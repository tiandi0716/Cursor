import {
  Braces,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Database,
  Terminal,
  type LucideIcon,
} from "lucide-react";

type Meta = { icon: LucideIcon; color: string };

const BY_EXT: Record<string, Meta> = {
  ts: { icon: FileCode, color: "#4a9eed" },
  tsx: { icon: FileCode, color: "#4a9eed" },
  js: { icon: FileCode, color: "#e5c453" },
  jsx: { icon: FileCode, color: "#e5c453" },
  mjs: { icon: FileCode, color: "#e5c453" },
  cjs: { icon: FileCode, color: "#e5c453" },
  java: { icon: FileCode, color: "#e8845a" },
  kt: { icon: FileCode, color: "#b07cf0" },
  py: { icon: FileCode, color: "#5fa8d3" },
  go: { icon: FileCode, color: "#5cc8d8" },
  rs: { icon: FileCode, color: "#d6805c" },
  c: { icon: FileCode, color: "#6a9fd8" },
  cpp: { icon: FileCode, color: "#6a9fd8" },
  h: { icon: FileCode, color: "#6a9fd8" },
  cs: { icon: FileCode, color: "#8fc66b" },
  php: { icon: FileCode, color: "#9a8fe0" },
  rb: { icon: FileCode, color: "#e0645c" },
  html: { icon: FileCode, color: "#e8845a" },
  vue: { icon: FileCode, color: "#5fc08a" },
  css: { icon: FileCode, color: "#6aa7e8" },
  scss: { icon: FileCode, color: "#d27ab0" },
  less: { icon: FileCode, color: "#6a8fd8" },
  xml: { icon: FileCode, color: "#e8a45a" },
  json: { icon: FileJson, color: "#e5c453" },
  jsonc: { icon: FileJson, color: "#e5c453" },
  yml: { icon: FileCog, color: "#c8d06a" },
  yaml: { icon: FileCog, color: "#c8d06a" },
  toml: { icon: FileCog, color: "#c8d06a" },
  properties: { icon: FileCog, color: "#c8d06a" },
  env: { icon: FileCog, color: "#c8d06a" },
  md: { icon: FileText, color: "#7aa2d8" },
  txt: { icon: FileText, color: "#8a8a8a" },
  log: { icon: FileText, color: "#8a8a8a" },
  sql: { icon: Database, color: "#d2a45a" },
  sh: { icon: Terminal, color: "#7ec87a" },
  zsh: { icon: Terminal, color: "#7ec87a" },
  bat: { icon: Terminal, color: "#7ec87a" },
  png: { icon: FileImage, color: "#b07cd0" },
  jpg: { icon: FileImage, color: "#b07cd0" },
  jpeg: { icon: FileImage, color: "#b07cd0" },
  gif: { icon: FileImage, color: "#b07cd0" },
  webp: { icon: FileImage, color: "#b07cd0" },
  svg: { icon: FileImage, color: "#e8a45a" },
  xlsx: { icon: FileSpreadsheet, color: "#5cb87a" },
  xls: { icon: FileSpreadsheet, color: "#5cb87a" },
  csv: { icon: FileSpreadsheet, color: "#5cb87a" },
  docx: { icon: FileText, color: "#5a8fe0" },
  doc: { icon: FileText, color: "#5a8fe0" },
  pdf: { icon: FileText, color: "#e0645c" },
  zip: { icon: FileArchive, color: "#c0a060" },
  rar: { icon: FileArchive, color: "#c0a060" },
  gz: { icon: FileArchive, color: "#c0a060" },
  jar: { icon: FileArchive, color: "#c0a060" },
  postman_collection: { icon: Braces, color: "#e8845a" },
};

export function fileTypeMeta(name: string): Meta {
  const base = name.split("/").pop() || name;
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return { icon: FileCog, color: "#5aa0e0" };
  if (lower.startsWith(".env")) return BY_EXT.env;
  if (lower.endsWith(".postman_collection.json")) return BY_EXT.postman_collection;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  return BY_EXT[ext] || { icon: File, color: "#8a8a8a" };
}

export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const { icon: Icon, color } = fileTypeMeta(name);
  return <Icon size={size} color={color} strokeWidth={1.8} style={{ flexShrink: 0 }} />;
}
