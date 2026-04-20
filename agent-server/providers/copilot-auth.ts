import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

const EDITOR_VERSION = 'GithubCLI/2.60.0';
const EDITOR_PLUGIN_VERSION = 'github-copilot-cli/1.0.5';
const USER_AGENT = 'GitHubCopilotChat/0.26.7';

export const COPILOT_DEFAULT_HEADERS: Record<string, string> = {
  'Editor-Version': EDITOR_VERSION,
  'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': USER_AGENT,
};

interface SessionToken {
  token: string;
  expiresAt: number;
  apiEndpoint: string;
}

let memGithubToken: string | null = null;
let memSessionToken: SessionToken | null = null;

function tryGhCli(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      const token = out.trim();
      if (code === 0 && token) resolve(token);
      else resolve(null);
    });
  });
}

function tryCopilotHostsFile(): string[] {
  const tokens: string[] = [];
  const candidates = [
    path.join(os.homedir(), '.config', 'github-copilot', 'apps.json'),
    path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      for (const key of Object.keys(data)) {
        const entry = data[key];
        const token = entry?.oauth_token ?? entry?.token;
        if (typeof token === 'string' && token.length > 0 && !tokens.includes(token)) {
          tokens.push(token);
        }
      }
    } catch {
      // missing or invalid — try next
    }
  }
  return tokens;
}

async function fetchSessionToken(githubToken: string): Promise<SessionToken> {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/json',
      'Editor-Version': EDITOR_VERSION,
      'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Copilot token exchange ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return {
    token: data.token,
    expiresAt: data.expires_at,
    apiEndpoint: data.endpoints?.api ?? 'https://api.githubcopilot.com',
  };
}

async function resolveAndValidate(): Promise<SessionToken | null> {
  const now = Math.floor(Date.now() / 1000);
  if (memGithubToken && memSessionToken && memSessionToken.expiresAt - now > 60) {
    return memSessionToken;
  }

  const candidates: string[] = [];
  for (const t of tryCopilotHostsFile()) {
    if (!candidates.includes(t)) candidates.push(t);
  }
  const gh = await tryGhCli();
  if (gh && !candidates.includes(gh)) candidates.push(gh);

  for (const token of candidates) {
    try {
      const session = await fetchSessionToken(token);
      memGithubToken = token;
      memSessionToken = session;
      return session;
    } catch {
      // try next token
    }
  }

  memGithubToken = null;
  memSessionToken = null;
  return null;
}

export async function getCopilotSessionToken(): Promise<SessionToken> {
  const session = await resolveAndValidate();
  if (!session) throw new Error('NO_AUTH');
  return session;
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    await getCopilotSessionToken();
    return true;
  } catch {
    return false;
  }
}
