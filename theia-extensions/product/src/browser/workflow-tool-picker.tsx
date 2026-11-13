import * as React from '@theia/core/shared/react';
import { splitMethodRef, methodRef } from '../common/tool-methods';
import { SavedTool, ToolProblem } from '../common/project-tool-service';
interface Props { tools: SavedTool[]; unavailable: ToolProblem[]; selected: string[]; disabled: boolean; onChange: (ids: string[]) => void; }
export function WorkflowToolPicker({ tools, unavailable, selected, disabled, onChange }: Props): React.ReactElement {
    const [query, setQuery] = React.useState(''); const [open, setOpen] = React.useState(false);
    const input = React.useRef<HTMLInputElement>(null); const options = React.useRef<HTMLDivElement>(null);
    const addedTools = React.useRef<HTMLDivElement>(null);
    const listId = React.useId();
    const groups = [...new Set(selected.map(ref=>splitMethodRef(ref).id))];
    const matches = tools.filter(item=>!item.workflowSupport).flatMap(item=>{
        const all=selected.includes(item.tool.id); if(all)return [];
        if(!item.methods)return [{id:item.tool.id,name:item.tool.name,hint:item.functionName}];
        const methods=item.methods.filter(method=>!method.workflowSupport&&!selected.includes(methodRef(item.tool.id,method.id)));
        return [...(methods.length?[{id:item.tool.id,name:item.tool.name,hint:'All methods'}]:[]),...methods.map(method=>({id:methodRef(item.tool.id,method.id),name:`${item.tool.name} · ${method.name}`,hint:`${item.functionName}.${method.id}`}))];
    }).filter(item=>`${item.name} ${item.hint}`.toLowerCase().includes(query.trim().toLowerCase()));
    const add = (id: string) => { if(disabled||selected.includes(id))return;const ref=splitMethodRef(id);const next=ref.method?selected:selected.filter(value=>splitMethodRef(value).id!==ref.id);onChange([id,...next]);if(addedTools.current)addedTools.current.scrollTop=0;setQuery('');setOpen(false); };
    return <div className="workflow-tool-picker">
        <div className="workflow-selected-tools" aria-label="Added tools" ref={addedTools}>
            <small>{groups.length} {groups.length===1?'tool added':'tools added'}</small>
            {!groups.length&&<p className="workflow-no-tools">No tools added yet.</p>}
            {groups.map(id=>{const item=tools.find(tool=>tool.tool.id===id);const problem=unavailable.find(tool=>tool.id===id);const refs=selected.filter(ref=>splitMethodRef(ref).id===id);const all=refs.includes(id);
                return <div className={`workflow-selected-tool${item?'':' workflow-tool-missing'}`} key={id}><span><strong>{item?.tool.name||problem?.name||id}</strong>
                    <small>{item?item.functionName:problem?.error||'Not installed or unavailable.'}</small>
                    {item?.methods&&<div className="workflow-method-chips">{all?<small>All available methods</small>:refs.map(ref=>{const method=splitMethodRef(ref).method;const name=item.methods?.find(value=>value.id===method)?.name||method;return <button type="button" key={ref} disabled={disabled} aria-label={`Remove ${item.tool.name} method ${name}`} onClick={()=>onChange(selected.filter(value=>value!==ref))}>{name} <span aria-hidden="true">×</span></button>;})}</div>}
                </span><button type="button" className="workflow-tool-remove" aria-label={`Remove ${item?.tool.name||id}`} title="Remove tool" disabled={disabled} onClick={()=>onChange(selected.filter(ref=>splitMethodRef(ref).id!==id))}>×</button></div>;
            })}
        </div>
        <div className="workflow-tool-add" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); input.current?.focus(); setOpen(false); } }}>
            <div className="workflow-tool-search-row">
                <input ref={input} className="workflow-tool-search" type="search" role="combobox" aria-label="Find tools to add" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" placeholder="Find a tool to add…" disabled={disabled} value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.currentTarget.value); setOpen(true); }} onKeyDown={event => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); options.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
                    if (event.key === 'Enter' && open && matches.length) { event.preventDefault(); add(matches[0].id); }
                }} />
                <button type="button" className="workflow-tool-browse" aria-label="Browse tools" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>⌄</button>
            </div>
            {open && <div className="workflow-tool-dropdown" ref={options} id={listId} role="listbox" aria-label="Available tools" onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return; event.preventDefault();
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
                const index = buttons.indexOf(event.target as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }}>
                {!matches.length && <p>{query ? 'No matching tools to add.' : 'All available tools have been added.'}</p>}
                {matches.slice(0,50).map(item=><button type="button" role="option" aria-selected="false" className="workflow-tool-option" key={item.id} disabled={disabled} onClick={()=>add(item.id)}><span><strong>{item.name}</strong><small>{item.hint}</small></span><span aria-hidden="true">+</span></button>)}
                {matches.length > 50 && <p>Showing 50 of {matches.length} tools. Type to narrow the list.</p>}
            </div>}
        </div>
    </div>;
}
