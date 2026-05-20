import { useAgentTab } from '../../agentTabStore';

interface Props {
  tabId: string;
}

/**
 * Sticky panel that displays the current plan. Plan messages arrive
 * via the IPC 'agent:onMessage' branch and land in tab.currentPlan
 * (not in the timeline). Renders only when there's non-empty content.
 */
export function PlanPanel({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const currentPlan = tab?.currentPlan ?? '';

  if (!currentPlan.trim()) return null;

  return (
    <div className="agent-plan-panel">
      <div className="agent-plan-header">Plan</div>
      <pre className="agent-plan-body">{currentPlan}</pre>
    </div>
  );
}
