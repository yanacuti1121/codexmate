const http = require('http');
const { assert } = require('./helpers');

function startRecordingServer() {
    const requests = [];
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.setEncoding('utf-8');
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = null; }
                requests.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: parsed,
                    raw: body
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({ server, port: addr.port, requests });
        });
    });
}

function closeRecordingServer(server) {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
    });
}

function waitFor(predicate, timeoutMs = 2000, intervalMs = 30) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            try {
                if (predicate()) return resolve();
            } catch (_) {}
            if (Date.now() - start >= timeoutMs) {
                return reject(new Error('waitFor timeout'));
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

module.exports = async function testWebhook(ctx) {
    const { api } = ctx;
    const recorder = await startRecordingServer();
    const recorderUrl = `http://127.0.0.1:${recorder.port}/hook`;

    try {
        const initial = await api('get-webhook-config');
        assert(initial && typeof initial === 'object' && !initial.error, 'get-webhook-config should return object');
        assert(typeof initial.enabled === 'boolean', 'get-webhook-config missing enabled');
        assert(Array.isArray(initial.events), 'get-webhook-config missing events array');

        const saved = await api('set-webhook-config', {
            config: {
                enabled: true,
                url: recorderUrl,
                events: ['provider-switch', 'claude-md-edit']
            }
        });
        assert(saved && saved.enabled === true, 'set-webhook-config did not persist enabled');
        assert(saved.url === recorderUrl, 'set-webhook-config did not persist url');

        const testPing = await api('test-webhook');
        assert(testPing && testPing.ok === true, 'test-webhook should succeed: ' + JSON.stringify(testPing));
        await waitFor(() => recorder.requests.length >= 1, 2000);
        const ping = recorder.requests[0];
        assert(ping.method === 'POST', 'test-webhook should POST');
        assert(ping.body && ping.body.event === 'provider-switch', 'test ping event mismatch');
        assert(ping.body.details && ping.body.details.test === true, 'test ping marker missing');

        const requestsBefore = recorder.requests.length;
        const claudeApply = await api('apply-claude-config', {
            config: {
                name: 'webhook-e2e',
                apiKey: 'sk-webhook-e2e',
                baseUrl: ctx.mockProviderUrl,
                model: 'glm-4.7'
            }
        });
        assert(claudeApply && !claudeApply.error, 'apply-claude-config failed: ' + JSON.stringify(claudeApply));
        await waitFor(() => recorder.requests.length > requestsBefore, 2000);
        const switchEvent = recorder.requests[recorder.requests.length - 1];
        assert(switchEvent.body && switchEvent.body.event === 'provider-switch', 'apply-claude-config should trigger provider-switch event');
        assert(typeof switchEvent.body.summary === 'string' && switchEvent.body.summary.indexOf('webhook-e2e') !== -1,
            'webhook summary should mention provider name: ' + switchEvent.body.summary);
        assert(typeof switchEvent.body.timestamp === 'string' && switchEvent.body.timestamp.length > 0,
            'webhook payload should include timestamp');

        await api('set-webhook-config', {
            config: { enabled: false, url: recorderUrl, events: ['provider-switch', 'claude-md-edit'] }
        });
        const requestsBeforeDisabled = recorder.requests.length;
        const claudeApplyDisabled = await api('apply-claude-config', {
            config: {
                name: 'webhook-e2e-disabled',
                apiKey: 'sk-webhook-e2e',
                baseUrl: ctx.mockProviderUrl,
                model: 'glm-4.7'
            }
        });
        assert(claudeApplyDisabled && !claudeApplyDisabled.error, 'apply-claude-config (disabled webhook) should still succeed');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert(recorder.requests.length === requestsBeforeDisabled,
            'disabled webhook should not deliver any new requests, got ' + (recorder.requests.length - requestsBeforeDisabled));

        const filtered = await api('set-webhook-config', {
            config: { enabled: true, url: recorderUrl, events: ['claude-md-edit'] }
        });
        assert(filtered && filtered.events && filtered.events.indexOf('provider-switch') === -1,
            'event filter should drop provider-switch');
        const requestsBeforeFiltered = recorder.requests.length;
        const claudeApplyFiltered = await api('apply-claude-config', {
            config: {
                name: 'webhook-e2e-filtered',
                apiKey: 'sk-webhook-e2e',
                baseUrl: ctx.mockProviderUrl,
                model: 'glm-4.7'
            }
        });
        assert(claudeApplyFiltered && !claudeApplyFiltered.error, 'apply-claude-config (filtered) should still succeed');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert(recorder.requests.length === requestsBeforeFiltered,
            'filtered event should not be delivered, got ' + (recorder.requests.length - requestsBeforeFiltered));
    } finally {
        try {
            await api('set-webhook-config', { config: { enabled: false, url: '', events: ['provider-switch', 'claude-md-edit'] } });
        } catch (_) {}
        await closeRecordingServer(recorder.server);
    }
};
