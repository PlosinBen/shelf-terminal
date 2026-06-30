import { useEffect, useState, useCallback } from 'react';
import type { McpServerBlock, McpStdioBlock, McpHttpBlock } from '@shared/mcp';

// Settings → MCP: manage app-level MCP servers (set once → every project, both
// agents, run on whichever machine the agent runs on). Additive on top of the
// agent's native config — see features/app-level-mcps.

type Transport = 'stdio' | 'http';

interface FormState {
  /** null = adding a new server; otherwise the name being edited (for rename). */
  originalName: string | null;
  name: string;
  type: Transport;
  command: string;
  args: string;    // one per line
  env: string;     // KEY=value per line
  url: string;
  headers: string; // KEY=value per line
}

const EMPTY_FORM: FormState = {
  originalName: null, name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '',
};

function parseLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}
function parseKeyVals(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}
function stringifyKeyVals(map: Record<string, string> | undefined): string {
  return map ? Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n') : '';
}

function formToBlock(f: FormState): McpServerBlock | { error: string } {
  if (f.type === 'stdio') {
    if (!f.command.trim()) return { error: 'Command is required for a stdio server' };
    const block: McpStdioBlock = { type: 'stdio', command: f.command.trim() };
    const args = parseLines(f.args);
    if (args.length) block.args = args;
    const env = parseKeyVals(f.env);
    if (Object.keys(env).length) block.env = env;
    return block;
  }
  if (!f.url.trim()) return { error: 'URL is required for an http server' };
  const block: McpHttpBlock = { type: 'http', url: f.url.trim() };
  const headers = parseKeyVals(f.headers);
  if (Object.keys(headers).length) block.headers = headers;
  return block;
}

function blockToForm(name: string, block: McpServerBlock): FormState {
  if (block.type === 'stdio') {
    return {
      originalName: name, name, type: 'stdio',
      command: block.command, args: (block.args ?? []).join('\n'), env: stringifyKeyVals(block.env),
      url: '', headers: '',
    };
  }
  return {
    originalName: name, name, type: 'http',
    command: '', args: '', env: '',
    url: block.url, headers: stringifyKeyVals(block.headers),
  };
}

function summary(block: McpServerBlock): string {
  return block.type === 'stdio'
    ? [block.command, ...(block.args ?? [])].join(' ')
    : block.url;
}

export function McpSettingsTab() {
  const [servers, setServers] = useState<Record<string, McpServerBlock> | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const refresh = useCallback(() => {
    window.shelfApi.mcp.list().then(setServers).catch(() => setServers({}));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => window.shelfApi.mcp.onChanged(refresh), [refresh]);

  const startAdd = () => { setError(null); setForm({ ...EMPTY_FORM }); };
  const startEdit = (name: string, block: McpServerBlock) => { setError(null); setForm(blockToForm(name, block)); };
  const cancel = () => { setForm(null); setError(null); };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) { setError('Server name is required'); return; }
    const block = formToBlock(form);
    if ('error' in block) { setError(block.error); return; }
    const res = form.originalName == null
      ? await window.shelfApi.mcp.add(form.name.trim(), block)
      : await window.shelfApi.mcp.update(form.originalName, block, form.name.trim() !== form.originalName ? form.name.trim() : undefined);
    if (!res.ok) { setError(res.error ?? 'Save failed'); return; }
    setForm(null);
    refresh();
  };

  const remove = async (name: string) => {
    await window.shelfApi.mcp.remove(name);
    refresh();
  };

  const entries = Object.entries(servers ?? {});
  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="web-settings">
      <h3 className="web-settings-title">
        MCP servers
        <button className="mcp-help-btn" onClick={() => setShowHelp((v) => !v)} title="What is this?">?</button>
      </h3>
      <p className="web-settings-hint">
        External MCP servers the agent can use — set once, applies to every project and both agents (Claude &amp; Copilot).
      </p>
      {showHelp && (
        <p className="web-settings-hint mcp-help">
          These run on <strong>whichever machine the agent runs on</strong> (local, or your SSH/Docker/WSL worker) — the
          command and any env vars must exist <strong>there</strong>. Env/header values may reference environment
          variables as <code>{'${VAR}'}</code> (resolved on the worker — recommended over pasting literal secrets). This
          config is <strong>additive</strong> on top of the agent's native MCP, not a replacement.
        </p>
      )}

      {servers === null ? (
        <p className="web-settings-hint">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="web-settings-hint">No MCP servers configured.</p>
      ) : (
        <ul className="web-list">
          {entries.map(([name, block]) => (
            <li key={name} className="web-list-item">
              <span className="web-list-main">{name}</span>
              <span className="mcp-list-type">{block.type}</span>
              <span className="web-list-sub mcp-list-summary">{summary(block)}</span>
              <button className="web-list-action" onClick={() => startEdit(name, block)}>Edit</button>
              <button className="web-list-action" onClick={() => void remove(name)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      {form === null ? (
        <button className="mcp-add-btn" onClick={startAdd}>+ Add server</button>
      ) : (
        <div className="mcp-form">
          <div className="mcp-form-row">
            <label>Name</label>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="github" />
          </div>
          <div className="mcp-form-row">
            <label>Transport</label>
            <select value={form.type} onChange={(e) => set({ type: e.target.value as Transport })}>
              <option value="stdio">stdio (local process)</option>
              <option value="http">http (remote URL)</option>
            </select>
          </div>
          {form.type === 'stdio' ? (
            <>
              <div className="mcp-form-row">
                <label>Command</label>
                <input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
              </div>
              <div className="mcp-form-row">
                <label>Args <span className="mcp-form-hint">one per line</span></label>
                <textarea value={form.args} onChange={(e) => set({ args: e.target.value })} rows={3} placeholder={'-y\n@modelcontextprotocol/server-everything'} />
              </div>
              <div className="mcp-form-row">
                <label>Env <span className="mcp-form-hint">KEY=value per line; {'${VAR}'} allowed</span></label>
                <textarea value={form.env} onChange={(e) => set({ env: e.target.value })} rows={2} placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}'} />
              </div>
            </>
          ) : (
            <>
              <div className="mcp-form-row">
                <label>URL</label>
                <input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" />
              </div>
              <div className="mcp-form-row">
                <label>Headers <span className="mcp-form-hint">KEY=value per line; {'${VAR}'} allowed</span></label>
                <textarea value={form.headers} onChange={(e) => set({ headers: e.target.value })} rows={2} placeholder={'Authorization=Bearer ${API_TOKEN}'} />
              </div>
            </>
          )}
          {error && <p className="mcp-form-error">{error}</p>}
          <div className="mcp-form-actions">
            <button className="mcp-form-save" onClick={() => void save()}>Save</button>
            <button className="mcp-form-cancel" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
