export type SkillMutationGuard = () => void | Promise<void>;

let tail: Promise<unknown> = Promise.resolve();

/** Serialize source mutations and snapshots; never hold this while doing remote work. */
export function withSkillsMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = tail.then(operation);
  tail = result.catch(() => undefined);
  return result;
}

// Content/identity mutations invalidate queued bindings even if bytes are later restored.
const invocationRevisions = new Map<string, number>();
export function invalidateSkillInvocations(name: string): void {
  invocationRevisions.set(name, skillInvocationRevision(name) + 1);
}
export function skillInvocationRevision(name: string): number { return invocationRevisions.get(name) ?? 0; }
