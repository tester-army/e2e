/** `EngineAttemptContext.resolveSecret` for an attempt whose engine declares no secrets: a call is a bug in the test. */
export const noSecrets = (): Promise<string> => Promise.reject(new Error('this attempt declares no secrets'));

/** `EngineAttemptContext.appLog`, `screen`, and `environment` for an attempt whose test reads none of what the engine tells the trace. */
export const ignoreTrace = {
  appLog: (): void => undefined,
  screen: (): void => undefined,
  environment: (): void => undefined,
};
