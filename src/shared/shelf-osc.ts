export const SHELF_OSC_NAMESPACE_PREFIX = '\x1b]6973;';
export const SHELF_OSC_BEL = '\x07';
export const SHELF_OSC_ST = '\x1b\\';
export const SHELF_OSC_MAX_FRAME = 16 * 1024;

export interface ShelfOscFrame {
  readonly route: string;
  readonly version: number;
  readonly payload: string;
  readonly raw: string;
}

export interface ShelfOscAnomaly {
  readonly kind: 'frame-too-long' | 'unterminated-frame';
  readonly route?: string;
}

export interface ShelfOscParseResult {
  readonly visible: string;
  readonly anomalies: readonly ShelfOscAnomaly[];
}

export type ShelfOscRouteHandler = (frame: ShelfOscFrame) => boolean;
export type ShelfOscRouteHandlers = Readonly<Record<string, ShelfOscRouteHandler>>;

export function encodeShelfOscFrame(
  route: string,
  version: number,
  payload: string,
  terminator = SHELF_OSC_BEL,
): string {
  return `${SHELF_OSC_NAMESPACE_PREFIX}${route};${version};${payload}${terminator}`;
}

/** Bounded streaming router for Shelf-owned OSC 6973 feature frames. */
export class ShelfOscRouter {
  private pending = '';

  constructor(private readonly maxFrame = SHELF_OSC_MAX_FRAME) {}

  push(data: string, handlers: ShelfOscRouteHandlers): ShelfOscParseResult {
    let input = this.pending + data;
    this.pending = '';
    let visible = '';
    const anomalies: ShelfOscAnomaly[] = [];

    while (input) {
      const start = input.indexOf(SHELF_OSC_NAMESPACE_PREFIX);
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
        if (input.length > this.maxFrame) {
          const route = routeFromStart(input);
          if (route && handlers[route]) {
            anomalies.push({ kind: 'frame-too-long', route });
          } else {
            visible += input;
          }
        } else {
          this.pending = input;
        }
        break;
      }

      const frameLength = terminator.index + terminator.length;
      const raw = input.slice(0, frameLength);
      const route = routeFromStart(raw);
      if (frameLength > this.maxFrame) {
        if (route && handlers[route]) {
          anomalies.push({ kind: 'frame-too-long', route });
        } else {
          visible += raw;
        }
        input = input.slice(frameLength);
        continue;
      }

      const frame = parseFrame(raw, terminator.index);
      if (!frame) {
        visible += raw;
      } else {
        const handler = handlers[frame.route];
        if (!handler || !handler(frame)) visible += raw;
      }
      input = input.slice(frameLength);
    }

    return { visible, anomalies };
  }

  finish(handlers: ShelfOscRouteHandlers): ShelfOscParseResult {
    const pending = this.pending;
    this.pending = '';
    if (!pending) return { visible: '', anomalies: [] };

    if (pending.startsWith(SHELF_OSC_NAMESPACE_PREFIX)) {
      const route = routeFromStart(pending);
      if (route && handlers[route]) {
        return { visible: '', anomalies: [{ kind: 'unterminated-frame', route }] };
      }
    }
    return { visible: pending, anomalies: [] };
  }
}

function parseFrame(raw: string, terminatorIndex: number): ShelfOscFrame | null {
  const body = raw.slice(SHELF_OSC_NAMESPACE_PREFIX.length, terminatorIndex);
  const match = body.match(/^([a-z0-9-]+);([0-9]+);([\s\S]*)$/);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  return Object.freeze({ route: match[1], version, payload: match[3], raw });
}

function routeFromStart(value: string): string | undefined {
  return value.slice(SHELF_OSC_NAMESPACE_PREFIX.length).match(/^([a-z0-9-]+);/)?.[1];
}

function partialPrefixLength(value: string): number {
  const max = Math.min(value.length, SHELF_OSC_NAMESPACE_PREFIX.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (SHELF_OSC_NAMESPACE_PREFIX.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function terminatorAt(value: string): { index: number; length: number } | null {
  const bel = value.indexOf(SHELF_OSC_BEL, SHELF_OSC_NAMESPACE_PREFIX.length);
  const st = value.indexOf(SHELF_OSC_ST, SHELF_OSC_NAMESPACE_PREFIX.length);
  if (bel === -1 && st === -1) return null;
  if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
  return { index: st, length: SHELF_OSC_ST.length };
}
