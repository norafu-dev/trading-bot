"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KolConfig, Operation } from "@shared/types";
import { kolApi, operationApi } from "@/lib/api";
import { authorColor } from "@/lib/utils";

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

  // We deliberately DON'T pass `status` to the API. If the server-side
  // filter is on, the chip-row counts collapse to the current filter
  // (e.g. picking "已批准" makes 全部 say 1 and 已拒绝 say 0). Status
  // filtering happens in-page; KOL filtering still goes to the server
  // because that affects the meaningful "total in this KOL's history".
  const refresh = useCallback(async () => {
    try {
      const [{ operations: ops, total: t }, ks] = await Promise.all([
        operationApi.list({
          limit: 200,
          ...(filterKolId && { kolId: filterKolId }),
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

  // Visible-list slice: applies status filter on top of the API response.
  // The unfiltered `operations` array stays the source of truth for the
  // chip counts so they don't collapse when a status is selected.
  const visibleOperations = useMemo(
    () => (filterStatus ? operations.filter((op) => op.status === filterStatus) : operations),
    [operations, filterStatus],
  );

  // Status counts always come from the unfiltered (status-wise) array so
  // every chip stays correct as you click through them.
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
            最近 {operations.length} / {total} 条操作
            {filterStatus && ` · 当前筛选「${STATUS_LABEL[filterStatus]}」${visibleOperations.length} 条`}
            {" · 每 "}{POLL_MS / 1000}{" 秒自动刷新"}
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
          全部 <span className="ml-1 font-mono text-muted-foreground">{operations.length}</span>
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
              <span className="ml-1 font-mono opacity-80">{n}</span>
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

      {!loading && operations.length > 0 && visibleOperations.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card/50 px-6 py-8 text-center text-sm text-muted-foreground">
          当前筛选条件下没有操作 — 切换上方标签查看其它状态
        </div>
      )}

      {!loading && visibleOperations.length > 0 && (
        <div className="mt-6 space-y-3">
          {visibleOperations.map((op) => (
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

          {/* Conditional-stop note — KOL's original wording when SL was
              given as a candle-close condition rather than a hard price. */}
          {spec.action === "placeOrder" && spec.stopLoss?.condition && (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">
              原始止损条件: {spec.stopLoss.condition}
            </p>
          )}

          {/* Sizing context */}
          {op.sizingContext && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              基于权益 {op.sizingContext.equity} USDT × 实际 {op.sizingContext.effectiveRiskPercent}%
            </p>
          )}

          {/* Live-price decision aid: distance-to-entry / TP / SL */}
          {spec.action === "placeOrder" && op.priceCheck && (
            <PriceAidLine spec={spec} priceCheck={op.priceCheck} />
          )}

          {/* Decision callout — guard / timeout / human / broker */}
          <DecisionCallout op={op} onChanged={onChanged} />

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
 * Bottom-of-card explainer showing why this op is no longer pending.
 * Replaces the old guardRejection-only callout so an "approval timeout"
 * isn't visually identical to "guard rejected" — the operator deserves
 * to see "you missed the 5-minute window" called out specifically.
 */
function DecisionCallout({ op, onChanged }: { op: Operation; onChanged: () => Promise<void> }) {
  // Still pending → no decision to surface yet
  if (op.status === "pending") return null;

  // Guard rejection — the most diagnostic case, surface guard + reason
  if (op.status === "rejected" && op.guardRejection) {
    return (
      <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
        <span className="font-medium">守卫拒绝 [{op.guardRejection.guardName}]</span>
        <span className="ml-1.5 opacity-80">{op.guardRejection.reason}</span>
      </div>
    );
  }

  if (!op.lastDecision) return null;
  const ts = new Date(op.lastDecision.at).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Timeout — engine self-rejects after 5 min. Surface a "重新提交"
  // button so the operator can spawn a fresh approval card with a
  // refreshed priceCheck (limit-order setups often still actionable
  // hours after the original signal).
  if (
    op.status === "rejected" &&
    op.lastDecision.by === "engine" &&
    op.lastDecision.reason?.startsWith("approval timeout")
  ) {
    return (
      <ResubmittableCallout
        op={op}
        ts={ts}
        onChanged={onChanged}
        icon="⏰"
        title="审批超时自动拒绝"
        tone="amber"
      />
    );
  }

  // Human reject — dashboard or telegram
  if (
    op.status === "rejected" &&
    (op.lastDecision.by === "dashboard" || op.lastDecision.by === "telegram")
  ) {
    const surface = op.lastDecision.by === "dashboard" ? "网页手动拒绝" : "Telegram 手动拒绝";
    return (
      <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
        <span className="font-medium">{surface}</span>
        <span className="ml-1.5 opacity-80">{ts}</span>
        {op.lastDecision.reason && (
          <span className="ml-1.5 opacity-80">· {op.lastDecision.reason}</span>
        )}
      </div>
    );
  }

  // Executed — broker confirmed, surface order id
  if (op.status === "executed" && op.lastDecision.reason) {
    return (
      <div className="mt-2 rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1.5 text-xs text-green-400">
        <span className="font-medium">已执行</span>
        <span className="ml-1.5 opacity-80 font-mono">{op.lastDecision.reason}</span>
      </div>
    );
  }

  // Failed — broker rejected the main order. Resubmit is safe because
  // executor only flags `failed` when the main order didn't fill (TP-only
  // failures stay `executed`), so there's no broker-side state to
  // reconcile. Some error categories (invalid-order, permission) won't
  // get healed by retry — the operator reads the reason and decides;
  // MAX_RESUBMITS_PER_SIGNAL caps the chain.
  if (op.status === "failed") {
    return (
      <ResubmittableCallout
        op={op}
        ts={ts}
        onChanged={onChanged}
        icon="⚠️"
        title="执行失败"
        tone="red"
      />
    );
  }

  return null;
}

/**
 * Resubmittable-decision callout. Used for both approval-timeout and
 * execution-failed terminal states. The "🔄 重新提交" button re-runs
 * the original signal through the engine, producing a fresh pending
 * op with refreshed priceCheck. Guards re-fire so a truly stale signal
 * (or a config-level invalid-order issue) is still blocked. The chain
 * is capped by MAX_RESUBMITS_PER_SIGNAL backend-side; clicking past the
 * cap surfaces the backend error inline.
 */
function ResubmittableCallout({
  op,
  ts,
  onChanged,
  icon,
  title,
  tone,
}: {
  op: Operation;
  ts: string;
  onChanged: () => Promise<void>;
  icon: string;
  title: string;
  tone: "amber" | "red";
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onResubmit = async () => {
    if (!confirm("确认重新提交这条信号？\n会以最新行情产生一条全新的待审批操作。")) return;
    setPending(true);
    setError(null);
    try {
      await operationApi.resubmit(op.id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  // Button uses the same -400 text tier as wrap content so the light-mode
  // override in globals.css (`text-red-400 → #b91c1c`, `text-amber-400 →
  // #b45309`) kicks in and the AA contrast is real. -200 had no override
  // and was unreadable on a white surface. Background steps up from -500/10
  // (wrap) to -500/25 (button) so the button reads as a distinct affordance.
  const palette =
    tone === "red"
      ? {
          wrap: "border-red-500/30 bg-red-500/10 text-red-400",
          btn: "border-red-500/60 bg-red-500/25 text-red-400 hover:bg-red-500/35",
        }
      : {
          wrap: "border-amber-500/30 bg-amber-500/10 text-amber-400",
          btn: "border-amber-500/60 bg-amber-500/25 text-amber-400 hover:bg-amber-500/35",
        };

  return (
    <div className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${palette.wrap}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{icon} {title}</span>
        <span className="opacity-80">{ts}{op.lastDecision?.reason && ` · ${op.lastDecision.reason}`}</span>
        <button
          disabled={pending}
          onClick={() => void onResubmit()}
          className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${palette.btn}`}
          title="以最新行情重新生成一条待审批操作；守卫会再次评估"
        >
          {pending ? "提交中…" : "🔄 重新提交"}
        </button>
      </div>
      {error && <div className="mt-1 text-red-400">{error}</div>}
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

/**
 * Live-price decision aid. Shows current market and signed distances
 * to entry / TP / SL — the operator's first question before approving
 * a market order is "is the R/R still attractive at NOW's price?".
 *
 * Sign convention: distances are framed in the trade's favourable
 * direction (positive % = price needs to move that way to hit the
 * level), except for SL which always shows the raw signed distance so
 * a deep-red "-13%" jumps out as "you're 13% from getting stopped".
 */
function PriceAidLine({
  spec,
  priceCheck,
}: {
  spec: Extract<Operation["spec"], { action: "placeOrder" }>;
  priceCheck: NonNullable<Operation["priceCheck"]>;
}) {
  const live = Number(priceCheck.currentPrice);
  if (!Number.isFinite(live) || live <= 0) return null;
  const dirSign = spec.side === "long" ? 1 : -1;

  // SL/TP distance basis: entry price for unfilled limit orders, live
  // otherwise. For a limit order waiting on a pullback, the operator
  // wants to know "if this fills, how much do I gain/lose to each
  // level" — not "how far from current price". The latter gave
  // confusing negatives like "TP1 -2.4%" for a short that hadn't even
  // reached its entry yet.
  let slTpBasis: number | null = null;
  if (spec.orderType === "limit" && spec.price) {
    const e = Number(spec.price);
    if (Number.isFinite(e) && e > 0) slTpBasis = e;
  }
  if (slTpBasis === null) slTpBasis = live;

  const distances: Array<{ label: string; pct: number; tone?: "good" | "bad" }> = [];
  // Entry — always vs live (showing "how far before this fills")
  if (spec.orderType === "limit" && spec.price) {
    const e = Number(spec.price);
    if (Number.isFinite(e) && e > 0) {
      distances.push({
        label: "距入场",
        pct: ((e - live) / live) * 100 * -dirSign,
      });
    }
  }
  for (const tp of spec.takeProfits ?? []) {
    const v = Number(tp.price);
    if (!Number.isFinite(v) || v <= 0) continue;
    distances.push({
      label: `TP${tp.level}`,
      pct: ((v - slTpBasis) / slTpBasis) * 100 * dirSign,
      tone: "good",
    });
  }
  if (spec.stopLoss?.price) {
    const v = Number(spec.stopLoss.price);
    if (Number.isFinite(v) && v > 0) {
      distances.push({
        label: "SL",
        pct: ((v - slTpBasis) / slTpBasis) * 100 * dirSign,
        tone: "bad",
      });
    }
  }

  const usingEntryBasis = spec.orderType === "limit" && spec.price !== undefined;

  return (
    <div className="mt-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium text-blue-400">📊 实时 {priceCheck.currentPrice}</span>
        <span className="text-[10px] text-muted-foreground">{priceCheck.source}</span>
      </div>
      {distances.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
          {distances.map((d, i) => (
            <span key={i} className={
              d.tone === "good" ? "text-green-400"
              : d.tone === "bad" ? "text-red-400"
              : "text-foreground"
            }>
              {d.label}{" "}
              {d.pct >= 0 ? "+" : ""}
              {d.pct.toFixed(1)}%
            </span>
          ))}
        </div>
      )}
      {usingEntryBasis && (
        <div className="mt-0.5 text-[10px] text-muted-foreground italic">
          ↑ SL/TP 距离基于挂单价 {spec.price}（成交后变动）
        </div>
      )}
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
