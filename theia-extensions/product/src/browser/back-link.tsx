import * as React from '@theia/core/shared/react';

interface BackLinkProps {
    destination: string;
    onClick: () => void;
    disabled?: boolean;
}

export function BackLink({ destination, onClick, disabled }: BackLinkProps): React.JSX.Element {
    return <button type="button" className="project-back-link" onClick={onClick} disabled={disabled}>
        <span aria-hidden="true">←</span> Back to {destination}
    </button>;
}
