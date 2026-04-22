const MAX_BYTES = 100 * 1024; // 100KB per tab

const buffers = new Map<string, string>();

export function append(tabId: string, data: string): void {
  const existing = buffers.get(tabId) ?? '';
  let combined = existing + data;
  if (combined.length > MAX_BYTES) {
    combined = combined.slice(combined.length - MAX_BYTES);
  }
  buffers.set(tabId, combined);
}

export function read(tabId: string, lines = 50): string {
  const raw = buffers.get(tabId) ?? '';
  return lastNLines(stripAnsi(raw), lines);
}

export function remove(tabId: string): void {
  buffers.delete(tabId);
}

export function clear(): void {
  buffers.clear();
}

export function allTabIds(): string[] {
  return [...buffers.keys()];
}

export function has(tabId: string): boolean {
  return buffers.has(tabId);
}

function lastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

// Strip ANSI escape sequences (colors, cursor movement, OSC, etc.)
const ANSI_RE = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\[[0-9;]*[?]?[a-zA-Z]|\(B)/g;
// Also strip carriage returns for cleaner output
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r/g, '');
}
