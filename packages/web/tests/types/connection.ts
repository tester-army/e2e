/** Compile-time assertions for endpoint provisioning, transport recovery, and the browser provider seam. */
import { secrets } from 'e2e';
import type { BrowserLease, BrowserProvider, WebConnectOptions, WebInitScript, WebOptions } from '../../src/index.ts';

({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async (signal) => {
  signal.throwIfAborted();
  return 'ws://localhost:9222';
} }) satisfies WebConnectOptions;

// @ts-expect-error recovery cannot omit the fresh-attempt provisioner.
({ reconnectEndpoint: () => 'ws://localhost:9222' }) satisfies WebConnectOptions;
// @ts-expect-error a recovery resolver must return an endpoint, never a page or a success flag.
({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async () => true }) satisfies WebConnectOptions;

({ name: 'hosted', scope: 'attempt', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined }) satisfies BrowserProvider;
({ id: 's', cdpEndpoint: 'ws://localhost:9222', reconnectEndpoint: undefined }) satisfies BrowserLease;
({ browser: { name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined } }) satisfies WebOptions;

// @ts-expect-error a lease names its endpoint; a browser object or a page is not one.
({ id: 's', cdpEndpoint: 9222 }) satisfies BrowserLease;
// @ts-expect-error a lease scope is `worker` or `attempt`.
({ name: 'hosted', scope: 'run', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }), release: async () => undefined }) satisfies BrowserProvider;
// @ts-expect-error a provider releases what it leased.
({ name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }) }) satisfies BrowserProvider;

({
  name: 'hosted',
  acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }),
  release: async () => undefined,
  downloads: { dir: '/downloads', read: async (lease, file, context) => new TextEncoder().encode(`${lease.id} ${file} ${context.runId}`) },
  sweep: async (context) => [context.runId],
}) satisfies BrowserProvider;

// @ts-expect-error: a download is its bytes, not a path.
({ name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }), release: async () => undefined, downloads: { dir: '/d', read: async () => '/d/file' } }) satisfies BrowserProvider;

// @ts-expect-error: a sweep resolves to the ids it released.
({ name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }), release: async () => undefined, sweep: async () => 2 }) satisfies BrowserProvider;

// Gates on the way to a protected app, the page size, the attribute that carries a test id, and the user agent.
({ headers: { 'x-vercel-protection-bypass': 'token' }, basicAuth: { username: 'preview', password: 'secret' }, viewport: { width: 390, height: 844 }, testIdAttribute: 'data-qa', userAgent: 'Mozilla/5.0 playwright' }) satisfies WebOptions;
// @ts-expect-error basic auth is a username and a password; one without the other is no credential.
({ basicAuth: { username: 'preview' } }) satisfies WebOptions;
// A configured secret keeps the password out of the config file.
({ basicAuth: { username: 'preview', password: secrets.get('previewPassword') } }) satisfies WebOptions;
// @ts-expect-error a password is a string or a secrets.get() handle.
({ basicAuth: { username: 'preview', password: 42 } }) satisfies WebOptions;
// @ts-expect-error a header value is a string; nothing else is sent.
({ headers: { 'x-vercel-protection-bypass': 1 } }) satisfies WebOptions;
// @ts-expect-error a viewport is a width and a height.
({ viewport: { width: 1280 } }) satisfies WebOptions;
// `null` follows the window instead of emulating a size.
({ viewport: null }) satisfies WebOptions;
// @ts-expect-error the test id attribute is one attribute name.
({ testIdAttribute: ['data-qa', 'data-test'] }) satisfies WebOptions;
// @ts-expect-error a user agent is one string.
({ userAgent: 3 }) satisfies WebOptions;
// The locale and time zone every context runs in.
({ locale: 'de-DE', timezoneId: 'Europe/Berlin' }) satisfies WebOptions;
// @ts-expect-error a locale is one tag; Playwright takes no fallback list.
({ locale: ['de-DE', 'en-US'] }) satisfies WebOptions;
// Init scripts: source, a file, or a function that takes no argument.
({ initScripts: ['window.x = 1', { path: 'shim.js' }, () => undefined] }) satisfies WebOptions;
({ path: 'shim.js' }) satisfies WebInitScript;
// @ts-expect-error a configured script takes no argument; inline the value or use browser.addInitScript.
({ initScripts: [(arg: { a: number }) => arg.a] }) satisfies WebOptions;
// @ts-expect-error Playwright's { content } is a plain string here.
({ initScripts: [{ content: 'window.x = 1' }] }) satisfies WebOptions;
// The page screencast's frame size and quality; which attempts record is the config's video.
({ screencast: { size: { width: 1280, height: 720 }, quality: 80 } }) satisfies WebOptions;
// @ts-expect-error web({ video }) was renamed web({ screencast }).
({ video: { quality: 80 } }) satisfies WebOptions;
