/**
 * The browsers the engine drives over WebDriver BiDi, and how each one
 * differs: one `BrowserTraits` record per browser, which the driver reads
 * instead of comparing browser names in its flows.
 */

/** Every browser the engine launches, in the order the CLI lists them. */
export const BROWSER_NAMES = ['chromium', 'firefox'] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

/** Whether `name` is a browser the engine launches. */
export function isBrowserName(name: string): name is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(name);
}

/** What the driver does differently on one browser. */
export interface BrowserTraits {
  readonly name: BrowserName;
  /**
   * Whether Chromium's DevTools protocol is reachable (the mapper's `goog:cdp`
   * passthrough): keys a BiDi key action cannot carry, drags the page starts,
   * and frames a rotation or 3D transform turns go through it. Only a browser
   * with it is attached to over CDP.
   */
  readonly cdp: boolean;
  /** The `browsingContext.create` type a new top-level context takes. */
  readonly newContext: 'tab' | 'window';
  /** How the attempt's video is recorded: the browser's own BiDi screencast, or the CDP screencast encoded by ffmpeg. */
  readonly screencast: 'bidi' | 'cdp';
  /** Whether `emulation.setMediaFeaturesOverride` takes `prefers-reduced-motion`; without it only the launch preference sets it. */
  readonly emulatesReducedMotion: boolean;
  /**
   * Whether the browser's default answer to a basic-auth challenge is a login
   * prompt BiDi neither reports nor dismisses, which stalls the navigation,
   * so every challenge is held even without credentials.
   */
  readonly promptsForAuth: boolean;
  /** Whether a continued request gets its cookies from the browser's jar, so a header override drops the cookie header it was sent with. */
  readonly continueAddsCookies: boolean;
  /** Whether a continued request keeps its old `content-length` when the route replaces its body, so the driver sets the new one. */
  readonly continueKeepsContentLength: boolean;
  /** Whether `network.continueRequest` can send a request to another URL. */
  readonly continueRewritesUrl: boolean;
  /** Whether the body of a held navigation (a form submission) can be read; Chromium never answers for it. */
  readonly navigationBodies: boolean;
  /**
   * Whether a mouse or wheel action first waits for the tab to be shown and
   * its document to have rendered a frame: the parent process hit-tests such
   * input against what the compositor shows.
   */
  readonly pointerWaitsForFrame: boolean;
  /** The permission names a target's `app.permissions` may grant. */
  readonly permissions: readonly string[];
}

/** Every browser's traits. */
export const BROWSER_TRAITS: Readonly<Record<BrowserName, BrowserTraits>> = {
  chromium: {
    name: 'chromium',
    cdp: true,
    newContext: 'tab',
    screencast: 'cdp',
    emulatesReducedMotion: true,
    promptsForAuth: false,
    continueAddsCookies: true,
    continueKeepsContentLength: false,
    continueRewritesUrl: true,
    navigationBodies: false,
    pointerWaitsForFrame: false,
    permissions: [
      'accelerometer', 'ambient-light-sensor', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write',
      'geolocation', 'gyroscope', 'local-fonts', 'local-network-access', 'magnetometer', 'microphone', 'midi',
      'midi-sysex', 'notifications', 'payment-handler', 'screen-wake-lock', 'storage-access',
    ],
  },
  firefox: {
    name: 'firefox',
    cdp: false,
    newContext: 'window',
    screencast: 'bidi',
    emulatesReducedMotion: false,
    promptsForAuth: true,
    continueAddsCookies: false,
    continueKeepsContentLength: true,
    continueRewritesUrl: false,
    navigationBodies: true,
    pointerWaitsForFrame: true,
    permissions: ['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock'],
  },
};
