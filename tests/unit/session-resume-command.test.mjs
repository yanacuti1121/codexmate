import assert from 'assert';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { createSessionActionMethods } = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'web-ui', 'modules', 'app.methods.session-actions.mjs'))
);
const { DICT } = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'web-ui', 'modules', 'i18n.dict.mjs'))
);

test('isResumeCommandAvailable supports codex and codebuddy with sessionId', () => {
    const methods = createSessionActionMethods();
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'codex', sessionId: 'sess-1' }), true);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'codebuddy', sessionId: 'abc123' }), true);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'gemini', sessionId: 'gm-123' }), true);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'gemini', sessionId: '', filePath: '/home/user/.gemini/tmp/abc/chats/gm-456.json' }), true);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'codebuddy', sessionId: '' }), false);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'claude', sessionId: 'sess-2' }), true);
    assert.strictEqual(methods.isResumeCommandAvailable({ source: 'claude', sessionId: '', filePath: '/home/user/.claude/projects/demo/sess-3.jsonl' }), true);
});

test('derived native availability controls resume warning and import action', () => {
    const methods = createSessionActionMethods();
    assert.strictEqual(
        methods.isImportToNativeAvailable.call(methods, { source: 'codex', sessionId: 'sess-20260101-010101-abcdef', derived: true, nativeAvailable: false, nativeImportAvailable: true }),
        true
    );
    assert.strictEqual(
        methods.isImportToNativeAvailable.call(methods, { source: 'codex', sessionId: 'sess-20260101-010101-abcdef', derived: true, nativeAvailable: true, nativeImportAvailable: false }),
        false
    );
    assert.strictEqual(
        methods.getResumeCommandTitle.call(methods, { source: 'claude', sessionId: 'sess-2', derived: true, nativeAvailable: false }),
        'Session not in native directory, resume may fail'
    );
    assert.strictEqual(
        methods.getResumeCommandTitle.call(methods, { source: 'claude', sessionId: 'sess-2', derived: true, nativeAvailable: true }),
        'Copy resume command'
    );
    const zhContext = {
        ...methods,
        t(key) { return DICT.zh[key] || key; }
    };
    assert.strictEqual(
        methods.getResumeCommandTitle.call(zhContext, { source: 'claude', sessionId: 'sess-2', derived: true, nativeAvailable: false }),
        '会话不在原生目录中，恢复可能失败'
    );
});

test('import to native session action strings are localized in both locales', () => {
    const keys = [
        'sessions.preview.importNative',
        'sessions.preview.importingNative',
        'sessions.preview.importNative.unsupported',
        'sessions.preview.importNative.confirmTitle',
        'sessions.preview.importNative.confirmMessage',
        'sessions.preview.importNative.confirmText',
        'sessions.preview.importNative.cancelled',
        'sessions.preview.importNative.conflict',
        'sessions.preview.importNative.invalidSource',
        'sessions.preview.importNative.fileNotFound',
        'sessions.preview.importNative.nativePathUnavailable',
        'sessions.preview.importNative.success',
        'sessions.preview.importNative.failed',
        'sessions.preview.importNative.failedWithReason',
        'sessions.resume.nativeUnavailableTitle'
    ];
    for (const key of keys) {
        assert(DICT.zh[key], `missing zh i18n key: ${key}`);
        assert(DICT.en[key], `missing en i18n key: ${key}`);
    }
    assert.strictEqual(DICT.zh['sessions.preview.importNative'], '导入原生目录');
    assert.strictEqual(DICT.en['sessions.preview.importNative'], 'Import to Native');
});

test('import to native backend error codes are shown through localized strings', async () => {
    const methods = createSessionActionMethods({
        api: async () => ({ error: 'Invalid source', errorCode: 'INVALID_SOURCE' })
    });
    const messages = [];
    const context = {
        ...methods,
        sessionImportingNative: {},
        showMessage(message, type) { messages.push({ message, type }); },
        t(key, params) {
            const template = DICT.zh[key] || key;
            if (!params) return template;
            return template.replace(/\{([^}]+)\}/g, (_, name) => params[name] ?? `{${name}}`);
        }
    };

    await methods.importDerivedSessionToNative.call(context, {
        source: 'codex',
        sessionId: 'sess-20260101-010101-abcdef',
        filePath: '/tmp/sess-20260101-010101-abcdef.jsonl',
        derived: true,
        nativeAvailable: false,
        nativeImportAvailable: true
    });

    assert.deepStrictEqual(messages, [{ message: '会话来源无效', type: 'error' }]);
});

test('buildResumeCommand generates codex resume with optional --yolo, codebuddy -r, gemini -r, and claude -r', () => {
    const methods = createSessionActionMethods();
    const contextBase = {
        ...methods,
        sessionResumeWithYolo: false
    };

    assert.strictEqual(
        methods.buildResumeCommand.call(contextBase, { source: 'codex', sessionId: 'sess-1' }),
        'codex resume sess-1'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'codex', sessionId: 'sess-1' }),
        'codex --yolo resume sess-1'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'codebuddy', sessionId: 'abc123' }),
        'codebuddy -r abc123'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'gemini', sessionId: 'gm-123' }),
        'gemini -r gm-123'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'claude', sessionId: 'sess-2' }),
        'claude -r sess-2'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'claude', sessionId: '', filePath: '/home/user/.claude/projects/demo/sess-3.jsonl' }),
        'claude -r sess-3'
    );

    assert.strictEqual(
        methods.buildResumeCommand.call({ ...contextBase, sessionResumeWithYolo: true }, { source: 'gemini', sessionId: '', filePath: '/home/user/.gemini/tmp/abc/chats/gm-456.json' }),
        'gemini -r gm-456'
    );
});
