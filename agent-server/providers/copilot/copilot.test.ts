import { describe, it, expect } from 'vitest';
import { quotaSnapshotToSegment, parseApplyPatch, formatCopilotToolInput, elicitationSchemaToPrompts, picksToElicitationContent, normalizeCopilotTask, isBackgroundedCopilotTask, buildCopilotAuthConfig, buildOrphanFinalizeMessages, type InflightToolUseEntry } from './helpers';

describe('buildCopilotAuthConfig (transitional gh-or-loggedInUser)', () => {
  it('uses gitHubToken + useLoggedInUser:false when a gh token is present', () => {
    expect(buildCopilotAuthConfig('gho_abc123')).toEqual({
      gitHubToken: 'gho_abc123',
      useLoggedInUser: false,
    });
  });

  it('falls back to useLoggedInUser:true when no gh token (undefined)', () => {
    expect(buildCopilotAuthConfig(undefined)).toEqual({ useLoggedInUser: true });
  });

  it('treats empty string as no token (falls back)', () => {
    expect(buildCopilotAuthConfig('')).toEqual({ useLoggedInUser: true });
  });
});

describe('quotaSnapshotToSegment', () => {
  it('renders premium quota at 100%', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toMatch(/^premium: 100%/);
  });

  // Regression: Copilot CLI derives `usedRequests` from
  // `entitlement * (1 - percent_remaining)` so it caps at entitlementRequests
  // and the real overage count lives in the separate `overage` field. Earlier
  // formula `usedRequests / entitlement` saturated at 100%; current formula
  // `(usedRequests + overage) / entitlement` surfaces real overage.
  it('shows overage above 100% by combining usedRequests + overage', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300, // capped at entitlement by the SDK
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 60, // real overage lives here
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toMatch(/^premium: 120%/);
  });

  // Pathological case from the field report: 255% utilisation needs to render
  // verbatim, not get clipped to 100%.
  it('renders extreme overage like 255% verbatim', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 100,
      usedRequests: 100,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 155,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^premium: 255%/);
  });

  it('marks exhausted quota with no overage permission as critical', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: false,
      overage: 0,
      overageAllowedWithExhaustedQuota: false,
    });
    expect(seg!.severity).toBe('critical');
  });

  it('returns null for unlimited entitlement', () => {
    const seg = quotaSnapshotToSegment('chat_interactions', {
      isUnlimitedEntitlement: true,
      entitlementRequests: 0,
      usedRequests: 12,
      remainingPercentage: 1,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).toBeNull();
  });

  it('falls back to remainingPercentage when entitlementRequests is 0', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 0,
      usedRequests: 0,
      remainingPercentage: 0.7,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^premium: 30%/);
  });

  it('uses raw key as label when no friendly mapping exists', () => {
    const seg = quotaSnapshotToSegment('mystery_quota', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 100,
      usedRequests: 50,
      remainingPercentage: 0.5,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^mystery_quota: 50%/);
  });
});

