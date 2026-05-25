#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const packagePath = path.join(rootDir, 'package.json');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertExists(relativePath) {
  const resolved = path.join(rootDir, relativePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`desktop resource is missing: ${relativePath}`);
  }
}

const pkg = readJson(packagePath);
const config = readJson(tauriConfigPath);

config.productName = 'Codex Mate';
config.version = pkg.version;
config.identifier = config.identifier && config.identifier !== 'com.tauri.dev'
  ? config.identifier
  : 'ai.codexmate.desktop';

config.build = {
  ...(config.build || {}),
  devUrl: 'http://127.0.0.1:3737',
  frontendDist: '../web-ui',
  beforeDevCommand: 'npm run desktop:prepare && node cli.js run --host 127.0.0.1 --no-browser',
  beforeBuildCommand: 'npm run desktop:prepare'
};

config.app = {
  ...(config.app || {}),
  windows: [
    {
      label: 'main',
      title: 'Codex Mate',
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      resizable: true,
      fullscreen: false,
      url: 'http://127.0.0.1:3737'
    }
  ],
  security: {
    ...(config.app && config.app.security ? config.app.security : {}),
    csp: null
  }
};

config.bundle = {
  ...(config.bundle || {}),
  active: true,
  targets: 'all',
  resources: {
    '../cli.js': 'codexmate/cli.js',
    '../package.json': 'codexmate/package.json',
    '../package-lock.json': 'codexmate/package-lock.json',
    '../cli': 'codexmate/cli',
    '../lib': 'codexmate/lib',
    '../plugins': 'codexmate/plugins',
    '../web-ui': 'codexmate/web-ui',
    '../web-ui.html': 'codexmate/web-ui.html',
    '../node_modules': 'codexmate/node_modules'
  }
};

[
  'cli.js',
  'package.json',
  'package-lock.json',
  'cli',
  'lib',
  'plugins',
  'web-ui',
  'node_modules'
].forEach(assertExists);

writeJson(tauriConfigPath, config);

if (fs.existsSync(cargoTomlPath)) {
  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const nextCargoToml = cargoToml.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
    `$1${pkg.version}$3`
  );
  fs.writeFileSync(cargoTomlPath, nextCargoToml);
}

console.log(`desktop config prepared for Codex Mate ${pkg.version}`);
