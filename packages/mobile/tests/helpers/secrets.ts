/** `EngineAttemptContext.resolveSecret` for an attempt whose engine declares no secrets: a call is a bug in the test. */
export const noSecrets = (): Promise<string> => Promise.reject(new Error('this attempt declares no secrets'));

/** `EngineAttemptContext.appLog` for an attempt whose test reads none of what the app logs. */
export const ignoreAppLog = (): void => undefined;
