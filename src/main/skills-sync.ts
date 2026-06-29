/**
 * Single post-mutation pipeline for app-level skills. Called after ANY skill
 * write — whether the trigger was the agent bridge (app-tool) or the manager
 * UI (ipc/skills.ts). Keeps "what happens after a skill changes" in one place so
 * the triggers stay dumb. See .agent/features/app-level-capabilities.md.
 *
 * Three reactions, in order:
 *   1. Re-project onto THIS machine    — a local agent picks it up next session.
 *   2. Re-mirror onto active remotes   — a remote agent picks it up next session
 *      (hash-gated; registered by agent/index.ts via `subscribeSkillsChanged` to
 *      avoid a remote.ts → app-tool.ts → skills-sync.ts import cycle).
 *   3. Notify the renderer             — the open SkillsView refetches its list.
 *
 * Best-effort throughout: a reaction that throws must not fail the mutation, nor
 * block the others.
 */
import { projectSkillsLocal } from './skills-projection';
import { getAppInstanceId } from './app-instance-id';
import { getMainWindow } from './app-state';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';

type SkillsChangedSubscriber = () => void;
const subscribers = new Set<SkillsChangedSubscriber>();

/**
 * Register a reaction to skill mutations (e.g. the remote re-mirror, wired by
 * agent/index.ts which owns the active-session registry). Inverts the dependency
 * so skills-sync never imports back into the agent/remote layer.
 */
export function subscribeSkillsChanged(fn: SkillsChangedSubscriber): void {
  subscribers.add(fn);
}

/**
 * Tell the renderer a skill's metadata changed so the open SkillsView refetches
 * its list. This is the ONLY reaction a pure lock/unlock needs: the lock badge
 * comes from listSkills()'s `locked`, while the lock itself is enforced in main —
 * agents never read it, so there's nothing to re-project, re-mirror, or reload.
 * Content mutations call the full onSkillsChanged() (which ends here too).
 */
export function notifyRendererSkillsChanged(): void {
  try {
    getMainWindow()?.webContents.send(IPC.SKILLS_CHANGED);
  } catch {
    /* renderer may be gone — nothing to refresh */
  }
}

export function onSkillsChanged(): void {
  try {
    projectSkillsLocal(getAppInstanceId());
  } catch {
    /* best-effort — projection failure must not fail the mutation */
  }

  for (const fn of subscribers) {
    try {
      fn();
    } catch (err: any) {
      log.error('skills', `skills-changed subscriber failed: ${err?.message ?? err}`);
    }
  }

  notifyRendererSkillsChanged();
}
