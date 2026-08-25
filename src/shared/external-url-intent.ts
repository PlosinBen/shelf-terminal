export const EXTERNAL_URL_INTENT_DECISIONS = {
  copy: 'copy',
  open: 'open',
  cancel: 'cancel',
} as const;

export type ExternalUrlIntentDecision = typeof EXTERNAL_URL_INTENT_DECISIONS[keyof typeof EXTERNAL_URL_INTENT_DECISIONS];

export const EXTERNAL_URL_INTENT_SCHEMES = {
  http: 'http:',
  https: 'https:',
  mailto: 'mailto:',
} as const;

export const EXTERNAL_URL_INTENT_LIMITS = {
  url: 8_192,
  reason: 512,
  sourceId: 256,
} as const;

export type ExternalUrlIntentSource =
  | { kind: 'project-tab'; projectId: string; tabId: string }
  | { kind: 'app-window' };

export interface ExternalUrlIntentInput {
  url: string;
  reason: string;
  source: ExternalUrlIntentSource;
}

export type ExternalUrlDestination =
  | { kind: 'web-origin'; origin: string }
  | { kind: 'mail-address'; address: string };

export interface ValidatedExternalUrlIntent extends ExternalUrlIntentInput {
  destination: ExternalUrlDestination;
}

export interface ExternalUrlIntentRequest extends ValidatedExternalUrlIntent {
  requestId: string;
}

export type ExternalUrlIntentFailureCode =
  | 'invalid-input'
  | 'url-too-long'
  | 'malformed-url'
  | 'unsupported-scheme'
  | 'embedded-credentials'
  | 'missing-mail-destination'
  | 'malformed-mail-destination'
  | 'invalid-reason'
  | 'invalid-source';

export type ExternalUrlIntentValidation =
  | { ok: true; intent: ValidatedExternalUrlIntent }
  | { ok: false; code: ExternalUrlIntentFailureCode };

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

function validateSource(value: unknown): value is ExternalUrlIntentSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  if (source.kind === 'app-window') return true;
  return source.kind === 'project-tab'
    && isBoundedNonEmptyString(source.projectId, EXTERNAL_URL_INTENT_LIMITS.sourceId)
    && isBoundedNonEmptyString(source.tabId, EXTERNAL_URL_INTENT_LIMITS.sourceId);
}

/**
 * Validate an untrusted URL-intent payload without echoing its exact URL in the
 * failure shape. Callers may safely log a failure code; successful exact URLs
 * remain UI/action data and must not be written to diagnostics or persistence.
 */
export function validateExternalUrlIntent(value: unknown): ExternalUrlIntentValidation {
  if (!value || typeof value !== 'object') return { ok: false, code: 'invalid-input' };
  const input = value as Record<string, unknown>;

  if (typeof input.url !== 'string' || input.url.length === 0 || input.url.trim() !== input.url) {
    return { ok: false, code: 'malformed-url' };
  }
  if (input.url.length > EXTERNAL_URL_INTENT_LIMITS.url) {
    return { ok: false, code: 'url-too-long' };
  }
  if (!isBoundedNonEmptyString(input.reason, EXTERNAL_URL_INTENT_LIMITS.reason)) {
    return { ok: false, code: 'invalid-reason' };
  }
  if (!validateSource(input.source)) return { ok: false, code: 'invalid-source' };

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, code: 'malformed-url' };
  }

  let destination: ExternalUrlDestination;
  if (parsed.protocol === EXTERNAL_URL_INTENT_SCHEMES.http
      || parsed.protocol === EXTERNAL_URL_INTENT_SCHEMES.https) {
    if (parsed.username || parsed.password) return { ok: false, code: 'embedded-credentials' };
    destination = { kind: 'web-origin', origin: parsed.origin };
  } else if (parsed.protocol === EXTERNAL_URL_INTENT_SCHEMES.mailto) {
    if (!parsed.pathname) return { ok: false, code: 'missing-mail-destination' };
    let address: string;
    try {
      address = decodeURIComponent(parsed.pathname);
    } catch {
      return { ok: false, code: 'malformed-mail-destination' };
    }
    if (!address || /[\u0000-\u001f\u007f]/.test(address)) {
      return { ok: false, code: 'malformed-mail-destination' };
    }
    destination = { kind: 'mail-address', address };
  } else {
    return { ok: false, code: 'unsupported-scheme' };
  }

  return {
    ok: true,
    intent: {
      url: input.url,
      reason: input.reason,
      source: input.source,
      destination,
    },
  };
}
