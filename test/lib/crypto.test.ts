import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateCredentialsKey } from '../../src/lib/crypto';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a credential', async () => {
    const sealed = await encryptSecret(KEY, 'wise-token-abc123');
    expect(await decryptSecret(KEY, sealed)).toBe('wise-token-abc123');
  });

  it('never emits the plaintext in the stored fields', async () => {
    const sealed = await encryptSecret(KEY, 'wise-token-abc123');
    expect(sealed.ciphertext).not.toContain('wise-token');
    expect(sealed.iv).not.toContain('wise-token');
  });

  it('uses a fresh IV each time, so the same secret never encrypts alike', async () => {
    // IV reuse under one key is how AES-GCM is broken, so this is a real
    // property to pin rather than an incidental one.
    const a = await encryptSecret(KEY, 'same-token');
    const b = await encryptSecret(KEY, 'same-token');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptSecret(KEY, a)).toBe(await decryptSecret(KEY, b));
  });

  it('refuses a tampered ciphertext instead of returning garbage', async () => {
    // GCM authenticates. This is why it was chosen over CBC: a corrupted
    // credential must fail loudly, not decrypt into something that then
    // gets sent to a bank's API as a token.
    const sealed = await encryptSecret(KEY, 'wise-token-abc123');
    const flipped = sealed.ciphertext.startsWith('A')
      ? 'B' + sealed.ciphertext.slice(1)
      : 'A' + sealed.ciphertext.slice(1);
    await expect(decryptSecret(KEY, { ...sealed, ciphertext: flipped })).rejects.toThrow();
  });

  it('refuses a different key rather than silently failing open', async () => {
    const sealed = await encryptSecret(KEY, 'wise-token-abc123');
    await expect(decryptSecret(generateCredentialsKey(), sealed)).rejects.toThrow();
  });

  it('rejects a key that is not 32 bytes, rather than padding it into shape', async () => {
    await expect(encryptSecret('c2hvcnQ=', 'x')).rejects.toThrow(/must be 32 base64-encoded bytes/);
  });

  it('generates keys of the size it demands', async () => {
    const key = generateCredentialsKey();
    const sealed = await encryptSecret(key, 'round-trip');
    expect(await decryptSecret(key, sealed)).toBe('round-trip');
  });
});
