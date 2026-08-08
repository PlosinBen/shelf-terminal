import type { MainProjectsRepository } from './projects-repository';

let repository: MainProjectsRepository | null = null;

export function setProjectsRepository(nextRepository: MainProjectsRepository): void {
  repository = nextRepository;
}

export function getProjectsRepository(): MainProjectsRepository {
  if (!repository) throw new Error('projects repository is not initialized');
  return repository;
}

export function resetProjectsRepositoryForTests(): void {
  repository = null;
}