describe('parseApplyPatch', () => {
  it('parses single-hunk Update into a one-element array of oldString/newString', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/foo.md
@@
-# Old Title
+# New Title
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(1);
    expect(out![0].kind).toBe('update');
    expect(out![0].filePath).toBe('/tmp/foo.md');
    expect((out![0] as any).diff).toEqual({ oldString: '# Old Title', newString: '# New Title' });
  });

  it('preserves context lines on both sides of the diff', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/code.ts
@@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect((out![0] as any).diff.oldString).toBe('const a = 1;\nconst b = 2;\nconst c = 4;');
    expect((out![0] as any).diff.newString).toBe('const a = 1;\nconst b = 3;\nconst c = 4;');
  });

  it('parses Add into a one-element array with content', () => {
    const patch = `*** Begin Patch
*** Add File: /tmp/hello.txt
+hi
+there
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!).toHaveLength(1);
    expect(out![0].kind).toBe('add');
    expect(out![0].filePath).toBe('/tmp/hello.txt');
    expect((out![0] as any).content).toBe('hi\nthere');
  });

  it('parses multi-hunk Update into one entry per hunk with the same filePath', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/foo.ts
@@
-a
+b
@@
-c
+d
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!).toHaveLength(2);
    expect(out![0]).toEqual({ kind: 'update', filePath: '/tmp/foo.ts', diff: { oldString: 'a', newString: 'b' } });
    expect(out![1]).toEqual({ kind: 'update', filePath: '/tmp/foo.ts', diff: { oldString: 'c', newString: 'd' } });
  });

  it('parses multi-file patches into one entry per file', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/a.ts
@@
-x
+y
*** Update File: /tmp/b.ts
@@
-p
+q
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!).toHaveLength(2);
    expect(out![0].filePath).toBe('/tmp/a.ts');
    expect((out![0] as any).diff).toEqual({ oldString: 'x', newString: 'y' });
    expect(out![1].filePath).toBe('/tmp/b.ts');
    expect((out![1] as any).diff).toEqual({ oldString: 'p', newString: 'q' });
  });

  it('mixes Update and Add in a single patch', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/a.ts
@@
-x
+y
*** Add File: /tmp/new.ts
+hello
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!).toHaveLength(2);
    expect(out![0].kind).toBe('update');
    expect(out![1].kind).toBe('add');
    expect((out![1] as any).content).toBe('hello');
  });

  it('returns null for Delete operations (not yet supported by file_edit canonical type)', () => {
    const patch = `*** Begin Patch
*** Delete File: /tmp/gone.txt
*** End Patch
`;
    expect(parseApplyPatch(patch)).toBeNull();
  });

  it('returns null when Delete appears alongside other ops — whole patch falls back to tool_use', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/keep.ts
@@
-x
+y
*** Delete File: /tmp/gone.ts
*** End Patch
`;
    expect(parseApplyPatch(patch)).toBeNull();
  });

  it('returns null for missing Begin/End markers', () => {
    expect(parseApplyPatch('*** Update File: /tmp/x.ts\n-a\n+b')).toBeNull();
    expect(parseApplyPatch('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseApplyPatch(null as any)).toBeNull();
    expect(parseApplyPatch({} as any)).toBeNull();
  });
});

describe('formatCopilotToolInput', () => {
  const cwd = '/Users/me/proj';

  it('formats bash to bare command', () => {
    expect(formatCopilotToolInput('bash', { command: 'ls -la' }, cwd)).toBe('ls -la');
  });

  it('strips cwd from view path', () => {
    expect(formatCopilotToolInput('view', { path: '/Users/me/proj/src/foo.ts' }, cwd))
      .toBe('src/foo.ts');
  });

  it('formats grep with pattern + relative path', () => {
    expect(formatCopilotToolInput('grep', { pattern: 'TODO', path: '/Users/me/proj/src' }, cwd))
      .toBe('TODO in src');
  });

  it('formats glob with pattern only', () => {
    expect(formatCopilotToolInput('glob', { pattern: '**/*.ts' }, cwd))
      .toBe('**/*.ts');
  });

  it('formats task with agent_type + name + truncated prompt', () => {
    const out = formatCopilotToolInput('task', {
      agent_type: 'explore',
      name: 'find-foo',
      prompt: 'a'.repeat(200),
    }, cwd);
    expect(out).toContain('explore:');
    expect(out).toContain('find-foo');
    expect(out.length).toBeLessThan(180);
  });

  it('list_directory returns "." when path empty', () => {
    expect(formatCopilotToolInput('list_directory', {}, cwd)).toBe('.');
  });

  it('falls back to first string for unknown tool', () => {
    expect(formatCopilotToolInput('mystery_mcp', { count: 1, label: 'hi' }, cwd))
      .toBe('hi');
  });

  it('falls back to JSON when no string field', () => {
    expect(formatCopilotToolInput('mystery', { x: 1 }, cwd)).toContain('"x":1');
  });
});

