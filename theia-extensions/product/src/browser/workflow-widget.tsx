import { BackLink } from './back-link';
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { CommandService } from '@theia/core/lib/common/command';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WorkflowEvidenceProvider, WorkflowIssue, WorkflowService, WorkflowStep, WorkflowSummary, WorkflowView, canMoveWorkflowStep, editableStep, workflowIssues } from '../common/workflow-service';
import { ProjectToolService, SavedTool, ToolProblem } from '../common/project-tool-service';
import { WorkflowToolPicker } from './workflow-tool-picker';

@injectable()
export class WorkflowWidget extends ReactWidget {
    static readonly ID = 'governed-ide:workflow';
    @inject(WorkflowService) protected readonly workflows: WorkflowService;
    @inject(ProjectToolService) protected readonly projectTools: ProjectToolService;
    protected evidenceProviders: WorkflowEvidenceProvider[] = [];
    protected tools: SavedTool[] = []; protected unavailableTools: ToolProblem[] = [];
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(CommandService) protected readonly commands: CommandService;
    protected project = '';
    protected catalog: WorkflowSummary[] = [];
    protected screen: 'list' | 'create' | 'edit' = 'list';
    protected createName = '';
    protected createDescription = '';
    protected createSource = '';
    protected nameError = '';
    protected view?: WorkflowView;
    protected steps: WorkflowStep[] = [];
    protected nextWorkflows: string[] = [];
    protected selected?: string;
    protected dirty = false;
    protected busy = false;
    protected error = '';
    protected notice = '';
    protected issues: WorkflowIssue[] = [];
    protected dragged?: string;

