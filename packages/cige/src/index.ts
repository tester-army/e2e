/**
 * CIGE test cases on e2e: Context, Intent, Guardrails, and Execution as a
 * portable JSON file, registered as tests by `cigeSuite`, and summarized for
 * the agents that classify and repair them by the `cige()` reporter. The
 * standard: https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard
 */

export { cigeSuite, cigeTag, CIGE_TAG, type CigeSuiteOptions } from './suite.ts';
export { runCige, type CigeHook, type CigeHooks, type RunCigeOptions } from './run.ts';
export { loadCigeCases, loadCigeFile, type CigeRoot, type LoadOptions } from './load.ts';
export { cige, type CigeReporterOptions, type CigeRunSummary } from './reporter.ts';
export { classifyResult, type CigeClassification, type CigeFailureType, type CigePhase } from './classify.ts';
export { createGuardrailMonitor } from './guardrails.ts';
export { actInstruction, intentAssertion, renderAgentContext } from './render.ts';
export {
  CigeValidationError,
  parseCige,
  type CigeCase,
  type CigeContext,
  type CigeEvidence,
  type CigeExecutionStep,
  type CigeGuardrail,
  type CigeIntent,
  type CigePrecondition,
  type CigeTestCase,
} from './schema.ts';
