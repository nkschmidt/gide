import { analyzeCommand, CommandOption, CommandProfile, hasOption, OperationAnalysis, parseArguments } from '../core/command-analysis';

const readGit = ['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'show-ref', 'describe', 'shortlog'];
const gitOptions: CommandOption[] = [
    { name: '--output', value: true, effects: ['write'] },
    ...['--format', '--pretty', '--date', '--encoding', '--since', '--until', '--author', '--committer', '--grep', '--skip', '--diff-filter', '--order-file', '--pathspec-from-file'].map(name => ({ name, value: true })),
    { name: '--max-count', aliases: ['-n'], value: true }, { name: '--message', aliases: ['-m'], value: true },
    { name: '--force', aliases: ['-f'], effects: ['delete'] }, { name: '--force-with-lease', effects: ['delete'] },
    { name: '--delete', aliases: ['-d', '-D'], effects: ['delete'] }, { name: '--discard-changes', effects: ['delete'] },
    { name: '--force-create', aliases: ['-B'], value: true, effects: ['delete'] }, { name: '--hard', effects: ['delete'] }
];
const gitReadOptions: CommandOption[] = [
    ...gitOptions.filter(option => !option.effects?.includes('delete') && !['--message', '--pathspec-from-file', '--format', '--pretty'].includes(option.name)),
    { name: '--format', value: 'optional' }, { name: '--pretty', value: 'optional' },
    ...['--short', '--porcelain', '--branch', '--untracked-files', '--ignored', '--ahead-behind', '--renames', '--no-renames', '--oneline', '--decorate', '--no-decorate', '--graph', '--all', '--branches', '--tags', '--remotes', '--first-parent', '--no-merges', '--merges', '--reverse', '--abbrev-commit', '--no-abbrev-commit', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--check', '--patch', '--no-patch', '--raw', '--binary', '--cached', '--staged', '--exit-code', '--quiet', '--no-color', '--color', '--no-ext-diff', '--no-textconv', '--no-prefix', '--full-index', '--full-name', '--relative', '--find-renames', '--find-copies', '--diff-algorithm', '--minimal', '--patience', '--histogram', '--ignore-space-at-eol', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--text', '--word-diff', '--compact-summary', '--verify', '--symbolic', '--symbolic-full-name', '--abbrev-ref', '--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--is-inside-work-tree', '--is-bare-repository', '--is-shallow-repository', '--local-env-vars', '--count', '--left-right', '--cherry-pick', '--objects', '--cached', '--others', '--exclude-standard', '--error-unmatch', '--stage', '--deleted', '--modified', '--no-empty-directory', '--recurse-submodules', '--long', '--contains', '--always', '--dirty'].map(name => ({ name, value: ['--porcelain', '--untracked-files', '--ignored', '--decorate', '--color', '--relative', '--find-renames', '--find-copies', '--word-diff', '--dirty'].includes(name) ? 'optional' as const : false })),
    ...['-p', '-s', '-u', '-U', '-W', '-w', '-b', '-B', '-D', '-M', '-C', '-R', '-z', '-a', '-r', '-t', '-l', '-v', '-d', '-f', '-1'].map(name => ({ name, value: ['-U', '-B', '-M', '-C'].includes(name) ? 'optional' as const : false }))
];
const gitProfile: CommandProfile = {
    id: 'git', fallback: { category: 'local', effects: ['unknown'] }, rules: [
        ...['add', 'rm', 'mv', 'commit', 'switch', 'checkout', 'rebase', 'merge', 'reset', 'branch', 'tag', 'apply', 'revert', 'cherry-pick', 'stash'].map(command => ({ command: [command], category: 'local', effects: ['write'] as const, options: gitOptions, unknownOptions: 'policy' as const })),
        ...readGit.map(command => ({ command: [command], category: 'read', effects: ['read'] as const, options: gitReadOptions, numericOptions: true, abbreviations: true, unknownOptions: 'policy' as const })),
        ...['fetch', 'pull', 'ls-remote'].map(command => ({ command: [command], category: 'network', effects: ['network', ...(command === 'ls-remote' ? [] : ['write'])] as OperationAnalysis['effects'], options: gitOptions, unknownOptions: 'policy' as const })),
        { command: ['push'], category: 'publish', effects: ['network', 'publish'], options: gitOptions, unknownOptions: 'policy' },
        ...['clean', 'restore'].map(command => ({ command: [command], category: 'destructive', effects: ['write', 'delete'] as const, options: gitOptions, unknownOptions: 'policy' as const }))
    ]
};
export function analyzeGitCommand(argv: readonly string[]): OperationAnalysis {
    const analysis = analyzeCommand(gitProfile, argv);
    const flags = analysis.unrecognizedFlags?.length ? { unrecognizedFlags: analysis.unrecognizedFlags } : {};
    if (!readGit.includes(argv[0]) && analysis.effects.includes('delete')) return { ...flags, category: 'destructive', effects: [...new Set([...analysis.effects, 'write' as const])] };
    if (analysis.category === 'read' && analysis.effects.includes('write')) return { ...flags, category: 'local', effects: analysis.effects };
    if (argv[0] === 'branch') {
        const parsed = parseArguments(argv.slice(1), { options: ['--list', '--all', '--remotes', '--show-current', '--verbose'].map((name, i) => ({ name, aliases: [['-l'], ['-a'], ['-r'], [], ['-v']][i] })) });
        if (!parsed.errors.length && !parsed.operands.length && parsed.options.every(option => option.known)) return { category: 'read', effects: ['read'] };
    }
    // Classify destructive flags on mutating commands, including short option clusters.
    if (!readGit.includes(argv[0]) && hasOption(parseArguments(argv.slice(1), { options: gitOptions }), '--force', '--force-with-lease', '--delete', '--discard-changes', '--force-create', '--hard')) return { ...flags, category: 'destructive', effects: ['write', 'delete'] };
    return { ...flags, category: analysis.category, effects: analysis.effects };
}

const dockerRunOptions: CommandOption[] = [
    ...['--name', '--env', '--env-file', '--mount', '--volume', '--publish', '--entrypoint', '--user', '--workdir', '--hostname', '--cpu-shares', '--network', '--memory', '--cpus', '--restart', '--device', '--cap-add', '--cap-drop', '--security-opt'].map(name => ({ name, aliases: ({ '--env': ['-e'], '--volume': ['-v'], '--publish': ['-p'], '--user': ['-u'], '--workdir': ['-w'], '--hostname': ['-h'], '--cpu-shares': ['-c'], '--memory': ['-m'] } as Record<string, string[]>)[name], value: true })),
    ...['--rm', '--interactive', '--tty', '--detach', '--init', '--privileged', '--read-only', '--publish-all'].map(name => ({ name, aliases: ({ '--interactive': ['-i'], '--tty': ['-t'], '--detach': ['-d'], '--publish-all': ['-P'] } as Record<string, string[]>)[name] }))
];
const dockerRules: CommandProfile['rules'][number][] = [];
const addDocker = (command: string[], category: string, effects: OperationAnalysis['effects'], options?: CommandOption[]) => dockerRules.push({ command, category, effects, options, unknownOptions: 'policy' });
for (const command of ['version', 'info', 'ps', 'images', 'inspect', 'logs', 'port', 'top', 'history', 'stats']) addDocker([command], 'read', ['read']);
for (const root of ['container', 'image', 'volume', 'network']) for (const command of ['ls', 'list', 'inspect']) addDocker([root, command], 'read', ['read']);
for (const command of ['logs', 'port', 'top', 'stats']) addDocker(['container', command], 'read', ['read']);
addDocker(['image', 'history'], 'read', ['read']); addDocker(['system', 'df'], 'read', ['read']);
for (const command of ['run', 'create', 'start', 'stop', 'restart', 'kill', 'pause', 'unpause']) for (const path of [[command], ['container', command]]) addDocker(path, 'run', ['execute', 'write', 'network']);
for (const path of [['exec'], ['container', 'exec']]) addDocker(path, 'exec', ['execute', 'write', 'network']);
for (const path of [['push'], ['image', 'push'], ['manifest', 'push']]) addDocker(path, 'push', ['network', 'publish']);
for (const path of [['rm'], ['rmi'], ...['container', 'image', 'volume', 'network', 'builder', 'system', 'manifest'].flatMap(root => ['rm', 'remove', 'prune'].map(command => [root, command]))]) addDocker(path, 'remove', ['delete', 'write']);
const buildOptions: CommandOption[] = [
    { name: '--builder', value: true, effects: ['unknown'] }, { name: '--output', aliases: ['-o'], value: true, effects: ['publish'] },
    { name: '--cache-to', value: true, effects: ['publish'] }, { name: '--push', effects: ['publish'] },
    ...['--tag', '--file', '--build-arg', '--label', '--target', '--platform', '--progress', '--secret', '--ssh', '--cache-from', '--network', '--add-host'].map(name => ({ name, aliases: name === '--tag' ? ['-t'] : name === '--file' ? ['-f'] : [], value: true }))
];
for (const path of [['build'], ['image', 'build']]) addDocker(path, 'build', ['execute', 'write', 'network'], buildOptions);
const dockerReadOptions: CommandOption[] = [
    ...['--format', '--filter', '--tail', '--since', '--until', '--last', '--type'].map(name => ({ name, aliases: name === '--format' ? ['-f'] : name === '--last' ? ['-n'] : [], value: true })),
    ...['--all', '--quiet', '--no-trunc', '--size', '--follow', '--timestamps', '--details', '--no-stream', '--no-resolve', '--digests', '--human', '--verbose'].map(name => ({ name, aliases: name === '--all' ? ['-a'] : name === '--quiet' ? ['-q'] : name === '--timestamps' ? ['-t'] : [] }))
];
for (const rule of dockerRules) {
    if (rule.category === 'read') { rule.options = dockerReadOptions; rule.unknownOptions = 'policy'; }
    if (['run', 'exec'].includes(rule.category)) { rule.options = dockerRunOptions; rule.stopAtOperand = true; }
}
/** This parses Docker-owned flags only; a container command's payload is opaque. */
export function parseDockerArguments(argv: readonly string[]) {
    const nested = ['container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'manifest'].includes(argv[0]);
    const command = argv[nested ? 1 : 0];
    const values: CommandOption[] = [
        ...(command === 'build' ? buildOptions : ['run', 'create', 'exec'].includes(command) ? [] : dockerReadOptions),
        ...['--host', '--context', '--config', '--tlscacert', '--tlscert', '--tlskey'].map(name => ({ name, aliases: name === '--host' ? ['-H'] : [], value: true })),
        ...dockerRunOptions,
        { name: '--tls' }, { name: '--tlsverify' }
    ];
    return parseArguments(argv.slice(argv[0]?.startsWith('-') ? 0 : nested ? 2 : 1), { options: values, stopAtOperand: ['run', 'create', 'exec'].includes(command) });
}
const dockerProfile: CommandProfile = { id: 'docker', rules: dockerRules, fallback: { category: 'manage', effects: ['unknown'] } };
export function analyzeDockerCommand(argv: readonly string[]): OperationAnalysis {
    const analysis = analyzeCommand(dockerProfile, argv);
    const flags = analysis.unrecognizedFlags?.length ? { unrecognizedFlags: analysis.unrecognizedFlags } : {};
    if (hasOption(analysis.parsed, '--builder')) return { ...flags, category: 'manage', effects: analysis.effects };
    if (analysis.effects.includes('publish')) return { ...flags, category: 'push', effects: analysis.effects };
    return { ...flags, category: analysis.category, effects: analysis.effects };
}

export const githubCommandProfile: CommandProfile = {
    id: 'gh', fallback: { category: 'execute', effects: ['execute', 'unknown'] }, rules: [
        ...[['auth', 'status'], ['pr', 'list'], ['pr', 'view']].map(command => ({ command, category: 'read', effects: ['read', 'network'] as const, options: ['--hostname', '--repo', '--state', '--head', '--base', '--json', '--limit'].map(name => ({ name, value: true })) })),
        { command: ['pr', 'create'], category: 'publish', effects: ['write', 'network', 'publish'], options: ['--repo', '--head', '--base', '--title', '--body'].map(name => ({ name, value: true })) }
    ]
};
