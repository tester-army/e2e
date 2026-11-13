/** Compile-time assertions for the provider's public options. Never executed. */
import { browserRun, type BrowserRunOptions } from '../../src/index.ts';

browserRun();

browserRun({ scope: 'worker', keepAlive: 60_000 });

browserRun({ scope: 'attempt' });

({ scope: undefined, keepAlive: undefined }) satisfies BrowserRunOptions;

// @ts-expect-error browser lifetime is worker-scoped or attempt-scoped.
browserRun({ scope: 'run' });

// @ts-expect-error the inactivity timeout is a number of milliseconds.
browserRun({ keepAlive: '60000' });

// @ts-expect-error experimental pools are not part of the supported options.
browserRun({ lab: true });

// @ts-expect-error live viewing is outside this provider's options.
browserRun({ liveView: true });
