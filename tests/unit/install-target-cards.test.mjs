import assert from 'assert';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { createDashboardComputed } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'web-ui', 'modules', 'app.computed.dashboard.mjs')));
const { createInstallMethods } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'web-ui', 'modules', 'app.methods.install.mjs')));

const computed = createDashboardComputed();
const installMethods = createInstallMethods();

function createContext(overrides = {}) {
    return {
        ...installMethods,
        installPackageManager: 'npm',
        installCommandAction: 'install',
        installRegistryPreset: 'default',
        installRegistryCustom: '',
        installStatusTargets: null,
        quoteShellArg(value) {
            return `'${value.replace(/'/g, `'\\''`)}'`;
        },
        ...overrides
    };
}

test('installTargetCards falls back when install-status is missing', () => {
    const ctx = createContext();
    const cards = computed.installTargetCards.call(ctx);
    assert.strictEqual(cards.length, 4);
    const ids = cards.map((item) => item.id).sort();
    assert.deepStrictEqual(ids, ['claude', 'codebuddy', 'codex', 'gemini']);
    for (const card of cards) {
        assert.strictEqual(typeof card.command, 'string');
        assert(card.command.length > 0);
    }
    const codex = cards.find((item) => item.id === 'codex');
    assert(codex);
    assert.strictEqual(typeof codex.termuxCommand, 'string');
    assert(codex.termuxCommand.includes('@mmmbuto/codex-cli-termux'));
});

