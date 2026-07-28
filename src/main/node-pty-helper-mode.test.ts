import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  ensureNodePtyHelperMode,
  helperCandidates,
} = require('../../scripts/ensure-node-pty-helper-mode.cjs') as {
  ensureNodePtyHelperMode: (rootDir: string, opts?: { platform?: string; arch?: string }) => Array<{
    filePath: string;
    exists: boolean;
    changed: boolean;
  }>;
  helperCandidates: (rootDir: string, platform?: string, arch?: string) => string[];
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-node-pty-mode-'));
  tempDirs.push(dir);
  return dir;
}

describe('ensureNodePtyHelperMode', () => {
  it('adds executable bits to the current platform node-pty prebuild spawn-helper', () => {
    const root = makeTempRoot();
    const helper = path.join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, '#!/bin/sh\n');
    fs.chmodSync(helper, 0o644);

    const results = ensureNodePtyHelperMode(root, { platform: 'darwin', arch: 'arm64' });

    expect(results.find((r) => r.filePath === helper)).toMatchObject({ exists: true, changed: true });
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it('also checks the source-build Release helper path', () => {
    const root = makeTempRoot();
    const helper = path.join(root, 'node_modules/node-pty/build/Release/spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, '#!/bin/sh\n');
    fs.chmodSync(helper, 0o644);

    ensureNodePtyHelperMode(root, { platform: 'linux', arch: 'x64' });

    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it('skips Windows because node-pty uses conpty/winpty helpers there', () => {
    expect(helperCandidates('/tmp/root', 'win32', 'x64')).toEqual([]);
  });
});
