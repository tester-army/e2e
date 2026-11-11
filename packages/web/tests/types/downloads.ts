/** Compile-time contracts for collecting a batch from one download trigger. */
import type { Browser } from '../../src/index.ts';
declare const browser: Browser;
void (browser.waitForDownloads(async () => undefined, { count: 2 }) satisfies Promise<readonly { path: string; absolutePath: string; suggestedFilename: string }[]>);
// @ts-expect-error a batch must name the expected count
void browser.waitForDownloads(async () => undefined, {});
// @ts-expect-error the trigger is asynchronous
void browser.waitForDownloads(() => undefined, { count: 2 });
