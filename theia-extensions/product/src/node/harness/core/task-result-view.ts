export interface TaskResultView { project(text: string, resultRef: string | undefined, characters: number): string; }
/** Compact transport view; canonical result text in SQLite is never modified. */
export class BoundedTaskResultView implements TaskResultView {
    project(text: string, resultRef: string | undefined, characters: number): string {
        if (text.length <= characters) return text;
        let excerpt: unknown = text.slice(0, characters);
        try {
            const value = JSON.parse(text);
            if (value && !Array.isArray(value) && typeof value.output === 'string') {
                // Keep the actual exit/status/output ahead of potentially large source-observation metadata.
                const metadata = Object.fromEntries(['id', 'toolId', 'state', 'exitCode', 'signal', 'sourceChanged', 'truncated'].filter(key => ['string', 'number', 'boolean'].includes(typeof value[key])).map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 200) : value[key]]));
                excerpt = { ...metadata, output: value.output.slice(0, Math.floor(characters / 2)), outputTruncated: value.output.length > characters / 2, ...(typeof value.error === 'string' ? { error: value.error.slice(0, 500) } : {}) };
            }
        } catch { /* Plain text results retain an explicitly marked excerpt. */ }
        return JSON.stringify({ resultRef, truncated: true, totalCharacters: text.length, excerpt, retrieve: 'Use task_memory.read_result with this resultRef, offset and limit <=2000 for missing details. An excerpt is not the full result.' });
    }
}
