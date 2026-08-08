import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Workflow = {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
  };
  jobs?: Record<string, {
    needs?: string | string[];
    strategy?: {
      'max-parallel'?: number;
    };
    steps?: Array<{ run?: string }>;
  }>;
};

type Release = {
  id: number;
  tag_name: string;
  draft: boolean;
  html_url: string;
};

type ReleasePlan =
  | { kind: 'create' }
  | { kind: 'reuse'; release: Release }
  | { kind: 'error'; message: string };

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function loadReleasePlanner(): Promise<{
  planDraftRelease: (releases: Release[], tag: string) => ReleasePlan;
  draftReleasePayload: (tag: string) => {
    tag_name: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
  };
}> {
  const moduleUrl = new URL('../scripts/ensure-draft-release.mjs', import.meta.url).href;
  return import(/* @vite-ignore */ moduleUrl);
}

describe('release workflow draft gate', () => {
  it('creates or reuses one draft before any platform build starts', () => {
    const source = fs.readFileSync(`${repoRoot}/.github/workflows/build.yml`, 'utf8');
    const workflow = parseYaml(source) as Workflow;
    const createRelease = workflow.jobs?.create_release;

    expect(createRelease?.needs).toBe('test');
    expect(createRelease?.steps?.some((step) =>
      step.run?.includes('node scripts/ensure-draft-release.mjs'),
    )).toBe(true);
    expect(workflow.jobs?.build.needs).toBe('create_release');
  });

  it('serializes workflow runs for the same tag', () => {
    const source = fs.readFileSync(`${repoRoot}/.github/workflows/build.yml`, 'utf8');
    const workflow = parseYaml(source) as Workflow;

    expect(workflow.concurrency?.group).toContain('github.ref');
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('allows all platform builds to run in parallel after the draft gate', () => {
    const source = fs.readFileSync(`${repoRoot}/.github/workflows/build.yml`, 'utf8');
    const workflow = parseYaml(source) as Workflow;

    expect(workflow.jobs?.build.strategy?.['max-parallel']).toBeUndefined();
  });
});

describe('draft release planning', () => {
  it('creates drafts with an empty description', async () => {
    const { draftReleasePayload } = await loadReleasePlanner();

    expect(draftReleasePayload('v2.15.0')).toEqual({
      tag_name: 'v2.15.0',
      name: '2.15.0',
      body: '',
      draft: true,
      prerelease: false,
    });
  });

  it('creates a draft only when no release exists for the tag', async () => {
    const { planDraftRelease } = await loadReleasePlanner();
    expect(planDraftRelease([], 'v2.15.0')).toEqual({ kind: 'create' });
  });

  it('reuses the sole draft for the tag', async () => {
    const { planDraftRelease } = await loadReleasePlanner();
    const release: Release = {
      id: 42,
      tag_name: 'v2.15.0',
      draft: true,
      html_url: 'https://github.test/releases/42',
    };

    expect(planDraftRelease([release], 'v2.15.0')).toEqual({
      kind: 'reuse',
      release,
    });
  });

  it('fails loudly instead of choosing between duplicate releases', async () => {
    const { planDraftRelease } = await loadReleasePlanner();
    const releases: Release[] = [
      { id: 42, tag_name: 'v2.15.0', draft: true, html_url: 'https://github.test/releases/42' },
      { id: 43, tag_name: 'v2.15.0', draft: true, html_url: 'https://github.test/releases/43' },
    ];

    const plan = planDraftRelease(releases, 'v2.15.0');
    expect(plan.kind).toBe('error');
    expect(plan.kind === 'error' ? plan.message : '').toContain('42, 43');
  });

  it('does not mutate an already-published release', async () => {
    const { planDraftRelease } = await loadReleasePlanner();
    const published: Release = {
      id: 42,
      tag_name: 'v2.15.0',
      draft: false,
      html_url: 'https://github.test/releases/42',
    };

    const plan = planDraftRelease([published], 'v2.15.0');
    expect(plan.kind).toBe('error');
    expect(plan.kind === 'error' ? plan.message : '').toContain('already published');
  });
});
