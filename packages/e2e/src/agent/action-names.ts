/**
 * The names an agent step's engine events carry for what the dispatcher did.
 * Telemetry counts an agent's actions by these names and nothing else, so
 * adding an action means adding it here.
 */

/** The name of each grammar action, as the dispatcher records it. */
export const GRAMMAR_ACTION_NAMES = [
  'dismissKeyboard',
  'navigate',
  'press',
  'pressKey',
  'scroll',
  'selectOption',
  'tap',
  'type',
  'typeSecret',
  'typeText',
] as const;

/** The prefix of the engine event a project's own tool records; its name is the project's, and telemetry folds it away. */
export const PROJECT_TOOL_EVENT_PREFIX = 'tool:';
