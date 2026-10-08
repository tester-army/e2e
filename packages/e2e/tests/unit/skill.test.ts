import { expect, it } from 'vitest';
import { readGuide } from '../../src/cli/skill.ts';

it('rejects unknown topics and paths outside the bundled guide', () => {
  expect(readGuide('nope')).toBeUndefined();
  expect(readGuide('../SKILL')).toBeUndefined();
});
