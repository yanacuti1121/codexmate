const net = require('net');
const { assert } = require('./helpers');
const {
    buildClientHandshake,
    encodeMaskedFrame,
    makeFrameReader
} = require('../../lib/cli-ws-server');

function connectWs(port, path) {
    return new Promise((resolve, reject) => {
        const handshake = buildClientHandshake('ws://127.0.0.1:' + port + path);
        const socket = net.connect(port, '127.0.0.1');
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        socket.on('error', reject);
        socket.on('connect', () => {
            socket.write(handshake.request);
        });
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (!upgraded) {
                const idx = buffer.indexOf('\r\n\r\n');
                if (idx === -1) return;
                const head = buffer.slice(0, idx).toString('utf-8');
                buffer = buffer.slice(idx + 4);
                if (!/^HTTP\/1\.1 101/.test(head)) {
                    socket.destroy();
                    reject(new Error('handshake rejected: ' + head.split('\n')[0]));
                    return;
                }
                if (!head.toLowerCase().includes('sec-websocket-accept: ' + handshake.expectedAccept.toLowerCase())) {
                    socket.destroy();
                    reject(new Error('handshake accept mismatch'));
                    return;
                }
                upgraded = true;
                resolve({ socket, leftover: buffer });
            }
        };
        socket.on('data', onData);
    });
}

function collectFrames(socket, leftover) {
    const messages = [];
    const closeFlags = { closed: false };
    const reader = makeFrameReader(
        (text) => { messages.push(text); },
        () => { closeFlags.closed = true; }
    );
    if (leftover && leftover.length > 0) reader(leftover);
    socket.on('data', reader);
    socket.on('close', () => { closeFlags.closed = true; });
    return { messages, closeFlags };
}

function waitForFrame(messages, predicate, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            for (let i = 0; i < messages.length; i++) {
                let parsed;
                try { parsed = JSON.parse(messages[i]); } catch (_) { continue; }
                if (predicate(parsed)) return resolve(parsed);
            }
            if (Date.now() - start >= timeoutMs) return reject(new Error('frame wait timeout'));
            setTimeout(tick, 30);
        };
        tick();
    });
}

module.exports = async function testTerminal(ctx) {
    const { port } = ctx;
    if (!port) throw new Error('terminal e2e requires ctx.port');

    {
        const conn = await connectWs(port, '/ws/terminal');
        const { messages, closeFlags } = collectFrames(conn.socket, conn.leftover);
        const payload = JSON.stringify({
            type: 'run',
            cmd: 'node',
            args: ['-e', "process.stdout.write('hello-terminal-e2e\\n');"]
        });
        conn.socket.write(encodeMaskedFrame(payload, 0x1));

        const started = await waitForFrame(messages, (m) => m && m.type === 'started');
        assert(typeof started.pid === 'number' && started.pid > 0, 'started frame should include positive pid');

        const data = await waitForFrame(messages, (m) => m && m.type === 'data' && typeof m.text === 'string' && m.text.indexOf('hello-terminal-e2e') !== -1);
        assert(data.stream === 'stdout', 'data frame stream should be stdout, got ' + data.stream);

        const exit = await waitForFrame(messages, (m) => m && m.type === 'exit');
        assert(exit.code === 0, 'exit code should be 0, got ' + exit.code);

        try { conn.socket.end(); } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert(closeFlags.closed || conn.socket.destroyed, 'socket should be closed after exit');
    }

    {
        const conn = await connectWs(port, '/ws/terminal');
        const { messages } = collectFrames(conn.socket, conn.leftover);
        const payload = JSON.stringify({ type: 'run', cmd: 'rm', args: ['-rf', '/'] });
        conn.socket.write(encodeMaskedFrame(payload, 0x1));
        const err = await waitForFrame(messages, (m) => m && m.type === 'error');
        assert(/not allowed/i.test(err.message || ''), 'should reject non-whitelisted command, got ' + err.message);
        try { conn.socket.end(); } catch (_) {}
    }

    {
        const conn = await connectWs(port, '/ws/terminal');
        const { messages } = collectFrames(conn.socket, conn.leftover);
        const stderrPayload = JSON.stringify({
            type: 'run',
            cmd: 'node',
            args: ['-e', "process.stderr.write('err-terminal-e2e\\n');"]
        });
        conn.socket.write(encodeMaskedFrame(stderrPayload, 0x1));
        const data = await waitForFrame(messages, (m) => m && m.type === 'data' && typeof m.text === 'string' && m.text.indexOf('err-terminal-e2e') !== -1);
        assert(data.stream === 'stderr', 'stderr stream should route correctly');
        await waitForFrame(messages, (m) => m && m.type === 'exit');
        try { conn.socket.end(); } catch (_) {}
    }
};
