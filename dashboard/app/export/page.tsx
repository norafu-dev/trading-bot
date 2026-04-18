"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChannelConfig, KolConfig } from "@shared/types";
import { channelApi, kolApi, discordApi } from "@/lib/api";
import type { ExportRecord, ExportResult } from "@/lib/api";

// ── helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Format records as plain text for pasting directly into an AI prompt. */
function toAiText(result: ExportResult, kolMap: Map<string, string>): string {
  const lines: string[] = [
    `=== KOL 发言导出 ===`,
    `频道 ID : ${result.channelId}`,
    `日期范围: ${result.dateFrom.slice(0, 10)} ~ ${result.dateTo.slice(0, 10)}`,
    `消息数量: ${result.total}`,
    ``,
  ];
  for (const m of result.messages) {
    const name = kolMap.get(m.authorId) ?? m.authorUsername;
    const ts = new Date(m.timestamp).toLocaleString("zh-CN");
    lines.push(`[${ts}] ${name}`);
    if (m.text) lines.push(m.text);
    for (const url of m.images) {
      lines.push(`[图片] ${url}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── component ─────────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50";
const labelClass =
  "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

export default function ExportPage() {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [channelId, setChannelId] = useState("");
  const [selectedKols, setSelectedKols] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState(daysAgo(7));
  const [dateTo, setDateTo] = useState(today());
  const [limit, setLimit] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    channelApi.list().then((list) => {
      setChannels(list.filter((c) => c.enabled));
      if (list.length > 0) setChannelId(list[0].id);
    }).catch(() => {});
    kolApi.list().then(setKols).catch(() => {});
  }, []);

  const kolMap = new Map(kols.map((k) => [k.id, k.label]));

  const selectedChannel = channels.find((c) => c.id === channelId);
  // When channel changes, pre-select that channel's associated KOLs
  const handleChannelChange = useCallback((id: string) => {
    setChannelId(id);
    const ch = channels.find((c) => c.id === id);
    if (ch && ch.kolIds.length > 0) setSelectedKols(new Set(ch.kolIds));
    else setSelectedKols(new Set());
    setResult(null);
  }, [channels]);

  function toggleKol(id: string) {
    setSelectedKols((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleFetch() {
    if (!channelId) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await discordApi.export({
        channelId,
        authorIds: [...selectedKols],
        dateFrom,
        dateTo,
        limit,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{"\u5386\u53f2\u6d88\u606f\u5bfc\u51fa"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {"\u91c7\u96c6\u6307\u5b9a\u9891\u9053\u3001KOL\u3001\u65e5\u671f\u8303\u56f4\u7684\u5386\u53f2\u53d1\u8a00\uff0c\u5bfc\u51fa\u7ed9 AI \u5206\u6790 KOL \u4ea4\u6613\u98ce\u683c"}
        </p>
      </div>

      {/* ── Form ── */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-5">

        {/* Channel */}
        <div>
          <label className={labelClass}>{"\u76d1\u542c\u9891\u9053"}</label>
          <select className={inputClass} value={channelId}
            onChange={(e) => handleChannelChange(e.target.value)}>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.label} ({ch.id})</option>
            ))}
          </select>
          {selectedChannel?.group && (
            <p className="mt-1 text-xs text-muted-foreground">{"\u5206\u7ec4\uff1a"}{selectedChannel.group}</p>
          )}
        </div>

        {/* KOL filter */}
        <div>
          <label className={labelClass}>{"\u8fc7\u6ee4 KOL\uff08\u4e0d\u52fe\u9009 = \u5bfc\u51fa\u8be5\u9891\u9053\u6240\u6709\u4eba\uff09"}</label>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-muted p-2 space-y-1">
            {kols.map((kol) => (
              <label key={kol.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-card">
                <input type="checkbox" checked={selectedKols.has(kol.id)}
                  onChange={() => toggleKol(kol.id)}
                  className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary" />
                <span className="text-sm">{kol.label}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{kol.id}</span>
              </label>
            ))}
            {kols.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{"\u6682\u65e0 KOL\uff0c\u5c06\u5bfc\u51fa\u9891\u9053\u6240\u6709\u6d88\u606f"}</p>
            )}
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{"\u5f00\u59cb\u65e5\u671f"}</label>
            <input type="date" className={inputClass} value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>{"\u7ed3\u675f\u65e5\u671f"}</label>
            <input type="date" className={inputClass} value={dateTo}
              onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        {/* Limit */}
        <div>
          <label className={labelClass}>{"\u6700\u591a\u83b7\u53d6\u6761\u6570\uff08\u6700\u5927 500\uff09"}</label>
          <input type="number" className={inputClass} value={limit} min={1} max={500}
            onChange={(e) => setLimit(Number(e.target.value))} />
        </div>

        <button
          onClick={() => void handleFetch()}
          disabled={loading || !channelId}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50">
          {loading ? "\u91c7\u96c6\u4e2d\uff0c\u8bf7\u7a0d\u5019\u2026" : "\u5f00\u59cb\u91c7\u96c6"}
        </button>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
        )}
      </div>

      {/* ── Results ── */}
      {result && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-semibold text-foreground">
                {"\u91c7\u96c6\u5b8c\u6210\uff1a"}{result.total} {"\u6761\u6d88\u606f"}
              </span>
              <span className="ml-3 text-xs text-muted-foreground">
                {result.dateFrom.slice(0, 10)} ~ {result.dateTo.slice(0, 10)}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => downloadText(
                  toAiText(result, kolMap),
                  `kol-export-${channelId}-${dateFrom}-${dateTo}.txt`
                )}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
                {"\u4e0b\u8f7d .txt\uff08AI \u5206\u6790\u7528\uff09"}
              </button>
              <button
                onClick={() => downloadJson(
                  result.messages,
                  `kol-export-${channelId}-${dateFrom}-${dateTo}.json`
                )}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
                {"\u4e0b\u8f7d .json"}
              </button>
            </div>
          </div>

          {/* Preview */}
          <div className="max-h-[480px] overflow-y-auto rounded-xl border border-border bg-card divide-y divide-border">
            {result.messages.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {"\u8be5\u65f6\u95f4\u8303\u56f4\u5185\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u6d88\u606f"}
              </p>
            )}
            {result.messages.map((m: ExportRecord) => (
              <div key={m.messageId} className="px-4 py-3">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs font-semibold text-primary">
                    {kolMap.get(m.authorId) ?? m.authorUsername}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(m.timestamp).toLocaleString("zh-CN")}
                  </span>
                  {m.hasEmbeds && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">embed</span>
                  )}
                </div>
                {m.text && (
                  <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">{m.text}</p>
                )}
                {m.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.images.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="attachment"
                          className="max-h-48 max-w-xs rounded-lg border border-border object-contain shadow-sm" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
