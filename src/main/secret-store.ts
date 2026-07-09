import path from 'path';
import fs from 'fs';
import { app, safeStorage } from 'electron';
import { log } from '@shared/logger';
import { generateKey, encryptWithKey, decryptWithKey } from './secret-crypto';
import { sanitizeEnvMap, isReservedEnvKey, type EnvMap } from '@shared/project-env';

/**
 * Project SECRET env vars — encrypted at rest, never synced. This module owns
 * the master-key at-rest protection (the swappable "key-storage seam") + the
 * per-project encrypted store; the value crypto itself is secret-crypto.ts.
 *
 * Key-storage tiers, selected by the ACTUAL runtime backend (never a platform
 * guess), all sharing one AES-256-GCM on-disk format so the tier can upgrade
 * with no data migration:
 *
 *   os-backed — Windows DPAPI (user-bound) · Linux with a REAL keyring
 *               (gnome_libsecret / kwallet*) · SIGNED macOS Keychain. Real
 *               OS-level protection of the master key.
 *   local-key — unsigned macOS · Linux with no keyring (safeStorage backend
 *               'basic_text'). A per-install random master key in a 0600 file:
 *               obfuscation-grade (defeats commodity infostealers scanning for
 *               known plaintext token shapes + accidental cloud-backup exposure),
 *               NOT a targeted local adversary. We NEVER call
 *               setUsePlainTextEncryption / trust 'basic_text' — we degrade to
 *               local-key instead, so a secret is never written in the clear.
 *
 * macOS unsigned MUST be local-key for DURABILITY: Keychain ACLs bind to the
 * code-signing identity; an unsigned build's ad-hoc cdhash changes every update,
 * so a Keychain-stored key becomes inaccessible after an update (data loss).
 * Flip SHELF_MAC_SIGNED=1 only for a signed+notarized release.
 *
 * See context/project-env#4 (crypto + tier seam) and #5 (unsigned-mac durability).
 */

export type KeyTier = 'os-backed' | 'local-key';

const SECRETS_FILE = 'project-secrets.json';
const OS_KEY_FILE = 'secret-key.enc';    // master key wrapped by safeStorage
const LOCAL_KEY_FILE = 'secret-key.local'; // master key, 0600 raw (base64)

/** Real OS keyrings on Linux (safeStorage.getSelectedStorageBackend values). */
const LINUX_REAL_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

function userDataPath(file: string): string {
  return path.join(app.getPath('userData'), file);
}

/**
 * Whether the OS-backed tier genuinely protects the master key on this machine
 * — the authoritative runtime signal, not a platform assumption.
 */
export function osBackedAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'darwin') {
      // Keychain durability holds only on a signed build (see file header).
      return process.env.SHELF_MAC_SIGNED === '1';
    }
    if (process.platform === 'linux') {
      // isEncryptionAvailable() is TRUE even for the hardcoded-key 'basic_text'
      // backend (no real protection) — require a real keyring.
      const backend = safeStorage.getSelectedStorageBackend?.();
      return !!backend && LINUX_REAL_KEYRINGS.has(backend);
    }
    // Windows: DPAPI, user-bound, durable.
    return true;
  } catch (err: any) {
    log.warn('secret-store', `osBackedAvailable probe failed → local-key: ${err?.message ?? err}`);
    return false;
  }
}

/** The active key-storage tier (drives UI disclosure copy). */
export function getKeyTier(): KeyTier {
  return osBackedAvailable() ? 'os-backed' : 'local-key';
}

let cachedKey: Buffer | null = null;

function loadOrCreateMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = osBackedAvailable() ? loadOsKey() : loadLocalKey();
  return cachedKey;
}

function loadOsKey(): Buffer {
  const file = userDataPath(OS_KEY_FILE);
  if (fs.existsSync(file)) {
    const wrapped = fs.readFileSync(file);
    const b64 = safeStorage.decryptString(wrapped);
    return Buffer.from(b64, 'base64');
  }
  const key = generateKey();
  // safeStorage wraps a string → store the base64 key encrypted.
  fs.writeFileSync(file, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
  log.info('secret-store', 'created new os-backed master key');
  return key;
}

function loadLocalKey(): Buffer {
  const file = userDataPath(LOCAL_KEY_FILE);
  if (fs.existsSync(file)) {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  const key = generateKey();
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms w/o POSIX perms */ }
  log.info('secret-store', 'created new local-key master key (0600)');
  return key;
}

type SecretsFile = Record<string, Record<string, string>>; // projectId → KEY → encBlob

function readSecretsFile(): SecretsFile {
  const file = userDataPath(SECRETS_FILE);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as SecretsFile : {};
  } catch (err: any) {
    // Corrupt file — fail loud, do NOT silently wipe the user's secrets.
    log.error('secret-store', `failed to read ${SECRETS_FILE}: ${err?.message ?? err}`);
    throw err;
  }
}

function writeSecretsFile(data: SecretsFile): void {
  const file = userDataPath(SECRETS_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic replace
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

/** The secret KEY names set for a project (no values) — for the settings UI. */
export function listProjectSecretKeys(projectId: string): string[] {
  const section = readSecretsFile()[projectId];
  return section ? Object.keys(section).sort() : [];
}

/**
 * Decrypt this project's secret env vars into a plain map for injection. Only
 * this project's section is ever decrypted (other projects' secrets never enter
 * plaintext memory). A decrypt failure on one key is fail-loud + SKIPPED (never
 * inject a stale/empty value); the key stays in the store so the user can
 * re-enter it. Reserved keys are dropped defensively.
 */
export function resolveProjectSecrets(projectId: string): EnvMap {
  const section = readSecretsFile()[projectId];
  if (!section) return {};
  const key = loadOrCreateMasterKey();
  const out: EnvMap = {};
  for (const [name, blob] of Object.entries(section)) {
    if (isReservedEnvKey(name)) continue;
    try {
      out[name] = decryptWithKey(key, blob);
    } catch (err: any) {
      log.error('secret-store', `decrypt failed for ${projectId}/${name} — skipping (needs re-entry): ${err?.message ?? err}`);
    }
  }
  return out;
}

/** Set (encrypt + persist) one secret. Reserved keys are rejected (backstop). */
export function setProjectSecret(projectId: string, name: string, value: string): void {
  if (isReservedEnvKey(name)) throw new Error(`secret key '${name}' is reserved by Shelf`);
  const key = loadOrCreateMasterKey();
  const data = readSecretsFile();
  (data[projectId] ??= {})[name] = encryptWithKey(key, value);
  writeSecretsFile(data);
}

/** Remove one secret from a project. No-op if absent. */
export function deleteProjectSecret(projectId: string, name: string): void {
  const data = readSecretsFile();
  const section = data[projectId];
  if (!section || !(name in section)) return;
  delete section[name];
  if (Object.keys(section).length === 0) delete data[projectId];
  writeSecretsFile(data);
}

/** Prune a project's whole secret section (on project removal). No-op if absent. */
export function deleteProjectSecrets(projectId: string): void {
  const data = readSecretsFile();
  if (!(projectId in data)) return;
  delete data[projectId];
  writeSecretsFile(data);
}

/** Test-only: drop the cached master key so a later call re-reads from disk. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
