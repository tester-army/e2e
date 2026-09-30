/** The refusal every engine factory gives an option that moved to the target. */

import { ConfigurationError } from '../internal/errors.ts';

/**
 * Refuses the options an engine factory used to take that now live on the
 * target, every one of them in one error, with the target block they make:
 * `web({ url, command })` reads `targets: [{ engine: web(), app: { url,
 * command } }]`. `factory` is the call as a target writes it (`web()`,
 * `mobile({ platform })`); `moved` maps each old option to where it lives
 * now, `app.<key>` under the target's app or a key of the target itself.
 */
export function rejectMovedOptions(factory: string, options: object, moved: Readonly<Record<string, string>>): void {
  const found = Object.keys(moved).filter((key) => key in options);
  if (found.length === 0) return;
  const places = found.map((key) => moved[key]!);
  const app = [...new Set(places.filter((place) => place.startsWith('app.')).map((place) => place.slice('app.'.length)))];
  const block = [`engine: ${factory}`, ...(app.length === 0 ? [] : [`app: { ${app.join(', ')} }`]), ...places.filter((place) => !place.startsWith('app.'))];
  const name = factory.slice(0, factory.indexOf('('));
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `${name}({ ${found.join(', ')} }) moved to the target: the app under test is declared there, as targets: [{ ${block.join(', ')} }]; ${name}() only drives it`,
  );
}
