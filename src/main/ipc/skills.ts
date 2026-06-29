import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill, setSkillLocked,
  listSkillAuxFiles, readSkillFile, writeSkillFile, deleteSkillFile,
} from '../skills-store';
import { onSkillsChanged, notifyRendererSkillsChanged } from '../skills-sync';

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

  // Lock/unlock is metadata-only: enforced in main against the source folder,
  // never read by agents. So it just repaints the renderer badge — it must NOT
  // re-project, re-sync to remotes, or hot-reload live sessions (which would
  // inject a stray "Skills reloaded" line into unrelated agent tabs).
  ipcMain.handle(IPC.SKILLS_SET_LOCKED, async (_event, payload: { name: string; locked: boolean }) => {
    await setSkillLocked(payload.name, payload.locked);
    notifyRendererSkillsChanged();
  });

  // Aux files: the manager is, like the agent bridge, just a TRIGGER — writes
  // funnel into onSkillsChanged() (re-project). UNLIKE the bridge, the manager
  // is NOT lock-gated (lock fences the agent out, not the user).
  ipcMain.handle(IPC.SKILLS_LIST_FILES, async (_event, name: string) => {
    return listSkillAuxFiles(name);
  });

  ipcMain.handle(IPC.SKILLS_READ_FILE, async (_event, payload: { name: string; path: string }) => {
    return readSkillFile(payload.name, payload.path);
  });

  ipcMain.handle(IPC.SKILLS_WRITE_FILE, async (_event, payload: { name: string; path: string; content: string }) => {
    const res = await writeSkillFile(payload.name, payload.path, payload.content);
    if (res.ok) onSkillsChanged();
    return res;
  });

  ipcMain.handle(IPC.SKILLS_DELETE_FILE, async (_event, payload: { name: string; path: string }) => {
    const res = await deleteSkillFile(payload.name, payload.path);
    if (res.ok) onSkillsChanged();
    return res;
  });
}
