import MarkdownIt from '@theia/core/shared/markdown-it';

export type ChatLink = { kind: 'external'; href: string } | { kind: 'file'; path: string };

/** Chat links open ordinary web pages or files relative to this project, never IDE commands. */
export function chatLink(href: string): ChatLink | undefined {
    if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
    if (/^https?:\/\//i.test(href)) {
        try { const url = new URL(href); return { kind: 'external', href: url.href }; } catch { return undefined; }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return undefined;
    let path: string;
    try { path = decodeURIComponent(href.split('#')[0]); } catch { return undefined; }
    if (path.startsWith('./')) path = path.slice(2);
    if (!path || /[\\:?#\u0000-\u001f\u007f]/.test(path) || /%[a-f0-9]{2}/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
    return { kind: 'file', path };
}

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.validateLink = href => !!chatLink(href);
// Render image labels as text; messages must not automatically load remote resources.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function renderChatMarkdown(text: string): string { return markdown.render(text); }
