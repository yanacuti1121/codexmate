const fs = require('fs');
const path = require('path');

const { parseArgs, ensureDir, resolveOutputPath } = require('./session-convert-args');
const { readSessionMessages, buildTargetRecords } = require('./session-convert-io');

function printUsage() {
    console.log('\n用法:');
    console.log('  codexmate convert-session --from <codex|claude> --to <codex|claude> (--session-id <ID>|--file <PATH>) [--output <PATH>] [--output-dir <native|derived>] [--max-messages <N|all|Infinity>]');
}


function resolveExistingDir(candidates, fallback) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
        } catch (_) {}
    }
    return fallback;
}

function resolveCodexSessionsDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [];
    if (process.env.CODEX_HOME) candidates.push(path.join(process.env.CODEX_HOME, 'sessions'));
    if (process.env.XDG_CONFIG_HOME) candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'codex', 'sessions'));
    if (home) {
        candidates.push(path.join(home, '.config', 'codex', 'sessions'));
        candidates.push(path.join(home, '.codex', 'sessions'));
    }
    return resolveExistingDir(candidates, candidates[candidates.length - 1] || path.resolve('.codex/sessions'));
}

function resolveClaudeProjectsDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [];
    const claudeHome = process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || '';
    if (claudeHome) candidates.push(path.join(claudeHome, 'projects'));
    if (process.env.XDG_CONFIG_HOME) candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'claude', 'projects'));
    if (home) {
        candidates.push(path.join(home, '.config', 'claude', 'projects'));
        candidates.push(path.join(home, '.claude', 'projects'));
    }
    return resolveExistingDir(candidates, candidates[candidates.length - 1] || path.resolve('.claude/projects'));
}

function sanitizeClaudeProjectName(cwd) {
    const value = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : 'codexmate-derived';
    return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'codexmate-derived';
}

function buildSourceKey(from, sessionId, filePath) {
    const seed = `${from}|${sessionId || ''}|${filePath || ''}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    return String(Math.abs(hash)).padStart(8, '0').slice(0, 8);
}

function resolveDefaultOutputPath(opt, sessionId, cwd) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
    if (opt.output) return resolveOutputPath(opt.output, `${opt.to}-session-${safeSessionId}.jsonl`);
    if (opt.outputDir === 'derived') {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const root = path.join(home || process.cwd(), '.codexmate', 'sessions', 'derived', opt.to, opt.from, buildSourceKey(opt.from, sessionId, opt.filePath));
        return path.join(root, `${safeSessionId}.jsonl`);
    }
    if (opt.to === 'codex') return path.join(resolveCodexSessionsDir(), `${safeSessionId}.jsonl`);
    return path.join(resolveClaudeProjectsDir(), sanitizeClaudeProjectName(cwd), `${safeSessionId}.jsonl`);
}

async function cmdConvertSession(args = [], deps = {}) {
    const parsed = parseArgs(args);
    if (parsed.error) {
        console.error('错误:', parsed.error);
        printUsage();
        process.exit(1);
    }
    if (!deps || typeof deps.resolveSessionFilePath !== 'function') {
        console.error('错误: convert-session missing resolver');
        process.exit(1);
    }
    const opt = parsed.options;
    const filePath = deps.resolveSessionFilePath(opt.from, opt.filePath, opt.sessionId);
    if (!filePath) {
        console.error('转换失败: Session file not found');
        process.exit(1);
    }
    const extracted = await readSessionMessages(filePath, opt.from, opt.maxMessages);
    const sessionId = extracted.sessionId || opt.sessionId || path.basename(filePath, '.jsonl');
    const records = buildTargetRecords(opt.to, { sessionId, cwd: extracted.cwd || '', messages: extracted.messages });
    const jsonl = `${records.map(r => JSON.stringify(r)).join('\n')}\n`;
    const outputPath = resolveDefaultOutputPath(opt, sessionId, extracted.cwd || '');
    if (fs.existsSync(outputPath)) {
        console.error('转换失败: target session already exists:', outputPath);
        process.exit(1);
    }
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, jsonl, 'utf-8');
    console.log('\n✓ 会话已转换:', outputPath);
    if (extracted.truncated) console.log('! 已截断: 可使用 --max-messages=all');
    console.log();
}

module.exports = { cmdConvertSession };

