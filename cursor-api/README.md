# Cursor 工作台

本地运行的类 Cursor 界面：左侧文件树、中间编辑器、右侧 Agent 对话。填入你在 [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api) 创建的密钥（`crsr_…`）即可使用，走官方 `@cursor/sdk`，计费与 Cursor IDE 中的 Agent 相同。

## 环境

- Node.js **22.13+**（仓库带 `.nvmrc`：`22.22.1`）
- 本机已登录可用的 Cursor 账号与 API Key

```bash
cd cursor-api
source ~/.nvm/nvm.sh && nvm use
npm install
```

## 桌面应用（Mac / Windows）

开发时用 Electron 窗口打开：

```bash
npm run dev
# 或
npm run desktop
```

打包：

```bash
npm run dist:mac    # Mac arm64：release 里的 .dmg / .zip
npm run dist:win    # Windows x64 安装包（.exe）
npm run dist:all    # 两个都打
```

安装包在 `release/`：

- Mac：把 `Cursor 工作台.app` 拖进「应用程序」，或打开 `.dmg`
- Windows：解压 `CursorWorkbench-*-win-x64.zip`，运行 `Cursor 工作台.exe`

Windows 安装向导（NSIS）建议在 Windows 上把 `electron-builder.yml` 的 `win.target` 改成 `nsis` 后再打包。

安装包不含 API Key。每人在自己电脑的设置里填写后，才保存在用户目录 `~/.cursor-ui/config.json`（Windows 为 `%USERPROFILE%\.cursor-ui\config.json`），可随时查看或删除。

## 浏览器开发

```bash
npm run dev:web
```

打开 http://127.0.0.1:5173

服务只监听 `127.0.0.1`。

## 使用

1. 首次打开会进入设置页。可选两种对话来源：
   - **Cursor API Key**：粘贴 `crsr_…` 后点「保存并验证」，走官方 `@cursor/sdk` Agent（可读改文件）。
   - **CC Switch**：本机已安装并启用 [CC Switch](https://github.com/farion1231/cc-switch) 时，切到该页并「保存并检测」。默认代理 `http://127.0.0.1:15721`，读取 `~/.claude/settings.json` / `~/.grok/config.toml` 的 live 配置，**不**再存一份供应商 Key。Claude（Anthropic）、OpenAI 兼容与 **Grok Responses function calling** 均支持 **Agent 读改文件** 与 **Plan**；工具失败时自动降级纯文本。
2. 也可随时用 ⌘/Ctrl + , 打开设置。
3. 打开一个本地文件夹作为工作区（默认是 `~/.cursor-ui/workspace`；桌面版走系统文件夹对话框，⌘/Ctrl + O）。
4. 在右侧对话。**Agent** 会读改工作区文件（CC Switch 下还可 `runShell`）；**Plan** 只读并产出计划卡，Build 后切回 Agent 实施。
5. 点模型名可切换模型（API Key 模式还支持 Fast / Effort）；回车发送，Shift+Enter 换行。

## 注意

- Agent 默认会自动执行工具（读文件、改文件、跑终端），请只指向你信任的工作区。
- 不要把 API Key 发到聊天、截图或仓库里。若已经泄露，到 Dashboard 作废并重建。
- CC Switch 模式依赖本机代理；关掉 CC Switch 后需重新检测连接。
