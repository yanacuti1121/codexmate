# Codex Mate Desktop (Tauri)

Codex Mate 的桌面版使用 Tauri 作为 Windows / macOS 外壳，复用现有 Node CLI 与 Web UI 服务。

## 架构

- Tauri 负责桌面窗口、系统打包和平台安装包。
- 现有 `cli.js run --host 127.0.0.1 --no-browser` 继续提供本地 Web UI 与 `/api`。
- 桌面窗口加载 `http://127.0.0.1:3737`，避免重写现有 Web UI API。
- 生产包会把 `cli.js`、`cli/`、`lib/`、`plugins/`、`web-ui/` 和 `node_modules/` 作为 Tauri resources 带入包内。

## 命令

```bash
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
```

## 本地要求

桌面构建需要：

- Node.js 18+
- Rust / Cargo
- Tauri 对应平台依赖

当前实现仍通过系统 `node` 启动打包进 resources 的 Codex Mate 后端。后续如果要做完全免 Node 安装的分发，需要把 Node runtime 或预编译 sidecar 纳入打包流程。

## CI

`.github/workflows/desktop-build.yml` 会在 GitHub Actions 上构建：

- macOS bundle / dmg
- Windows installer bundle（由当前 Tauri 平台支持的 targets 决定）

构建产物会以 `codexmate-desktop-macOS` / `codexmate-desktop-Windows` artifact 上传。
