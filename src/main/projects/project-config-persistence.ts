import type { Project } from '@shared/projects';
import { log } from '@shared/logger';
import {
  formatProjectsDocument,
  loadProjectsDocument,
  type ProjectConfigCodecStage,
  type ProjectConfigRevision,
} from './project-config-codec';
import type {
  ProjectConfigFileIo,
  ProjectConfigFileIoOperation,
} from './project-config-file-io';

export type ProjectConfigPersistenceStage = ProjectConfigCodecStage | ProjectConfigFileIoOperation;

export interface ProjectConfigPersistenceError {
  readonly stage: ProjectConfigPersistenceStage;
  readonly path: string;
  readonly message: string;
  readonly context?: string;
  readonly revision?: ProjectConfigRevision;
  readonly kind?: 'permission' | 'io';
}

export type ProjectConfigPersistenceLoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectConfigPersistenceError };

export type ProjectConfigPersistenceSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProjectConfigPersistenceError };

export interface ProjectConfigPersistence {
  load(): ProjectConfigPersistenceLoadResult<readonly Project[]>;
  save(projects: readonly Project[]): Promise<ProjectConfigPersistenceSaveResult>;
}

interface ProjectConfigPersistenceOptions {
  readonly now?: () => Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function backupTimestamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function createProjectConfigPersistence(
  filePath: string,
  fileIo: ProjectConfigFileIo,
  options: ProjectConfigPersistenceOptions = {},
): ProjectConfigPersistence {
  const now = options.now ?? (() => new Date());
  let persistedProjectCount: number | null = null;

  return {
    load() {
      const read = fileIo.read(filePath);
      if (!read.ok) {
        return {
          ok: false,
          error: {
            stage: read.error.operation,
            path: read.error.path,
            message: read.error.message,
            kind: read.error.kind,
          },
        };
      }
      if (read.state === 'missing') {
        persistedProjectCount = 0;
        return { ok: true, value: [] };
      }

      const loaded = loadProjectsDocument(read.data);
      if (!loaded.ok) {
        return {
          ok: false,
          error: {
            stage: loaded.error.stage,
            path: filePath,
            message: loaded.error.message,
            context: loaded.error.context,
            revision: loaded.error.revision,
          },
        };
      }
      persistedProjectCount = loaded.value.length;
      return loaded;
    },

    async save(projects) {
      const formatted = formatProjectsDocument(projects);
      if (!formatted.ok) {
        return {
          ok: false,
          error: {
            stage: formatted.error.stage,
            path: filePath,
            message: formatted.error.message,
            context: formatted.error.context,
            revision: formatted.error.revision,
          },
        };
      }

      if (projects.length === 0 && persistedProjectCount !== null && persistedProjectCount > 0) {
        const backupPath = `${filePath}.backup.${backupTimestamp(now())}`;
        const backedUp = await fileIo.backup(filePath, backupPath);
        if (!backedUp.ok) {
          log.error(
            'projects-persistence',
            `failed to back up non-empty config before empty write: source=${filePath} backup=${backupPath} ${backedUp.error.message}`,
          );
        }
      }

      const written = await fileIo.writeAtomic(filePath, formatted.data);
      if (!written.ok) {
        return {
          ok: false,
          error: {
            stage: written.error.operation,
            path: written.error.path,
            message: written.error.message,
            kind: written.error.kind,
          },
        };
      }
      persistedProjectCount = projects.length;
      return { ok: true };
    },
  };
}
