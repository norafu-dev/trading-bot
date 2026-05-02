"use client";

import { useCallback, useEffect, useState } from "react";
import { llmConfigApi } from "@/lib/api";
import type { LlmTestResult, PublicLlmConfig } from "@/lib/api";

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
