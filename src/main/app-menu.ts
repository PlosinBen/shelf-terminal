import { app, Menu, shell } from 'electron';
import path from 'path';
import { buildAppMenuTemplate } from './app-menu-template';

const ISSUE_URL = 'https://github.com/PlosinBen/shelf-terminal/issues/new';

interface BuildMenuArgs {
  onCheckForUpdates: () => void;
}

export function buildAppMenu({ onCheckForUpdates }: BuildMenuArgs): Menu {
  const template = buildAppMenuTemplate(
    {
      onCheckForUpdates,
      onReportIssue: () => {
        shell.openExternal(ISSUE_URL);
      },
      onViewLogs: () => {
        shell.openPath(path.join(app.getPath('userData'), 'logs'));
      },
    },
    process.platform,
    app.name,
  );
  return Menu.buildFromTemplate(template);
}
