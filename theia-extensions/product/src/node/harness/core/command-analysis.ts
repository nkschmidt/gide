/** Semantic descriptions are supplied by installed implementations, never by model arguments. */
import { OperationAnalysis, ToolEffect } from '../../../common/tool-policy';
export { OperationAnalysis, ToolEffect } from '../../../common/tool-policy';
export interface CommandOption { name: string; aliases?: readonly string[]; value?: boolean | 'optional'; effects?: readonly ToolEffect[]; }
export interface ParsedOption { name: string; value?: string; token: string; known: boolean; }
export interface ParsedArguments { options: ParsedOption[]; operands: string[]; literalOperands: string[]; errors: string[]; }
export interface ArgumentSyntax { options?: readonly CommandOption[]; abbreviations?: boolean; stopAtOperand?: boolean; numericOptions?: boolean; }

/** Parses argv only: no shell expansion, filesystem access or execution. `--` is never an option. */
export function parseArguments(argv: readonly string[], syntax: ArgumentSyntax = {}): ParsedArguments {
    const result: ParsedArguments = { options: [], operands: [], literalOperands: [], errors: [] };
    const definitions = syntax.options || []; let literal = false;
    const match = (name: string): CommandOption | undefined => {
        const exact = definitions.find(option => [option.name, ...(option.aliases || [])].includes(name));
        if (exact || !syntax.abbreviations || !name.startsWith('--') || name.length <= 2) return exact;
        const candidates = definitions.filter(option => [option.name, ...(option.aliases || [])].some(alias => alias.startsWith(name)));
        return candidates.length === 1 ? candidates[0] : undefined;
    };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (literal) { result.operands.push(token); result.literalOperands.push(token); continue; }
        if (token === '--') { literal = true; continue; }
        if (syntax.numericOptions && /^-\d+$/.test(token)) { result.options.push({ name: '-n', value: token.slice(1), token, known: true }); continue; }
        if (!token.startsWith('-') || token === '-') { result.operands.push(token); if (syntax.stopAtOperand) literal = true; continue; }
        const equal = token.indexOf('=');
        const names = token.startsWith('--') ? [equal < 0 ? token : token.slice(0, equal)] : token.slice(1).split('').map(letter => '-' + letter);
        for (let offset = 0; offset < names.length; offset++) {
            const name = names[offset]; const definition = match(name);
            let value = token.startsWith('--') && equal >= 0 ? token.slice(equal + 1) : undefined;
            if (definition?.value) {
                if (!token.startsWith('--') && offset + 1 < names.length) { value = token.slice(offset + 2); offset = names.length; }
                if (value === undefined && definition.value !== 'optional') { if (index + 1 < argv.length && argv[index + 1] !== '--') value = argv[++index]; else result.errors.push(`Missing value for ${name}.`); }
            } else if (definition && value !== undefined) result.errors.push(`Unexpected value for ${name}.`);
            result.options.push({ name: definition?.name || name, value, token, known: !!definition });
        }
    }
    return result;
}
export function hasOption(parsed: ParsedArguments, ...names: string[]): boolean { return parsed.options.some(option => names.includes(option.name)); }
export function isReadOnly(operation: OperationAnalysis): boolean { return operation.effects.length > 0 && operation.effects.every(effect => effect === 'read'); }
/** Unknown flags on a declared read operation need separate policy review, not a feature branch. */
export function requiresSourceScope(operation: OperationAnalysis): boolean { return operation.effects.some(effect => ['write', 'delete', 'execute', 'publish'].includes(effect)) || (operation.effects.includes('unknown') && !operation.effects.includes('read')); }
export interface CommandRule extends ArgumentSyntax { command: readonly string[]; category: string; effects: readonly ToolEffect[]; unknownOptions?: 'accept' | 'conservative' | 'policy'; }
export interface CommandProfile { id: string; rules: readonly CommandRule[]; fallback: OperationAnalysis; }
export interface CommandAnalysis extends OperationAnalysis { profile: string; command: readonly string[]; parsed: ParsedArguments; }
/** Longest command path wins; unfamiliar semantics never inherit a read-only classification. */
export function analyzeCommand(profile: CommandProfile, argv: readonly string[]): CommandAnalysis {
    const rule = [...profile.rules].sort((a, b) => b.command.length - a.command.length).find(candidate => candidate.command.every((part, index) => argv[index] === part));
    const command = rule?.command || argv.slice(0, 1); const parsed = parseArguments(argv.slice(command.length), rule);
    const unrecognizedFlags = [...new Set(parsed.options.filter(option => !option.known).map(option => option.token))];
    const uncertain = !rule || parsed.errors.length > 0 || (!['accept', 'policy'].includes(rule.unknownOptions || '') && unrecognizedFlags.length > 0);
    const operation = uncertain ? profile.fallback : { category: rule.category, effects: [...new Set([...rule.effects, ...parsed.options.flatMap(option => rule.options?.find(definition => definition.name === option.name)?.effects || []), ...(rule.unknownOptions === 'policy' && unrecognizedFlags.length ? ['unknown' as const] : [])])] };
    return { ...operation, ...(unrecognizedFlags.length ? { unrecognizedFlags } : {}), profile: profile.id, command, parsed };
}
