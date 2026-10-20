import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Built with the adapter's own helper instead of a hand-copied object, so
// each @opennextjs/cloudflare upgrade brings its new required defaults along
// (the copy this replaced had already fallen behind: no asset resolver for the
// external middleware, no cache-invalidation default). Checked field for
// field against the previous literal: the only difference is those added
// defaults — wrapper/converter/proxyExternalRequest/incrementalCache/tagCache
// /queue are identical.
//
// incrementalCache and tagCache stay "dummy" on purpose: the app has no R2/KV
// cache bucket, and its pages are either per-user or served from the short
// anonymous edge cache in custom-worker.ts. `export const revalidate` in a
// page therefore has no effect here — don't rely on it. If a real
// incremental cache is ever added, configure it here (see the OpenNext
// Cloudflare caching docs).
export default defineCloudflareConfig({
  queue: "direct",
});
