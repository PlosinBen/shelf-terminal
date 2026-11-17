import { expect, it } from 'vitest';
import { mergeSlashCommands } from './slash-commands';
import { SKILL_COMMAND_AVAILABILITY as A } from '@shared/skill-invocation';
it('keeps native command and an unavailable app conflict as distinct menu rows', () => {
  const entry = { name: 'model', description: 'Workflow', skillName: 'flow', selection: { registrationId: 'id', catalogRevision: 'revision' }, availability: A.CONFLICT, reason: 'Native command owns this name' };
  const commands = mergeSlashCommands(null, [entry]);
  expect(commands.filter(command => command.name === 'model')).toHaveLength(2);
  expect(commands.find(command => command.shelf)?.shelf).toEqual(entry);
});
