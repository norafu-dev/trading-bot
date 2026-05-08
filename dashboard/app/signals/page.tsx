"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KolConfig, Operation, ParserType, PositionUpdate, Signal } from "@shared/types";
import { kolApi, operationApi, signalApi } from "@/lib/api";
import type { SignalRecord } from "@/lib/api";
import { authorColor } from "@/lib/utils";

// ==================== Constants ====================

const POLL_MS = 5_000;

const PARSER_BADGE: Record<ParserType, { label: string; className: string }> = {
  regex_structured: { label: "Regex", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  llm_text: { label: "LLM 文本", className: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
  llm_vision: { label: "LLM 视觉", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  hybrid: { label: "混合", className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30" },
};

const UPDATE_TYPE_LABEL: Record<PositionUpdate["updateType"], { text: string; tone: "good" | "bad" | "neutral" }> = {
  limit_filled: { text: "限价单成交", tone: "neutral" },
  tp_hit: { text: "TP 命中", tone: "good" },
  sl_hit: { text: "止损触发", tone: "bad" },
  breakeven_move: { text: "移至保本", tone: "neutral" },
  breakeven_hit: { text: "保本止损", tone: "neutral" },
  manual_close: { text: "手动平仓", tone: "neutral" },
  full_close: { text: "全部平仓", tone: "neutral" },
  runner_close: { text: "尾仓平仓", tone: "neutral" },
  stop_modified: { text: "止损调整", tone: "neutral" },
};

// ==================== Helpers ====================

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function KolAvatar({ kol, kolId, size = 36 }: { kol?: KolConfig; kolId: string; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const hasAvatar = kol?.avatarPath && !imgError;
  const initial = (kol?.label ?? kolId).charAt(0).toUpperCase();
  return (
    <div
      className="shrink-0 rounded-full overflow-hidden flex items-center justify-center font-bold text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: hasAvatar ? "transparent" : authorColor(kolId),
        fontSize: size * 0.42,
      }}
      title={kol?.label ?? kolId}
    >
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={kolApi.avatarUrl(kolId)}
          alt={kol?.label ?? kolId}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initial
      )}
    </div>
  );
}

// ==================== Page ====================

export default function SignalsPage() {
  const [records, setRecords] = useState<SignalRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKolId, setFilterKolId] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const [{ records: rs, total: t }, ks, { operations: ops }] = await Promise.all([
        signalApi.list({ limit: 200, kolId: filterKolId || undefined }),
        kolApi.list(),
        operationApi.list({ limit: 500, ...(filterKolId && { kolId: filterKolId }) }),
      ]);
      setRecords(rs);
      setTotal(t);
      setKols(ks);
      setOperations(ops);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterKolId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const kolMap = useMemo(() => {
    const m = new Map<string, KolConfig>();
    for (const k of kols) m.set(k.id, k);
    return m;
  }, [kols]);

  // signalId → Operation it produced. A signal may produce 0 ops (filtered
  // out before the engine reached it) or 1 op (the normal path); we don't
  // currently fan-out to multiple ops per signal.
  const opBySignalId = useMemo(() => {
    const m = new Map<string, Operation>();
    for (const op of operations) m.set(op.signalId, op);
    return m;
  }, [operations]);

  // Stats by kind
  const stats = useMemo(() => {
    let signals = 0;
    let updates = 0;
    let unlinked = 0;
    for (const r of records) {
      if (r.kind === "signal") signals++;
      else {
        updates++;
        if (!r.record.linkedSignalId) unlinked++;
      }
    }
    return { signals, updates, unlinked };
  }, [records]);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">信号流</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            最近 {records.length} / {total} 条 ·{" "}
            <span className="text-foreground">{stats.signals}</span> 信号 ·{" "}
            <span className="text-foreground">{stats.updates}</span> 更新
            {stats.unlinked > 0 && (
              <>
                {" · "}
                <span className="text-amber-500">{stats.unlinked}</span> 未关联
              </>
            )}
            {" · 每 5 秒自动刷新"}
          </p>
        </div>
        <select
          value={filterKolId}
          onChange={(e) => setFilterKolId(e.target.value)}
          className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">全部 KOL</option>
          {kols.map((k) => (
            <option key={k.id} value={k.id}>{k.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-8 text-center text-sm text-muted-foreground">加载中…</div>
      )}

      {!loading && records.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card/50 px-8 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            暂无信号 — Discord 监听器接通 + 解析流水线启动后会显示在这里
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            （开发模式可运行 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">pnpm tsx scripts/seed-signals.ts</code> 生成示例数据）
          </p>
        </div>
      )}

      {!loading && records.length > 0 && (
        <div className="mt-6 space-y-3">
          {records.map((r) =>
            r.kind === "signal" ? (
              <SignalCard
                key={r.record.id}
                signal={r.record}
                kol={kolMap.get(r.record.kolId)}
                op={opBySignalId.get(r.record.id)}
              />
            ) : (
              <UpdateCard key={r.record.id} update={r.record} kol={kolMap.get(r.record.kolId)} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ==================== Cards ====================

function SignalCard({ signal, kol, op }: { signal: Signal; kol?: KolConfig; op?: Operation }) {
  const [showRaw, setShowRaw] = useState(false);
  const sideTone =
    signal.side === "long" ? "text-green-400" :
    signal.side === "short" ? "text-red-400" :
    "text-muted-foreground";
  const parser = PARSER_BADGE[signal.parserType];

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
      <div className="flex items-start gap-3">
        <KolAvatar kol={kol} kolId={signal.kolId} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold text-foreground">{kol?.label ?? signal.kolId}</span>
            <span className="text-xs text-muted-foreground">{formatTime(signal.parsedAt)}</span>
            <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${parser.className}`}>
              {parser.label}
            </span>
            <DownstreamBadge op={op} />
            <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
              📈 信号
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span className="font-mono text-base font-semibold text-foreground">{signal.symbol}</span>
            {signal.side && (
              <span className={`font-mono text-sm font-bold uppercase ${sideTone}`}>
                {signal.side}
              </span>
            )}
            {signal.contractType && (
              <span className="text-xs text-muted-foreground">{signal.contractType}</span>
            )}
            {signal.leverage !== undefined && (
              <span className="text-xs font-mono text-muted-foreground">{signal.leverage}×</span>
            )}
            {signal.action !== "open" && (
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {signal.action}
              </span>
            )}
          </div>

          {/* Trade params grid */}
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
            {signal.entry && (
              <Field
                label="入场"
                value={
                  signal.entry.price ??
                  (signal.entry.priceRangeLow && signal.entry.priceRangeHigh
                    ? `${signal.entry.priceRangeLow}–${signal.entry.priceRangeHigh}`
                    : "—")
                }
                hint={signal.entry.type}
              />
            )}
            {signal.stopLoss?.price && (
              <Field label="止损" value={signal.stopLoss.price} tone="bad" />
            )}
            {signal.takeProfits?.map((tp) => (
              <Field key={tp.level} label={`TP${tp.level}`} value={tp.price} tone="good" />
            ))}
            {signal.size && (
              <Field
                label="仓位"
                value={`${signal.size.value}${signal.size.type === "percent" ? "%" : ""}`}
              />
            )}
          </div>

          {/* Confidence bar */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">置信度</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${(signal.confidence * 100).toFixed(0)}%` }}
              />
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">
              {(signal.confidence * 100).toFixed(0)}%
            </span>
          </div>

          {signal.unitAnomaly?.detected && (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-400">
              ⚠️ 单位异常：{signal.unitAnomaly.description}
            </div>
          )}

          {signal.priceCheck && <PriceCheckBar check={signal.priceCheck} />}

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="hover:text-foreground transition-colors"
            >
              {showRaw ? "收起" : "查看原文"} {signal.reasoning ? "/ 解析理由" : ""}
            </button>
            <span className="font-mono text-[10px]">{signal.id.slice(0, 12)}</span>
          </div>

          {showRaw && (
            <div className="mt-2 space-y-2">
              {signal.rawText && (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 text-[11px] text-foreground">
                  {signal.rawText}
                </pre>
              )}
              {signal.reasoning && (
                <p className="rounded-md border border-border bg-muted/30 p-2 text-[11px] italic text-muted-foreground">
                  💭 {signal.reasoning}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UpdateCard({ update, kol }: { update: PositionUpdate; kol?: KolConfig }) {
  const meta = UPDATE_TYPE_LABEL[update.updateType];
  const isUnlinked = !update.linkedSignalId;
  const toneClass =
    meta.tone === "good"
      ? "border-green-500/30 bg-green-500/5"
      : meta.tone === "bad"
      ? "border-red-500/30 bg-red-500/5"
      : "border-border bg-card";

  return (
    <div className={`ml-12 rounded-xl border p-3 shadow-sm transition-colors ${toneClass}`}>
      <div className="flex items-center gap-3">
        <KolAvatar kol={kol} kolId={update.kolId} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold text-foreground">{kol?.label ?? update.kolId}</span>
            <span className="text-xs text-muted-foreground">{formatTime(update.receivedAt)}</span>
            {update.symbol && (
              <span className="font-mono text-sm font-semibold text-foreground">{update.symbol}</span>
            )}
            <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
              {meta.text}
            </span>
            {update.level !== undefined && (
              <span className="text-xs font-mono text-muted-foreground">TP{update.level}</span>
            )}
            <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
              🎯 更新
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {update.closedPercent !== undefined && (
              <span>
                平仓 <span className="font-mono text-foreground">{update.closedPercent}%</span>
              </span>
            )}
            {update.realizedPriceRef !== undefined && (
              <span>
                成交价 <span className="font-mono text-foreground">{update.realizedPriceRef}</span>
              </span>
            )}
            {update.realizedRR !== undefined && (
              <span>
                R/R{" "}
                <span
                  className={`font-mono ${
                    Number(update.realizedRR) >= 0 ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {update.realizedRR}
                </span>
              </span>
            )}
            {update.newStopLoss !== undefined && (
              <span>
                新止损 <span className="font-mono text-foreground">{update.newStopLoss}</span>
              </span>
            )}
            {update.linkedSignalId ? (
              <span className="ml-auto font-mono text-[10px]">
                ↳ {update.linkedSignalId.slice(0, 12)}
              </span>
            ) : (
              <span className="ml-auto rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                未关联到任何信号
              </span>
            )}
          </div>

          {isUnlinked && update.reasoning && (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">
              {update.reasoning}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact bar showing the live-market price-check attached to a Signal.
 * Three states: unitMismatch (red, very loud), stale (amber), fresh (subtle blue).
 */
function PriceCheckBar({ check }: { check: NonNullable<Signal["priceCheck"]> }) {
  const tone = check.unitMismatch
    ? "border-red-500/40 bg-red-500/10 text-red-400"
    : check.stale
    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
    : "border-blue-500/20 bg-blue-500/5 text-blue-400";

  const icon = check.unitMismatch ? "🚫" : check.stale ? "⚠️" : "📊";
  const headline = check.unitMismatch
    ? "单位疑似错位"
    : check.stale
    ? "价格已偏离入场点"
    : "对照实时价";

  const distRaw = check.entryDistancePercent;
  const dist = distRaw !== undefined ? Number(distRaw) : undefined;
  const distLabel =
    dist === undefined
      ? null
      : `入场${dist >= 0 ? "高于" : "低于"}现价 ${Math.abs(dist).toFixed(2)}%`;

  return (
    <div className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${tone}`}>
      <div className="flex items-center gap-2">
        <span className="shrink-0">{icon}</span>
        <span className="font-medium">{headline}</span>
        <span className="ml-auto font-mono text-[10px] opacity-90">
          live {check.currentPrice} ({check.source})
        </span>
      </div>
      {distLabel && (
        <div className="mt-1 text-[11px] font-medium">{distLabel}</div>
      )}
      {check.note && check.note !== distLabel && (
        <div className="mt-0.5 truncate text-[10px] opacity-80" title={check.note}>
          {check.note}
        </div>
      )}
    </div>
  );
}

/**
 * Compact tag showing whether a signal made it through to a downstream
 * Operation. For rejections we surface the SOURCE (guard / timeout /
 * human) in the badge — without this, an "approval timeout" looked
 * identical to "guard rejected" and the operator couldn't tell that
 * they were the bottleneck.
 */
function DownstreamBadge({ op }: { op?: Operation }) {
  if (!op) {
    return (
      <span
        className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
        title="此信号未产生 Operation（可能被丢弃或解析前已被过滤）"
      >
        → 未跟单
      </span>
    );
  }
  // Status-driven color and label.
  const statusMap: Record<Operation["status"], { label: string; cls: string }> = {
    pending: { label: "待审批", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
    approved: { label: "已批准", cls: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
    rejected: { label: "已拒绝", cls: "border-red-500/40 bg-red-500/10 text-red-400" },
    executed: { label: "已执行", cls: "border-green-500/40 bg-green-500/10 text-green-400" },
    failed: { label: "执行失败", cls: "border-red-500/40 bg-red-500/10 text-red-400" },
  };
  const s = statusMap[op.status];
  const decoration = decorateRejection(op);
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`}
      title={decoration?.fullText ?? `Operation ${op.id.slice(-8)}`}
    >
      → {s.label}
      {decoration && (
        <span className="ml-1 opacity-70">[{decoration.short}]</span>
      )}
    </span>
  );
}

/**
 * For a rejected/failed op, derive a short tag + tooltip text that
 * tells the operator WHY. Order of precedence:
 *   1. Guard rejection — most specific, names the rule that fired
 *   2. Engine timeout — the operator missed the 5-min window
 *   3. Human reject — surfaces the actor and (if given) the reason
 *   4. Broker failure — execution category from error-classifier
 */
function decorateRejection(op: Operation): { short: string; fullText: string } | null {
  if (op.status === "rejected") {
    if (op.guardRejection) {
      return { short: op.guardRejection.guardName, fullText: op.guardRejection.reason };
    }
    if (op.lastDecision?.by === "engine" && op.lastDecision.reason?.startsWith("approval timeout")) {
      return { short: "审批超时", fullText: op.lastDecision.reason };
    }
    if (op.lastDecision?.by === "dashboard" || op.lastDecision?.by === "telegram") {
      const actor = op.lastDecision.by === "dashboard" ? "网页拒绝" : "Telegram 拒绝";
      return { short: actor, fullText: op.lastDecision.reason ?? actor };
    }
  }
  if (op.status === "failed" && op.lastDecision?.by === "broker" && op.lastDecision.reason) {
    return { short: "下单失败", fullText: op.lastDecision.reason };
  }
  return null;
}

function Field({ label, value, hint, tone }: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  const valueClass =
    tone === "good" ? "text-green-400" :
    tone === "bad" ? "text-red-400" :
    "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-medium ${valueClass}`}>
        {value}
        {hint && <span className="ml-1 text-[10px] uppercase text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
