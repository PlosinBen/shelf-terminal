/**
 * Dumb, semantic-free GFM markdown helpers — shared ONLY for table boilerplate
 * (escaping + alignment). Deliberately carries NO knowledge of MCP servers,
 * skills, tools, or any provider concept: list-style provider output (`/mcp`,
 * `/skills`, …) is composed as markdown INSIDE each provider from its own SDK
 * shapes, not normalized into a cross-provider result type. See agent-providers
 * decision on provider-composed rendering primitives.
 *
 * The renderer's `marked` has gfm + table CSS, so these render as real tables.
 */

/** Escape a cell value for a GFM table (pipes break the column boundary). */
export function cell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

/** Build a GFM table from headers + rows (cells pre-escaped via `cell`). */
export function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}
