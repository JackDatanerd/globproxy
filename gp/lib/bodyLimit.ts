// Reads a request body as text but never holds more than `max` bytes. Unlike
// `(await req.text()).slice(0, max)` — which reads the ENTIRE body into memory
// first and only then truncates — this checks Content-Length up front and
// otherwise stops reading (and cancels the stream) as soon as the limit is
// crossed. Returns null when the body is larger than `max`.
export async function readTextCapped(req: Request, max: number): Promise<string | null> {
  const declared = req.headers.get('content-length')
  if (declared !== null && Number(declared) > max) return null
  if (!req.body) return ''

  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > max) {
        await reader.cancel().catch(() => {})
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock?.()
  }
}
