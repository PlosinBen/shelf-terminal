import { describe, it, expect } from 'vitest';
import { clampMenuPosition } from './Sidebar';

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
