import { randomBytes, randomUUID } from "node:crypto"

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  balanceOf,
  clearDatabase,
  createUser,
  installFakeHiggsfield,
  installFakeOpenRouter,
  OR_KEY,
  setupEnv,
  startDatabase,
  stopDatabase,
  type FakeHiggsfield,
  type FakeOpenRouter,
} from "./support/harness"

setupEnv()
const ENCRYPTION_KEY = randomBytes(32).toString("base64")
process.env.BYOK_ENCRYPTION_KEY = ENCRYPTION_KEY

const session = vi.hoisted(() => ({ user: null as unknown }))
vi.mock("@/lib/auth/session", async () => {
  const { UnauthorizedError } = await import("@/lib/errors")
  return {
    requireUser: async () => {
      if (!session.user) throw new UnauthorizedError()
      return session.user
    },
  }
})
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (work: () => Promise<unknown>) => void work() }
})

const { decryptSecret, encryptSecret, KeyDecryptError, keyAad } =
  await import("@/lib/byok/crypto")
const keys = await import("@/lib/byok/keys")
const { saveKeyAction, deleteKeyAction } = await import("@/app/actions/keys")
const { submitGeneration } = await import("@/lib/generations/submit")
const { finalizeGeneration } = await import("@/lib/generations/finalize")
const { cancelGeneration } = await import("@/lib/generations/cancel")
const { reconcile } = await import("@/lib/generations/reconcile")
const { toGenerationView } = await import("@/lib/generations/serialize")
const { collections } = await import("@/lib/db/collections")
const { resetEnvForTests } = await import("@/lib/env")
const { clientPricing, invalidatePricing } =
  await import("@/lib/billing/pricing")
const { ObjectId } = await import("mongodb")

const USER_OR_KEY = "sk-or-v1-user-own-key-abcdef1234567890"
const USER_HF_KEY = "user-key-id:user-key-secret-9876"

/* ── Encryption ─────────────────────────────────────────────────────────── */

