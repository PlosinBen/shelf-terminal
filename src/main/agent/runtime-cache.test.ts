import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseShasums,
  integrityMatches,
  sha256hex,
  ensureNodeCached,
  ensureClaudeCached,
  ensureCopilotCached,
  type CacheDeps,
} from './runtime-cache';
import { nodeArchiveName, nodeShasumsUrl, claudeManifestUrl, copilotManifestUrl } from './agent-runtime-versions';
import { cachedNodeBin, cachedClaudeBin, cachedCopilotBin } from './deploy-layout';
import { targetId, type RuntimeTarget } from './runtime-target';

const X64: RuntimeTarget = { arch: 'x64', libc: 'glibc' };
const BLOCK = 512;

// ── tiny tar.gz builder (one file) ──
function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0);
  h.write(mode.toString(8).padStart(7, '0'), 100);
  h.write(size.toString(8).padStart(11, '0'), 124);
  h.write('0', 156);
  h.write('ustar', 257);
  return h;
}
function tarGz(name: string, content: string, mode = 0o755): Buffer {
  const data = Buffer.from(content);
  const padded = Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
  const tar = Buffer.concat([tarHeader(name, data.length, mode), padded, Buffer.alloc(BLOCK * 2)]);
  return gzipSync(tar);
}

describe('parseShasums', () => {
  const body = [
    '111...short',
    `${'a'.repeat(64)}  node-v20.18.1-linux-x64.tar.gz`,
    `${'b'.repeat(64)}  node-v20.18.1-linux-arm64.tar.gz`,
  ].join('\n');
  it('finds the sha for an exact filename', () => {
    expect(parseShasums(body, 'node-v20.18.1-linux-x64.tar.gz')).toBe('a'.repeat(64));
  });
  it('returns undefined when absent', () => {
    expect(parseShasums(body, 'nope.tar.gz')).toBeUndefined();
  });
  it('tolerates a leading * (binary mode marker)', () => {
    expect(parseShasums(`${'c'.repeat(64)} *file.bin`, 'file.bin')).toBe('c'.repeat(64));
  });
});

describe('integrityMatches', () => {
  const buf = Buffer.from('hello');
  const sri = 'sha512-' + createHash('sha512').update(buf).digest('base64');
  it('matches a correct SRI', () => {
    expect(integrityMatches(buf, sri)).toBe(true);
  });
  it('rejects a wrong SRI', () => {
    expect(integrityMatches(Buffer.from('other'), sri)).toBe(false);
  });
  it('rejects malformed integrity', () => {
    expect(integrityMatches(buf, 'not-an-sri-without-algo-sep')).toBe(false);
  });
});

describe('ensureNodeCached', () => {
  let userData: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-node-'));
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  function nodeDeps(): CacheDeps & { calls: number } {
    const archive = nodeArchiveName(X64);
    const tgz = tarGz(`${archive}/bin/node`, 'NODEBIN');
    const shasums = `${sha256hex(tgz)}  ${archive}.tar.gz\n`;
    const d = {
      calls: 0,
      async download(url: string) {
        d.calls++;
        return url === nodeShasumsUrl() ? Buffer.from(shasums) : tgz;
      },
    };
    return d;
  }

  it('downloads, verifies, extracts bin/node with exec bit, returns cached path', async () => {
    const deps = nodeDeps();
    const p = await ensureNodeCached(userData, X64, deps);
    expect(p).toBe(cachedNodeBin(userData, targetId(X64), nodeArchiveName(X64)));
    expect(fs.readFileSync(p, 'utf8')).toBe('NODEBIN');
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });

  it('second call hits cache (no further downloads)', async () => {
    const deps = nodeDeps();
    await ensureNodeCached(userData, X64, deps);
    const after = deps.calls;
    await ensureNodeCached(userData, X64, deps);
    expect(deps.calls).toBe(after); // unchanged
  });

  it('throws on sha256 mismatch', async () => {
    const archive = nodeArchiveName(X64);
    const tgz = tarGz(`${archive}/bin/node`, 'NODEBIN');
    const badDeps: CacheDeps = {
      async download(url) {
        return url === nodeShasumsUrl() ? Buffer.from(`${'0'.repeat(64)}  ${archive}.tar.gz\n`) : tgz;
      },
    };
    await expect(ensureNodeCached(userData, X64, badDeps)).rejects.toThrow(/sha256 mismatch/);
  });
});

describe('ensureClaudeCached', () => {
  let userData: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-claude-'));
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  const VER = '0.3.159';
  function claudeDeps(): CacheDeps {
    const tgz = tarGz('package/claude', 'CLAUDEBIN');
    const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64');
    return {
      async download(url) {
        return url === claudeManifestUrl(X64, VER)
          ? Buffer.from(JSON.stringify({ dist: { integrity } }))
          : tgz;
      },
    };
  }

  it('downloads, SRI-verifies, extracts package/claude with exec bit', async () => {
    const p = await ensureClaudeCached(userData, X64, VER, claudeDeps());
    expect(p).toBe(cachedClaudeBin(userData, targetId(X64), VER));
    expect(fs.readFileSync(p, 'utf8')).toBe('CLAUDEBIN');
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });

  it('throws on integrity mismatch', async () => {
    const tgz = tarGz('package/claude', 'CLAUDEBIN');
    const badDeps: CacheDeps = {
      async download(url) {
        return url === claudeManifestUrl(X64, VER)
          ? Buffer.from(JSON.stringify({ dist: { integrity: 'sha512-' + 'AAAA' } }))
          : tgz;
      },
    };
    await expect(ensureClaudeCached(userData, X64, VER, badDeps)).rejects.toThrow(/integrity mismatch/);
  });
});

describe('ensureCopilotCached', () => {
  let userData: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-copilot-'));
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  const VER = '1.0.56';
  it('downloads, SRI-verifies, extracts package/copilot with exec bit', async () => {
    const tgz = tarGz('package/copilot', 'COPILOTBIN');
    const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64');
    const deps: CacheDeps = {
      async download(url) {
        return url === copilotManifestUrl(X64, VER)
          ? Buffer.from(JSON.stringify({ dist: { integrity } }))
          : tgz;
      },
    };
    const p = await ensureCopilotCached(userData, X64, VER, deps);
    expect(p).toBe(cachedCopilotBin(userData, targetId(X64), VER));
    expect(fs.readFileSync(p, 'utf8')).toBe('COPILOTBIN');
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });
});
