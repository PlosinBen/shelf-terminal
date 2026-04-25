import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate, type AppMenuActions } from './app-menu-template';

function noopActions(): AppMenuActions {
  return {
    onCheckForUpdates: vi.fn(),
    onReportIssue: vi.fn(),
    onViewLogs: vi.fn(),
  };
}

function topLevel(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  return template.find((item) => item.label === label);
}

function submenuItems(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  if (!item || !Array.isArray(item.submenu)) return [];
  return item.submenu;
}

function flattenRoles(template: MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  for (const item of template) {
    if (item.role) out.push(item.role);
    if (Array.isArray(item.submenu)) {
      for (const sub of item.submenu) {
        if (sub.role) out.push(sub.role);
      }
    }
  }
  return out;
}

describe('buildAppMenuTemplate (macOS)', () => {
  it('starts with the app menu using the provided app name', () => {
    const t = buildAppMenuTemplate(noopActions(), 'darwin', 'Shelf');
    expect(t[0].label).toBe('Shelf');
  });

  it('puts Check for Updates as the second item in the app menu', () => {
    const t = buildAppMenuTemplate(noopActions(), 'darwin', 'Shelf');
    const items = submenuItems(t[0]);
    expect(items[0].role).toBe('about');
    expect(items[1].label).toBe('Check for Updates…');
  });

  it('does NOT add Check for Updates to Help (avoids duplication)', () => {
    const t = buildAppMenuTemplate(noopActions(), 'darwin', 'Shelf');
    const helpItems = submenuItems(topLevel(t, 'Help'));
    const labels = helpItems.map((i) => i.label);
    expect(labels).not.toContain('Check for Updates…');
  });

  it('Window menu has Front (mac-only convention)', () => {
    const t = buildAppMenuTemplate(noopActions(), 'darwin', 'Shelf');
    const windowItems = submenuItems(topLevel(t, 'Window'));
    const roles = windowItems.map((i) => i.role);
    expect(roles).toContain('front');
    expect(roles).not.toContain('close');
  });
});

describe('buildAppMenuTemplate (Windows / Linux)', () => {
  for (const platform of ['win32', 'linux'] as const) {
    describe(platform, () => {
      it('starts with File menu (no app menu)', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        expect(t[0].label).toBe('File');
      });

      it('puts Check for Updates in Help menu', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const helpItems = submenuItems(topLevel(t, 'Help'));
        const labels = helpItems.map((i) => i.label);
        expect(labels[0]).toBe('Check for Updates…');
      });

      it('Window menu has Close (not Front)', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const windowItems = submenuItems(topLevel(t, 'Window'));
        const roles = windowItems.map((i) => i.role);
        expect(roles).toContain('close');
        expect(roles).not.toContain('front');
      });
    });
  }
});

describe('buildAppMenuTemplate (cross-platform invariants)', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    describe(platform, () => {
      it('Edit menu preserves cut / copy / paste / selectAll roles (terminal needs these)', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const editItems = submenuItems(topLevel(t, 'Edit'));
        const roles = editItems.map((i) => i.role);
        expect(roles).toContain('cut');
        expect(roles).toContain('copy');
        expect(roles).toContain('paste');
        expect(roles).toContain('selectAll');
      });

      it('View menu has DevTools toggle and zoom controls', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const viewItems = submenuItems(topLevel(t, 'View'));
        const roles = viewItems.map((i) => i.role);
        expect(roles).toContain('toggleDevTools');
        expect(roles).toContain('resetZoom');
        expect(roles).toContain('zoomIn');
        expect(roles).toContain('zoomOut');
      });

      // Regression guard: Reload silently destroys xterm scrollback and is the
      // reason this whole menu refactor exists. If anyone re-adds reload by
      // habit, this test breaks loudly.
      it('regression: NO reload / forceReload role anywhere in the menu', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const allRoles = flattenRoles(t);
        expect(allRoles).not.toContain('reload');
        expect(allRoles).not.toContain('forceReload');
      });

      it('Help menu contains Report Issue and View Logs', () => {
        const t = buildAppMenuTemplate(noopActions(), platform, 'Shelf');
        const helpItems = submenuItems(topLevel(t, 'Help'));
        const labels = helpItems.map((i) => i.label);
        expect(labels).toContain('Report Issue…');
        expect(labels).toContain('View Logs');
      });
    });
  }
});

describe('buildAppMenuTemplate click handlers', () => {
  it('Check for Updates click invokes the provided callback', () => {
    const actions = noopActions();
    const t = buildAppMenuTemplate(actions, 'darwin', 'Shelf');
    const appItems = submenuItems(t[0]);
    const checkItem = appItems.find((i) => i.label === 'Check for Updates…');
    expect(checkItem?.click).toBeTypeOf('function');
    (checkItem!.click as () => void)();
    expect(actions.onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it('Report Issue click invokes the provided callback', () => {
    const actions = noopActions();
    const t = buildAppMenuTemplate(actions, 'linux', 'Shelf');
    const helpItems = submenuItems(topLevel(t, 'Help'));
    const reportItem = helpItems.find((i) => i.label === 'Report Issue…');
    (reportItem!.click as () => void)();
    expect(actions.onReportIssue).toHaveBeenCalledOnce();
  });

  it('View Logs click invokes the provided callback', () => {
    const actions = noopActions();
    const t = buildAppMenuTemplate(actions, 'win32', 'Shelf');
    const helpItems = submenuItems(topLevel(t, 'Help'));
    const logsItem = helpItems.find((i) => i.label === 'View Logs');
    (logsItem!.click as () => void)();
    expect(actions.onViewLogs).toHaveBeenCalledOnce();
  });
});
