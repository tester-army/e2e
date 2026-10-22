/**
 * Runtime guardrails. The prose of every guardrail reaches the acting agent
 * on each `act` instruction (see `render.ts`); a guardrail with `deny` is
 * also checked by the runner after every action an `act` step completes,
 * model-chosen or replayed from the cache. `onAction` runs once the action
 * has happened, so a match cannot undo it: it stops the step at once with
 * `POLICY_DENIED`, and the run summary names the guardrail, so a recorded
 * path that a strengthened guardrail now forbids fails on its next replay
 * instead of passing.
 */

import { AgentError, type ActionEvent, type ActionHook } from 'e2e';

import type { CigeGuardrailViolation } from './plugins.ts';
import { ID_PATTERN, type CigeGuardrail } from './schema.ts';

const VIOLATION = /CIGE guardrail ([A-Za-z0-9][A-Za-z0-9._-]*) violated/;

/** The guardrail a failure message names, when the failure was a guardrail violation. */
export function violatedGuardrail(message: string | undefined): string | undefined {
  return message === undefined ? undefined : VIOLATION.exec(message)?.[1];
}

function actionMatches(denied: string, action: string): boolean {
  return denied.endsWith('*') ? action.startsWith(denied.slice(0, -1)) : action === denied;
}

/** The first guardrail the action breaks, if any. */
export function breakingGuardrail(guardrails: readonly CigeGuardrail[], event: Pick<ActionEvent, 'action' | 'summary'>): CigeGuardrail | undefined {
  return guardrails.find((rule) => {
    const deny = rule.deny;
    if (deny === undefined) return false;
    if (deny.actions?.some((denied) => actionMatches(denied, event.action)) === true) return true;
    return deny.summary?.some((pattern) => new RegExp(pattern, 'i').test(event.summary)) === true;
  });
}

/**
 * The `onAction` hook that enforces the structured guardrails, then any
 * plugin checks (`check`), whose violations stop the step the same way and
 * read back the same in a run summary. It returns undefined when there is
 * nothing to enforce, so such a case passes no hook at all.
 */
export function createGuardrailMonitor(
  guardrails: readonly CigeGuardrail[],
  check?: (event: ActionEvent) => CigeGuardrailViolation | undefined,
): ActionHook | undefined {
  if (check === undefined && !guardrails.some((rule) => rule.deny !== undefined)) return undefined;
  return (event) => {
    const broken = breakingGuardrail(guardrails, event);
    if (broken !== undefined) {
      throw new AgentError(
        'POLICY_DENIED',
        `CIGE guardrail ${broken.id} violated by ${event.action} (${event.source}): ${event.summary}. Guardrail: ${broken.rule}`,
      );
    }
    const violation = check?.(event);
    if (violation === undefined) return;
    if (!ID_PATTERN.test(violation.guardrail)) {
      // The summary reads the guardrail back by id; one it can't parse would lose the violation.
      throw new Error(`a plugin's onAction named guardrail ${JSON.stringify(violation.guardrail)}, which is not an id (letters, digits, dots, dashes, underscores)`);
    }
    throw new AgentError('POLICY_DENIED', `CIGE guardrail ${violation.guardrail} violated by ${event.action} (${event.source}): ${event.summary}. ${violation.reason}`);
  };
}
