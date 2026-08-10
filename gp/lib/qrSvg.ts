// Renders a QR code as an SVG string WITHOUT going through the 'qrcode'
// package's normal entry point (qrcode/lib/index.js → lib/server.js).
// That file unconditionally requires 'fs' and 'pngjs' at module-load
// time — for PNG output support this app never uses (lib/mfa.ts only
// ever asks for {type:'svg'}) — because qrcode/lib/renderer/png.js does
// `const fs = require('fs')` at its top level, and server.js imports
// that renderer eagerly regardless of which output type you actually
// request. That's harmless in plain Node (which is why this passed a
// local `next build` and a local Node smoke test of the enroll flow),
// but under Cloudflare Workers (workerd) — where 'fs' doesn't really
// exist and is at best a partial polyfill — it broke /auth/mfa-setup in
// production: the enroll request never completed.
//
// qrcode's own package.json ships a "browser" field remapping its main
// entry away from server.js specifically because of this — but nothing
// in this app's build pipeline (Turbopack → OpenNext → Workers) applies
// that remap, so the Node entry point still got bundled.
//
// The fix: import only the two files QRCode.toString(text, {type:'svg'})
// actually uses under the hood — core/qrcode.js (the pure QR encoder:
// Reed-Solomon, masking, bit-buffer math, zero I/O) and
// renderer/svg-tag.js (the SVG string serializer, which itself only
// requires renderer/utils.js — also zero I/O). Output is byte-identical
// to calling the package's own toString(); this just avoids the import
// chain that drags in fs/pngjs/zlib for a feature we never touch.

// @ts-expect-error — no type declarations for this subpath; the package
// has no "exports" map restricting it (only "main"/"browser" fields), and
// this is the exact file qrcode/lib/server.js itself imports internally.
import QRCodeCore from 'qrcode/lib/core/qrcode.js'
// @ts-expect-error — same reasoning; this is qrcode's own SVG serializer,
// imported the same way qrcode/lib/server.js imports it internally.
import SvgRenderer from 'qrcode/lib/renderer/svg-tag.js'

export interface QrSvgOptions {
  width?: number
  margin?: number
}

export function renderQrSvg(text: string, opts: QrSvgOptions = {}): string {
  const data = QRCodeCore.create(text, opts)
  return SvgRenderer.render(data, opts)
}
