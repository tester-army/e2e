import { AgentError } from 'e2e/agent';
/**
 * MODEL_UNAVAILABLE for a missing API key, naming the environment variable
 * from the SDK's own message when it names one. Only that identifier is
 * kept, never the rest of the text.
 */
export function missingKey(role: 'decision' | 'field-text', error: Error): AgentError {
  const variable = /\bthe ([A-Z][A-Z0-9_]*) environment variable\b/.exec(error.message)?.[1];
  const message = variable === undefined
    ? `Set the ${role} model API key.`
    : `Set ${variable} to the ${role} model API key.`;
  return new AgentError('MODEL_UNAVAILABLE', message);
}
