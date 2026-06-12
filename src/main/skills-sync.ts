/**
 * Single post-mutation pipeline for app-level skills. Called after ANY skill
 * write — whether the trigger was the agent bridge (app-tool) or the manager
 * UI. Keeps "what happens after a skill changes" in one place so the triggers
 * stay dumb. See .agent/features/app-level-capabilities.md.
 *
 * Step 4 (here): re-project onto this machine so a local agent picks the change
 * up next session. Step 6 will extend this to broadcast to active remote
 * connections (hash-gated) + notify the renderer.
 */
import { projectSkillsLocal } from './skills-projection';
import { getAppInstanceId } from './app-instance-id';

export function onSkillsChanged(): void {
  try {
    projectSkillsLocal(getAppInstanceId());
  } catch {
    /* best-effort — projection failure must not fail the mutation */
  }
}
