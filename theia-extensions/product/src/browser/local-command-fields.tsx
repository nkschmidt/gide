import * as React from '@theia/core/shared/react';
import { LocalProcessConfiguration } from '../common/project-tool-service';

export const localCommandDefaults = (): LocalProcessConfiguration => ({ directory: '.', program: '', arguments: [], environment: 'local', timeoutSeconds: 300, outputLimit: 32768 });

export function LocalCommandFields({ configuration, disabled, onChange }: {
    configuration: Record<string, unknown>;
    disabled?: boolean;
    onChange: (change: Partial<LocalProcessConfiguration>) => void;
}): React.ReactElement {
    const c = { ...localCommandDefaults(), ...configuration } as LocalProcessConfiguration;
    return <div className="tool-command-fields">
        <p className="tool-muted">Available in every connected repository. Choose the repository when you run this command.</p>
        <label>Command<input required value={c.program} placeholder="e.g. npm or go" disabled={disabled} onChange={event => onChange({ program: event.currentTarget.value })} /><small>The name of an installed program or its full path.</small></label>
        <label>Arguments<textarea rows={3} placeholder="e.g. test" value={c.arguments.join('\n')} disabled={disabled} onChange={event => onChange({ arguments: event.currentTarget.value ? event.currentTarget.value.split('\n') : [] })} /><small>One argument per line. For <code>npm test</code>, enter <code>npm</code> above and <code>test</code> here.</small></label>
        <details className="tool-command-options"><summary>Advanced settings</summary><div className="tool-command-fields">
            <label>Working folder<input value={c.directory === '.' ? '' : c.directory} placeholder="Repository root" disabled={disabled} onChange={event => onChange({ directory: event.currentTarget.value || '.' })} /><small>Optional subfolder relative to the repository you choose at run time.</small></label>
            <div className="tool-form-pair"><label>Timeout · seconds<input type="number" min={1} max={1800} value={c.timeoutSeconds} disabled={disabled} onChange={event => onChange({ timeoutSeconds: Number(event.currentTarget.value) })} /></label><label>Output limit · bytes<input type="number" min={1024} max={262144} value={c.outputLimit} disabled={disabled} onChange={event => onChange({ outputLimit: Number(event.currentTarget.value) })} /></label></div>
        </div></details>
    </div>;
}
