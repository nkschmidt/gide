import { initialStepTools } from '../../../common/workflow-tool-defaults';
import { WorkflowDefinition } from '../../../common/workflow-service';

export const DevelopmentWorkflow: WorkflowDefinition = {
    "id": "development",
    "version": "1.2.0",
    "name": "Development",
    "description": "Agree on the task, research existing architecture, approve a ChangeSet, prepare clean feature branches, implement and verify focused changes.",
    nextWorkflows: ["code-review"],
    "steps": [
        {
            "id": "understand",
            "tools": initialStepTools("development", "understand"),
            "title": "Understand the task",
            "instructions": "Read the request from the task chat. Describe the problem, desired behavior, scope, exclusions, constraints and observable acceptance criteria. Resolve questions using the conversation and available project information; ask the user about unresolved product decisions instead of guessing. If uncertainty blocks a correct solution, wait for clarification. Present the resulting task brief in chat and obtain explicit user confirmation before studying the implementation.",
            "definitionOfReady": [
                "The user request and relevant conversation are available."
            ],
            "definitionOfDone": [
                "The problem, desired behavior, scope and exclusions are recorded in a concise task brief.",
                "Constraints and observable acceptance criteria are documented.",
                "Blocking ambiguities are resolved; remaining assumptions are explicitly stated.",
                "The task brief is presented in chat for user approval."
            ],
            "approval": true,
            "enabled": true
        },
        {
            "id": "study",
            "tools": initialStepTools("development", "study"),
            "title": "Study the project",
            "instructions": "Use the approved task brief to identify the required repositories and affected modules, services and their dependencies. Request relevant saved context topics, then verify them against representative current source and existing implementation examples. Identify architecture boundaries, data access, integrations, conventions and test approaches relevant to this task. Inspect Git state in each affected repository: current branch, default or agreed base branch, staged/unstaged changes, untracked files and conflicts. If unrelated changes, conflicts or an unexpected branch are found, stop and ask how to proceed; never discard, commit or stash another change automatically. Do not edit implementation files during research. Record a focused impact map, existing patterns with source references, risks and unresolved questions.",
            "definitionOfReady": [
                "The user has approved the task brief.",
                "Connected repositories and relevant project context are accessible."
            ],
            "definitionOfDone": [
                "Required repositories, affected modules and relevant dependencies are identified.",
                "Existing architecture patterns and representative source examples are documented with references.",
                "Relevant tests, integration contracts, data changes and compatibility risks are identified.",
                "Current Git branches, expected base branches and working-tree state are recorded; unexpected state is resolved with the user.",
                "There is enough verified context to prepare a concrete ChangeSet, with no blocking technical questions."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "changeset",
            "tools": initialStepTools("development", "changeset"),
            "title": "Prepare the ChangeSet",
            "instructions": "Create a task-specific Markdown file under changesets/ in the project folder, using a unique descriptive filename. Describe the problem, key idea, scope and exclusions, current approach, proposed changes per repository/module/file or symbol, dependencies, data/API impacts, planned base and feature branches, risks and verification plan. State the expected behavior and acceptance criteria precisely. Reference the studied project patterns and source examples. Distinguish confirmed implementation targets from provisional ones; resolve blocking uncertainty rather than inventing file locations. Include a scoped checklist of changes. Show the user a concise summary and a link to the saved Markdown file in chat, then wait for explicit approval of this revision. If scope or approach changes later, revise the ChangeSet and obtain approval again before implementing the deviation.",
            "definitionOfReady": [
                "The task brief is approved and project research is complete.",
                "Affected repositories, modules, existing patterns and relevant Git state are known.",
                "Blocking product and technical questions have been resolved."
            ],
            "definitionOfDone": [
                "A unique Markdown ChangeSet is saved in changesets/ and linked in chat.",
                "The ChangeSet specifies why, where and how changes will be made and what observable result is expected.",
                "Per-repository changes, architecture references, risks and verification criteria are documented.",
                "The proposed ChangeSet revision is presented to the user for approval."
            ],
            "approval": true,
            "enabled": true
        },
        {
            "id": "prepare-git",
            "tools": initialStepTools("development", "prepare-git"),
            "title": "Prepare feature branches",
            "instructions": "After ChangeSet approval, recheck Git state in every repository that will be changed. On a repeat pass, revalidate the recorded task branch with git.prepare_branch instead of creating another branch. Only unchanged task-owned edits covered by the current approved scope may remain; resolve other changes with the user. For initial branch creation, Require a clean working tree, including staged/unstaged changes, untracked files and no merge/rebase conflicts. Verify the agreed base branch: use the repository default (main or master) or an explicitly agreed alternative; do not assume the branch is named master. If the tree is dirty, the current branch is unexpected or base freshness cannot be established, stop, explain the state and ask the user to resolve or approve a specific course of action. Never automatically reset, clean, stash, commit or overwrite existing work. Once each repository is clean and on the agreed current base, create and check out a new task-specific feature branch, without reusing or overwriting an existing branch. Record the actual base commit and feature branch for every affected repository in the ChangeSet. If setup only partly succeeds, report the partial state and stop before implementation.",
            "definitionOfReady": [
                "The user has approved the current saved ChangeSet revision.",
                "The repositories to modify and planned branch names are identified."
            ],
            "definitionOfDone": [
                "Each repository has no unresolved Git operation and is either clean for initial creation or has only verified task-owned edits for revalidation.",
                "The agreed main/master or alternative base branch and base commit are verified.",
                "A new feature branch is prepared, or the recorded task branch is revalidated without resetting or discarding work.",
                "Actual repository, base commit and feature branch details are recorded in the ChangeSet; there are no setup blockers."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "implement",
            "tools": initialStepTools("development", "implement"),
            "title": "Implement the ChangeSet",
            "instructions": "Implement only the approved ChangeSet on the prepared feature branches. Use the studied project context, architecture boundaries, existing patterns and implementation examples. Make focused changes sufficient for the acceptance criteria; avoid unrelated refactoring, speculative abstractions, new dependencies or extra functionality. Add or adjust relevant tests with the code. Preserve other work; if unexpected edits appear, stop and clarify ownership. If a material scope, architecture or contract change is needed, update the ChangeSet and request user approval before proceeding. Keep the ChangeSet checklist and implementation notes accurate. Do not claim edits that were not performed or automatically commit, push or merge.",
            "definitionOfReady": [
                "The current ChangeSet revision is explicitly approved.",
                "Feature-branch preparation is complete for every repository to modify.",
                "The required project context, source references and relevant permissions are available."
            ],
            "definitionOfDone": [
                "The approved ChangeSet changes and relevant tests are implemented in the intended repositories.",
                "The implementation follows the studied architecture and patterns without unrelated changes.",
                "The ChangeSet checklist records actual changes and any approved deviations.",
                "Changed files and repository branches are identified; the work is ready for user review."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "review-implementation",
            "title": "Review implementation",
            "tools": initialStepTools("development", "review-implementation"),
            "dependsOn": ["implement"],
            "reworkTargets": ["understand", "study", "changeset", "implement"],
            "reviewEvidence": ["repository-source"],
            "instructions": "Review the actual implementation against the approved ChangeSet and inspect the current Git diff. Present a concise Markdown explanation of what changed, why, any remaining limitations and a link to the ChangeSet. The engine adds the factual changed-file list and pins the reviewed source state. Clearly distinguish implementation from verification: checks come next and must not be claimed as passed yet. Do not edit or execute verification commands here. Submit the result with workflow.report to obtain the user's explicit confirmation. The user can ask questions in chat without leaving this review. For an explicit request to adjust code within the approved scope, use workflow.revise to return to implement; for changed scope reopen the appropriate agreement or ChangeSet step. Never treat an ordinary chat message as approval.",
            "definitionOfReady": ["The implementation result and approved ChangeSet are available."],
            "definitionOfDone": [
                "The actual diff has been inspected against the approved scope.",
                "The user receives a concise explanation of the implementation, remaining limitations and ChangeSet link.",
                "Verification is clearly identified as the next stage; no unperformed check is claimed as passed."
            ],
            "approval": true,
            "enabled": true
        },
        {
            "id": "verify",
            "tools": initialStepTools("development", "verify"),
            "title": "Verify the result",
            "instructions": "Verify the implementation against each acceptance criterion in the approved ChangeSet. Inspect the final diff for missing changes, unrelated edits and violations of the studied architecture. Run the relevant available tests, type checks, lint and builds; verify user-visible scenarios and cross-repository contracts where affected. For fixes, check the original failure and the corrected behavior when feasible. Record commands or scenarios, actual results and supporting evidence. Distinguish new failures from established baseline problems. Fix failures within the approved scope and rerun affected checks; obtain approval before changing scope. Report checks that failed, were blocked or were not run; never label them as passed. Present a concise verification report in chat and link it from the ChangeSet. Do not automatically commit, push, deploy or merge.",
            "definitionOfReady": [
                "The current implementation has passed the configured user review, and relevant tests are available.",
                "Acceptance criteria and the required verification environment are known."
            ],
            "definitionOfDone": [
                "Every acceptance criterion has a recorded result and evidence, or an explicit unresolved blocker.",
                "Relevant tests, static checks, builds and affected interaction scenarios have actual recorded results.",
                "The final diff is reviewed for scope, architecture consistency and unrelated changes.",
                "Known failures, unperformed checks and residual risks are clearly reported; unresolved acceptance blockers prevent a success claim.",
                "The ChangeSet includes verification results and the user receives a concise report in chat."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "memory",
            "tools": initialStepTools("development", "memory"),
            "title": "Update project memory",
            "instructions": "After verification, identify only architecture topics affected by the approved and implemented change. Update observations and source references, or explain why existing memory remains accurate. Keep source code and task history out of architecture summaries. Link relevant topic updates from the ChangeSet. Do not describe unimplemented plans or unresolved verification failures as completed work.",
            "definitionOfReady": [
                "The actual implementation and verification results are documented.",
                "The affected architecture topics can be identified from the final changes."
            ],
            "definitionOfDone": [
                "Affected architecture topics are updated with current source references, or a reason for leaving memory unchanged is recorded.",
                "Memory contains concise verified observations without source-code copies or task history.",
                "The ChangeSet references relevant memory updates or the no-change decision."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "commit",
            "tools": initialStepTools("development", "commit"),
            "title": "Commit changes",
            "instructions": "After Update project memory, use git.commit_changeset once per changed repository to create a local commit from the approved ChangeSet. Use a concise message describing the change. Check the actual commit hash. If no files changed, record that there is nothing to commit. If repository state is unexpected or Git cannot commit, report the blocker. Record each repository, feature branch and commit hash in the ChangeSet execution notes. Do not publish here.",
            "definitionOfReady": [
                "Implementation and verification results are recorded, and the project memory step is complete."
            ],
            "definitionOfDone": [
                "Each changed repository has a local commit on its task branch with its hash recorded in the ChangeSet, or there were no changes to commit."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "pull-request",
            "tools": initialStepTools("development", "pull-request"),
            "title": "Create pull request",
            "instructions": "For each local task commit, use github.pull_request for a GitHub remote or git.pull_request for other remotes. The tool asks the user to confirm the exact push destination, commit and PR text. If the user chooses to keep the commit local, record that decision and do not publish. Record the confirmed PR/MR URL when available. If the branch was published and the tool returns a browser link, record that the user can finish in the browser. Report a blocker or partial result accurately. Do not merge or retry a denied proposal. Skip publication when there were no changes.",
            "definitionOfReady": [
                "Local task commits or a no-changes outcome are documented."
            ],
            "definitionOfDone": [
                "The ChangeSet records the PR/MR URL, the published branch and browser link, the choice to keep the commit local, a concrete publishing blocker, or that there were no changes."
            ],
            "approval": false,
            "enabled": true
        },
        {
            "id": "complete",
            "tools": initialStepTools("development", "complete"),
            "title": "Complete task",
            "instructions": "Summarize the outcome for the user in the workflow report. Include the ChangeSet, verification results and limitations, and the actual local commit and PR/MR status for each affected repository. If the user still needs to submit the PR form, say so and include the link. Reporting this final step closes the task and preserves its history.",
            "definitionOfReady": [
                "The ChangeSet records the outcome of the work and the publication decision or blocker."
            ],
            "definitionOfDone": [
                "The final task summary records what changed, what was verified, and the actual commit and publication outcomes."
            ],
            "approval": false,
            "enabled": true
        }
    ]
};
