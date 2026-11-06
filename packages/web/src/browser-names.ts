/** The browsers the engine drives over WebDriver BiDi. */

/** Every browser the engine launches, in the order the CLI lists them. */
export const BROWSER_NAMES = ['chromium', 'firefox'] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

/** Whether `name` is a browser the engine launches. */
export function isBrowserName(name: string): name is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(name);
}
