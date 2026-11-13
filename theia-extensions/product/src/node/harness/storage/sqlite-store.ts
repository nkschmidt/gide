import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { Action, Approval, isTaskClosed, Message, Run, Task, TaskEvent } from '../../../common/task-service';
import { HarnessStore } from '../core/contracts';
import { InteractionRequest } from '../../../common/interaction';
import { createHash } from 'crypto';
import { TaskCheckpoint, TaskResult } from '../../../common/task-memory';
import { historyDigest } from '../core/task-memory-history';

export class SqliteStore implements HarnessStore {
    private readonly db: DatabaseSync;
    private readonly normalizedTasks = new Set<string>();
    constructor(file: string) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file); chmodSync(file, 0o600);
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (![0, 5, 6].includes(version)) { this.db.close(); throw new Error('Unsupported task database format.'); }
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_path TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_path);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, body TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(task_id) WHERE state IN ('running','awaiting_approval');
            CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
            CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
            CREATE INDEX IF NOT EXISTS actions_run ON actions(run_id);
            CREATE INDEX IF NOT EXISTS approvals_action ON approvals(action_id);
            CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
            CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), request_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task_id,request_key));
            CREATE INDEX IF NOT EXISTS interactions_task ON interactions(task_id);
            CREATE TABLE IF NOT EXISTS task_results(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS task_results_task ON task_results(task_id);
            CREATE TABLE IF NOT EXISTS task_checkpoints(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(task_id,version));
            CREATE INDEX IF NOT EXISTS task_checkpoints_task ON task_checkpoints(task_id,version);`);
        this.db.exec('PRAGMA user_version=6');
    }
    close(): void { this.db.close(); }
    transaction<T>(operation: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); this.normalizedTasks.clear(); throw error; }
    }
    private get<T>(table: string, id: string): T {
        const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
        if (!row) throw new Error('The requested record does not exist.');
        return JSON.parse(row.body as string);
    }
    private list<T>(table: string, column: string, id: string): T[] { return this.db.prepare(`SELECT body FROM ${table} WHERE ${column}=? ORDER BY rowid`).all(id).map(row => JSON.parse(row.body as string)); }
    tasks(projectPath: string): Task[] { return this.list<Task>('tasks', 'project_path', projectPath).sort((a, b) => b.updatedAt - a.updatedAt); }
    task(id: string): Task { return this.get('tasks', id); }
    putTask(task: Task): void { this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, task.projectPath, JSON.stringify(task)); }
    private storeResult(taskId: string, text: string): string {
        const id = 'result:' + createHash('sha256').update(taskId).update('\0').update(text).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO task_results VALUES(?,?,?)').run(id, taskId, text); return id;
    }
    result(taskId: string, id: string): TaskResult {
        const row = this.db.prepare('SELECT text FROM task_results WHERE id=? AND task_id=?').get(id, taskId);
        if (!row) throw new Error('Result not found in this task.'); return { id, taskId, text: row.text as string };
    }
    /** Lossless normalization of existing records; action and message reference the same stored result. */
    private normalize(taskId: string): void {
        if (this.normalizedTasks.has(taskId)) return;
        for (const row of this.db.prepare('SELECT actions.body FROM actions JOIN runs ON runs.id=actions.run_id WHERE runs.task_id=?').all(taskId)) {
            const action = JSON.parse(row.body as string) as Action; if (action.result !== undefined) this.putAction(action);
        }
        for (const message of this.list<Message>('messages', 'task_id', taskId)) if (message.role === 'tool' && !message.resultRef) this.putMessage(message);
        this.normalizedTasks.add(taskId);
    }
    messageRecords(taskId: string): Message[] { this.normalize(taskId); return this.list('messages', 'task_id', taskId); }
    messages(taskId: string): Message[] { return this.messageRecords(taskId).map(message => message.resultRef ? { ...message, text: this.result(taskId, message.resultRef).text } : message); }
    putMessage(message: Message): void {
        const stored = message.role === 'tool' ? { ...message, resultRef: message.resultRef && !message.text ? message.resultRef : this.storeResult(message.taskId, message.text), text: '' } : message;
        this.db.prepare('INSERT INTO messages VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(message.id, message.taskId, JSON.stringify(stored));
    }
    checkpoint(taskId: string): TaskCheckpoint | undefined {
        const row = this.db.prepare('SELECT body FROM task_checkpoints WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId); return row ? JSON.parse(row.body as string) : undefined;
    }
    putCheckpoint(checkpoint: TaskCheckpoint, expectedId?: string): void {
        this.transaction(() => {
            const head = this.checkpoint(checkpoint.taskId);
            if (head?.id !== expectedId || checkpoint.version !== (head?.version || 0) + 1) throw new Error('Task summary changed during preparation.');
            const history = this.messageRecords(checkpoint.taskId).filter(message => !message.localOnly); const index = history.findIndex(message => message.id === checkpoint.throughMessageId);
            if (index < 0 || historyDigest(history.slice(0, index + 1)) !== checkpoint.sourceHash) throw new Error('Task history changed during summary preparation.');
            this.db.prepare('INSERT INTO task_checkpoints VALUES(?,?,?,?)').run(checkpoint.id, checkpoint.taskId, checkpoint.version, JSON.stringify(checkpoint));
        });
    }
    runs(taskId: string): Run[] { return this.list('runs', 'task_id', taskId); }
    pendingRuns(): Run[] { return this.db.prepare("SELECT body FROM runs WHERE state='awaiting_approval'").all().map(row => JSON.parse(row.body as string)); }
    run(id: string): Run { return this.get('runs', id); }
    putRun(run: Run): void { this.db.prepare('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body').run(run.id, run.taskId, run.state, JSON.stringify(run)); }
    private hydrateAction(action: Action & { resultRef?: string }): Action { return action.resultRef ? { ...action, result: this.result(action.taskId, action.resultRef).text } : action; }
    actions(runId: string): Action[] { return this.list<Action>('actions', 'run_id', runId).map(action => this.hydrateAction(action)); }
    action(id: string): Action { return this.hydrateAction(this.get('actions', id)); }
    putAction(action: Action): void {
        const { result, ...rest } = action; const stored = result !== undefined ? { ...rest, resultRef: this.storeResult(action.taskId, result) } : rest;
        this.db.prepare('INSERT INTO actions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(action.id, action.runId, JSON.stringify(stored));
    }
    approvals(actionId: string): Approval[] { return this.list('approvals', 'action_id', actionId); }
    interaction(id: string): InteractionRequest { return this.get('interactions', id); }
    interactions(taskId: string): InteractionRequest[] { return this.list('interactions', 'task_id', taskId); }
    putInteraction(request: InteractionRequest): void { this.db.prepare('INSERT INTO interactions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(request.id, request.taskId, request.key, JSON.stringify(request)); }
    putApproval(approval: Approval): void { this.db.prepare('INSERT INTO approvals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(approval.id, approval.actionId, JSON.stringify(approval)); }
    event(taskId: string, runId: string | undefined, type: string, data: Record<string, unknown> = {}): void {
        this.db.prepare('INSERT INTO events(task_id,run_id,type,data,created_at) VALUES(?,?,?,?,?)').run(taskId, runId || null, type, JSON.stringify(data), Date.now());
    }
    events(taskId: string): TaskEvent[] {
        return this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT 100) ORDER BY id').all(taskId).map(row => ({ id: row.id as number, taskId, runId: row.run_id as string | undefined, type: row.type as string, data: JSON.parse(row.data as string), createdAt: row.created_at as number }));
    }
    recover(): void {
        this.transaction(() => {
            const runs = this.db.prepare("SELECT body FROM runs WHERE state='running'").all().map(row => JSON.parse(row.body as string) as Run);
            for (const run of runs) {
                run.state = 'interrupted'; run.error = 'The application stopped during this run. Review and continue explicitly.'; run.updatedAt = Date.now(); this.putRun(run);
                const task = this.task(run.taskId); task.state = isTaskClosed(task) ? 'completed' : 'interrupted'; this.putTask(task);
                for (const request of this.interactions(task.id).filter(item => item.runId === run.id && item.state === 'pending')) { request.state = 'invalidated'; request.resolvedAt = Date.now(); this.putInteraction(request); }
                for (const action of this.actions(run.id)) {
                    if (['requested', 'running', 'awaiting_approval'].includes(action.state)) {
                        action.state = 'interrupted'; action.updatedAt = Date.now(); action.error = 'Execution interrupted; not retried automatically.'; this.putAction(action);
                        for (const approval of this.approvals(action.id).filter(item => item.state === 'pending')) { approval.state = 'revoked'; this.putApproval(approval); }
                    }
                    if (run.kind === 'model' && !this.messages(task.id).some(message => message.callId === action.callId && message.role === 'tool')) this.putMessage({ id: `result:${action.id}`, taskId: task.id, runId: run.id, role: 'tool', callId: action.callId, text: JSON.stringify({ error: action.error || 'Execution interrupted.' }), createdAt: Date.now() });
                }
                this.event(task.id, run.id, 'run.interrupted');
            }
        });
    }
}
