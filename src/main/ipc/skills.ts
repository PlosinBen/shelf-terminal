import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from '../skills-store';
import { projectSkillsLocal } from '../skills-projection';
import { getAppInstanceId } from '../app-instance-id';

// Keep the local projection (`~/.shelf/apps/<id>/skills`) in step with edits so
// the next agent query sees fresh skills without reopening the tab (Claude
// re-reads its plugins per query). Remote machines re-sync on their next
// session (L3). Best-effort — the store write already succeeded.
function reproject(): void {
  projectSkillsLocal(getAppInstanceId());
}

export function registerSkillsHandlers(): void {
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return listSkills();
  });

  ipcMain.handle(IPC.SKILLS_GET, async (_event, name: string) => {
    return getSkill(name);
  });

  ipcMain.handle(IPC.SKILLS_CREATE, async () => {
    const meta = await createSkill();
    reproject();
    return meta;
  });

  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, payload: { name: string; content: string }) => {
    const res = await updateSkill(payload.name, payload.content);
    if (res.ok) reproject();
    return res;
  });

  ipcMain.handle(IPC.SKILLS_DELETE, async (_event, name: string) => {
    await deleteSkill(name);
    reproject();
  });
}
