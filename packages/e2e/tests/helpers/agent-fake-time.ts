import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';

/**
 * Runs every test in the calling file on fake time that jumps to each next
 * timer, so a step's screen settle and the SDK's retry backoff cost nothing.
 * The agent loop and the AI SDK load lazily; both are loaded up front, since
 * a real import in flight would let the clock jump straight to the step
 * deadline.
 */
export function runAgentStepsOnFakeTime(): void {
  beforeAll(async () => {
    await import('../../src/agent/default-agent.ts');
    await loadAiSdk();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setTimerTickMode('nextTimerAsync');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
