import { SKILLS_PREVIEW_SOURCE, EXTERNAL_URL_INTENT_LIMITS, validateExternalUrlIntent, type ExternalUrlIntentInput, type ExternalUrlIntentDecision } from '@shared/external-url-intent';
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
  const envelope = validateExternalUrlIntent({
    ...input, url: 'https://link.invalid/',
  });
  if (!envelope.ok) throw new Error(`Invalid link request: ${envelope.code}`);
  const source = envelope.intent.source;
  if (input.destinationProjectId !== undefined && (source.kind !== SKILLS_PREVIEW_SOURCE
    || typeof input.destinationProjectId !== 'string' || !input.destinationProjectId
    || input.destinationProjectId.trim() !== input.destinationProjectId
    || input.destinationProjectId.length > EXTERNAL_URL_INTENT_LIMITS.sourceId)) {
    throw new Error('Invalid destination project');
  }
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
    const projectId = source.kind === SKILLS_PREVIEW_SOURCE ? input.destinationProjectId
      : source.kind === 'app-window' ? undefined : source.projectId;
    if (!projectId) throw new Error('A destination project is required for this link');
    await dependencies.web(projectId, input.url);
    return { kind: 'web', projectId, url: input.url };
  }
  if (scheme && scheme !== 'file:' && !/^[a-z]:[\\/]/i.test(input.url)) throw new Error('Unsupported link scheme');
  if (source.kind === 'app-window' || source.kind === SKILLS_PREVIEW_SOURCE) throw new Error('A source project is required for file preview');
  return dependencies.file(input);
}
