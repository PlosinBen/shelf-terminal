import { describe, expect, it, vi } from 'vitest';
import { openLink } from './link-open-intent';

const source = { kind: 'project-tab' as const, projectId: 'p', tabId: 'v' };
const dependencies = () => ({ external: vi.fn(), web: vi.fn(), file: vi.fn() });

describe('link opening destinations', () => {
  it('opens PM replies in their captured destination and retains app source identity', async () => {
    const deps = dependencies();
    expect(await openLink({ url: 'https://example.com/pm', source: { kind: 'pm-reply' }, reason: 'Link', destinationProjectId: 'click-project' }, deps))
      .toEqual({ kind: 'web', projectId: 'click-project', url: 'https://example.com/pm' });
    expect(deps.web).toHaveBeenCalledWith('click-project', 'https://example.com/pm');
    expect(deps.external).not.toHaveBeenCalled();
  });
  it('requires PM destination and never interprets it as a file source', async () => {
    const deps = dependencies();
    await expect(openLink({ url: 'https://example.com', source: { kind: 'pm-reply' }, reason: 'Link' }, deps)).rejects.toThrow('destination project');
    await expect(openLink({ url: './secret.txt', source: { kind: 'pm-reply' }, reason: 'Link', destinationProjectId: 'p' }, deps)).rejects.toThrow('source project');
    expect(deps.file).not.toHaveBeenCalled();
  });
  it('opens Skills web links in the captured destination without fabricating project ownership', async () => {
    const deps = dependencies();
    const source = { kind: 'skills-preview', skillName: 'example', filePath: 'SKILL.md' };
    const url = 'https://example.com/skill';
    expect(await openLink({ url, reason: 'Link', source, destinationProjectId: 'click-project' }, deps))
      .toEqual({ kind: 'web', projectId: 'click-project', url });
    expect(source).toEqual({ kind: 'skills-preview', skillName: 'example', filePath: 'SKILL.md' });
    expect(deps.web).toHaveBeenCalledWith('click-project', url);
    expect(deps.external).not.toHaveBeenCalled();
  });
  it('requires an explicit captured destination for Skills without extending the rule to unrelated app-window sources', async () => {
    const deps = dependencies();
    await expect(openLink({ url: 'https://example.com', reason: 'Link', source: { kind: 'skills-preview', skillName: 'example', filePath: 'SKILL.md' } }, deps))
      .rejects.toThrow('destination project');
    await expect(openLink({ url: 'https://example.com', reason: 'Link', source: { kind: 'app-window' }, destinationProjectId: 'p' }, deps))
      .rejects.toThrow();
    expect(deps.web).not.toHaveBeenCalled();
  });
  it('validates Skills identity and destination independently', async () => {
    const deps = dependencies();
    const base = { url: 'https://example.com', reason: 'Link', source: { kind: 'skills-preview', skillName: 'example', filePath: 'reference.md' } };
    for (const destinationProjectId of ['', ' p ', 12, 'p'.repeat(257)]) {
      await expect(openLink({ ...base, destinationProjectId }, deps)).rejects.toThrow('destination project');
    }
    await expect(openLink({ ...base, destinationProjectId: 'p', source: { ...base.source, skillName: '' } }, deps)).rejects.toThrow('invalid-source');
    await expect(openLink({ ...base, url: './reference.md', destinationProjectId: 'p' }, deps)).rejects.toThrow('source project');
    expect(deps.web).not.toHaveBeenCalled();
    expect(deps.file).not.toHaveBeenCalled();
  });
  it('keeps mailto original value in a copy-only message', async () => {
    const deps = dependencies();
    const url = 'mailto:ben@example.com?subject=hello%20world';
    expect(await openLink({ url, source, reason: 'Link' }, deps)).toEqual({
      kind: 'message', title: 'Shelf cannot preview email links', url,
    });
    expect(deps.external).not.toHaveBeenCalled();
  });
  it('only delegates explicitly external links to the external gate', async () => {
    const deps = dependencies();
    const input = { url: 'mailto:ben@example.com', source, reason: 'Login', destination: 'external' as const };
    await openLink(input, deps);
    expect(deps.external).toHaveBeenCalledWith(input);
    expect(deps.web).not.toHaveBeenCalled();
  });
  it('opens HTTP in the source project and preserves the original URL', async () => {
    const deps = dependencies();
    const url = 'https://example.com/path?q=%2f';
    expect(await openLink({ url, source, reason: 'Link' }, deps)).toEqual({ kind: 'web', projectId: 'p', url });
    expect(deps.web).toHaveBeenCalledWith('p', url);
    expect(deps.external).not.toHaveBeenCalled();
  });
  it('keeps relative file references for the project reader', async () => {
    const deps = dependencies();
    deps.file.mockResolvedValue({ kind: 'file' });
    const input = { url: './src/a.ts#L12', source, reason: 'Link' };
    await openLink(input, deps);
    expect(deps.file).toHaveBeenCalledWith(input);
  });
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'custom:hello'])('rejects %s without external fallback', async url => {
    const deps = dependencies();
    await expect(openLink({ url, source, reason: 'Link' }, deps)).rejects.toThrow('Unsupported link scheme');
    expect(deps.external).not.toHaveBeenCalled();
  });
  it('rejects missing ownership and credentials', async () => {
    const deps = dependencies();
    await expect(openLink({ url: 'https://example.com', source: { kind: 'app-window' }, reason: 'Link' }, deps)).rejects.toThrow('project');
    await expect(openLink({ url: 'https://user:pass@example.com', source, reason: 'Link' }, deps)).rejects.toThrow('embedded-credentials');
  });
});
