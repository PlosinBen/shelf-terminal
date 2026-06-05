import { app, Menu } from 'electron';
import { buildAppMenuTemplate } from './app-menu-template';

interface BuildMenuArgs {
  onCheckForUpdates: () => void;
}

export function buildAppMenu({ onCheckForUpdates }: BuildMenuArgs): Menu {
  const template = buildAppMenuTemplate(
    {
      onCheckForUpdates,
    },
    process.platform,
    app.name,
  );
  return Menu.buildFromTemplate(template);
}
