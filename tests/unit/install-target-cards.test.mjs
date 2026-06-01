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

test('app update notice only appears when latest package version is newer', () => {
    const ctx = createContext({
        appVersion: '0.0.40',
        appLatestVersion: '0.0.41',
        t(key, params = {}) {
            if (key === 'side.update.availableWithVersion') return `Update v${params.version}`;
            if (key === 'side.update.metaVersions') return `${params.current}->${params.latest}`;
            return key;
        }
    });

    assert.strictEqual(ctx.comparePackageVersions('0.0.40', '0.0.41'), -1);
    assert.strictEqual(ctx.comparePackageVersions('0.0.41', '0.0.40'), 1);
    assert.strictEqual(ctx.comparePackageVersions('v0.0.41', '0.0.41'), 0);
    assert.strictEqual(ctx.isAppUpdateAvailable(), true);
    assert.strictEqual(ctx.appUpdateNoticeText(), 'Update v0.0.41');
    assert.strictEqual(ctx.appUpdateNoticeMeta(), '0.0.40->0.0.41');

    ctx.appLatestVersion = '0.0.40';
    assert.strictEqual(ctx.isAppUpdateAvailable(), false);
});

test('openAppUpdateDocs switches to docs update command without running update', () => {
    const calls = [];
    const ctx = createContext({
        installCommandAction: 'install',
        switchMainTab(tab) { calls.push(tab); }
    });

    ctx.openAppUpdateDocs();

    assert.strictEqual(ctx.installCommandAction, 'update');
    assert.deepStrictEqual(calls, ['docs']);
});
