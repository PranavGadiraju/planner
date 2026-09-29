// Bearer-token auth. Tokens are compared by SHA-256 digest with a fixed-time byte comparison; every configured
// secret is checked (no early exit) so timing does not reveal which role a token was close to.
import type { Role } from '../shared/types'

export type TokenSecrets = Record<Role, string | undefined>

const ROLES: readonly Role[] = ['app', 'shortcut', 'mac']

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

// Secrets are three fixed strings per isolate; caching their digests saves re-hashing on every request.
const secretDigests = new Map<string, Uint8Array>()
async function secretDigest(secret: string): Promise<Uint8Array> {
  let d = secretDigests.get(secret)
  if (!d) {
    d = await digest(secret)
    secretDigests.set(secret, d)
  }
  return d
}

/** Fixed-time comparison: always walks the full length of `a`. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header)
  return m?.[1] ?? null
}

/** The role a presented token grants, or null. Unset secrets never match. */
export async function roleForToken(token: string | null, secrets: TokenSecrets): Promise<Role | null> {
  if (!token) return null
  const given = await digest(token)
  let role: Role | null = null
  for (const r of ROLES) {
    const secret = secrets[r]
    if (!secret) continue
    const match = bytesEqual(given, await secretDigest(secret))
    if (match && role === null) role = r
  }
  return role
}
