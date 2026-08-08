import { describe, it, expect } from 'vitest';
import {
  computeGroups,
  computeVisibleProjectIndices,
  findDirectionalVisibleProjectIndex,
  groupedOrder,
  moveGroup,
  type GroupableItem,
} from './project-grouping';

// Minimal items — only id / parentProjectId matter.
const item = (id: string, parentProjectId?: string): GroupableItem => ({
  id,
  parentProjectId: parentProjectId ?? null,
});
const ids = (items: GroupableItem[]) => items.map((it) => it.id);

describe('computeGroups', () => {
  it('groups each parent with its trailing children (invariant holds)', () => {
    const items = [item('A'), item('A1', 'A'), item('A2', 'A'), item('B'), item('B1', 'B')];
    expect(computeGroups(items)).toEqual([[0, 1, 2], [3, 4]]);
  });

  it('treats a bare parent as a singleton group', () => {
    const items = [item('A'), item('B'), item('C')];
    expect(computeGroups(items)).toEqual([[0], [1], [2]]);
  });

  it('a child not adjacent to its parent starts its own group (invariant broken)', () => {
    // Not normalized: child of A appears after B — computeGroups reflects raw layout.
    const items = [item('A'), item('B'), item('A1', 'A')];
    expect(computeGroups(items)).toEqual([[0], [1], [2]]);
  });
});

describe('groupedOrder', () => {
  it('pulls a child up to sit right after its parent', () => {
    const items = [item('A'), item('B'), item('A1', 'A')];
    expect(ids(groupedOrder(items))).toEqual(['A', 'A1', 'B']);
  });

  it('keeps parent order and each parent’s child order stable', () => {
    const items = [item('A'), item('B'), item('B2', 'B'), item('A1', 'A'), item('B1', 'B')];
    // B2 precedes B1 in the source → order preserved within B's group.
    expect(ids(groupedOrder(items))).toEqual(['A', 'A1', 'B', 'B2', 'B1']);
  });

  it('is idempotent on already-grouped input', () => {
    const items = [item('A'), item('A1', 'A'), item('B')];
    expect(ids(groupedOrder(items))).toEqual(['A', 'A1', 'B']);
  });

  it('leaves an orphan child (parent absent) as its own row in place', () => {
    const items = [item('A'), item('X1', 'GONE'), item('B')];
    expect(ids(groupedOrder(items))).toEqual(['A', 'X1', 'B']);
  });

  it('places a newly appended child after its parent group', () => {
    const items = [item('A'), item('A1', 'A'), item('B')];
    const appended = [...items, item('A2', 'A')]; // pushed to end
    expect(ids(groupedOrder(appended))).toEqual(['A', 'A1', 'A2', 'B']);
  });
});

describe('moveGroup', () => {
  const items = [item('A'), item('A1', 'A'), item('B'), item('C')];

  it('moves a whole parent group when dragging the parent', () => {
    // Drag A (idx 0) onto C (idx 3): A's group lands at C's slot.
    expect(ids(moveGroup(items, 0, 3))).toEqual(['B', 'C', 'A', 'A1']);
  });

  it('dragging onto a child resolves to that child’s group', () => {
    // Drag C (idx 3) onto A1 (idx 1, a child of A): C lands at A's group slot.
    expect(ids(moveGroup(items, 3, 1))).toEqual(['C', 'A', 'A1', 'B']);
  });

  it('is a no-op (same reference) when source and target share a group', () => {
    expect(moveGroup(items, 0, 1)).toBe(items);
  });

  it('is a no-op for out-of-range indices', () => {
    expect(moveGroup(items, -1, 2)).toBe(items);
    expect(moveGroup(items, 1, 99)).toBe(items);
  });

  it('moves a group up above an earlier group', () => {
    expect(ids(moveGroup(items, 2, 0))).toEqual(['B', 'A', 'A1', 'C']);
  });
});

describe('computeVisibleProjectIndices', () => {
  const project = (id: string, connected: boolean, parentProjectId?: string) => ({
    ...item(id, parentProjectId),
    tabs: connected ? [{}] : [],
  });

  it('returns every original index when connected-only mode is off', () => {
    const items = [project('A', false), project('B', true)];
    expect(computeVisibleProjectIndices(items, false)).toEqual([0, 1]);
  });

  it('hides disconnected standalone projects', () => {
    const items = [project('A', false), project('B', true), project('C', false)];
    expect(computeVisibleProjectIndices(items, true)).toEqual([1]);
  });

  it('keeps a whole worktree group when any member is connected', () => {
    const items = [
      project('A', false),
      project('A1', true, 'A'),
      project('A2', false, 'A'),
      project('B', false),
      project('B1', false, 'B'),
    ];
    expect(computeVisibleProjectIndices(items, true)).toEqual([0, 1, 2]);
  });

  it('treats an orphan child as its own visibility group', () => {
    const items = [project('A', true), project('X1', false, 'GONE'), project('B', true)];
    expect(computeVisibleProjectIndices(items, true)).toEqual([0, 2]);
  });
});

describe('findDirectionalVisibleProjectIndex', () => {
  const visible = [0, 2, 5];

  it('finds the nearest visible index in either direction', () => {
    expect(findDirectionalVisibleProjectIndex(visible, 2, -1)).toBe(0);
    expect(findDirectionalVisibleProjectIndex(visible, 2, 1)).toBe(5);
  });

  it('can navigate outward from a currently hidden index', () => {
    expect(findDirectionalVisibleProjectIndex(visible, 3, -1)).toBe(2);
    expect(findDirectionalVisibleProjectIndex(visible, 3, 1)).toBe(5);
  });

  it('does not wrap when no visible index exists in the direction', () => {
    expect(findDirectionalVisibleProjectIndex(visible, 0, -1)).toBeNull();
    expect(findDirectionalVisibleProjectIndex(visible, 5, 1)).toBeNull();
    expect(findDirectionalVisibleProjectIndex([], 2, 1)).toBeNull();
  });
});
