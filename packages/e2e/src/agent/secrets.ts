/** Host-side secret fill authorization. */

import type { SemanticNode } from '../engine/surface.ts';
import { unavailableCode } from '../secrets.ts';
import type { Secret } from '../types.ts';
import { AgentError, toAgentError } from './error.ts';
import type { AgentContext } from './invocation.ts';
import { isEditable } from '../internal/roles.ts';

/**
 * The narrow surface a secret fill needs from its step machinery: the act
 * dispatch is its one caller today, and any future tier that fills secrets
 * satisfies the same member rather than re-deriving the policy.
 */
interface SecretFillHost {
  recordPolicy(name: string, decision: 'allowed' | 'denied', code?: string): void;
}

/**
 * Authorizes one secret fill and resolves the plaintext only after every check
 * passes. The value is returned to the caller for a single immediate handoff to
 * the trusted engine and is never logged, cached, or sent to a model.
 */
export async function authorizeSecretFill(
  host: SecretFillHost,
  runtime: AgentContext,
  secret: Secret,
  node: SemanticNode,
): Promise<string> {
  const registered = runtime.config.secrets.get(secret.name);
  if (registered === undefined) {
    const code = unavailableCode(secret);
    host.recordPolicy('secret.registered', 'denied', code);
    throw new AgentError(code, `secret "${secret.name}" is not configured`);
  }

  if (node.states?.disabled === true) {
    host.recordPolicy('secret.sink', 'denied', 'POLICY_DENIED');
    throw new AgentError('POLICY_DENIED', 'the target field is disabled');
  }
  if (!isEditable(node)) {
    host.recordPolicy('secret.sink', 'denied', 'POLICY_DENIED');
    throw new AgentError(
      'POLICY_DENIED',
      `the target is not an editable input (role ${node.role ?? 'none'})`,
    );
  }
  // A password belongs in a password field, where the surface masks it. A
  // generic secret has no field of its own: it goes wherever the test says,
  // and redaction covers the value the moment it shows on screen.
  if (secret.purpose === 'password' && node.inputPurpose !== 'password') {
    host.recordPolicy('secret.purpose', 'denied', 'POLICY_DENIED');
    throw new AgentError(
      'POLICY_DENIED',
      `field purpose ${node.inputPurpose ?? 'none'} is incompatible with secret purpose ${secret.purpose}`,
    );
  }

  host.recordPolicy('secret.fill', 'allowed');
  try {
    return await runtime.secrets.resolve(secret);
  } catch (cause) {
    throw toAgentError(cause);
  }
}

