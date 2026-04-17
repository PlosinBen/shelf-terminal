import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectConfig } from '@shared/types';

let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}));

// Import after mock so getConfigPath() picks up the mocked app
const { loadProjects, saveProjects } = await import('./project-store');

function makeProject(id: string): ProjectConfig {
  return {
    id,
    name: id,
    cwd: '/tmp',
    connection: { type: 'local' },
    maxTabs: 5,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-project-store-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function readProjectsJson(): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'projects.json'), 'utf-8'));
}

function listBackups(): string[] {
  return fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith('projects.json.backup.'));
}

describe('saveProjects — empty-write backup guard', () => {
  it('backs up existing non-empty file before writing []', () => {
    const existing = [makeProject('a'), makeProject('b'), makeProject('c')];
    saveProjects(existing);

    saveProjects([]);

    expect(readProjectsJson()).toEqual([]);

    const backups = listBackups();
    expect(backups).toHaveLength(1);
    const backupContents = JSON.parse(
      fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8'),
    );
    expect(backupContents).toEqual(existing);
  });

  it('does not back up when file does not exist', () => {
    saveProjects([]);

    expect(readProjectsJson()).toEqual([]);
    expect(listBackups()).toHaveLength(0);
  });

  it('does not back up when existing file is already empty []', () => {
    saveProjects([]);
    saveProjects([]);

    expect(listBackups()).toHaveLength(0);
  });

  it('does not back up when writing a non-empty list', () => {
    saveProjects([makeProject('a'), makeProject('b')]);
    saveProjects([makeProject('a')]);

    expect(readProjectsJson()).toEqual([makeProject('a')]);
    expect(listBackups()).toHaveLength(0);
  });

  it('does not back up when existing file is corrupt / unparseable', () => {
    fs.writeFileSync(path.join(tmpDir, 'projects.json'), 'not json', 'utf-8');

    saveProjects([]);

    expect(readProjectsJson()).toEqual([]);
    expect(listBackups()).toHaveLength(0);
  });
});

describe('saveProjects / loadProjects round trip', () => {
  it('loads what was saved', () => {
    const projects = [makeProject('a'), makeProject('b')];
    saveProjects(projects);

    const result = loadProjects();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(projects);
  });
});
