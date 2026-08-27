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

// ---------------------------------------------------------------------------
// Envelope encryption for stored provider credentials — a different job
// from the hashing above (reversible and keyed, rather than one-way) on the
// same WebCrypto-only, no-dependency footing.
//
// AES-256-GCM via WebCrypto, which the Workers runtime provides natively —
// no dependency, no bundled crypto library. GCM rather than CBC because it
// is authenticated: a tampered ciphertext fails to decrypt rather than
// decrypting to garbage that then gets sent to a bank's API as a token.
//
// THE KEY IS A GLOBAL WORKER SECRET AND THAT IS THE POINT. A stored
// credential cannot be a Worker secret (one global value; a token
// identifies one person — see migrations/0010), but the KEY used to
// encrypt them can be, because it is app infrastructure rather than
// anyone's identity. That is the distinction that makes this design
// multi-user-safe: one shared key, one ciphertext per person.
//
// Pure crypto: no DB, no Cloudflare bindings beyond the standard WebCrypto
// global. The key material is passed in.

/** What `encryptSecret` produces and `decryptSecret` consumes — both base64, stored as two TEXT columns. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
}

/**
 * GCM's IV must be unique per encryption under a given key. 96 bits is the
 * size AES-GCM is specified and optimised for, and a fresh random one is
 * generated per call rather than derived from anything — a counter or a
 * row id would repeat after a restore-from-backup, and IV reuse under one
 * key is the standard way GCM is broken.
 */
const IV_BYTES = 12;

/** Raw AES-256 key length. Anything else is a configuration error worth failing loudly on, not padding into shape. */
const KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Imports the app-level key from its base64 Worker secret.
 *
 * Throws rather than falling back to a default or a derived key when the
 * secret is missing or the wrong size: an environment without
 * CREDENTIALS_KEY must fail to store credentials, not quietly store them
 * under a guessable key.
 */
async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(`CREDENTIALS_KEY must be ${KEY_BYTES} base64-encoded bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(base64Key: string, plaintext: string): Promise<SealedSecret> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/**
 * Recovers the plaintext, or throws.
 *
 * A throw here is meaningful rather than incidental: GCM authenticates, so
 * failure means the stored bytes are not what was written — a wrong key
 * (CREDENTIALS_KEY rotated or differing between environments) or tampering.
 * Callers should treat it as "this connection needs re-entering", never
 * retry it.
 */
export async function decryptSecret(base64Key: string, sealed: SealedSecret): Promise<string> {
  const key = await importKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource },
    key,
    fromBase64(sealed.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/** A fresh base64 AES-256 key, for generating what goes into the CREDENTIALS_KEY secret. */
export function generateCredentialsKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