describe('elicitationSchemaToPrompts', () => {
  it('returns null for malformed schema', () => {
    expect(elicitationSchemaToPrompts(null)).toBeNull();
    expect(elicitationSchemaToPrompts({ type: 'string' })).toBeNull();
    expect(elicitationSchemaToPrompts({ type: 'object', properties: {} })).toBeNull();
  });

  it('maps string + enum to single-select options', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        role: { type: 'string', title: 'Role', description: 'Pick role', enum: ['admin', 'user'] },
      },
    })!;
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toEqual({
      question: 'Pick role',
      header: 'Role',
      multiSelect: false,
      options: [
        { label: 'admin', description: undefined },
        { label: 'user', description: undefined },
      ],
      inputType: undefined,
      currentValue: undefined,
    });
    expect(result.fields[0].key).toBe('role');
  });

  it('maps string + enumNames to options with const stored as description', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        env: { type: 'string', enum: ['p', 's'], enumNames: ['Production', 'Staging'] },
      },
    })!;
    expect(result.prompts[0].options).toEqual([
      { label: 'Production', description: 'p' },
      { label: 'Staging', description: 's' },
    ]);
  });

  it('maps array + items.enum to multi-select', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          description: 'Pick regions',
          items: { type: 'string', enum: ['us', 'eu', 'asia'] },
          default: ['us'],
        },
      },
    })!;
    expect(result.prompts[0].multiSelect).toBe(true);
    expect(result.prompts[0].options).toEqual([{ label: 'us' }, { label: 'eu' }, { label: 'asia' }]);
    expect(result.prompts[0].currentValue).toEqual(['us']);
  });

  it('maps boolean to Yes/No options with default', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        autoscale: { type: 'boolean', default: true },
      },
    })!;
    expect(result.prompts[0]).toMatchObject({
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No' }],
      currentValue: 'Yes',
    });
  });

  it('maps integer to free-text input with inputType', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        replicas: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      },
    })!;
    expect(result.prompts[0]).toMatchObject({
      options: [],
      inputType: 'integer',
      currentValue: '3',
    });
  });

  it('maps multi-field schemas preserving property order', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 50 },
        role: { type: 'string', enum: ['a', 'b'] },
        count: { type: 'integer' },
      },
    })!;
    expect(result.prompts).toHaveLength(3);
    expect(result.fields.map((f) => f.key)).toEqual(['name', 'role', 'count']);
    expect(result.prompts[0].inputType).toBe('text');     // plain string
    expect(result.prompts[1].inputType).toBeUndefined();  // enum
    expect(result.prompts[2].inputType).toBe('integer');
  });

  it('clips long title to 12-char header (chip convention)', () => {
    const result = elicitationSchemaToPrompts({
      type: 'object',
      properties: {
        x: { type: 'boolean', title: 'This is a very long title' },
      },
    })!;
    expect(result.prompts[0].header).toBe('This is a ve');
    expect(result.prompts[0].header!.length).toBe(12);
  });
});

describe('picksToElicitationContent', () => {
  it('boolean Yes → true, anything else → false', () => {
    const fields = [{ key: 'autoscale', field: { type: 'boolean' } }];
    expect(picksToElicitationContent(fields, ['Yes'])).toEqual({ autoscale: true });
    expect(picksToElicitationContent(fields, ['No'])).toEqual({ autoscale: false });
  });

  it('integer parses to number, falls through string on parse fail', () => {
    const fields = [{ key: 'count', field: { type: 'integer' } }];
    expect(picksToElicitationContent(fields, ['42'])).toEqual({ count: 42 });
    expect(picksToElicitationContent(fields, ['abc'])).toEqual({ count: 'abc' });
  });

  it('number parses to float', () => {
    const fields = [{ key: 'rate', field: { type: 'number' } }];
    expect(picksToElicitationContent(fields, ['1.5'])).toEqual({ rate: 1.5 });
  });

  it('array enumNames label reverses back to const value', () => {
    const fields = [{
      key: 'env',
      field: { type: 'array', items: { type: 'string', enum: ['p', 's'], enumNames: ['Prod', 'Stage'] } },
    }];
    const out = picksToElicitationContent(fields, [['Prod', 'Stage']]);
    expect(out).toEqual({ env: ['p', 's'] });
  });

  it('string enumNames label reverses back to const value', () => {
    const fields = [{
      key: 'role',
      field: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] },
    }];
    expect(picksToElicitationContent(fields, ['Beta'])).toEqual({ role: 'b' });
  });

  it('plain string field passes through', () => {
    const fields = [{ key: 'name', field: { type: 'string' } }];
    expect(picksToElicitationContent(fields, ['Alice'])).toEqual({ name: 'Alice' });
  });

  it('multi-field content keyed by property order', () => {
    const fields = [
      { key: 'name', field: { type: 'string' } },
      { key: 'count', field: { type: 'integer' } },
      { key: 'enabled', field: { type: 'boolean' } },
    ];
    expect(picksToElicitationContent(fields, ['Alice', '3', 'Yes'])).toEqual({
      name: 'Alice', count: 3, enabled: true,
    });
  });
});

