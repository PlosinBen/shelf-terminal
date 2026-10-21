import type { AgentPrefs, Connection, QuickCommand, TabTemplate } from '@shared/types';
import type { Project } from '@shared/projects';
import { isAgentProvider, providerLabel } from '@shared/agent-providers';

export const PROJECTS_SCHEMA_VERSION = 2 as const;

export type ProjectConfigCodecStage = 'decode' | 'parse' | 'schema' | 'format';
export type ProjectConfigRevision = 'legacy-v0' | 'v1' | 'v2' | 'unknown';

export interface ProjectConfigCodecError {
  readonly stage: ProjectConfigCodecStage;
  readonly revision: ProjectConfigRevision;
  readonly context: string;
  readonly message: string;
}

export type ProjectConfigLoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectConfigCodecError };

export type ProjectConfigFormatResult =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly error: ProjectConfigCodecError };

type UnknownRecord = Record<string, unknown>;
type ProjectShape = 'legacy-v0' | 'v1' | 'v2';

class SchemaIssue extends Error {
  constructor(readonly context: string, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new SchemaIssue(`${context}.${key}`, 'expected string');
  return value;
}

function nullableString(
  record: UnknownRecord,
  key: string,
  context: string,
  shape: ProjectShape,
): string | null {
  if (!hasOwn(record, key)) {
    if (shape === 'legacy-v0') return null;
    throw new SchemaIssue(`${context}.${key}`, 'missing current field');
  }
  const value = record[key];
  if (value === null || typeof value === 'string') return value;
  throw new SchemaIssue(`${context}.${key}`, 'expected string or null');
}

function stringRecord(value: unknown, context: string): Record<string, string> {
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected object');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new SchemaIssue(`${context}.${key}`, 'expected string');
    result[key] = entry;
  }
  return result;
}

function optionalStringRecord(
  record: UnknownRecord,
  key: string,
  context: string,
  shape: ProjectShape,
): Record<string, string> {
  if (!hasOwn(record, key)) {
    if (shape === 'legacy-v0') return {};
    throw new SchemaIssue(`${context}.${key}`, 'missing current field');
  }
  return stringRecord(record[key], `${context}.${key}`);
}

function normalizeConnection(value: unknown, context: string): Connection {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SchemaIssue(context, 'expected connection object');
  }
  switch (value.type) {
    case 'local':
      return { type: 'local' };
    case 'ssh': {
      const host = requireString(value, 'host', context);
      const user = requireString(value, 'user', context);
      const port = value.port;
      if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
        throw new SchemaIssue(`${context}.port`, 'expected valid TCP port');
      }
      const password = value.password;
      if (password !== undefined && typeof password !== 'string') {
        throw new SchemaIssue(`${context}.password`, 'expected string');
      }
      const idleShutdownMinutes = value.idleShutdownMinutes;
      if (idleShutdownMinutes !== undefined
        && (!Number.isInteger(idleShutdownMinutes) || (idleShutdownMinutes as number) < 0)) {
        throw new SchemaIssue(`${context}.idleShutdownMinutes`, 'expected non-negative integer');
      }
      return {
        type: 'ssh',
        host,
        port: port as number,
        user,
        ...(password === undefined ? {} : { password }),
        ...(idleShutdownMinutes === undefined ? {} : { idleShutdownMinutes: idleShutdownMinutes as number }),
      };
    }
    case 'wsl':
      return { type: 'wsl', distro: requireString(value, 'distro', context) };
    case 'docker':
      return { type: 'docker', container: requireString(value, 'container', context) };
    default:
      throw new SchemaIssue(`${context}.type`, `unsupported connection type ${value.type}`);
  }
}