describe("AES-256-GCM", () => {
  const key = randomBytes(32)
  const aad = keyAad("507f1f77bcf86cd799439011", "openrouter")

  it("round-trips and never stores the plaintext", () => {
    const sealed = encryptSecret(USER_OR_KEY, key, aad)
    expect(JSON.stringify(sealed)).not.toContain(USER_OR_KEY)
    expect(Buffer.from(sealed.iv, "base64")).toHaveLength(12)
    expect(Buffer.from(sealed.tag, "base64")).toHaveLength(16)
    expect(decryptSecret(sealed, key, aad)).toBe(USER_OR_KEY)
  })

  it("uses a fresh IV every time", () => {
    const a = encryptSecret("same", key, aad)
    const b = encryptSecret("same", key, aad)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it("rejects tampered ciphertext, tag and IV", () => {
    const sealed = encryptSecret(USER_OR_KEY, key, aad)
    const flip = (value: string) => {
      const bytes = Buffer.from(value, "base64")
      bytes[0] = bytes[0]! ^ 1
      return bytes.toString("base64")
    }
    for (const field of ["ciphertext", "tag", "iv"] as const)
      expect(() =>
        decryptSecret({ ...sealed, [field]: flip(sealed[field]) }, key, aad)
      ).toThrow(KeyDecryptError)
  })

  it("rejects the wrong key and a different owner or provider", () => {
    const sealed = encryptSecret(USER_OR_KEY, key, aad)
    expect(() => decryptSecret(sealed, randomBytes(32), aad)).toThrow(
      KeyDecryptError
    )
    expect(() =>
      decryptSecret(
        sealed,
        key,
        keyAad("507f1f77bcf86cd799439012", "openrouter")
      )
    ).toThrow(KeyDecryptError)
    expect(() =>
      decryptSecret(
        sealed,
        key,
        keyAad("507f1f77bcf86cd799439011", "higgsfield")
      )
    ).toThrow(KeyDecryptError)
  })

  it("refuses a key that is not 32 bytes", () => {
    expect(() => encryptSecret("x", randomBytes(16), aad)).toThrow()
  })
})

describe("key shape and redaction", () => {
  it("checks the shape per provider", () => {
    expect(keys.normalizeKey("openrouter", `  ${USER_OR_KEY}\n`)).toBe(
      USER_OR_KEY
    )
    expect(keys.normalizeKey("openrouter", "mock-abcdef12")).toBe(
      "mock-abcdef12"
    )
    expect(() => keys.normalizeKey("openrouter", "short")).toThrow()
    expect(() =>
      keys.normalizeKey("openrouter", "has space in it 12345")
    ).toThrow()
    expect(keys.normalizeKey("higgsfield", USER_HF_KEY)).toBe(USER_HF_KEY)
    expect(() => keys.normalizeKey("higgsfield", "no-colon-here")).toThrow()
    expect(() => keys.normalizeKey("higgsfield", "")).toThrow()
  })

  it("redacts keys and credentials from text", () => {
    const text = `failed: Authorization: Bearer ${USER_OR_KEY} and Key ${USER_HF_KEY} for ${USER_OR_KEY}`
    const out = keys.redactSecrets(text, USER_OR_KEY, USER_HF_KEY)
    expect(out).not.toContain(USER_OR_KEY)
    expect(out).not.toContain(USER_HF_KEY)
    expect(keys.redactSecrets("token sk-or-v1-abcdef0123456789")).not.toContain(
      "abcdef0123456789"
    )
  })
})

/* ── Storage, actions, ownership ────────────────────────────────────────── */

let fake: FakeOpenRouter
let hf: FakeHiggsfield

beforeAll(startDatabase, 120_000)
afterAll(stopDatabase)
beforeEach(async () => {
  process.env.BYOK_ENCRYPTION_KEY = ENCRYPTION_KEY
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test-key-0123456789"
  process.env.HF_CREDENTIALS = "key:secret"
  resetEnvForTests()
  await clearDatabase()
  session.user = null
  hf = await installFakeHiggsfield()
  fake = await installFakeOpenRouter()
  fake.acceptedKeys.add(USER_OR_KEY)
  vi.stubGlobal("fetch", (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    return url.host === "or.test" || url.host === "storage.or.test"
      ? fake.fetch(input, init)
      : hf.fetch(input, init)
  }) as typeof fetch)
})

const orFetch = (...args: Parameters<typeof fetch>) => fake.fetch(...args)

async function rawKeyDocs() {
  const { userKeys } = await collections()
  return userKeys.find({}).toArray()
}

describe("saving keys", () => {
  it("encrypts at rest, keeps last four, and verifies OpenRouter with GET /key", async () => {
    const user = await createUser()
    const status = await keys.saveUserKey(
      user.objectId,
      "openrouter",
      USER_OR_KEY,
      orFetch
    )
    expect(status).toMatchObject({
      provider: "openrouter",
      last4: USER_OR_KEY.slice(-4),
      verified: true,
    })
    expect(JSON.stringify(status)).not.toContain(USER_OR_KEY)
    const [doc] = await rawKeyDocs()
    expect(JSON.stringify(doc)).not.toContain(USER_OR_KEY)
    expect(doc!.ciphertext).toBeTruthy()
    expect(doc!.userId.equals(user.objectId)).toBe(true)
    expect(
      fake.seen.some(
        (r) =>
          r.url.endsWith("/api/v1/key") &&
          r.authorization === `Bearer ${USER_OR_KEY}`
      )
    ).toBe(true)
    expect(await keys.loadUserKey(user.objectId, "openrouter")).toBe(
      USER_OR_KEY
    )
  })

  it("replaces an existing key (one document per user and provider)", async () => {
    const user = await createUser()
    fake.acceptedKeys.add("sk-or-v1-second-key-zzzz9999")
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    await keys.saveUserKey(
      user.objectId,
      "openrouter",
      "sk-or-v1-second-key-zzzz9999",
      orFetch
    )
    expect(await rawKeyDocs()).toHaveLength(1)
    expect(await keys.loadUserKey(user.objectId, "openrouter")).toBe(
      "sk-or-v1-second-key-zzzz9999"
    )
    expect((await keys.listUserKeys(user.objectId))[0]!.last4).toBe("9999")
  })

  it("does not save a key the provider rejects", async () => {
    const user = await createUser()
    await expect(
      keys.saveUserKey(
        user.objectId,
        "openrouter",
        "sk-or-v1-not-accepted-0000",
        orFetch
      )
    ).rejects.toMatchObject({ code: "KEY_REJECTED" })
    expect(await rawKeyDocs()).toHaveLength(0)
  })

  it("Higgsfield credentials are format-checked only (verified: false)", async () => {
    const user = await createUser()
    const status = await keys.saveUserKey(
      user.objectId,
      "higgsfield",
      USER_HF_KEY,
      orFetch
    )
    expect(status.verified).toBe(false)
    expect(status.last4).toBe(USER_HF_KEY.slice(-4))
    // No call at all was made to a Higgsfield endpoint.
    expect(hf.seenAuth).toHaveLength(0)
  })

  it("refuses with a clear message when BYOK_ENCRYPTION_KEY is missing", async () => {
    delete process.env.BYOK_ENCRYPTION_KEY
    resetEnvForTests()
    const user = await createUser()
    await expect(
      keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    ).rejects.toMatchObject({ code: "BYOK_NOT_CONFIGURED" })
    expect(await rawKeyDocs()).toHaveLength(0)
    expect(keys.byokEnabled()).toBe(false)
  })

  it("rate-limits saves per user", async () => {
    const user = await createUser()
    const other = await createUser()
    for (let i = 0; i < 10; i++)
      await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    await expect(
      keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    // Another user is unaffected.
    await expect(
      keys.saveUserKey(other.objectId, "openrouter", USER_OR_KEY, orFetch)
    ).resolves.toBeDefined()
  })

  it("a key that fails to decrypt (owner mismatch) is unreadable, not leaked", async () => {
    const owner = await createUser()
    const thief = await createUser()
    await keys.saveUserKey(owner.objectId, "openrouter", USER_OR_KEY, orFetch)
    const { userKeys } = await collections()
    // Copy the owner's sealed key onto another account.
    const [doc] = await rawKeyDocs()
    await userKeys.insertOne({
      ...doc!,
      _id: new ObjectId(),
      userId: thief.objectId,
    })
    await expect(
      keys.loadUserKey(thief.objectId, "openrouter")
    ).rejects.toMatchObject({ reason: "unreadable" })
  })
})

describe("key actions", () => {
  it("require a signed-in user", async () => {
    expect(await saveKeyAction("openrouter", USER_OR_KEY)).toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    })
    expect(await deleteKeyAction("openrouter")).toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    })
    expect(await rawKeyDocs()).toHaveLength(0)
  })

  it("scope to the caller and never return the key", async () => {
    const alice = await createUser()
    const bob = await createUser()
    session.user = alice
    const saved = await saveKeyAction("higgsfield", USER_HF_KEY)
    expect(saved.ok).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(USER_HF_KEY)
    expect(JSON.stringify(saved)).not.toContain("user-key-secret")
    expect(saved.ok && saved.data).toEqual([
      expect.objectContaining({
        provider: "higgsfield",
        last4: USER_HF_KEY.slice(-4),
      }),
    ])
    // Bob sees nothing of Alice's and deleting "his" key leaves hers alone.
    session.user = bob
    const bobDelete = await deleteKeyAction("higgsfield")
    expect(bobDelete.ok && bobDelete.data).toEqual([])
    expect(await keys.listUserKeys(alice.objectId)).toHaveLength(1)
    await expect(
      keys.loadUserKey(bob.objectId, "higgsfield")
    ).rejects.toBeInstanceOf(keys.UserKeyMissingError)
    session.user = alice
    const aliceDelete = await deleteKeyAction("higgsfield")
    expect(aliceDelete.ok && aliceDelete.data).toEqual([])
    expect(await rawKeyDocs()).toHaveLength(0)
  })

  it("rejects an unknown provider and a bad key with readable errors", async () => {
    session.user = await createUser()
    expect(await saveKeyAction("stripe", USER_OR_KEY)).toMatchObject({
      ok: false,
      error: "Unknown provider.",
    })
    expect(await saveKeyAction("openrouter", "bad key")).toMatchObject({
      ok: false,
      code: "INVALID_KEY",
    })
  })
})

