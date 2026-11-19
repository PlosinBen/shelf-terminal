/** Observe completion identity without copying arbitrary tool titles or payload text. */
export const COPILOT_COMPLETION_LOG_TAG = 'copilot-completion';
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keys = (value: unknown) => Object.keys(record(value)).slice(0, 40);
const identifiers = (value: unknown) => {
  const data = record(value);
  return Object.fromEntries(['toolName', 'tool_name', 'name'].flatMap(key =>
    typeof data[key] === 'string' && /^[a-zA-Z_][\w.-]{0,79}$/.test(data[key] as string)
      ? [[key, data[key]]] : []));
};

export function summarizeCompletionIdentity(value: unknown) {
  const data = record(value);
  const title = typeof data.title === 'string' ? data.title : undefined;
  return {
    updateType: data.sessionUpdate, toolCallId: data.toolCallId, kind: data.kind, status: data.status,
    // Ordinary titles may contain full commands or file content. Only the
    // completion-shaped title is needed to investigate this protocol drift.
    title: title && /^task[ _-]complet(?:e|ion)$/i.test(title) ? title : undefined,
    titleLength: title?.length,
    fields: keys(data), identifiers: identifiers(data),
    metaFields: keys(data._meta), metaIdentifiers: identifiers(data._meta),
    rawInputFields: keys(data.rawInput), rawOutputFields: keys(data.rawOutput),
  };
}
