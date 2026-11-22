import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * AES-256-GCM for users' own provider keys. A fresh random 12-byte IV per
 * encryption; the auth tag makes tampering detectable; the associated data
 * (`userId|provider`) binds a ciphertext to its owner, so a document copied to
 * another user or provider does not decrypt.
 */
export type Sealed = { ciphertext: string; iv: string; tag: string }

export class KeyDecryptError extends Error {
  constructor() {
    super("The stored key could not be decrypted.")
    this.name = "KeyDecryptError"
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("BYOK key must be 32 bytes")
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  aad: string
): Sealed {
  assertKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  }
}

export function decryptSecret(
  sealed: Sealed,
  key: Buffer,
  aad: string
): string {
  assertKey(key)
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.iv, "base64")
    )
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"))
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    // Wrong key, wrong owner, or tampered data: never say which.
    throw new KeyDecryptError()
  }
}

/** Associated data that ties a ciphertext to one user and provider. */
export function keyAad(userId: string, provider: string): string {
  return `vireo-byok|${userId}|${provider}`
}
