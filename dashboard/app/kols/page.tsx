"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KolConfig, ParserType } from "@shared/types";
import { kolApi } from "@/lib/api";
import type { CreateKol, UpdateKol } from "@/lib/api";
import { Modal } from "../components/modal";

// ==================== Constants ====================

const STRATEGY_LABEL: Record<ParserType, string> = {
  regex_structured: "Regex",
  llm_text: "LLM 文本",
  llm_vision: "LLM 视觉",
  hybrid: "混合",
};

const STRATEGY_COLOR: Record<ParserType, string> = {
  // (background tint, text color, border)
  regex_structured: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  llm_text: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  llm_vision: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  hybrid: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
};

// ==================== Helpers ====================

function authorColor(id: string): string {
  const colors = ["#5865F2","#57F287","#FEE75C","#EB459E","#ED4245","#3BA55C","#F47B67","#9B59B6"];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[n % colors.length];
}

function KolAvatar({ kol, size = 64 }: { kol: Pick<KolConfig, "id" | "label" | "avatarPath">; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const hasAvatar = !!kol.avatarPath && !imgError;
  return (
    <div
      className="shrink-0 rounded-full overflow-hidden flex items-center justify-center font-bold text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: hasAvatar ? "transparent" : authorColor(kol.id),
        fontSize: size * 0.42,
      }}
    >
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={kolApi.avatarUrl(kol.id)}
          alt={kol.label}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        kol.label.charAt(0).toUpperCase()
      )}
    </div>
  );
}

