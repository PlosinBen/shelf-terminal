import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type ProjectConfigFileIoOperation = 'read' | 'prepare-directory' | 'backup' | 'write-temp' | 'replace';
export type ProjectConfigFileIoErrorKind = 'permission' | 'io';

export interface ProjectConfigFileIoError {
  readonly operation: ProjectConfigFileIoOperation;
  readonly kind: ProjectConfigFileIoErrorKind;
  readonly path: string;
  readonly message: string;
}

export type ProjectConfigFileReadResult =
  | { readonly ok: true; readonly state: 'missing' }
  | { readonly ok: true; readonly state: 'present'; readonly data: Uint8Array }
  | { readonly ok: false; readonly error: ProjectConfigFileIoError };

export type ProjectConfigFileWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProjectConfigFileIoError };

export interface ProjectConfigFileIo {
  read(filePath: string): ProjectConfigFileReadResult;
  backup(sourcePath: string, backupPath: string): Promise<ProjectConfigFileWriteResult>;
  writeAtomic(filePath: string, data: string | Uint8Array): Promise<ProjectConfigFileWriteResult>;
}

export interface ProjectConfigFileOperations {
  readFile(filePath: string): Uint8Array;
  mkdir(directory: string): Promise<void>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

interface ProjectConfigFileIoOptions {
  readonly operations?: ProjectConfigFileOperations;
  readonly createTempToken?: () => string;
}

const DEFAULT_OPERATIONS: ProjectConfigFileOperations = {
  readFile: (filePath) => fsSync.readFileSync(filePath),
  mkdir: async (directory) => {
    await fs.mkdir(directory, { recursive: true });
  },
  copyFile: (sourcePath, targetPath) => fs.copyFile(sourcePath, targetPath),
  writeFile: (filePath, data) => fs.writeFile(filePath, data),
  rename: (sourcePath, targetPath) => fs.rename(sourcePath, targetPath),
  unlink: (filePath) => fs.unlink(filePath),
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ioError(
  operation: ProjectConfigFileIoOperation,
  filePath: string,
  error: unknown,
): ProjectConfigFileIoError {
  const code = errorCode(error);
  return {
    operation,
    kind: code === 'EACCES' || code === 'EPERM' ? 'permission' : 'io',
    path: filePath,
    message: errorMessage(error),
  };
}

export function createProjectConfigFileIo(
  options: ProjectConfigFileIoOptions = {},
): ProjectConfigFileIo {
  const operations = options.operations ?? DEFAULT_OPERATIONS;
  const createTempToken = options.createTempToken ?? randomUUID;

  return {
    read(filePath) {
      try {
        return { ok: true, state: 'present', data: operations.readFile(filePath) };
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { ok: true, state: 'missing' };
        return { ok: false, error: ioError('read', filePath, error) };
      }
    },

    async backup(sourcePath, backupPath) {
      try {
        await operations.copyFile(sourcePath, backupPath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: ioError('backup', sourcePath, error) };
      }
    },

    async writeAtomic(filePath, data) {
      const directory = path.dirname(filePath);
      const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.${createTempToken()}.tmp`,
      );
      try {
        await operations.mkdir(directory);
      } catch (error) {
        return { ok: false, error: ioError('prepare-directory', filePath, error) };
      }
      try {
        await operations.writeFile(tempPath, data);
      } catch (error) {
        let writeError = ioError('write-temp', filePath, error);
        try {
          await operations.unlink(tempPath);
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== 'ENOENT') {
            writeError = {
              ...writeError,
              message: `${writeError.message}; temp cleanup failed: ${errorMessage(cleanupError)}`,
            };
          }
        }
        return { ok: false, error: writeError };
      }
      try {
        await operations.rename(tempPath, filePath);
        return { ok: true };
      } catch (error) {
        let replaceError = ioError('replace', filePath, error);
        try {
          await operations.unlink(tempPath);
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== 'ENOENT') {
            replaceError = {
              ...replaceError,
              message: `${replaceError.message}; temp cleanup failed: ${errorMessage(cleanupError)}`,
            };
          }
        }
        return { ok: false, error: replaceError };
      }
    },
  };
}
