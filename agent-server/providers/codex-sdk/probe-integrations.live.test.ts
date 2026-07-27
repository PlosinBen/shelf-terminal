import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { type CodexSdkProbeRequest, type CodexSdkProbeSummary, runCodexSdkProbe } from './probe-harness';

const runLive = process.env.SHELF_CODEX_SDK_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;

interface IntegrationProbeReport {
  sdkVersion: '0.145.0';
  cases: Record<string, CodexSdkProbeSummary | Record<string, unknown>>;
}

describeLive('Codex official SDK app-scoped integration probe', () => {
  it('captures auth, MCP, skills, env redaction, and shared-home concurrency evidence', async () => {
    const codexPathOverride = resolveInstalledNativeCodexPath();
    const cliEntry = resolveCodexCliEntry();
    const existingCodexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
    const workspace = mkdtempSync(path.join(tmpdir(), 'shelf-codex-sdk-integrations-'));
    const freshCodexHome = path.join(workspace, 'fresh-codex-home');
    mkdirSync(freshCodexHome, { recursive: true });
    const stdioMcpPath = path.join(workspace, 'shelf-probe-stdio-mcp.cjs');
    writeFileSync(stdioMcpPath, mcpStdioProbeServerSource());
    const secretSentinel = 'shelf-secret-sentinel-value';
    const report: IntegrationProbeReport = { sdkVersion: '0.145.0', cases: {} };

    const httpMcp = await startHttpMcpProbeServer();
    try {
      const base: Omit<CodexSdkProbeRequest, 'input' | 'timeoutMs'> = {
        codexPathOverride,
        codexHome: existingCodexHome,
        workingDirectory: workspace,
        env: {
          ...baseProbeEnv(existingCodexHome),
          SHELF_HTTP_MCP_TOKEN: secretSentinel,
        },
        redactValues: [existingCodexHome, workspace, secretSentinel, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter(
          (value): value is string => !!value,
        ),
        threadOptions: {
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          model: process.env.SHELF_CODEX_SDK_PROBE_MODEL,
        },
      };

      report.cases.existing_auth_home = await runCodexSdkProbe({
        ...base,
        input: 'Reply with exactly: shelf-existing-auth-ok',
        timeoutMs: 60_000,
      });
      expect((report.cases.existing_auth_home as CodexSdkProbeSummary).ok).toBe(true);

      report.cases.fresh_app_home = await runCodexSdkProbe({
        ...base,
        codexHome: freshCodexHome,
        env: baseProbeEnv(freshCodexHome),
        input: 'Reply with exactly: should-not-authenticate',
        timeoutMs: 45_000,
      });
      expect((report.cases.fresh_app_home as CodexSdkProbeSummary).ok).toBe(false);

      report.cases.user_stdio_mcp = await runCodexSdkProbe({
        ...base,
        config: {
          mcp_servers: {
            shelf_probe_stdio: {
              command: process.execPath,
              args: [stdioMcpPath],
              cwd: workspace,
              required: true,
              enabled_tools: ['shelf_probe_stdio_echo'],
              default_tools_approval_mode: 'approve',
            },
          },
        },
        input: 'Call the shelf_probe_stdio_echo MCP tool. Then reply exactly: shelf-stdio-mcp-done.',
        timeoutMs: 90_000,
      });
      expect((report.cases.user_stdio_mcp as CodexSdkProbeSummary).ok).toBe(true);
      expect((report.cases.user_stdio_mcp as CodexSdkProbeSummary).events.some((event) => event.itemType === 'mcp_tool_call')).toBe(true);

      report.cases.user_http_mcp = await runCodexSdkProbe({
        ...base,
        config: {
          mcp_servers: {
            shelf_probe_http: {
              url: httpMcp.url,
              required: true,
              bearer_token_env_var: 'SHELF_HTTP_MCP_TOKEN',
              enabled_tools: ['shelf_probe_http_echo'],
              default_tools_approval_mode: 'approve',
            },
          },
        },
        input: 'Call the shelf_probe_http_echo MCP tool. Then reply exactly: shelf-http-mcp-done.',
        timeoutMs: 90_000,
      });
      report.cases.user_http_mcp_server_errors = { errors: httpMcp.errors };
      expect((report.cases.user_http_mcp as CodexSdkProbeSummary).ok).toBe(true);
      expect((report.cases.user_http_mcp as CodexSdkProbeSummary).events.some((event) => event.itemType === 'mcp_tool_call')).toBe(true);

      report.cases.required_l1_failure = await runCodexSdkProbe({
        ...base,
        config: {
          mcp_servers: {
            shelf_required_missing: {
              command: path.join(workspace, 'missing-required-mcp'),
              required: true,
            },
          },
        },
        input: 'Reply with exactly: should-not-run-without-required-mcp',
        timeoutMs: 45_000,
      });
      expect((report.cases.required_l1_failure as CodexSdkProbeSummary).ok).toBe(false);

      report.cases.argv_env_secret_inspection = await runFakeExecutableInspection(workspace, existingCodexHome, secretSentinel);
      expect(JSON.stringify(report.cases.argv_env_secret_inspection)).not.toContain(secretSentinel);
      expect((report.cases.argv_env_secret_inspection as Record<string, unknown>).secretInArgv).toBe(false);
      expect((report.cases.argv_env_secret_inspection as Record<string, unknown>).secretEnvReachedChild).toBe(true);

      report.cases.skill_projection = runSkillProjectionProbe(cliEntry, workspace);
      expect((report.cases.skill_projection as Record<string, unknown>).homeSkillCount).toBe(1);
      expect((report.cases.skill_projection as Record<string, unknown>).codexHomeSkillCount).toBe(0);

      report.cases.shared_home_app_server_overlap = await runSharedHomeAppServerOverlapProbe(
        cliEntry,
        codexPathOverride,
        existingCodexHome,
        workspace,
        base.redactValues ?? [],
      );
    } finally {
      await httpMcp.close();
      writeIntegrationReport(report);
    }
  }, 480_000);
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

async function startHttpMcpProbeServer(): Promise<{ url: string; errors: string[]; close: () => Promise<void> }> {
  const errors: string[] = [];
  const mcp = new McpServer({ name: 'shelf-probe-http-mcp', version: '1.0.0' });
  mcp.registerTool(
    'shelf_probe_http_echo',
    {
      description: 'Return a fixed Shelf Codex SDK HTTP MCP probe marker.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: 'shelf-http-mcp-probe-result' }] }),
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    void readJsonRequestBody(req)
      .then((body) => transport.handleRequest(req, res, body))
      .catch((error) => {
        errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP MCP server did not bind a TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    errors,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
      await transport.close();
      await mcp.close();
    },
  };
}

async function readJsonRequestBody(req: Parameters<StreamableHTTPServerTransport['handleRequest']>[0]): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function runFakeExecutableInspection(
  workspace: string,
  codexHome: string,
  secretSentinel: string,
): Promise<Record<string, unknown>> {
  const fakeCodexPath = path.join(workspace, 'fake-codex-exec.cjs');
  const capturePath = path.join(workspace, 'fake-codex-capture.json');
  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      CODEX_HOME: process.env.CODEX_HOME,
      SHELF_SECRET_SENTINEL: process.env.SHELF_SECRET_SENTINEL,
    },
    stdinLength: stdin.length,
  }, null, 2));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  }}));
});
`,
  );
  chmodSync(fakeCodexPath, 0o755);

  const probe = await runCodexSdkProbe({
    codexPathOverride: fakeCodexPath,
    codexHome,
    workingDirectory: workspace,
    input: 'Inspect argv and env.',
    timeoutMs: 10_000,
    env: {
      ...baseProbeEnv(codexHome),
      SHELF_SECRET_SENTINEL: secretSentinel,
    },
    config: {
      mcp_servers: {
        secret_stdio: {
          command: 'node',
          args: ['server.js'],
          env_vars: ['SHELF_SECRET_SENTINEL'],
        },
        secret_http: {
          url: 'http://127.0.0.1:9/mcp',
          bearer_token_env_var: 'SHELF_SECRET_SENTINEL',
          env_http_headers: {
            'X-Shelf-Secret': 'SHELF_SECRET_SENTINEL',
          },
        },
      },
    },
    redactValues: [secretSentinel, workspace, codexHome],
  });
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  const argvJson = JSON.stringify(capture.argv);
  return {
    ok: probe.ok,
    outcome: probe.outcome,
    secretInArgv: argvJson.includes(secretSentinel),
    secretNameInArgv: argvJson.includes('SHELF_SECRET_SENTINEL'),
    secretEnvReachedChild: capture.env.SHELF_SECRET_SENTINEL === secretSentinel,
    stdinLength: capture.stdinLength,
  };
}

function runSkillProjectionProbe(cliEntry: string, workspace: string): Record<string, unknown> {
  const codexHomeRoot = path.join(workspace, 'skill-codex-home-root');
  const homeRoot = path.join(workspace, 'skill-home-root');
  const codexHome = path.join(codexHomeRoot, 'codex');
  const homeProjectionCodexHome = path.join(homeRoot, 'codex');
  mkdirSync(path.join(codexHome, '.agents', 'skills', 'shelf-probe'), { recursive: true });
  mkdirSync(homeProjectionCodexHome, { recursive: true });
  mkdirSync(path.join(homeRoot, '.agents', 'skills', 'shelf-probe'), { recursive: true });
  const skill = `---
