/** Host-side secret fill authorization (spec 04-resources.md, 14-security.md). */

import type { TargetSession, OperationContext, SemanticNode } from '../backend/surface.ts';
import type { Secret } from '../types.ts';
import { AgentError, toAgentError } from './error.ts';
import type { AgentContext } from './invocation.ts';

/**
 * The narrow surface a secret fill needs from its step machinery. Both the
 * locate/judgment tier (Invocation) and the executor socket (ActDispatch)
 * satisfy it, so the authorization policy has exactly one implementation.
 */
export interface SecretFillHost {
  readonly session: TargetSession;
  operation(): OperationContext;
  recordPolicy(name: string, decision: 'allowed' | 'denied', code?: string): void;
}

/** Roles that expose an editable secure input sink. */
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * Authorizes one secret fill and resolves the plaintext only after every check
 * passes. The value is returned to the caller for a single immediate handoff to
 * the trusted backend and is never logged, cached, or sent to a model.
 */
export async function authorizeSecretFill(
  host: SecretFillHost,
  runtime: AgentContext,
  secret: Secret,
  node: SemanticNode,
): Promise<string> {
  const credential = runtime.config.credentials.get(secret.name);
  if (credential === undefined) {
    host.recordPolicy('secret.registered', 'denied', 'AUTH_CREDENTIAL_UNAVAILABLE');
    throw new AgentError(
      'AUTH_CREDENTIAL_UNAVAILABLE',
      `credential "${secret.name}" is not configured`,
    );
  }

  const origin = await currentOrigin(host);
  const appAllows = runtime.config.app.allowedOrigins.includes(origin);
  const credentialAllows =
    credential.allowedOrigins === undefined || credential.allowedOrigins.includes(origin);
  if (!appAllows || !credentialAllows) {
    host.recordPolicy('secret.origin', 'denied', 'POLICY_DENIED');
    throw new AgentError(
      'POLICY_DENIED',
      `origin ${origin} is not authorized for secret "${secret.name}"`,
    );
  }

  if (node.states?.disabled === true) {
    host.recordPolicy('secret.sink', 'denied', 'POLICY_DENIED');
    throw new AgentError('POLICY_DENIED', 'the target field is disabled');
  }
  if (node.role === undefined || !EDITABLE_ROLES.has(node.role)) {
    host.recordPolicy('secret.sink', 'denied', 'POLICY_DENIED');
    throw new AgentError(
      'POLICY_DENIED',
      `the target is not an editable input (role ${node.role ?? 'none'})`,
    );
  }
  if (node.inputPurpose !== secret.purpose) {
    host.recordPolicy('secret.purpose', 'denied', 'POLICY_DENIED');
    throw new AgentError(
      'POLICY_DENIED',
      `field purpose ${node.inputPurpose ?? 'none'} is incompatible with secret purpose ${secret.purpose}`,
    );
  }

  host.recordPolicy('secret.fill', 'allowed');
  try {
    return runtime.secrets.resolve(secret);
  } catch (cause) {
    throw toAgentError(cause);
  }
}

/** Reads the current top-level origin for origin policy checks. */
async function currentOrigin(host: SecretFillHost): Promise<string> {
  const url = host.session.url;
  if (url === undefined) {
    throw new AgentError(
      'POLICY_DENIED',
      'secret fills require a backend that exposes the current top-level URL',
    );
  }
  let href: string;
  try {
    href = await url(host.operation());
  } catch (cause) {
    throw toAgentError(cause);
  }
  try {
    return new URL(href).origin;
  } catch {
    throw new AgentError('POLICY_DENIED', `the current URL ${href} is not a valid origin`);
  }
}
