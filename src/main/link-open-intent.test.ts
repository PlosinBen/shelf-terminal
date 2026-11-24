import { describe, expect, it, vi } from 'vitest';
import { openLink } from './link-open-intent';

const source = { kind: 'project-tab' as const, projectId: 'p', tabId: 'v' };
const dependencies = () => ({ external: vi.fn(), web: vi.fn(), file: vi.fn() });

describe('link opening destinations', () => {
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
