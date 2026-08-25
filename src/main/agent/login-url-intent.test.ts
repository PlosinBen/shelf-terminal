import { describe, expect, it, vi } from 'vitest';
import { mediateAgentLoginUrl } from './login-url-intent';

describe('mediateAgentLoginUrl', () => {
  it('submits the exact login URL with its owning project and tab', () => {
    const request = vi.fn(async () => 'cancel' as const);
    const reportFailure = vi.fn();

    mediateAgentLoginUrl({
      projectId: 'project-copilot',
      tabId: 'tab-copilot',
      provider: 'copilot',
      url: 'https://github.com/login/device?user_code=EXACT-CODE',
    }, { request, reportFailure });

    expect(request).toHaveBeenCalledWith({
      url: 'https://github.com/login/device?user_code=EXACT-CODE',
      reason: 'Authorize copilot device login',
      source: {
        kind: 'project-tab',
        projectId: 'project-copilot',
        tabId: 'tab-copilot',
      },
    });
  });

  it('fails loudly without submitting when project attribution is missing', () => {
    const request = vi.fn(async () => 'cancel' as const);
    const reportFailure = vi.fn();

    mediateAgentLoginUrl({
      projectId: undefined,
      tabId: 'tab-copilot',
      provider: 'copilot',
      url: 'https://github.com/login/device?user_code=PRIVATE',
    }, { request, reportFailure });

    expect(request).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith('Agent login URL has no owning project');
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain('PRIVATE');
  });
});
