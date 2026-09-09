import { describe, expect, it } from 'vitest';
import { imageTokenUpperBound } from '../../src/agent/model/adapter.ts';
import { observationByteBudget } from '../../src/agent/observation-budget.ts';

const LIMITS = { maxObservationBytes: 262_144, maxModelTokensPerCall: 200_000 };
const INSTRUCTION_RESERVE = 4_096;
const PIXEL_RESERVE = imageTokenUpperBound({ width: 2_560, height: 1_440 });

describe('observationByteBudget', () => {
  it('returns the configured ceiling when the request leaves room for it', () => {
    expect(
      observationByteBudget({ ...LIMITS, maxModelTokensPerCall: 1_000_000 }, { fixedBytes: 10_000, pixels: false }),
    ).toBe(262_144);
  });

  it('clamps to the per-call token ceiling minus the request overhead', () => {
    const fixedBytes = 100_000;
    expect(observationByteBudget(LIMITS, { fixedBytes, pixels: false })).toBe(
      LIMITS.maxModelTokensPerCall - fixedBytes - INSTRUCTION_RESERVE,
    );
  });

  it('reserves the largest planned screenshot on a vision request', () => {
    const fixedBytes = 100_000;
    const text = observationByteBudget(LIMITS, { fixedBytes, pixels: false });
    const vision = observationByteBudget(LIMITS, { fixedBytes, pixels: true });
    expect(text - vision).toBe(PIXEL_RESERVE);
  });

  it('never falls below the floor a tree can still name controls under', () => {
    expect(observationByteBudget(LIMITS, { fixedBytes: 1_000_000, pixels: true })).toBe(1_024);
  });

  it('honors a configured ceiling smaller than the token ceiling allows', () => {
    expect(
      observationByteBudget({ ...LIMITS, maxObservationBytes: 4_096 }, { fixedBytes: 0, pixels: false }),
    ).toBe(4_096);
  });
});
