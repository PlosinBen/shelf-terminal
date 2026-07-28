import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import {
  NODE_VERSION,
  CLAUDE_SDK_VERSION,
  COPILOT_CLI_VERSION,
  CODEX_ACP_VERSION,
  CODEX_CLI_VERSION,
  ACP_SDK_VERSION,
  nodeArchiveName,
  nodeDownloadUrl,
  claudePackageName,
  claudeTarballUrl,
  copilotPackageName,
  copilotTarballUrl,
  codexNativeTarballUrl,
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
  it('musl package per arch (official -musl companion exists for both)', () => {
    expect(claudePackageName(X64_MUSL)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64-musl');
    expect(claudePackageName({ arch: 'arm64', libc: 'musl' })).toBe(
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
    );
  });
});

describe('claudeTarballUrl', () => {
  it('builds scoped registry tarball URL (path keeps scope, filename unscoped)', () => {
    expect(claudeTarballUrl(ARM64_GLIBC, '0.3.159')).toBe(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.159.tgz',
    );
    expect(claudeTarballUrl(X64_MUSL, '0.3.159')).toBe(
      'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64-musl/-/claude-agent-sdk-linux-x64-musl-0.3.159.tgz',
    );
  });
});

describe('CLAUDE_SDK_VERSION', () => {
  // Drift guard: the pinned companion version must equal the installed
  // @anthropic-ai/claude-agent-sdk dependency, or the downloaded Claude binary
  // won't match the SDK JS bundled into agent-server.
  it('matches the installed @anthropic-ai/claude-agent-sdk version', () => {
    const pkg = JSON.parse(
      readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'),
    );
    expect(CLAUDE_SDK_VERSION).toBe(pkg.version);
  });
});

describe('COPILOT_CLI_VERSION', () => {
  // Drift guard: pinned Copilot companion version must equal the installed
  // @github/copilot dependency.
  it('matches the installed @github/copilot version', () => {
    const pkg = JSON.parse(readFileSync('node_modules/@github/copilot/package.json', 'utf8'));
    expect(COPILOT_CLI_VERSION).toBe(pkg.version);
  });
});

describe('Codex ACP runtime versions', () => {
  // Drift guard: Codex ACP, its SDK, and the Codex CLI are a tested protocol
  // unit. All three must stay exact and match the installed direct packages.
  it('matches the installed exact Codex ACP runtime set', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    const acp = JSON.parse(readFileSync('node_modules/@agentclientprotocol/codex-acp/package.json', 'utf8'));
    const cli = JSON.parse(readFileSync('node_modules/@openai/codex/package.json', 'utf8'));
    const sdk = JSON.parse(readFileSync('node_modules/@agentclientprotocol/sdk/package.json', 'utf8'));
    expect(root.dependencies['@agentclientprotocol/codex-acp']).toBe(CODEX_ACP_VERSION);
    expect(root.dependencies['@openai/codex']).toBe(CODEX_CLI_VERSION);
    expect(root.dependencies['@agentclientprotocol/sdk']).toBe(ACP_SDK_VERSION);
    expect(CODEX_ACP_VERSION).toBe(acp.version);
    expect(CODEX_CLI_VERSION).toBe(cli.version);
    expect(ACP_SDK_VERSION).toBe(sdk.version);
  });
});

describe('Codex runtime versions', () => {
  it('does not install a second Codex CLI tree under the legacy ACP adapter', () => {
    expect(existsSync('node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex')).toBe(false);
  });
});

describe('copilotPackageName / copilotTarballUrl', () => {
  it('uses linux / linuxmusl variant prefix per (arch × libc)', () => {
    expect(copilotPackageName(X64_GLIBC)).toBe('@github/copilot-linux-x64');
    expect(copilotPackageName(ARM64_GLIBC)).toBe('@github/copilot-linux-arm64');
    expect(copilotPackageName(X64_MUSL)).toBe('@github/copilot-linuxmusl-x64');
    expect(copilotPackageName({ arch: 'arm64', libc: 'musl' })).toBe('@github/copilot-linuxmusl-arm64');
  });
  it('builds the scoped registry tarball URL', () => {
    expect(copilotTarballUrl(X64_GLIBC, '1.0.56')).toBe(
      'https://registry.npmjs.org/@github/copilot-linux-x64/-/copilot-linux-x64-1.0.56.tgz',
    );
  });
});

describe('codexNativeTarballUrl', () => {
  it('uses the Codex alias package tarball name, not the target package name', () => {
    expect(codexNativeTarballUrl('arm64', CODEX_CLI_VERSION)).toBe(
      `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-arm64.tgz`,
    );
  });
});
