import { describe, expect, it } from 'vitest'
import { bearerToken, bytesEqual, roleForToken } from '../src/worker/auth'

const secrets = { app: 'app-secret', shortcut: 'shortcut-secret', mac: 'mac-secret' }

describe('roleForToken', () => {
  it('maps each secret to its role', async () => {
    expect(await roleForToken('app-secret', secrets)).toBe('app')
    expect(await roleForToken('shortcut-secret', secrets)).toBe('shortcut')
    expect(await roleForToken('mac-secret', secrets)).toBe('mac')
  })
  it('rejects wrong, partial, empty and missing tokens', async () => {
    expect(await roleForToken('app-secret ', secrets)).toBeNull()
    expect(await roleForToken('app-secre', secrets)).toBeNull()
    expect(await roleForToken('', secrets)).toBeNull()
    expect(await roleForToken(null, secrets)).toBeNull()
  })
  it('an unset secret never matches, even an empty token', async () => {
    expect(await roleForToken('', { app: 'a', shortcut: undefined, mac: '' })).toBeNull()
    expect(await roleForToken('undefined', { app: 'a', shortcut: undefined, mac: 'm' })).toBeNull()
  })
})

describe('bearerToken', () => {
  const req = (h?: string) => new Request('http://x/api/me', h === undefined ? {} : { headers: { authorization: h } })
  it('extracts the token case-insensitively and trims whitespace', () => {
    expect(bearerToken(req('Bearer abc'))).toBe('abc')
    expect(bearerToken(req('bearer  abc  '))).toBe('abc')
  })
  it('returns null for missing or malformed headers', () => {
    expect(bearerToken(req())).toBeNull()
    expect(bearerToken(req('abc'))).toBeNull()
    expect(bearerToken(req('Basic abc'))).toBeNull()
    expect(bearerToken(req('Bearer'))).toBeNull()
    expect(bearerToken(req('Bearer a b'))).toBeNull()
  })
})

describe('bytesEqual', () => {
  it('compares full length and length', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
    expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true)
  })
})
