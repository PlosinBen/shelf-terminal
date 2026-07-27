import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../mcp-config';
import {
  CODEX_SDK_EFFORT_LEVELS,
  buildCodexSdkRuntimeConfig,
  toCodexSdkInput,
} from './config';

describe('Codex SDK pure runtime config mapping', () => {
  it('maps Shelf permission modes to the probed SDK non-interactive modes', () => {
    expect(buildCodexSdkRuntimeConfig({ cwd: '/repo', permissionMode: 'plan' }).threadOptions).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    expect(buildCodexSdkRuntimeConfig({ cwd: '/repo', permissionMode: 'default' }).threadOptions).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(buildCodexSdkRuntimeConfig({ cwd: '/repo', permissionMode: 'bypassPermissions' }).threadOptions).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });

  it('passes supported model and effort through ThreadOptions', () => {
    const mapped = buildCodexSdkRuntimeConfig({ cwd: '/repo', model: 'gpt-5-codex', effort: 'xhigh' });
    expect(mapped.ok).toBe(true);
    expect(mapped.threadOptions).toMatchObject({
      workingDirectory: '/repo',
      skipGitRepoCheck: true,
      model: 'gpt-5-codex',
      modelReasoningEffort: 'xhigh',
    });
    expect(CODEX_SDK_EFFORT_LEVELS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('rejects unsupported effort and permission values without rewriting them', () => {
    expect(buildCodexSdkRuntimeConfig({ cwd: '/repo', effort: 'ultra' })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Unsupported Codex SDK effort/)]) as unknown[],
    });
    expect(buildCodexSdkRuntimeConfig({ cwd: '/repo', permissionMode: 'yolo' })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/Unsupported Codex SDK permission mode/)]) as unknown[],
    });
  });

  it('maps required Shelf L1 MCP to config without secrets', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      shelfMcp: { url: 'http://127.0.0.1:1234/mcp' },
      baseEnv: { PATH: '/bin' },
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.codexOptions.config).toEqual({
      mcp_servers: {
        shelf: {
          url: 'http://127.0.0.1:1234/mcp',
          required: true,
        },
      },
    });
    expect(mapped.codexOptions.env).toEqual({ PATH: '/bin' });
  });

  it('maps stdio MCP env values via env_vars and child env, not serialized config', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      mcpServers: {
        gh: { type: 'stdio', command: 'node', args: ['server.js'], env: { GITHUB_TOKEN: 'secret-token' } },
      },
      baseEnv: { PATH: '/bin' },
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.codexOptions.config).toEqual({
      mcp_servers: {
        gh: {
          command: 'node',
          args: ['server.js'],
          env_vars: ['GITHUB_TOKEN'],
        },
      },
    });
    expect(mapped.codexOptions.env).toMatchObject({ PATH: '/bin', GITHUB_TOKEN: 'secret-token' });
    expect(JSON.stringify(mapped.codexOptions.config)).not.toContain('secret-token');
  });

  it('maps HTTP MCP headers through generated env vars and bearer_token_env_var', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      mcpServers: {
        api: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: {
            Authorization: 'Bearer secret-bearer',
            'X-Api-Key': 'secret-header',
          },
        },
      },
      baseEnv: {},
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.codexOptions.config).toEqual({
      mcp_servers: {
        api: {
          url: 'https://mcp.example.test',
          bearer_token_env_var: 'SHELF_CODEX_MCP_API_AUTHORIZATION',
          env_http_headers: {
            'X-Api-Key': 'SHELF_CODEX_MCP_API_X_API_KEY',
          },
        },
      },
    });
    expect(mapped.codexOptions.env).toMatchObject({
      SHELF_CODEX_MCP_API_AUTHORIZATION: 'secret-bearer',
      SHELF_CODEX_MCP_API_X_API_KEY: 'secret-header',
    });
    expect(JSON.stringify(mapped.codexOptions.config)).not.toContain('secret-');
  });

  it('rejects duplicate stdio env names with different values', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      mcpServers: {
        a: { type: 'stdio', command: 'a', env: { TOKEN: 'one' } },
        b: { type: 'stdio', command: 'b', env: { TOKEN: 'two' } },
      },
      baseEnv: {},
    });
    expect(mapped.ok).toBe(false);
    expect(mapped.errors.join('\n')).toMatch(/TOKEN.*a.*b/);
  });

  it('allows duplicate stdio env names when the value is identical', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      mcpServers: {
        a: { type: 'stdio', command: 'a', env: { TOKEN: 'same' } },
        b: { type: 'stdio', command: 'b', env: { TOKEN: 'same' } },
      },
      baseEnv: {},
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.codexOptions.env.TOKEN).toBe('same');
  });

  it('rejects malicious env var names before they enter SDK config', () => {
    const mapped = buildCodexSdkRuntimeConfig({
      cwd: '/repo',
      mcpServers: {
        bad: { type: 'stdio', command: 'node', env: { 'BAD-NAME': 'secret' } },
      },
    });
    expect(mapped.ok).toBe(false);
    expect(mapped.errors.join('\n')).toMatch(/Invalid MCP env var name/);
    expect(JSON.stringify(mapped.codexOptions.config)).not.toContain('secret');
  });

  it('keeps missing ${VAR} failures in the parser before SDK mapping', () => {
    const parsed = parseMcpConfig(
      JSON.stringify({ gh: { type: 'stdio', command: 'node', env: { GITHUB_TOKEN: '${MISSING}' } } }),
      {},
    );
    expect(parsed.servers).toEqual({});
    expect(parsed.errors.join('\n')).toMatch(/MISSING/);
  });
});

describe('Codex SDK input mapping', () => {
  it('passes text-only prompts as a string', () => {
    expect(toCodexSdkInput('hello', [])).toEqual({ ok: true, input: 'hello' });
  });

  it('passes text plus images as structured SDK input', () => {
    expect(toCodexSdkInput('describe', ['/tmp/a.png', '/tmp/b.jpg'])).toEqual({
      ok: true,
      input: [
        { type: 'text', text: 'describe' },
        { type: 'local_image', path: '/tmp/a.png' },
        { type: 'local_image', path: '/tmp/b.jpg' },
      ],
    });
  });

  it('rejects image-only input before the SDK is called', () => {
    expect(toCodexSdkInput('   ', ['/tmp/a.png'])).toEqual({
      ok: false,
      error: expect.stringMatching(/requires a text prompt/) as unknown as string,
    });
  });
});
