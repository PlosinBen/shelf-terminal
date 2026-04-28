import type { TabInferredState, TabScanResult } from '@shared/types';
import * as scrollback from './scrollback-buffer';
import { readNote, writeNote, readGlobalNote, writeGlobalNote } from './note-store';
import { isAwayMode } from './away-mode';
import { checkRedline } from './redline';

// ── Synced state from renderer ──

interface SyncedTab {
  id: string;
  label: string;
}

interface SyncedProject {
  id: string;
  name: string;
  cwd: string;
  connectionType: string;
  tabs: SyncedTab[];
}

let syncedProjects: SyncedProject[] = [];

export function updateSyncedState(projects: SyncedProject[]): void {
  syncedProjects = projects;
}

// ── Tool schemas (OpenAI function-calling format) ──

export const toolSchemas = [
  {
    type: 'function' as const,
    function: {
      name: 'list_projects',
      description: 'List all projects with basic info (name, connection type, cwd, tab count)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_project',
      description: 'Get detailed info for a single project including all tabs',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project ID' } },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_tabs',
      description: 'List all tabs for a project',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project ID' } },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_scrollback',
      description: 'Read the last N lines of terminal output from a tab (ANSI-stripped)',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID' },
          lines: { type: 'number', description: 'Number of lines to read (default 50)' },
        },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scan_all_tabs',
      description: 'Scan all tabs across all projects. Returns last ~20 lines and inferred state for each tab.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_project_note',
      description: 'Read the PM rolling summary note for a project',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project ID' } },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_project_note',
      description: 'Overwrite the PM rolling summary note for a project. Follow the rolling summary format: Active / Recently done / Open loops / Context hints. Keep under ~300 words.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          content: { type: 'string', description: 'Markdown content (rolling summary format)' },
        },
        required: ['projectId', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_global_note',
      description: 'Read the PM global note — cross-project memory storing user preferences, work conventions, and inter-project relationships. Read this at the start of every new conversation.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_global_note',
      description: 'Overwrite the PM global note. Write when you learn something new about user preferences, work conventions, or cross-project relationships. Keep under ~200 words.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown content' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_to_pty',
      description: 'Send data to a terminal tab (Away Mode only). Use for: sending prompts to CLI agents, approving/denying permission prompts (y/n), or interrupting with ESC/Ctrl+C. NEVER use on idle_shell tabs.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID' },
          data: { type: 'string', description: 'Data to send (text, \\x1b for ESC, \\x03 for Ctrl+C)' },
        },
        required: ['tabId', 'data'],
      },
    },
  },
];

// ── write_to_pty callback (injected from main/index.ts) ──

let writePtyFn: ((tabId: string, data: string) => void) | null = null;

export function setWritePtyFn(fn: (tabId: string, data: string) => void): void {
  writePtyFn = fn;
}

// ── Tool schemas filtered by Away Mode ──

export function getActiveToolSchemas(): typeof toolSchemas {
  if (isAwayMode()) return toolSchemas;
  return toolSchemas.filter((t) => t.function.name !== 'write_to_pty');
}

// ── Tool execution ──

