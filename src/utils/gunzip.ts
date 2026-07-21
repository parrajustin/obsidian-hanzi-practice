/**
 * Inflate a gzip blob using the web-standard `DecompressionStream`.
 *
 * Node's `zlib` is deliberately NOT used here: Obsidian mobile (Capacitor) has
 * no Node runtime, and its plugin loader rejects `require('zlib')` with
 * `Attempting to load NodeJS package: "zlib"` — which broke the plugin on
 * phones. `DecompressionStream` exists on every platform Obsidian runs on
 * (Chromium/Electron desktop, Android WebView, iOS 16.4+ WebKit).
 */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh Uint8Array: guarantees an ArrayBuffer-backed view
  // (streams reject SharedArrayBuffer-backed input, and the copy satisfies
  // TypeScript's BufferSource requirement).
  const input = new Uint8Array(data);
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  // Do NOT await the write before draining the readable — the write promise
  // only resolves once the decompressor's output is consumed, so awaiting it
  // first would deadlock. Errors (e.g. corrupt gzip) surface through
  // reader.read() below; swallow the duplicate rejection here so it cannot
  // become an unhandled rejection.
  void writer.write(input).catch(() => {});
  void writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
