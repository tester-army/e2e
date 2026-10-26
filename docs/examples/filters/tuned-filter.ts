import type { TestFilter } from 'e2e';
import { gateway } from 'ai';
import { decisionFilter } from '@e2e-dev/decision';

const decision = decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') });

export const tuned = {
  name: 'decision',
  filter(tests, context) {
    if (context.changes.files.some((file) => file.startsWith('infra/'))) return { exclude: {}, note: 'infra/ changed' };
    const judged = tests.filter((test) => !test.tags.includes('smoke'));
    const files = context.changes.files.filter((file) => !file.startsWith('apps/mobile/'));
    if (files.length === 0) return { exclude: Object.fromEntries(judged.map((test) => [test.id, 'only apps/mobile/ changed'])) };
    return decision.filter(judged, { ...context, changes: { ...context.changes, files } });
  },
} satisfies TestFilter;
