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
  clearDatabase,
  createUser,
  setupEnv,
  startDatabase,
  stopDatabase,
} from "./support/harness"

setupEnv()

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

const {
  beatPlan,
  buildExpandMessages,
  cleanExpansion,
  expandInputSchema,
  EXPANDED_MAX_CHARS,
} = await import("@/lib/prompt-expand")
const { describeExpandError, expandPrompt, ExpandError } =
  await import("@/lib/openrouter/expand")
const { enforceRateLimit, LIMITS } = await import("@/lib/rate-limit")
const { POST } = await import("@/app/api/prompt/expand/route")
const { resetEnvForTests } = await import("@/lib/env")

const userMessage = (input: Parameters<typeof buildExpandMessages>[0]) =>
  buildExpandMessages(input).find((m) => m.role === "user")!.content

describe("beatPlan / prompt builder", () => {
  it.each([
    [4, 1],
    [5, 1],
    [6, 2],
    [10, 2],
    [15, 3],
    [30, 6],
  ])("%i s gets %i beat(s) covering the whole clip", (seconds, count) => {
    const beats = beatPlan(seconds)
    expect(beats).toHaveLength(count)
    expect(beats[0]!.startSec).toBe(0)
    expect(beats.at(-1)!.endSec).toBe(seconds)
    beats.forEach((beat, i) => {
      if (i > 0) expect(beat.startSec).toBe(beats[i - 1]!.endSec)
    })
  })

  it("15 s, 21:9, audio on lists three timed beats and asks for Audio", () => {
    const text = userMessage({
      prompt: "an epic sci-fi scene",
      kind: "video",
      durationSec: 15,
      aspectRatio: "21:9",
      hasAudio: true,
    })
    expect(text).toContain("Beat 1 0-5 s, Beat 2 5-10 s, Beat 3 10-15 s")
    expect(text).toContain("21:9")
    expect(text).toContain("Include the Audio line")
  })

  it("audio off forbids the Audio line; 4 s is one beat", () => {
    const text = userMessage({
      prompt: "a fox",
      kind: "video",
      durationSec: 4,
      hasAudio: false,
    })
    expect(text).toContain("Beats (1): Beat 1 0-4 s")
    expect(text).toContain("Do NOT write an Audio line")
  })

  it("keeps non-English wording and forbids brands in the system prompt", () => {
    const [system, user] = buildExpandMessages({
      prompt: "Samarqand bozori, “Registon” yozuvi",
      kind: "video",
      durationSec: 10,
    })
    expect(user!.content).toContain("Samarqand bozori, “Registon” yozuvi")
    expect(system!.content).toMatch(/exactly as given/)
    expect(system!.content).toMatch(/brands, logos/)
  })

  it("image prompts have no beats or audio", () => {
    const text = userMessage({
      prompt: "a lighthouse",
      kind: "image",
      aspectRatio: "1:1",
    })
    expect(text).not.toMatch(/Beat|Audio/)
    expect(text).toContain("1:1")
  })

  it("cleanExpansion strips markdown/think tags and caps the length", () => {
    expect(cleanExpansion("<think>hmm</think>**Opening frame:** x")).toBe(
      "Opening frame: x"
    )
    const long = Array.from({ length: 80 }, (_, i) => `Line number ${i}.`).join(
      "\n"
    )
    expect(cleanExpansion(long).length).toBeLessThanOrEqual(EXPANDED_MAX_CHARS)
  })
})

describe("input validation", () => {
  it("accepts a valid request and trims the idea", () => {
    expect(
      expandInputSchema.parse({
        prompt: "  a fox  ",
        kind: "video",
        durationSec: 15,
      }).prompt
    ).toBe("a fox")
  })
  it.each([
    { prompt: "ab", kind: "video" },
    { prompt: "x".repeat(501), kind: "video" },
    { prompt: "a fox", kind: "audio" },
    { prompt: "a fox", kind: "video", durationSec: 0 },
    { prompt: "a fox", kind: "video", aspectRatio: "wide!" },
  ])("rejects %j", (bad) => {
    expect(expandInputSchema.safeParse(bad).success).toBe(false)
  })
})

