const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderChatMarkdown, chatLink } = require('../lib/common/chat-markdown');

test('chat formats plans, lists, tables, inline and fenced code, and project file links', () => {
    const html = renderChatMarkdown('# Plan\n\n**Change:** `back/Dockerfile`\n\n- Update Node\n- Verify build\n\n[Open plan](changesets/node24-plan.md)\n\n```dockerfile\nFROM node:24\n```\n\n| Check | Result |\n| --- | --- |\n| Build | Passed |');
    for (const pattern of [/<h1>Plan<\/h1>/, /<strong>Change:<\/strong>/, /<code>back\/Dockerfile<\/code>/, /<ul>/, /href="changesets\/node24-plan.md"/, /class="language-dockerfile"/, /<table>/]) assert.match(html, pattern);
});

test('model text cannot inject HTML, execute command links, or automatically fetch images', () => {
    const html = renderChatMarkdown('<script>alert(1)</script>\n<img src="https://example.invalid/pixel" onerror="alert(1)">\n\n[run](javascript:alert(1)) [command](command:workbench.action.closeWindow) [local](file:///etc/passwd)\n\n![image label](https://example.invalid/pixel)\n\n```html\n<script>code sample</script>\n```');
    assert.doesNotMatch(html, /<(script|img|iframe)\b|href="(?:javascript|command|file):/i);
    assert.match(html, /&lt;script&gt;code sample&lt;\/script&gt;/); assert.match(html, /image label/);
});

test('only normal web pages and contained project-relative paths are opened from chat', () => {
    assert.deepEqual(chatLink('changesets/node24-plan.md'), { kind: 'file', path: 'changesets/node24-plan.md' });
    assert.deepEqual(chatLink('./changesets/план%20работ.md#details'), { kind: 'file', path: 'changesets/план работ.md' });
    assert.deepEqual(chatLink('https://example.com/docs'), { kind: 'external', href: 'https://example.com/docs' });
    for (const href of ['../outside', 'changesets/../../outside', '%2fetc/passwd', 'changesets/%2e%2e/file', 'changesets/%252e%252e/file', '//example.com', 'command:do_something', 'file:///etc/passwd', 'data:text/html,hello', 'java\nscript:alert(1)', 'repositories\\..\\outside']) assert.equal(chatLink(href), undefined, href);
});
