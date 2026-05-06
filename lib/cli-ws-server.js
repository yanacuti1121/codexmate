const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
    return crypto.createHash('sha1').update(String(clientKey || '') + WS_GUID).digest('base64');
}

function performHandshake(req, socket) {
    const headers = req && req.headers ? req.headers : {};
    const key = headers['sec-websocket-key'];
    if (!key || (headers.upgrade || '').toLowerCase() !== 'websocket') {
        try { socket.destroy(); } catch (_) {}
        return false;
    }
    const accept = computeAcceptKey(key);
    const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + accept
    ];
    try {
        socket.write(lines.join('\r\n') + '\r\n\r\n');
    } catch (_) {
        return false;
    }
    return true;
}

function encodeFrame(payload, opcode) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf-8');
    const op = typeof opcode === 'number' ? opcode : 0x1;
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | op;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | op;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | op;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, data]);
}

function sendText(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(encodeFrame(String(text == null ? '' : text), 0x1));
        return true;
    } catch (_) {
        return false;
    }
}

function sendJson(socket, obj) {
    return sendText(socket, JSON.stringify(obj || {}));
}

function sendClose(socket, code) {
    if (!socket || socket.destroyed) return;
    try {
        const c = Number.isFinite(code) ? code : 1000;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(c, 0);
        const header = Buffer.from([0x88, payload.length]);
        socket.write(Buffer.concat([header, payload]));
        socket.end();
    } catch (_) {}
}

function makeFrameReader(onMessage, onClose) {
    let buffer = Buffer.alloc(0);
    return function feed(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            if (buffer.length < 2) return;
            const b0 = buffer[0];
            const b1 = buffer[1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) === 0x80;
            let len = b1 & 0x7f;
            let p = 2;
            if (len === 126) {
                if (buffer.length < 4) return;
                len = buffer.readUInt16BE(2);
                p = 4;
            } else if (len === 127) {
                if (buffer.length < 10) return;
                len = Number(buffer.readBigUInt64BE(2));
                p = 10;
            }
            let mask = null;
            if (masked) {
                if (buffer.length < p + 4) return;
                mask = buffer.slice(p, p + 4);
                p += 4;
            }
            if (buffer.length < p + len) return;
            let payload = buffer.slice(p, p + len);
            if (masked && mask) {
                const out = Buffer.alloc(len);
                for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
                payload = out;
            }
            buffer = buffer.slice(p + len);
            if (opcode === 0x1 || opcode === 0x2) {
                if (typeof onMessage === 'function') onMessage(payload.toString('utf-8'));
            } else if (opcode === 0x8) {
                if (typeof onClose === 'function') onClose();
                return;
            }
        }
    };
}

function buildClientHandshake(targetUrl, extraHeaders) {
    const parsed = new URL(targetUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
        Host: parsed.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
    };
    if (extraHeaders && typeof extraHeaders === 'object') {
        Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
    }
    const lines = ['GET ' + (parsed.pathname || '/') + (parsed.search || '') + ' HTTP/1.1'];
    Object.keys(headers).forEach(function (k) { lines.push(k + ': ' + headers[k]); });
    return {
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 443 : 80),
        request: lines.join('\r\n') + '\r\n\r\n',
        expectedAccept: computeAcceptKey(key)
    };
}

function encodeMaskedFrame(text, opcode) {
    const data = Buffer.from(String(text == null ? '' : text), 'utf-8');
    const op = typeof opcode === 'number' ? opcode : 0x1;
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | op;
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | op;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | op;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
}

module.exports = {
    computeAcceptKey,
    performHandshake,
    encodeFrame,
    sendText,
    sendJson,
    sendClose,
    makeFrameReader,
    buildClientHandshake,
    encodeMaskedFrame
};
