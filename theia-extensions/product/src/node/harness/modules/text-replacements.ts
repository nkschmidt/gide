import { SafeToolError } from './file-tools';
export interface TextReplacement { oldText: string; newText: string; expectedMatches: number; }
/** Literal sed-style substitutions, without platform-specific regexes, scripts or file IO. */
export function replaceText(content: string, value: unknown): { content: string; changedOccurrences: number } {
    if (!Array.isArray(value) || !value.length || value.length > 20 || Buffer.byteLength(JSON.stringify(value)) > 64000) throw new SafeToolError('Pass 1–20 literal replacements within 64,000 bytes.');
    let changedOccurrences = 0;
    for (const item of value as TextReplacement[]) {
        if (!item || Object.keys(item).sort().join(',') !== 'expectedMatches,newText,oldText' || typeof item.oldText !== 'string' || !item.oldText || typeof item.newText !== 'string' || item.oldText.includes('\0') || item.newText.includes('\0') || item.oldText === item.newText || !Number.isInteger(item.expectedMatches) || item.expectedMatches < 1 || item.expectedMatches > 1000) throw new SafeToolError('Each replacement needs nonempty oldText, different newText and expectedMatches from 1 to 1000. No regexes or escape expansion.');
        let count = 0; let offset = 0; let position: number;
        while ((position = content.indexOf(item.oldText, offset)) >= 0) { count++; if (count > item.expectedMatches) break; offset = position + item.oldText.length; }
        if (count !== item.expectedMatches) throw new SafeToolError(`Replacement expected ${item.expectedMatches} occurrence(s), but found ${count > item.expectedMatches ? 'more than expected' : count}. Search current source and provide a precise fragment. Nothing was written.`);
        const size = Buffer.byteLength(content) + count * (Buffer.byteLength(item.newText) - Buffer.byteLength(item.oldText));
        if (size > 131072) throw new SafeToolError('Replacement result exceeds the 128 KiB repository-edit limit. Nothing was written.');
        content = content.split(item.oldText).join(item.newText); changedOccurrences += count;
    }
    return { content, changedOccurrences };
}
