import { api, API_BASE } from './api.mjs';

export function createWebhookTerminalMethods() {
    return {
        async loadWebhookSettings() {
            try {
                const data = await api('get-webhook-config');
                if (data && typeof data === 'object' && !data.error) {
                    this.webhookConfig = {
                        enabled: !!data.enabled,
                        url: typeof data.url === 'string' ? data.url : '',
                        events: Array.isArray(data.events) && data.events.length
                            ? data.events.slice()
                            : this.webhookEventOptions.slice()
                    };
                }
            } catch (e) {
                this.webhookTestResult = { ok: false, error: e && e.message ? e.message : String(e) };
            }
        },

        async saveWebhookSettings() {
            this.webhookSaving = true;
            try {
                const cfg = {
                    enabled: !!this.webhookConfig.enabled,
                    url: typeof this.webhookConfig.url === 'string' ? this.webhookConfig.url.trim() : '',
                    events: Array.isArray(this.webhookConfig.events) ? this.webhookConfig.events.slice() : []
                };
                const saved = await api('set-webhook-config', { config: cfg });
                if (saved && typeof saved === 'object' && !saved.error) {
                    this.webhookConfig = {
                        enabled: !!saved.enabled,
                        url: typeof saved.url === 'string' ? saved.url : '',
                        events: Array.isArray(saved.events) ? saved.events.slice() : []
                    };
                    this.webhookTestResult = { ok: true, status: 'saved' };
                } else {
                    this.webhookTestResult = { ok: false, error: (saved && saved.error) || 'save failed' };
                }
            } catch (e) {
                this.webhookTestResult = { ok: false, error: e && e.message ? e.message : String(e) };
            } finally {
                this.webhookSaving = false;
            }
        },

        async testWebhook() {
            this.webhookTesting = true;
            try {
                const cfg = {
                    enabled: true,
                    url: typeof this.webhookConfig.url === 'string' ? this.webhookConfig.url.trim() : '',
                    events: Array.isArray(this.webhookConfig.events) && this.webhookConfig.events.length
                        ? this.webhookConfig.events.slice()
                        : this.webhookEventOptions.slice()
                };
                const r = await api('test-webhook', { config: cfg });
                this.webhookTestResult = r || { ok: false, error: 'no result' };
            } catch (e) {
                this.webhookTestResult = { ok: false, error: e && e.message ? e.message : String(e) };
            } finally {
                this.webhookTesting = false;
            }
        },

        toggleWebhookEvent(eventName) {
            if (!Array.isArray(this.webhookConfig.events)) {
                this.webhookConfig.events = [];
            }
            const idx = this.webhookConfig.events.indexOf(eventName);
            if (idx === -1) {
                this.webhookConfig.events.push(eventName);
            } else {
                this.webhookConfig.events.splice(idx, 1);
            }
        },

        toggleTerminalPanel() {
            this.terminalPanelOpen = !this.terminalPanelOpen;
        },

        clearTerminalOutput() {
            this.terminalLines = [];
            this.terminalPendingBuffer = [];
        },

        pauseTerminal() {
            this.terminalPaused = true;
        },

        resumeTerminal() {
            this.terminalPaused = false;
            this._flushTerminalBuffer();
        },

        _flushTerminalBuffer() {
            if (!Array.isArray(this.terminalPendingBuffer) || this.terminalPendingBuffer.length === 0) return;
            const drained = this.terminalPendingBuffer;
            this.terminalPendingBuffer = [];
            for (const line of drained) {
                this._appendTerminalLine(line.stream, line.text);
            }
        },

        _appendTerminalLine(stream, text) {
            const lines = String(text || '').split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i];
                if (i === lines.length - 1 && t === '') continue;
                this.terminalLines.push({ stream: stream || 'stdout', text: t });
            }
            const max = Number.isFinite(this.terminalMaxLines) ? this.terminalMaxLines : 2000;
            if (this.terminalLines.length > max) {
                this.terminalLines.splice(0, this.terminalLines.length - max);
            }
        },

        runTerminalCommand() {
            if (this.terminalRunning) return;
            const raw = String(this.terminalCommandInput || '').trim();
            if (!raw) return;
            const parts = raw.split(/\s+/);
            const cmd = parts.shift();
            const args = parts;
            const proto = (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') ? 'wss:' : 'ws:';
            const host = (typeof window !== 'undefined' && window.location && window.location.host) ? window.location.host : 'localhost';
            const url = proto + '//' + host + '/ws/terminal';
            let socket;
            try {
                socket = new WebSocket(url);
            } catch (e) {
                this._appendTerminalLine('stderr', '[connect error] ' + (e && e.message ? e.message : String(e)));
                return;
            }
            this.terminalSocket = socket;
            this.terminalRunning = true;
            this._appendTerminalLine('stdout', '$ ' + raw);
            socket.onopen = () => {
                try {
                    socket.send(JSON.stringify({ type: 'run', cmd, args }));
                } catch (e) {
                    this._appendTerminalLine('stderr', '[send error] ' + (e && e.message ? e.message : String(e)));
                }
            };
            socket.onmessage = (ev) => {
                let parsed;
                try { parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (_) { return; }
                if (!parsed || typeof parsed !== 'object') return;
                if (parsed.type === 'data') {
                    const stream = parsed.stream === 'stderr' ? 'stderr' : 'stdout';
                    if (this.terminalPaused) {
                        this.terminalPendingBuffer.push({ stream, text: String(parsed.text || '') });
                    } else {
                        this._appendTerminalLine(stream, String(parsed.text || ''));
                    }
                } else if (parsed.type === 'started') {
                    this._appendTerminalLine('stdout', '[started pid=' + (parsed.pid || '') + ']');
                } else if (parsed.type === 'exit') {
                    this._appendTerminalLine('stdout', '[exit code=' + (parsed.code == null ? '?' : parsed.code) + (parsed.signal ? ' signal=' + parsed.signal : '') + ']');
                } else if (parsed.type === 'error') {
                    this._appendTerminalLine('stderr', '[error] ' + (parsed.message || ''));
                }
            };
            socket.onerror = () => {
                this._appendTerminalLine('stderr', '[socket error]');
            };
            socket.onclose = () => {
                this.terminalRunning = false;
                this.terminalSocket = null;
            };
        },

        killTerminalCommand() {
            if (this.terminalSocket && this.terminalSocket.readyState === 1) {
                try {
                    this.terminalSocket.send(JSON.stringify({ type: 'kill' }));
                } catch (_) {}
            }
        }
    };
}
