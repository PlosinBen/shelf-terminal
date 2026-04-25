import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuActions {
  onCheckForUpdates: () => void;
  onReportIssue: () => void;
  onViewLogs: () => void;
}

/**
 * Pure template builder. Returns the menu structure as plain data so it can
 * be unit-tested without an Electron runtime. The wiring layer (`app-menu.ts`)
 * feeds this through `Menu.buildFromTemplate()`.
 *
 * Intentionally omits any reload / forceReload role: an accidental Cmd+R
 * would clear xterm scrollback and force the renderer to reconnect. Reload
 * is reachable only through DevTools.
 */
export function buildAppMenuTemplate(
  actions: AppMenuActions,
  platform: NodeJS.Platform,
  appName: string,
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';

  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => actions.onCheckForUpdates(),
  };

  const helpItems: MenuItemConstructorOptions[] = [
    ...(isMac ? [] : [checkForUpdatesItem, { type: 'separator' as const }]),
    {
      label: 'Report Issue…',
      click: () => actions.onReportIssue(),
    },
    {
      label: 'View Logs',
      click: () => actions.onViewLogs(),
    },
  ];

  return [
    ...(isMac
      ? [{
          label: appName,
          submenu: [
            { role: 'about' as const },
            checkForUpdatesItem,
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : [{
          label: 'File',
          submenu: [{ role: 'quit' as const }],
        }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ]
        : [
            { role: 'minimize' },
            { role: 'close' },
          ],
    },
    {
      label: 'Help',
      submenu: helpItems,
    },
  ];
}
