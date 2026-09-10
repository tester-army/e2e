/**
 * The model arms: which models the bench runs, how each is reached, and what
 * it costs. Every arm is a Vercel AI Gateway id (one key, provider-reported
 * cost), accepts tool calls and images, and is an exact id, never a moving
 * alias. Standard variants only: the gateway's `-fast` ids are the same model
 * with priority processing at double price, and the reference arm is the one
 * exception because it is what the PR gate runs.
 *
 * Pricing is USD per million tokens as the gateway listed it on `asOf`; it
 * prices non-gateway arms and reprices old runs, and it is the second cost
 * figure next to the provider-reported one.
 */

export type Tier = 'frontier' | 'premium' | 'mid' | 'budget';

export interface Pricing {
  readonly input: number;
  readonly output: number;
  /** Discounted rate for prompt-cache reads; undefined when the vendor lists none. */
  readonly cacheRead: number | undefined;
  /** The day the numbers were read off the gateway catalog. */
  readonly asOf: string;
}

export interface Arm {
  /** Short stable id used in run directories, results, and the CLI. */
  readonly id: string;
  /** The gateway model id the config wraps in `gateway()`. */
  readonly model: string;
  readonly tier: Tier;
  readonly openWeights: boolean;
  /** Runs in the first matrix only, kept or dropped on evidence. */
  readonly calibrationOnly: boolean;
  readonly pricing: Pricing;
  /** AI SDK provider options the config sends with every call (effort sweeps). */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Why the arm is in the bench, one line for the methodology page. */
  readonly why: string;
}

const AS_OF = '2026-09-10';

/** The arm the harness time series is measured with: the model the PR gate runs. */
export const REFERENCE_ARM = 'luna-fast';

