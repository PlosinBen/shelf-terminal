import { describe, it, expect } from 'vitest';
import { generateKey, encryptWithKey, decryptWithKey, isEncryptedBlob } from './secret-crypto';

describe('secret-crypto', () => {
  it('round-trips a value', () => {
    const key = generateKey();
    const blob = encryptWithKey(key, 'gho_supersecret');
    expect(decryptWithKey(key, blob)).toBe('gho_supersecret');
  });

  it('round-trips unicode and empty strings', () => {
    const key = generateKey();
    for (const v of ['', 'héllo 🌍', 'a'.repeat(5000)]) {
      expect(decryptWithKey(key, encryptWithKey(key, v))).toBe(v);
    }
  });

  it('produces a versioned, self-describing blob', () => {
    const blob = encryptWithKey(generateKey(), 'x');
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob.split(':')).toHaveLength(4);
    expect(isEncryptedBlob(blob)).toBe(true);
    expect(isEncryptedBlob('plain')).toBe(false);
  });

  it('encrypts the same value differently each time (random IV, no equality leak)', () => {
    const key = generateKey();
    expect(encryptWithKey(key, 'same')).not.toBe(encryptWithKey(key, 'same'));
  });

  it('fails loud on the wrong key', () => {
    const blob = encryptWithKey(generateKey(), 'secret');
    expect(() => decryptWithKey(generateKey(), blob)).toThrow();
  });

  it('fails loud on tampering (auth tag mismatch)', () => {
    const key = generateKey();
    const blob = encryptWithKey(key, 'secret');
    const parts = blob.split(':');
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptWithKey(key, parts.join(':'))).toThrow();
  });

  it('rejects a malformed or wrong-version blob', () => {
    const key = generateKey();
    expect(() => decryptWithKey(key, 'nope')).toThrow(/unrecognized/);
    expect(() => decryptWithKey(key, 'v2:a:b:c')).toThrow(/unrecognized/);
  });

  it('rejects a wrong-size key', () => {
    expect(() => encryptWithKey(Buffer.alloc(16), 'x')).toThrow(/32 bytes/);
  });
});
