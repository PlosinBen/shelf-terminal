import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { type CodexSdkProbeRequest, type CodexSdkProbeSummary, runCodexSdkProbe } from './probe-harness';

const runLive = process.env.SHELF_CODEX_SDK_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;

describeLive('Codex official SDK lifecycle probe', () => {
  it('captures bounded event summaries for core turn lifecycle cases', async () => {
    const codexPathOverride = resolveInstalledNativeCodexPath();
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
    const workspace = mkdtempSync(path.join(tmpdir(), 'shelf-codex-sdk-probe-'));
    const imagePath = path.join(workspace, 'one-pixel.png');
    const mcpServerPath = path.join(workspace, 'shelf-probe-mcp.cjs');
    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luzC7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    writeFileSync(mcpServerPath, mcpProbeServerSource());

    const base: Omit<CodexSdkProbeRequest, 'input' | 'timeoutMs'> = {
      codexPathOverride,
      codexHome,
      workingDirectory: workspace,
      env: baseProbeEnv(codexHome),
      redactValues: [codexHome, workspace, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter(
        (value): value is string => !!value,
      ),
      threadOptions: {
        skipGitRepoCheck: true,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        model: process.env.SHELF_CODEX_SDK_PROBE_MODEL,
      },
    };

    const report: Record<string, CodexSdkProbeSummary> = {};
    try {
      report.new_thread = await runCodexSdkProbe({
        ...base,
        input: 'Reply with exactly: shelf-probe-new',
        timeoutMs: 60_000,
      });
      expect(report.new_thread.ok).toBe(true);
      expect(report.new_thread.threadId).toBeTruthy();

      report.second_turn_resume = await runCodexSdkProbe({
        ...base,
        threadId: report.new_thread.threadId,
        input: 'Reply with exactly: shelf-probe-second',
        timeoutMs: 60_000,
      });
      expect(report.second_turn_resume.ok).toBe(true);

      report.command_and_file = await runCodexSdkProbe({
        ...base,
        threadId: report.new_thread.threadId,
        input: 'Create a file named sdk-probe-output.txt containing exactly shelf-file-probe, then reply done.',
        timeoutMs: 90_000,
      });
      expect(report.command_and_file.ok).toBe(true);

      report.image_only = await runCodexSdkProbe({
        ...base,
        input: [{ type: 'local_image', path: imagePath }],
        timeoutMs: 60_000,
      });
      expect(report.image_only.ok).toBe(false);
      expect(report.image_only.outcome).toBe('non_zero');
      expect(report.image_only.error).toMatch(/No prompt provided via stdin/);

      report.todo_prompt = await runCodexSdkProbe({
        ...base,
        threadId: report.new_thread.threadId,
        input: 'Use your todo list for two short steps, complete both steps, then reply exactly shelf-todo-done.',
        timeoutMs: 90_000,
      });
      expect(report.todo_prompt.ok).toBe(true);

      report.mcp_tool = await runCodexSdkProbe({
        ...base,
        config: {
          mcp_servers: {
            shelf_probe: {
              command: process.execPath,
              args: [mcpServerPath],
              cwd: workspace,
              required: true,
              enabled_tools: ['shelf_probe_echo'],
              default_tools_approval_mode: 'approve',
              startup_timeout_sec: 5,
              tool_timeout_sec: 30,
            },
          },
        },
        input: 'Call the shelf_probe_echo MCP tool. Then reply exactly: shelf-mcp-done.',
        timeoutMs: 90_000,
      });
      expect(report.mcp_tool.ok).toBe(true);
      expect(report.mcp_tool.events.some((event) => event.itemType === 'mcp_tool_call')).toBe(true);

      report.abort_timeout = await runCodexSdkProbe({
        ...base,
        input: 'Wait and then count to 1000000 before replying.',
        timeoutMs: 10,
      });
      expect(report.abort_timeout.ok).toBe(false);
      expect(report.abort_timeout.outcome).toBe('timeout');

      report.invalid_resume = await runCodexSdkProbe({
        ...base,
        threadId: 'not-a-real-codex-thread-id',
        input: 'Reply with exactly: should-not-run',
        timeoutMs: 60_000,
      });
      expect(report.invalid_resume.ok).toBe(true);
      expect(report.invalid_resume.threadId).not.toBe('not-a-real-codex-thread-id');

      report.forced_child_failure = await runCodexSdkProbe({
        ...base,
        codexPathOverride: path.join(workspace, 'missing-codex-binary'),
        input: 'Reply with exactly: should-not-run',
        timeoutMs: 10_000,
      });
      expect(report.forced_child_failure.ok).toBe(false);
    } finally {
      writeProbeReport(report);
    }
  }, 360_000);
});

function resolveInstalledNativeCodexPath(): string {
  const require = createRequire(import.meta.url);
  const packageName = nativePackageName();
  const packageJson = require.resolve(`${packageName}/package.json`);
  const binary = path.join(path.dirname(packageJson), 'vendor', nativeTriple(), 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!existsSync(binary)) {
    throw new Error(`Installed Codex native binary not found at ${binary}`);
  }
  return binary;
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

function writeProbeReport(report: Record<string, CodexSdkProbeSummary>): void {
  const reportDir = path.join(process.cwd(), '.agent', 'features');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'codex-official-sdk-probe-results.json'),
    `${JSON.stringify(
      {
        generatedBy: 'agent-server/providers/codex-sdk/probe-lifecycle.live.test.ts',
        sdkVersion: '0.145.0',
        cases: report,
      },
      null,
      2,
    )}\n`,
  );
}

function mcpProbeServerSource(): string {
  const require = createRequire(import.meta.url);
  const mcpServerModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
  const stdioModule = JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'));
  return `
const { McpServer } = require(${mcpServerModule});
const { StdioServerTransport } = require(${stdioModule});

const server = new McpServer({ name: 'shelf-probe-mcp', version: '1.0.0' });
server.registerTool(
  'shelf_probe_echo',
  {
    description: 'Return a fixed Shelf Codex SDK probe marker.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'shelf-mcp-probe-result' }],
  }),
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}
