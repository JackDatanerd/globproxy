// Minimal ambient types for Cloudflare Workers' cloudflare:sockets module —
// this project has no @cloudflare/workers-types dependency, so without this,
// `import { connect } from 'cloudflare:sockets'` (used by the benchmark cron
// task, app/api/cron/[task]/route.ts) fails to type-check even though it's
// valid at runtime under the nodejs_compat flag already set in wrangler.jsonc.
// Trimmed to just the surface actually used — see Cloudflare's docs for the
// full API if this needs to grow (TLS via startTls, SocketOptions, etc.).
declare module 'cloudflare:sockets' {
  export interface Socket {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    closed: Promise<void>
    close(): Promise<void>
  }

  export interface SocketAddress {
    hostname: string
    port: number
  }

  export function connect(address: SocketAddress | string, options?: { secureTransport?: 'off' | 'on' | 'starttls' }): Socket
}
