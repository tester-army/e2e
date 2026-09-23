/**
 * The page registry: every group's routes merged into the table the server
 * serves, and their nav entries in group order, which the layout renders. A
 * nav entry naming no page fails at startup, so the nav cannot drift from
 * the routes.
 */

import { basics } from './basics.mjs';
import { canvas } from './canvas.mjs';
import { controls } from './controls.mjs';
import { downloads } from './downloads.mjs';
import { interaction } from './interaction.mjs';

const groups = [basics, interaction, canvas, downloads, controls];

/** Route -> `(request) => { title, body }`, across every group. */
export const pages = Object.assign({}, ...groups.map((group) => group.pages));

/** Every nav entry, in group order. */
export const nav = groups.flatMap((group) => group.nav);

for (const { path } of nav) {
  if (!(path in pages)) throw new Error(`nav entry without a page: ${path}`);
}
