import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

test('desktop staging creates validated runtime resource layout', () => {
    const result = spawnSync(process.execPath, ['tools/desktop/prepare-tauri-resources.js'], {
        cwd: projectRoot,
        encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const stageRoot = path.join(projectRoot, 'dist', 'desktop', 'codexmate');
    const requiredEntries = [
        'codexmate-desktop.json',
        'cli.js',
        'cli',
        'lib',
        'plugins',
        'web-ui',
        'web-ui.html',
        'package.json',
        'package-lock.json',
        'node_modules'
    ];

    for (const entry of requiredEntries) {
        assert.ok(fs.existsSync(path.join(stageRoot, entry)), `missing staged desktop resource: ${entry}`);
    }

    const pkg = readJson(path.join(projectRoot, 'package.json'));
    const manifest = readJson(path.join(stageRoot, 'codexmate-desktop.json'));
    assert.strictEqual(manifest.layoutVersion, 1);
    assert.strictEqual(manifest.version, pkg.version);
    assert.strictEqual(manifest.entrypoint, 'cli.js');
    assert.ok(manifest.copiedRuntimeModules > 0, 'manifest should record copied runtime node modules');

    for (const dependencyName of Object.keys(pkg.dependencies || {})) {
        const dependencyPath = path.join(stageRoot, 'node_modules', ...dependencyName.split('/'));
        assert.ok(fs.existsSync(dependencyPath), `missing staged runtime dependency: ${dependencyName}`);
    }

    const tauriConfig = readJson(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'));
    assert.strictEqual(tauriConfig.bundle.resources['../dist/desktop/codexmate'], 'codexmate');
    assert.match(tauriConfig.app.security.csp, /default-src 'self'/);
    assert.match(tauriConfig.app.security.csp, /http:\/\/127\.0\.0\.1:3737/);
});
