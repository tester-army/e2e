/** The fixtures a `mobile()` target contributes, as types only. */

import type { Device } from './device.ts';

/** What a session on a `mobile()` target holds beside `screen` and `app`: the `device` fixture. */
export interface MobileFixtures {
  readonly device: Device;
}