    constructor() { super(); this.id = WorkflowWidget.ID; this.title.label = 'Workflow'; this.title.caption = 'Project workflow'; this.title.closable = true; this.title.iconClass = 'codicon codicon-list-ordered'; this.addClass('workflow-widget'); }
    @postConstruct() protected initialize(): void {
        this.project = this.workspace.workspace?.resource.parent.path.toString() || ''; void this.showList();
        const beforeUnload = (event: BeforeUnloadEvent) => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', beforeUnload); this.toDispose.push({ dispose: () => window.removeEventListener('beforeunload', beforeUnload) });
    }
    protected onCloseRequest(message: Message): void {
        if (!this.dirty) { super.onCloseRequest(message); return; }
        void new ConfirmDialog({ title: 'Unsaved workflow changes', msg: 'Discard the unsaved changes to this project workflow?', ok: 'Discard changes', cancel: 'Keep editing' }).open().then(discard => { if (discard) { this.dirty = false; super.onCloseRequest(message); } });
    }
    protected accept(view: WorkflowView): void {
        this.view = view; this.nextWorkflows = [...view.nextWorkflows || []]; this.steps = view.steps.map(editableStep); if (!this.steps.some(step => step.id === this.selected)) this.selected = this.steps[0]?.id;
        this.dirty = false; this.title.className = ''; this.issues = []; this.error = ''; this.update();
    }
    protected async load(id = this.view?.id || 'development'): Promise<void> {
        if (this.dirty && !await new ConfirmDialog({ title: 'Reload saved workflow', msg: 'Replace your unsaved draft with the saved project workflow?', ok: 'Reload saved', cancel: 'Keep editing' }).open()) return;
        this.busy = true; this.error = ''; this.update();
        try { this.evidenceProviders = await this.workflows.evidenceProviders(this.project); const catalog = await this.projectTools.list(this.project); this.tools = catalog.tools; this.unavailableTools = catalog.unavailable; this.catalog = await this.workflows.list(this.project); this.accept(await this.workflows.get(this.project, id)); this.screen = 'edit'; this.notice = ''; }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not load the project workflow.'; }
        finally { this.busy = false; this.update(); }
    }
    protected changed(): void { this.dirty = true; this.title.className = 'theia-mod-dirty'; this.notice = ''; if (this.issues.length && this.view) this.issues = workflowIssues(this.steps); this.update(); }
    protected change<K extends Exclude<keyof WorkflowStep, 'id'>>(field: K, value: WorkflowStep[K]): void {
        const step = this.steps.find(step => step.id === this.selected); if (!step) return; step[field] = value; this.changed();
    }
    protected move(index: number, target: number): void {
        if (index < 0 || index >= this.steps.length || target < 0 || target >= this.steps.length) return;
        const candidate = [...this.steps]; const step = candidate.splice(index, 1)[0]; candidate.splice(target, 0, step);
        this.steps = candidate; this.changed();
    }
    protected addStep(): void {
        if (this.steps.length >= 30) return;
        const step: WorkflowStep = { id: `project-${crypto.randomUUID()}`, title: 'New step', instructions: '', definitionOfReady: [], definitionOfDone: [], tools: [], approval: false, enabled: true };
        const index = this.steps.findIndex(step => step.id === this.selected); this.steps.splice(index < 0 ? this.steps.length : index + 1, 0, step); this.selected = step.id; this.changed();
    }
    protected removeStep(): void {
        const index = this.steps.findIndex(step => step.id === this.selected); if (index < 0) return;
        const removed = this.steps[index]; const dependencies = removed.dependsOn || (index ? [this.steps[index - 1].id] : []);
        this.steps.splice(index, 1);
        for (const step of this.steps) {
            if (step.dependsOn) step.dependsOn = [...new Set(step.dependsOn.flatMap(id => id === removed.id ? dependencies : [id]))];
            if (step.reworkTargets) step.reworkTargets = step.reworkTargets.filter(id => id !== removed.id);
        }
        this.selected = this.steps[Math.max(0, index - 1)]?.id; this.changed();
    }
    protected async save(): Promise<void> {
        if (!this.view) return; this.issues = workflowIssues(this.steps); this.error = '';
        if (this.issues.length) { this.selected = this.issues.find(issue => issue.stepId)?.stepId || this.selected; this.update(); return; }
        this.busy = true; this.update();
        try { this.accept(await this.workflows.save(this.project, { id: this.view.id, expectedRevision: this.view.revision, steps: this.steps.map(editableStep), nextWorkflows: this.nextWorkflows })); this.notice = 'Project workflow saved.'; }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not save the workflow. Your draft has been kept.'; }
        finally { this.busy = false; this.update(); }
    }
    protected async showList(): Promise<void> {
        if (this.dirty && !await new ConfirmDialog({ title: 'Unsaved workflow changes', msg: 'Discard changes and return to workflows?', ok: 'Discard changes', cancel: 'Keep editing' }).open()) return;
        this.busy = true; this.error = ''; this.update();
        try { this.catalog = await this.workflows.list(this.project); this.screen = 'list'; this.dirty = false; this.title.className = ''; this.notice = ''; this.issues = []; }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not load workflows.'; }
        finally { this.busy = false; this.update(); }
    }
    protected async createWorkflow(): Promise<void> {
        this.nameError = ''; this.error = '';
        const name = this.createName.trim();
        if (!name || name.length > 80) this.nameError = 'Enter a workflow name, up to 80 characters.';
        else if (this.catalog.some(item => item.name.toLowerCase() === name.toLowerCase())) this.nameError = 'A workflow with this name already exists.';
        if (this.nameError) { this.update(); return; }
        this.busy = true; this.update();
        try { const toolCatalog = await this.projectTools.list(this.project); this.tools = toolCatalog.tools; this.unavailableTools = toolCatalog.unavailable; this.accept(await this.workflows.create(this.project, { name, description: this.createDescription, ...(this.createSource ? { sourceId: this.createSource } : {}) })); this.screen = 'edit'; this.notice = 'Workflow created. Add or edit its steps below.'; }
        catch (error) { this.error = error instanceof Error ? error.message : 'Could not create workflow.'; }
        finally { this.busy = false; this.update(); }
    }
    protected renderCriteria(field: 'definitionOfReady' | 'definitionOfDone', title: string, description: string): React.ReactNode {
        const step = this.steps.find(item => item.id === this.selected); if (!step) return undefined;
        const values = step[field];
        return <fieldset className="workflow-criteria"><legend>{title}</legend><p>{description}</p>
            {values.length === 0 && <small>No criteria defined.</small>}
            {values.map((value, index) => <div className="workflow-criterion" key={index}><div className="workflow-criterion-input"><span aria-hidden="true">{index + 1}.</span><input aria-label={`${title} criterion ${index + 1}`} value={value} maxLength={300} disabled={this.busy} aria-invalid={this.invalid(`${field}.${index}`)} onChange={event => { const next = [...values]; next[index] = event.currentTarget.value; this.change(field, next); }} /><button type="button" className="context-text-button" aria-label={`Remove ${title} criterion ${index + 1}`} disabled={this.busy} onClick={() => this.change(field, values.filter((_, item) => item !== index))}>×</button></div>{this.fieldError(`${field}.${index}`)}</div>)}
            {this.fieldError(field)}
            <button type="button" className="context-secondary" disabled={this.busy || values.length >= 20} onClick={() => this.change(field, [...values, ''])}>Add criterion to {title === 'Definition of Ready' ? 'Ready' : 'Done'}</button>
        </fieldset>;
    }
    protected fieldError(field: string): React.ReactNode { const issue = this.issues.find(issue => issue.stepId === this.selected && issue.field === field); return issue && <span className="workflow-field-error" role="alert">{issue.message}</span>; }
    protected invalid(field: string): boolean { return this.issues.some(issue => issue.stepId === this.selected && issue.field === field); }
    protected renderStepLinks(field: 'dependsOn' | 'reworkTargets', title: string): React.ReactNode {
        const index = this.steps.findIndex(step => step.id === this.selected); const step = this.steps[index]; if (!step) return null;
        const selected = step[field]; const choices = this.steps.slice(0, field === 'reworkTargets' ? index + 1 : index);
        return <fieldset className="workflow-tools"><legend>{title}</legend><p>{field === 'dependsOn' ? 'Changing a dependency invalidates this result. Independent results remain valid during rework.' : 'The model may return to these steps for requested changes. Questions stay in the current review.'}</p>
            <label className="workflow-field">Selection<select aria-label={`${title} mode`} value={selected === undefined ? 'default' : 'custom'} disabled={this.busy} onChange={event => this.change(field, event.currentTarget.value === 'default' ? undefined : [])}><option value="default">{field === 'dependsOn' ? 'Previous enabled step' : 'Any current or earlier step'}</option><option value="custom">Selected steps</option></select></label>
            {selected !== undefined && <><div className="workflow-step-links">{selected.map(id => <button type="button" className="context-secondary" key={id} disabled={this.busy} aria-label={`Remove ${id} from ${title}`} onClick={() => this.change(field, selected.filter(value => value !== id))}>{this.steps.find(item => item.id === id)?.title || id} ×</button>)}</div>
            <label className="workflow-field">Add step<select aria-label={`Add ${title}`} value="" disabled={this.busy} onChange={event => { if (event.currentTarget.value) this.change(field, [...selected, event.currentTarget.value]); }}><option value="">Choose a step…</option>{choices.filter(item => !selected.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></>}{this.fieldError(field)}</fieldset>;
    }
    protected render(): React.ReactNode {
        const view = this.view; const selected = this.steps.find(step => step.id === this.selected);
        if (this.screen !== 'edit') return <div className="workflow-root"><div className="project-page workflow-page">
            <BackLink destination={this.screen === 'create' ? 'Workflows' : 'Workbench'} disabled={this.busy}
                onClick={() => this.screen === 'create' ? void this.showList() : void this.commands.executeCommand('governed-ide:open-chat')} />
            <header className="workflow-header"><div><h1>{this.screen === 'create' ? 'Create workflow' : 'Project workflows'}</h1><p>{this.screen === 'create' ? 'Start with an empty process or copy an existing workflow.' : 'Choose a workflow to edit its steps, or create a new process for this project.'}</p></div></header>
            {this.error && <div className="context-alert" role="alert">{this.error}</div>}
            {this.screen === 'list' ? <><div className="workflow-catalog-heading"><h2>Workflows</h2><button className="context-primary" disabled={this.busy} onClick={() => { this.screen = 'create'; this.createName = ''; this.createDescription = ''; this.createSource = ''; this.nameError = ''; this.update(); }}>Create workflow</button></div>{this.busy ? <p>Loading workflows…</p> : <div className="workflow-catalog">{this.catalog.map(item => <button className="workflow-catalog-card" key={item.id} onClick={() => void this.load(item.id)}><span className="workflow-catalog-icon codicon codicon-list-ordered" aria-hidden="true" /><span className="workflow-catalog-info"><strong>{item.name}</strong>{item.description && <span className="workflow-catalog-description">{item.description}</span>}</span><small>{item.stepCount} {item.stepCount === 1 ? 'step' : 'steps'}</small><span className="workflow-catalog-chevron" aria-hidden="true">›</span></button>)}</div>}</> :
            <form className="workflow-create-form" onSubmit={event => { event.preventDefault(); void this.createWorkflow(); }}>
                <label className="workflow-field">Workflow name<input aria-label="Workflow name" autoFocus value={this.createName} maxLength={80} disabled={this.busy} aria-invalid={!!this.nameError} onChange={event => { this.createName = event.currentTarget.value; this.nameError = ''; this.update(); }} />{this.nameError && <span className="workflow-field-error" role="alert">{this.nameError}</span>}</label>
                <label className="workflow-field">Description <small>Optional</small><textarea aria-label="Workflow description" value={this.createDescription} maxLength={2000} rows={3} disabled={this.busy} onChange={event => { this.createDescription = event.currentTarget.value; this.update(); }} /></label>
                <label className="workflow-field">Start from<select aria-label="Start from" value={this.createSource} disabled={this.busy} onChange={event => { this.createSource = event.currentTarget.value; this.update(); }}><option value="">Empty workflow</option>{this.catalog.map(item => <option value={item.id} key={item.id}>Copy {item.name}</option>)}</select><small>Copies are independent. Changes will only affect the new workflow.</small></label>
                <button className="context-primary" type="submit" disabled={this.busy}>{this.busy ? 'Creating…' : 'Create workflow'}</button>
            </form>}</div></div>;
        return <div className="workflow-root"><div className="project-page workflow-page">
            <BackLink destination="Workflows" disabled={this.busy} onClick={() => void this.showList()} />
            <header className="workflow-header"><div><h1>{view?.name || 'Workflow'}</h1><p>Edit this project’s process. Every step can be changed, reordered or removed.</p></div></header>
            {this.error && <div className="context-alert" role="alert">{this.error}</div>}{this.notice && <div className="workflow-notice" role="status">{this.notice}</div>}{this.issues.filter(issue => !issue.stepId).map((issue, index) => <div className="context-alert" role="alert" key={index}>{issue.message}</div>)}
            {!view ? <p>Loading workflow…</p> : <><div className="workflow-toolbar"><div><strong>{view.name}</strong><span>Independent project workflow</span></div><div className="workflow-toolbar-actions"><span className="workflow-save-status">{this.dirty ? 'Unsaved changes' : 'Saved'}</span><button className="context-secondary" disabled={this.busy} onClick={() => void this.load()}>Reload saved</button><button className="context-primary" disabled={this.busy || !this.dirty} onClick={() => void this.save()}>{this.busy ? 'Working…' : 'Save changes'}</button></div></div>
            <section className="workflow-completion-settings">
                <h2>After completion</h2>
                <p>Add workflows that can continue work in a new task.</p>
                {this.nextWorkflows.length > 0 && <ul>{this.nextWorkflows.map(id => <li key={id}>
                    <span>{this.catalog.find(item => item.id === id)?.name || id}</span>
                    <button className="context-text-button" disabled={this.busy} aria-label={`Remove follow-up ${this.catalog.find(item => item.id === id)?.name || id}`}
                        onClick={() => { this.nextWorkflows = this.nextWorkflows.filter(item => item !== id); this.changed(); }}>Remove</button>
                </li>)}</ul>}
                <label className="workflow-field">Add workflow<select aria-label="Add follow-up workflow" value="" disabled={this.busy}
                    onChange={event => { if (event.currentTarget.value) { this.nextWorkflows = [...this.nextWorkflows, event.currentTarget.value]; this.changed(); } }}>
                    <option value="">Choose a workflow…</option>
                    {this.catalog.filter(item => !this.nextWorkflows.includes(item.id) && item.stepCount > 0).map(item =>
                        <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
            </section>
            <div className="workflow-layout"><aside className="workflow-steps"><div className="workflow-list-heading"><h2>Steps</h2><button className="context-secondary" disabled={this.busy || this.steps.length >= 30} onClick={() => this.addStep()}>Add step</button></div><ol>{this.steps.map((step, index) => { return <li key={step.id} className={`${step.id === this.selected ? 'selected' : ''}${step.enabled ? '' : ' disabled'}`} draggable={!this.busy} onDragStart={() => { this.dragged = step.id; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const from = this.steps.findIndex(item => item.id === this.dragged); if (from >= 0) this.move(from, index); this.dragged = undefined; }}><button className="workflow-step-select" onClick={() => { this.selected = step.id; this.update(); }}><span className="workflow-step-number">{index + 1}</span><span><strong>{step.title || 'Untitled step'}</strong><small>{step.enabled ? 'Enabled' : 'Disabled'}</small></span></button><div className="workflow-move"><button aria-label={`Move ${step.title} up`} title="Move up" disabled={this.busy || !canMoveWorkflowStep(this.steps, index, -1)} onClick={() => this.move(index, index - 1)}>↑</button><button aria-label={`Move ${step.title} down`} title="Move down" disabled={this.busy || !canMoveWorkflowStep(this.steps, index, 1)} onClick={() => this.move(index, index + 1)}>↓</button></div></li>; })}</ol><p className="workflow-list-help">Drag any step or use the arrows to change the order.</p></aside>
            {!selected && <main className="workflow-editor"><h2>No steps yet</h2><p>Add a step to build this project’s workflow.</p></main>}{selected && <main className="workflow-editor"><div className="workflow-editor-heading"><div><h2>{selected.title || 'Untitled step'}</h2></div><button className="context-text-button workflow-remove" disabled={this.busy} onClick={() => this.removeStep()}>Remove step</button></div>
            <label className="workflow-field">Step title<input aria-label="Step title" maxLength={80} aria-invalid={this.invalid('title')} value={selected.title} disabled={this.busy} onChange={event => this.change('title', event.currentTarget.value)} />{this.fieldError('title')}</label>
            <label className="workflow-field">Instructions<textarea aria-label="Step instructions" maxLength={2000} rows={7} aria-invalid={this.invalid('instructions')} value={selected.instructions} disabled={this.busy} onChange={event => this.change('instructions', event.currentTarget.value)} /><small>Plain text or Markdown. Describe how this stage should be carried out.</small>{this.fieldError('instructions')}</label>
            {this.renderCriteria('definitionOfReady', 'Definition of Ready', 'What must be available or agreed before this step starts.')}
            {this.renderCriteria('definitionOfDone', 'Definition of Done', 'What must be true for this step to be considered complete. Record evidence when checking these criteria.')}
            {this.renderStepLinks('dependsOn', 'Result dependencies')}
            {this.renderStepLinks('reworkTargets', 'Allowed rework targets')}
            {selected.approval && <fieldset className="workflow-tools"><legend>Review safeguards</legend><p>Capture evidence with the report. Approval and later completion are rejected if the reviewed state changes.</p><div className="workflow-step-links">{(selected.reviewEvidence || []).map(id => <button type="button" className="context-secondary" key={id} disabled={this.busy} onClick={() => this.change('reviewEvidence', selected.reviewEvidence!.filter(value => value !== id))}>{this.evidenceProviders.find(item => item.id === id)?.name || id} ×</button>)}</div><label className="workflow-field">Add safeguard<select aria-label="Add review safeguard" value="" disabled={this.busy} onChange={event => { if (event.currentTarget.value) this.change('reviewEvidence', [...selected.reviewEvidence || [], event.currentTarget.value]); }}><option value="">Choose a safeguard…</option>{this.evidenceProviders.filter(item => !selected.reviewEvidence?.includes(item.id)).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{this.fieldError('reviewEvidence')}</fieldset>}

            <fieldset className="workflow-tools"><legend>Tools</legend><p>Add tools available to the model during this step. Their access rules and repository checks still apply.</p>
                <WorkflowToolPicker key={selected.id} tools={this.tools} unavailable={this.unavailableTools} selected={selected.tools || []} disabled={this.busy} onChange={ids => this.change('tools', ids)} />
                <div className="workflow-tool-support"><strong>Workflow support · always available</strong><p>{this.tools.flatMap(item=>item.workflowSupport?[item.tool.name]:(item.methods||[]).filter(method=>method.workflowSupport).map(method=>`${item.tool.name} / ${method.name}`)).join(' · ')}</p><small>Questions, readiness and step transitions. Their access rules still apply.</small></div>{this.fieldError('tools')}
            </fieldset>
            <div className="workflow-switches"><label><input type="checkbox" checked={selected.approval} disabled={this.busy} onChange={event => this.change('approval', event.currentTarget.checked)} /><span>Require user confirmation before continuing</span></label><label><input type="checkbox" checked={selected.enabled} disabled={this.busy} onChange={event => this.change('enabled', event.currentTarget.checked)} /><span>Enable this step</span></label>{this.fieldError('enabled')}</div></main>}</div>
            <p className="workflow-execution-note">Task workflows execute from a saved snapshot. The engine controls transitions and approval; criterion assessments are reported by the agent and should be reviewed with their evidence.</p></>}
        </div></div>;
    }
}
