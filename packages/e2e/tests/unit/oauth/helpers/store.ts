import type { CredentialStore, OAuthCredentials } from '../../../../src/oauth/types.ts';

/** An in-memory store: the tests' way to hand a login to a constructor without a file. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, OAuthCredentials>();
  constructor(initial: Record<string, OAuthCredentials> = {}) {
    for (const [id, credentials] of Object.entries(initial)) this.entries.set(id, credentials);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries.get(providerId);
  }
  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    this.entries.set(providerId, credentials);
  }
  async remove(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
  async list(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}
