import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from '../skills-store';
import { onSkillsChanged } from '../skills-sync';

// The manager UI is just one TRIGGER of a skill mutation — like the agent
// bridge. Both funnel into the single onSkillsChanged() pipeline (re-project
// locally, re-mirror to live remotes, notify the renderer) so the after-effects
// live in one place. Best-effort — the store write already succeeded.

export function registerSkillsHandlers(): void {
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return listSkills();
  });

  ipcMain.handle(IPC.SKILLS_GET, async (_event, name: string) => {
    return getSkill(name);
  });

  ipcMain.handle(IPC.SKILLS_CREATE, async () => {
    const meta = await createSkill();
    onSkillsChanged();
    return meta;
  });

  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, payload: { name: string; content: string }) => {
    const res = await updateSkill(payload.name, payload.content);
    if (res.ok) onSkillsChanged();
    return res;
  });

  ipcMain.handle(IPC.SKILLS_DELETE, async (_event, name: string) => {
    await deleteSkill(name);
    onSkillsChanged();
  });
}
