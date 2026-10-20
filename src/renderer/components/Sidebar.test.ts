import { describe, it, expect } from 'vitest';
import {
  clampMenuPosition,
  decideProjectSearchKey,
  findProjectSearchMatchIndex,
  moveProjectSearchCandidate,
} from './Sidebar';

// Pure overflow math for the project context menu — keeps the whole menu on
// screen (margin 8 by default) when right-clicking near an edge.
describe('clampMenuPosition', () => {
  const VW = 1000;
  const VH = 800;
  const MENU_W = 160;
  const MENU_H = 200;

  it('keeps the requested position when the menu fits', () => {
    expect(clampMenuPosition(100, 100, MENU_W, MENU_H, VW, VH)).toEqual({ left: 100, top: 100 });
  });

  it('pulls the menu up when it would overflow the bottom edge', () => {
    // y=700 + 200 = 900 > 800 → top clamps to 800 - 200 - 8 = 592.
    expect(clampMenuPosition(100, 700, MENU_W, MENU_H, VW, VH)).toEqual({ left: 100, top: 592 });
  });

  it('pulls the menu left when it would overflow the right edge', () => {
    // x=900 + 160 = 1060 > 1000 → left clamps to 1000 - 160 - 8 = 832.
    expect(clampMenuPosition(900, 100, MENU_W, MENU_H, VW, VH)).toEqual({ left: 832, top: 100 });
  });

  it('clamps both axes when cornered at the bottom-right', () => {
    expect(clampMenuPosition(990, 790, MENU_W, MENU_H, VW, VH)).toEqual({ left: 832, top: 592 });
  });

  it('never goes past the top/left margin when the menu is taller than the viewport', () => {
    expect(clampMenuPosition(100, 100, MENU_W, 1000, VW, VH)).toEqual({ left: 100, top: 8 });
  });

  it('respects a custom margin', () => {
    expect(clampMenuPosition(990, 100, MENU_W, MENU_H, VW, VH, 20)).toEqual({ left: 820, top: 100 });
  });
});

describe('project search', () => {
  it('matches only non-empty case-insensitive substrings of the displayed label', () => {
    expect(findProjectSearchMatchIndex('Feature/Project-Search', 'project')).toBe(8);
    expect(findProjectSearchMatchIndex('Feature/Project-Search', 'PROJECT')).toBe(8);
    expect(findProjectSearchMatchIndex('Feature/Project-Search', 'parent')).toBe(-1);
    expect(findProjectSearchMatchIndex('Feature/Project-Search', '')).toBe(-1);
  });

  it('maps navigation and completion keys only outside IME composition', () => {
    expect(decideProjectSearchKey('ArrowDown', false)).toBe('down');
    expect(decideProjectSearchKey('ArrowUp', false)).toBe('up');
    expect(decideProjectSearchKey('Enter', false)).toBe('activate');
    expect(decideProjectSearchKey('Escape', false)).toBe('close');
    expect(decideProjectSearchKey('a', false)).toBe('none');

    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(decideProjectSearchKey(key, true)).toBe('none');
    }
  });

  it('moves between matches without wrapping and starts at the nearest edge', () => {
    const matches = ['alpha', 'alpine', 'atlas'];
    expect(moveProjectSearchCandidate(matches, 'alpha', 1)).toBe('alpine');
    expect(moveProjectSearchCandidate(matches, 'alpha', -1)).toBe('alpha');
    expect(moveProjectSearchCandidate(matches, 'atlas', 1)).toBe('atlas');
    expect(moveProjectSearchCandidate(matches, null, 1)).toBe('alpha');
    expect(moveProjectSearchCandidate(matches, null, -1)).toBe('atlas');
    expect(moveProjectSearchCandidate([], null, 1)).toBeNull();
  });
});
