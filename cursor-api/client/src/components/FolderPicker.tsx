import { useEffect, useState } from "react";
import { browse } from "../api";
import { Folder } from "lucide-react";

type Props = {
  initial: string;
  onClose: () => void;
  onPick: (path: string) => void;
};

export function FolderPicker({ initial, onClose, onPick }: Props) {
  const [path, setPath] = useState(initial || "");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [error, setError] = useState("");

  const load = async (p: string) => {
    try {
      const data = await browse(p);
      setPath(data.path);
      setParent(data.parent);
      setEntries(data.entries);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load(initial);
  }, [initial]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>打开工作区</h3>
        <div className="path-line">{path}</div>
        {error ? <p className="err">{error}</p> : null}
        <div className="folder-list">
          {parent ? (
            <button onClick={() => void load(parent)}>
              <Folder size={14} /> ..
            </button>
          ) : null}
          {entries.map((e) => (
            <button key={e.path} onClick={() => void load(e.path)}>
              <Folder size={14} /> {e.name}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onPick(path)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
