import { readFile } from 'node:fs/promises';
import type { ActionHook, App } from 'e2e';
import type { DebugSession } from '@samsara-dev/visionflow';

type Session = Pick<
  DebugSession,
  'recordHostPhase' | 'recordTestResult' | 'getViewerUrl'
>;

/**
 * Project-local bridge, not an executor: e2e drives actions and VisionFlow
 * records their settled screenshots. A recording failure stops the act.
 */
export function visionFlowDebug(
  session: Session,
  app: Pick<App, 'screenshot'>,
  log: (message: string) => void = console.log,
): { onAction: ActionHook; finish: (success: boolean) => Promise<void> } {
  let sequence = 0;
  const startedAt = Date.now();

  return {
    async onAction(event) {
      sequence += 1;
      const title = `${sequence}: ${event.source} ${event.action}`;
      const path = await app.screenshot(title);
      await session.recordHostPhase({
        kind: 'custom',
        phase: 'e2e action',
        title,
        detail: `Act action ${event.index}: ${event.summary}`,
        afterScreenshot: await readFile(path),
      });
      const url = session.getViewerUrl();
      if (!url)
        throw new Error('VisionFlow did not publish a debug viewer URL');
      log(`VisionFlow action ${sequence}: ${url}`);
    },

    async finish(success) {
      await session.recordHostPhase({
        kind: 'assert',
        title: 'Assignment rows are fully labeled',
        success,
        durationMs: Date.now() - startedAt,
        ...(success
          ? {}
          : {
              failureReason:
                'The e2e test failed. See the e2e report for details.',
            }),
      });
      await session.recordTestResult({
        runner: 'e2e',
        status: success ? 'passed' : 'failed',
      });
      const url = session.getViewerUrl();
      if (!url)
        throw new Error('VisionFlow did not publish a debug viewer URL');
      log(`VisionFlow debug viewer: ${url}`);
    },
  };
}
