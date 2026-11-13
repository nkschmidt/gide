import { AccessCategory } from '../common/tool-policy';
import { ToolMethodsEditor } from './tool-methods-editor';
import * as React from '@theia/core/shared/react';
import { ImplementationChoice, ProjectTool, ToolPlan } from '../common/project-tool-service';
import { LocalCommandFields, localCommandDefaults } from './local-command-fields';
export function emptyProjectTool(): ProjectTool { return { schemaVersion: 2, id: '', toolName: '', name: '', description: '', implementation: { executor: 'methods', configuration: {methods:[{id:'run',name:'Run',description:'Run a fixed project command.',implementation:{executor:'local-process',configuration:{ ...localCommandDefaults() }}}]} }, policy: { 'run--execute': 'ask' } }; }
export interface EditorProps { tool: ProjectTool; implementations?: ImplementationChoice[]; editing?: boolean; builtin?: boolean; busy?: boolean; saveLabel?: string; cancelLabel?: string; onDirty?: () => void; onReview?: (method:string)=>void; onSave: (tool: ProjectTool) => void; onCancel?: () => void; }
export function ToolEditor(props: EditorProps): React.ReactElement {
    const [tool, setTool] = React.useState(props.tool); const [json, setJson] = React.useState(JSON.stringify(props.tool.implementation.configuration.settings || props.tool.implementation.configuration, null, 2)); const [error, setError] = React.useState('');
    const change = (value: ProjectTool) => { props.onDirty?.(); setTool(value); setError(''); };
    const config = (value: Record<string, unknown>) => change({ ...tool, implementation: { ...tool.implementation, configuration: { ...tool.implementation.configuration, ...value } } });
    const choices: ImplementationChoice[] = props.implementations || [{ key: tool.implementation.executor, label: tool.implementation.executor, executor: tool.implementation.executor, configuration: tool.implementation.configuration, configurationSchema: {}, categories: Object.keys(tool.policy).map(id => ({ id, label: id.replace(/-/g, ' '), defaultDecision: 'ask' as const })) }];
    const selected = choices.find(item => item.executor === tool.implementation.executor && (item.executor !== 'handler' || (item.configuration.handler === tool.implementation.configuration.handler && item.configuration.version === tool.implementation.configuration.version)));
    const categories: AccessCategory[] = selected?.categories || Object.keys(tool.policy).map(id => ({ id, label: id.replace(/-/g, ' '), defaultDecision: 'ask' as const }));
    if (tool.implementation.executor === 'methods') return <ToolMethodsEditor {...props} tool={tool}/>;
    return <form className="tool-editor" onSubmit={event => { event.preventDefault(); try {
        if (props.builtin) { props.onSave(tool); return; }
        let next = tool;
        if (tool.implementation.executor === 'handler') { const settings = JSON.parse(json); next = { ...tool, implementation: { ...tool.implementation, configuration: { ...tool.implementation.configuration, settings } } }; }
        else if (tool.implementation.executor !== 'local-process') next = { ...tool, implementation: { ...tool.implementation, configuration: JSON.parse(json) } };
        props.onSave(next);
    } catch { setError('Enter a valid JSON configuration object.'); } }}>
        {!props.builtin && <>
        <div className="tool-form-pair"><label>Tool ID<input required disabled={props.busy || props.editing} value={tool.id} onChange={event => { const id = event.currentTarget.value; change({ ...tool, id, toolName: `project_${id.replace(/[.-]/g, '_')}`.slice(0, 64) }); }} /></label><label>Function name<input required disabled={props.busy || props.builtin} value={tool.toolName} onChange={event => change({ ...tool, toolName: event.currentTarget.value })} /></label></div>
        <label>Name<input required value={tool.name} disabled={props.busy} onChange={event => change({ ...tool, name: event.currentTarget.value })} /></label>
        <label>Description<textarea required rows={3} value={tool.description} disabled={props.busy} onChange={event => change({ ...tool, description: event.currentTarget.value })} /></label>
        <h2>Implementation</h2>
        <label>Implementation<select aria-label="Implementation" value={selected?.key || ''} disabled={props.busy} onChange={event => { const choice = choices.find(item => item.key === event.currentTarget.value); if (!choice) return; const configuration: Record<string, unknown> = choice.executor === 'local-process' ? { ...localCommandDefaults() } : { ...choice.configuration }; change({ ...tool, implementation: { executor: choice.executor, configuration }, policy: Object.fromEntries(choice.categories.map(category => [category.id, category.defaultDecision])) }); setJson(JSON.stringify(choice.executor === 'handler' ? configuration.settings || {} : configuration, null, 2)); }}>
            {!selected && <option value="">Unavailable implementation</option>}{choices.map(choice => <option value={choice.key} key={choice.key}>{choice.executor === 'handler' ? `Handler · ${choice.label}` : choice.label}</option>)}
        </select></label>
        {tool.implementation.executor === 'local-process' ? <>
            <LocalCommandFields configuration={tool.implementation.configuration} disabled={props.busy} onChange={config} />
            <p className="tool-local-notice">Local execution uses your account's file and network permissions. Keep credentials out of commands and output.</p>
        </> : tool.implementation.executor === 'handler' && (!selected || !Object.keys((selected.configurationSchema.properties || {}) as object).length) ? <p className="tool-muted">This installed handler has no configurable settings. It uses its own validated input schema.</p> : <label>{tool.implementation.executor === 'handler' ? 'Handler settings · JSON' : 'Configuration · JSON'}<textarea rows={5} value={json} disabled={props.busy} onChange={event => { props.onDirty?.(); setJson(event.currentTarget.value); setError(''); }} /></label>}
        </>}
        <h2>Access rules</h2><p className="tool-muted">Allow runs automatically. Ask requests permission. Deny blocks the action. Technical boundaries and workflow reviews remain enforced.</p>
        {categories.map(category => <label className="tool-policy-rule" key={category.id}><span>{category.label}{category.description && <small className="tool-policy-hint">{category.description}</small>}</span><select aria-label={`Policy: ${category.id}`} value={tool.policy[category.id] || 'ask'} disabled={props.busy} onChange={event => change({ ...tool, policy: { ...tool.policy, [category.id]: event.currentTarget.value as 'allow' | 'ask' | 'deny' } })}><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option></select></label>)}
        {error && <p className="chat-runtime-error" role="alert">{error}</p>}<p className="tool-muted">Saving updates this single tool manifest. It does not execute the tool.</p>
        <div className="tool-buttons"><button type="submit" className="theia-button" disabled={props.busy}>{props.saveLabel || (props.builtin ? 'Save access rules' : 'Save changes')}</button>{props.onCancel && <button type="button" className="theia-button secondary" disabled={props.busy} onClick={props.onCancel}>{props.cancelLabel}</button>}</div>
    </form>;
}
export function ToolRunReview({ plan, share }: { plan: ToolPlan; share: boolean }): React.ReactElement { return <section className="tool-run-review"><strong>{plan.tool.name} · Run tool</strong><dl>{plan.review.fields.map(field => <React.Fragment key={field.label}><dt>{field.label}</dt><dd><code>{field.value}</code></dd></React.Fragment>)}</dl><p>{plan.review.warning}</p><p>{share ? 'Up to 12,000 output characters are sent to the external model without secret filtering.' : 'This manual run keeps output locally.'}</p></section>; }
