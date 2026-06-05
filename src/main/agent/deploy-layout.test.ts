import { describe, it, expect } from 'vitest';
import {
  deployRoot,
  remoteFilePath,
  needsDeploy,
  missingFiles,
  cacheDir,
  cachedNodeBin,
  cachedClaudeBin,
  DEPLOY_FILES,
  type RemoteInventory,
} from './deploy-layout';

describe('deployRoot / remoteFilePath (POSIX, version-scoped)', () => {
  it('builds versioned root under <base>/.shelf/agent-server', () => {
    expect(deployRoot('~', '2.4.3')).toBe('~/.shelf/agent-server/2.4.3');
    expect(deployRoot('/root', '2.4.3')).toBe('/root/.shelf/agent-server/2.4.3');
  });
  it('trims trailing slashes on base', () => {
    expect(deployRoot('/root/', '1.0.0')).toBe('/root/.shelf/agent-server/1.0.0');
  });
  it('never emits backslashes (remote is always POSIX even from a Windows host)', () => {
    expect(remoteFilePath('~', '2.4.3', 'node')).toBe('~/.shelf/agent-server/2.4.3/node');
    expect(remoteFilePath('~', '2.4.3', 'index.mjs')).not.toContain('\\');
  });
});

describe('needsDeploy / missingFiles (sentinel + all payload files)', () => {
  const allPresent = (sentinel: boolean): RemoteInventory => ({
    sentinel,
    files: { node: true, 'index.mjs': true, claude: true },
  });

  it('needs deploy when sentinel missing even if files exist', () => {
    expect(needsDeploy(allPresent(false))).toBe(true);
  });
  it('needs deploy when a payload file is missing even with sentinel', () => {
    const inv: RemoteInventory = { sentinel: true, files: { node: true, claude: true } };
    expect(needsDeploy(inv)).toBe(true);
    expect(missingFiles(inv)).toEqual(['index.mjs']);
  });
  it('skips deploy when sentinel present AND all files exist', () => {
    expect(needsDeploy(allPresent(true))).toBe(false);
    expect(missingFiles(allPresent(true))).toEqual([]);
  });
  it('all missing when inventory empty', () => {
    expect(missingFiles({ sentinel: false, files: {} })).toEqual([...DEPLOY_FILES]);
  });
});

describe('host cache paths (host separators via path.join)', () => {
  it('cacheDir is per-target under runtime-cache', () => {
    expect(cacheDir('/u/data', 'x64-glibc')).toBe('/u/data/runtime-cache/x64-glibc');
  });
  it('cachedNodeBin points at <archive>/bin/node', () => {
    expect(cachedNodeBin('/u/data', 'arm64-glibc', 'node-v20.18.1-linux-arm64')).toBe(
      '/u/data/runtime-cache/arm64-glibc/node-v20.18.1-linux-arm64/bin/node',
    );
  });
  it('cachedClaudeBin is versioned by sdk version', () => {
    expect(cachedClaudeBin('/u/data', 'x64-musl', '0.3.159')).toBe(
      '/u/data/runtime-cache/x64-musl/claude-0.3.159/claude',
    );
  });
});
