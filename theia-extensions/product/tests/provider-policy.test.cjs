require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChatGptService } = require('../lib/node/chatgpt-service');

test('workflow policy reaches the actual Responses request; ordinary chat retains auto tool choice', async t => {
    const bodies = []; const service = new ChatGptService(); service.accessToken = async () => 'synthetic-test-token';
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }));
        bodies.push(JSON.parse(options.body)); return new Response('synthetic-stream');
    });
    const tools = [{ type: 'function', name: 'ask_user', description: 'Ask', parameters: {} }];
    await service.streamResponse([], 'Workflow', tools, new AbortController().signal, 'required');
    await service.streamResponse([], 'Chat', tools, new AbortController().signal);
    assert.equal(bodies[0].tool_choice, 'required'); assert.equal(bodies[0].parallel_tool_calls, false);
    assert.equal(bodies[1].tool_choice, 'auto');
});
