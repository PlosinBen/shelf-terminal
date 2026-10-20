import type { TabTemplate } from '@shared/types';
import type { Tab } from './store-projects';

function baseTemplate(tab: Tab) {
  return {
    name: tab.label,
    ...(tab.color ? { color: tab.color } : {}),
  };
}

export function runtimeTabToTemplate(tab: Tab): TabTemplate | null {
  const base = baseTemplate(tab);
  if (tab.type === 'agent') {
    if (!tab.provider) return null;
    return { ...base, kind: 'agent', provider: tab.provider };
  }
  if (tab.type === 'web') {
    return { ...base, kind: 'web', ...(tab.url ? { url: tab.url } : {}) };
  }
  return { ...base, ...(tab.cmd ? { cmd: tab.cmd } : {}) };
}
