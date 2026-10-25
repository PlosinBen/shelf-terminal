// Test-mode transport only: exercise the actual provider before renderer delivery.
import { createMockAcpAgent } from '../acp/mock-agent';
import { createCopilotBackend } from './index';
import { COPILOT_USAGE_UPDATE } from './usage-observation';

export function createCopilotUsageTestBackend() {
  const mock = createMockAcpAgent({
    updatesOnPrompt: [
      { sessionUpdate: COPILOT_USAGE_UPDATE, used: 0, size: 0 },
      { sessionUpdate: COPILOT_USAGE_UPDATE, used: 100, size: 1000, cost: { amount: 0.1, currency: 'USD' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'usage-test-reply', content: { type: 'text', text: 'Copilot usage observed' } },
    ],
  });
  return {
    ...createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null }),
    // Keep this transport fixture independent of a native CLI or signed-in account.
    // The real account-quota hook is covered by credit.test.ts and live validation.
    refreshAccountStatus: async () => {},
  };
}
