/** Diagnostic summaries only: no command, file content, result text or auth data. */
export const FILE_TOOL_LOG_TAG = { CLAUDE: 'claude-file-tool', COPILOT: 'copilot-file-tool' } as const;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const shape = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const textLength = (value: unknown) => typeof value === 'string' ? value.length : undefined;
const filePaths = (value: unknown) => {
  const data = object(value);
  return Object.fromEntries(['file_path', 'filePath', 'path', 'move_path']
    .filter(key => typeof data[key] === 'string').map(key => [key, data[key]]));
};

export function summarizeFileToolData(value: unknown) {
  const data = object(value);
  return {
    shape: shape(value), paths: filePaths(data),
    sourceShape: shape(data.source), destinationShape: shape(data.destination),
    operation: ['create', 'update', 'add', 'delete', 'move'].includes(String(data.type)) ? data.type : undefined,
    contentLength: textLength(data.content),
    originalFileShape: shape(data.originalFile), originalFileLength: textLength(data.originalFile),
    patchCount: Array.isArray(data.structuredPatch) ? data.structuredPatch.length : undefined,
  };
}

export function summarizeAcpFileTool(update: unknown) {
  const data = object(update);
  const blocks = Array.isArray(data.content) ? data.content.map(object) : [];
  const locations = Array.isArray(data.locations) ? data.locations.map(object) : [];
  return {
    toolCallId: data.toolCallId, updateType: data.sessionUpdate, kind: data.kind, status: data.status,
    locations: locations.slice(0, 20).map(filePaths), locationCount: locations.length,
    diffs: blocks.filter(block => block.type === 'diff').slice(0, 20).map(block => ({
      paths: filePaths(block), oldTextShape: shape(block.oldText), oldTextLength: textLength(block.oldText),
      newTextShape: shape(block.newText), newTextLength: textLength(block.newText),
    })),
    diffCount: blocks.filter(block => block.type === 'diff').length,
    rawInput: summarizeFileToolData(data.rawInput), rawOutput: summarizeFileToolData(data.rawOutput),
  };
}
