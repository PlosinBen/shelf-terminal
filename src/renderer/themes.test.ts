import { describe, it, expect } from 'vitest';
import { themes, getTheme, buildThemeVars, SEMANTIC_TOKENS } from './themes';

/**
 * R3 — themes.ts is the single serializable source for ALL theme tokens.
 * buildThemeVars is the one token→CSS-var derivation App.tsx feeds to
 * documentElement (and a future native/webview host reuses verbatim), so it
 * must (a) emit the full, stable key set for every theme, (b) map per-theme
 * `ui` + shared SEMANTIC_TOKENS correctly, and (c) stay plain-serializable.
 */

const EXPECTED_KEYS = [
  '--bg', '--bg-secondary', '--border', '--text', '--text-muted', '--accent', '--surface',
  '--agent-error', '--agent-success', '--agent-warning', '--agent-info',
  '--agent-fold-label', '--agent-user-bubble',
  '--status-healthy', '--status-slow', '--status-unstable', '--status-dead',
].sort();

describe('buildThemeVars', () => {
  it('emits the full, stable key set for every theme', () => {
    for (const theme of themes) {
      const vars = buildThemeVars(theme);
      expect(Object.keys(vars).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  it('maps per-theme ui colors', () => {
    const t = getTheme('catppuccin-mocha');
    const vars = buildThemeVars(t);
    expect(vars['--bg']).toBe(t.ui.bg);
    expect(vars['--text']).toBe(t.ui.text);
    expect(vars['--accent']).toBe(t.ui.accent);
  });

  it('maps the shared theme-invariant semantic tokens', () => {
    // Semantic colors are identical across themes by design (theme-invariant).
    const a = buildThemeVars(getTheme('catppuccin-mocha'));
    const b = buildThemeVars(getTheme('dracula'));
    for (const key of ['--agent-error', '--agent-success', '--agent-warning', '--agent-info', '--agent-fold-label', '--agent-user-bubble', '--status-healthy', '--status-slow', '--status-unstable', '--status-dead']) {
      expect(a[key]).toBe(b[key]);
    }
    expect(a['--agent-error']).toBe(SEMANTIC_TOKENS.error);
    expect(a['--agent-user-bubble']).toBe(SEMANTIC_TOKENS.userBubble);
    expect(a['--status-dead']).toBe(SEMANTIC_TOKENS.statusDead);
  });

  it('is plain-serializable (structuredClone round-trips identically)', () => {
    const vars = buildThemeVars(getTheme('nord'));
    expect(structuredClone(vars)).toEqual(vars);
    // Every value is a string — safe to ship over postMessage / to a native host.
    expect(Object.values(vars).every((v) => typeof v === 'string')).toBe(true);
  });
});