/* ── Generation with a user key ─────────────────────────────────────────── */

const mini = (overrides: Record<string, unknown> = {}) => ({
  submitKey: randomUUID(),
  modelId: "seedance-2.0-mini-openrouter",
  prompt: "A fox crossing a snowy field",
  settings: {},
  media: [],
  ...overrides,
})

async function generationDoc(id: string) {
  const { generations } = await collections()
  return (await generations.findOne({ _id: new ObjectId(id) }))!
}

async function ledgerRows(id: string) {
  const { ledger } = await collections()
  return ledger.find({ refId: id }).toArray()
}

describe("submit with the user's own key", () => {
  it("uses the user's key, charges no credits and records keySource", async () => {
    const user = await createUser({ topup: 500 })
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    expect(view.status).toBe("queued")
    expect(view.cost).toBe(0)
    expect(view.keySource).toBe("user")
    expect(fake.submits).toHaveLength(1)
    expect(fake.submits[0]!.authorization).toBe(`Bearer ${USER_OR_KEY}`)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
    expect(await ledgerRows(view.id)).toHaveLength(0)
    const doc = await generationDoc(view.id)
    expect(doc.keySource).toBe("user")
    expect(doc.cost).toBe(0)
    expect(JSON.stringify(doc)).not.toContain(USER_OR_KEY)
  })

  it("works without any credits at all", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    await expect(submitGeneration(user, mini())).resolves.toMatchObject({
      status: "queued",
      cost: 0,
    })
  })

  it("leaves the server-key path unchanged for users without a key", async () => {
    const user = await createUser({ topup: 500 })
    const other = await createUser({ topup: 500 })
    // Another account's key never applies to this user.
    await keys.saveUserKey(other.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    expect(view.cost).toBeGreaterThan(0)
    expect(view.keySource).toBe("server")
    expect(fake.submits[0]!.authorization).toBe(`Bearer ${OR_KEY}`)
    expect((await balanceOf(user.objectId)).topup).toBe(500 - view.cost)
    expect((await generationDoc(view.id)).keySource).toBe("server")
  })

  it("still enforces the per-run USD cap on the user's key", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    await expect(
      submitGeneration(
        user,
        mini({
          modelId: "seedance-2.5-openrouter",
          settings: { duration: 30, resolution: "1080p" },
        })
      )
    ).rejects.toMatchObject({ code: "OVER_BUDGET" })
    expect(fake.submits).toHaveLength(0)
  })

  it("keeps submit idempotency: the same press twice is one job", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const input = mini()
    const first = await submitGeneration(user, input)
    const second = await submitGeneration(user, input)
    expect(second.id).toBe(first.id)
    expect(fake.submits).toHaveLength(1)
  })

  it("a model with neither a server nor a user key is inactive (NEEDS_KEY)", async () => {
    delete process.env.OPENROUTER_API_KEY
    resetEnvForTests()
    invalidatePricing()
    const user = await createUser({ topup: 500 })
    await expect(submitGeneration(user, mini())).rejects.toMatchObject({
      code: "NEEDS_KEY",
    })
    expect(fake.submits).toHaveLength(0)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
    // Connecting a key makes the same request work, with no credits.
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    await expect(submitGeneration(user, mini())).resolves.toMatchObject({
      status: "queued",
      cost: 0,
    })
  })

  it("clientPricing: the user's own provider is selectable and flagged as billed to the key", async () => {
    delete process.env.OPENROUTER_API_KEY
    resetEnvForTests()
    invalidatePricing()
    const without = await clientPricing([])
    expect(without.disabled).toContain("seedance-2.0-mini-openrouter")
    expect(without.ownKeys).toEqual([])
    invalidatePricing()
    const withKey = await clientPricing(["openrouter"])
    expect(withKey.disabled).not.toContain("seedance-2.0-mini-openrouter")
    expect(withKey.ownKeys).toEqual(["openrouter"])
    expect(
      withKey.inactive.some((item) => item.platform === "openrouter")
    ).toBe(false)
  })

  it("Higgsfield: user credentials run the job, nothing is charged", async () => {
    const user = await createUser({ topup: 500 })
    await keys.saveUserKey(user.objectId, "higgsfield", USER_HF_KEY)
    const view = await submitGeneration(user, {
      submitKey: randomUUID(),
      modelId: "soul-2",
      prompt: "Editorial portrait in soft daylight",
      settings: { batchSize: "1", resolution: "720p" },
      media: [],
    })
    expect(view.cost).toBe(0)
    expect(view.keySource).toBe("user")
    expect(hf.submits).toHaveLength(1)
    expect(
      hf.seenAuth.filter((call) => call.authorization === `Key ${USER_HF_KEY}`)
    ).toHaveLength(1)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })

  it("a provider rejecting the user's key says so, with no refund text and no operator alert", async () => {
    const user = await createUser({ topup: 500 })
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    fake.nextSubmit = 401
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    const view = await submitGeneration(user, mini())
    expect(view.status).toBe("failed")
    expect(view.error).toContain("OpenRouter rejected your key")
    expect(view.error).not.toContain("refunded")
    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes("OPERATOR ALERT")
      )
    ).toBe(false)
    errors.mockRestore()
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })
})

