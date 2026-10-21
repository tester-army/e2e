/**
 * Variants: one case, several combinations of its dimensions. Intent,
 * Guardrails, and evidence are shared; a variant only fills the case's
 * `{name}` placeholders and says where it runs. An `act` step hands its
 * values to `agent.act` as params, so the runner substitutes them and the
 * cache keys on them; the judgment statements take no params, so their
 * placeholders are filled here, where the judge reads the concrete value.
 */

import { placeholdersIn, type CigeCase, type CigeExecutionStep, type CigeVariant } from './schema.ts';

function fill(text: string, params: CigeVariant['params']): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** One step with the variant's values: params for an `act`, filled text for a `verify`. */
function resolveStep(step: CigeExecutionStep, params: CigeVariant['params']): CigeExecutionStep {
  if (step.kind === 'verify') return { ...step, text: fill(step.text, params) };
  const used = placeholdersIn(step.text).filter((name) => Object.hasOwn(params, name));
  if (used.length === 0) return step;
  return { ...step, params: { ...step.params, ...Object.fromEntries(used.map((name) => [name, params[name]])) } };
}

/** The case resolved for one of its variants. */
function resolveVariant(testCase: CigeCase, variant: CigeVariant): CigeCase {
  const { params } = variant;
  const { intent, context } = testCase;
  return {
    ...testCase,
    variant: variant.id,
    params,
    context: {
      ...context,
      ...(variant.platforms === undefined ? {} : { platforms: variant.platforms }),
      ...(variant.agent === undefined ? {} : { agent: variant.agent }),
      ...(variant.session === undefined ? {} : { session: variant.session }),
    },
    intent: {
      ...intent,
      statement: fill(intent.statement, params),
      success: intent.success.map((line) => fill(line, params)),
      failure: intent.failure.map((line) => fill(line, params)),
      evidence: intent.evidence.map((item) => (item.kind === 'assert' ? { ...item, text: fill(item.text, params) } : item)),
    },
    execution: testCase.execution.map((step) => resolveStep(step, params)),
  };
}

/**
 * The cases a case runs as: itself when it has no variants, else one
 * resolved case per variant, in the order the file lists them.
 */
export function expandVariants(testCase: CigeCase): readonly CigeCase[] {
  if (testCase.variant !== undefined || testCase.variants.length === 0) return [testCase];
  return testCase.variants.map((variant) => resolveVariant(testCase, variant));
}

/** The case `expandVariants` resolved for `variant`, or the case itself when `variant` is undefined. */
export function caseForVariant(testCase: CigeCase, variant: string | undefined): CigeCase | undefined {
  if (variant === undefined) return testCase.variants.length === 0 ? testCase : undefined;
  return expandVariants(testCase).find((resolved) => resolved.variant === variant);
}
