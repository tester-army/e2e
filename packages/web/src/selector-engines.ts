/** Every selector engine the web engine registers, in a launched browser and in a CDP context alike. */

import { CLOSED_SHADOW_SELECTOR_ENGINES } from './closed-shadow.ts';
import { EXACT_LABEL_SELECTOR_ENGINE, EXACT_LABEL_SELECTOR_ENGINE_SOURCE } from './label-selector.ts';

export const SELECTOR_ENGINES: readonly { readonly name: string; readonly source: string }[] = [
  ...CLOSED_SHADOW_SELECTOR_ENGINES,
  { name: EXACT_LABEL_SELECTOR_ENGINE, source: EXACT_LABEL_SELECTOR_ENGINE_SOURCE },
];