function normalizeTabTemplate(value: unknown, context: string, allowAgent: boolean): TabTemplate {
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected tab template object');
  const name = requireString(value, 'name', context);
  const cmd = value.cmd;
  const color = value.color;
  const kind = value.kind;
  const url = value.url;
  const provider = value.provider;
  if (cmd !== undefined && typeof cmd !== 'string') throw new SchemaIssue(`${context}.cmd`, 'expected string');
  if (color !== undefined && typeof color !== 'string') throw new SchemaIssue(`${context}.color`, 'expected string');
  if (kind !== undefined && kind !== 'terminal' && kind !== 'web' && !(allowAgent && kind === 'agent')) {
    throw new SchemaIssue(`${context}.kind`, allowAgent ? 'expected terminal, web, or agent' : 'expected terminal or web');
  }
  if (url !== undefined && typeof url !== 'string') throw new SchemaIssue(`${context}.url`, 'expected string');
  if (provider !== undefined && typeof provider !== 'string') {
    throw new SchemaIssue(`${context}.provider`, 'expected string');
  }
  const base = { name, ...(color === undefined ? {} : { color }) };
  if (kind === 'agent') {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new SchemaIssue(`${context}.provider`, 'expected non-empty string');
    }
    if (cmd !== undefined || url !== undefined) {
      throw new SchemaIssue(context, 'agent template must not contain cmd or url');
    }
    return { ...base, kind: 'agent', provider };
  }
  if (kind === 'web') {
    if (cmd !== undefined || provider !== undefined) {
      throw new SchemaIssue(context, 'web template must not contain cmd or provider');
    }
    return { ...base, kind: 'web', ...(url === undefined ? {} : { url }) };
  }
  if (url !== undefined || provider !== undefined) {
    throw new SchemaIssue(context, 'terminal template must not contain url or provider');
  }
  return { ...base, ...(cmd === undefined ? {} : { cmd }) };
}

function normalizeQuickCommand(value: unknown, context: string): QuickCommand {
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected quick command object');
  return {
    label: requireString(value, 'label', context),
    command: requireString(value, 'command', context),
    target: requireString(value, 'target', context),
  };
}

function objectArray<T>(
  record: UnknownRecord,
  key: string,
  context: string,
  shape: ProjectShape,
  normalize: (value: unknown, context: string) => T,
): T[] {
  if (!hasOwn(record, key)) {
    if (shape === 'legacy-v0') return [];
    throw new SchemaIssue(`${context}.${key}`, 'missing current field');
  }
  const value = record[key];
  if (!Array.isArray(value)) throw new SchemaIssue(`${context}.${key}`, 'expected array');
  return value.map((entry, index) => normalize(entry, `${context}.${key}[${index}]`));
}

function normalizeAgentPrefs(value: unknown, context: string): AgentPrefs {
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected agent preferences object');
  const result: AgentPrefs = {};
  for (const key of ['model', 'effort', 'permissionMode', 'nativeMode', 'nativePermission'] as const) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== 'string') {
      throw new SchemaIssue(`${context}.${key}`, 'expected string');
    }
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function agentPrefsRecord(
  record: UnknownRecord,
  context: string,
  shape: ProjectShape,
): Record<string, AgentPrefs> {
  if (!hasOwn(record, 'agentPrefs')) {
    if (shape === 'legacy-v0') return {};
    throw new SchemaIssue(`${context}.agentPrefs`, 'missing current field');
  }
  const value = record.agentPrefs;
  if (!isRecord(value)) throw new SchemaIssue(`${context}.agentPrefs`, 'expected object');
  const result: Record<string, AgentPrefs> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = normalizeAgentPrefs(entry, `${context}.agentPrefs.${key}`);
  }
  return result;
}

