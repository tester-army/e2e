/**
 * The tracks: which suite runs against which app, and which oracle scores
 * it. A track is a package directory in this repository, a config in it, and
 * either test files for `e2e run` or a goal for `e2e explore`. The bench
 * spawns the CLI in that directory with the model, port, and provider
 * options in the environment; the configs read them (see
 * `packages/web-benchmark/e2e.bench.config.ts` and
 * `packages/testbed/e2e.explore.config.ts`).
 *
 * `TASK_SET_VERSION` names the task set as a whole. Adding, removing, or
 * rewording a task bumps it; the leaderboard compares rows on one version only.
 */

export const TASK_SET_VERSION = 1;

export type TrackId = 'act' | 'judgment' | 'explore' | 'explore-clean';

/** How a run of the track is scored. */
export type Oracle = 'tests' | 'judgment' | 'explore';

export interface Track {
  readonly id: TrackId;
  readonly oracle: Oracle;
  /** Package directory, relative to the repository root. */
  readonly packageDir: string;
  /** Config file, relative to `packageDir`. */
  readonly config: string;
  readonly command: 'run' | 'explore';
  /** Test files or directories for `run`, relative to `packageDir`. */
  readonly files?: readonly string[];
  /** The exploration goal for `explore`. */
  readonly goal?: string;
  /** Extra CLI arguments. */
  readonly args?: readonly string[];
  /** Extra environment for the CLI process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the run past this; a hung provider must not hold the matrix. */
  readonly timeoutMs: number;
  readonly description: string;
}

const EXPLORE_GOAL =
  'Explore this bookshop like a careful first-time buyer: browse the catalog, add books to the cart, change quantities, remove one, check out, then visit the account, orders, and sign-in pages. Report every defect you have evidence of.';

export const TRACKS: readonly Track[] = [
  {
    id: 'act',
    oracle: 'tests',
    packageDir: 'packages/web-benchmark',
    config: 'e2e.bench.config.ts',
    command: 'run',
    files: ['tests-agent/scenarios.e2e.ts', 'tests-agent/login-form.e2e.ts'],
    timeoutMs: 40 * 60_000,
    description: 'One agent.act per benchmark scenario, then a deterministic check of the success message.',
  },
  {
    id: 'judgment',
    oracle: 'judgment',
    packageDir: 'packages/web-benchmark',
    config: 'e2e.bench.config.ts',
    command: 'run',
    files: ['tests-judgment'],
    timeoutMs: 40 * 60_000,
    description: 'agent.assert of correct behavior on planted-bug pages (must fail) and on working pages (must pass).',
  },
  {
    id: 'explore',
    oracle: 'explore',
    packageDir: 'packages/testbed',
    config: 'e2e.explore.config.ts',
    command: 'explore',
    goal: EXPLORE_GOAL,
    args: ['--max-steps', '8', '--timeout', '600000'],
    timeoutMs: 15 * 60_000,
    description: 'e2e explore against the bug garden; recall over 11 planted defects.',
  },
  {
    id: 'explore-clean',
    oracle: 'explore',
    packageDir: 'packages/testbed',
    config: 'e2e.explore.config.ts',
    command: 'explore',
    goal: EXPLORE_GOAL,
    args: ['--max-steps', '8', '--timeout', '600000'],
    env: { BUG_GARDEN_CLEAN: '1' },
    timeoutMs: 15 * 60_000,
    description: 'The same exploration against the garden with every defect fixed; every issue reported is a false positive.',
  },
];

/** Resolves track ids, failing on the first unknown one with the known list. */
export function selectTracks(ids: readonly string[]): Track[] {
  return ids.map((id) => {
    const track = TRACKS.find((candidate) => candidate.id === id);
    if (track === undefined) {
      throw new Error(`unknown track "${id}"; known tracks: ${TRACKS.map((candidate) => candidate.id).join(', ')}`);
    }
    return track;
  });
}
