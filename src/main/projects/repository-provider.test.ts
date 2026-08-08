import { beforeEach, describe, expect, it } from 'vitest';
import type { MainProjectsRepository } from './projects-repository';
import {
  getProjectsRepository,
  resetProjectsRepositoryForTests,
  setProjectsRepository,
} from './repository-provider';

describe('projects repository provider', () => {
  beforeEach(() => resetProjectsRepositoryForTests());

  it('fails loud before bootstrap initialization', () => {
    expect(() => getProjectsRepository()).toThrow('projects repository is not initialized');
  });

  it('returns the ready repository installed by bootstrap', () => {
    const repository = {} as MainProjectsRepository;
    setProjectsRepository(repository);
    expect(getProjectsRepository()).toBe(repository);
  });
});
