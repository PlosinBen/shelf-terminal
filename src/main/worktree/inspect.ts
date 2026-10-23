import type { WorktreeIdentity } from '@shared/worktree';

export interface WorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
}
const Field = { PATH: 'worktree', HEAD: 'HEAD', BRANCH: 'branch', DETACHED: 'detached', BARE: 'bare', LOCKED: 'locked', PRUNABLE: 'prunable' } as const;
export function parseWorktreeList(output: string): WorktreeRecord[] {
  if (!output || !output.endsWith('\0\0')) throw new Error('Incomplete worktree list');
  const paths = new Set<string>();
  return output.slice(0, -2).split('\0\0').map((record) => {
    const fields = new Map<string, string>();
    for (const field of record.split('\0')) {
      const space = field.indexOf(' ');
      const key = space < 0 ? field : field.slice(0, space);
      const value = space < 0 ? '' : field.slice(space + 1);
      if (Object.values(Field).includes(key as typeof Field[keyof typeof Field])) {
        if (fields.has(key)) throw new Error(`Duplicate worktree field: ${key}`);
        fields.set(key, value);
      }
    }
    const path = fields.get(Field.PATH);
    const head = fields.get(Field.HEAD) ?? null;
    const ref = fields.get(Field.BRANCH);
    const bare = fields.has(Field.BARE);
    const detached = fields.has(Field.DETACHED);
    if (!path || paths.has(path) || (bare && (head || ref || detached)) ||
        (!bare && (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || (detached === (ref !== undefined)))) ||
        (ref !== undefined && !ref.startsWith('refs/heads/'))) {
      throw new Error(`Invalid worktree record: ${JSON.stringify(path)}`);
    }
    paths.add(path);
    return { path, head, branch: ref?.slice('refs/heads/'.length) ?? null, bare };
  });
}
export interface InspectedWorktree extends WorktreeRecord { identity: WorktreeIdentity }
export function sameWorktree(a: WorktreeIdentity, b: WorktreeIdentity): boolean {
  return a.commonDir === b.commonDir && a.gitDir === b.gitDir;
}
