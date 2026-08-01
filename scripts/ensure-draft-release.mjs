import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';

export function planDraftRelease(releases, tag) {
  const matching = releases.filter((release) => release.tag_name === tag);

  if (matching.length === 0) {
    return { kind: 'create' };
  }

  if (matching.length > 1) {
    const ids = matching.map((release) => release.id).join(', ');
    return {
      kind: 'error',
      message: `Found multiple releases for ${tag} (IDs: ${ids}); refusing to choose one automatically.`,
    };
  }

  const [release] = matching;
  if (!release.draft) {
    return {
      kind: 'error',
      message: `Release ${release.id} for ${tag} is already published; refusing to upload new build assets.`,
    };
  }

  return { kind: 'reuse', release };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;

  for (const link of linkHeader.split(',')) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }

  return null;
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'shelf-release-workflow',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }

  return response;
}

async function listReleases(apiUrl, repository, token) {
  const releases = [];
  let url = `${apiUrl}/repos/${repository}/releases?per_page=100`;

  while (url) {
    const response = await githubRequest(url, token);
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error('GitHub releases response was not an array');
    }
    releases.push(...page);
    url = nextPage(response.headers.get('link'));
  }

  return releases;
}

function readReleaseNotes(tag) {
  const notes = execFileSync(
    'git',
    ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`],
    { encoding: 'utf8' },
  ).trim();

  if (!notes) {
    throw new Error(`Tag ${tag} has no release notes`);
  }

  return notes;
}

async function createDraft(apiUrl, repository, token, tag) {
  const response = await githubRequest(`${apiUrl}/repos/${repository}/releases`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag.replace(/^v/, ''),
      body: readReleaseNotes(tag),
      draft: true,
      prerelease: false,
    }),
  });

  return response.json();
}

async function main() {
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const tag = requiredEnv('GITHUB_REF_NAME');
  const token = requiredEnv('GITHUB_TOKEN');
  const apiUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const releases = await listReleases(apiUrl, repository, token);
  const plan = planDraftRelease(releases, tag);

  if (plan.kind === 'error') throw new Error(plan.message);

  if (plan.kind === 'reuse') {
    console.log(`Reusing draft release ${plan.release.id}: ${plan.release.html_url}`);
    return;
  }

  const release = await createDraft(apiUrl, repository, token, tag);
  console.log(`Created draft release ${release.id}: ${release.html_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
