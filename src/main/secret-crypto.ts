import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Pure AES-256-GCM value encryption — the crypto core for project secret env
 * vars. Dependency-free (no electron, no fs) so it's fully unit-testable; the
 * KEY's at-rest protection (OS keychain vs local 0600 file) is a separate
 * concern owned by secret-store.ts.
 *
 * Design is deliberately OPEN and standard (Kerckhoffs): security comes from
 * the key's location, never from hiding this code. The blob is authenticated
 * (GCM tag) so tampering / a wrong key fails loudly on decrypt instead of
 * returning garbage.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM standard nonce length
const KEY_BYTES = 32;  // AES-256
const VERSION = 'v1';

/** A fresh random 256-bit key (the master key secret-store persists per install). */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt a UTF-8 string with `key` → a self-describing, versioned blob:
 * `v1:<iv b64>:<tag b64>:<ciphertext b64>`. A random IV per call means the same
 * value encrypts differently every time (no equality leak).
 */
export function encryptWithKey(key: Buffer, plain: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypt a blob produced by {@link encryptWithKey}. Throws on a malformed blob,
 * an unknown version, a wrong key, or any tampering (GCM auth failure) — callers
 * must treat a throw as "secret unavailable" and fail loud, never inject a
 * stale/empty value silently.
 */
export function decryptWithKey(key: Buffer, blob: string): string {
  assertKey(key);
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`secret-crypto: unrecognized blob format`);
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const enc = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV_BYTES) throw new Error('secret-crypto: bad IV length');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** True if `blob` looks like an encrypted secret blob (versioned envelope). */
export function isEncryptedBlob(blob: unknown): blob is string {
  return typeof blob === 'string' && blob.startsWith(`${VERSION}:`);
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`secret-crypto: key must be ${KEY_BYTES} bytes`);
  }
}
