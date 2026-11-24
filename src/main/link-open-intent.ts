import { validateExternalUrlIntent, type ExternalUrlIntentInput, type ExternalUrlIntentDecision } from '@shared/external-url-intent';
import { LINK_OPEN, type LinkOpenInput, type LinkOpenResult } from '@shared/link-open-intent';

interface Dependencies {
  external(input: ExternalUrlIntentInput): Promise<ExternalUrlIntentDecision>;
  web(projectId: string, url: string): unknown;
  file(input: LinkOpenInput): Promise<LinkOpenResult>;
}

export async function openLink(value: unknown, dependencies: Dependencies): Promise<LinkOpenResult> {
  if (!value || typeof value !== 'object') throw new Error('Invalid link request');
  const input = value as LinkOpenInput;
  if (typeof input.url !== 'string' || !input.url || input.url.length > 8192 || /[\u0000-\u001f\u007f]/.test(input.url)) {
    throw new Error('Invalid link value');
  }
  if (input.destination !== undefined && input.destination !== LINK_OPEN.shelf && input.destination !== LINK_OPEN.external) {
    throw new Error('Invalid link destination');
  }
  const source = input.source;
  if (!source || !['app-window', 'project-tab', 'project-note'].includes(source.kind)) throw new Error('Invalid link source');
  if (source.kind !== 'app-window' && (typeof source.projectId !== 'string' || !source.projectId
    || (source.kind === 'project-tab' ? typeof source.tabId !== 'string' || !source.tabId : typeof source.noteId !== 'string' || !source.noteId))) {
    throw new Error('Invalid link source');
  }
  const envelope = validateExternalUrlIntent({
    ...input, url: 'https://link.invalid/',
    source: source.kind === 'project-note'
      ? { kind: 'project-tab', projectId: source.projectId, tabId: source.noteId } : source,
  });
  if (!envelope.ok) throw new Error(`Invalid link request: ${envelope.code}`);
  if (input.destination === LINK_OPEN.external) {
    const decision = await dependencies.external(input as ExternalUrlIntentInput);
    return { kind: 'opened', decision };
  }
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(input.url)?.[0].toLowerCase();
  if (scheme === 'mailto:') {
    return { kind: 'message', title: 'Shelf cannot preview email links', url: input.url };
  }
  if (scheme === 'http:' || scheme === 'https:') {
    const checked = validateExternalUrlIntent({ ...input, source: source.kind === 'project-note' ? { kind: 'app-window' } : source });
    if (!checked.ok) throw new Error(`Link blocked: ${checked.code}`);
    if (source.kind === 'app-window') throw new Error('A destination project is required for this link');
    await dependencies.web(source.projectId, input.url);
    return { kind: 'web', projectId: source.projectId, url: input.url };
  }
  if (scheme && scheme !== 'file:' && !/^[a-z]:[\\/]/i.test(input.url)) throw new Error('Unsupported link scheme');
  if (source.kind === 'app-window') throw new Error('A source project is required for file preview');
  return dependencies.file(input);
}
