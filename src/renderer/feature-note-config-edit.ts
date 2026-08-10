import { normalizeFeatureNoteDir } from '@shared/feature-note-dir';
import type { Project } from '@shared/projects';

/** Fields derived from the canonical `Project` interface in `@shared/projects`. */
type FeatureNoteProjectFields = Pick<Project, 'parentProjectId' | 'featureNoteDir'>;

/** Project Settings rule: main projects edit the binding; children retain their snapshot. */
export function featureNoteDirForProjectSave(
  project: FeatureNoteProjectFields,
  input: string,
): string | null {
  if (project.parentProjectId) return project.featureNoteDir;
  return normalizeFeatureNoteDir(input) ?? null;
}
