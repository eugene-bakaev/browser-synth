import type { ProfileStore } from './ProfileStore.js';

// In-memory ProfileStore for unit tests and the no-database fallback path.
export class InMemoryProfileStore implements ProfileStore {
  private readonly usernames = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [id, name] of Object.entries(seed)) this.usernames.set(id, name);
  }

  async getUsername(userId: string): Promise<string | null> {
    return this.usernames.get(userId) ?? null;
  }

  set(userId: string, username: string): void {
    this.usernames.set(userId, username);
  }
}
