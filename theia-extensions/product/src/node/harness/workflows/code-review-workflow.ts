import { WorkflowDefinition, WorkflowStep } from '../../../common/workflow-service';

const readTools = [
    'builtin.repositories#list', 'builtin.repositories#browse', 'builtin.files#search',
    'builtin.files#read', 'builtin.context#index', 'builtin.context#get',
    'builtin.git#status', 'builtin.git#diff', 'builtin.git#command'
];
const step = (id: string, title: string, instructions: string, done: string): WorkflowStep => ({
    id, title, instructions, tools: [...readTools],
    definitionOfReady: [], definitionOfDone: [done], approval: false, enabled: true
});

export const CodeReviewWorkflow: WorkflowDefinition = {
    id: 'code-review', version: '1.0.0', name: 'Code Review',
    description: 'Review a change for correctness, regressions and verification gaps.',
    nextWorkflows: [],
    steps: [
        step('scope', 'Identify the change',
            'If this task follows another task, read its source overview and relevant step reports using task memory. Identify repositories, ChangeSets, base and feature commits. Inspect the actual current Git state and agree any missing scope with ask_user. Treat source results as historical evidence. Establish the review scope without modifying files or Git state.',
            'The repositories, change range and review scope are identified from source evidence.'),
        step('review', 'Review the code',
            'Read the diff and relevant code. Check correctness, regressions, architectural conventions and missing verification. Prioritize concrete actionable issues with file and line references, impact and reasoning. Inspect existing source context as needed. Use read-only Git commands. Keep findings in this task and leave repository files and branches intact.',
            'The scoped change was reviewed and concrete findings or an explicit no-findings conclusion are recorded.'),
        step('report', 'Present the review',
            'Present a concise Markdown review in the user’s language. Put actionable findings first, ranked by severity, with file and line references. State what was examined, unresolved questions and verification limitations. If no actionable issues were found, say so explicitly. Report this final step to complete the review task.',
            'The user receives the review findings and scope or a no-findings result with its verification limitations.')
    ]
};
