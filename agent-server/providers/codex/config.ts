import type { McpServerBlock, McpServersFile } from '@shared/mcp';

interface CodexConfigObject {
  mcp_servers?: Record<string, CodexMcpServerConfig>;
}

interface BuildConfigInput {
  cwd: string;
  mcpServers?: McpServersFile;
  shelfMcp?: { url: string };
  baseEnv?: Record<string, string | undefined>;
}

type CodexMcpServerConfig =
  | {
      command: string;
      args?: string[];
      env_vars?: string[];
    }
  | {
      url: string;
      required?: boolean;
      bearer_token_env_var?: string;
      env_http_headers?: Record<string, string>;
    };

export interface CodexSdkRuntimeConfigResult {
  ok: boolean;
  errors: string[];
  codexOptions: { config: CodexConfigObject; env: Record<string, string> };
}

export function buildCodexRuntimeConfig(input: BuildConfigInput): CodexSdkRuntimeConfigResult {
  const errors: string[] = [];
  const env = compactEnv(input.baseEnv ?? {});
  const mcpServers: Record<string, CodexMcpServerConfig> = {};
  if (input.shelfMcp) {
    mcpServers.shelf = {
      url: input.shelfMcp.url,
      required: true,
    };
  }

  const stdioEnvOwners = new Map<string, { value: string; serverName: string }>();
  for (const [serverName, server] of Object.entries(input.mcpServers ?? {})) {
    if (!isSafeMcpServerName(serverName)) {
      errors.push(`Invalid MCP server name for Codex SDK config: ${serverName}`);
      continue;
    }
    const mapped = mapMcpServer(serverName, server, env, stdioEnvOwners, errors);
    if (mapped) mcpServers[serverName] = mapped;
  }

  const config: CodexConfigObject = {};
  if (Object.keys(mcpServers).length > 0) {
    config.mcp_servers = mcpServers;
  }

  return {
    ok: errors.length === 0,
    errors,
    codexOptions: { config, env },
  };
}

function mapMcpServer(
  serverName: string,
  server: McpServerBlock,
  env: Record<string, string>,
  stdioEnvOwners: Map<string, { value: string; serverName: string }>,
  errors: string[],
): CodexMcpServerConfig | null {
  if (server.type === 'stdio') {
    const envVars: string[] = [];
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (!isSafeEnvName(name)) {
        errors.push(`Invalid MCP env var name for server "${serverName}": ${name}`);
        continue;
      }
      const prior = stdioEnvOwners.get(name);
      if (prior && prior.value !== value) {
        errors.push(
          `MCP env var "${name}" has conflicting values for servers "${prior.serverName}" and "${serverName}"; Codex SDK stdio MCP env_vars are process-wide.`,
        );
        continue;
      }
      stdioEnvOwners.set(name, { value, serverName });
      env[name] = value;
      envVars.push(name);
    }
    return {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(envVars.length ? { env_vars: envVars } : {}),
    };
  }

  if (server.type === 'http') {
    const headers: Record<string, string> = {};
    let bearerTokenEnvVar: string | undefined;
    for (const [headerName, headerValue] of Object.entries(server.headers ?? {})) {
      const envName = generatedHttpHeaderEnvName(serverName, headerName);
      if (!isSafeEnvName(envName)) {
        errors.push(`Invalid generated MCP HTTP header env var name for server "${serverName}" header "${headerName}": ${envName}`);
        continue;
      }
      const bearer = /^Bearer\s+(.+)$/i.exec(headerValue);
      if (headerName.toLowerCase() === 'authorization' && bearer) {
        bearerTokenEnvVar = envName;
        env[envName] = bearer[1];
      } else {
        headers[headerName] = envName;
        env[envName] = headerValue;
      }
    }
    return {
      url: server.url,
      ...(bearerTokenEnvVar ? { bearer_token_env_var: bearerTokenEnvVar } : {}),
      ...(Object.keys(headers).length ? { env_http_headers: headers } : {}),
    };
  }

  errors.push(`Unsupported MCP server type for "${serverName}": ${(server as { type?: unknown }).type}`);
  return null;
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isSafeMcpServerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isSafeEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function generatedHttpHeaderEnvName(serverName: string, headerName: string): string {
  return `SHELF_CODEX_MCP_${sanitizeEnvPart(serverName)}_${sanitizeEnvPart(headerName)}`;
}

function sanitizeEnvPart(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
}
