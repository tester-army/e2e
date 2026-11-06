import type { TestFilter } from 'e2e';

/** The test tags each part of the app reaches, by path from the repository root. */
const AREAS: Readonly<Record<string, readonly string[]>> = {
  'src/todos/': ['todos'],
  'src/auth/': ['auth', 'smoke'],
  'src/checkout/': ['checkout'],
};
/** Every tag an area reaches; a test without one always runs. */
const AREA_TAGS: ReadonlySet<string> = new Set(Object.values(AREAS).flat());

export const areas = {
  name: 'areas',
  filter(tests, { changes }) {
    const reached = new Set<string>();
    let unmapped: string | undefined;
    for (const file of changes.files) {
      const area = Object.keys(AREAS).find((prefix) => file.startsWith(prefix));
      if (area === undefined) unmapped = file;
      else for (const tag of AREAS[area] ?? []) reached.add(tag);
    }
    const exclude: Record<string, string> = {};
    const relevance: Record<string, number> = {};
    for (const test of tests) {
      const tags = test.tags.filter((tag) => AREA_TAGS.has(tag));
      if (tags.some((tag) => reached.has(tag))) relevance[test.id] = 1;
      else if (tags.length > 0 && unmapped === undefined) exclude[test.id] = 'the change reaches none of its areas';
    }
    if (unmapped === undefined) return { exclude, relevance };
    return { exclude, relevance, note: `${unmapped} is in no area, so areas leaves nothing out` };
  },
} satisfies TestFilter;
