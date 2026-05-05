"use client";

import { useCallback, useEffect, useState } from "react";
import { executionConfigApi, llmConfigApi, riskConfigApi, telegramConfigApi } from "@/lib/api";
import type {
  ExecutionConfig,
  LlmTestResult,
  PublicLlmConfig,
  PublicTelegramConfig,
  TelegramTestResult,
} from "@/lib/api";
import type { RiskConfig } from "@shared/types";

// ==================== Page ====================

export default function SettingsPage() {
  const [config, setConfig] = useState<PublicLlmConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setConfig(await llmConfigApi.get());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">系统设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          LLM 解析器、API 密钥、置信度阈值等
        </p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {restartHint && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="flex-1">
            <p className="font-medium">配置已保存，需要重启后端进程才能生效</p>
            <p className="mt-1 text-xs opacity-80">
              管线在启动时读取 LLM 配置一次，运行时修改不会即时生效（避免请求中途切换 provider 导致 SessionLogger 记录不一致）。在终端运行 <code className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono">pnpm dev</code> 重启 signal 进程。
            </p>
          </div>
          <button
            onClick={() => setRestartHint(false)}
            className="text-xs text-amber-400 hover:text-amber-300"
          >
            知道了
          </button>
        </div>
      )}

      <div className="mt-6 max-w-3xl space-y-6">
        {loading && (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        )}
        {!loading && config && (
          <LlmConfigCard
            initial={config}
            onSaved={async () => {
              setRestartHint(true);
              await refresh();
            }}
          />
        )}
        <ExecutionConfigCard />
        <RiskConfigCard />
        <TelegramConfigCard onSaved={() => setRestartHint(true)} />
      </div>
    </div>
  );
}

// ==================== LLM Config Card ====================

const inputClass =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50";
const labelClass =
  "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

