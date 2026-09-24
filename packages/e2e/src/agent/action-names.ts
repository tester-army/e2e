/**
 * The names an agent step's engine events carry for what the dispatcher did.
 * Telemetry counts an agent's actions by these names and nothing else, so
 * adding an action means adding it here.
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
