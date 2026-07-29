import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@shared/types';
import { createProjectsRepository } from './projects-repository';

function config(id: string): ProjectConfig {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
  };
}

describe('projects repository ordering', () => {
  it('keeps stable view order unchanged when visual project order changes', () => {
    const save = vi.fn();
    const repo = createProjectsRepository({ saveProjects: save });

    repo.setProjects([config('A'), config('B'), config('C')]);
    repo.addTab('A');
    repo.addTab('B');
    repo.addTab('C');
    repo.setActiveProject('A');

    expect(repo.listVisual().map((p) => p.config.id)).toEqual(['A', 'B', 'C']);
    expect(repo.listStableViews().map((p) => p.config.id)).toEqual(['A', 'B', 'C']);

    repo.reorder('A', 'C');

    expect(repo.listVisual().map((p) => p.config.id)).toEqual(['B', 'C', 'A']);
    expect(repo.listStableViews().map((p) => p.config.id)).toEqual(['A', 'B', 'C']);
    expect(repo.getActiveProjectId()).toBe('A');
    expect(save).toHaveBeenLastCalledWith([config('B'), config('C'), config('A')]);
  });
});
