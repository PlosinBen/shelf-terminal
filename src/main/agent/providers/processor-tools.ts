export type ToolCategory = 'read' | 'exec' | 'write';

export interface ToolDef {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOLS: Record<string, ToolDef> = {
  Read: {
    name: 'Read',
    category: 'read',
    description: 'Read the contents of a file from the filesystem.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'integer', description: '1-indexed line to start from (optional)' },
        limit: { type: 'integer', description: 'Number of lines to read (optional)' },
      },
      required: ['file_path'],
    },
  },
  Grep: {
    name: 'Grep',
    category: 'read',
    description: 'Search file contents using a regular expression pattern (ripgrep-compatible).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'File or directory to search in' },
        glob: { type: 'string', description: 'Glob filter such as "*.ts"' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        case_insensitive: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  Glob: {
    name: 'Glob',
    category: 'read',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as "src/**/*.ts"' },
        path: { type: 'string', description: 'Base directory (defaults to cwd)' },
      },
      required: ['pattern'],
    },
  },
  Ls: {
    name: 'Ls',
    category: 'read',
    description: 'List the contents of a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: ['path'],
    },
  },
  Bash: {
    name: 'Bash',
    category: 'exec',
    description: 'Execute a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        description: { type: 'string', description: 'Short description of what the command does' },
      },
      required: ['command'],
    },
  },
  Edit: {
    name: 'Edit',
    category: 'write',
    description: 'Replace an exact string in a file with a new string.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  Write: {
    name: 'Write',
    category: 'write',
    description: 'Write content to a file, creating or overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
};

export function toolsForMode(mode: string): ToolDef[] {
  const all = Object.values(TOOLS);
  if (mode === 'plan') return all.filter((t) => t.category === 'read');
  return all;
}

export function toOpenAIFormat(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

export function shouldAllowAutomatically(mode: string, category: ToolCategory): boolean {
  if (mode === 'bypassPermissions') return true;
  if (mode === 'plan') return category === 'read';
  if (mode === 'acceptEdits') return category !== 'exec';
  return false;
}

export function shouldDenyAutomatically(mode: string, category: ToolCategory): boolean {
  if (mode === 'plan' && category !== 'read') return true;
  return false;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'ask',     description: 'Ask a one-off question without polluting history' },
  { name: 'clear',   description: 'Reset the conversation history' },
  { name: 'compact', description: 'Summarise old turns to free context window' },
  { name: 'context', description: 'Show token usage and context window' },
  { name: 'help',    description: 'List available slash commands' },
  { name: 'model',   description: 'Pick or switch the current model' },
  { name: 'status',  description: 'Summarise the session state' },
  { name: 'tools',   description: 'List tools available in the current mode' },
];

// Pattern-based detection of models that accept `reasoning_effort`.
// Mirrors Vercel AI SDK's approach in @ai-sdk/openai — OpenAI does not expose a
// capability flag, so we infer from the model id family.
// IMPORTANT: verify this list against OpenAI docs + Copilot /models output
// when OpenAI ships new model families (o4, o5, gpt-6, etc.).
export function getEffortLevels(modelId: string): string[] {
  if (/^gpt-5(?!-chat)/.test(modelId)) return ['minimal', 'low', 'medium', 'high'];
  if (/^o\d/.test(modelId)) return ['low', 'medium', 'high'];
  return [];
}

export function buildSystemPrompt(cwd: string, mode: string, projectInstructions?: string): string {
  const base = [
    'You are an AI coding assistant embedded in a terminal-based project manager.',
    `Working directory: ${cwd}`,
    'Use the provided tools to read, search, and modify the project. Prefer concrete file paths over guesses.',
    'Keep responses concise. When you finish a task, summarise what changed in one or two sentences.',
  ];

  if (projectInstructions && projectInstructions.trim().length > 0) {
    base.push('', '### Project instructions', projectInstructions.trim());
  }

  if (mode === 'plan') {
    base.push(
      '',
      'PLAN MODE: You are in plan mode. Do NOT execute shell commands or modify files.',
      'Use Read / Grep / Glob / Ls to explore, then output a concrete plan the user can approve.',
      'Never call Bash, Edit, or Write in this mode — those tools are not available to you.',
    );
  } else if (mode === 'acceptEdits') {
    base.push('', 'Edits to files will be applied automatically without asking. Shell commands still require confirmation.');
  } else if (mode === 'bypassPermissions') {
    base.push('', 'All tools run without confirmation. Be conservative with destructive operations.');
  }

  return base.join('\n');
}
