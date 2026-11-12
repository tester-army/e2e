/**
 * Tabs the browser is opening that Playwright has not reported yet.
 *
 * Chromium announces a tab the app opens (`Target.targetCreated` with an
 * opener) before the click that opened it returns, but Playwright reports
 * the page only once its first navigation commits: tens of milliseconds
 * later, or seconds on a slow server. An operation that started in that gap
 * would run on the tab the attempt showed before, and the one after it on
 * the new tab. Each operation waits here first, so the tab change lands
 * between two operations, the same one on every run.
 *
 * Some tabs are never reported: a `mailto:` link, or a response with no
 * document (a 204). Such a tab is waited for only while its first request is
 * in flight, then for a short grace, and then given up on.
 */
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import { raceAbort } from 'e2e/engine';
import { targetIdentity } from './cdp-recovery.ts';

/**
 * How long a tab that has no request in flight may take to be reported. A
 * tab with no request at all (`window.open('')`) is reported in tens of
 * milliseconds; this leaves room for a loaded machine.
 */
const REPORT_GRACE_MS = 1_000;

interface Announced {
  readonly context: string | undefined;
  readonly at: number;
}

export class OpeningTabs {
  private readonly announced = new Map<string, Announced>();
  /** Every page target the app opened while watched, reported or not. */
  private readonly opened = new Set<string>();
  /** First requests of tabs being opened that have no response yet. */
  private readonly loading = new Set<Request>();
  /** When `loading` last emptied. */
  private quietSince = 0;
  private readonly listeners = new Set<() => void>();
  private context: Promise<string | undefined> | undefined;
  private unlisten = (): void => undefined;

  private constructor(private readonly cdp: CDPSession, contextId: string | undefined) {
    if (contextId !== undefined) this.context = Promise.resolve(contextId);
  }

  /** Follows the first requests of tabs being opened in `browserContext`. */
  private listen(browserContext: BrowserContext): void {
    const started = (request: Request): void => {
      if (!opensTab(request)) return;
      this.loading.add(request);
      this.changed();
    };
    const ended = (request: Request): void => {
      if (!this.loading.delete(request)) return;
      if (this.loading.size === 0) this.quietSince = Date.now();
      this.changed();
    };
    const answered = (response: { request(): Request }): void => { ended(response.request()); };
    browserContext.on('request', started);
    browserContext.on('response', answered);
    browserContext.on('requestfailed', ended);
    this.unlisten = () => {
      browserContext.off('request', started);
      browserContext.off('response', answered);
      browserContext.off('requestfailed', ended);
    };
  }

  /**
   * Starts watching the browser's targets, or returns undefined when the
   * browser cannot be watched (a CDP endpoint without target discovery):
   * the attempt then follows a tab whenever Playwright reports it. Targets
   * that exist before discovery starts are not tabs being opened.
   */
  static async watch(browser: Browser, context: BrowserContext, contextId: string | undefined): Promise<OpeningTabs | undefined> {
    let cdp: CDPSession;
    try {
      cdp = await browser.newBrowserCDPSession();
    } catch {
      return undefined;
    }
    let opening: OpeningTabs | undefined;
    try {
      const watching = new OpeningTabs(cdp, contextId);
      opening = watching;
      let discovering = false;
      cdp.on('Target.targetCreated', ({ targetInfo }) => {
        if (discovering && targetInfo.type === 'page' && targetInfo.openerId !== undefined) {
          watching.announced.set(targetInfo.targetId, { context: targetInfo.browserContextId, at: Date.now() });
          watching.opened.add(targetInfo.targetId);
        }
      });
      cdp.on('Target.targetDestroyed', ({ targetId }) => {
        watching.opened.delete(targetId);
        watching.settle(targetId);
      });
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      discovering = true;
      watching.listen(context);
      return watching;
    } catch {
      if (opening === undefined) void Promise.resolve().then(() => cdp.detach()).catch(() => undefined);
      else opening.detach();
      return undefined;
    }
  }

  /**
   * Playwright reported `page`: it is no longer a tab being opened. When the
   * app opened it, `appOpened` runs first, so a wait that ends here finds
   * the page already handled.
   */
  reported(page: Page, appOpened: () => void): void {
    // `opened` holds every announced tab, also one given up on before Playwright reported it.
    if (this.opened.size === 0) return;
    targetIdentity(page).then(({ targetId }) => {
      if (this.opened.has(targetId)) appOpened();
      this.settle(targetId);
    }, () => undefined);
  }

  /**
   * Resolves once no tab is being opened in the attempt's context, `false`
   * when one still is at `endsAt`. `page` is any page of that context, to
   * learn its id when the watch began without it; until that id is known,
   * every announced tab counts.
   */
  async settled(page: Page | undefined, signal: AbortSignal, endsAt: number): Promise<boolean> {
    if (this.announced.size === 0) return true;
    if (this.context === undefined && page !== undefined) {
      // A failed read is not kept: the next operation asks again.
      const reading = targetIdentity(page).then((target) => target.browserContextId, () => {
        if (this.context === reading) this.context = undefined;
        return undefined;
      });
      this.context = reading;
    }
    const context = await raceAbort(within(this.context ?? Promise.resolve(undefined), endsAt), signal, 'tab');
    if (context === TIMED_OUT) return false;
    for (;;) {
      const now = Date.now();
      let until = Number.POSITIVE_INFINITY;
      for (const [targetId, tab] of this.announced) {
        if (context !== undefined && tab.context !== context) continue;
        if (this.loading.size > 0) {
          until = endsAt;
          break;
        }
        const giveUpAt = Math.max(tab.at, this.quietSince) + REPORT_GRACE_MS;
        if (now >= giveUpAt) {
          this.settle(targetId);
          continue;
        }
        until = Math.min(until, giveUpAt);
      }
      if (until === Number.POSITIVE_INFINITY) return true;
      if (now >= endsAt) return false;
      await raceAbort(this.change(Math.min(until, endsAt) - now), signal, 'tab');
    }
  }

  /** Stops watching; the session goes with its connection otherwise. */
  detach(): void {
    this.unlisten();
    this.announced.clear();
    this.opened.clear();
    this.loading.clear();
    this.changed();
    void Promise.resolve().then(() => this.cdp.detach()).catch(() => undefined);
  }

  private settle(targetId: string): void {
    if (!this.announced.delete(targetId)) return;
    if (this.announced.size === 0) this.loading.clear();
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves at the next change, or after `ms`. */
  private change(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
    });
  }
}

const TIMED_OUT = Symbol('timed out');

/** `work`'s value, or `TIMED_OUT` once `endsAt` passes first. */
function within<T>(work: Promise<T>, endsAt: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => { resolve(TIMED_OUT); }, Math.max(0, endsAt - Date.now()));
  });
  return Promise.race([work, expired]).finally(() => { clearTimeout(timer); });
}

/**
 * The first request of a tab being opened: a navigation Playwright has no
 * frame for yet, since the page it loads in is not reported. Only `http:`
 * and `https:` get an answer; a `mailto:` link's request never ends.
 */
function opensTab(request: Request): boolean {
  if (!request.isNavigationRequest() || !/^https?:/.test(request.url())) return false;
  try {
    request.frame();
    return false;
  } catch {
    return true;
  }
}
