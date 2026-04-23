"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  TradingAccountConfig,
  BrokerConfigField,
  BrokerTypeInfo,
  AccountBalance,
  TradePosition,
} from "@shared/types";
import { Modal } from "../components/modal";
import { tradingConfigApi, tradingApi } from "@/lib/api";

const inputClass =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50";
const labelClass =
  "mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground";

type EditState =
  | { kind: "create" }
  | { kind: "edit"; account: TradingAccountConfig }
  | null;

export default function TradingPage() {
  const [accounts, setAccounts] = useState<TradingAccountConfig[]>([]);
  const [brokerTypes, setBrokerTypes] = useState<BrokerTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>(null);

  // View balance/positions state
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewBalance, setViewBalance] = useState<AccountBalance | null>(null);
  const [viewPositions, setViewPositions] = useState<TradePosition[]>([]);
  const [viewError, setViewError] = useState<string | null>(null);

  async function refresh() {
    try {
      setLoading(true);
      const [accountsRes, typesRes] = await Promise.all([
        tradingConfigApi.listAccounts(),
        tradingConfigApi.getBrokerTypes(),
      ]);
      setAccounts(accountsRes.accounts);
      setBrokerTypes(typesRes.brokerTypes);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(id: string) {
    if (!confirm(`确定删除账户 "${id}" 吗？`)) return;
    await tradingConfigApi.deleteAccount(id);
    await refresh();
  }

  async function handleView(id: string) {
    setViewingId(id);
    setViewLoading(true);
    setViewBalance(null);
    setViewPositions([]);
    setViewError(null);
    try {
      const [bal, pos] = await Promise.all([
        tradingApi.getBalance(id),
        tradingApi.getPositions(id),
      ]);
      setViewBalance(bal);
      setViewPositions(pos.positions);
    } catch (e) {
      setViewError((e as Error).message);
    } finally {
      setViewLoading(false);
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">交易配置</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            配置方式交易所、动态密钥字段、连接测试后保存
          </p>
        </div>
        <button
          onClick={() => setEditState({ kind: "create" })}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          + 添加账户
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">账户 ID</th>
              <th className="px-4 py-3 font-medium">类型</th>
              <th className="px-4 py-3 font-medium">交易所</th>
              <th className="px-4 py-3 font-medium text-center">启用</th>
              <th className="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  暂无交易账户
                </td>
              </tr>
            )}
            {accounts.map((account) => (
              <tr
                key={account.id}
                className="border-b border-border last:border-0 transition-colors hover:bg-muted/40"
              >
                <td className="px-4 py-3 font-medium">{account.id}</td>
                <td className="px-4 py-3">{account.type}</td>
                <td className="px-4 py-3">
                  {typeof account.brokerConfig.exchange === "string"
                    ? account.brokerConfig.exchange
                    : "-"}
                </td>
                <td className="px-4 py-3 text-center">
                  {account.enabled ? (
                    <span className="text-xs font-medium text-success">已启用</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">已禁用</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => void handleView(account.id)}
                    className="mr-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    查看
                  </button>
                  <button
                    onClick={() => setEditState({ kind: "edit", account })}
                    className="mr-2 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void handleDelete(account.id)}
                    className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={editState !== null}
        onClose={() => setEditState(null)}
        title={editState?.kind === "create" ? "添加交易账户" : "编辑交易账户"}
      >
        {editState && (
          <AccountForm
            mode={editState.kind}
            initial={editState.kind === "edit" ? editState.account : null}
            brokerTypes={brokerTypes}
            existingIds={accounts.map((a) => a.id)}
            onSaved={async () => {
              setEditState(null);
              await refresh();
            }}
            onCancel={() => setEditState(null)}
          />
        )}
      </Modal>

      <Modal
        open={viewingId !== null}
        onClose={() => setViewingId(null)}
        title={`账户详情 — ${viewingId ?? ""}`}
      >
        <AccountDetailView
          loading={viewLoading}
          balance={viewBalance}
          positions={viewPositions}
          error={viewError}
          onRefresh={() => viewingId && void handleView(viewingId)}
        />
      </Modal>
    </div>
  );
}

function fmt(val: string | undefined, decimals = 2): string {
  const n = parseFloat(val ?? "0");
  if (isNaN(n)) return val ?? "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function PnlCell({ value }: { value: string }) {
  const n = parseFloat(value);
  if (isNaN(n) || n === 0)
    return <span className="text-muted-foreground">0.00</span>;
  return (
    <span className={n > 0 ? "text-success" : "text-danger"}>
      {n > 0 ? "+" : ""}
      {fmt(value)}
    </span>
  );
}

function AccountDetailView(props: {
  loading: boolean;
  balance: AccountBalance | null;
  positions: TradePosition[];
  error: string | null;
  onRefresh: () => void;
}) {
  const { loading, balance, positions, error, onRefresh } = props;

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onRefresh}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!balance) return null;

  return (
    <div className="space-y-5">
      {/* Balance summary */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "净值", value: fmt(balance.netLiquidation) },
          { label: "可用余额", value: fmt(balance.totalCashValue) },
          { label: "已用保证金", value: fmt(balance.initMarginReq) },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-center"
          >
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 font-mono text-sm font-semibold text-foreground">
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Positions */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">
            持仓 ({positions.length})
          </span>
          <button
            onClick={onRefresh}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            刷新
          </button>
        </div>

        {positions.length === 0 ? (
          <div className="rounded-lg border border-border py-6 text-center text-sm text-muted-foreground">
            暂无持仓
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Symbol</th>
                  <th className="px-3 py-2 font-medium">方向</th>
                  <th className="px-3 py-2 text-right font-medium">数量</th>
                  <th className="px-3 py-2 text-right font-medium">开仓价</th>
                  <th className="px-3 py-2 text-right font-medium">标记价</th>
                  <th className="px-3 py-2 text-right font-medium">未实现盈亏</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos, i) => (
                  <tr
                    key={i}
                    className="border-b border-border last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 font-mono font-medium">{pos.symbol}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          pos.side === "long"
                            ? "text-success font-medium"
                            : "text-danger font-medium"
                        }
                      >
                        {pos.side === "long" ? "多" : "空"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(pos.quantity, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(pos.entryPrice, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(pos.markPrice, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      <PnlCell value={pos.unrealizedPnl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountForm(props: {
  mode: "create" | "edit";
  initial: TradingAccountConfig | null;
  brokerTypes: BrokerTypeInfo[];
  existingIds: string[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { mode, initial, brokerTypes, existingIds, onSaved, onCancel } = props;
  const [id, setId] = useState(initial?.id ?? "");
  const [type, setType] = useState(initial?.type ?? "ccxt");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [brokerConfig, setBrokerConfig] = useState<Record<string, unknown>>(
    initial?.brokerConfig ?? {},
  );
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const [ccxtExchanges, setCcxtExchanges] = useState<string[]>([]);
  const [ccxtCredFields, setCcxtCredFields] = useState<BrokerConfigField[]>([]);

  const selectedType = useMemo(
    () => brokerTypes.find((b) => b.type === type),
    [brokerTypes, type],
  );

  const fields = useMemo(() => {
    if (!selectedType) return [];
    if (type !== "ccxt") return selectedType.fields;
    return selectedType.fields
      .map((f) =>
        f.name === "exchange"
          ? {
              ...f,
              options: ccxtExchanges.map((x) => ({
                value: x,
                label: x,
              })),
            }
          : f,
      )
      .concat(ccxtCredFields);
  }, [selectedType, type, ccxtExchanges, ccxtCredFields]);

  useEffect(() => {
    if (type !== "ccxt") return;
    void tradingConfigApi
      .getCcxtExchanges()
      .then((res) => setCcxtExchanges(res.exchanges))
      .catch(() => setCcxtExchanges([]));
  }, [type]);

  useEffect(() => {
    if (type !== "ccxt") return;
    const exchange = brokerConfig.exchange;
    if (typeof exchange !== "string" || exchange.length === 0) {
      setCcxtCredFields([]);
      return;
    }
    void tradingConfigApi
      .getCcxtCredentialFields(exchange)
      .then((res) => setCcxtCredFields(res.fields))
      .catch(() => setCcxtCredFields([]));
  }, [type, brokerConfig.exchange]);

  useEffect(() => {
    if (type !== "ccxt") return;
  }, [type]);

  function patchBrokerField(name: string, value: unknown) {
    setBrokerConfig((prev) => ({ ...prev, [name]: value }));
  }

  const requiredOk = fields
    .filter((f) => f.required)
    .every((f) => String(brokerConfig[f.name] ?? "").trim().length > 0);

  async function testConnection() {
    setTesting(true);
    setError(null);
    setTestStatus(null);
    try {
      const payload: TradingAccountConfig = {
        id: id.trim() || `${type}-main`,
        type,
        enabled,
        guards: initial?.guards ?? [],
        brokerConfig,
      };
      const res = await tradingConfigApi.testConnection(payload);
      if (res.success) setTestStatus("连接测试成功");
      else setError(res.error ?? "连接测试失败");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const finalId = id.trim() || `${type}-main`;
    if (mode === "create" && existingIds.includes(finalId)) {
      setError(`账户 "${finalId}" 已存在`);
      return;
    }
    setSaving(true);
    setError(null);
    setTestStatus(null);
    try {
      const payload: TradingAccountConfig = {
        id: finalId,
        type,
        enabled,
        guards: initial?.guards ?? [],
        brokerConfig,
      };
      await tradingConfigApi.upsertAccount(payload);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>账户 ID</label>
          <input
            className={inputClass}
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={mode === "edit"}
          />
        </div>
        <div>
          <label className={labelClass}>账户类型</label>
          <select
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={mode === "edit"}
          >
            {brokerTypes.map((b) => (
              <option key={b.type} value={b.type}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
        />
        启用账户
      </label>

      {fields.length > 0 && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          {fields.map((f) => (
            <div key={f.name}>
              <label className={labelClass}>{f.label}</label>
              {f.type === "boolean" ? (
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(brokerConfig[f.name] ?? f.default)}
                    onChange={(e) => patchBrokerField(f.name, e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
                  />
                  {f.description ?? "启用"}
                </label>
              ) : f.type === "select" ? (
                <select
                  className={inputClass}
                  value={String(brokerConfig[f.name] ?? f.default ?? "")}
                  onChange={(e) => patchBrokerField(f.name, e.target.value)}
                >
                  {f.name === "exchange" && (
                    <option value="">
                      请选择交易所
                    </option>
                  )}
                  {f.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputClass}
                  type={f.sensitive && !showSecrets ? "password" : "text"}
                  value={String(brokerConfig[f.name] ?? f.default ?? "")}
                  onChange={(e) => patchBrokerField(f.name, e.target.value)}
                  placeholder={f.placeholder ?? ""}
                />
              )}
            </div>
          ))}
          {fields.some((f) => f.sensitive) && (
            <button
              type="button"
              onClick={() => setShowSecrets((v) => !v)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {showSecrets ? "隐藏密钥" : "显示密钥"}
            </button>
          )}
        </div>
      )}

      {testStatus && (
        <div className="rounded border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {testStatus}
        </div>
      )}
      {error && (
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !requiredOk}
          className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing ? "测试中..." : "测试连接"}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !requiredOk}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
