import { Eye, EyeOff, KeyRound, RefreshCw, Trash2, X, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { listModels, saveSettings, type AiSource, type Settings } from "../api";

type Props = {
  settings: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
};

type Tab = "source" | "apiKey" | "ccswitch";

export function SettingsPage({ settings, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>(settings.aiSource === "ccswitch" ? "ccswitch" : "apiKey");
  const [aiSource, setAiSource] = useState<AiSource>(settings.aiSource === "ccswitch" ? "ccswitch" : "apiKey");
  const [apiKey, setApiKey] = useState(settings.apiKey || "");
  const [proxyUrl, setProxyUrl] = useState(settings.ccswitchProxyUrl || "http://127.0.0.1:15721");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [status, setStatus] = useState(settings.ccswitchStatus);

  useEffect(() => {
    setApiKey(settings.apiKey || "");
    setAiSource(settings.aiSource === "ccswitch" ? "ccswitch" : "apiKey");
    setProxyUrl(settings.ccswitchProxyUrl || "http://127.0.0.1:15721");
    setStatus(settings.ccswitchStatus);
  }, [settings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const switchSource = async (next: AiSource) => {
    if (busy || next === aiSource) {
      setTab(next === "ccswitch" ? "ccswitch" : "apiKey");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({
        aiSource: next,
        ccswitchProxyUrl: proxyUrl.trim() || "http://127.0.0.1:15721",
      });
      setAiSource(saved.aiSource === "ccswitch" ? "ccswitch" : "apiKey");
      setStatus(saved.ccswitchStatus);
      setTab(next === "ccswitch" ? "ccswitch" : "apiKey");
      setOk(next === "ccswitch" ? "已切换到 CC Switch。" : "已切换到 Cursor API Key。");
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    if (busy || !apiKey.trim()) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({ apiKey: apiKey.trim(), aiSource: "apiKey" });
      await listModels();
      setOk("密钥有效，已保存到本机。");
      setApiKey(saved.apiKey || apiKey.trim());
      setAiSource("apiKey");
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !settings.hasKey) return;
    if (!window.confirm("删除后需要重新填写才能用 API Key 对话，确定删除本机保存的 API Key？")) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({ clearApiKey: true });
      setApiKey("");
      setShow(false);
      setOk("已删除。安装包不会自带密钥，只有你再次保存后才会记住。");
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCcSwitch = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({
        aiSource: "ccswitch",
        ccswitchProxyUrl: proxyUrl.trim() || "http://127.0.0.1:15721",
      });
      setAiSource("ccswitch");
      setStatus(saved.ccswitchStatus);
      setProxyUrl(saved.ccswitchProxyUrl || proxyUrl);
      if (saved.ccswitchStatus?.connected) {
        setOk("已连接 CC Switch。");
        try {
          await listModels();
        } catch {
          /* models may still fall back server-side */
        }
      } else {
        setError(saved.ccswitchStatus?.error || "未连接 CC Switch");
      }
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page">
      <header className="settings-top">
        <span>Cursor Settings</span>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="settings-body">
        <aside className="settings-nav">
          <button
            type="button"
            className={tab === "apiKey" ? "on" : ""}
            onClick={() => setTab("apiKey")}
          >
            <KeyRound size={15} />
            API Key
          </button>
          <button
            type="button"
            className={tab === "ccswitch" ? "on" : ""}
            onClick={() => setTab("ccswitch")}
          >
            <Waypoints size={15} />
            CC Switch
          </button>
        </aside>
        <section className="settings-main">
          <div className="settings-source-toggle" role="tablist" aria-label="对话来源">
            <button
              type="button"
              className={aiSource === "apiKey" ? "on" : ""}
              disabled={busy}
              onClick={() => void switchSource("apiKey")}
            >
              Cursor API Key
            </button>
            <button
              type="button"
              className={aiSource === "ccswitch" ? "on" : ""}
              disabled={busy}
              onClick={() => void switchSource("ccswitch")}
            >
              CC Switch
            </button>
          </div>

          {tab === "ccswitch" ? (
            <>
              <h2>CC Switch</h2>
              <p className="settings-desc">
                使用本机 CC Switch 当前启用的供应商对话。不复制其 API Key，只读取 Claude live 配置与本地代理。Claude、OpenAI 与 Grok（Responses function calling）均支持 Agent 读改文件与 Plan。
              </p>
              <p className="settings-hint">
                当前来源：{aiSource === "ccswitch" ? "CC Switch" : "API Key"}
                {status?.connected
                  ? ` · 已连接${status.providerHint ? `（${status.providerHint}）` : ""}`
                  : " · 未连接"}
              </p>
              {status?.baseUrl ? (
                <p className="settings-hint">端点：{status.baseUrl}</p>
              ) : null}
              {status?.error && !ok ? <p className="err">{status.error}</p> : null}

              <label className="settings-label" htmlFor="ccswitch-proxy-url">
                本地代理地址
              </label>
              <div className="settings-key">
                <input
                  id="ccswitch-proxy-url"
                  type="text"
                  placeholder="http://127.0.0.1:15721"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              {error ? <p className="err">{error}</p> : null}
              {ok ? <p className="settings-ok">{ok}</p> : null}
              <div className="settings-actions">
                <button type="button" className="btn primary" disabled={busy} onClick={() => void saveCcSwitch()}>
                  {busy ? "处理中…" : "保存并检测"}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void saveCcSwitch()}>
                  <RefreshCw size={14} />
                  刷新状态
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>API Key</h2>
              <p className="settings-desc">
                在 cursor.com/dashboard/api 创建密钥，格式为 crsr_…。安装包不含密钥；只有你在这台电脑保存后才会记住，别人安装后是空的。
              </p>
              {settings.hasKey ? (
                <p className="settings-hint">当前本机已保存密钥，可查看或删除。</p>
              ) : (
                <p className="settings-hint">尚未配置。保存后才能用官方 Agent 对话，并只留在这台电脑。</p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveKey();
                }}
              >
                <label className="settings-label" htmlFor="cursor-api-key">
                  Cursor API Key
                </label>
                <div className="settings-key">
                  <input
                    id="cursor-api-key"
                    type={show ? "text" : "password"}
                    placeholder="crsr_…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={!settings.hasKey && aiSource === "apiKey"}
                  />
                  <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} title={show ? "隐藏" : "显示"}>
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {error ? <p className="err">{error}</p> : null}
                {ok ? <p className="settings-ok">{ok}</p> : null}
                <div className="settings-actions">
                  <button type="submit" className="btn primary" disabled={busy || !apiKey.trim()}>
                    {busy ? "处理中…" : settings.hasKey ? "更新并验证" : "保存并验证"}
                  </button>
                  {settings.hasKey ? (
                    <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
                      <Trash2 size={14} />
                      删除 API Key
                    </button>
                  ) : null}
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
