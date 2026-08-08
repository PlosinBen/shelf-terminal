import type { Project } from '@shared/projects';
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
}

export type ProjectConfigPersistenceLoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectConfigPersistenceError };

export type ProjectConfigPersistenceSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProjectConfigPersistenceError };

export interface ProjectConfigPersistence {
  load(): Promise<ProjectConfigPersistenceLoadResult<readonly Project[]>>;
  save(projects: readonly Project[]): Promise<ProjectConfigPersistenceSaveResult>;
}

export function createProjectConfigPersistence(
  filePath: string,
  fileIo: ProjectConfigFileIo,
): ProjectConfigPersistence {
  return {
    async load() {
      const read = await fileIo.read(filePath);
      if (!read.ok) {
        return {
          ok: false,
          error: {
            stage: read.error.operation,
            path: read.error.path,
            message: read.error.message,
          },
        };
      }
      if (read.state === 'missing') return { ok: true, value: [] };

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

      const written = await fileIo.writeAtomic(filePath, formatted.data);
      if (!written.ok) {
        return {
          ok: false,
          error: {
            stage: written.error.operation,
            path: written.error.path,
            message: written.error.message,
          },
        };
      }
      return { ok: true };
    },
  };
}
