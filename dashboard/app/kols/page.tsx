"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KolConfig } from "@shared/types";
import { kolApi } from "@/lib/api";
import type { CreateKol, UpdateKol } from "@/lib/api";
import { Modal } from "../components/modal";

function authorColor(id: string): string {
  const colors = ["#5865F2","#57F287","#FEE75C","#EB459E","#ED4245","#3BA55C","#F47B67","#9B59B6"];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[n % colors.length];
}

function KolAvatar({ kol, size = 36 }: { kol: Pick<KolConfig, "id" | "label" | "avatarPath">; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const hasAvatar = !!kol.avatarPath && !imgError;
  return (
    <div
      className="shrink-0 rounded-full overflow-hidden flex items-center justify-center font-bold text-white"
      style={{ width: size, height: size, backgroundColor: hasAvatar ? "transparent" : authorColor(kol.id), fontSize: size * 0.42 }}
    >
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={kolApi.avatarUrl(kol.id)} alt={kol.label} width={size} height={size}
          className="h-full w-full object-cover" onError={() => setImgError(true)} />
      ) : (
        kol.label.charAt(0).toUpperCase()
      )}
    </div>
  );
}

// ==================== Page ====================

export default function KolsPage() {
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KolConfig | null>(null);
  const [showModal, setShowModal] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setKols(await kolApi.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleSave(data: CreateKol, avatarFile?: File) {
    let savedKol: KolConfig;
    if (editing) {
      const { id: _id, ...rest } = data;
      savedKol = await kolApi.update(editing.id, rest as UpdateKol);
    } else {
      savedKol = await kolApi.create(data);
    }
    if (avatarFile) await kolApi.uploadAvatar(savedKol.id, avatarFile);
    setShowModal(false);
    await refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm("确定要删除这个 KOL 吗？")) return;
    await kolApi.remove(id);
    await refresh();
  }

  async function handleToggle(kol: KolConfig) {
    await kolApi.update(kol.id, { enabled: !kol.enabled });
    await refresh();
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">KOL 管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理你关注的 KOL，设置风险参数和信任度</p>
        </div>
        <button onClick={() => { setEditing(null); setShowModal(true); }}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          + 添加 KOL
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium w-12">头像</th>
              <th className="px-4 py-3 font-medium">名称</th>
              <th className="px-4 py-3 font-medium">Discord ID</th>
              <th className="px-4 py-3 font-medium">启用</th>
              <th className="px-4 py-3 font-medium text-right">风险倍数</th>
              <th className="px-4 py-3 font-medium text-right">最大持仓</th>
              <th className="px-4 py-3 font-medium text-right">默认把握度</th>
              <th className="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">加载中…</td></tr>
            )}
            {!loading && kols.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">暂无 KOL，点击右上角添加</td></tr>
            )}
            {kols.map((kol) => (
              <tr key={kol.id} className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-4 py-2"><KolAvatar kol={kol} size={32} /></td>
                <td className="px-4 py-3 font-medium">{kol.label}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{kol.id}</td>
                <td className="px-4 py-3"><Toggle enabled={kol.enabled} onToggle={() => void handleToggle(kol)} /></td>
                <td className="px-4 py-3 text-right font-mono">{kol.riskMultiplier}x</td>
                <td className="px-4 py-3 text-right font-mono">{kol.maxOpenPositions}</td>
                <td className="px-4 py-3 text-right font-mono">{(kol.defaultConviction * 100).toFixed(0)}%</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEditing(kol); setShowModal(true); }}
                    className="mr-2 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">编辑</button>
                  <button onClick={() => void handleDelete(kol.id)}
                    className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? "编辑 KOL" : "添加 KOL"}>
        <KolForm initial={editing} onSave={(data, file) => void handleSave(data, file)} onCancel={() => setShowModal(false)} />
      </Modal>
    </div>
  );
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`inline-flex h-6 w-10 items-center rounded-full transition-colors ${enabled ? "bg-success" : "bg-border"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}

const inputClass = "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50";
const labelClass = "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

function KolForm({ initial, onSave, onCancel }: {
  initial: KolConfig | null;
  onSave: (data: CreateKol, avatarFile?: File) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [riskMultiplier, setRiskMultiplier] = useState(String(initial?.riskMultiplier ?? 1));
  const [maxOpenPositions, setMaxOpenPositions] = useState(String(initial?.maxOpenPositions ?? 3));
  const [defaultConviction, setDefaultConviction] = useState(String(initial?.defaultConviction ?? 0.5));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    initial?.avatarPath ? kolApi.avatarUrl(initial.id) : null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(
      { id, label, enabled, riskMultiplier: Number(riskMultiplier), maxOpenPositions: Number(maxOpenPositions), defaultConviction: Number(defaultConviction), notes: notes || undefined },
      avatarFile ?? undefined,
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => fileInputRef.current?.click()}
          className="group relative shrink-0 overflow-hidden rounded-full" style={{ width: 64, height: 64 }} title="点击上传头像">
          {avatarPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarPreview} alt="头像预览" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-white"
              style={{ backgroundColor: id ? authorColor(id) : "#5865F2" }}>
              {(label || "K").charAt(0).toUpperCase()}
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
        <div>
          <p className="text-sm font-medium text-foreground">
            {avatarFile ? avatarFile.name : initial?.avatarPath ? "已有头像（点击替换）" : "点击头像上传图片"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">支持 JPG、PNG、GIF、WebP</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Discord User ID</label>
          <input className={inputClass} value={id} onChange={(e) => setId(e.target.value)}
            placeholder="例: 123456789012345678" required disabled={!!initial} />
        </div>
        <div>
          <label className={labelClass}>显示名称</label>
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="例: CryptoKing" required />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>风险倍数</label>
          <input type="number" step="0.1" min="0.1" className={inputClass} value={riskMultiplier} onChange={(e) => setRiskMultiplier(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>最大持仓数</label>
          <input type="number" step="1" min="0" className={inputClass} value={maxOpenPositions} onChange={(e) => setMaxOpenPositions(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>默认把握度 (0-1)</label>
          <input type="number" step="0.05" min="0" max="1" className={inputClass} value={defaultConviction} onChange={(e) => setDefaultConviction(e.target.value)} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Toggle enabled={enabled} onToggle={() => setEnabled(!enabled)} />
        <span className="text-sm text-foreground">{enabled ? "已启用" : "已禁用"}</span>
      </div>

      <div>
        <label className={labelClass}>备注</label>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="可选备注信息" />
      </div>

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <button type="button" onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">取消</button>
        <button type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          {initial ? "保存更改" : "添加"}
        </button>
      </div>
    </form>
  );
}