name: shelf_probe_skill_marker
description: Use for Shelf Codex SDK skill projection probe.
---

# Shelf Probe Skill

When asked about the shelf projection marker, answer shelf-skill-probe-result.
`;
  writeFileSync(path.join(codexHome, '.agents', 'skills', 'shelf-probe', 'SKILL.md'), skill);
  writeFileSync(path.join(homeRoot, '.agents', 'skills', 'shelf-probe', 'SKILL.md'), skill);

  const codexHomeOnly = renderPromptInput(cliEntry, workspace, {
    CODEX_HOME: codexHome,
    HOME: homedir(),
    PATH: process.env.PATH ?? '',
  }, ['-C', workspace, '--add-dir', codexHome, 'debug', 'prompt-input', 'Probe available skills.']);
  const homeProjection = renderPromptInput(cliEntry, workspace, {
    CODEX_HOME: homeProjectionCodexHome,
    HOME: homeRoot,
    PATH: process.env.PATH ?? '',
  }, ['-C', workspace, 'debug', 'prompt-input', 'Probe available skills.']);

  return {
    codexHomeSkillCount: countOccurrences(codexHomeOnly.stdout, 'shelf_probe_skill_marker'),
    homeSkillCount: countOccurrences(homeProjection.stdout, 'shelf_probe_skill_marker'),
    codexHomeExitCode: codexHomeOnly.status,
    homeExitCode: homeProjection.status,
  };
}

function renderPromptInput(
  cliEntry: string,
  workspace: string,
  env: Record<string, string>,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runSharedHomeAppServerOverlapProbe(
  cliEntry: string,
  codexPathOverride: string,
  codexHome: string,
  workspace: string,
  redactValues: string[],
): Promise<Record<string, unknown>> {
  const socketPath = path.join(tmpdir(), `shelf-codex-${process.pid}-${Date.now()}.sock`);
  const child = spawn(process.execPath, [cliEntry, 'app-server', '--listen', `unix://${socketPath}`], {
    cwd: workspace,
    env: baseProbeEnv(codexHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const appServerExitedBeforeSdk = child.exitCode !== null;

  const sdkProbe = await runCodexSdkProbe({
    codexPathOverride,
    codexHome,
    workingDirectory: workspace,
    input: 'Reply with exactly: shelf-overlap-ok',
    timeoutMs: 60_000,
    env: baseProbeEnv(codexHome),
    threadOptions: {
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      model: process.env.SHELF_CODEX_SDK_PROBE_MODEL,
    },
    redactValues,
  });
  child.kill();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });
  }
  return {
    appServerExitedBeforeSdk,
    sdkOkWhileAppServerAlive: sdkProbe.ok,
    sdkOutcome: sdkProbe.outcome,
    appServerStderr: redactText(Buffer.concat(stderrChunks).toString('utf8').slice(0, 2_000), redactValues),
  };
}

function writeIntegrationReport(report: IntegrationProbeReport): void {
  const reportDir = path.join(process.cwd(), '.agent', 'features');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'codex-official-sdk-integration-results.json'),
    `${JSON.stringify(
      {
        generatedBy: 'agent-server/providers/codex-sdk/probe-integrations.live.test.ts',
        ...report,
      },
      null,
      2,
    )}\n`,
  );
}

function mcpStdioProbeServerSource(): string {
  const require = createRequire(import.meta.url);
  const mcpServerModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
  const stdioModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'));
  return `
const { McpServer } = require(${mcpServerModule});
const { StdioServerTransport } = require(${stdioModule});
const server = new McpServer({ name: 'shelf-probe-stdio-mcp', version: '1.0.0' });
server.registerTool(
  'shelf_probe_stdio_echo',
  {
    description: 'Return a fixed Shelf Codex SDK stdio MCP probe marker.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: 'shelf-stdio-mcp-probe-result' }] }),
);
server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

function countOccurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

function redactText(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}
