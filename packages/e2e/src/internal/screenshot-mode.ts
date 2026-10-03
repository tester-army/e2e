/**
 * The screenshot modes, in one place for every check that reads one (the
 * config, a target, a test, `--screenshot`).
 */

import type { ScreenshotMode } from '../types.ts';

export const SCREENSHOT_MODES: readonly ScreenshotMode[] = ['on-failure', 'every-step', 'off'];

/** Whether `value` is one of `SCREENSHOT_MODES`. */
export function isScreenshotMode(value: unknown): value is ScreenshotMode {
  return (SCREENSHOT_MODES as readonly unknown[]).includes(value);
}
