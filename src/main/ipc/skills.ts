import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from '../skills-store';

export function registerSkillsHandlers(): void {
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return listSkills();
  });

  ipcMain.handle(IPC.SKILLS_GET, async (_event, name: string) => {
    return getSkill(name);
  });

  ipcMain.handle(IPC.SKILLS_CREATE, async () => {
    return createSkill();
  });

  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, payload: { name: string; content: string }) => {
    return updateSkill(payload.name, payload.content);
  });

  ipcMain.handle(IPC.SKILLS_DELETE, async (_event, name: string) => {
    await deleteSkill(name);
  });
}
