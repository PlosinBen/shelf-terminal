import { registerPtyHandlers } from './pty';
import { registerProjectHandlers } from './project';
import { registerConnectorHandlers } from './connector';
import { registerGitHandlers } from './git';
import { registerFileTransferHandlers } from './file-transfer';
import { registerDialogHandlers } from './dialog';
import { registerSettingsHandlers } from './settings';
import { registerLogsHandlers } from './logs';
import { registerWebHandlers } from './web';
import { registerNotesHandlers } from './notes';
import { registerSkillsHandlers } from './skills';
import { registerMcpHandlers } from './mcp';
import { registerConfigBackupHandlers } from './config-backup';
import { registerUpdaterHandlers } from './updater';
import { registerPmHandlers } from './pm';
import { registerFindHandlers } from './find';

/**
 * Registers every domain's IPC handlers. Agent handlers are registered
 * separately via initAgentManager() (see ../agent), and window lifecycle /
 * reload-guard / menu wiring stays in index.ts.
 */
export function registerAllIpcHandlers(): void {
  registerPtyHandlers();
  registerProjectHandlers();
  registerConnectorHandlers();
  registerGitHandlers();
  registerFileTransferHandlers();
  registerDialogHandlers();
  registerSettingsHandlers();
  registerLogsHandlers();
  registerWebHandlers();
  registerNotesHandlers();
  registerSkillsHandlers();
  registerMcpHandlers();
  registerConfigBackupHandlers();
  registerUpdaterHandlers();
  registerPmHandlers();
  registerFindHandlers();
}
