import type { AgentInitPhase } from '../../../shared/types';

/**
 * User-facing label for the init sub-phase shown while an agent tab is starting.
 * Single source for both the ConnectionOverlay (starting cover) and any other
 * starting-state surface. `null` → generic "Starting agent…".
 */
export function initPhaseLabel(phase: AgentInitPhase | null): string {
  switch (phase) {
    case 'deploying': return 'Deploying runtime…';
    case 'connecting': return 'Connecting…';
    case 'checking-auth': return 'Checking sign-in…';
    default: return 'Starting agent…';
  }
}
