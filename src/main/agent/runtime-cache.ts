/**
 * Runtime cache (R1, Phase 1.1).
 *
 * Lazily fetches the per-target Node runtime (glibc only) and the Claude CLI
 * binary, verifies integrity, extracts the single file we need, and caches it
 * under userData so we only pay the download once per (target × artifact). The
 * deploy layer then ships the cached file to the remote.
 *
 * Cross-platform with zero environment branching: gzip via built-in `zlib`,
 * tar via our own `tar.ts` — never the system `tar`/`xz` (host may be Windows).
 *
 * Pure helpers (parseShasums / integrityMatches / sha256hex) are exported for
 * unit tests; `download` is injectable so the cache orchestration can be tested
 * with synthetic archives, no network.
 */

import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { findFile } from './tar';
import { type RuntimeTarget, targetId } from './runtime-target';
import {
  NODE_VERSION,
  nodeArchiveName,
  nodeDownloadUrl,
  nodeShasumsUrl,
  claudeTarballUrl,
  claudeManifestUrl,
} from './agent-runtime-versions';
import { cachedNodeBin, cachedClaudeBin } from './deploy-layout';

// ── pure helpers ──────────────────────────────────────────────────────────

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Find the sha256 for `filename` in a nodejs.org SHASUMS256.txt body. */
export function parseShasums(text: string, filename: string): string | undefined {
  for (const line of text.split('\n')) {
    // `<64-hex>  <name>` (a leading `*` marks binary mode in some tools).
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return undefined;
}

/** Verify a buffer against an SRI integrity string like `sha512-<base64>`. */
export function integrityMatches(buf: Buffer, integrity: string): boolean {
  const dash = integrity.indexOf('-');
  if (dash < 0) return false;
  const algo = integrity.slice(0, dash);
  const expected = integrity.slice(dash + 1);
  try {
    return createHash(algo).update(buf).digest('base64') === expected;
  } catch {
    return false;
  }
}

// ── I/O ───────────────────────────────────────────────────────────────────

export interface CacheDeps {
  download(url: string): Promise<Buffer>;
}

function httpGet(url: string, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const { statusCode = 0, headers } = res;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          return resolve(httpGet(new URL(headers.location, url).toString(), redirectsLeft - 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} → HTTP ${statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

const defaultDeps: CacheDeps = { download: httpGet };

/** Atomically write a binary file with the executable bit set. */
async function writeBinary(dest: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.chmod(tmp, 0o755).catch(() => {}); // no-op semantics on win32
  await fsp.rename(tmp, dest);
}

/**
 * Ensure the glibc Node binary for `target` is cached; returns its path.
 * Downloads + sha256-verifies + extracts `bin/node` on a cache miss.
 */
export async function ensureNodeCached(
  userData: string,
  target: RuntimeTarget,
  deps: CacheDeps = defaultDeps,
): Promise<string> {
  const archive = nodeArchiveName(target); // node-v20.18.1-linux-<arch>
  const dest = cachedNodeBin(userData, targetId(target), archive);
  if (fs.existsSync(dest)) return dest;

  const [tgz, shasums] = await Promise.all([
    deps.download(nodeDownloadUrl(target)),
    deps.download(nodeShasumsUrl()),
  ]);

  const expected = parseShasums(shasums.toString('utf8'), `${archive}.tar.gz`);
  if (!expected) throw new Error(`No SHASUMS256 entry for ${archive}.tar.gz`);
  if (sha256hex(tgz) !== expected) throw new Error(`Node tarball sha256 mismatch for ${archive}`);

  const entry = findFile(gunzipSync(tgz), `${archive}/bin/node`);
  if (!entry) throw new Error(`bin/node not found in ${archive}.tar.gz`);

  await writeBinary(dest, entry.data);
  return dest;
}

/**
 * Ensure the Claude CLI binary for `target`+`sdkVersion` is cached; returns its
 * path. Downloads + SRI-verifies (npm `dist.integrity`) + extracts on a miss.
 */
export async function ensureClaudeCached(
  userData: string,
  target: RuntimeTarget,
  sdkVersion: string,
  deps: CacheDeps = defaultDeps,
): Promise<string> {
  const dest = cachedClaudeBin(userData, targetId(target), sdkVersion);
  if (fs.existsSync(dest)) return dest;

  const tgz = await deps.download(claudeTarballUrl(target, sdkVersion));

  // Integrity from the npm version manifest's dist.integrity (SRI sha512).
  const manifestRaw = await deps.download(claudeManifestUrl(target, sdkVersion));
  const integrity: string | undefined = JSON.parse(manifestRaw.toString('utf8'))?.dist?.integrity;
  if (integrity && !integrityMatches(tgz, integrity)) {
    throw new Error(`Claude tarball integrity mismatch for ${targetId(target)}@${sdkVersion}`);
  }

  const entry = findFile(gunzipSync(tgz), 'package/claude');
  if (!entry) throw new Error('package/claude not found in Claude companion tarball');

  await writeBinary(dest, entry.data);
  return dest;
}

export { NODE_VERSION };
