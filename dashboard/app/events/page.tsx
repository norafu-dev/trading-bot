"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KolConfig } from "@shared/types";
import { eventApi, kolApi } from "@/lib/api";
import type { EventEntry } from "@/lib/api";

// ==================== Constants ====================

const POLL_MS = 3_000;

const TYPE_META: Record<string, { label: string; className: string; icon: string }> = {
  "signal.parsed": {
    label: "signal.parsed",
    className: "bg-green-500/15 text-green-400 border-green-500/30",
    icon: "📈",
  },
  "update.linked": {
    label: "update.linked",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    icon: "🎯",
  },
  "update.unlinked": {
    label: "update.unlinked",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    icon: "⚠️",
  },
  "parse.discarded": {
    label: "parse.discarded",
    className: "bg-muted text-muted-foreground border-border",
    icon: "—",
  },
  "parse.failed": {
    label: "parse.failed",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
    icon: "❌",
  },
};

const TYPE_FILTER_OPTIONS = [
  { value: "", label: "全部" },
  { value: "signal.parsed", label: "信号" },
  { value: "update.linked", label: "关联成功" },
  { value: "update.unlinked", label: "未关联" },
  { value: "parse.discarded", label: "丢弃" },
  { value: "parse.failed", label: "失败" },
];

// ==================== Helpers ====================

function authorColor(id: string): string {
  const colors = ["#5865F2","#57F287","#FEE75C","#EB459E","#ED4245","#3BA55C","#F47B67","#9B59B6"];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[n % colors.length];
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const hms = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hms;
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `昨天 ${hms}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hms}`;
}

function getKolId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const k = (payload as Record<string, unknown>).kolId;
  return typeof k === "string" ? k : undefined;
}

// ==================== Page ====================

export default function EventsPage() {
  const [entries, setEntries] = useState<EventEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [paused, setPaused] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ entries: es, total: t }, ks] = await Promise.all([
        eventApi.list({ limit: 200, type: typeFilter || undefined }),
        kolApi.list(),
      ]);
      setEntries(es);
      setTotal(t);
      setKols(ks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    void refresh();
    if (paused) return;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, paused]);

  const kolMap = useMemo(() => {
    const m = new Map<string, KolConfig>();
    for (const k of kols) m.set(k.id, k);
    return m;
  }, [kols]);

  // Type breakdown for status header (computed over current page only)
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return counts;
  }, [entries]);

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">事件流</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            最近 {entries.length} / {total} 条 · 每 {POLL_MS / 1000} 秒自动刷新
            {paused && <span className="ml-2 text-amber-500">（已暂停）</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              paused
                ? "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {paused ? "▶ 恢复" : "⏸ 暂停"}
          </button>
          <button
            onClick={() => { void refresh(); }}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ↻ 刷新
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {TYPE_FILTER_OPTIONS.map((opt) => {
          const active = typeFilter === opt.value;
          const count = opt.value === "" ? entries.length : typeCounts.get(opt.value) ?? 0;
          return (
            <button
              key={opt.value}
              onClick={() => setTypeFilter(opt.value)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {opt.label}
              {count > 0 && (
                <span className="ml-1.5 font-mono text-[10px] opacity-70">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-8 text-center text-sm text-muted-foreground">加载中…</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card/50 px-8 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {typeFilter ? `没有 ${typeFilter} 类型的事件` : "暂无事件"}
          </p>
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card font-mono text-xs">
          {entries.map((e, idx) => (
            <EventRow
              key={e.seq}
              entry={e}
              kolLabel={getKolId(e.payload) ? kolMap.get(getKolId(e.payload)!)?.label : undefined}
              alt={idx % 2 === 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Row ====================

function EventRow({ entry, kolLabel, alt }: { entry: EventEntry; kolLabel?: string; alt: boolean }) {
  const meta = TYPE_META[entry.type] ?? {
    label: entry.type,
    className: "bg-muted text-muted-foreground border-border",
    icon: "·",
  };
  const summary = renderSummary(entry, kolLabel);
  const kolId = getKolId(entry.payload);

  return (
    <div
      className={`flex items-center gap-3 border-b border-border px-3 py-2 last:border-0 ${
        alt ? "bg-muted/20" : ""
      }`}
    >
      <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground/70">
        #{entry.seq}
      </span>
      <span className="w-20 shrink-0 text-muted-foreground">{formatTime(entry.ts)}</span>
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}
        style={{ minWidth: "9.5rem" }}
      >
        <span>{meta.icon}</span>
        <span>{meta.label}</span>
      </span>
      {kolId && (
        <span
          className="shrink-0 truncate max-w-[6rem] text-foreground/90"
          style={{ color: authorColor(kolId) }}
          title={kolLabel ?? kolId}
        >
          {kolLabel ?? kolId.slice(0, 8)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-foreground/80" title={summary}>
        {summary}
      </span>
    </div>
  );
}

// ==================== Summary renderers ====================

function renderSummary(entry: EventEntry, _kolLabel?: string): string {
  const p = entry.payload as Record<string, unknown>;
  if (!p || typeof p !== "object") return JSON.stringify(entry.payload);

  switch (entry.type) {
    case "signal.parsed": {
      const symbol = p.symbol as string | undefined;
      const conf = p.confidence as number | undefined;
      const parser = p.parserType as string | undefined;
      const id = p.signalId as string | undefined;
      return [
        symbol && `${symbol}`,
        parser && `[${parser}]`,
        conf !== undefined && `conf=${(conf * 100).toFixed(0)}%`,
        id && `id=${id.slice(0, 12)}`,
      ].filter(Boolean).join("  ");
    }
    case "update.linked": {
      const updateType = p.updateType as string | undefined;
      const conf = p.linkConfidence as string | undefined;
      const closed = p.closedSignal as boolean | undefined;
      const sigId = p.signalId as string | undefined;
      return [
        updateType,
        conf && `(${conf})`,
        closed && "🔒 关闭信号",
        sigId && `→ ${sigId.slice(0, 12)}`,
      ].filter(Boolean).join("  ");
    }
    case "update.unlinked": {
      const updateType = p.updateType as string | undefined;
      const reason = p.reason as string | undefined;
      return [updateType, reason && `· ${reason}`].filter(Boolean).join("  ");
    }
    case "parse.discarded": {
      const reason = p.reason as string | undefined;
      const bundleId = p.bundleId as string | undefined;
      return [reason, bundleId && `bundle=${bundleId.slice(0, 12)}`].filter(Boolean).join("  ");
    }
    case "parse.failed": {
      const code = p.errorCode as string | undefined;
      const msg = p.message as string | undefined;
      const retriable = p.retriable as boolean | undefined;
      return [
        code && `[${code}]`,
        retriable !== undefined && (retriable ? "可重试" : "永久失败"),
        msg,
      ].filter(Boolean).join("  ");
    }
    default:
      return JSON.stringify(p);
  }
}
