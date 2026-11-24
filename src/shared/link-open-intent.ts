import type { ExternalUrlIntentSource, ExternalUrlIntentDecision } from './external-url-intent';

export const LINK_OPEN = {
  submit: 'link-open:submit',
  external: 'external',
  shelf: 'shelf',
  projectAttribute: 'data-link-project-id',
  viewAttribute: 'data-link-view-id',
  noteAttribute: 'data-link-note-id',
  destinationAttribute: 'data-link-destination',
  maxFileBytes: 1024 * 1024,
} as const;

export function linkSourceAttributes(projectId: string, viewId: string, note = false) {
  return { [LINK_OPEN.projectAttribute]: projectId, [note ? LINK_OPEN.noteAttribute : LINK_OPEN.viewAttribute]: viewId };
}

export interface LinkOpenInput {
  url: string;
  reason: string;
  source: ExternalUrlIntentSource;
  destination?: 'shelf' | 'external';
}

export type LinkOpenResult =
  | { kind: 'opened'; decision?: ExternalUrlIntentDecision }
  | { kind: 'web'; projectId: string; url: string }
  | { kind: 'message'; title: string; url: string }
  | { kind: 'file'; url: string; path: string; content: string; line?: number };

export type LinkPreviewResult = Extract<LinkOpenResult, { kind: 'message' | 'file' }>;
