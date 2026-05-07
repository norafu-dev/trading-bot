"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KolConfig, Operation } from "@shared/types";
import { kolApi, operationApi } from "@/lib/api";

const POLL_MS = 5_000;

const STATUS_TONE: Record<Operation["status"], string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  approved: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  rejected: "bg-red-500/15 text-red-400 border-red-500/30",
  executed: "bg-green-500/15 text-green-400 border-green-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
};

const STATUS_LABEL: Record<Operation["status"], string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  executed: "已执行",
  failed: "执行失败",
};

function authorColor(id: string): string {
  const colors = ["#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245", "#3BA55C", "#F47B67", "#9B59B6"];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[n % colors.length];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function KolBadge({ kolId, kol }: { kolId: string; kol?: KolConfig }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs"
      style={{ color: authorColor(kolId) }}
      title={kol?.label ?? kolId}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: authorColor(kolId) }} />
      {kol?.label ?? kolId.slice(0, 8)}
    </span>
  );
}

// ==================== Page ====================

export default function OperationsPage() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [total, setTotal] = useState(0);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKolId, setFilterKolId] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<Operation["status"] | "">("");

  const refresh = useCallback(async () => {
    try {
      const [{ operations: ops, total: t }, ks] = await Promise.all([
        operationApi.list({
          limit: 200,
          ...(filterKolId && { kolId: filterKolId }),
          ...(filterStatus && { status: filterStatus }),
        }),
        kolApi.list(),
      ]);
      setOperations(ops);
      setTotal(t);
      setKols(ks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterKolId, filterStatus]);

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

  // Counts per status (current page only)
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const op of operations) c[op.status] = (c[op.status] ?? 0) + 1;
    return c;
  }, [operations]);

  // "Today" snapshot — newest-first list lets us short-circuit the prefix.
  // Approval rate = (approved + executed) / total decided today, ignoring
  // still-pending ops since they haven't been decided yet.
  const todayStats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const startIso = todayStart.toISOString();
    const today = operations.filter((op) => op.createdAt >= startIso);
    const decided = today.filter((op) => op.status !== "pending").length;
    const approved = today.filter((op) => op.status === "approved" || op.status === "executed").length;
    return {
      total: today.length,
      decided,
      approveRate: decided > 0 ? Math.round((100 * approved) / decided) : null,
    };
  }, [operations]);

  // Oldest still-pending op — surfaces "you have a 4-minute-old approval
  // sitting unattended" risk before it auto-rejects.
  const oldestPending = useMemo(() => {
    const pending = operations.filter((op) => op.status === "pending");
    if (pending.length === 0) return null;
    // newest-first list → walk to the end of the pending block to get oldest
    return pending[pending.length - 1];
  }, [operations]);

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">运营操作流</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            最近 {operations.length} / {total} 条操作 · 由 PositionSizer + GuardPipeline 产生 · 每 {POLL_MS / 1000} 秒自动刷新
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as Operation["status"] | "")}
            className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="">全部状态</option>
            <option value="pending">待审批</option>
            <option value="approved">已批准</option>
            <option value="rejected">已拒绝</option>
            <option value="executed">已执行</option>
            <option value="failed">执行失败</option>
          </select>
        </div>
      </div>

      {/* ── Today's overview ───────────────────────────────────────── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <DashStat label="今日操作" value={todayStats.total} />
        <DashStat
          label="今日通过率"
          value={todayStats.approveRate === null ? "—" : `${todayStats.approveRate}%`}
          sub={`${todayStats.decided}/${todayStats.total} 已决策`}
        />
        <DashStat
          label="待审批"
          value={statusCounts.pending ?? 0}
          tone={(statusCounts.pending ?? 0) > 0 ? "warn" : undefined}
          sub={oldestPending ? `最早 ${formatTime(oldestPending.createdAt)}` : undefined}
        />
        <DashStat label="已执行" value={statusCounts.executed ?? 0} tone="good" />
      </div>

      {/* ── Status filter chips (clickable to filter the list) ─────── */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        <button
          onClick={() => setFilterStatus("")}
          className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            filterStatus === ""
              ? "border-primary bg-primary/15 text-primary"
              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          全部 <span className="ml-1 font-mono opacity-70">{operations.length}</span>
        </button>
        {(["pending", "approved", "rejected", "executed", "failed"] as Operation["status"][]).map((s) => {
          const n = statusCounts[s] ?? 0;
          const active = filterStatus === s;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(active ? "" : s)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                active ? STATUS_TONE[s] : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {STATUS_LABEL[s]}
              <span className="ml-1 font-mono opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <div className="mt-8 text-center text-sm text-muted-foreground">加载中…</div>}

      {!loading && operations.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card/50 px-8 py-12 text-center">
          <p className="text-sm text-muted-foreground">还没有操作记录</p>
          <p className="mt-2 text-xs text-muted-foreground">
            等待真信号到达，或在 [/messages](/messages) 上重放历史消息触发流水线
          </p>
        </div>
      )}

      {!loading && operations.length > 0 && (
        <div className="mt-6 space-y-3">
          {operations.map((op) => (
            <OperationCard key={op.id} op={op} kol={kolMap.get(op.kolId)} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Card ====================

function OperationCard({ op, kol, onChanged }: { op: Operation; kol?: KolConfig; onChanged: () => Promise<void> }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const spec = op.spec;
  const sideTone = spec.action === "placeOrder"
    ? spec.side === "long" ? "text-green-400" : "text-red-400"
    : "text-muted-foreground";

  const submit = async (status: "approved" | "rejected", reason?: string) => {
    setPending(true);
    setActionError(null);
    try {
      await operationApi.setStatus(op.id, status, reason);
      await onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const onApprove = () => {
    if (!confirm(`确认批准这单操作吗？\n${spec.action === "placeOrder" ? `${spec.symbol} ${spec.side} ${spec.size.value}` : spec.action}`)) return;
    void submit("approved");
  };

  const onRejectConfirm = () => {
    void submit("rejected", rejectReason.trim() || undefined);
    setShowRejectInput(false);
    setRejectReason("");
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Header: kol + time + status + symbol */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <KolBadge kolId={op.kolId} kol={kol} />
            <span className="text-xs text-muted-foreground">{formatTime(op.createdAt)}</span>
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[op.status]}`}>
              {STATUS_LABEL[op.status]}
            </span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{op.id.slice(0, 12)}</span>
          </div>

          {/* Trade summary */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            {spec.action === "placeOrder" ? (
              <>
                <span className="font-mono text-base font-semibold text-foreground">{spec.symbol}</span>
                <span className={`font-mono text-sm font-bold uppercase ${sideTone}`}>{spec.side}</span>
                <span className="text-xs text-muted-foreground">{spec.contractType}</span>
                {spec.leverage !== undefined && (
                  <span className="text-xs font-mono text-muted-foreground">{spec.leverage}×</span>
                )}
                <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                  {spec.orderType}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">{spec.action}</span>
            )}
          </div>

          {/* Numbers grid */}
          {spec.action === "placeOrder" && (
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
              <Field label="规模" value={`${spec.size.value} ${spec.size.unit === "absolute" ? "USDT" : spec.size.unit}`} />
              {spec.price && <Field label="入场" value={spec.price} />}
              {spec.stopLoss?.price && <Field label="止损" value={spec.stopLoss.price} tone="bad" />}
              {spec.takeProfits?.map((tp) => (
                <Field key={tp.level} label={`TP${tp.level}`} value={tp.price} tone="good" />
              ))}
            </div>
          )}

          {/* Sizing context */}
          {op.sizingContext && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              基于权益 {op.sizingContext.equity} USDT × 实际 {op.sizingContext.effectiveRiskPercent}%
            </p>
          )}

          {/* Guard rejection callout */}
          {op.guardRejection && (
            <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
              <span className="font-medium">[{op.guardRejection.guardName}]</span> {op.guardRejection.reason}
            </div>
          )}

          {/* Approve / reject controls (pending only) */}
          {op.status === "pending" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                disabled={pending}
                onClick={onApprove}
                className="inline-flex items-center gap-1 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-400 transition hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✓ 批准并下单
              </button>
              <button
                disabled={pending}
                onClick={() => setShowRejectInput((s) => !s)}
                className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✗ 拒绝
              </button>
              {actionError && <span className="text-xs text-red-400">{actionError}</span>}
            </div>
          )}
          {showRejectInput && op.status === "pending" && (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="拒绝理由（可选）"
                className="flex-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                autoFocus
              />
              <button
                disabled={pending}
                onClick={onRejectConfirm}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
              >
                确认拒绝
              </button>
              <button
                onClick={() => { setShowRejectInput(false); setRejectReason(""); }}
                className="rounded-md border border-border bg-muted px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {showDetails ? "收起" : "查看 Guard 详情"} ({op.guardResults.length})
            </button>
            <span className="font-mono text-[10px] text-muted-foreground">
              ↳ {op.signalId.slice(0, 12)}
            </span>
          </div>

          {showDetails && (
            <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 p-2">
              {op.guardResults.length === 0 ? (
                <p className="text-[11px] italic text-muted-foreground">没运行 Guard（操作可能在创建前就被拒绝）</p>
              ) : (
                op.guardResults.map((g, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className={`shrink-0 ${g.passed ? "text-green-400" : "text-red-400"}`}>
                      {g.passed ? "✓" : "✗"}
                    </span>
                    <span className="font-medium text-foreground/80">{g.name}</span>
                    {g.reason && <span className="text-muted-foreground">— {g.reason}</span>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Big-number metric tile shown in the top-of-page overview row.
 * `tone` flags the visual urgency: warn = "the operator should pay
 * attention" (typically pending > 0 with no auto-progress); good =
 * "execution is happening as expected".
 */
function DashStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "warn" | "good";
}) {
  const toneClass =
    tone === "warn"
      ? "border-amber-500/40 bg-amber-500/5"
      : tone === "good"
      ? "border-green-500/40 bg-green-500/5"
      : "border-border bg-card";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const valueClass =
    tone === "good" ? "text-green-400" :
    tone === "bad" ? "text-red-400" :
    "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-medium ${valueClass}`}>{value}</div>
    </div>
  );
}
