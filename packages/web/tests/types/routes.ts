/** Compile-time assertions for route decisions: the options each one takes, and the ones it refuses at runtime too. */
import type { Browser, Dialog, RouteContinueOverrides, RouteFulfillResponse, WebRoute } from '../../src/index.ts';

({ json: { ok: true }, contentType: 'application/vnd.quote+json' }) satisfies RouteFulfillResponse;
({ path: 'fixtures/quote.json', status: 201 }) satisfies RouteFulfillResponse;
({}) satisfies RouteFulfillResponse;
({ url: '/api/other', method: 'PUT', headers: { 'x-a': 'b' }, postData: '{}' }) satisfies RouteContinueOverrides;

// @ts-expect-error a response has one source: `path` and `body` together are not one.
({ path: 'quote.json', body: 'x' }) satisfies RouteFulfillResponse;
// @ts-expect-error a response has one source: `path` and `json` together are not one.
({ path: 'quote.json', json: 1 }) satisfies RouteFulfillResponse;
// @ts-expect-error `fulfill({ response })` from Playwright is not implemented.
({ response: {} }) satisfies RouteFulfillResponse;
// @ts-expect-error header values are strings.
({ headers: { 'x-n': 1 } }) satisfies RouteContinueOverrides;

declare const browser: Browser;
void (browser.waitForDownload(async () => {}).then(file => file.absolutePath) satisfies Promise<string>);

declare const route: WebRoute;
void route.continue();
void route.fallback();
// @ts-expect-error `abort` takes no Playwright error code.
void route.abort('failed');
// @ts-expect-error `fallback` takes no overrides.
void route.fallback({ url: '/api/other' });

/** Dialog handlers expose only native browser kinds. */
declare const dialog: Dialog;
void (dialog.type satisfies 'alert' | 'confirm' | 'prompt' | 'beforeunload');
// @ts-expect-error the kind is read-only
dialog.type = 'alert';
// @ts-expect-error unsupported native kinds are outside the contract
const futureKind: Dialog['type'] = 'future';
void futureKind;
