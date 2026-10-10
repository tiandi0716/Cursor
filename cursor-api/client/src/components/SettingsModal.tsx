import { Boxes, Eye, EyeOff, KeyRound, RefreshCw, SlidersHorizontal, Trash2, X, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { getSettings, listModels, saveSettings, type AiSource, type CcSourceSummary, type ModelInfo, type Settings } from "../api";

type Props = {
  settings: Settings;
  models: ModelInfo[];
  sources: CcSourceSummary[];
  onRefreshModels: (refresh?: boolean) => Promise<void> | void;
  onClose: () => void;
  onSaved: (s: Settings) => void;
};

type Tab = "general" | "models" | "apiKey" | "ccswitch";

export function SettingsPage({ settings, models, sources, onRefreshModels, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>(settings.hasKey || settings.ccswitchStatus?.connected ? "general" : settings.aiSource === "ccswitch" ? "ccswitch" : "apiKey");
  const [refreshing, setRefreshing] = useState(false);
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

  // 设置页打开时主动再探一次，避免刚切完供应商还显示旧名称
  useEffect(() => {
    if (tab !== "ccswitch" && aiSource !== "ccswitch") return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        setStatus(s.ccswitchStatus);
        if (s.ccswitchProxyUrl) setProxyUrl(s.ccswitchProxyUrl);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, aiSource]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const switchSource = async (next: AiSource) => {
    if (busy || next === aiSource) return;
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

  const refreshModels = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshModels(true);
    } finally {
      setRefreshing(false);
    }
  };

  const modelsByProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const k = m.provider || "";
    modelsByProvider.set(k, [...(modelsByProvider.get(k) || []), m]);
  }
  const protoLabel = (p: CcSourceSummary["protocol"]) =>
    p === "anthropic" ? "Anthropic Messages" : p === "responses" ? "OpenAI Responses" : "OpenAI Chat";

  const navItem = (id: Tab, icon: React.ReactNode, label: string) => (
    <button type="button" className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
      {icon}
      {label}
    </button>
  );

  return (
    <div className="settings-page">
      <header className="settings-top">
        <span>设置</span>
        <button type="button" className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="settings-body">
        <aside className="settings-nav">
          {navItem("general", <SlidersHorizontal size={15} />, "通用")}
          {navItem("models", <Boxes size={15} />, "模型")}
          <div className="settings-nav-sep" />
          {navItem("apiKey", <KeyRound size={15} />, "Cursor API Key")}
          {navItem("ccswitch", <Waypoints size={15} />, "CC Switch")}
        </aside>
        <section className="settings-main">
          {tab === "general" ? (
            <>
              <h2>通用</h2>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-row-main">
                    <div className="set-row-title">对话来源</div>
                    <div className="set-row-desc">
                      Cursor API Key 走官方 Agent；CC Switch 读取本机 CC Switch 里已显示应用下的全部供应商。
                    </div>
                  </div>
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
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <div className="set-row-title">当前状态</div>
                    <div className="set-row-desc">
                      {aiSource === "ccswitch"
                        ? status?.connected
                          ? `已连接 · ${status.providerHint || "CC Switch"}`
                          : status?.error || "未连接 CC Switch"
                        : settings.hasKey
                          ? `已保存 API Key（${settings.keyHint}）`
                          : "尚未配置 API Key"}
                    </div>
                  </div>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <div className="set-row-title">工作区</div>
                    <div className="set-row-desc mono">{settings.workspace}</div>
                  </div>
                </div>
              </div>
              {error ? <p className="err">{error}</p> : null}
              {ok ? <p className="settings-ok">{ok}</p> : null}
            </>
          ) : null}

          {tab === "models" ? (
            <>
              <div className="set-head">
                <h2>模型</h2>
                <button type="button" className="btn" disabled={refreshing} onClick={() => void refreshModels()}>
                  <RefreshCw size={14} className={refreshing ? "spin" : ""} />
                  刷新
                </button>
              </div>
              {aiSource !== "ccswitch" ? (
                <p className="settings-desc">当前使用 Cursor API Key，模型列表来自 Cursor 官方。切换到 CC Switch 后这里会显示每个供应商及其模型。</p>
              ) : sources.length === 0 ? (
                <p className="settings-desc">
                  没读到可用的供应商。请确认 CC Switch 已安装，并在其「应用」页打开了要用的应用（Claude Code / Codex / Grok Build / Gemini CLI 等），且供应商填了 API Key。
                </p>
              ) : (
                <>
                  <p className="settings-desc">
                    读取 CC Switch「应用」页已打开显示的应用下的全部供应商（含未启用的），选中某个模型就直连它所属的供应商，不需要再回 CC Switch 切换。
                  </p>
                  <div className="set-card">
                    {sources.map((src) => {
                      const list = modelsByProvider.get(src.name) || [];
                      return (
                        <div className="set-row set-row-col" key={src.key}>
                          <div className="prov-head">
                            <span className="prov-app">{src.appLabel}</span>
                            <span className="prov-name">{src.name}</span>
                            {src.isCurrent ? <span className="prov-tag cur">CC Switch 当前</span> : null}
                            <span className="prov-tag">{protoLabel(src.protocol)}</span>
                            <span className="spacer" />
                            <span className={`prov-count ${src.error ? "bad" : ""}`}>
                              {src.error ? "不可用" : `${src.count} 个模型`}
                            </span>
                          </div>
                          <div className="set-row-desc mono">{src.host}</div>
                          {src.error ? <div className="err">{src.error}</div> : null}
                          {!src.live && !src.error ? (
                            <div className="set-row-desc warn">上游没有返回模型目录，当前使用供应商配置里指定的模型。</div>
                          ) : null}
                          {list.length ? (
                            <div className="prov-models">
                              {list.map((m) => (
                                <span key={m.id} className="prov-model" title={m.bare}>
                                  {m.displayName}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          ) : null}

          {tab === "ccswitch" ? (
            <>
              <h2>CC Switch</h2>
              <p className="settings-desc">
                工作台直接读取 CC Switch 的数据库，用各供应商自己的地址和密钥直连上游，不复制 API Key。本地代理地址仅在读不到数据库时作为兜底。
              </p>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-row-main">
                    <div className="set-row-title">连接状态</div>
                    <div className="set-row-desc">
                      {status?.connected
                        ? `已连接${status.providerHint ? ` · ${status.providerHint}` : ""}`
                        : status?.providerHint
                          ? `未连接（CC Switch 当前：${status.providerHint}）`
                          : "未连接"}
                    </div>
                  </div>
                  <button type="button" className="btn" disabled={busy} onClick={() => void saveCcSwitch()}>
                    <RefreshCw size={14} />
                    检测
                  </button>
                </div>
                <div className="set-row set-row-col">
                  <div className="set-row-title">本地代理地址</div>
                  <div className="settings-key" style={{ marginBottom: 0, width: "100%" }}>
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
                </div>
              </div>
              {status?.error && !ok ? <p className="err">{status.error}</p> : null}
              {error ? <p className="err">{error}</p> : null}
              {ok ? <p className="settings-ok">{ok}</p> : null}
              <div className="settings-actions">
                <button type="button" className="btn primary" disabled={busy} onClick={() => void saveCcSwitch()}>
                  {busy ? "处理中…" : "保存并检测"}
                </button>
              </div>
            </>
          ) : null}

          {tab === "apiKey" ? (
            <>
              <h2>Cursor API Key</h2>
              <p className="settings-desc">
                在 cursor.com/dashboard/api 创建密钥，格式为 crsr_…。安装包不含密钥；只有你在这台电脑保存后才会记住，别人安装后是空的。
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveKey();
                }}
              >
                <div className="set-card">
                  <div className="set-row set-row-col">
                    <div className="set-row-title">
                      API Key
                      <span className="set-row-sub">{settings.hasKey ? "已保存，可查看或删除" : "尚未配置"}</span>
                    </div>
                    <div className="settings-key" style={{ marginBottom: 0, width: "100%" }}>
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
                  </div>
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
          ) : null}
        </section>
      </div>
    </div>
  );
}
