/**
 * `@e2e-dev/cige` against a real model: one test per CIGE case and variant,
 * each pass backed by a code check of the page, and a run summary per
 * result under `.e2e/cige/`.
 */

import { cigeSuite } from '@e2e-dev/cige';
import cigeConfig from '../cige.config.ts';

cigeSuite(cigeConfig);
