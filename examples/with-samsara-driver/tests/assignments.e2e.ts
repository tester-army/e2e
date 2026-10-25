import { expect } from 'e2e';
import { test } from '@e2e-dev/mobile';
import { DebugSession } from '@samsara-dev/visionflow';
import { visionFlowDebug } from '../support/visionflow-debug.ts';

test('Assignment rows are fully labeled', async ({ app, agent, screen }) => {
  const baseUrl = process.env.VISIONFLOW_DEBUG_BASE_URL;
  if (!baseUrl)
    throw new Error(
      'Set VISIONFLOW_DEBUG_BASE_URL to an authorized VisionFlow viewer',
    );
  const apiKey = process.env.VISIONFLOW_DEBUG_API_KEY;
  const session = new DebugSession({
    remote: { baseUrl, ...(apiKey ? { apiKey } : {}) },
    saveScreenshots: true,
    saveHistory: true,
  });
  const debug = visionFlowDebug(session, app);
  const failures: unknown[] = [];

  try {
    await app.open();
    await agent.act(
      'From the signed-in Driver Home, open Assignments using the Assets shortcut. ' +
        'If Assignments is already visible, leave it open. Stop without selecting a row or pressing Done. ' +
        'If a sign-in, onboarding, or permission screen is visible, stop and fail: setup must finish before this test.',
      { onAction: debug.onAction },
    );
    await expect(screen.getByText(/^(Assignments|Assets)$/)).toBeVisible();
    // Require visible rows: an empty sheet must not satisfy "every visible row".
    await expect(screen.getByText('Vehicle', { exact: true })).toBeVisible();
    await agent.assert(
      'Only observe; do not interact. The Assignments screen remains visible. ' +
        'Every visible assignment row, including Vehicle, Trailers, and Shipping IDs when present, has readable text labels or selected values. ' +
        'If a Carrier row is visible, its title includes a readable carrier name and DOT number. ' +
        'No assignment row has a blank title area between its icon and chevron.',
      { vision: 'only' },
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await debug.finish(failures.length === 0);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Driver test and VisionFlow recording failed',
    );
});
