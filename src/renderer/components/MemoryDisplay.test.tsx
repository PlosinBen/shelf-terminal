import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProcessMemorySummary } from '@shared/process-memory';
import { AgentMemory, FooterMemory, formatMemoryKiB } from './MemoryDisplay';

const available = (memoryKiB: number) => ({
  availability: 'available' as const,
  memoryKiB,
  excludedSources: 0,
});

const unavailable = { availability: 'unavailable' as const, excludedSources: 1 };

const summary: ProcessMemorySummary = {
  summarizedAt: '2026-08-05T00:00:00.000Z',
  app: available(420 * 1024),
  connections: {
    local: {
      runtime: available(1536 * 1024),
      agents: available(0),
      agentCount: 2,
    },
    empty: {
      runtime: available(0),
      agents: available(0),
      agentCount: 0,
    },
  },
  tabs: { tab1: available(64 * 1024) },
  excludedSourceCount: 0,
};

describe('formatMemoryKiB', () => {
  it('formats available values in adaptive binary units', () => {
    expect(formatMemoryKiB(available(0))).toBe('0 MiB');
    expect(formatMemoryKiB(available(420 * 1024))).toBe('420 MiB');
    expect(formatMemoryKiB(available(1280 * 1024))).toBe('1.3 GiB');
  });

  it('formats unavailable or absent values as a dash', () => {
    expect(formatMemoryKiB(unavailable)).toBe('—');
    expect(formatMemoryKiB(undefined)).toBe('—');
  });
});

describe('memory display components', () => {
  it('keeps App visible but leaves connection rollups unavailable without a selection', () => {
    const html = renderToStaticMarkup(
      <FooterMemory summary={summary} />,
    );
    expect(html).toContain('App 420 MiB');
    expect(html).toContain('Runtime —');
    expect(html).toContain('Agents(0) —');
  });

  it('selects one connection and preserves a valid empty rollup as numeric zero', () => {
    const html = renderToStaticMarkup(
      <FooterMemory summary={summary} selectedConnectionScopeKey="empty" />,
    );
    expect(html).toContain('Runtime 0 MiB');
    expect(html).toContain('Agents(0) 0 MiB');
  });

  it('renders only the selected tab rollup in the Agent status segment', () => {
    expect(renderToStaticMarkup(<AgentMemory rollup={summary.tabs.tab1} />))
      .toContain('Memory 64 MiB');
    expect(renderToStaticMarkup(<AgentMemory rollup={unavailable} />))
      .toContain('Memory —');
  });
});
