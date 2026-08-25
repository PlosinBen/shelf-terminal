import { EXTERNAL_URL_INTENT_LIMITS } from './external-url-intent';

export const EXTERNAL_URL_OSC_PREFIX = '\x1b]6973;external-url;1;';
export const EXTERNAL_URL_OSC_BEL = '\x07';
export const EXTERNAL_URL_OSC_ST = '\x1b\\';
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
  return `${EXTERNAL_URL_OSC_PREFIX}${encodeBase64Url(url)}${EXTERNAL_URL_OSC_BEL}`;
}

function partialPrefixLength(value: string): number {
  const max = Math.min(value.length, EXTERNAL_URL_OSC_PREFIX.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (EXTERNAL_URL_OSC_PREFIX.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function terminatorAt(value: string): { index: number; length: number } | null {
  const bel = value.indexOf(EXTERNAL_URL_OSC_BEL, EXTERNAL_URL_OSC_PREFIX.length);
  const st = value.indexOf(EXTERNAL_URL_OSC_ST, EXTERNAL_URL_OSC_PREFIX.length);
  if (bel === -1 && st === -1) return null;
  if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
  return { index: st, length: EXTERNAL_URL_OSC_ST.length };
}

export class ExternalUrlOscParser {
  private pending = '';

  finish(): ExternalUrlOscParseResult {
    const pending = this.pending;
    this.pending = '';
    if (!pending) return { visible: '', urls: [], anomalies: [] };
    if (pending.startsWith(EXTERNAL_URL_OSC_PREFIX)) {
      return { visible: '', urls: [], anomalies: ['unterminated-frame'] };
    }
    return { visible: pending, urls: [], anomalies: [] };
  }

  push(data: string): ExternalUrlOscParseResult {
    let input = this.pending + data;
    this.pending = '';
    let visible = '';
    const urls: string[] = [];
    const anomalies: ExternalUrlOscAnomaly[] = [];

    while (input) {
      const start = input.indexOf(EXTERNAL_URL_OSC_PREFIX);
      if (start === -1) {
        const partialLength = partialPrefixLength(input);
        visible += partialLength ? input.slice(0, -partialLength) : input;
        this.pending = partialLength ? input.slice(-partialLength) : '';
        break;
      }

      visible += input.slice(0, start);
      input = input.slice(start);
      const terminator = terminatorAt(input);
      if (!terminator) {
        if (input.length > EXTERNAL_URL_OSC_MAX_FRAME) {
          anomalies.push('frame-too-long');
        } else {
          this.pending = input;
        }
        break;
      }

      const frameLength = terminator.index + terminator.length;
      if (frameLength > EXTERNAL_URL_OSC_MAX_FRAME) {
        anomalies.push('frame-too-long');
      } else {
        const payload = input.slice(EXTERNAL_URL_OSC_PREFIX.length, terminator.index);
        const url = decodeBase64Url(payload);
        if (url === null || url.length > EXTERNAL_URL_INTENT_LIMITS.url) {
          anomalies.push('invalid-payload');
        } else {
          urls.push(url);
        }
      }
      input = input.slice(frameLength);
    }

    return { visible, urls, anomalies };
  }
}
