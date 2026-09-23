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

/** The prefix of the engine event a project's own tool records; its name is the project's, and telemetry folds it away. */
export const PROJECT_TOOL_EVENT_PREFIX = 'tool:';
