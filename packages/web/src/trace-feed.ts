/**
 * What the web engine tells the harness for an attempt's trace, apart from
 * the app log: the screen an action left (`EngineAttemptContext.screen`),
 * and the browser and user agent the attempt runs on (`environment`). One
 * feed per attempt; it never fails what the test does.
 */

import type { Page } from 'playwright-core';
import type { EngineAttemptContext, OperationContext } from 'e2e/engine';
import { captureObservation, type CaptureSettings } from './observation-capture.ts';
import { withOperationDeadline } from './operation-budget.ts';
import { RefRegistry } from './refs.ts';

/** How long the screen an action left may take for the trace before the step goes without one. */
const TRACE_SCREEN_TIMEOUT_MS = 1_000;
/** How long the page may take to report its user agent before the trace names the browser alone. */
const ENVIRONMENT_TIMEOUT_MS = 1_000;

export class TraceFeed {
  /** Whether the feed told the harness what the attempt runs on. */
  private environmentTold = false;

  /**
   * `page` reads the attempt's open page without touching the error latch;
   * `refs` is the registry a screen is captured against, then let go.
   */
  constructor(
    private readonly context: Pick<EngineAttemptContext, 'screen' | 'environment'>,
    private readonly page: () => Page | undefined,
    private readonly refs: () => RefRegistry | undefined,
    private readonly settings: CaptureSettings,
  ) {}

  /**
   * Tells the harness, once an attempt, the browser and the user agent its
   * page reports. Best effort and not awaited: nothing the test does waits
   * on it.
   */
  tellEnvironment(): void {
    if (this.environmentTold) return;
    const sink = this.context.environment;
    void this.environmentFacts().then((facts) => {
      try {
        if (facts !== undefined) sink(facts);
      } catch {
        // The harness's sink never fails the attempt.
      }
    });
  }

  /** The browser and the user agent the page reports, within a second; undefined without a page or a browser to ask. */
  private async environmentFacts(): Promise<Record<string, string> | undefined> {
    try {
      const page = this.page();
      if (page === undefined) return undefined;
      this.environmentTold = true;
      const browser = page.context().browser();
      const facts: Record<string, string> = browser === null ? {} : { browser: `${browser.browserType().name()} ${browser.version()}` };
      const budget = { signal: AbortSignal.timeout(ENVIRONMENT_TIMEOUT_MS), timeoutMs: ENVIRONMENT_TIMEOUT_MS };
      const userAgent = await withOperationDeadline(budget, 'user agent', () => page.evaluate(() => navigator.userAgent)).catch(() => undefined);
      return typeof userAgent === 'string' ? { ...facts, 'user agent': userAgent } : facts;
    } catch {
      return undefined;
    }
  }

  /**
   * Hands the harness the screen an action left. The read is on the action's
   * path, as the `screen` contract allows, and only when the attempt keeps a
   * trace (the harness hands no `screen` otherwise). The screen is captured
   * like an observation but never published, so every ref a test or model
   * holds stays valid; a page that cannot answer within a second leaves the
   * step without one.
   */
  async screenAfterAction(operation: OperationContext): Promise<void> {
    const sink = this.context.screen;
    const refs = this.refs();
    if (sink === undefined || operation.signal.aborted || refs === undefined) return;
    try {
      const page = this.page();
      if (page === undefined) return;
      const budget = { signal: operation.signal, timeoutMs: TRACE_SCREEN_TIMEOUT_MS };
      const captured = await withOperationDeadline(budget, 'trace screen', (remaining) =>
        captureObservation(page, refs, this.settings, { ...operation, ...remaining() }, undefined),
      );
      RefRegistry.dispose(captured.generation);
      sink(captured.snapshot);
    } catch {
      // A screen the page could not give in time is no evidence the trace claims.
    }
  }
}
