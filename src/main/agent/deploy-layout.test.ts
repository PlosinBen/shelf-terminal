import { describe, it, expect } from 'vitest';
import {
  deployRoot,
  remoteFilePath,
  deployFilesFor,
  needsDeploy,
  missingFiles,
  cacheDir,
  cachedNodeBin,
  cachedClaudeBin,
  DEPLOY_FILES,
  type RemoteInventory,
} from './deploy-layout';

const GLIBC_FILES = deployFilesFor('glibc');
const MUSL_FILES = deployFilesFor('musl');

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

describe('deployFilesFor', () => {
  it('glibc ships node; musl does not (uses remote node)', () => {
    expect(deployFilesFor('glibc')).toEqual(['node', 'index.mjs', 'claude']);
    expect(deployFilesFor('musl')).toEqual(['index.mjs', 'claude']);
  });
});

describe('needsDeploy / missingFiles (sentinel + expected files)', () => {
  const allPresent = (sentinel: boolean): RemoteInventory => ({
    sentinel,
    files: { node: true, 'index.mjs': true, claude: true },
  });

  it('needs deploy when sentinel missing even if files exist', () => {
    expect(needsDeploy(allPresent(false), GLIBC_FILES)).toBe(true);
  });
  it('needs deploy when an expected file is missing even with sentinel', () => {
    const inv: RemoteInventory = { sentinel: true, files: { node: true, claude: true } };
    expect(needsDeploy(inv, GLIBC_FILES)).toBe(true);
    expect(missingFiles(inv, GLIBC_FILES)).toEqual(['index.mjs']);
  });
  it('skips deploy when sentinel present AND all expected files exist', () => {
    expect(needsDeploy(allPresent(true), GLIBC_FILES)).toBe(false);
    expect(missingFiles(allPresent(true), GLIBC_FILES)).toEqual([]);
  });
  it('musl does not require node: a node-less inventory is complete for musl', () => {
    const inv: RemoteInventory = { sentinel: true, files: { 'index.mjs': true, claude: true } };
    expect(needsDeploy(inv, MUSL_FILES)).toBe(false);
    expect(missingFiles(inv, MUSL_FILES)).toEqual([]);
    // ...but the same inventory WOULD need node under glibc.
    expect(needsDeploy(inv, GLIBC_FILES)).toBe(true);
  });
  it('all expected missing when inventory empty', () => {
    expect(missingFiles({ sentinel: false, files: {} }, GLIBC_FILES)).toEqual([...DEPLOY_FILES]);
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
