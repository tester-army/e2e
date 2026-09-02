/**
 * The device suite's `test`, typed with the agent-device backend's
 * contributed `device` fixture — no global `declare module` augmentation.
 * `extend` is a pure type refinement; `device` still resolves from the
 * target's backend at runtime.
 */

import { test as base } from 'e2e';
import type { Device } from '../fixtures/agent-device.ts';

export const test = base.extend<{ device: Device }>();
export { expect } from 'e2e';
