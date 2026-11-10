import type { ActionTrace, RecordedAction } from './cache/trace.ts';

type ActionName = RecordedAction['name'];
type MatchingAction<N extends ActionName> = RecordedAction extends infer A
  ? A extends { name: infer Names } ? N extends Names ? A : never : never
  : never;

/** Builds one typed replay instruction. It describes an operation; the runner executes it. */
function action<N extends ActionName>(name: N) {
  return (input: Omit<MatchingAction<N>, 'name'>): RecordedAction => ({ ...input, name }) as RecordedAction;
}

/** Defines a recorded step; execution and outcome verification belong to the runner. */
function define(context: Omit<ActionTrace, 'actions'>, actions: readonly RecordedAction[]): ActionTrace {
  return { ...context, actions };
}

/** Replay-only operations retain the engine-independent recovery and verification contract. */
export const replay = {
  define,
  tap: action('tap'), doubleTap: action('doubleTap'), longPress: action('longPress'),
  secondaryTap: action('secondaryTap'), hover: action('hover'), scrollTo: action('scrollTo'),
  type: action('type'), typeSecret: action('typeSecret'), press: action('press'),
  select: action('select'), check: action('check'), upload: action('upload'), drag: action('drag'),
  scroll: action('scroll'), scrollUntil: action('scrollUntil'), navigate: action('navigate'),
  back: action('back'), resize: action('resize'), tapAt: action('tapAt'), hoverAt: action('hoverAt'),
  dragAt: action('dragAt'), typeText: action('typeText'), pressKey: action('pressKey'),
  dismissKeyboard: action('dismissKeyboard'), tool: action('tool'),
} satisfies { define: typeof define } & Record<ActionName, unknown>;
