import type { Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../app/data.ts';
import fixture from '../../../e2e/schema/fixtures/report-v1.valid.json' with { type: 'json' };

// The page's own tsconfig checks this file: the model it tests reads the DOM.
const REPORT = fixture as unknown as Report;

describe('serial members', () => {
  it('keep their own error, and one that never ran shows the error that stopped it', () => {
    const [group] = REPORT.run.serialGroups;
    const [attempt] = group!.attempts;
    const [member] = attempt!.members;
    const result = REPORT.run.results.find((candidate) => candidate.serialGroupId === group!.id);
    const failure = REPORT.run.results.flatMap((each) => each.attempts).find((each) => each.error !== undefined)!.error!;
    const members = [
      { ...member!, testId: 'failed', status: 'failed', error: failure },
      { ...member!, testId: 'passed', status: 'passed' },
      { ...member!, testId: 'skipped', status: 'skipped' },
    ] as const;
    const model = buildModel({
      report: {
        ...REPORT,
        run: {
          ...REPORT.run,
          results: members.map(({ testId }) => ({ ...result!, testId, selected: true })),
          serialGroups: [{ ...group!, attempts: [{ ...attempt!, error: failure, members }] }],
        },
      },
      media: { mode: 'none' },
      resultsDir: '.e2e/results',
      traces: {},
      sources: {},
    });
    expect(model.results.map((each) => [each.testId, model.attempts(each)[0]?.error?.message])).toEqual([
      ['failed', failure.message],
      ['passed', undefined],
      ['skipped', failure.message],
    ]);
  });
});
