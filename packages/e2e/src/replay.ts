import type { ReplayStep, ReplayTest } from './cache/test-file.ts';
import type { ActionTrace, RecordedAction } from './cache/trace.ts';

type ActionName = RecordedAction['name'];
type MatchingAction<N extends ActionName> = RecordedAction extends infer A
  ? A extends { name: infer Names } ? N extends Names ? A : never : never
  : never;

/** Builds a typed action declaration. The cache loader reads these calls as data, never imports them. */
function action<N extends ActionName>(name: N) {
  return (input: Omit<MatchingAction<N>, 'name'>): RecordedAction => ({ ...input, name }) as RecordedAction;
}

/** Defines a recorded step; execution and outcome verification belong to the runner. */
function define(context: Omit<ActionTrace, 'actions'>, actions: readonly RecordedAction[]): ActionTrace {
  return { ...context, actions };
}

/** Groups all recorded act calls for one test in the cache directory. */
function test(context: Pick<ReplayTest, 'id' | 'testId'>, steps: readonly ReplayStep[]): ReplayTest {
  return { ...context, steps };
}

/** Records one act call's identity and position without executing it. */
function step(context: Omit<ReplayStep, 'trace'>, trace: ActionTrace): ReplayStep {
  return { ...context, trace };
}

/** Replay-only operations retain the engine-independent recovery and verification contract. */
export const replay = {
  define, test, step,
  tap: action('tap'), doubleTap: action('doubleTap'), longPress: action('longPress'),
  secondaryTap: action('secondaryTap'), hover: action('hover'), scrollTo: action('scrollTo'),
  type: action('type'), typeSecret: action('typeSecret'), press: action('press'),
  select: action('select'), check: action('check'), upload: action('upload'), drag: action('drag'),
  scroll: action('scroll'), scrollUntil: action('scrollUntil'), navigate: action('navigate'),
  back: action('back'), resize: action('resize'), tapAt: action('tapAt'), hoverAt: action('hoverAt'),
  dragAt: action('dragAt'), typeText: action('typeText'), pressKey: action('pressKey'),
  dismissKeyboard: action('dismissKeyboard'), tool: action('tool'),
} satisfies { define: typeof define; test: typeof test; step: typeof step } & Record<ActionName, unknown>;
