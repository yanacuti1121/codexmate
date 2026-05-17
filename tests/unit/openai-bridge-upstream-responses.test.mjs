import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createOpenaiBridgeHttpHandler,
    flattenToolHistoryInChatMessages,
    isThinkingModeToolHistoryError,
    chatMessagesContainToolHistory,
    convertResponsesRequestToChatCompletions
} = require('../../cli/openai-bridge.js');
const { OpenaiBridgeSessionStore } = require('../../cli/openai-bridge-session.js');

function listen(server) {
    server.listen(0, '127.0.0.1');
    return once(server, 'listening').then(() => {
        const addr = server.address();
        return { port: addr.port, host: addr.address };
    });
}

async function requestText(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: `${u.pathname}${u.search}`,
            method,
            headers
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                headers: res.headers || {},
                text: Buffer.concat(chunks).toString('utf-8')
            }));
        });
        req.on('error', reject);
        if (body !== undefined) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

test('openai-bridge GET /v1 returns local bridge status without probing upstream models', async () => {
    let upstreamHit = false;
    const upstream = http.createServer((req, res) => {
        upstreamHit = true;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ msg: 'Not Found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const resp = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1`, {
        headers: { Authorization: 'Bearer codexmate' }
    });
    assert.equal(resp.status, 200);
    assert.deepStrictEqual(JSON.parse(resp.text), {
        object: 'codexmate.openai_bridge',
        provider: 'test',
        status: 'ok',
        endpoints: ['/v1/responses', '/v1/models']
    });
    assert.equal(upstreamHit, false);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge streams chat/completions directly when Responses client requests SSE', async () => {
    let responsesHit = false;
    let capturedChatRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            responsesHit = true;
            // Simulate gateways that accept /responses but never produce a usable response.
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedChatRequest = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"role":"assistant"}}]}\n\n');
                res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"hello"}}]}\n\n');
                res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"-bridge"}}]}\n\n');
                res.end('data: [DONE]\n\n');
            });
            return;
        }
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const base = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const sse = await requestText(base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: true
        }
    });
    assert.equal(sse.status, 200);
    assert.equal(responsesHit, false, 'streaming bridge should not block on upstream /responses probe');
    assert.ok(capturedChatRequest, 'streaming bridge should call upstream chat/completions');
    assert.equal(capturedChatRequest.stream, true);
    assert.match(sse.headers['content-type'], /text\/event-stream/i);
    assert.match(sse.text, /response\.output_item\.added/);
    assert.match(sse.text, /response\.output_text\.delta/);
    assert.match(sse.text, /"delta":"hello"/);
    assert.match(sse.text, /"delta":"-bridge"/);
    assert.match(sse.text, /event: response\.completed/);
    assert.match(sse.text, /data: \[DONE\]/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge omits upstream reasoning_content from output_text deltas', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write('data: {"id":"r1","model":"deepseek-v4","choices":[{"delta":{"reasoning_content":"thinking-"}}]}\n\n');
                res.write('data: {"id":"r1","model":"deepseek-v4","choices":[{"delta":{"reasoning_content":"step"}}]}\n\n');
                res.write('data: {"id":"r1","model":"deepseek-v4","choices":[{"delta":{"content":"answer"}}]}\n\n');
                res.end('data: [DONE]\n\n');
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const base = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const sse = await requestText(base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: { model: 'deepseek-v4', input: 'ping', stream: true }
    });
    assert.equal(sse.status, 200);
    assert.doesNotMatch(sse.text, /"delta":"thinking-"/);
    assert.doesNotMatch(sse.text, /"delta":"step"/);
    assert.match(sse.text, /"delta":"answer"/);
    assert.match(sse.text, /"text":"answer"/);
    assert.match(sse.text, /data: \[DONE\]/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge preserves upstream reasoning_content as a reasoning item and replays it on the next turn', async () => {
    let capturedRequests = [];
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedRequests.push(JSON.parse(body || '{}'));
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write('data: {"id":"r","model":"deepseek-v4","choices":[{"delta":{"reasoning_content":"plan-A"}}]}\n\n');
                res.write('data: {"id":"r","model":"deepseek-v4","choices":[{"delta":{"reasoning_content":"-step"}}]}\n\n');
                res.write('data: {"id":"r","model":"deepseek-v4","choices":[{"delta":{"content":"hi"}}]}\n\n');
                res.end('data: [DONE]\n\n');
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const base = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const turn1 = await requestText(base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: { model: 'deepseek-v4', input: 'ping', stream: true }
    });
    assert.equal(turn1.status, 200);
    assert.match(turn1.text, /"type":"reasoning"/);
    assert.match(turn1.text, /"text":"plan-A-step"/);
    assert.match(turn1.text, /"delta":"hi"/);
    // reasoning text must NOT leak as an output_text delta
    assert.doesNotMatch(turn1.text, /"delta":"plan-A"/);

    // Simulate Codex replaying the prior reasoning item alongside the assistant message
    // on the next turn. The bridge must convert it into the assistant message's
    // `reasoning_content` so thinking-mode upstreams accept the continuation.
    const turn2 = await requestText(base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'deepseek-v4',
            stream: true,
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
                { type: 'reasoning', id: 'rs_x', summary: [{ type: 'summary_text', text: 'plan-A-step' }] },
                { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
                { role: 'user', content: [{ type: 'input_text', text: 'again' }] }
            ]
        }
    });
    assert.equal(turn2.status, 200);
    assert.equal(capturedRequests.length, 2);
    const replayed = capturedRequests[1];
    const assistantMsg = replayed.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, 'assistant message should reach upstream');
    assert.equal(assistantMsg.reasoning_content, 'plan-A-step');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge completes Responses SSE when upstream chat stream closes after finish_reason without DONE', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"answer"}}]}\n\n');
            res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            res.end();
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const sse = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: true
        }
    });
    assert.equal(sse.status, 200);
    assert.match(sse.text, /response\.output_text\.delta/);
    assert.match(sse.text, /event: response\.completed/);
    assert.match(sse.text, /"output_text":"answer"/);
    assert.doesNotMatch(sse.text, /event: response\.failed/);
    assert.match(sse.text, /data: \[DONE\]/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge reports failed Responses SSE when upstream chat stream ends before DONE', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            res.write('data: {"id":"chatcmpl_stream","model":"gpt-test","choices":[{"delta":{"content":"partial"}}]}\n\n');
            res.end();
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const sse = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: true
        }
    });
    assert.equal(sse.status, 200);
    assert.match(sse.text, /response\.output_text\.delta/);
    assert.match(sse.text, /event: response\.failed/);
    assert.match(sse.text, /upstream stream ended before \[DONE\]/);
    assert.doesNotMatch(sse.text, /event: response\.completed/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge returns JSON when stream requested but client does not accept event-stream', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'resp_upstream',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'hello-from-upstream' }]
                }]
            }));
            return;
        }
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const base = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: true
        }
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers['content-type'], /application\/json/i);
    const parsed = JSON.parse(resp.text);
    assert.equal(parsed.object, 'response');
    assert.equal(parsed.model, 'gpt-test');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge allows loopback clients to send arbitrary Authorization headers', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'resp_upstream',
                model: 'gpt-test',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'hello-from-upstream' }]
                }]
            }));
            return;
        }
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // 故意提供一个与 expectedToken 不同的 token；loopback 也应放行
            'Authorization': 'Bearer not-codexmate'
        },
        body: { model: 'gpt-test', input: 'ping', stream: false }
    });
    assert.equal(resp.status, 200);
    const parsed = JSON.parse(resp.text);
    assert.equal(parsed.object, 'response');
    assert.equal(parsed.model, 'gpt-test');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge normalizes mixed tool definitions before upstream /responses', async () => {
    let capturedResponsesRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedResponsesRequest = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 'resp_tool_normalized', model: 'gpt-test', output: [] }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const resp = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer codexmate' },
        body: {
            model: 'gpt-test',
            input: 'ping',
            tools: [{
                type: 'function',
                name: 'lookup',
                function: {
                    description: 'Look up data',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } }
                }
            }, {
                type: 'web_search_preview'
            }, {
                type: 'function',
                function: { description: 'missing name should be dropped' }
            }],
            stream: false
        }
    });
    assert.equal(resp.status, 200);
    assert.deepStrictEqual(capturedResponsesRequest.tools, [{
        type: 'function',
        name: 'lookup',
        description: 'Look up data',
        parameters: { type: 'object', properties: { query: { type: 'string' } } }
    }]);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge falls back to chat when upstream /responses rejects tool function name', async () => {
    let capturedChatRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: "'name' is a required property - 'tools.0.function'",
                    type: 'invalid_request_error',
                    param: '',
                    code: null
                }
            }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedChatRequest = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl_tool_error_fallback',
                    model: 'gpt-test',
                    choices: [{ message: { role: 'assistant', content: 'hello-from-chat' } }]
                }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const resp = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer codexmate' },
        body: {
            model: 'gpt-test',
            input: 'ping',
            tools: [{
                type: 'function',
                name: 'lookup',
                function: {
                    description: 'Look up data',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } }
                }
            }, {
                type: 'web_search_preview'
            }, {
                type: 'function',
                function: { description: 'missing name should be dropped' }
            }],
            stream: false
        }
    });
    assert.equal(resp.status, 200);
    assert.deepStrictEqual(capturedChatRequest.tools, [{
        type: 'function',
        function: {
            name: 'lookup',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            description: 'Look up data'
        }
    }]);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge falls back to upstream /chat/completions when /responses is not supported', async () => {
    let capturedChatRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                const parsed = JSON.parse(body || '{}');
                capturedChatRequest = parsed;
                // 确保 responses 的 object input 能被转换为 chat messages
                assert.equal(parsed.messages && parsed.messages[0] && parsed.messages[0].role, 'user');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl_x',
                    model: 'gpt-test',
                    choices: [{ message: { role: 'assistant', content: 'hello-from-chat' } }]
                }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: { type: 'input_text', text: 'ping' },
            tools: [{
                type: 'function',
                name: 'lookup',
                function: {
                    description: 'Look up data',
                    parameters: { type: 'object', properties: { query: { type: 'string' } } }
                }
            }, {
                type: 'web_search_preview'
            }, {
                type: 'function',
                function: { description: 'missing name should be dropped' }
            }],
            tool_choice: { type: 'function', name: 'lookup' },
            stream: false
        }
    });
    assert.equal(resp.status, 200);
    const parsed = JSON.parse(resp.text);
    assert.equal(parsed.object, 'response');
    assert.equal(parsed.model, 'gpt-test');
    assert.ok(Array.isArray(parsed.output));
    assert.deepStrictEqual(capturedChatRequest.tools, [{
        type: 'function',
        function: {
            name: 'lookup',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            description: 'Look up data'
        }
    }]);
    assert.deepStrictEqual(capturedChatRequest.tool_choice, { type: 'function', function: { name: 'lookup' } });

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge falls back to /chat/completions when upstream /responses returns 500 not implemented', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'not implemented (request id: test)',
                    type: 'new_api_error',
                    param: '',
                    code: 'convert_request_failed'
                }
            }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl_x',
                model: 'gpt-test',
                choices: [{ message: { role: 'assistant', content: 'hello-from-chat' } }]
            }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: false
        }
    });
    assert.equal(resp.status, 200);
    const parsed = JSON.parse(resp.text);
    assert.equal(parsed.object, 'response');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge falls back to /chat/completions when upstream /responses returns 400 unknown endpoint', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Unknown endpoint: POST /v1/responses',
                    type: 'invalid_request_error',
                    code: 'unknown_endpoint'
                }
            }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl_x',
                model: 'gpt-test',
                choices: [{ message: { role: 'assistant', content: 'hello-from-chat' } }]
            }));
            return;
        }
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            input: 'ping',
            stream: false
        }
    });
    assert.equal(resp.status, 200);
    const parsed = JSON.parse(resp.text);
    assert.equal(parsed.object, 'response');
    assert.equal(parsed.model, 'gpt-test');
    assert.ok(Array.isArray(parsed.output));

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge merges codex developer-role AGENTS.md into a single leading system message', async () => {
    let capturedChatRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses') {
            // 模拟上游接受 /responses 但不可用，强制走 fallback。
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not implemented' }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedChatRequest = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl_dev',
                    model: 'gpt-test',
                    choices: [{ message: { role: 'assistant', content: 'ok' } }]
                }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const resp = await requestText(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer codexmate' },
        body: {
            model: 'gpt-test',
            instructions: 'codex-base-prompt',
            input: [
                { role: 'developer', content: [{ type: 'input_text', text: 'MISAKA_TOKEN_XYZ from AGENTS.md' }] },
                { role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }
            ],
            stream: false
        }
    });

    assert.equal(resp.status, 200);
    assert.ok(capturedChatRequest, 'fallback should hit chat/completions');
    const msgs = capturedChatRequest.messages;
    assert.ok(Array.isArray(msgs) && msgs.length >= 2, 'should produce system + user');
    assert.equal(msgs[0].role, 'system', 'first message must be system');
    assert.match(msgs[0].content, /codex-base-prompt/);
    assert.match(msgs[0].content, /MISAKA_TOKEN_XYZ from AGENTS\.md/);
    const systemCount = msgs.filter((m) => m && m.role === 'system').length;
    assert.equal(systemCount, 1, 'multiple system sources must be merged into one');
    const devLeak = msgs.find((m) => m && m.role !== 'system' && typeof m.content === 'string' && /MISAKA_TOKEN_XYZ/.test(m.content));
    assert.equal(devLeak, undefined, 'AGENTS.md must not leak into user/assistant role');
    const userMsg = msgs.find((m) => m && m.role === 'user');
    assert.ok(userMsg, 'user message preserved');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge SSE fast path also merges developer-role AGENTS.md into leading system', async () => {
    let capturedChatRequest = null;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                capturedChatRequest = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write('data: {"id":"x","model":"gpt-test","choices":[{"delta":{"content":"ok"}}]}\n\n');
                res.end('data: [DONE]\n\n');
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    await requestText(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'gpt-test',
            instructions: 'codex-base-prompt',
            input: [
                { role: 'developer', content: [{ type: 'input_text', text: 'AGENTS_MARK_STREAM' }] },
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
            ],
            stream: true
        }
    });

    assert.ok(capturedChatRequest, 'fast path should call chat/completions');
    const msgs = capturedChatRequest.messages;
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /codex-base-prompt/);
    assert.match(msgs[0].content, /AGENTS_MARK_STREAM/);
    const leak = msgs.find((m) => m && m.role !== 'system' && typeof m.content === 'string' && /AGENTS_MARK_STREAM/.test(m.content));
    assert.equal(leak, undefined, 'developer content must not leak into non-system role');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge skips /v1/responses probe after upstream marks it unsupported', async () => {
    let responsesHits = 0;
    let chatHits = 0;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/responses' && req.method === 'POST') {
            responsesHits += 1;
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unknown endpoint', code: 'unknown_endpoint' } }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            chatHits += 1;
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'cc_x',
                    model: 'gpt-test',
                    choices: [{ message: { role: 'assistant', content: 'ok' } }]
                }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const url = `http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`;
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer codexmate' };
    const body = { model: 'gpt-test', input: 'ping', stream: false };

    const first = await requestText(url, { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(responsesHits, 1, 'first call should probe /v1/responses');
    assert.equal(chatHits, 1, 'first call should fall back to chat/completions');

    const second = await requestText(url, { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(responsesHits, 1, 'second call should skip /v1/responses probe (cache hit)');
    assert.equal(chatHits, 2, 'second call should go directly to chat/completions');

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('openai-bridge preserves multibyte UTF-8 deltas split across chunk boundaries', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            const fullEvent = 'data: {"id":"x","model":"gpt-test","choices":[{"delta":{"content":"御坂"}}]}\n\n';
            const fullBytes = Buffer.from(fullEvent, 'utf-8');
            // 御 (U+5FA1) 占 3 字节，从偏移 67 起；故意在 68 处切——切到 "御" 中间。
            const splitAt = fullBytes.indexOf(Buffer.from('御', 'utf-8')) + 1;
            const firstHalf = fullBytes.slice(0, splitAt);
            const secondHalf = fullBytes.slice(splitAt);
            res.write(firstHalf);
            setTimeout(() => {
                res.write(secondHalf);
                res.end('data: [DONE]\n\n');
            }, 10);
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const sse = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: { model: 'gpt-test', input: 'ping', stream: true }
    });
    assert.equal(sse.status, 200);
    assert.match(sse.text, /"delta":"御坂"/);
    assert.doesNotMatch(sse.text, /�/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('flattenToolHistoryInChatMessages folds assistant tool_calls and tool role into text', () => {
    const flattened = flattenToolHistoryInChatMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', reasoning_content: 'plan', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result-1' },
        { role: 'user', content: 'next' }
    ]);
    assert.equal(flattened.length, 4);
    assert.equal(flattened[0].role, 'user');
    assert.equal(flattened[1].role, 'assistant');
    assert.equal(flattened[1].reasoning_content, 'plan');
    assert.equal(flattened[1].tool_calls, undefined);
    assert.match(flattened[1].content, /<tool_call id="c1" name="calc">\{"x":1\}<\/tool_call>/);
    assert.equal(flattened[2].role, 'user');
    assert.match(flattened[2].content, /<tool_result tool_call_id="c1">result-1<\/tool_result>/);
    assert.equal(flattened[3].role, 'user');
});

test('isThinkingModeToolHistoryError matches the windhub mimo upstream signature only', () => {
    assert.equal(isThinkingModeToolHistoryError(400, '{"error":{"message":"Param Incorrect","param":"The reasoning_content in the thinking mode must be passed back to the API."}}'), true);
    assert.equal(isThinkingModeToolHistoryError(400, 'unrelated 400'), false);
    assert.equal(isThinkingModeToolHistoryError(500, 'reasoning_content thinking mode'), false);
});

test('chatMessagesContainToolHistory detects assistant.tool_calls and role=tool', () => {
    assert.equal(chatMessagesContainToolHistory([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ]), false);
    assert.equal(chatMessagesContainToolHistory([
        { role: 'user', content: 'hi' },
        { role: 'assistant', tool_calls: [{ id: 'c1' }] }
    ]), true);
    assert.equal(chatMessagesContainToolHistory([
        { role: 'tool', tool_call_id: 'c1', content: 'x' }
    ]), true);
});

test('openai-bridge retries with flattened tool history when upstream rejects thinking-mode tool calls', async () => {
    const captured = [];
    let attempt = 0;
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                attempt += 1;
                const parsedBody = JSON.parse(body || '{}');
                captured.push(parsedBody);
                if (attempt === 1) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Param Incorrect', type: 'upstream_error', param: 'The reasoning_content in the thinking mode must be passed back to the API.', code: '400' } }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write('data: {"id":"r","model":"mimo","choices":[{"delta":{"content":"ok"}}]}\n\n');
                res.end('data: [DONE]\n\n');
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codexmate-bridge-test-'));
    const settingsFile = path.join(tmpDir, 'bridge.json');
    await writeFile(settingsFile, JSON.stringify({
        version: 1,
        providers: {
            test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-upstream' }
        }
    }), 'utf-8');

    const handler = createOpenaiBridgeHttpHandler({ settingsFile, expectedToken: 'codexmate' });
    const bridge = http.createServer((req, res) => {
        if (!handler(req, res)) {
            res.statusCode = 404;
            res.end('not handled');
        }
    });
    const { port: bridgePort } = await listen(bridge);

    const sse = await requestText(`http://127.0.0.1:${bridgePort}/bridge/openai/test/v1/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer codexmate'
        },
        body: {
            model: 'mimo',
            stream: true,
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'do calc' }] },
                { type: 'function_call', call_id: 'c1', name: 'calc', arguments: '{}' },
                { type: 'function_call_output', call_id: 'c1', output: 'done' },
                { role: 'user', content: [{ type: 'input_text', text: 'next' }] }
            ],
            tools: [{ type: 'function', function: { name: 'calc', description: 'x', parameters: { type: 'object', properties: {} } } }]
        }
    });
    assert.equal(sse.status, 200);
    assert.equal(attempt, 2, 'should retry after upstream rejects tool history');
    assert.equal(captured.length, 2);
    const firstHistory = captured[0].messages;
    const firstAssistantToolCalls = firstHistory.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(firstAssistantToolCalls, 'first attempt should carry structured tool_calls');
    assert.equal(captured[1].tools, undefined, 'flattened retry must drop tools array');
    const secondAssistant = captured[1].messages.find((m) => m.role === 'assistant');
    assert.equal(secondAssistant && Array.isArray(secondAssistant.tool_calls), false, 'flattened retry must not carry structured tool_calls');
    assert.match(secondAssistant.content, /<tool_call/);
    assert.match(sse.text, /"delta":"ok"/);

    await bridge.close();
    await upstream.close();
    await rm(tmpDir, { recursive: true, force: true });
});

test('convertResponsesRequestToChatCompletions groups consecutive function_call items into one assistant message', () => {
    const sessions = new OpenaiBridgeSessionStore();
    sessions.storeReasoning('c1', 'plan-A');
    const { chat } = convertResponsesRequestToChatCompletions({
        model: 'test',
        input: [
            { role: 'user', content: [{ type: 'input_text', text: 'do parallel' }] },
            { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '' }] },
            { type: 'function_call', call_id: 'c1', name: 'fn_a', arguments: '{"x":1}' },
            { type: 'function_call', call_id: 'c2', name: 'fn_b', arguments: '{"y":2}' },
            { type: 'function_call_output', call_id: 'c1', output: 'r1' },
            { type: 'function_call_output', call_id: 'c2', output: 'r2' }
        ]
    }, { sessions, history: [] });
    const assistantMsgs = chat.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMsgs.length, 1, 'consecutive function_call items must merge into ONE assistant message');
    assert.equal(assistantMsgs[0].tool_calls.length, 2);
    assert.equal(assistantMsgs[0].tool_calls[0].id, 'c1');
    assert.equal(assistantMsgs[0].tool_calls[1].id, 'c2');
    assert.equal(assistantMsgs[0].reasoning_content, 'plan-A');
    const toolMsgs = chat.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
});

test('convertResponsesRequestToChatCompletions drops Responses reasoning items from input', () => {
    const sessions = new OpenaiBridgeSessionStore();
    const { chat } = convertResponsesRequestToChatCompletions({
        model: 'test',
        input: [
            { type: 'reasoning', id: 'rs_x', summary: [{ type: 'summary_text', text: 'leaked-summary' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
    }, { sessions, history: [] });
    const allContent = chat.messages.map((m) => m.content).filter((c) => typeof c === 'string').join(' ');
    assert.doesNotMatch(allContent, /leaked-summary/);
});

test('convertResponsesRequestToChatCompletions moves developer messages between tool calls to the front', () => {
    const { chat } = convertResponsesRequestToChatCompletions({
        model: 'test',
        input: [
            { type: 'function_call', call_id: 'c1', name: 'fn_a', arguments: '{}' },
            { role: 'developer', content: [{ type: 'input_text', text: 'extra rules' }] },
            { type: 'function_call_output', call_id: 'c1', output: 'done' },
            { role: 'user', content: [{ type: 'input_text', text: 'next' }] }
        ]
    });
    const roles = chat.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'assistant', 'tool', 'user'], 'developer must be lifted to front so assistant->tool stay contiguous');
});

test('convertResponsesRequestToChatCompletions injects reasoning_content via session store for plain assistant messages', () => {
    const sessions = new OpenaiBridgeSessionStore();
    sessions.storeTurnReasoning({ role: 'assistant', content: 'hello' }, 'remembered thought');
    const { chat } = convertResponsesRequestToChatCompletions({
        model: 'test',
        input: [
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'more' }] }
        ]
    }, { sessions, history: [] });
    const assistant = chat.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'remembered thought');
});

test('OpenaiBridgeSessionStore stores reasoning by call_id and content fingerprint', () => {
    const sessions = new OpenaiBridgeSessionStore();
    const assistant = { role: 'assistant', content: 'final answer', tool_calls: [{ id: 'c1' }, { id: 'c2' }] };
    sessions.storeTurnReasoning(assistant, 'big thought');
    assert.equal(sessions.getReasoning('c1'), 'big thought');
    assert.equal(sessions.getReasoning('c2'), 'big thought');
    assert.equal(sessions.getTurnReasoning(assistant), 'big thought');
    assert.equal(sessions.getReasoning('missing'), null);
});
