import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@shared/types';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  addTab,
  getActiveProjectId,
  listStableProjectViews,
  projectDisplayLabel,
  reorderProjects,
  setActiveProjectById,
  setProjects,
} from './store';

function config(id: string): ProjectConfig {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
  };
}

describe('store project ordering', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      shelfApi: {
        project: { save: vi.fn() },
      },
    });
    __resetStoreForTests();
  });

  it('uses the worktree branch as the visible project label', () => {
    const base = { config: config('Base') };
    const child = {
      config: {
        ...config('Child'),
        name: 'Base',
        parentProjectId: 'Base',
        worktreeBranch: 'feature/popup-focus',
      },
    };

    expect(projectDisplayLabel(base)).toBe('Base');
    expect(projectDisplayLabel(child)).toBe('feature/popup-focus');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetStoreForTests();
  });

  it('keeps stable project view order unchanged when visual project order changes', () => {
    setProjects([config('A'), config('B'), config('C')]);
    addTab(0);
    addTab(1);
    addTab(2);
    setActiveProjectById('A');

    expect(__getSnapshotForTests().projects.map((p) => p.config.id)).toEqual(['A', 'B', 'C']);
    expect(listStableProjectViews().map((p) => p.config.id)).toEqual(['A', 'B', 'C']);

    reorderProjects(0, 2);

    expect(__getSnapshotForTests().projects.map((p) => p.config.id)).toEqual(['B', 'C', 'A']);
    expect(listStableProjectViews().map((p) => p.config.id)).toEqual(['A', 'B', 'C']);
    expect(getActiveProjectId()).toBe('A');
    expect(window.shelfApi.project.save).toHaveBeenLastCalledWith([config('B'), config('C'), config('A')]);
  });
});
