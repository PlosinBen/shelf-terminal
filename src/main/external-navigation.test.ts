import { describe, expect, it, vi } from 'vitest';
import {
  createExternalWindowOpenHandler,
  handleExternalWillNavigate,
} from './external-navigation';

describe('external navigation mediation', () => {
  it('denies a created window and routes its URL through an app-window intent', () => {
    const request = vi.fn(async () => 'cancel' as const);
    const reportFailure = vi.fn();
    const handler = createExternalWindowOpenHandler({ request, reportFailure });

    expect(handler({ url: 'https://example.com/docs?token=private' })).toEqual({ action: 'deny' });
    expect(request).toHaveBeenCalledWith({
      url: 'https://example.com/docs?token=private',
      reason: 'A Shelf window requested an external link',
      source: { kind: 'app-window' },
    });
  });

  it('reports rejected unsupported URLs visibly without opening them', async () => {
    const request = vi.fn(async () => { throw new Error('unsupported-scheme'); });
    const reportFailure = vi.fn();
    const handler = createExternalWindowOpenHandler({ request, reportFailure });

    handler({ url: 'javascript:alert(1)' });
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith('unsupported-scheme'));
  });

  it('allows the initial same-URL navigation but mediates later navigation', () => {
    const request = vi.fn(async () => 'cancel' as const);
    const reportFailure = vi.fn();
    const sameEvent = { preventDefault: vi.fn() };

    handleExternalWillNavigate(
      sameEvent,
      'file:///app/index.html',
      'file:///app/index.html',
      { request, reportFailure },
    );
    expect(sameEvent.preventDefault).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    handleExternalWillNavigate(
      externalEvent,
      'mailto:support@example.com',
      'file:///app/index.html',
      { request, reportFailure },
    );
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      url: 'mailto:support@example.com',
      reason: 'A link tried to navigate the Shelf app window',
      source: { kind: 'app-window' },
    });
  });
});
