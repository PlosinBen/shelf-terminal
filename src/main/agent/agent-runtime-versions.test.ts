import { describe, it, expect } from 'vitest';
import {
  NODE_VERSION,
  nodeArchiveName,
  nodeDownloadUrl,
  claudePackageName,
  claudeTarballUrl,
  claudeSdkVersion,
} from './agent-runtime-versions';
import { UnsupportedTargetError, type RuntimeTarget } from './runtime-target';

const X64_GLIBC: RuntimeTarget = { arch: 'x64', libc: 'glibc' };
const ARM64_GLIBC: RuntimeTarget = { arch: 'arm64', libc: 'glibc' };
const X64_MUSL: RuntimeTarget = { arch: 'x64', libc: 'musl' };

describe('NODE_VERSION', () => {
  it('is a pinned v20.x (aligned with esbuild node20 target)', () => {
    expect(NODE_VERSION).toMatch(/^v20\.\d+\.\d+$/);
  });
});

describe('nodeArchiveName (glibc only)', () => {
  it('builds the linux glibc archive name', () => {
    expect(nodeArchiveName(X64_GLIBC)).toBe(`node-${NODE_VERSION}-linux-x64`);
    expect(nodeArchiveName(ARM64_GLIBC)).toBe(`node-${NODE_VERSION}-linux-arm64`);
  });
  it('throws on a musl target (defensive — rejected upstream)', () => {
    expect(() => nodeArchiveName(X64_MUSL)).toThrow(UnsupportedTargetError);
  });
});

describe('nodeDownloadUrl', () => {
  it('glibc → nodejs.org official dist (.tar.gz, no extra decoder needed)', () => {
    expect(nodeDownloadUrl(X64_GLIBC)).toBe(
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`,
    );
    expect(nodeDownloadUrl(ARM64_GLIBC)).toContain('https://nodejs.org/dist/');
  });
  it('throws on musl (no official musl Node)', () => {
    expect(() => nodeDownloadUrl(X64_MUSL)).toThrow(UnsupportedTargetError);
  });
});

describe('claudePackageName', () => {
  it('glibc package per arch', () => {
    expect(claudePackageName(ARM64_GLIBC)).toBe('@anthropic-ai/claude-agent-sdk-linux-arm64');
    expect(claudePackageName(X64_GLIBC)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
  });
  it('throws on musl (defensive)', () => {
    expect(() => claudePackageName(X64_MUSL)).toThrow(UnsupportedTargetError);
  });
});

describe('claudeTarballUrl', () => {
  it('builds scoped registry tarball URL (path keeps scope, filename unscoped)', () => {
    expect(claudeTarballUrl(ARM64_GLIBC, '0.3.159')).toBe(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.159.tgz',
    );
    expect(claudeTarballUrl(X64_GLIBC, '0.3.159')).toBe(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.159.tgz',
    );
  });
});

describe('claudeSdkVersion', () => {
  it('reads the bundled SDK version via injected reader', () => {
    expect(claudeSdkVersion((name) => (name.endsWith('claude-agent-sdk') ? '0.3.159' : ''))).toBe('0.3.159');
  });
  it('throws if version cannot be resolved', () => {
    expect(() => claudeSdkVersion(() => '')).toThrow();
  });
});
