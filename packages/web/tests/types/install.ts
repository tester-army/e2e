/** Compile-time assertions for the browser install surface: the arguments each entry point takes, and the ones it refuses. */
import type { BrowserName } from '../../src/browser-connection.ts';
import { installArgs, isBrowserInstalled } from '../../src/install.ts';
import type { EnsureBrowsersOptions, InstallContext } from '../../src/install.ts';

declare const browsers: BrowserName[];
declare const env: NodeJS.ProcessEnv;

// The check behind the run's own install reads the cache the run was pointed at,
// and answers which of the two chromium builds the run will launch needs.
installArgs(browsers, false);
installArgs(browsers, true);
// @ts-expect-error the run mode is a decision, not a second one.
installArgs(browsers);
isBrowserInstalled('chromium', env, false);
isBrowserInstalled('chromium', env, true);
// @ts-expect-error a run that cannot say does not get a verdict, so it passes one anyway.
isBrowserInstalled('chromium', env);
// @ts-expect-error the run mode is a decision, not a third state.
isBrowserInstalled('chromium', env, 'yes');

// The run mode reaches the installer, so it asks for the build it will launch.
false satisfies InstallContext['headed'];
false satisfies EnsureBrowsersOptions['headed'];
undefined satisfies EnsureBrowsersOptions['headed'];