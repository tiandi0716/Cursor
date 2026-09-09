# Cursor OpenAI 兼容代理

把 Dashboard 的 `crsr_…` 包成 OpenAI 的 `/v1/chat/completions`，让 **Cursor IDE** 通过「自定义 OpenAI 地址」调用。真正用哪个模型、Fast / Effort 在本应用里选；Cursor 里的模型名可以随便起。

**Cursor 不能填 `http://127.0.0.1:8765/v1`。** 请求是从 Cursor 官方云端发出的，本机地址会被拦成 `Access to private networks is forbidden`。必须开公网 HTTPS 隧道。

代理只做纯文本：关掉了 SDK 工具，不会改你的项目文件。Tab / Auto / 官方 Composer 仍走 Cursor 登录账号。

## 桌面端（推荐）

需要 Node **22.13+**，以及本机已安装 `cloudflared`（`brew install cloudflared`）：

```bash
cd Cursor/cursor-proxy
source ~/.nvm/nvm.sh && nvm use
npm install
npm run desktop
```

窗口里点 **开启公网隧道**，然后：

1. Cursor Settings → Models，打开 OpenAI API Key，填窗口里的 **访问令牌**（`cpx_…`，不是 `crsr_`）
2. Override OpenAI Base URL 填隧道地址，形如 `https://xxxx.trycloudflare.com/v1`
3. HTTP Compatibility → HTTP/1.1
4. Add Model，名字随便起（建议 `cursor-proxy`，Plan 也可加 `cursor-proxy-plan`）
5. 对话里选这个自定义模型，输入框旁切到 **Plan**（不要用 ∞ Agent）。Plan 会回 `create_plan` 卡片，不是普通聊天正文

关掉代理窗口或隧道后，Cursor 会连不上。

配置写在 `~/.cursor-ui/proxy.json`，权限 600。公网隧道只暴露 `/v1`，访问要带令牌。
