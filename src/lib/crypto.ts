// Web Crypto helpers, available natively in the Workers runtime.

/** Cryptographically random bytes, hex-encoded. 32 bytes = 256 bits. */
export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Used to store only a hash of
 * magic-link tokens and challenge cookies — the raw secret exists only in
 * the emailed link / the browser's cookie jar, never at rest in D1.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