function StrategyBadge({ strategy }: { strategy?: ParserType }) {
  if (!strategy) {
    return (
      <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        未设置
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STRATEGY_COLOR[strategy]}`}
    >
      {STRATEGY_LABEL[strategy]}
    </span>
  );
}

function Toggle({ enabled, onToggle, size = "md" }: { enabled: boolean; onToggle: () => void; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-5 w-9" : "h-6 w-10";
  const knob = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const knobOn = size === "sm" ? "translate-x-4" : "translate-x-5";
  return (
    <button
      onClick={onToggle}
      className={`inline-flex ${dim} items-center rounded-full transition-colors ${enabled ? "bg-success" : "bg-border"}`}
    >
      <span className={`inline-block ${knob} rounded-full bg-white shadow transition-transform ${enabled ? knobOn : "translate-x-1"}`} />
    </button>
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

  // Sort: enabled first, then by label
  const sortedKols = [...kols].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-Hans-CN");
  });

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">KOL 管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理你关注的 KOL — 风险参数、解析策略、提示词。共 {kols.length} 位，启用 {kols.filter((k) => k.enabled).length} 位。
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowModal(true); }}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          + 添加 KOL
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && (
        <div className="mt-8 text-center text-sm text-muted-foreground">加载中…</div>
      )}

      {!loading && kols.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card/50 px-8 py-12 text-center">
          <p className="text-sm text-muted-foreground">还没有 KOL，点击右上角添加第一位</p>
        </div>
      )}

      {!loading && kols.length > 0 && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sortedKols.map((kol) => (
            <KolCard
              key={kol.id}
              kol={kol}
              onEdit={() => { setEditing(kol); setShowModal(true); }}
              onDelete={() => void handleDelete(kol.id)}
              onToggle={() => void handleToggle(kol)}
            />
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? "编辑 KOL" : "添加 KOL"}>
        <KolForm
          initial={editing}
          onSave={(data, file) => void handleSave(data, file)}
          onCancel={() => setShowModal(false)}
        />
      </Modal>
    </div>
  );
}

// ==================== Card ====================

function KolCard({ kol, onEdit, onDelete, onToggle }: {
  kol: KolConfig;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={`group relative flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
        kol.enabled ? "" : "opacity-60"
      }`}
    >
      {/* Header: avatar + label + strategy */}
      <div className="flex items-start gap-3">
        <KolAvatar kol={kol} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-base font-semibold text-foreground" title={kol.label}>
              {kol.label}
            </h3>
            <Toggle enabled={kol.enabled} onToggle={onToggle} size="sm" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StrategyBadge strategy={kol.parsingStrategy} />
            {kol.regexConfigName && (
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                {kol.regexConfigName}
              </span>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={kol.id}>
            {kol.id}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2.5">
        <Stat label="风险" value={`${kol.riskMultiplier}×`} />
        <Stat label="最大持仓" value={String(kol.maxOpenPositions)} />
        <Stat label="把握度" value={`${(kol.defaultConviction * 100).toFixed(0)}%`} />
      </div>

      {/* Style preview (from parsingHints) */}
      {kol.parsingHints?.style && kol.parsingHints.style !== "TODO: describe this KOL's signal style" && (
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={kol.parsingHints.style}>
          {kol.parsingHints.style}
        </p>
      )}

      {/* Actions */}
      <div className="mt-auto flex justify-end gap-1 pt-3">
        <button
          onClick={onEdit}
          className="rounded-md px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
        >
          编辑
        </button>
        <button
          onClick={onDelete}
          className="rounded-md px-2.5 py-1 text-xs text-danger transition-colors hover:bg-danger/10"
        >
          删除
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="font-mono text-sm font-semibold text-foreground">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

// ==================== Form ====================

const inputClass = "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50";
const labelClass = "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

const STRATEGY_OPTIONS: Array<{ value: ParserType | ""; label: string }> = [
  { value: "", label: "未设置（默认走 LLM 文本）" },
  { value: "regex_structured", label: "Regex — 固定格式 Bot 信号" },
  { value: "llm_text", label: "LLM 文本 — 自然语言解析" },
  { value: "llm_vision", label: "LLM 视觉 — 含图表截图" },
  { value: "hybrid", label: "混合 — 先 Regex，失败兜底 LLM" },
];

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

  // Parsing fields
  const [parsingStrategy, setParsingStrategy] = useState<ParserType | "">(initial?.parsingStrategy ?? "");
  const [regexConfigName, setRegexConfigName] = useState(initial?.regexConfigName ?? "");
  const [confidenceOverride, setConfidenceOverride] = useState(
    initial?.confidenceOverride !== undefined ? String(initial.confidenceOverride) : "",
  );
  const [styleHint, setStyleHint] = useState(initial?.parsingHints?.style ?? "");
  const [imagePolicy, setImagePolicy] = useState(initial?.parsingHints?.imagePolicy ?? "optional");

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    initial?.avatarPath ? kolApi.avatarUrl(initial.id) : null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const needsHints = parsingStrategy === "llm_text" || parsingStrategy === "llm_vision" || parsingStrategy === "hybrid";
  const needsRegex = parsingStrategy === "regex_structured" || parsingStrategy === "hybrid";

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Preserve existing parsingHints fields (classifierExamples, extractorExamples, vocabulary,
    // fieldDefaults) the dashboard does NOT surface — only overwrite what the form edits.
    const mergedHints = needsHints
      ? {
          ...(initial?.parsingHints ?? {}),
          style: styleHint,
          imagePolicy,
        }
      : undefined;

    const payload: CreateKol = {
      id,
      label,
      enabled,
      riskMultiplier: Number(riskMultiplier),
      maxOpenPositions: Number(maxOpenPositions),
      defaultConviction: Number(defaultConviction),
      ...(notes ? { notes } : {}),
      ...(parsingStrategy ? { parsingStrategy } : {}),
      ...(needsRegex && regexConfigName ? { regexConfigName } : {}),
      ...(confidenceOverride !== "" ? { confidenceOverride: Number(confidenceOverride) } : {}),
      ...(mergedHints ? { parsingHints: mergedHints } : {}),
    };

    onSave(payload, avatarFile ?? undefined);
  }

  return (
    <form onSubmit={handleSubmit} className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="group relative shrink-0 overflow-hidden rounded-full"
          style={{ width: 64, height: 64 }}
          title="点击上传头像"
        >
          {avatarPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarPreview} alt="头像预览" className="h-full w-full object-cover" />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-2xl font-bold text-white"
              style={{ backgroundColor: id ? authorColor(id) : "#5865F2" }}
            >
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

      {/* Basics */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Discord User ID</label>
          <input
            className={inputClass}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例: 123456789012345678"
            required
            disabled={!!initial}
          />
        </div>
        <div>
          <label className={labelClass}>显示名称</label>
          <input
            className={inputClass}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例: CryptoKing"
            required
          />
        </div>
      </div>

      {/* Risk knobs */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>风险倍数</label>
          <input
            type="number" step="0.1" min="0.1"
            className={inputClass}
            value={riskMultiplier}
            onChange={(e) => setRiskMultiplier(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>最大持仓数</label>
          <input
            type="number" step="1" min="0"
            className={inputClass}
            value={maxOpenPositions}
            onChange={(e) => setMaxOpenPositions(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>默认把握度 (0-1)</label>
          <input
            type="number" step="0.05" min="0" max="1"
            className={inputClass}
            value={defaultConviction}
            onChange={(e) => setDefaultConviction(e.target.value)}
          />
        </div>
      </div>

      {/* Parsing strategy block */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-4">
        <div>
          <label className={labelClass}>解析策略</label>
          <select
            className={inputClass}
            value={parsingStrategy}
            onChange={(e) => setParsingStrategy(e.target.value as ParserType | "")}
          >
            {STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {needsRegex && (
          <div>
            <label className={labelClass}>Regex 配置名</label>
            <input
              className={inputClass}
              value={regexConfigName}
              onChange={(e) => setRegexConfigName(e.target.value)}
              placeholder="例: wg-bot"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              引用一个已注册的正则配置（在代码里定义，dashboard 暂不支持编辑）
            </p>
          </div>
        )}

        {needsHints && (
          <>
            <div>
              <label className={labelClass}>风格描述</label>
              <textarea
                className={inputClass}
                rows={2}
                value={styleHint}
                onChange={(e) => setStyleHint(e.target.value)}
                placeholder="例: 使用 $XXX 格式表示 symbol；TP 通常写在图表里"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                注入到 LLM 系统提示词，帮助模型理解此 KOL 的发信号风格
              </p>
            </div>

            <div>
              <label className={labelClass}>图片处理</label>
              <select
                className={inputClass}
                value={imagePolicy}
                onChange={(e) => setImagePolicy(e.target.value as "required" | "optional" | "ignore")}
              >
                <option value="optional">可选 — 有就用，没有也行</option>
                <option value="required">必须 — 此 KOL 总把关键信息放图里</option>
                <option value="ignore">忽略 — 文本足够，不发图节省 token</option>
              </select>
            </div>

            <div>
              <label className={labelClass}>置信度阈值覆盖（可选，0-1）</label>
              <input
                type="number" step="0.05" min="0" max="1"
                className={inputClass}
                value={confidenceOverride}
                onChange={(e) => setConfidenceOverride(e.target.value)}
                placeholder="留空使用默认 0.6"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                LLM 抽取置信度低于此值的信号会被丢弃；不填使用全局默认
              </p>
            </div>
          </>
        )}
      </div>

      {/* Toggle */}
      <div className="flex items-center gap-3">
        <Toggle enabled={enabled} onToggle={() => setEnabled(!enabled)} />
        <span className="text-sm text-foreground">{enabled ? "已启用" : "已禁用"}</span>
      </div>

      {/* Notes */}
      <div>
        <label className={labelClass}>备注</label>
        <textarea
          className={inputClass}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="可选备注信息"
        />
      </div>

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          取消
        </button>
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          {initial ? "保存更改" : "添加"}
        </button>
      </div>
    </form>
  );
}
