import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ToolJob } from '../../../common/project-tool-service';
export class ExecutionStore {
    private db?: DatabaseSync;
    constructor(private readonly file: string) { }
    private database(): DatabaseSync {
        if (!this.db) {
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(this.file); chmodSync(this.file, 0o600);
            this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project);');
            try {
                const jobs = this.db.prepare('SELECT body FROM jobs').all().map(row => JSON.parse(String(row.body)) as ToolJob);
                if (jobs.some(job => job.tool?.schemaVersion !== 2)) throw new Error('Unsupported tool execution format. Only current tool manifests are supported.');
                for (const job of jobs) if (['running', 'cancelling'].includes(job.state)) { job.state = 'interrupted'; job.finishedAt = Date.now(); job.error = 'Application stopped before the result was recorded. No automatic replay.'; this.put(job); }
            } catch (error) { const failed = this.db; this.db = undefined; failed.close(); throw error; }
        } return this.db;
    }
    open(): void { this.database(); }
    close(): void { this.db?.close(); this.db = undefined; }
    put(job: ToolJob): void { this.database().prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(job.id, job.project, JSON.stringify(job)); }
    list(project: string): ToolJob[] { return this.database().prepare('SELECT body FROM jobs WHERE project=? ORDER BY rowid DESC LIMIT 50').all(project).map(row => JSON.parse(String(row.body))); }
    get(project: string, id: string): ToolJob | undefined { const row = this.database().prepare('SELECT body FROM jobs WHERE project=? AND id=?').get(project, id); return row ? JSON.parse(String(row.body)) : undefined; }
}
