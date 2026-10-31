/** Compile-time assertions for the browser clock configuration. */
import { web, type WebClock } from '../../src/index.ts';

const clock: WebClock = { time: '2032-01-02T03:04:05Z', mode: 'running' };
web({ clock });
web({ clock: { time: 0, mode: 'paused' } });
web({ clock: { time: -1 } });

// @ts-expect-error the initial time is required.
web({ clock: { mode: 'running' } });
// @ts-expect-error the public clock takes a string or milliseconds, not a Date object.
web({ clock: { time: new Date() } });
// @ts-expect-error mode is running or paused.
web({ clock: { time: 0, mode: 'frozen' } });
// @ts-expect-error only time and mode are accepted.
web({ clock: { time: 0, paused: true } });
