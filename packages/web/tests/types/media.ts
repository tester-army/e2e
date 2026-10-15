/** Compile-time assertions for media emulation: the features and values `web()` and `browser.emulateMedia` take. */
import { web, type Browser } from '../../src/index.ts';

declare const browser: Browser;
void browser.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
void browser.emulateMedia({ reducedMotion: 'no-preference' });
void browser.emulateMedia({});
web({ colorScheme: 'no-preference', reducedMotion: 'reduce' });

// @ts-expect-error a color scheme is light, dark, or no-preference.
void browser.emulateMedia({ colorScheme: 'sepia' });
// @ts-expect-error reduced motion is reduce or no-preference, not a boolean.
web({ reducedMotion: true });
// @ts-expect-error only the emulated features are taken.
void browser.emulateMedia({ forcedColors: 'active' });
// @ts-expect-error the features go in one object.
void browser.emulateMedia();
