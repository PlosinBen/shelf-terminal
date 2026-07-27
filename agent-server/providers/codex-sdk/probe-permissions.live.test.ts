import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { type CodexSdkProbeRequest, type CodexSdkProbeSummary, runCodexSdkProbe } from './probe-harness';

const runLive = process.env.SHELF_CODEX_SDK_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;

interface PermissionProbeReport {
  sdkVersion: '0.145.0';
  cases: Record<string, CodexSdkProbeSummary | Record<string, unknown>>;
}

describeLive('Codex official SDK permission and capability-source probe', () => {
  it('captures bounded permission behavior and available first-party capability sources', async () => {
    const codexPathOverride = resolveInstalledNativeCodexPath();
    const cliEntry = resolveCodexCliEntry();
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
    const workspace = mkdtempSync(path.join(tmpdir(), 'shelf-codex-sdk-permissions-'));
    const outsideDir = mkdtempSync(path.join(process.cwd(), '.codex-sdk-outside-'));
    const report: PermissionProbeReport = { sdkVersion: '0.145.0', cases: {} };
    const base: Omit<CodexSdkProbeRequest, 'input' | 'timeoutMs'> = {
      codexPathOverride,
      codexHome,
      workingDirectory: workspace,
      env: baseProbeEnv(codexHome),
      redactValues: [workspace, outsideDir, codexHome, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter(
        (value): value is string => !!value,
      ),
      threadOptions: {
        skipGitRepoCheck: true,
        model: process.env.SHELF_CODEX_SDK_PROBE_MODEL,
      },
    };

    try {
      const planFile = path.join(workspace, 'plan-mode-write.txt');
      report.cases.plan_read_only_never = await runCodexSdkProbe({
        ...base,
        threadOptions: {
          ...base.threadOptions,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        },
        input: `Attempt to create ${planFile} containing shelf-plan-write, then report the result.`,
        timeoutMs: 90_000,
      });
      expect((report.cases.plan_read_only_never as CodexSdkProbeSummary).outcome).not.toBe('timeout');
      report.cases.plan_read_only_file = { exists: existsSync(planFile) };

      const defaultOutsideFile = path.join(outsideDir, 'default-outside-write.txt');
      report.cases.default_workspace_on_request_escape = await runCodexSdkProbe({
        ...base,
        threadOptions: {
          ...base.threadOptions,
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
        input: `Attempt to create ${defaultOutsideFile} containing shelf-default-outside-write, then report the result.`,
        timeoutMs: 90_000,
      });
      expect((report.cases.default_workspace_on_request_escape as CodexSdkProbeSummary).outcome).not.toBe('timeout');
      report.cases.default_outside_file = { exists: existsSync(defaultOutsideFile) };

      const bypassOutsideFile = path.join(outsideDir, 'bypass-outside-write.txt');
      report.cases.bypass_danger_never = await runCodexSdkProbe({
        ...base,
        threadOptions: {
          ...base.threadOptions,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
        },
        input: `Create ${bypassOutsideFile} containing shelf-bypass-outside-write, then report the result.`,
        timeoutMs: 90_000,
      });
      expect((report.cases.bypass_danger_never as CodexSdkProbeSummary).outcome).not.toBe('timeout');
      report.cases.bypass_outside_file = { exists: existsSync(bypassOutsideFile) };

      report.cases.sdk_public_surface = inspectSdkPublicSurface();
      report.cases.bundled_model_catalog = inspectBundledModelCatalog(cliEntry, codexHome, workspace);
      report.cases.app_server_protocol = inspectAppServerGeneratedProtocol(cliEntry, codexHome, workspace);
    } finally {
      writePermissionReport(report);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 420_000);
});

function resolveInstalledNativeCodexPath(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(`${nativePackageName()}/package.json`);
  const binary = path.join(path.dirname(packageJson), 'vendor', nativeTriple(), 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!existsSync(binary)) throw new Error(`Installed Codex native binary not found at ${binary}`);
  return binary;
}

function resolveCodexCliEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@openai/codex/bin/codex.js');
}

function nativePackageName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return '@openai/codex-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return '@openai/codex-darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return '@openai/codex-linux-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return '@openai/codex-linux-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return '@openai/codex-win32-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return '@openai/codex-win32-x64';
  throw new Error(`Unsupported probe platform: ${process.platform}/${process.arch}`);
}

function nativeTriple(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported probe platform: ${process.platform}/${process.arch}`);
}

function baseProbeEnv(codexHome: string): Record<string, string> {
  return {
    CODEX_HOME: codexHome,
    HOME: homedir(),
    PATH: process.env.PATH ?? '',
    SHELL: process.env.SHELL ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

function inspectSdkPublicSurface(): Record<string, unknown> {
  return {
    codexPrototypeMethods: Object.getOwnPropertyNames(Codex.prototype).filter((name) => name !== 'constructor').sort(),
    hasGatherCapabilitiesApi: 'gatherCapabilities' in Codex.prototype,
    hasModelListApi: 'listModels' in Codex.prototype || 'models' in Codex.prototype,
  };
}

function inspectBundledModelCatalog(cliEntry: string, codexHome: string, workspace: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cliEntry, 'debug', 'models', '--bundled'], {
    cwd: workspace,
    env: baseProbeEnv(codexHome),
    encoding: 'utf8',
    timeout: 30_000,
  });
  let modelCount = 0;
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) {
      modelCount = parsed.length;
      keys = Object.keys(parsed[0] ?? {}).sort();
    } else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      keys = Object.keys(record).sort();
      const maybeModels = Object.values(record).find((value) => Array.isArray(value));
      modelCount = Array.isArray(maybeModels) ? maybeModels.length : 0;
    }
  } catch {
    modelCount = 0;
  }
  return {
    status: result.status,
    modelCount,
    topLevelKeys: keys,
    stderr: result.stderr.slice(0, 2_000),
  };
}

function inspectAppServerGeneratedProtocol(cliEntry: string, codexHome: string, workspace: string): Record<string, unknown> {
  const outDir = path.join(workspace, 'app-server-protocol');
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(process.execPath, [cliEntry, 'app-server', 'generate-ts', '--out', outDir], {
    cwd: workspace,
    env: baseProbeEnv(codexHome),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const files = existsSync(outDir) ? listFiles(outDir).sort() : [];
  const content = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  return {
    status: result.status,
    fileCount: files.length,
    sampleFiles: files.slice(0, 20).map((file) => path.relative(outDir, file)),
    mentionsModel: /\bmodel\b/i.test(content),
    mentionsSlash: /slash/i.test(content),
    mentionsApproval: /approval|permission/i.test(content),
    mentionsCapabilities: /capabilit/i.test(content),
    stderr: result.stderr.slice(0, 2_000),
  };
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = path.join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function writePermissionReport(report: PermissionProbeReport): void {
  const reportDir = path.join(process.cwd(), '.agent', 'features');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'codex-official-sdk-permission-results.json'),
    `${JSON.stringify(
      {
        generatedBy: 'agent-server/providers/codex-sdk/probe-permissions.live.test.ts',
        ...report,
      },
      null,
      2,
    )}\n`,
  );
}