describe('normalizeCopilotTask', () => {
  // Shapes per copilot SDK rpc.d.ts (TaskAgentInfo | TaskShellInfo).
  it('maps a backgrounded shell task → shell NormalizedTask with command', () => {
    expect(normalizeCopilotTask({
      type: 'shell', id: 's1', description: 'run build', status: 'running',
      command: 'npm run build', attachmentMode: 'detached', executionMode: 'background',
    })).toEqual({
      id: 's1', type: 'shell', label: 'run build', status: 'running', command: 'npm run build', error: undefined, done: false,
    });
  });

  it('maps an agent task → agent NormalizedTask (no command)', () => {
    const out = normalizeCopilotTask({ type: 'agent', id: 'a1', description: 'research', status: 'completed', agentType: 'explore' });
    expect(out).toMatchObject({ id: 'a1', type: 'agent', label: 'research', status: 'completed', done: true });
    expect(out?.command).toBeUndefined();
  });

  it('maps copilot-only statuses: idle→running, cancelled→stopped', () => {
    expect(normalizeCopilotTask({ type: 'shell', id: 's', description: 'x', status: 'idle' }))
      .toMatchObject({ status: 'running', done: false });
    expect(normalizeCopilotTask({ type: 'shell', id: 's', description: 'x', status: 'cancelled' }))
      .toMatchObject({ status: 'stopped', done: true });
  });

  it('carries error + collapses unknown type', () => {
    expect(normalizeCopilotTask({ type: 'agent', id: 'a', description: 'x', status: 'failed', error: 'boom' }))
      .toMatchObject({ status: 'failed', error: 'boom', done: true });
    expect(normalizeCopilotTask({ type: 'mystery', id: 'm', description: 'x', status: 'running' })?.type).toBe('unknown');
  });

  it('returns null for malformed input', () => {
    expect(normalizeCopilotTask(null)).toBeNull();
    expect(normalizeCopilotTask({ type: 'shell' })).toBeNull(); // no id
  });

  it('isBackgroundedCopilotTask only true for executionMode background', () => {
    expect(isBackgroundedCopilotTask({ executionMode: 'background' })).toBe(true);
    expect(isBackgroundedCopilotTask({ executionMode: 'sync' })).toBe(false);
    expect(isBackgroundedCopilotTask({})).toBe(false);
  });
});

describe('buildOrphanFinalizeMessages', () => {
  const ERR = 'Tool did not complete — the turn ended while it was still running (it may have hung).';

  // Regression (the rg/grep forever-spinner): a tool whose tool.execution_complete
  // never arrived must be finalized as a terminal error card with the SAME msgId,
  // so the renderer upserts the running card instead of leaving it spinning.
  it('finalizes a generic tool_use orphan as an errored fold_code on the same msgId', () => {
    const entries: Array<[string, InflightToolUseEntry]> = [
      ['call_rg1', { kind: 'tool_use', toolName: 'rg', input: 'process.env' }],
    ];
    expect(buildOrphanFinalizeMessages(entries, '/repo', ERR)).toEqual([
      { msgId: 'call_rg1', msgType: 'fold_code', label: 'rg', subtitle: 'process.env', errorMessage: ERR },
    ]);
  });

  it('returns an empty array when nothing is in flight (the common case)', () => {
    expect(buildOrphanFinalizeMessages([], '/repo', ERR)).toEqual([]);
  });

  it('finalizes each apply_patch sub-card (update→fold_diff, add→fold_code) with cwd-stripped subtitles', () => {
    const entries: Array<[string, InflightToolUseEntry]> = [
      ['call_patch', { kind: 'apply_patch', subs: [
        { msgId: 'call_patch:f0', spec: { kind: 'update', filePath: '/repo/a.ts', diff: { oldString: 'x', newString: 'y' } } },
        { msgId: 'call_patch:f1', spec: { kind: 'add', filePath: '/repo/b.ts', content: 'new' } },
      ] }],
    ];
    expect(buildOrphanFinalizeMessages(entries, '/repo', ERR)).toEqual([
      { msgId: 'call_patch:f0', msgType: 'fold_diff', label: 'Edit', subtitle: 'a.ts', errorMessage: ERR },
      { msgId: 'call_patch:f1', msgType: 'fold_code', label: 'Add', subtitle: 'b.ts', errorMessage: ERR },
    ]);
  });

  it('finalizes a file_edit orphan (diff→Edit/fold_diff, content-only→Write/fold_code)', () => {
    const entries: Array<[string, InflightToolUseEntry]> = [
      ['call_edit', { kind: 'file_edit', filePath: '/repo/c.ts', diff: { oldString: 'a', newString: 'b' } }],
      ['call_write', { kind: 'file_edit', filePath: '/repo/d.ts', content: 'hello' }],
    ];
    expect(buildOrphanFinalizeMessages(entries, '/repo', ERR)).toEqual([
      { msgId: 'call_edit', msgType: 'fold_diff', label: 'Edit', subtitle: 'c.ts', errorMessage: ERR },
      { msgId: 'call_write', msgType: 'fold_code', label: 'Write', subtitle: 'd.ts', errorMessage: ERR },
    ]);
  });
});
