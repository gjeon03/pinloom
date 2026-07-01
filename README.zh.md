# pinloom

[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md)

本地 Claude Code 工作区。持久化历史记录、固定回答、项目 Wiki、Teams 编排，以及基于 GitHub 的备份。

![pinloom 工作区](docs/screenshots/05-project-workspace.png)

## 下载

不想从源码构建，直接想要应用？

**[⬇ 下载 macOS 版 pinloom（Apple Silicon）](https://github.com/gjeon03/pinloom/releases/latest)**

未签名的构建版本——首次启动时，请右键点击应用 → **打开**（或前往 **系统设置 → 隐私与安全性 → 仍要打开**）。仍然需要在本地安装并登录 Claude Code CLI。更愿意自己构建？请参阅 [快速开始](#quick-start) 和 [`packages/desktop`](packages/desktop/README.md)。

## 为什么

Claude Code 的 CLI 很出色，但会在 `~/.claude/` 重置、SDK 升级以及更换机器时丢失会话上下文。pinloom 将对话、各项目的笔记以及团队设置保存在自己本地的 SQLite + 文件系统中，因此它们能在上述所有情况下保留下来。

## 你能获得什么

- **持久化的对话历史。** 每一条消息和工具调用都会被镜像到 pinloom 自己的 SQLite 中，因此 `~/.claude/` 重置、SDK
  版本升级以及更换机器都不会丢失历史记录。
- **固定回答。** 右键点击助手消息 → "Pin"（固定）。它
  会停靠到侧边面板并在你继续聊天时保持可见，
  让你真正需要的那一句话不会随着 200 条消息向下滚动
  而消失在视野之外。
- **持久化的 Wiki，agent 在每一轮都会读取。** 位于 `~/.pinloom/wiki/` 的按项目 +
  跨项目 markdown 笔记。可从聊天会话同步、
  分析代码库以提炼约定，或带实时预览地就地编辑页面。
  → [docs/features/wiki.md](docs/features/wiki.md)
- **环境变量，注册一次即可。** 设置 → 环境
  变量。每一次 Claude/Codex agent 运行都会继承它们。不再需要
  为每个集成去修改 `~/.bashrc`。
  → [docs/features/env-vars.md](docs/features/env-vars.md)
- **Teams——通过 MCP 实现编排者 + 工作者。** 将一个编排者
  会话与 N 个工作者编为一组；编排者通过别名
  （`@be`、`@fe`）或标签（广播）进行派发。同步的 `team_ask`
  镜像了 SDK 的 Task 工具，因此编排者的回合在整个
  往返过程中都保持存活。
- **基于 GitHub 的备份。** 一键将你的 wiki 目录树推送到私有仓库，
  并在另一台机器上恢复。数据库不走 git 一侧，而是
  以可移植的 JSON 导出/导入形式存在，因此它能在多台
  笔记本之间留存，而不会用二进制差异让仓库膨胀。
- **仅限本地。** 没有认证、没有云、没有多用户。运行在
  你机器上的 `localhost:4747`。

| | |
|---|---|
| ![环境变量](docs/screenshots/03-env-var-add-form.png) | ![wiki](docs/screenshots/06-wiki-populated.png) |
| **环境变量** —— 注册一次，被每一次 agent 运行继承 | **Wiki** —— 持久化的项目记忆，agent 在每一轮都会读取 |

## 技术栈

- **运行时**：Node.js（`@anthropic-ai/claude-agent-sdk` 所必需）
- **后端**：Fastify + `@fastify/websocket` + `better-sqlite3`
- **前端**：React 19 + Vite + Tailwind CSS v4
- **Monorepo**：pnpm workspaces

## 环境要求

- **Node.js ≥ 22**（推荐 Node 24 LTS）。版本固定信息已为
  `nvm`（`.nvmrc`）和 `asdf`（`.tool-versions`）签入仓库。使用你
  偏好的任意版本管理器——如果你的系统 Node 已满足要求，也可以跳过。
- **pnpm**（如果没有，可通过 `corepack enable` 启用）
- **至少安装并在本地完成认证的一个 agent CLI**：
  - **Claude Code CLI** —— `claude --version` 应能正常工作
  - **Codex CLI**（可选的替代方案）—— `codex --version` 应能正常工作

  会话可以使用任一 agent；在 UI 中按会话选择。安装你有权访问的那一个即可。

## 快速开始

```bash
pnpm install
pnpm start           # build + run, http://localhost:4747
```

### 开发 pinloom 本身

```bash
pnpm dev             # tsx watch + Vite HMR — for editing pinloom's source
```

`pnpm dev` 会加上源文件监听，更为重量级；日常使用请用 `pnpm start`。

## 设计原则

1. **会话归 pinloom 所有，而非 Claude Code。** 所有消息和 tool_use 块都会被镜像到本地 SQLite 数据库，因此 `~/.claude/` 重置绝不会丢失对话历史。
2. **agent 的记忆存放在你掌控的磁盘上。** Wiki 位于 `~/.pinloom/wiki/`，会话位于 `data/pinloom.sqlite`。两者都可以备份到 GitHub 或导出为文件。
3. **仅显式删除。** 不会自动清除任何会话、页面或计划——由 Web UI 的操作来移除数据。
4. **仅限本地的 MVP。** 没有认证、没有云、没有多用户。在你自己的机器上运行。

## 目录结构

```
packages/
  shared/      # types, constants, zod schemas
  backend/     # Fastify app, SQLite, WS hub, claude-agent-sdk runner
  frontend/    # React UI: chat / wiki / teams / settings
  mcp-server/  # pinloom MCP tools for the Teams orchestrator
docs/
  features/    # deep-dives on individual features
  screenshots/ # committed UI screenshots for the README + features docs
e2e/
  smoke.spec.ts        # CI smoke test
  walkthrough.spec.ts  # regenerates docs/screenshots/ + a .webm walkthrough
```

## 重新生成截图 + 演示视频

`docs/screenshots/` 中的截图以及位于
`docs/walkthrough.webm` 的演练视频由一个 Playwright spec 生成：

```bash
pnpm exec playwright test --config e2e/walkthrough.config.ts
cp e2e/artifacts/screenshots/*.png docs/screenshots/
cp e2e/artifacts/walkthrough.webm docs/walkthrough.webm
```

该演练会：

- 在 `localhost:4747` 上启动一个全新的后端 + 前端，使用 `$TMPDIR` 下
  一个一次性的 SQLite 以及被覆盖的 `$HOME`——它绝不会触碰
  `data/pinloom.sqlite` 或你真实的 `~/.pinloom/`。
- 在测试开始前通过本地 `claude` CLI 预先获取一个真实的 Claude 回答
  （这样录制就不会是一个空白标签页在等待 SDK），
  通过直接操作 SQLite 插入问答，并通过公开的
  `PATCH /api/messages/:id` 路由固定该助手消息。
- 在磁盘上预置三个 wiki 页面，使 Wiki 仪表盘能捕捉到真实
  内容，而不是空状态。

需要宿主机的 `claude` CLI 已完成认证——SDK
内置的原生二进制选择器偏好一个在
glibc Linux 上无法运行的 musl 构建版本，因此我们改为调用系统 CLI。

## 许可证

MIT
