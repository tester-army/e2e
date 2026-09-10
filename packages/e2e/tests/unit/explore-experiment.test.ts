import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPERIMENT, readExperiment } from '../../src/explore/experiment.ts';

describe('readExperiment', () => {
  it('is the product behavior with nothing set, and flips only the knobs named', () => {
    expect(readExperiment({})).toEqual(DEFAULT_EXPERIMENT);
    expect(readExperiment({ E2E_EXPLORE_EXPERIMENT: '' })).toEqual(DEFAULT_EXPERIMENT);
    expect(readExperiment({ E2E_EXPLORE_EXPERIMENT: 'no-findings-params' })).toEqual({ ...DEFAULT_EXPERIMENT, findingsInParams: false });
    expect(readExperiment({ E2E_EXPLORE_EXPERIMENT: ' planner-no-history , conversation' })).toEqual({ findingsInParams: true, plannerHistory: false, conversation: true });
    // An unknown knob changes nothing rather than failing a run.
    expect(readExperiment({ E2E_EXPLORE_EXPERIMENT: 'nope' })).toEqual(DEFAULT_EXPERIMENT);
  });
});