function normalizeProject(value: unknown, index: number, shape: ProjectShape): Project {
  const context = `projects[${index}]`;
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected project object');

  const maxTabs = value.maxTabs;
  if (!Number.isInteger(maxTabs) || (maxTabs as number) <= 0) {
    throw new SchemaIssue(`${context}.maxTabs`, 'expected positive integer');
  }
  if (shape === 'v2' && (hasOwn(value, 'defaultAgentProvider') || hasOwn(value, 'openAgentOnConnect'))) {
    throw new SchemaIssue(context, 'current project must not contain legacy agent startup fields');
  }
  const openAgentOnConnect = value.openAgentOnConnect;
  if (shape !== 'v2') {
    if (!hasOwn(value, 'openAgentOnConnect')) {
      if (shape === 'v1') throw new SchemaIssue(`${context}.openAgentOnConnect`, 'missing v1 field');
    } else if (typeof openAgentOnConnect !== 'boolean') {
      throw new SchemaIssue(`${context}.openAgentOnConnect`, 'expected boolean');
    }
  }

  let legacyProvider: string | null = null;
  if (shape !== 'v2') {
    legacyProvider = nullableString(value, 'defaultAgentProvider', context, shape);
  }
  const parsedTabs = objectArray(
    value,
    'defaultTabs',
    context,
    shape,
    (entry, entryContext) => normalizeTabTemplate(entry, entryContext, shape === 'v2'),
  );
  if (shape === 'v2' && parsedTabs.length === 0) {
    throw new SchemaIssue(`${context}.defaultTabs`, 'expected at least one tab template');
  }
  const baseTabs: TabTemplate[] = parsedTabs.length > 0 ? parsedTabs : [{ name: 'Terminal' }];
  const defaultTabs: TabTemplate[] = legacyProvider === null
    ? baseTabs
    : [{
      name: isAgentProvider(legacyProvider) ? providerLabel(legacyProvider) : legacyProvider,
      kind: 'agent',
      provider: legacyProvider,
    }, ...baseTabs];
  const providers = new Set<string>();
  for (let tabIndex = 0; tabIndex < defaultTabs.length; tabIndex++) {
    const tab = defaultTabs[tabIndex];
    if (tab.kind !== 'agent') continue;
    if (providers.has(tab.provider)) {
      throw new SchemaIssue(`${context}.defaultTabs[${tabIndex}].provider`, `duplicate agent provider ${tab.provider}`);
    }
    providers.add(tab.provider);
  }

  return {
    id: requireString(value, 'id', context),
    name: requireString(value, 'name', context),
    cwd: requireString(value, 'cwd', context),
    connection: normalizeConnection(value.connection, `${context}.connection`),
    maxTabs: maxTabs as number,
    initScript: nullableString(value, 'initScript', context, shape),
    envPlain: optionalStringRecord(value, 'envPlain', context, shape),
    defaultTabs,
    quickCommands: objectArray(value, 'quickCommands', context, shape, normalizeQuickCommand),
    featureNoteDir: nullableString(value, 'featureNoteDir', context, shape),
    parentProjectId: nullableString(value, 'parentProjectId', context, shape),
    worktreeBranch: nullableString(value, 'worktreeBranch', context, shape),
    baseBranch: nullableString(value, 'baseBranch', context, shape),
    agentSessionIds: optionalStringRecord(value, 'agentSessionIds', context, shape),
    agentPrefs: agentPrefsRecord(value, context, shape),
  };
}

function normalizeProjects(
  values: readonly unknown[],
  revision: Exclude<ProjectConfigRevision, 'unknown'>,
): ProjectConfigLoadResult<readonly Project[]> {
  try {
    const projects = values.map((value, index) => normalizeProject(value, index, revision));
    const ids = new Set<string>();
    for (let index = 0; index < projects.length; index++) {
      const id = projects[index].id;
      if (ids.has(id)) throw new SchemaIssue(`projects[${index}].id`, `duplicate project id ${id}`);
      ids.add(id);
    }
    return { ok: true, value: projects };
  } catch (error) {
    const issue = error instanceof SchemaIssue
      ? error
      : new SchemaIssue('projects', error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      error: {
        stage: 'schema',
        revision,
        context: issue.context,
        message: issue.message,
      },
    };
  }
}

function decode(data: string | Uint8Array): ProjectConfigLoadResult<string> {
  if (typeof data === 'string') return { ok: true, value: data };
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(data) };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: 'decode',
        revision: 'unknown',
        context: 'document',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function loadProjectsDocument(
  data: string | Uint8Array,
): ProjectConfigLoadResult<readonly Project[]> {
  const decoded = decode(data);
  if (!decoded.ok) return decoded;

  let value: unknown;
  try {
    value = JSON.parse(decoded.value) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: 'parse',
        revision: 'unknown',
        context: 'document',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (Array.isArray(value)) return normalizeProjects(value, 'legacy-v0');
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== PROJECTS_SCHEMA_VERSION)) {
    return {
      ok: false,
      error: {
        stage: 'schema',
        revision: 'unknown',
        context: isRecord(value) && hasOwn(value, 'schemaVersion') ? 'schemaVersion' : 'document',
        message: isRecord(value) && hasOwn(value, 'schemaVersion')
          ? `unsupported schema version ${String(value.schemaVersion)}`
          : 'expected legacy project array or versioned project document',
      },
    };
  }
  const revision = value.schemaVersion === 1 ? 'v1' : 'v2';
  if (!Array.isArray(value.projects)) {
    return {
      ok: false,
      error: {
        stage: 'schema',
        revision,
        context: 'projects',
        message: 'expected array',
      },
    };
  }
  return normalizeProjects(value.projects, revision);
}

export function formatProjectsDocument(projects: readonly Project[]): ProjectConfigFormatResult {
  const validated = normalizeProjects(projects, 'v2');
  if (!validated.ok) {
    return {
      ok: false,
      error: { ...validated.error, stage: 'format' },
    };
  }
  try {
    return {
      ok: true,
      data: JSON.stringify({
        schemaVersion: PROJECTS_SCHEMA_VERSION,
        projects: validated.value,
      }, null, 2),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: 'format',
        revision: 'v2',
        context: 'document',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