describe("expandPrompt + error mapping", () => {
  const input = { prompt: "a fox", kind: "video" as const, durationSec: 5 }
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it("posts to chat/completions with the key and returns text and cost", async () => {
    const fetchMock = reply(200, {
      choices: [
        {
          message: {
            content:
              "Opening frame: a fox.\nBeat 1 (0-5 s) FOX: it runs. Camera: tracking.\nLook: warm.\nAudio: wind.",
          },
        },
      ],
      usage: { cost: 0.00003 },
    })
    const result = await expandPrompt(input, { fetch: fetchMock })
    expect(result).toEqual({
      prompt:
        "Opening frame: a fox.\nBeat 1 (0-5 s) FOX: it runs. Camera: tracking.\nLook: warm.\nAudio: wind.",
      costUsd: 0.00003,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("https://or.test/api/v1/chat/completions")
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-or-v1-test-key-0123456789"
    )
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe("anthropic/claude-haiku-5.5")
    expect(body.max_tokens).toBe(900)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("asks once more when the Audio line was dropped, and sums the cost", async () => {
    const bad = {
      choices: [{ message: { content: "Opening frame: a fox.\nLook: warm." } }],
      usage: { cost: 0.00003 },
    }
    const good = {
      choices: [
        {
          message: {
            content: "Opening frame: a fox.\nLook: warm.\nAudio: wind.",
          },
        },
      ],
      usage: { cost: 0.00004 },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(bad), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(good), { status: 200 })
      )
    const result = await expandPrompt(input, { fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.prompt).toMatch(/Audio: wind/)
    expect(result.costUsd).toBeCloseTo(0.00007, 8)
    const noAudio = await expandPrompt(
      { ...input, hasAudio: false },
      {
        fetch: vi.fn(
          async () => new Response(JSON.stringify(bad), { status: 200 })
        ),
      }
    )
    expect(noAudio.prompt).toMatch(/Look: warm/)
  })

  it("does not retry and never leaks upstream details", async () => {
    const fetchMock = reply(500, {
      error: { message: "secret upstream detail" },
    })
    const error = await expandPrompt(input, { fetch: fetchMock }).catch(
      (e) => e
    )
    expect(error).toBeInstanceOf(ExpandError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(describeExpandError(error).message).not.toMatch(/secret|upstream/)
  })

  it("maps statuses to safe messages, flagging operator problems", () => {
    expect(
      describeExpandError(new ExpandError(402, "x")).operatorAlert
    ).toMatch(/credits/)
    expect(
      describeExpandError(new ExpandError(403, "x")).operatorAlert
    ).toBeTruthy()
    expect(
      describeExpandError(new ExpandError(429, "x")).operatorAlert
    ).toBeUndefined()
    expect(
      describeExpandError(new ExpandError("network", "x")).message
    ).toMatch(/timed out/)
    expect(describeExpandError(new ExpandError("empty", "x")).message).toMatch(
      /nothing/
    )
    expect(describeExpandError(new Error("boom")).message).not.toMatch(/boom/)
  })

  it("turns an empty completion and a timeout into ExpandErrors", async () => {
    await expect(
      expandPrompt(input, { fetch: reply(200, { choices: [] }) })
    ).rejects.toMatchObject({ status: "empty" })
    const hang = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("abort"))
          )
        )
    )
    await expect(
      expandPrompt(input, {
        fetch: hang as unknown as typeof fetch,
        timeoutMs: 10,
      })
    ).rejects.toMatchObject({ status: "network" })
  })
})

describe("route and rate limit", () => {
  beforeAll(startDatabase, 120_000)
  afterAll(stopDatabase)
  beforeEach(async () => {
    await clearDatabase()
    session.user = null
    resetEnvForTests()
  })

  const call = (body: unknown) =>
    POST(
      new Request("http://localhost/api/prompt/expand", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )

  it("rejects anonymous callers with 401", async () => {
    const response = await call({ prompt: "a fox", kind: "video" })
    expect(response.status).toBe(401)
  })

  it("validates input (400) and returns the prompt on success", async () => {
    session.user = await createUser()
    expect((await call({ prompt: "a", kind: "video" })).status).toBe(400)
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Expanded." } }] })
          )
      )
    )
    const ok = await call({ prompt: "a fox", kind: "image" })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ prompt: "Expanded." })
    vi.unstubAllGlobals()
  })

  it("answers 502 with a safe message when the provider fails", async () => {
    session.user = await createUser()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 }))
    )
    const response = await call({ prompt: "a fox", kind: "video" })
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toMatch(/500|upstream/)
    vi.unstubAllGlobals()
  })

  it("limits each user to 20 expansions an hour", async () => {
    const { limit, window } = LIMITS.expandPerUser
    expect(limit).toBe(20)
    for (let i = 0; i < limit; i++)
      await enforceRateLimit("expand:u1", limit, window)
    await expect(
      enforceRateLimit("expand:u1", limit, window)
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    await enforceRateLimit("expand:u2", limit, window)
  })

  it("answers 503 when OpenRouter is not configured", async () => {
    session.user = await createUser()
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    resetEnvForTests()
    expect((await call({ prompt: "a fox", kind: "video" })).status).toBe(503)
    process.env.OPENROUTER_API_KEY = key
    resetEnvForTests()
  })
})

describe("video system prompt rules", () => {
  it("keeps the story, tone, readability and no-drop rules", async () => {
    const { buildExpandMessages } = await import("@/lib/prompt-expand")
    const system = buildExpandMessages({
      prompt: "an epic sci-fi scene",
      kind: "video",
      durationSec: 15,
      aspectRatio: "21:9",
      hasAudio: true,
    })[0]!.content
    expect(system).toMatch(/already be visible or clearly implied/)
    expect(system).toMatch(/who or what is in danger/)
    expect(system).toMatch(/consequence, not just the event/)
    expect(system).toMatch(/never settle for a calm journey/)
    expect(system).toMatch(/at most two or three secondary moving objects/)
    expect(system).toMatch(/never drop the Look or Audio line/)
    expect(system).toMatch(/Never contradict the Audio line/)
    expect(system).toMatch(/literally say "wide"/)
  })
})
