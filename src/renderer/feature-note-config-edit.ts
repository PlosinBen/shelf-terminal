import { normalizeFeatureNoteDir } from '@shared/feature-note-dir';

interface FeatureNoteProjectConfig {
  readonly parentProjectId?: string;
  readonly featureNoteDir?: string;
}

/** Project Settings rule: main projects edit the binding; children retain their snapshot. */
export function featureNoteDirForProjectSave(
  project: FeatureNoteProjectConfig,
  input: string,
): string | undefined {
  if (project.parentProjectId) return project.featureNoteDir;
  return normalizeFeatureNoteDir(input);
}
