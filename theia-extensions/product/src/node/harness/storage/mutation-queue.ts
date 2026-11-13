/** Serialize this application's project mutations; outside edits are checked again by digest. */
export class MutationQueue {
    private readonly pending = new Map<string, Promise<unknown>>();
    async run<T>(key: string, action: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(key) || Promise.resolve();
        const next = previous.catch(() => undefined).then(action); this.pending.set(key, next);
        try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
    }
}
export const projectMutations = new MutationQueue();
