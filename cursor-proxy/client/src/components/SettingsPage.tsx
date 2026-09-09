import { Eye, EyeOff, KeyRound, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { listModels, saveSettings, type Settings } from "../api";

type Props = {
  settings: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
};

export function SettingsPage({ settings, onClose, onSaved }: Props) {
  const [apiKey, setApiKey] = useState(settings.apiKey || "");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    setApiKey(settings.apiKey || "");
  }, [settings.apiKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (busy || !apiKey.trim()) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({ apiKey: apiKey.trim() });
      await listModels();
      setOk("密钥有效，已保存到本机。");
      setApiKey(saved.apiKey || apiKey.trim());
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || settings.keySource !== "proxy") return;
    if (!window.confirm("删除后若工作台里还有密钥会继续使用那把。确定删除代理自己保存的 API Key？")) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const saved = await saveSettings({ clearApiKey: true });
      setApiKey(saved.apiKey || "");
      setShow(false);
      setOk(saved.hasKey ? "已删除代理密钥，当前改用工作台里的密钥。" : "已删除。");
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
          <button type="button" className="on">
            <KeyRound size={15} />
            API Key
          </button>
        </aside>
        <section className="settings-main">
          <h2>API Key</h2>
          <p className="settings-desc">
            在 cursor.com/dashboard/api 创建密钥，格式为 crsr_…。安装包不含密钥。也可以继续用工作台里已经保存的那把。
          </p>
          {settings.keySource === "workbench" ? (
            <p className="settings-hint">当前使用工作台（~/.cursor-ui/config.json）里的密钥。</p>
          ) : settings.hasKey ? (
            <p className="settings-hint">当前本机已保存密钥，可查看或删除。</p>
          ) : (
            <p className="settings-hint">尚未配置。保存后 Cursor IDE 才能通过代理调用。</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
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
                autoFocus={!settings.hasKey}
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
              {settings.keySource === "proxy" ? (
                <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
                  <Trash2 size={14} />
                  删除 API Key
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
