/** Initial selections for the Development template, not an inherited restriction. */
const developmentTools: Record<string, string[]> = {
    "understand": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.git#status"
    ],
    "study": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.git#status",
        "builtin.git#diff",
        "builtin.changesets#list",
        "builtin.changesets#read",
        "builtin.workflow#get"
    ],
    "changeset": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.changesets#list",
        "builtin.changesets#read",
        "builtin.changesets#write"
    ],
    "prepare-git": [
        "builtin.repositories#list",
        "builtin.files#search",
        "builtin.git#status",
        "builtin.git#command",
        "builtin.git#prepare_branch",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "implement": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.git#status",
        "builtin.git#diff",
        "builtin.files#edit",
        "builtin.files#replace",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "review-implementation": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.git#status",
        "builtin.git#diff",
        "builtin.changesets#list",
        "builtin.changesets#read"
    ],
    "verify": [
        "builtin.docker#connection",
        "builtin.docker#read",
        "builtin.docker#build",
        "builtin.docker#run",
        "builtin.docker#exec",
        "builtin.docker#remove",
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.git#status",
        "builtin.git#diff",
        "builtin.git#command",
        "builtin.tools#list",
        "builtin.tools#get",
        "builtin.tools#propose",
        "builtin.tools#implementations",
        "builtin.executions#get",
        "builtin.executions#cancel",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "memory": [
        "builtin.repositories#list",
        "builtin.repositories#browse",
        "builtin.files#search",
        "builtin.files#read",
        "builtin.context#index",
        "builtin.context#get",
        "builtin.context#update",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "commit": [
        "builtin.git#status",
        "builtin.git#commit_changeset",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "pull-request": [
        "builtin.git#status",
        "builtin.git#pull_request",
        "builtin.github#pull_request",
        "builtin.changesets#read",
        "builtin.changesets#notes"
    ],
    "complete": [
        "builtin.changesets#read"
    ]
};
export function initialStepTools(workflowId: string, stepId: string): string[] { return workflowId === 'development' ? [...developmentTools[stepId] || []] : []; }
