import * as React from '@theia/core/shared/react';
import DOMPurify from '@theia/core/shared/dompurify';
import { renderChatMarkdown } from '../common/chat-markdown';

export function ChatMarkdown({ text, onLink }: { text: string; onLink: (href: string) => void }): React.ReactElement {
    const markup = React.useMemo(() => ({ __html: DOMPurify.sanitize(renderChatMarkdown(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'input', 'iframe', 'style'] }) }), [text]);
    const followLink = (event: React.MouseEvent<HTMLDivElement>) => {
        const anchor = (event.target as Element).closest('a');
        if (!anchor || !event.currentTarget.contains(anchor)) return;
        event.preventDefault();
        const href = anchor.getAttribute('href'); if (href) onLink(href);
    };
    return <div className="chat-markdown" onClick={followLink} onAuxClick={followLink} dangerouslySetInnerHTML={markup} />;
}

export function CompactChatReport({ text, onLink }: { text: string; onLink: (href: string) => void }): React.ReactElement {
    const [expanded, setExpanded] = React.useState(false);
    const lengthy = text.length > 900 || text.split('\n').length > 10;
    return <div className="chat-step-report">
        <div className={lengthy && !expanded ? 'chat-step-report-preview' : undefined}>
            <ChatMarkdown text={text} onLink={onLink} />
        </div>
        {lengthy && <button type="button" className="context-text-button" aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show full report'}</button>}
    </div>;
}
