import fs from 'fs';
import path from 'path';
import os from 'os';
import { expect, it, vi } from 'vitest';
import { createSendQueue } from '../../../agent-server/send-queue';
import { createSkillInvocationClient } from '../../../agent-server/skill-invocation-client';
import { createAgentInputMessage, AGENT_INPUT_SOURCE } from '@shared/agent-input';
import { SKILL_COMMAND_ERROR as E } from '@shared/skill-invocation';
let root: string;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
const { createSkillInvocationRegistry } = await import('./skill-invocations');
const { createSkillCommandStore } = await import('../skill-commands');
const { skillsCollectionDir, skillDirPath, setSkillDisabled } = await import('../skills-store');
it.each([false, true])('revalidates only after dequeue, settles failure, and keeps the queue moving (disabled=%s)', async disabled => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-command-queue-'));
  const directory = skillDirPath('flow'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: flow\ndescription: test\n---\nworkflow');
  const registry = createSkillInvocationRegistry(skillsCollectionDir); const owner = {};
  const command = createSkillCommandStore({ collectionDirectory: skillsCollectionDir, reservedAliases: new Set() });
  await command.save('flow', { alias: 'dev-flow', description: 'Run flow' });
  const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content: '/dev-flow task' });
  if (!built.ok) throw Error(built.error);
  const invocation = (await registry.prepare(owner, built.message, new Set()))!;
  registry.attach(owner, invocation, built.message.msgId, 'selected');
  const requested = vi.fn(); const dispatch = vi.fn(); const idle = vi.fn(); const failed = vi.fn();
  const client = createSkillInvocationClient(request => {
    requested(request);
    void registry.validate(owner, request).then(result => client.receive({ ...result, requestId: request.requestId, executionId: request.executionId, msgId: request.msgId, bindingId: invocation.bindingId }));
  }, vi.fn());
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const queue = createSendQueue<{ executionId: string; clientMsgId: string }>({
    handle: async message => {
      if (message.executionId === 'blocker') { await blocker; return; }
      if (message.executionId === 'selected') {
        await client.validate({ executionId: message.executionId, msgId: message.clientMsgId, invocation });
        dispatch(invocation);
      }
      idle(message.executionId);
    },
    emitSnapshot: vi.fn(), terminateExecution: idle,
    onHandleError: (message, error) => { failed(error); idle(message.executionId); },
  });
  try {
    queue.enqueue({ executionId: 'blocker', clientMsgId: 'blocker-msg' });
    queue.enqueue({ executionId: 'selected', clientMsgId: built.message.msgId });
    queue.enqueue({ executionId: 'after', clientMsgId: 'after-msg' });
    expect(requested).not.toHaveBeenCalled();
    if (disabled) await setSkillDisabled('flow', true);
    release();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledWith('after'));
    expect(requested).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(disabled ? 0 : 1);
    if (disabled) expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: E.DISABLED }));
    expect(queue.snapshot()).toEqual([]);
  } finally { release(); client.close(); registry.close(owner); fs.rmSync(root, { recursive: true, force: true }); }
});
