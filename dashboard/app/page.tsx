"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { KolConfig, ChannelConfig, Operation } from "@shared/types";
import {
  channelApi,
  executionConfigApi,
  kolApi,
  operationApi,
  signalApi,
  tradingApi,
} from "@/lib/api";
import type { ExecutionConfig, EquityResult, SignalListResult } from "@/lib/api";

const POLL_MS = 5_000;

// Today is "since 00:00 local". Used to filter operations / signals into a
// "today" bucket without paging through the entire history.
function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) {
    const minsAgo = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (minsAgo < 1) return "刚刚";
    if (minsAgo < 60) return `${minsAgo} 分钟前`;
    return `今天 ${hhmm}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

export default function Home() {
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [signals, setSignals] = useState<SignalListResult["records"]>([]);
  const [equity, setEquity] = useState<EquityResult | null>(null);
  const [exec, setExec] = useState<ExecutionConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [k, c, ops, sigs, e, x] = await Promise.allSettled([
        kolApi.list(),
        channelApi.list(),
        operationApi.list({ limit: 50 }),
        signalApi.list({ limit: 5 }),
        tradingApi.getEquity(),
        executionConfigApi.get(),
      ]);
      if (k.status === "fulfilled") setKols(k.value);
      if (c.status === "fulfilled") setChannels(c.value);
      if (ops.status === "fulfilled") setOperations(ops.value.operations);
      if (sigs.status === "fulfilled") setSignals(sigs.value.records);
      if (e.status === "fulfilled") setEquity(e.value);
      if (x.status === "fulfilled") setExec(x.value);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const kolMap = useMemo(() => {
    const m = new Map<string, KolConfig>();
    for (const kol of kols) m.set(kol.id, kol);
    return m;
  }, [kols]);

  // Today's bucket — operations.list is newest-first, so just walk the prefix
  // until we cross today's boundary.
  const todayStart = useMemo(() => startOfTodayIso(), []);
  const todayOps = operations.filter((op) => op.createdAt >= todayStart);
  const pending = operations.filter((op) => op.status === "pending");

  const enabledKols = kols.filter((k) => k.enabled).length;
  const enabledChannels = channels.filter((c) => c.enabled).length;

  // Status pill — execution mode is the most operationally critical signal,
  // so we make it big and obvious at the top of the dash.
  const isLive = exec?.mode === "live";
  const modeLabel = exec
    ? isLive ? "🔴 LIVE 真金白银" : "🟡 DRY-RUN 演练"
    : "··· 加载中";

  return (
    <div className="p-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">概览</h1>
        <p className="text-xs text-muted-foreground">每 {POLL_MS / 1000} 秒自动刷新</p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* ── Status hero — execution mode + monitoring + balance ────────── */}
      <div
        className={`mt-6 rounded-xl border p-5 ${
          isLive
            ? "border-red-500/40 bg-red-500/5"
            : "border-amber-500/30 bg-amber-500/5"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              执行模式
            </div>
            <div className="mt-0.5 text-lg font-bold">{modeLabel}</div>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              监听
            </div>
            <div className="mt-0.5 font-mono text-sm">
              {enabledKols}/{kols.length} KOL · {enabledChannels}/{channels.length} 频道
            </div>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              账户权益 (USDT)
            </div>
            <div className="mt-0.5 font-mono text-sm">
              {equity ? equity.totalEquity.toFixed(2) : "—"}
              {equity && equity.totalUnrealizedPnl !== 0 && (
                <span
                  className={`ml-2 text-xs ${
                    equity.totalUnrealizedPnl > 0 ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {equity.totalUnrealizedPnl > 0 ? "+" : ""}
                  {equity.totalUnrealizedPnl.toFixed(2)} 浮动
                </span>
              )}
            </div>
          </div>
          {pending.length > 0 && (
            <Link
              href="/operations?status=pending"
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
            >
              ⏳ {pending.length} 笔待审批
              <span className="opacity-60">→</span>
            </Link>
          )}
        </div>
      </div>

      {/* ── Today's numbers ─────────────────────────────────────────────── */}
      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Stat
          label="今日信号"
          value={signals.filter((r) => r.kind === "signal" && r.record.parsedAt >= todayStart).length}
        />
        <Stat label="今日操作" value={todayOps.length} sub={`${todayOps.filter(o => o.status === "executed").length} 已执行`} />
        <Stat label="待审批" value={pending.length} tone={pending.length > 0 ? "warn" : undefined} />
        <Stat
          label="今日通过率"
          value={
            todayOps.length === 0
              ? "—"
              : `${Math.round(
                  (100 * todayOps.filter(o => o.status === "approved" || o.status === "executed").length) /
                    todayOps.length,
                )}%`
          }
          sub={`${todayOps.length} 操作中`}
        />
      </div>

      {/* ── Two-column: latest signals + pending operations ────────────── */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section title="最近信号" href="/signals" empty={signals.length === 0 && !loading}>
          {signals
            .filter((r): r is Extract<typeof r, { kind: "signal" }> => r.kind === "signal")
            .slice(0, 5)
            .map((rec) => {
              const sig = rec.record;
              const kol = kolMap.get(sig.kolId);
              return (
                <RowLink key={sig.id} href="/signals">
                  <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
                    {formatTime(sig.parsedAt)}
                  </span>
                  <span className="truncate font-medium">{kol?.label ?? sig.kolId.slice(0, 8)}</span>
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-xs">
                    <span className="text-foreground/80">{sig.symbol}</span>
                    {sig.side && (
                      <span className={sig.side === "long" ? "text-green-400" : "text-red-400"}>
                        {sig.side}
                      </span>
                    )}
                  </span>
                </RowLink>
              );
            })}
        </Section>

        <Section title="待审批" href="/operations?status=pending" empty={pending.length === 0 && !loading}>
          {pending.slice(0, 5).map((op) => {
            const kol = kolMap.get(op.kolId);
            const spec = op.spec;
            return (
              <RowLink key={op.id} href={`/operations`}>
                <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
                  {formatTime(op.createdAt)}
                </span>
                <span className="truncate font-medium">{kol?.label ?? op.kolId.slice(0, 8)}</span>
                <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-xs">
                  {spec.action === "placeOrder" ? (
                    <>
                      <span className="text-foreground/80">{spec.symbol}</span>
                      <span className={spec.side === "long" ? "text-green-400" : "text-red-400"}>
                        {spec.side}
                      </span>
                      <span className="text-muted-foreground">
                        {spec.size.value} USDT
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{spec.action}</span>
                  )}
                </span>
              </RowLink>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────

function Stat({
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
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  href,
  empty,
  children,
}: {
  title: string;
  href: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link
          href={href}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          查看全部 →
        </Link>
      </div>
      {empty ? (
        <p className="mt-4 text-xs text-muted-foreground">无数据</p>
      ) : (
        <div className="mt-3 space-y-1">{children}</div>
      )}
    </div>
  );
}

function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
    >
      {children}
    </Link>
  );
}
