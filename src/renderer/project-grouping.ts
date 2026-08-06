/**
 * Sidebar project grouping.
 *
 * A project and its worktree children form ONE visual group that moves as a unit
 * when reordered. The store keeps `projects[]` FLAT (so `activeProjectIndex` and
 * index-based keybindings stay untouched) but upholds one invariant: a worktree
 * child sits immediately after its parent. These pure helpers own that invariant
 * and the group-granular reorder math, kept out of the store so they're testable.
 *
 * Generic over any item exposing `config.id` / `config.parentProjectId` — works on
 * both ProjectRuntime (renderer) and bare ProjectConfig.
 */

export interface GroupableItem {
  config: { id: string; parentProjectId?: string };
}

/**
 * Partition a flat item list into contiguous groups. Assumes the group invariant
 * holds (children already follow their parent — call `groupedOrder` first if not).
 * A group is a run starting at a parent (or an orphan child whose parent is absent)
 * followed by that parent's children. Returns arrays of indices into `items`.
 */
export function computeGroups<T extends GroupableItem>(items: readonly T[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    const pid = items[i].config.parentProjectId;
    const last = groups[groups.length - 1];
    if (pid && last && items[last[0]].config.id === pid) {
      last.push(i);
    } else {
      groups.push([i]);
    }
  }
  return groups;
}

export interface ConnectableGroupableItem extends GroupableItem {
  readonly tabs: readonly unknown[];
}

/**
 * Return indices into the original flat project list that should be visible.
 * Connected-only mode keeps an entire visual group when any member has a tab.
 */
export function computeVisibleProjectIndices<T extends ConnectableGroupableItem>(
  items: readonly T[],
  hideDisconnected: boolean,
): number[] {
  if (!hideDisconnected) return items.map((_, index) => index);

  return computeGroups(items).flatMap((group) =>
    group.some((index) => items[index].tabs.length > 0) ? group : [],
  );
}

/** Find the nearest visible real project index in one direction, without wrap. */
export function findDirectionalVisibleProjectIndex(
  visibleIndices: readonly number[],
  activeProjectIndex: number,
  direction: -1 | 1,
): number | null {
  if (direction === 1) {
    return visibleIndices.find((index) => index > activeProjectIndex) ?? null;
  }

  for (let i = visibleIndices.length - 1; i >= 0; i--) {
    if (visibleIndices[i] < activeProjectIndex) return visibleIndices[i];
  }
  return null;
}

/**
 * Normalize order so every worktree child sits directly after its parent, in a
 * stable way: parents keep their relative order, a parent's children keep theirs,
 * and an orphan child (parent not present) stays where it is as its own row. Used
 * on load (persisted order may predate grouping) and after appending a new child.
 */
export function groupedOrder<T extends GroupableItem>(items: T[]): T[] {
  const ids = new Set(items.map((it) => it.config.id));
  const result: T[] = [];
  const used = new Array<boolean>(items.length).fill(false);

  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    const it = items[i];
    const pid = it.config.parentProjectId;
    // A child whose parent exists is emitted alongside that parent below — skip
    // here so it lands right after the parent, not at its original position.
    if (pid && ids.has(pid)) continue;

    // Parent (or orphan child): emit it, then pull in its children in order.
    result.push(it);
    used[i] = true;
    if (pid) continue; // orphan child has no children of its own
    for (let j = 0; j < items.length; j++) {
      if (used[j]) continue;
      if (items[j].config.parentProjectId === it.config.id) {
        result.push(items[j]);
        used[j] = true;
      }
    }
  }
  return result;
}

/**
 * Move the whole group containing `fromIndex` to the slot of the group containing
 * `toIndex`, preserving each group's internal order. Group-granular analogue of a
 * flat splice: dragging any row drags its entire group. Returns the same reference
 * when the move is a no-op (same group) so callers can skip re-render.
 */
export function moveGroup<T extends GroupableItem>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  if (toIndex < 0 || toIndex >= items.length) return items;

  const groups = computeGroups(items);
  const fromG = groups.findIndex((g) => g.includes(fromIndex));
  const toG = groups.findIndex((g) => g.includes(toIndex));
  if (fromG === -1 || toG === -1 || fromG === toG) return items;

  const order = groups.slice();
  const [moved] = order.splice(fromG, 1);
  order.splice(toG, 0, moved);
  return order.flatMap((g) => g.map((idx) => items[idx]));
}
