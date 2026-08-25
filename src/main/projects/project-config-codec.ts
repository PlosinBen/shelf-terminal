import type { AgentPrefs, Connection, QuickCommand, TabTemplate } from '@shared/types';
import type { Project } from '@shared/projects';

export const PROJECTS_SCHEMA_VERSION = 1 as const;

export type ProjectConfigCodecStage = 'decode' | 'parse' | 'schema' | 'format';
export type ProjectConfigRevision = 'legacy-v0' | 'v1' | 'unknown';

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
type ProjectShape = 'legacy' | 'current';

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
    if (shape === 'legacy') return null;
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
    if (shape === 'legacy') return {};
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

function normalizeTabTemplate(value: unknown, context: string): TabTemplate {
  if (!isRecord(value)) throw new SchemaIssue(context, 'expected tab template object');
  const name = requireString(value, 'name', context);
  const cmd = value.cmd;
  const color = value.color;
  const kind = value.kind;
  const url = value.url;
  if (cmd !== undefined && typeof cmd !== 'string') throw new SchemaIssue(`${context}.cmd`, 'expected string');
  if (color !== undefined && typeof color !== 'string') throw new SchemaIssue(`${context}.color`, 'expected string');
  if (kind !== undefined && kind !== 'terminal' && kind !== 'web') {
    throw new SchemaIssue(`${context}.kind`, 'expected terminal or web');
  }
  if (url !== undefined && typeof url !== 'string') throw new SchemaIssue(`${context}.url`, 'expected string');
  return {
    name,
    ...(cmd === undefined ? {} : { cmd }),
    ...(color === undefined ? {} : { color }),
    ...(kind === undefined ? {} : { kind }),
    ...(url === undefined ? {} : { url }),
  };
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
    if (shape === 'legacy') return [];
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
    if (shape === 'legacy') return {};
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
  const openAgentOnConnect = value.openAgentOnConnect;
  if (!hasOwn(value, 'openAgentOnConnect')) {
    if (shape === 'current') throw new SchemaIssue(`${context}.openAgentOnConnect`, 'missing current field');
  } else if (typeof openAgentOnConnect !== 'boolean') {
    throw new SchemaIssue(`${context}.openAgentOnConnect`, 'expected boolean');
  }

  return {
    id: requireString(value, 'id', context),
    name: requireString(value, 'name', context),
    cwd: requireString(value, 'cwd', context),
    connection: normalizeConnection(value.connection, `${context}.connection`),
    maxTabs: maxTabs as number,
    initScript: nullableString(value, 'initScript', context, shape),
    envPlain: optionalStringRecord(value, 'envPlain', context, shape),
    defaultTabs: objectArray(value, 'defaultTabs', context, shape, normalizeTabTemplate),
    quickCommands: objectArray(value, 'quickCommands', context, shape, normalizeQuickCommand),
    featureNoteDir: nullableString(value, 'featureNoteDir', context, shape),
    parentProjectId: nullableString(value, 'parentProjectId', context, shape),
    worktreeBranch: nullableString(value, 'worktreeBranch', context, shape),
    baseBranch: nullableString(value, 'baseBranch', context, shape),
    defaultAgentProvider: nullableString(value, 'defaultAgentProvider', context, shape),
    openAgentOnConnect: openAgentOnConnect === true,
    agentSessionIds: optionalStringRecord(value, 'agentSessionIds', context, shape),
    agentPrefs: agentPrefsRecord(value, context, shape),
  };
}

function normalizeProjects(
  values: readonly unknown[],
  revision: Exclude<ProjectConfigRevision, 'unknown'>,
): ProjectConfigLoadResult<readonly Project[]> {
  try {
    const shape = revision === 'v1' ? 'current' : 'legacy';
    const projects = values.map((value, index) => normalizeProject(value, index, shape));
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
  if (!isRecord(value) || value.schemaVersion !== PROJECTS_SCHEMA_VERSION) {
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
  if (!Array.isArray(value.projects)) {
    return {
      ok: false,
      error: {
        stage: 'schema',
        revision: 'v1',
        context: 'projects',
        message: 'expected array',
      },
    };
  }
  return normalizeProjects(value.projects, 'v1');
}

export function formatProjectsDocument(projects: readonly Project[]): ProjectConfigFormatResult {
  const validated = normalizeProjects(projects, 'v1');
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
        revision: 'v1',
        context: 'document',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
