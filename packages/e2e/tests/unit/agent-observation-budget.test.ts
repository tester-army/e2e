import { describe, expect, it } from 'vitest';
import { imageTokenUpperBound } from '../../src/agent/model/adapter.ts';
import { observationByteBudget } from '../../src/agent/observation-budget.ts';

const LIMITS = { maxObservationBytes: 262_144, maxInputTokens: 200_000 };
const INSTRUCTION_RESERVE = 4_096;
const PIXEL_RESERVE = imageTokenUpperBound({ width: 2_560, height: 1_440 });

describe('observationByteBudget', () => {
  it('returns the configured ceiling when the request leaves room for it', () => {
    expect(
      observationByteBudget({ ...LIMITS, maxInputTokens: 1_000_000 }, { fixedBytes: 10_000, instructionBytes: 0, pixels: false }),
    ).toBe(262_144);
  });

  it('clamps to the per-call token ceiling minus the request overhead', () => {
    const fixedBytes = 100_000;
    expect(observationByteBudget(LIMITS, { fixedBytes, instructionBytes: 0, pixels: false })).toBe(
      LIMITS.maxInputTokens - fixedBytes - INSTRUCTION_RESERVE,
    );
  });

  it('cuts the screen by the measured instruction, not a fixed reserve', () => {
    const fixedBytes = 100_000;
    const short = observationByteBudget(LIMITS, { fixedBytes, instructionBytes: 100, pixels: false });
    const long = observationByteBudget(LIMITS, { fixedBytes, instructionBytes: 7_888, pixels: false });
    expect(short - long).toBe(7_788);
    expect(long).toBe(LIMITS.maxInputTokens - fixedBytes - 7_888 - INSTRUCTION_RESERVE);
  });

  it('reserves the largest planned screenshot on a vision request', () => {
    const fixedBytes = 100_000;
    const text = observationByteBudget(LIMITS, { fixedBytes, instructionBytes: 0, pixels: false });
    const vision = observationByteBudget(LIMITS, { fixedBytes, instructionBytes: 0, pixels: true });
    expect(text - vision).toBe(PIXEL_RESERVE);
  });

  it('never falls below the floor a tree can still name controls under', () => {
    expect(observationByteBudget(LIMITS, { fixedBytes: 1_000_000, instructionBytes: 0, pixels: true })).toBe(1_024);
  });
});
