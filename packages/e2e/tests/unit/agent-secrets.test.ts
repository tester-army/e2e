/**
 * Host-side secret fill authorization against the node shapes engines
 * project. The Android password field is the case that motivated it: the
 * mobile engine once projected it as a plain textbox, which this policy
 * refuses for a credential's password, so the shape core accepts is pinned
 * here next to the shape it turns away.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agent/invocation.ts';
import { authorizeSecretFill } from '../../src/agent/secrets.ts';
import type { ResolvedCredential, ResolvedSecret } from '../../src/config/resolve.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { secretBrand } from '../../src/internal/brands.ts';
import type { Secret } from '../../src/types.ts';
import { credentials, setSecretRegistry } from '../../src/secrets.ts';

const adminPassword: ResolvedSecret = { name: 'admin.password', purpose: 'password', value: 'hunter2' };
const admin: ResolvedCredential = { name: 'admin', username: 'admin@example.com', password: adminPassword };

afterEach(() => {
  setSecretRegistry(undefined);
});

/** The two members `authorizeSecretFill` reads off the runtime, over one registered credential. */
function runtime(): AgentContext {
  return {
    config: { allSecrets: new Map([[adminPassword.name, adminPassword]]) },
    secrets: { resolve: async () => adminPassword.value },
  } as unknown as AgentContext;
}

function host(): { decisions: string[]; recordPolicy: (name: string, decision: string, code?: string) => void } {
  const decisions: string[] = [];
  return {
    decisions,
    recordPolicy: (name, decision, code) => {
      decisions.push(code === undefined ? `${name}:${decision}` : `${name}:${decision}:${code}`);
    },
  };
}

/**
 * An Android password `EditText` as `@e2e-dev/mobile` projects it: UIAutomator
 * flags it `password` while the class stays the plain one, so the engine
 * derives `secure` and the purpose from the flag and drops the value.
 */
const androidPasswordField: SemanticNode = {
  ref: { id: 'n3', revision: '' },
  role: 'textbox',
  name: 'Password',
  text: 'Password',
  inputPurpose: 'password',
  states: { secure: true },
  testId: 'com.example:id/password',
  rect: { x: 0, y: 270, width: 390, height: 44 },
  selector: 'id=com.example:id/password',
};

/** The same field as the engine projected it before it read the flag: an open textbox carrying the typed value. */
const asPlainTextbox: SemanticNode = {
  ref: { id: 'n3', revision: '' },
  role: 'textbox',
  name: 'Password',
  text: 'Password',
  value: 'hunter2',
  testId: 'com.example:id/password',
  rect: { x: 0, y: 270, width: 390, height: 44 },
  selector: 'id=com.example:id/password',
};

describe('authorizeSecretFill', () => {
  it('lets a credential password into an Android password field as the mobile engine projects it', async () => {
    setSecretRegistry({ credentials: new Map([[admin.name, admin]]), secrets: new Map(), allSecrets: new Map([[adminPassword.name, adminPassword]]) });
    const recorder = host();
    await expect(authorizeSecretFill(recorder, runtime(), credentials.user('admin').password, androidPasswordField)).resolves.toBe(
      'hunter2',
    );
    expect(recorder.decisions).toEqual(['secret.fill:allowed']);
  });

  it('refuses the same field projected as a plain textbox, the shape before the mobile fix', async () => {
    setSecretRegistry({ credentials: new Map([[admin.name, admin]]), secrets: new Map(), allSecrets: new Map([[adminPassword.name, adminPassword]]) });
    const recorder = host();
    await expect(authorizeSecretFill(recorder, runtime(), credentials.user('admin').password, asPlainTextbox)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: 'field purpose none is incompatible with secret purpose password',
    });
    expect(recorder.decisions).toEqual(['secret.purpose:denied:POLICY_DENIED']);
  });

  it('judges the purpose by the config, not by what a handle claims', async () => {
    const claimsGeneric: Secret = Object.freeze({ name: adminPassword.name, purpose: 'generic-secret', [secretBrand]: true as const });
    const recorder = host();
    await expect(authorizeSecretFill(recorder, runtime(), claimsGeneric, asPlainTextbox)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: 'field purpose none is incompatible with secret purpose password',
    });
    expect(recorder.decisions).toEqual(['secret.purpose:denied:POLICY_DENIED']);
  });
});