const ARMS: readonly Arm[] = [
  {
    id: 'luna-fast',
    model: 'openai/gpt-5.6-luna-fast',
    tier: 'budget',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 0.4, output: 2.4, cacheRead: 0.04, asOf: AS_OF },
    why: 'The PR-gate model; the harness time series holds it fixed.',
  },
  {
    id: 'luna',
    model: 'openai/gpt-5.6-luna',
    tier: 'budget',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, asOf: AS_OF },
    why: 'Same model as the reference at half price; shows what -fast buys. Vision-bench winner (100%, 16 px).',
  },
  {
    id: 'gpt-6-astra',
    model: 'openai/gpt-6-astra',
    tier: 'frontier',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 10, output: 50, cacheRead: 1, asOf: AS_OF },
    why: 'Newest frontier model (2026-09-04): ScreenSpot-Pro 92.7, Stagehand Mind2Web 87%.',
  },
  {
    id: 'fable-5.1',
    model: 'anthropic/claude-fable-5.1',
    tier: 'frontier',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 10, output: 50, cacheRead: 0.25, asOf: AS_OF },
    why: 'OSWorld 2.0 and Terminal-Bench 2.1 leader on vendor runs. Rejects forced tool choice; the loop falls back to auto.',
  },
  {
    id: 'opus-5',
    model: 'anthropic/claude-opus-5',
    tier: 'frontier',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 5, output: 25, cacheRead: 0.5, asOf: AS_OF },
    why: 'tau2 airline 80.1, BrowseComp 90.8; the premium practical Claude.',
  },
  {
    id: 'sonnet-5',
    model: 'anthropic/claude-sonnet-5',
    tier: 'premium',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 2, output: 10, cacheRead: 0.2, asOf: AS_OF },
    why: '100% grounding in vision-bench (128 px center error), OSWorld-V 81.2, TesterArmy production allowlist.',
  },
  {
    id: 'sol',
    model: 'openai/gpt-5.6-sol',
    tier: 'premium',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 2, output: 10, cacheRead: 0.2, asOf: AS_OF },
    why: 'OSWorld-V 83.2, BrowseComp 92.2, Terminal-Bench 2 91.9; TesterArmy production allowlist.',
  },
  {
    id: 'grok-4.6',
    model: 'spacexai/grok-4.6',
    tier: 'premium',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 2, output: 6, cacheRead: 0.5, asOf: AS_OF },
    why: 'Second by gateway token volume, TesterArmy allowlist, no public UI-agent score: the bench supplies one.',
  },
  {
    id: 'kimi-k3',
    model: 'moonshotai/kimi-k3',
    tier: 'premium',
    openWeights: true,
    calibrationOnly: false,
    pricing: { input: 3, output: 15, cacheRead: 0.3, asOf: AS_OF },
    why: 'OSWorld-V 84.8, Toolathlon 76.5; found 8/11 garden defects as k3-fast.',
  },
  {
    id: 'qwen3.8-max',
    model: 'alibaba/qwen3.8-max-0902',
    tier: 'premium',
    openWeights: true,
    calibrationOnly: false,
    pricing: { input: 2, output: 6, cacheRead: 0.25, asOf: AS_OF },
    why: 'OSWorld-V 86.1 and AndroidWorld 85.3 leader, ScreenSpot-Pro 84.5; the dated id is pinned.',
  },
  {
    id: 'gemini-3.8-flash',
    model: 'google/gemini-3.8-flash',
    tier: 'mid',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 0.75, output: 3.75, cacheRead: 0.075, asOf: AS_OF },
    why: 'The 3.6 Flash line was the best garden explorer (10/11, zero noise). Price doubles on 2027-01-01.',
  },
  {
    id: 'haiku-4.5',
    model: 'anthropic/claude-haiku-4.5',
    tier: 'mid',
    openWeights: false,
    calibrationOnly: false,
    pricing: { input: 1, output: 5, cacheRead: 0.1, asOf: AS_OF },
    why: 'Small-Claude baseline; weak so far (3/11 garden, 50% grounding). Earliest retirement 2026-10-15.',
  },
  {
    id: 'glm-5.3-flash',
    model: 'zai/glm-5.3-flash',
    tier: 'budget',
    openWeights: true,
    calibrationOnly: false,
    pricing: { input: 0.15, output: 0.5, cacheRead: 0.03, asOf: AS_OF },
    why: 'Most-used model on the gateway and Toolathlon-Verified leader; GLM-5.1 scored 0% on a public QA flow.',
  },
  {
    id: 'deepseek-v4.1-flash',
    model: 'deepseek/deepseek-v4.1-flash',
    tier: 'budget',
    openWeights: true,
    calibrationOnly: false,
    pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, asOf: AS_OF },
    why: 'Cheapest floor with image input (released 2026-09-08); no independent evals yet.',
  },
  {
    id: 'qwen3.8-27b',
    model: 'alibaba/qwen3.8-27b',
    tier: 'budget',
    openWeights: true,
    calibrationOnly: false,
    pricing: { input: 0.5, output: 3, cacheRead: 0.1, asOf: AS_OF },
    why: 'The only single-GPU open model on UI-agent boards: OSWorld-V 84.3, AndroidWorld 81.9.',
  },
  {
    id: 'terra',
    model: 'openai/gpt-5.6-terra',
    tier: 'premium',
    openWeights: false,
    calibrationOnly: true,
    pricing: { input: 2, output: 12, cacheRead: 0.2, asOf: AS_OF },
    why: 'Fastest in vision-bench with 100% grounding; kept if it beats Sol.',
  },
  {
    id: 'muse-spark-1.3',
    model: 'meta/muse-spark-1.3',
    tier: 'mid',
    openWeights: false,
    calibrationOnly: true,
    pricing: { input: 1.25, output: 4.25, cacheRead: 0.15, asOf: AS_OF },
    why: 'GDPval 1703 but 12-37% clicks on 1.1 in vision-bench.',
  },
  {
    id: 'minimax-m3',
    model: 'minimax/minimax-m3',
    tier: 'budget',
    openWeights: true,
    calibrationOnly: true,
    pricing: { input: 0.3, output: 1.2, cacheRead: 0.06, asOf: AS_OF },
    why: 'Third by gateway token volume, no UI-agent scores anywhere.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    model: 'google/gemini-3.5-flash-lite',
    tier: 'budget',
    openWeights: false,
    calibrationOnly: true,
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.03, asOf: AS_OF },
    why: 'The Lite line flipped pass/fail run to run in a public QA flow test.',
  },
  {
    id: 'mistral-medium-3.5',
    model: 'mistral/mistral-medium-3.5',
    tier: 'mid',
    openWeights: true,
    calibrationOnly: true,
    pricing: { input: 1.5, output: 7.5, cacheRead: undefined, asOf: AS_OF },
    why: 'The only EU vendor; absent from every UI-agent leaderboard.',
  },
];

/** Resolves arm ids, failing on the first unknown one with the known list. */
export function selectArms(ids: readonly string[]): Arm[] {
  return ids.map((id) => {
    const arm = ARMS.find((candidate) => candidate.id === id);
    if (arm === undefined) {
      throw new Error(`unknown arm "${id}"; known arms: ${ARMS.map((candidate) => candidate.id).join(', ')}`);
    }
    return arm;
  });
}

/** The leaderboard set: every arm that is not calibration-only. */
export function coreArms(): Arm[] {
  return ARMS.filter((arm) => !arm.calibrationOnly);
}

/** What a run's tokens cost at list price, cache reads at their discounted rate when listed. */
export function tableCostUsd(
  pricing: Pricing,
  tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number },
): number {
  const cacheRate = pricing.cacheRead ?? pricing.input;
  const freshInput = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens);
  return (freshInput * pricing.input + tokens.cacheReadTokens * cacheRate + tokens.outputTokens * pricing.output) / 1_000_000;
}
