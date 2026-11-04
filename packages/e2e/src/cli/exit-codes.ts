/** The exit-code table of the CLI reference; the runner decides which one applies. */
export const EXIT_CODES: readonly (readonly [code: string, meaning: string])[] = [
  ['0', 'every selected test passed, was flaky, or was skipped'],
  ['1', 'a test failed or timed out'],
  ['2', 'CLI, config, or agent policy error'],
  ['3', 'engine, app process, model provider, artifact, or cleanup infrastructure failure'],
  ['4', 'internal runner error'],
  ['130', 'interrupted by Ctrl-C or a CI signal'],
];
