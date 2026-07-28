export function normalizeWorktreePrefillNotePaths(notePaths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of notePaths ?? []) {
    const notePath = raw.trim();
    if (!notePath || seen.has(notePath)) continue;
    seen.add(notePath);
    out.push(notePath);
  }
  return out;
}
