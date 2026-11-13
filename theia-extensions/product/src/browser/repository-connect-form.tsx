import * as React from '@theia/core/shared/react';
import { ConnectedRepository, ProjectService } from '../common/project-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';

interface RepositoryFormProps {
    projectPath: string;
    repositories: ConnectedRepository[];
    projects: ProjectService;
    dialogs: FileDialogService;
    busy: boolean;
    onBusy: (busy: boolean) => void;
    onConnected: () => Promise<void>;
}

export function RepositoryConnectForm(props: RepositoryFormProps): React.ReactElement {
    const [id, setId] = React.useState('');
    const [source, setSource] = React.useState('');
    const [kind, setKind] = React.useState<'local' | 'remote'>('local');
    const [error, setError] = React.useState<{ field: 'name' | 'source'; message: string }>();
    const sourceId = React.useId();
    const browse = async () => {
        try {
            const folder = await props.dialogs.showOpenDialog({ title: 'Select repository folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
            if (folder) {
                setSource(folder.path.toString());
                setId(current => current || folder.path.base.replace(/[^a-z0-9-]/gi, '-').replace(/^-+/, ''));
                setError(undefined);
            }
        } catch (error) { setError({ field: 'source', message: error instanceof Error ? error.message : 'Could not browse folders.' }); }
    };
    const connect = async () => {
        if (props.busy) return;
        const name = id.trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) { setError({ field: 'name', message: 'Enter a repository name using letters, numbers and hyphens.' }); return; }
        if (props.repositories.some(repository => repository.id === name)) { setError({ field: 'name', message: 'A repository with this name is already connected.' }); return; }
        if (!source.trim()) { setError({ field: 'source', message: kind === 'local' ? 'Choose a Git repository folder.' : 'Enter a remote Git URL.' }); return; }
        props.onBusy(true);
        setError(undefined);
        try {
            await props.projects.connectRepository({ projectPath: props.projectPath, id: name, source: source.trim(), kind, access: 'read-write' });
            setId('');
            setSource('');
            await props.onConnected();
        } catch (error) { setError({ field: 'source', message: error instanceof Error ? error.message : 'Could not connect repository.' }); }
        finally { props.onBusy(false); }
    };
    const nameInput = React.useRef<HTMLInputElement>(null);
    const sourceInput = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        if (error && !props.busy) (error.field === 'name' ? nameInput : sourceInput).current?.focus();
    }, [error, props.busy]);
    const fieldError = (field: 'name' | 'source') => error?.field === field
        ? <small className="field-error" role="alert" id={`${sourceId}-${field}-error`}>{error.message}</small>
        : undefined;
    const validation = (field: 'name' | 'source') => ({
        'aria-invalid': error?.field === field,
        'aria-describedby': error?.field === field ? `${sourceId}-${field}-error` : undefined
    });
    return <form onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label>Repository name<input ref={nameInput} {...validation('name')} value={id} disabled={props.busy} placeholder="backend" onChange={event => { setId(event.currentTarget.value); setError(undefined); }} />{fieldError('name')}</label>
        <fieldset className="repository-source"><legend>Source</legend><div>
            <button type="button" aria-pressed={kind === 'local'} disabled={props.busy} onClick={() => { setKind('local'); setSource(''); setError(undefined); }}>Existing folder</button>
            <button type="button" aria-pressed={kind === 'remote'} disabled={props.busy} onClick={() => { setKind('remote'); setSource(''); setError(undefined); }}>Clone from Git URL</button>
        </div></fieldset>
        <label htmlFor={sourceId}>{kind === 'local' ? 'Repository folder' : 'Remote Git URL'}</label>
        <div className="folder-input">
            <input ref={sourceInput} {...validation('source')} id={sourceId} value={source} disabled={props.busy} placeholder={kind === 'local' ? 'Select a Git repository folder' : 'https://github.com/owner/repository.git'} onChange={event => { setSource(event.currentTarget.value); setError(undefined); }} />
            {kind === 'local' && <button type="button" disabled={props.busy} onClick={() => void browse()}>Browse…</button>}
        </div>
        {kind === 'remote' && <p className="form-hint">Private repositories use your configured SSH agent or Git credential helper.</p>}
        {fieldError('source')}
        <button type="submit" className="primary-setup" disabled={props.busy}>{props.busy ? 'Working…' : 'Connect repository'}</button>
    </form>;
}

export function ConnectedRepositoryList({ repositories, busy, onRemove }: {
    repositories: ConnectedRepository[];
    busy: boolean;
    onRemove: (id: string) => void;
}): React.ReactElement {
    return <section className="connected-repositories" aria-label="Connected repositories">
        <h3>CONNECTED REPOSITORIES ({repositories.length})</h3>
        {repositories.map(repository => <div className="connected-repository" key={repository.id}>
            <div><strong>{repository.id}</strong><small>{repository.path}</small></div>
            <button type="button" disabled={busy} aria-label={`Disconnect ${repository.id}`} onClick={() => onRemove(repository.id)}>Disconnect</button>
        </div>)}
    </section>;
}
