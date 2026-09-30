/**
 * The agent's vocabulary by name: the tools the grammar hands a model, and
 * the names an agent step's engine events carry for what the dispatcher did.
 * Telemetry counts an agent's actions by these names and nothing else, so
 * adding an action means adding it here. A leaf module, so config resolution
 * can check a project tool's name without loading the grammar.
 */

/** The name of each grammar action, as the dispatcher records it. */
export const GRAMMAR_ACTION_NAMES = [
  'back',
  'check',
  'dismissKeyboard',
  'doubleTap',
  'dragTo',
  'hover',
  'hoverAt',
  'longPress',
  'navigate',
  'press',
  'pressKey',
  'scroll',
  'scrollIntoView',
  'scrollUntil',
  'secondaryTap',
  'selectOption',
  'setInputFiles',
  'tap',
  'tapAt',
  'type',
  'typeSecret',
  'typeText',
  'uncheck',
] as const;

/** One name of the vocabulary; what the dispatcher records an action under, so a new verb cannot slip past telemetry. */
export type GrammarActionName = (typeof GRAMMAR_ACTION_NAMES)[number];

/** The prefix of the engine event a project's own tool records; its name is the project's, and telemetry folds it away. */
export const PROJECT_TOOL_EVENT_PREFIX = 'tool:';

/**
 * The names of the agent's email tools, offered when `config.email` is set.
 * Reserved whether or not it is, so a project tool keeps its name when a
 * config adds email later.
 */
const EMAIL_TOOLS = ['new_email_address', 'wait_for_email'] as const;
export const EMAIL_TOOL_NAMES: ReadonlySet<string> = new Set<string>(EMAIL_TOOLS);

/** One of the email tools' names; the pack is typed by it, so a tool and its reserved name cannot drift apart. */
export type EmailToolName = (typeof EMAIL_TOOLS)[number];

/**
 * The tools the harness adds beside the grammar, each where it adds them:
 * `complete_step` in every agent step, `locate` and the recording tools in
 * an `e2e mcp` session, `report_finding` under `e2e explore`, and the email
 * tools in an agent step when `config.email` is set. A project
 * tool named like one would be replaced or dropped there, so the config load
 * refuses the name.
 */
export const HARNESS_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ['complete_step', 'every agent step'],
  ['locate', 'an e2e mcp session'],
  ['start_recording', 'an e2e mcp session'],
  ['stop_recording', 'an e2e mcp session'],
  ['report_finding', 'e2e explore'],
  ...EMAIL_TOOLS.map((name): [string, string] => [name, 'an agent step when config.email is set']),
]);

/**
 * Every name `createGrammarTools` may hand out. The grammar owns these in the
 * model's vocabulary whatever the engine declares, so a project tool cannot
 * take one: it would be silently shadowed on one engine and live on another.
 */
export const GRAMMAR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'observe',
  'tap',
  'double_tap',
  'long_press',
  'right_click',
  'hover',
  'type',
  'type_secret',
  'press',
  'select',
  'check',
  'scroll',
  'scroll_to',
  'drag',
  'upload',
  'navigate',
  'back',
  'screenshot',
  'tap_at',
  'hover_at',
  'type_at',
  'press_at',
  'select_at',
  'dismiss_keyboard',
]);