export function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_projects':
      return JSON.stringify(
        syncedProjects.map((p) => ({
          id: p.id,
          name: p.name,
          cwd: p.cwd,
          connectionType: p.connectionType,
          tabCount: p.tabs.length,
        })),
      );

    case 'get_project': {
      const proj = syncedProjects.find((p) => p.id === args.projectId);
      if (!proj) return JSON.stringify({ error: 'Project not found' });
      return JSON.stringify(proj);
    }

    case 'list_tabs': {
      const proj = syncedProjects.find((p) => p.id === args.projectId);
      if (!proj) return JSON.stringify({ error: 'Project not found' });
      return JSON.stringify(
        proj.tabs.map((t) => ({
          id: t.id,
          label: t.label,
          hasScrollback: scrollback.has(t.id),
        })),
      );
    }

    case 'read_scrollback': {
      const tabId = args.tabId as string;
      const lines = (args.lines as number) ?? 50;
      if (!scrollback.has(tabId)) return JSON.stringify({ error: 'Tab not found or no output yet' });
      return scrollback.read(tabId, lines);
    }

    case 'scan_all_tabs': {
      const results: TabScanResult[] = [];
      for (const proj of syncedProjects) {
        for (const tab of proj.tabs) {
          const lastLines = scrollback.has(tab.id) ? scrollback.read(tab.id, 20) : '';
          results.push({
            projectId: proj.id,
            projectName: proj.name,
            tabId: tab.id,
            tabName: tab.label,
            lastLines,
            inferredState: inferTabState(lastLines),
          });
        }
      }
      return JSON.stringify(results);
    }

    case 'read_project_note': {
      const content = readNote(args.projectId as string);
      return content || '(empty note)';
    }

    case 'write_project_note': {
      writeNote(args.projectId as string, args.content as string);
      return 'Note saved.';
    }

    case 'read_global_note': {
      const content = readGlobalNote();
      return content || '(empty note)';
    }

    case 'write_global_note': {
      writeGlobalNote(args.content as string);
      return 'Global note saved.';
    }

    case 'write_to_pty': {
      if (!isAwayMode()) return JSON.stringify({ error: 'Away Mode is OFF — cannot write to terminal' });
      const tabId = args.tabId as string;
      if (!scrollback.has(tabId)) return JSON.stringify({ error: 'Tab not found' });

      // Block writes to idle_shell tabs
      const state = inferTabState(scrollback.read(tabId, 20));
      if (state === 'idle_shell') {
        return JSON.stringify({ error: 'Tab is idle_shell — refusing to write to raw shell. Only write to tabs running CLI agents.' });
      }

      // Redline check
      const redline = checkRedline(tabId);
      if (redline.blocked) {
        return JSON.stringify({
          error: 'REDLINE BLOCKED',
          pattern: redline.pattern,
          snippet: redline.snippet,
          action: 'Escalate to user instead of approving.',
        });
      }

      // Unescape control characters
      const data = (args.data as string)
        .replace(/\\x1b/g, '\x1b')
        .replace(/\\x03/g, '\x03')
        .replace(/\\n/g, '\n');

      if (!writePtyFn) return JSON.stringify({ error: 'write_to_pty not wired up' });
      writePtyFn(tabId, data);
      return 'Sent.';
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Heuristic state inference ──

const SHELL_PROMPT_RE = /[$%#>]\s*$/;
const PERMISSION_RE = /\b(Allow|approve|Approve|y\/n|Y\/n|permission|Do you want to proceed|accept)\b/i;
const ERROR_RE = /(Error:|error:|FAIL|FAILED|panic:|Traceback|command not found|No such file|ENOENT)/;
const DONE_RE = /\b(Done|Completed|finished|Successfully|All tasks completed)\b/i;

export function inferTabState(text: string): TabInferredState {
  if (!text.trim()) return 'idle_shell';

  const lines = text.split('\n').filter((l) => l.trim());
  const lastFew = lines.slice(-5);
  const lastLine = lastFew[lastFew.length - 1] ?? '';

  // Check permission first (most specific)
  for (const line of lastFew) {
    if (PERMISSION_RE.test(line)) return 'cli_waiting_permission';
  }

  // Check errors
  for (const line of lastFew) {
    if (ERROR_RE.test(line)) return 'cli_error';
  }

  // Check if back to shell prompt
  if (SHELL_PROMPT_RE.test(lastLine)) return 'idle_shell';

  // Check done patterns
  for (const line of lastFew) {
    if (DONE_RE.test(line)) return 'cli_done';
  }

  // TUI-based CLIs (Claude Code, etc.) render ❯ as input prompt; status
  // bar text below it may push ❯ off the very last line, so scan lastFew.
  for (const line of lastFew) {
    if (/❯\s*$/.test(line)) return 'idle_shell';
  }

  // Check waiting for input (ends with ? or > but not a shell prompt)
  if (/[?:>]\s*$/.test(lastLine) && !SHELL_PROMPT_RE.test(lastLine)) {
    return 'cli_waiting_input';
  }

  return 'cli_running';
}
