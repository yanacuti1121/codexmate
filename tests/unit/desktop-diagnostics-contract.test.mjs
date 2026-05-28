import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('desktop release diagnostics expose console and file logging paths', () => {
    const mainSource = readSource('src-tauri/src/main.rs');
    const libSource = readSource('src-tauri/src/lib.rs');

    assert.match(mainSource, /app_lib::init_desktop_diagnostics\(\)/);
    assert.match(libSource, /CODEXMATE_DESKTOP_LOG/);
    assert.match(libSource, /CODEXMATE_DESKTOP_LOG_FILE/);
    assert.match(libSource, /--debug-console/);
    assert.match(libSource, /--log-to-console/);
    assert.match(libSource, /AttachConsole/);
    assert.match(libSource, /ATTACH_PARENT_PROCESS/);
    assert.match(libSource, /CONOUT\$/);
    assert.match(libSource, /CodexMate[\s\S]*logs[\s\S]*desktop\.log/);
    assert.match(libSource, /std::panic::set_hook/);
});

test('desktop debug console mode inherits backend stdout and stderr', () => {
    const libSource = readSource('src-tauri/src/lib.rs');

    assert.match(libSource, /let inherit_backend_stdio = DESKTOP_CONSOLE_LOGGING\.load/);
    assert.match(libSource, /command\.stdout\(Stdio::inherit\(\)\)\.stderr\(Stdio::inherit\(\)\)/);
    assert.match(libSource, /fn desktop_log_stdio\(\) -> Stdio/);
    assert.match(libSource, /command\.stdout\(desktop_log_stdio\(\)\)\.stderr\(desktop_log_stdio\(\)\)/);
    assert.match(libSource, /if DESKTOP_CONSOLE_LOGGING\.load[\s\S]*return;[\s\S]*CREATE_NO_WINDOW/);
});
