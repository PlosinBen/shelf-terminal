#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function helperCandidates(rootDir, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return [];
  const nodePtyRoot = path.join(rootDir, 'node_modules', 'node-pty');
  // node-pty's Unix prebuild calls spawn-helper during pty.fork(); if npm
  // leaves it non-executable, terminal spawn fails as `posix_spawnp failed`.
  // See .agent/context/terminal-pty.md terminal-pty#9.
  return [
    path.join(nodePtyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  ];
}

function ensureExecutable(filePath) {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o111) !== 0) {
    return false;
  }
  fs.chmodSync(filePath, stat.mode | 0o111);
  return true;
}

function ensureNodePtyHelperMode(rootDir = process.cwd(), opts = {}) {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const candidates = helperCandidates(rootDir, platform, arch);
  const results = [];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      results.push({ filePath, exists: false, changed: false });
      continue;
    }
    results.push({ filePath, exists: true, changed: ensureExecutable(filePath) });
  }

  return results;
}

if (require.main === module) {
  const results = ensureNodePtyHelperMode();
  for (const result of results) {
    if (!result.exists) continue;
    const action = result.changed ? 'fixed executable bit' : 'executable bit already set';
    console.log(`[postinstall] node-pty ${action}: ${result.filePath}`);
  }
}

module.exports = {
  helperCandidates,
  ensureNodePtyHelperMode,
};
