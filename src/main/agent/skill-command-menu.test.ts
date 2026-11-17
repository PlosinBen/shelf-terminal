import { expect, it } from 'vitest';
import { buildSkillCommandMenu } from './skill-command-menu';
import { SKILL_COMMAND_VERSION, type SkillCommandEntry } from '@shared/skill-commands';
import { SKILL_COMMAND_AVAILABILITY as A } from '@shared/skill-invocation';
const entries: SkillCommandEntry[] = [{ skillName: 'flow', disabled: false, command: { version: SKILL_COMMAND_VERSION, registrationId: 'ad1b0c23-6789-4123-8123-123456789abc', alias: 'dev-flow', description: 'Workflow' } }];
it('exposes neutral status and stable hints without native paths', () => {
  const ready = buildSkillCommandMenu(entries, new Set(), true, { available: true });
  expect(ready.entries[0]).toMatchObject({ availability: A.READY, name: 'dev-flow', selection: { registrationId: entries[0].command.registrationId, catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(buildSkillCommandMenu(entries, new Set(['dev-flow']), true, { available: true }).entries[0].availability).toBe(A.CONFLICT);
  expect(buildSkillCommandMenu([{ ...entries[0], disabled: true }], new Set(), true, { available: true }).entries[0].availability).toBe(A.DISABLED);
  expect(buildSkillCommandMenu(entries, new Set(), false).entries[0].availability).toBe(A.PENDING);
  expect(buildSkillCommandMenu(entries, new Set(), true).entries[0].availability).toBe(A.UNAVAILABLE);
});
