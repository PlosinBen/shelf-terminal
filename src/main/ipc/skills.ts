import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';
import { SKILL_COMMAND_RESERVED_ALIASES } from '@shared/skill-commands';
import type { SkillEditorSaveRequest } from '@shared/skill-editor';
import { createSkillEditorService } from '../skills-editor';
import { readSkillCommandFile } from '../skill-commands';
import { withSkillsMutation } from '../skills-mutation';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill, setSkillLocked, setSkillDisabled,
  listSkillAuxFiles, readSkillFile, writeSkillFile, deleteSkillFile, skillDirPath,
} from '../skills-store';
import { onSkillsChanged, notifyRendererSkillsChanged } from '../skills-sync';

// The manager UI is just one TRIGGER of a skill mutation — like the agent
// bridge. Both funnel into the single onSkillsChanged() pipeline (re-project
// locally, re-mirror to live remotes, notify the renderer) so the after-effects
// live in one place. Best-effort — the store write already succeeded.

export function registerSkillsHandlers(): void {
  const editor = createSkillEditorService(SKILL_COMMAND_RESERVED_ALIASES);
  ipcMain.handle(IPC.SKILLS_EDITOR_READ, async (_event, name: string) => editor.read(name));
  ipcMain.handle(IPC.SKILLS_EDITOR_SAVE, async (_event, request: SkillEditorSaveRequest) => {
    const result = await editor.save(request);
    // Partial success still changed the source. Refresh the appropriate consumers.
    if (result.contentChanged) onSkillsChanged();
    else if (result.commandChanged) notifyRendererSkillsChanged();
    return result;
  });
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return withSkillsMutation(async () => (await listSkills()).map(skill => {
      const result = readSkillCommandFile(skillDirPath(skill.name));
      if (!result.ok) log.error('skills', `command list failed skill=${skill.name}: ${result.error}`);
      return { ...skill, ...(result.ok ? { commandAlias: result.value?.alias } : { commandError: result.error }) };
    }));
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

  // Enable/disable is the OPPOSITE of lock: it changes the projected/synced tree
  // (a disabled skill's folder is dropped, so its description leaves context), so
  // it MUST run the full onSkillsChanged() pipeline — re-project locally, re-mirror
  // to live remotes (hash-gated), hot-reload live sessions — not the badge-only
  // notifyRendererSkillsChanged the lock handler uses.
  ipcMain.handle(IPC.SKILLS_SET_DISABLED, async (_event, payload: { name: string; disabled: boolean }) => {
    await setSkillDisabled(payload.name, payload.disabled);
    onSkillsChanged();
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
