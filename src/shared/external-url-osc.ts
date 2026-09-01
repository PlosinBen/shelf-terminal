import { EXTERNAL_URL_INTENT_LIMITS } from './external-url-intent';
import {
  SHELF_OSC_BEL,
  SHELF_OSC_NAMESPACE_PREFIX,
  SHELF_OSC_ST,
  ShelfOscRouter,
  encodeShelfOscFrame,
  type ShelfOscFrame,
} from './shelf-osc';

export const EXTERNAL_URL_OSC_ROUTE = 'external-url';
export const EXTERNAL_URL_OSC_VERSION = 1;
export const EXTERNAL_URL_OSC_PREFIX = `${SHELF_OSC_NAMESPACE_PREFIX}${EXTERNAL_URL_OSC_ROUTE};${EXTERNAL_URL_OSC_VERSION};`;
export const EXTERNAL_URL_OSC_BEL = SHELF_OSC_BEL;
export const EXTERNAL_URL_OSC_ST = SHELF_OSC_ST;
export const EXTERNAL_URL_OSC_MAX_PAYLOAD = Math.ceil(EXTERNAL_URL_INTENT_LIMITS.url * 4 / 3);
export const EXTERNAL_URL_OSC_MAX_FRAME = EXTERNAL_URL_OSC_PREFIX.length
  + EXTERNAL_URL_OSC_MAX_PAYLOAD
  + EXTERNAL_URL_OSC_ST.length;

export type ExternalUrlOscAnomaly = 'invalid-payload' | 'frame-too-long' | 'unterminated-frame';

export interface ExternalUrlOscParseResult {
  visible: string;
  urls: string[];
  anomalies: ExternalUrlOscAnomaly[];
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string | null {
  if (!value || value.length > EXTERNAL_URL_OSC_MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function encodeExternalUrlOscFrame(url: string): string {
  return encodeShelfOscFrame(EXTERNAL_URL_OSC_ROUTE, EXTERNAL_URL_OSC_VERSION, encodeBase64Url(url));
}

export type ExternalUrlOscDecodeResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'unsupported-version' | 'invalid-payload' };

export function decodeExternalUrlOscFrame(frame: ShelfOscFrame): ExternalUrlOscDecodeResult {
  if (frame.route !== EXTERNAL_URL_OSC_ROUTE || frame.version !== EXTERNAL_URL_OSC_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const url = decodeBase64Url(frame.payload);
  if (url === null || url.length > EXTERNAL_URL_INTENT_LIMITS.url) {
    return { ok: false, reason: 'invalid-payload' };
  }
  return { ok: true, url };
}

export class ExternalUrlOscParser {
  private readonly router = new ShelfOscRouter(EXTERNAL_URL_OSC_MAX_FRAME);

  finish(): ExternalUrlOscParseResult {
    const result = this.router.finish({ [EXTERNAL_URL_OSC_ROUTE]: () => true });
    return {
      visible: result.visible,
      urls: [],
      anomalies: result.anomalies.map((anomaly) => anomaly.kind),
    };
  }

  push(data: string): ExternalUrlOscParseResult {
    const urls: string[] = [];
    const anomalies: ExternalUrlOscAnomaly[] = [];
    const handleExternalUrl = (frame: ShelfOscFrame): boolean => {
      const decoded = decodeExternalUrlOscFrame(frame);
      if (!decoded.ok && decoded.reason === 'unsupported-version') return false;
      if (!decoded.ok) {
        anomalies.push('invalid-payload');
      } else {
        urls.push(decoded.url);
      }
      return true;
    };
    const result = this.router.push(data, { [EXTERNAL_URL_OSC_ROUTE]: handleExternalUrl });
    anomalies.push(...result.anomalies.map((anomaly) => anomaly.kind));
    return { visible: result.visible, urls, anomalies };
  }
}
