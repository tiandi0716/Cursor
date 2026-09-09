import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Settings as SettingsIcon } from "lucide-react";
import {
  getSettings,
  listModels,
  saveSettings,
  startTunnel,
  stopTunnel,
  type ModelInfo,
  type Settings,
} from "./api";
import { ModelPicker } from "./components/ModelPicker";
import { SettingsPage } from "./components/SettingsPage";

function sourceLabel(source: Settings["keySource"]) {
  if (source === "proxy") return "代理已保存";
  if (source === "workbench") return "工作台密钥";
  if (source === "env") return "环境变量";
  return "未配置";
}

function timeLabel(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | "">("");
  const [loadError, setLoadError] = useState("");
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelErr, setTunnelErr] = useState("");

  const refreshModels = useCallback(async () => {
    try {
      setModels(await listModels());
    } catch {
      setModels([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    const s = await getSettings();
    setSettings(s);
    if (s.hasKey) await refreshModels();
    else setModels([]);
  }, [refreshModels]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
        if (!s.hasKey) setShowSettings(true);
        else await refreshModels();
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshModels]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void getSettings()
        .then(setSettings)
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return window.desktop?.onOpenSettings?.(() => setShowSettings(true));
  }, []);

  const copy = async (kind: "url" | "token", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(""), 1500);
  };

  const toggleTunnel = async () => {
    if (!settings || tunnelBusy) return;
    setTunnelBusy(true);
    setTunnelErr("");
    try {
      const next = settings.tunnelRunning ? await stopTunnel() : await startTunnel();
      setSettings(next);
    } catch (e) {
      setTunnelErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTunnelBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="app">
        <header className="titlebar">
          <div className="brand">Cursor 代理</div>
        </header>
        <div className="empty">{loadError}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="app">
        <header className="titlebar">
          <div className="brand">Cursor 代理</div>
        </header>
        <div className="empty">正在连接本地代理…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">Cursor 代理</div>
        <span className="spacer" />
        <button type="button" className="icon-btn bar-btn" title="设置" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={15} />
        </button>
        {typeof window !== "undefined" && window.desktop?.platform === "win32" ? (
          <div className="win-controls">
            <button type="button" title="最小化" onClick={() => window.desktop?.minimize()}>
              ─
            </button>
            <button type="button" title="最大化" onClick={() => window.desktop?.maximize()}>
              ☐
            </button>
            <button type="button" className="win-close" title="关闭" onClick={() => window.desktop?.close()}>
              ×
            </button>
          </div>
        ) : null}
      </header>

      <main className="page">
        <section className="card">
          <h2>连接 Cursor IDE</h2>
          <p className="warn">
            Cursor 是从官方云端去请求 Base URL 的，所以不能填 127.0.0.1，否则会报 Access to private networks is
            forbidden。需要先开公网 HTTPS 隧道。
          </p>
          <div className="tunnel-row">
            <button
              type="button"
              className={`btn ${settings.tunnelRunning ? "danger" : "primary"}`}
              disabled={tunnelBusy || (!settings.hasCloudflared && !settings.tunnelRunning)}
              onClick={() => void toggleTunnel()}
            >
              {tunnelBusy ? "处理中…" : settings.tunnelRunning ? "关闭隧道" : "开启公网隧道"}
            </button>
            {!settings.hasCloudflared ? (
              <span className="settings-hint">未找到 cloudflared，请先执行 brew install cloudflared</span>
            ) : null}
          </div>
          {tunnelErr || settings.tunnelError ? (
            <p className="err">{tunnelErr || settings.tunnelError}</p>
          ) : null}

          <label className="settings-label">Override OpenAI Base URL</label>
          <div className="url-row">
            <code>{settings.baseUrl}</code>
            <button type="button" className="btn ghost" onClick={() => void copy("url", settings.baseUrl)}>
              {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "url" ? "已复制" : "复制"}
            </button>
          </div>
          {!settings.tunnelRunning ? (
            <p className="settings-hint">上面现在是本机地址，Cursor 用不了。开启隧道后会变成 https://….trycloudflare.com/v1</p>
          ) : null}

          <label className="settings-label">Cursor 里的 OpenAI API Key（访问令牌，不是 crsr_）</label>
          <div className="url-row">
            <code>{settings.accessToken}</code>
            <button type="button" className="btn ghost" onClick={() => void copy("token", settings.accessToken)}>
              {copied === "token" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "token" ? "已复制" : "复制"}
            </button>
          </div>

          <ol className="steps">
            <li>点「开启公网隧道」，复制 HTTPS 的 Base URL</li>
            <li>Cursor Settings → Models，打开 OpenAI API Key，粘贴上面的访问令牌</li>
            <li>勾选 Override OpenAI Base URL，粘贴隧道地址（以 /v1 结尾）</li>
            <li>Network 里把 HTTP Compatibility 调成 HTTP/1.1</li>
            <li>
              Add Model，建议填 <code>{settings.suggestedName}</code> 或 <code>cursor-proxy-plan</code>，也可以填任意名字
            </li>
            <li>
              对话里选这个自定义模型，输入框旁切到 <strong>Plan</strong>，不要用 ∞ Agent。Plan 会回
              <code>create_plan</code> 卡片；自定义 Key 下 ∞ Agent 要 Cursor 自己的工具协议，代理第一期不接
            </li>
            <li>关掉代理或隧道后 Cursor 会连不上</li>
          </ol>
        </section>

        <section className="card">
          <h2>实际模型</h2>
          <p className="muted">从 Cursor 账号拉取可选模型，和工作台里一样，可开 Fast、调 Effort。</p>
          {settings.hasKey ? (
            <ModelPicker
              models={models}
              model={settings.model}
              modelParams={settings.modelParams || []}
              onChange={async (id, modelParams) => {
                const next = await saveSettings({ model: id, modelParams });
                setSettings(next);
              }}
            />
          ) : (
            <p className="settings-hint">先在设置里保存 API Key，才能拉模型列表。</p>
          )}
        </section>

        <section className="card">
          <h2>最近请求</h2>
          {settings.recent?.length ? (
            <ul className="log">
              {settings.recent.map((item, i) => (
                <li key={`${item.at}-${i}`} className={item.ok ? "" : "fail"}>
                  <span className="t">{timeLabel(item.at)}</span>
                  <span className={`kind ${item.kind === "plan" ? "plan" : "ask"}`}>
                    {item.kind === "plan" ? "Plan" : "Ask"}
                  </span>
                  {item.reply ? (
                    <span className={`kind ${item.reply === "tool_calls" ? "plan" : "ask"}`}>
                      {item.reply === "tool_calls" ? "卡片" : "文本"}
                    </span>
                  ) : null}
                  <span className="map">
                    {item.requested} → {item.used}
                  </span>
                  <span className="ms">{item.ms}ms</span>
                  {item.error ? <span className="err-inline">{item.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-hint">还没有来自 Cursor 的请求。</p>
          )}
        </section>
      </main>

      <footer className="status">
        {settings.hasKey ? <span className="dot-ok" /> : <span className="dot-off" />}
        <span>{settings.hasKey ? `API Key ${settings.keyHint}` : "未配置 API Key"}</span>
        <span>{sourceLabel(settings.keySource)}</span>
        <span>{settings.tunnelRunning ? "隧道已开" : "仅本机"}</span>
        <span>{settings.model}</span>
        {settings.modelParams?.find((p) => p.id === "fast")?.value === "true" ? <span>Fast</span> : null}
        {(() => {
          const e = settings.modelParams?.find((p) => p.id === "effort" || p.id === "reasoning");
          return e ? <span>{e.value}</span> : null;
        })()}
      </footer>

      {showSettings ? (
        <SettingsPage
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
