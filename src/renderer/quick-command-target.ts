import type { TabType } from '@shared/types';

interface QuickCommandTab {
  id: string;
  label: string;
  type: TabType;
}

interface QuickCommandRuntime {
  tabs: readonly QuickCommandTab[];
  activeTabIndex: number;
}

export type QuickCommandTargetResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: 'missing' | 'non-terminal'; message: string };

function tabKindDescription(type: Exclude<TabType, 'terminal'>): string {
  return type === 'agent' ? 'an Agent' : 'a Web';
}

export function resolveQuickCommandTarget(
  runtime: QuickCommandRuntime,
  target: string,
): QuickCommandTargetResult {
  const current = target === 'current';
  const tab = current
    ? runtime.tabs[runtime.activeTabIndex]
    : runtime.tabs.find((candidate) => candidate.label === target);

  if (!tab) {
    return {
      ok: false,
      reason: 'missing',
      message: current
        ? 'No current tab is available for this Quick Command.'
        : `Quick Command target "${target}" is not open.`,
    };
  }
  if (tab.type !== 'terminal') {
    const kind = tabKindDescription(tab.type);
    return {
      ok: false,
      reason: 'non-terminal',
      message: current
        ? `Current tab "${tab.label}" is ${kind} tab, not a Terminal.`
        : `Quick Command target "${target}" is ${kind} tab, not a Terminal.`,
    };
  }
  return { ok: true, tabId: tab.id };
}
