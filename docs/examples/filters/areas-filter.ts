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
    for (const file of changes.files) {
      const area = Object.keys(AREAS).find((prefix) => file.startsWith(prefix));
      if (area === undefined) return { exclude: {}, note: `${file} is in no area, so areas leaves nothing out` };
      for (const tag of AREAS[area] ?? []) reached.add(tag);
    }
    const exclude: Record<string, string> = {};
    for (const test of tests) {
      const tags = test.tags.filter((tag) => AREA_TAGS.has(tag));
      if (tags.length > 0 && !tags.some((tag) => reached.has(tag))) exclude[test.id] = 'the change reaches none of its areas';
    }
    return { exclude };
  },
} satisfies TestFilter;
