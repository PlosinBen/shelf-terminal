import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/projects';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  addTab,
  getActiveProjectId,
  listStableProjectViews,
  projectDisplayLabel,
  setActiveProjectById,
  setProjects,
} from './store';

function project(id: string, changes: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
    initScript: null,
    envPlain: {},
    defaultTabs: [],
    quickCommands: [],
    featureNoteDir: null,
    parentProjectId: null,
    worktreeBranch: null,
    baseBranch: null,
    defaultAgentProvider: null,
    openAgentOnConnect: false,
    agentSessionIds: {},
    agentPrefs: {},
    ...changes,
  };
}

describe('store project reconciliation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { shelfApi: { pm: { syncState: vi.fn() } } });
    __resetStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetStoreForTests();
  });

  it('uses the worktree branch as the visible project label', () => {
    expect(projectDisplayLabel(project('Base'))).toBe('Base');
    expect(projectDisplayLabel(project('Child', {
      name: 'Base',
      parentProjectId: 'Base',
      worktreeBranch: 'feature/popup-focus',
    }))).toBe('feature/popup-focus');
  });

  it('adopts repository order while preserving runtime state by project id', () => {
    setProjects([project('A'), project('B'), project('C')]);
    addTab(0);
    addTab(1);
    addTab(2);
    setActiveProjectById('A');

    setProjects([project('B'), project('C'), project('A')]);

    expect(__getSnapshotForTests().projects.map((candidate) => candidate.id)).toEqual(['B', 'C', 'A']);
    expect(__getSnapshotForTests().projects.map((candidate) => candidate.tabs.length)).toEqual([1, 1, 1]);
    expect(listStableProjectViews().map((candidate) => candidate.id)).toEqual(['A', 'B', 'C']);
    expect(getActiveProjectId()).toBe('A');
  });
});