describe("later calls use the key the job was submitted with", () => {
  it("finalize polls and downloads with the stored user key, never the server key", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    const id = fake.lastJobId()
    fake.finish(id, "completed")
    const before = fake.seen.length
    expect(await finalizeGeneration(new ObjectId(view.id))).toBe("completed")
    const after = fake.seen.slice(before)
    expect(after.length).toBeGreaterThanOrEqual(2) // status poll + download
    for (const call of after)
      expect(call.authorization).toBe(`Bearer ${USER_OR_KEY}`)
    const doc = await generationDoc(view.id)
    expect(doc.status).toBe("completed")
    expect(doc.outputs[0]!.storage).not.toBe("platform")
    expect(await ledgerRows(view.id)).toHaveLength(0)
  })

  it("a server-key job keeps using the server key even if the user later connects a key", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    fake.finish(fake.lastJobId(), "completed")
    const before = fake.seen.length
    expect(await finalizeGeneration(new ObjectId(view.id))).toBe("completed")
    for (const call of fake.seen.slice(before))
      expect(call.authorization).toBe(`Bearer ${OR_KEY}`)
  })

  it("a failed user-key job ends failed with no credit movement", async () => {
    const user = await createUser({ topup: 500 })
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    fake.finish(fake.lastJobId(), "failed", { error: "Content policy" })
    expect(await finalizeGeneration(new ObjectId(view.id))).toBe("refunded")
    expect((await generationDoc(view.id)).status).toBe("failed")
    expect(await ledgerRows(view.id)).toHaveLength(0)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })

  it("the key deleted mid-job: the job fails safely, nothing is refunded, no other key is tried", async () => {
    const user = await createUser({ topup: 500 })
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    fake.finish(fake.lastJobId(), "completed")
    session.user = user
    await deleteKeyAction("openrouter")
    const before = fake.seen.length
    expect(await finalizeGeneration(new ObjectId(view.id))).toBe("key_gone")
    // No provider call at all: not with the server key, not with anyone's.
    expect(fake.seen.length).toBe(before)
    const doc = await generationDoc(view.id)
    expect(doc.status).toBe("failed")
    expect(doc.error).toContain("you have since removed")
    expect(doc.error).not.toContain("refunded")
    expect(JSON.stringify(doc)).not.toContain(USER_OR_KEY)
    expect(await ledgerRows(view.id)).toHaveLength(0)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
    // The view is safe to show.
    expect(JSON.stringify(toGenerationView(doc))).not.toContain(USER_OR_KEY)
  })

  it("the reconciler also ends a stale job whose key is gone", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    const { userKeys, generations } = await collections()
    await userKeys.deleteMany({ userId: user.objectId })
    await generations.updateOne(
      { _id: new ObjectId(view.id) },
      { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } }
    )
    const before = fake.seen.length
    const summary = await reconcile()
    expect(summary.errors).toBe(0)
    expect(fake.seen.length).toBe(before)
    expect((await generationDoc(view.id)).status).toBe("failed")
  })

  it("an unreadable key (encryption key changed) is treated like a removed key", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "openrouter", USER_OR_KEY, orFetch)
    const view = await submitGeneration(user, mini())
    process.env.BYOK_ENCRYPTION_KEY = randomBytes(32).toString("base64")
    resetEnvForTests()
    expect(await finalizeGeneration(new ObjectId(view.id))).toBe("key_gone")
    expect((await generationDoc(view.id)).error).toContain("can't read")
  })

  it("cancel on a Higgsfield user-key job uses that key", async () => {
    const user = await createUser({})
    await keys.saveUserKey(user.objectId, "higgsfield", USER_HF_KEY)
    const view = await submitGeneration(user, {
      submitKey: randomUUID(),
      modelId: "kling-3-std",
      prompt: "A paper boat in the rain",
      settings: {},
      media: [],
    })
    hf.seenAuth.length = 0
    await cancelGeneration(user.objectId, new ObjectId(view.id))
    expect(hf.seenAuth.length).toBeGreaterThan(0)
    for (const call of hf.seenAuth)
      expect(call.authorization).toBe(`Key ${USER_HF_KEY}`)
  })
})