function LlmConfigCard({
  initial,
  onSaved,
}: {
  initial: PublicLlmConfig;
  onSaved: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState(""); // empty = preserve
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [classifyModel, setClassifyModel] = useState(initial.classifyModel);
  const [extractModel, setExtractModel] = useState(initial.extractModel);
  const [confidenceThreshold, setConfidenceThreshold] = useState(
    String(initial.confidenceThreshold),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty =
    apiKey.length > 0 ||
    baseUrl !== initial.baseUrl ||
    classifyModel !== initial.classifyModel ||
    extractModel !== initial.extractModel ||
    Number(confidenceThreshold) !== initial.confidenceThreshold;

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      await llmConfigApi.update({
        ...(apiKey.length > 0 ? { apiKey } : {}),
        baseUrl,
        classifyModel,
        extractModel,
        confidenceThreshold: Number(confidenceThreshold),
      });
      setApiKey(""); // clear input — backend keeps the saved one
      await onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await llmConfigApi.test({
        ...(apiKey.length > 0 ? { apiKey } : {}),
        baseUrl,
        classifyModel,
      });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">LLM Provider</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            通过 OpenRouter 调用分类器与抽取器。改动落盘到{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              data/config/llm.json
            </code>
            ，不会被 git 追踪。
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${
            initial.apiKeyConfigured
              ? "border-green-500/30 bg-green-500/10 text-green-400"
              : "border-amber-500/30 bg-amber-500/10 text-amber-400"
          }`}
        >
          {initial.apiKeyConfigured ? "已配置" : "未配置"}
        </span>
      </div>

      <div className="mt-5 space-y-4">
        {/* API Key */}
        <div>
          <label className={labelClass}>API Key</label>
          <div className="relative">
            <input
              type="password"
              className={inputClass}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                initial.apiKeyConfigured
                  ? `（已存储，末 4 位 …${initial.apiKeyLast4}，留空保留）`
                  : "sk-or-v1-..."
              }
              autoComplete="off"
            />
            {initial.apiKeyConfigured && apiKey.length === 0 && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium uppercase tracking-wide text-green-400">
                active
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            从{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              openrouter.ai/keys
            </a>{" "}
            获取。明文写入磁盘 — 部署到生产时建议改用环境变量保护。
          </p>
        </div>

        {/* Base URL */}
        <div>
          <label className={labelClass}>Base URL</label>
          <input
            className={inputClass}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        {/* Models */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Classify 模型</label>
            <input
              className={inputClass}
              value={classifyModel}
              onChange={(e) => setClassifyModel(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              用于分类阶段（信号 / 更新 / 闲聊）— 选便宜快速的
            </p>
          </div>
          <div>
            <label className={labelClass}>Extract 模型</label>
            <input
              className={inputClass}
              value={extractModel}
              onChange={(e) => setExtractModel(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              用于字段抽取 — 选高质量、支持视觉的
            </p>
          </div>
        </div>

        {/* Confidence threshold */}
        <div>
          <label className={labelClass}>默认置信度阈值 (0–1)</label>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            className={inputClass}
            value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            LLM 抽取置信度低于此值的信号会被丢弃。可以在 KOL 卡片单独覆盖。
          </p>
        </div>

        {/* Test result */}
        {testResult && (
          <div
            className={`rounded-lg border px-3 py-2.5 text-xs ${
              testResult.ok
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-danger/30 bg-danger/10 text-danger"
            }`}
          >
            {testResult.ok ? (
              <>
                <div className="font-medium">✓ 连接成功</div>
                <div className="mt-1 font-mono text-[11px] opacity-80">
                  {testResult.model} · {testResult.latencyMs}ms · 输入{" "}
                  {testResult.inputTokens} / 输出 {testResult.outputTokens} tokens
                </div>
                {testResult.note && (
                  <div className="mt-1 italic opacity-80">{testResult.note}</div>
                )}
              </>
            ) : (
              <>
                <div className="font-medium">✗ 连接失败</div>
                <div className="mt-1 break-words font-mono text-[11px]">
                  {testResult.error}
                </div>
              </>
            )}
          </div>
        )}

        {saveError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            保存失败：{saveError}
          </div>
        )}

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== Risk Config Card ====================

/**
 * Position-sizing + guard knobs for the copy-trading engine. Edits here
 * apply to the NEXT signal — no restart required (engine reads
 * `loadRiskConfig` per operation).
 */
function RiskConfigCard() {
  const [config, setConfig] = useState<RiskConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConfig(await riskConfigApi.get());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!config) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {error ?? "加载风控配置中…"}
      </div>
    );
  }

  return (
    <Inner config={config} onChange={setConfig} onError={setError} saving={saving} setSaving={setSaving} savedAt={savedAt} setSavedAt={setSavedAt} />
  );
}

function Inner({
  config, onChange, onError, saving, setSaving, savedAt, setSavedAt,
}: {
  config: RiskConfig;
  onChange: (c: RiskConfig) => void;
  onError: (s: string | null) => void;
  saving: boolean;
  setSaving: (b: boolean) => void;
  savedAt: number | null;
  setSavedAt: (n: number) => void;
}) {
  const [base, setBase] = useState(String(config.baseRiskPercent));
  const [maxOp, setMaxOp] = useState(String(config.maxOperationSizePercent));
  const [whitelist, setWhitelist] = useState(config.symbolWhitelist.join(", "));
  const [cooldown, setCooldown] = useState(String(config.cooldownMinutes));

  const dirty =
    Number(base) !== config.baseRiskPercent ||
    Number(maxOp) !== config.maxOperationSizePercent ||
    Number(cooldown) !== config.cooldownMinutes ||
    whitelist !== config.symbolWhitelist.join(", ");

  async function handleSave() {
    onError(null);
    setSaving(true);
    try {
      const updated = await riskConfigApi.update({
        baseRiskPercent: Number(base),
        maxOperationSizePercent: Number(maxOp),
        symbolWhitelist: whitelist.split(",").map((s) => s.trim()).filter(Boolean),
        cooldownMinutes: Number(cooldown),
      });
      onChange(updated);
      setSavedAt(Date.now());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">风险与守卫</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            操作仓位大小 + 全局守卫规则。改动落盘到{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">data/config/risk.json</code>
            ，下一条信号立即生效（不需要重启）。
          </p>
        </div>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="shrink-0 rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1 text-[10px] text-green-400">
            ✓ 已保存
          </span>
        )}
      </div>

      <div className="mt-5 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>基础风险 % (每信号)</label>
            <input
              type="number" step="0.1" min="0" max="100"
              className={inputClass}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              名义仓位 = 权益 × 此 % × KOL 风险倍数 × 信号置信度
            </p>
          </div>
          <div>
            <label className={labelClass}>单次操作上限 % (硬封顶)</label>
            <input
              type="number" step="0.1" min="0" max="100"
              className={inputClass}
              value={maxOp}
              onChange={(e) => setMaxOp(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              即使 KOL 倍数+置信度乘积超过此值也会被封顶
            </p>
          </div>
        </div>

        <div>
          <label className={labelClass}>Symbol 白名单（逗号分隔，留空=全部允许）</label>
          <input
            className={inputClass}
            value={whitelist}
            onChange={(e) => setWhitelist(e.target.value)}
            placeholder="如 BTC, ETH, SOL"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            归一化匹配 — &quot;BTC&quot; 同时匹配 BTC/USDT / BTCUSDT / BTC/USDT:USDT
          </p>
        </div>

        <div className="max-w-xs">
          <label className={labelClass}>冷却时间（分钟）</label>
          <input
            type="number" step="1" min="0"
            className={inputClass}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            同 KOL 同 symbol 两次操作的最小间隔
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存风控"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== Execution Config Card ====================

/**
 * Execution mode + safety knobs. Top-level switch is dry-run ↔ live;
 * flipping to live requires an explicit typed confirmation because every
 * subsequent approved Operation will hit the real exchange. Saves take
 * effect immediately — the broker dispatcher reads this config per
 * operation, so this is also the fastest emergency stop-trading lever.
 */
function ExecutionConfigCard() {
  const [config, setConfig] = useState<ExecutionConfig | null>(null);
  const [draft, setDraft] = useState<ExecutionConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cfg = await executionConfigApi.get();
      setConfig(cfg);
      setDraft(cfg);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!config || !draft) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {error ?? "加载执行配置中…"}
      </div>
    );
  }

  const dirty = JSON.stringify(config) !== JSON.stringify(draft);
  const isLive = config.mode === "live";
  const willGoLive = config.mode === "dry-run" && draft.mode === "live";

  const handleSave = async () => {
    if (willGoLive) {
      const confirmText = prompt(
        "切到 LIVE 后，每一笔被批准的 Operation 都会真实下单到交易所。\n\n如确认，请输入 LIVE （大写）以继续：",
      );
      if (confirmText !== "LIVE") {
        alert("已取消");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const next = await executionConfigApi.update(draft);
      setConfig(next);
      setDraft(next);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-xl border p-6 ${
        isLive ? "border-red-500/40 bg-red-500/5" : "border-border bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">执行模式（broker）</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            被批准的 Operation 进入这一层。Dry-run 时只记日志不下单；live 时调用 CCXT 真下单。
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
            isLive
              ? "border-red-500/40 bg-red-500/10 text-red-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400"
          }`}
        >
          {isLive ? "🔴 LIVE 真金白银" : "🟡 DRY-RUN 演练"}
        </span>
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label className={labelClass}>模式</label>
          <div className="flex gap-2">
            <button
              onClick={() => setDraft({ ...draft, mode: "dry-run" })}
              className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                draft.mode === "dry-run"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                  : "border-border bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              🟡 Dry-run（不下单）
            </button>
            <button
              onClick={() => setDraft({ ...draft, mode: "live" })}
              className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                draft.mode === "live"
                  ? "border-red-500/40 bg-red-500/10 text-red-400"
                  : "border-border bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              🔴 Live（真下单）
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>单笔最大名义金额 (USDT)</label>
            <input
              type="number"
              min={0}
              value={draft.maxOrderUsdt}
              onChange={(e) =>
                setDraft({ ...draft, maxOrderUsdt: Number(e.target.value) })
              }
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              超过此值的 Operation 直接拒单。0 = 不限。
            </p>
          </div>
          <div>
            <label className={labelClass}>滑点容忍 (%)</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={draft.slippageTolerancePercent}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  slippageTolerancePercent: Number(e.target.value),
                })
              }
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              市价单实时价偏离信号超过此值则拒单（暂未启用，等 Phase 7）。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.setLeverage}
              onChange={(e) =>
                setDraft({ ...draft, setLeverage: e.target.checked })
              }
              className="h-4 w-4 rounded border-border bg-muted"
            />
            自动设置杠杆
          </label>
          <div>
            <label className={labelClass}>保证金模式</label>
            <select
              value={draft.marginMode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  marginMode: e.target.value as "isolated" | "cross",
                })
              }
              className={inputClass}
            >
              <option value="isolated">逐仓</option>
              <option value="cross">全仓</option>
            </select>
          </div>
        </div>

        {willGoLive && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            ⚠️ 你正在把执行模式切到 <b>LIVE</b>。保存后下一笔被批准的 Operation 就会真实下单。建议先在 Dry-run 模式下走通几笔，再切。
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {savedAt && Date.now() - savedAt < 3000 && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
            ✅ 已保存，立即生效（无需重启）
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
              willGoLive
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                : "bg-primary text-primary-foreground hover:bg-primary-hover"
            }`}
          >
            {saving ? "保存中…" : willGoLive ? "切到 LIVE（需确认）" : "保存执行配置"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== Telegram Config Card ====================

/**
 * Telegram approval channel config. The bot token is masked once stored
 * (only last 4 chars shown); leaving the field blank on save preserves
 * the existing token. Enabled/chatId/timeout edits — like LLM config —
 * require a restart because the long-poll loop and notifier subscriptions
 * are wired at boot time. We surface this via the same `onSaved` hook
 * that LLM config uses to flip the page-level "restart required" banner.
 */
function TelegramConfigCard({ onSaved }: { onSaved: () => void }) {
  const [stored, setStored] = useState<PublicTelegramConfig | null>(null);
  const [draft, setDraft] = useState<{
    enabled: boolean;
    chatId: string;
    approvalTimeoutSeconds: string;
    botToken: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TelegramTestResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cfg = await telegramConfigApi.get();
      setStored(cfg);
      setDraft({
        enabled: cfg.enabled,
        chatId: String(cfg.chatId),
        approvalTimeoutSeconds: String(cfg.approvalTimeoutSeconds),
        botToken: "",
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!stored || !draft) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {error ?? "加载 Telegram 配置中…"}
      </div>
    );
  }

  const buildUpdate = () => ({
    enabled: draft.enabled,
    chatId: Number(draft.chatId),
    approvalTimeoutSeconds: Number(draft.approvalTimeoutSeconds),
    ...(draft.botToken.length > 0 && { botToken: draft.botToken }),
  });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await telegramConfigApi.update(buildUpdate());
      setStored(next);
      setDraft({
        enabled: next.enabled,
        chatId: String(next.chatId),
        approvalTimeoutSeconds: String(next.approvalTimeoutSeconds),
        botToken: "",
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await telegramConfigApi.test(buildUpdate());
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Telegram 审批通道</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            待审批的 Operation 推到这个 chat，inline 按钮直接批准/拒绝。超时后自动按拒绝处理。
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${
            stored.enabled && stored.botTokenConfigured && stored.chatId !== 0
              ? "border-green-500/40 bg-green-500/10 text-green-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400"
          }`}
        >
          {stored.enabled && stored.botTokenConfigured && stored.chatId !== 0 ? "已启用" : "未启用"}
        </span>
      </div>

      <div className="mt-5 space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 rounded border-border bg-muted"
          />
          启用 Telegram 审批通道（关闭则只走 Dashboard 审批）
        </label>

        <div>
          <label className={labelClass}>Chat ID</label>
          <input
            type="text"
            inputMode="numeric"
            value={draft.chatId}
            onChange={(e) => setDraft({ ...draft, chatId: e.target.value })}
            placeholder="例如 -5136040062（group ID 是负数）"
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            私聊正整数；group / supergroup 为负数。Bot 必须已被加入该 chat。
          </p>
        </div>

        <div>
          <label className={labelClass}>Bot Token</label>
          <input
            type="password"
            value={draft.botToken}
            onChange={(e) => setDraft({ ...draft, botToken: e.target.value })}
            placeholder={
              stored.botTokenConfigured
                ? `已配置 (•••${stored.botTokenLast4}) — 留空保持不变`
                : "粘贴 BotFather 给的 token"
            }
            className={`${inputClass} font-mono`}
          />
        </div>

        <div>
          <label className={labelClass}>审批超时（秒）</label>
          <input
            type="number"
            min={0}
            value={draft.approvalTimeoutSeconds}
            onChange={(e) =>
              setDraft({ ...draft, approvalTimeoutSeconds: e.target.value })
            }
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            到期未审批的 Operation 自动按"拒绝"处理。0 = 不超时。默认 300 秒（5 分钟）。
          </p>
        </div>

        {testResult && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              testResult.ok
                ? "border-green-500/40 bg-green-500/10 text-green-400"
                : "border-red-500/40 bg-red-500/10 text-red-400"
            }`}
          >
            {testResult.ok ? (
              <>
                ✅ 已发送测试消息到 chat <code className="font-mono">{testResult.chatId}</code> · bot{" "}
                <code className="font-mono">@{testResult.botUsername}</code> · {testResult.latencyMs}ms
              </>
            ) : (
              <>❌ {testResult.error}</>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={() => void handleTest()}
            disabled={testing || saving}
            className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
          >
            {testing ? "测试中…" : "测试连通"}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || testing}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存 Telegram"}
          </button>
        </div>
      </div>
    </div>
  );
}
