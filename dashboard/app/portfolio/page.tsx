"use client";

import { useCallback, useEffect, useState } from "react";
import type { TradePosition } from "@shared/types";
import { tradingApi, type AccountEquitySummary, type EquityResult } from "@/lib/api";

// ==================== Types ====================

interface PositionWithAccount extends TradePosition {
  accountLabel: string;
  accountExchange: string;
}

interface PortfolioData {
  equity: EquityResult | null;
  positions: PositionWithAccount[];
}

const EMPTY: PortfolioData = { equity: null, positions: [] };

// ==================== Helpers ====================

function fmtUsd(n: number, decimals = 2): string {
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtNum(n: number, decimals = 4): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function pnlColor(n: number): string {
  if (n > 0) return "text-success";
  if (n < 0) return "text-danger";
  return "text-muted-foreground";
}

function fmtPnl(n: number): string {
  const s = fmtUsd(Math.abs(n));
  return n >= 0 ? `+${s}` : `-${s}`;
}

// ==================== Page ====================

export default function PortfolioPage() {
  const [data, setData] = useState<PortfolioData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const equity = await tradingApi.getEquity().catch(() => null);
      const accounts = equity?.accounts ?? [];

      const posResults = await Promise.all(
        accounts
          .filter((a) => !a.error)
          .map(async (acct): Promise<PositionWithAccount[]> => {
            try {
              const { positions } = await tradingApi.getPositions(acct.id);
              return positions.map((p) => ({
                ...p,
                accountLabel: acct.label,
                accountExchange: acct.exchange,
              }));
            } catch {
              return [];
            }
          }),
      );

      setData({ equity, positions: posResults.flat() });
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">持仓总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {lastRefresh
              ? `所有交易账户实时快照 · 更新于 ${lastRefresh.toLocaleTimeString()}`
              : "加载中..."}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "刷新中..." : "刷新"}
        </button>
      </div>

      {/* Hero metrics */}
      <HeroMetrics equity={data.equity} loading={loading} />

      {/* Account strip */}
      {(data.equity?.accounts.length ?? 0) > 0 && (
        <AccountStrip accounts={data.equity!.accounts} />
      )}

      {/* Positions table */}
      {data.positions.length > 0 ? (
        <PositionsTable positions={data.positions} />
      ) : !loading && (data.equity?.accounts.length ?? 0) > 0 ? (
        <EmptyPositions />
      ) : null}

      {/* No accounts */}
      {!loading && (data.equity?.accounts.length ?? 0) === 0 && (
        <div className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          暂无已启用的交易账户。请先在「交易配置」页面添加账户。
        </div>
      )}
    </div>
  );
}

// ==================== Hero Metrics ====================

function HeroMetrics({
  equity,
  loading,
}: {
  equity: EquityResult | null;
  loading: boolean;
}) {
  const metrics = [
    {
      label: "总权益",
      value: equity ? fmtUsd(equity.totalEquity) : "—",
      sub: null,
    },
    {
      label: "可用余额",
      value: equity ? fmtUsd(equity.totalCash) : "—",
      sub: null,
    },
    {
      label: "未实现盈亏",
      value: equity ? fmtPnl(equity.totalUnrealizedPnl) : "—",
      pnl: equity?.totalUnrealizedPnl,
    },
    {
      label: "账户数量",
      value: equity ? String(equity.accounts.filter((a) => !a.error).length) : "—",
      sub: equity
        ? `${equity.accounts.length} 个已启用`
        : null,
    },
  ];

  return (
    <div
      className={`grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-6 md:grid-cols-4 transition-opacity ${loading ? "opacity-60" : ""}`}
    >
      {metrics.map(({ label, value, sub, pnl }) => (
        <div key={label}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums md:text-3xl ${pnl != null ? pnlColor(pnl) : "text-foreground"}`}
          >
            {value}
          </p>
          {sub && (
            <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ==================== Account Strip ====================

function AccountStrip({ accounts }: { accounts: AccountEquitySummary[] }) {
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        账户明细
      </h2>
      <div className="flex flex-wrap gap-2">
        {accounts.map((a) => (
          <div
            key={a.id}
            className={`flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-sm ${a.error ? "opacity-60" : ""}`}
          >
            <span
              className={`h-2 w-2 rounded-full flex-shrink-0 ${a.error ? "bg-danger" : "bg-success"}`}
            />
            <span className="font-medium text-foreground">{a.label}</span>
            <span className="text-xs text-muted-foreground">{a.exchange}</span>
            {a.error ? (
              <span className="text-xs text-danger" title={a.error}>
                连接失败
              </span>
            ) : (
              <span className="font-mono text-sm text-foreground">
                {fmtUsd(a.equity)}
              </span>
            )}
            {!a.error && a.unrealizedPnl !== 0 && (
              <span className={`text-xs font-mono ${pnlColor(a.unrealizedPnl)}`}>
                {fmtPnl(a.unrealizedPnl)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== Positions Table ====================

function PositionsTable({ positions }: { positions: PositionWithAccount[] }) {
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        持仓明细 ({positions.length})
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium text-center">方向</th>
                <th className="px-4 py-3 font-medium text-right">数量</th>
                <th className="px-4 py-3 font-medium text-right">开仓价</th>
                <th className="px-4 py-3 font-medium text-right">标记价</th>
                <th className="px-4 py-3 font-medium text-right">市值</th>
                <th className="px-4 py-3 font-medium text-right">未实现盈亏</th>
                <th className="px-4 py-3 font-medium text-right">盈亏%</th>
                <th className="px-4 py-3 font-medium">账户</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const qty = parseFloat(p.quantity);
                const entry = parseFloat(p.entryPrice);
                const mark = parseFloat(p.markPrice);
                const mktVal = parseFloat(p.marketValue);
                const upnl = parseFloat(p.unrealizedPnl);
                const cost = entry * qty;
                const pct = cost > 0 ? (upnl / cost) * 100 : 0;

                return (
                  <tr
                    key={i}
                    className="border-b border-border last:border-0 transition-colors hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-foreground">
                          {p.symbol}
                        </span>
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {p.accountExchange}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                          p.side === "long"
                            ? "bg-success/15 text-success"
                            : "bg-danger/15 text-danger"
                        }`}
                      >
                        {p.side === "long" ? "多" : "空"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-foreground">
                      {fmtNum(qty)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {fmtUsd(entry, 4)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-foreground">
                      {fmtUsd(mark, 4)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-foreground">
                      {fmtUsd(mktVal)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-medium ${pnlColor(upnl)}`}>
                      {fmtPnl(upnl)}
                    </td>
                    <td className={`px-4 py-3 text-right text-xs ${pnlColor(pct)}`}>
                      {pct >= 0 ? "+" : ""}
                      {pct.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {p.accountLabel}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==================== Empty States ====================

function EmptyPositions() {
  return (
    <div className="rounded-xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">
      当前无持仓
    </div>
  );
}
