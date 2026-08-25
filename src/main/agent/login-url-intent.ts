import type {
  ExternalUrlIntentDecision,
  ExternalUrlIntentInput,
} from '@shared/external-url-intent';

interface AgentLoginUrlInput {
  projectId: string | undefined;
  tabId: string;
  provider: string;
  url: string;
}

interface AgentLoginUrlDependencies {
  request: (input: ExternalUrlIntentInput) => Promise<ExternalUrlIntentDecision>;
  reportFailure: (message: string) => void;
}

export function mediateAgentLoginUrl(
  input: AgentLoginUrlInput,
  dependencies: AgentLoginUrlDependencies,
): void {
  if (!input.projectId) {
    dependencies.reportFailure('Agent login URL has no owning project');
    return;
  }

  void dependencies.request({
    url: input.url,
    reason: `Authorize ${input.provider} device login`,
    source: {
      kind: 'project-tab',
      projectId: input.projectId,
      tabId: input.tabId,
    },
  }).catch((error) => {
    dependencies.reportFailure(
      error instanceof Error ? error.message : 'Agent login URL request failed',
    );
  });
}
