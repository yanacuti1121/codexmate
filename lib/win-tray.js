'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let trayProcess = null;
let exitMarkerPath = null;
let checkTimer = null;

function startWinTray(options = {}) {
    if (process.platform !== 'win32') return;

    const name = String(options.name || 'App');
    const port = Number(options.port) || 3000;
    const pid = process.pid;
    const url = `http://localhost:${port}`;

    exitMarkerPath = path.join(os.tmpdir(), `codexmate-tray-exit-${pid}.marker`);

    try { fs.unlinkSync(exitMarkerPath); } catch (_) {}

    const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Drawing;
using System.Windows.Forms;
public class CodexMateTrayIcon : IDisposable {
    private NotifyIcon _icon;
    private string _exitMarkerPath;
    public CodexMateTrayIcon(string tooltip, string url, string exitMarkerPath) {
        _exitMarkerPath = exitMarkerPath;
        _icon = new NotifyIcon();
        _icon.Icon = CreateIcon();
        _icon.Text = tooltip.Length > 63 ? tooltip.Substring(0, 63) : tooltip;
        _icon.Visible = true;
        var menu = new ContextMenuStrip();
        var openItem = menu.Items.Add('Open');
        openItem.Click += (s, e) => { try { System.Diagnostics.Process.Start(url); } catch {} };
        var exitItem = menu.Items.Add('Exit');
        exitItem.Click += (s, e) => {
            try { System.IO.File.WriteAllText(_exitMarkerPath, pid.ToString()); } catch {}
            Application.Exit();
        };
        _icon.ContextMenuStrip = menu;
        _icon.DoubleClick += (s, e) => { try { System.Diagnostics.Process.Start(url); } catch {} };
    }
    private static Icon CreateIcon() {
        var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp)) {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
            g.Clear(Color.FromArgb(59, 130, 246));
            using (var font = new Font('Segoe UI', 10f, FontStyle.Bold))
            using (var brush = new SolidBrush(Color.White))
                g.DrawString('C', font, brush, -1, -1);
        }
        var hIcon = bmp.GetHicon();
        var icon = Icon.FromHandle(hIcon);
        return (Icon)icon.Clone();
    }
    public void Dispose() {
        if (_icon != null) { _icon.Visible = false; _icon.Dispose(); _icon = null; }
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing.dll, System.Windows.Forms.dll

$app = New-Object CodexMateTrayIcon -ArgumentList '${name} - ${url}', '${url}', '${exitMarkerPath.replace(/\\/g, '\\\\')}'
[void][System.Windows.Forms.Application]::Run()
`;

    const scriptPath = path.join(os.tmpdir(), `codexmate-tray-${pid}.ps1`);
    fs.writeFileSync(scriptPath, script, 'utf8');

    try {
        trayProcess = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass', '-File', scriptPath
        ], { stdio: 'ignore', detached: true, windowsHide: true });
        trayProcess.unref();
        trayProcess.on('error', () => {});
        trayProcess.on('exit', () => {
            trayProcess = null;
            try { fs.unlinkSync(scriptPath); } catch (_) {}
        });
    } catch (_) {
        try { fs.unlinkSync(scriptPath); } catch (_) {}
    }

    checkTimer = setInterval(() => {
        if (!exitMarkerPath) return;
        try {
            fs.accessSync(exitMarkerPath, fs.constants.F_OK);
            try { fs.unlinkSync(exitMarkerPath); } catch (_) {}
            process.exit(0);
        } catch (_) {}
    }, 1500);
}

function stopWinTray() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    if (trayProcess) {
        try { trayProcess.kill(); } catch (_) {}
        trayProcess = null;
    }
    if (exitMarkerPath) {
        try { fs.unlinkSync(exitMarkerPath); } catch (_) {}
        exitMarkerPath = null;
    }
    if (process.platform === 'win32') {
        try {
            const scriptPath = path.join(os.tmpdir(), `codexmate-tray-${process.pid}.ps1`);
            fs.unlinkSync(scriptPath);
        } catch (_) {}
    }
}

module.exports = { startWinTray, stopWinTray };
