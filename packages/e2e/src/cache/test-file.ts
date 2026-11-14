import type { ActionTrace } from './trace.ts';

/** A test execution variant whose recordings can be updated independently. */
export interface ReplayVariant {
  readonly project: string;
  readonly target: string;
  readonly agent: string;
}

/** One recorded act call, in execution order within its variant. */
export interface ReplayStep {
  readonly key: string;
  readonly variant: ReplayVariant;
  readonly order: number;
  readonly trace: ActionTrace;
}

/** All recorded act calls belonging to one collected test identity. */
export interface ReplayTest {
  /** SHA-256 of the unredacted collected test identity; the display identity may be redacted. */
  readonly id: string;
  readonly testId: string;
  readonly steps: readonly ReplayStep[];
}
