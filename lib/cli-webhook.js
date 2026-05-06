const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

const ALLOWED_EVENTS = ['provider-switch', 'claude-md-edit'];
const DEFAULT_TIMEOUT_MS = 5000;

function defaultConfigPath() {
    return path.join(os.homedir(), '.codex', 'codexmate-webhook.json');
}

function normalizeConfig(cfg) {
    const out = { enabled: false, url: '', events: ALLOWED_EVENTS.slice() };
    if (!cfg || typeof cfg !== 'object') return out;
    out.enabled = !!cfg.enabled;
    out.url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    if (Array.isArray(cfg.events)) {
        const filtered = cfg.events.filter(function (e) { return ALLOWED_EVENTS.indexOf(e) !== -1; });
        out.events = filtered.length ? filtered : ALLOWED_EVENTS.slice();
    }
    return out;
}

function loadWebhookConfig(filePath) {
    const target = filePath || defaultConfigPath();
    try {
        if (!fs.existsSync(target)) {
            return normalizeConfig({});
        }
        const raw = fs.readFileSync(target, 'utf-8');
        return normalizeConfig(JSON.parse(raw));
    } catch (_) {
        return normalizeConfig({});
    }
}

function saveWebhookConfig(cfg, filePath) {
    const target = filePath || defaultConfigPath();
    const normalized = normalizeConfig(cfg);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (_) {}
    fs.writeFileSync(target, JSON.stringify(normalized, null, 2), 'utf-8');
    return normalized;
}

function postJson(targetUrl, payload, timeoutMs) {
    return new Promise(function (resolve) {
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch (_) {
            resolve({ ok: false, error: 'invalid-url' });
            return;
        }
        const transport = parsed.protocol === 'https:' ? https : http;
        const body = JSON.stringify(payload || {});
        let req;
        try {
            req = transport.request({
                method: 'POST',
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: (parsed.pathname || '/') + (parsed.search || ''),
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body, 'utf-8'),
                    'User-Agent': 'codexmate-webhook/1'
                }
            }, function (res) {
                let raw = '';
                res.on('data', function (chunk) {
                    if (raw.length < 1024) raw += chunk.toString('utf-8');
                });
                res.on('end', function () {
                    const status = res.statusCode || 0;
                    resolve({ ok: status >= 200 && status < 300, status: status, body: raw.slice(0, 200) });
                });
            });
        } catch (e) {
            resolve({ ok: false, error: e && e.message ? e.message : String(e) });
            return;
        }
        const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        req.setTimeout(wait, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (err) { resolve({ ok: false, error: err && err.message ? err.message : String(err) }); });
        req.write(body);
        req.end();
    });
}

function buildPayload(event, summary, details) {
    return {
        event: String(event || ''),
        summary: String(summary || ''),
        operator: process.env.USER || process.env.USERNAME || (os.userInfo && os.userInfo().username) || '',
        timestamp: new Date().toISOString(),
        details: details && typeof details === 'object' ? details : {}
    };
}

function notifyWebhook(event, summary, details, options) {
    const opts = options || {};
    const cfg = opts.config ? normalizeConfig(opts.config) : loadWebhookConfig(opts.filePath);
    if (!cfg.enabled || !cfg.url) {
        return Promise.resolve({ ok: false, skipped: true, reason: 'disabled' });
    }
    if (cfg.events.indexOf(event) === -1) {
        return Promise.resolve({ ok: false, skipped: true, reason: 'event-filtered' });
    }
    return postJson(cfg.url, buildPayload(event, summary, details), opts.timeoutMs);
}

module.exports = {
    ALLOWED_EVENTS,
    defaultConfigPath,
    normalizeConfig,
    loadWebhookConfig,
    saveWebhookConfig,
    notifyWebhook,
    buildPayload,
    postJson
};
