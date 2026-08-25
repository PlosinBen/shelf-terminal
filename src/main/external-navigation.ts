import type {
  ExternalUrlIntentDecision,
  ExternalUrlIntentInput,
} from '@shared/external-url-intent';

interface ExternalNavigationDependencies {
  request: (input: ExternalUrlIntentInput) => Promise<ExternalUrlIntentDecision>;
  reportFailure: (message: string) => void;
}

interface NavigationEvent {
  preventDefault: () => void;
}

function requestWithoutNavigation(
  input: ExternalUrlIntentInput,
  dependencies: ExternalNavigationDependencies,
): void {
  void dependencies.request(input).catch((error) => {
    dependencies.reportFailure(error instanceof Error ? error.message : 'External URL request failed');
  });
}

export function createExternalWindowOpenHandler(dependencies: ExternalNavigationDependencies) {
  return ({ url }: { url: string }) => {
    requestWithoutNavigation({
      url,
      reason: 'A Shelf window requested an external link',
      source: { kind: 'app-window' },
    }, dependencies);
    return { action: 'deny' as const };
  };
}

export function handleExternalWillNavigate(
  event: NavigationEvent,
  url: string,
  currentUrl: string,
  dependencies: ExternalNavigationDependencies,
): void {
  if (currentUrl && url === currentUrl) return;
  event.preventDefault();
  requestWithoutNavigation({
    url,
    reason: 'A link tried to navigate the Shelf app window',
    source: { kind: 'app-window' },
  }, dependencies);
}
