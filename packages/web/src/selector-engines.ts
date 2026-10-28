/** Every selector engine the web engine registers, in a launched browser and in a CDP context alike. */

import { CLOSED_SHADOW_SELECTOR_ENGINES } from './closed-shadow.ts';
import { EXACT_LABEL_SELECTOR_ENGINE, EXACT_LABEL_SELECTOR_ENGINE_SOURCE } from './label-selector.ts';
import { READ_SELECTOR_ENGINE, READ_SELECTOR_ENGINE_SOURCE } from './read-selector.ts';
import { SHOWN_SELECTOR_ENGINE, SHOWN_SELECTOR_ENGINE_SOURCE } from './shown-selector.ts';
import { MAIN_WORLD_SELECTOR_ENGINE, MAIN_WORLD_SELECTOR_ENGINE_SOURCE } from './main-world-selector.ts';

export const SELECTOR_ENGINES: readonly { readonly name: string; readonly source: string }[] = [
  { name: MAIN_WORLD_SELECTOR_ENGINE, source: MAIN_WORLD_SELECTOR_ENGINE_SOURCE },
  ...CLOSED_SHADOW_SELECTOR_ENGINES,
  { name: EXACT_LABEL_SELECTOR_ENGINE, source: EXACT_LABEL_SELECTOR_ENGINE_SOURCE },
  { name: READ_SELECTOR_ENGINE, source: READ_SELECTOR_ENGINE_SOURCE },
  { name: SHOWN_SELECTOR_ENGINE, source: SHOWN_SELECTOR_ENGINE_SOURCE },
];
