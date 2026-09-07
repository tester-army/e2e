/** `e2e guide`: prints the bundled agent skill for agents and people who do not have it installed. */

import { MISSING_SKILL_MESSAGE, readGuide, skillTopics } from './skill.ts';

/** Prints the overview or one topic to stdout; an unknown topic exits 2. */
export function guide(topic: string | undefined): number {
  const text = readGuide(topic);
  if (text === undefined) {
    const topics = skillTopics();
    process.stderr.write(
      topics.length === 0
        ? `${MISSING_SKILL_MESSAGE}\n`
        : `unknown topic "${topic}"; topics: ${topics.join(', ')}\n`,
    );
    return 2;
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}
