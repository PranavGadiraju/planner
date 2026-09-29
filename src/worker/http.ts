// JSON response helpers and a size-capped JSON body reader. No Worker-only globals so tests can import it.

export const MAX_BODY_BYTES = 256 * 1024

export class HttpError extends Error {
  readonly status: number
  readonly extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra
  }
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } })
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status)
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Parse a JSON body, refusing anything over `limit` bytes before it is fully buffered. */
export async function readJson<T = unknown>(request: Request, limit = MAX_BODY_BYTES): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > limit) throw new HttpError(413, `body larger than ${limit} bytes`)
  if (!request.body) throw new HttpError(400, 'JSON body required')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new HttpError(413, `body larger than ${limit} bytes`)
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  const text = new TextDecoder().decode(buf)
  if (!text.trim()) throw new HttpError(400, 'JSON body required')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}
