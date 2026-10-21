/**
 * Readiness: what a classifier or a repair would be missing if a case
 * failed now. A failure can be told apart from an intended change only
 * against the spec and the build's release notes, and replayed only in an
 * environment that can be reset, so a gap here is found on day one instead
 * of in the middle of triage. `e2e-cige check` lists every gap; the
 * reporter counts them under the run summary.
 */

import type { CigeConfig } from './config.ts';
import type { CigeCase } from './schema.ts';

/** One thing a case lacks for classification or replay. */
export type CigeGapKind = 'no-spec-ref' | 'no-build-ref' | 'build-unset' | 'environment-unset' | 'environment-undeclared' | 'environment-no-reset' | 'resolver-failed';

export interface CigeGap {
  readonly kind: CigeGapKind;
  readonly detail: string;
}

const BUILD_PLACEHOLDER = /\{build\}/;
const ENVIRONMENT_PLACEHOLDER = /\{environment\}/;

/** Every gap one case has under the config, in a fixed order; empty when it is ready. */
export function readinessGaps(testCase: CigeCase, config: Pick<CigeConfig, 'build' | 'refs' | 'environments'>): CigeGap[] {
  const { context } = testCase;
  const gaps: CigeGap[] = [];
  if (context.specRef === undefined && config.refs?.spec === undefined) {
    gaps.push({ kind: 'no-spec-ref', detail: 'no Context.specRef and no refs.spec resolver: a failure cannot be checked against the spec' });
  }
  if (context.buildRef === undefined && config.refs?.build === undefined) {
    gaps.push({ kind: 'no-build-ref', detail: 'no Context.buildRef and no refs.build resolver: a spec change cannot be confirmed as shipped' });
  }
  const refs = [context.specRef, context.buildRef, context.expectedRef].filter((ref) => ref !== undefined);
  if (refs.some((ref) => BUILD_PLACEHOLDER.test(ref)) && config.build === undefined) {
    gaps.push({ kind: 'build-unset', detail: 'a ref uses {build}, but the config sets no build; pass the CI commit or release tag' });
  }
  const environment = context.environment;
  if (environment === undefined) {
    if (refs.some((ref) => ENVIRONMENT_PLACEHOLDER.test(ref))) {
      gaps.push({ kind: 'environment-unset', detail: 'a ref uses {environment}, but the case sets no Context.environment' });
    } else if (config.environments !== undefined) {
      gaps.push({ kind: 'environment-unset', detail: 'no Context.environment: a replay runs with the default config and resets nothing' });
    }
  } else {
    const declared = config.environments === undefined || !Object.hasOwn(config.environments, environment) ? undefined : config.environments[environment];
    if (declared === undefined) {
      gaps.push({ kind: 'environment-undeclared', detail: `environment "${environment}" is not in the config's environments: a replay cannot reset it` });
    } else if (declared.reset === undefined) {
      gaps.push({ kind: 'environment-no-reset', detail: `environment "${environment}" has no reset action: recovery cannot restore it` });
    }
  }
  return gaps;
}
