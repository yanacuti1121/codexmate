'use strict';

const crypto = require('crypto');

// 模型 reasoning_content 必回放。
class OpenaiBridgeSessionStore {
    constructor() {
        this.reasoning = new Map();
        this.turnReasoning = new Map();
        this.history = new Map();
    }

    storeReasoning(callId, reasoning) {
        if (typeof callId !== 'string' || !callId) return;
        if (typeof reasoning !== 'string' || !reasoning) return;
        this.reasoning.set(callId, reasoning);
    }

    getReasoning(callId) {
        if (typeof callId !== 'string' || !callId) return null;
        return this.reasoning.has(callId) ? this.reasoning.get(callId) : null;
    }

    storeTurnReasoning(assistantMessage, reasoning) {
        if (!assistantMessage || typeof assistantMessage !== 'object') return;
        if (typeof reasoning !== 'string' || !reasoning) return;
        const content = OpenaiBridgeSessionStore.textOfContent(assistantMessage.content);
        if (content) {
            this.turnReasoning.set(OpenaiBridgeSessionStore.contentKey(content), reasoning);
        }
        if (Array.isArray(assistantMessage.tool_calls)) {
            for (const call of assistantMessage.tool_calls) {
                const id = call && typeof call === 'object' && typeof call.id === 'string' ? call.id : '';
                this.storeReasoning(id, reasoning);
            }
        }
    }

    getTurnReasoning(assistantMessage) {
        if (!assistantMessage || typeof assistantMessage !== 'object') return null;
        const content = OpenaiBridgeSessionStore.textOfContent(assistantMessage.content);
        if (!content) return null;
        const key = OpenaiBridgeSessionStore.contentKey(content);
        return this.turnReasoning.has(key) ? this.turnReasoning.get(key) : null;
    }

    getHistory(responseId) {
        if (typeof responseId !== 'string' || !responseId) return [];
        const cached = this.history.get(responseId);
        return Array.isArray(cached) ? cached.slice() : [];
    }

    newId() {
        return `resp_${crypto.randomBytes(10).toString('hex')}`;
    }

    saveWithId(responseId, messages) {
        if (typeof responseId !== 'string' || !responseId) return;
        this.history.set(responseId, Array.isArray(messages) ? messages.slice() : []);
    }

    save(messages) {
        const id = this.newId();
        this.saveWithId(id, messages);
        return id;
    }

    static textOfContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
                .filter(Boolean)
                .join('');
        }
        return '';
    }

    static contentKey(text) {
        return crypto.createHash('sha1').update(String(text || ''), 'utf-8').digest('hex');
    }
}

module.exports = { OpenaiBridgeSessionStore };
