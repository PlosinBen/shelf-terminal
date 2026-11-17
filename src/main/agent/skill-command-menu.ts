import { SKILL_COMMAND_AVAILABILITY as A, type AppSkillCommandCapability, type SkillCommandMenu } from '@shared/skill-invocation';
import type { SkillCommandEntry } from '@shared/skill-commands';
import { skillCommandCatalogRevision } from './skill-invocations';

/** Session truth becomes provider-neutral presentation; no native paths cross IPC. */
export function buildSkillCommandMenu(entries: SkillCommandEntry[], nativeNames: ReadonlySet<string>, ready: boolean, capability?: AppSkillCommandCapability): SkillCommandMenu {
  const catalogRevision = skillCommandCatalogRevision(entries);
  return { entries: entries.map(entry => {
    const [availability, reason] = nativeNames.has(entry.command.alias) ? [A.CONFLICT, 'A native command owns this name']
      : entry.disabled ? [A.DISABLED, 'Skill is disabled']
      : !ready ? [A.PENDING, 'Agent session is initializing']
      : !capability?.available ? [A.UNAVAILABLE, capability?.reason ?? 'Native app skill invocation is not verified for this session']
      : [A.READY, undefined];
    return { name: entry.command.alias, description: entry.command.description, skillName: entry.skillName,
      selection: { registrationId: entry.command.registrationId, catalogRevision }, availability, ...(reason ? { reason } : {}) };
  }) };
}
