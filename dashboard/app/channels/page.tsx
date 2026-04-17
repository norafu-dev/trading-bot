"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChannelConfig, KolConfig } from "@shared/types";
import { channelApi, kolApi } from "@/lib/api";
import type { CreateChannel, UpdateChannel } from "@/lib/api";
import { Modal } from "../components/modal";
import { GroupCombobox } from "@/components/ui/group-combobox";

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [showModal, setShowModal] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [ch, k] = await Promise.all([channelApi.list(), kolApi.list()]);
      setChannels(ch);
      setKols(k);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleSave(data: CreateChannel) {
    if (editing) {
      const { id: _id, ...rest } = data;
      await channelApi.update(editing.id, rest as UpdateChannel);
    } else {
      await channelApi.create(data);
    }
    setShowModal(false);
    await refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm("确定要删除这个频道吗？")) return;
    await channelApi.remove(id);
    await refresh();
  }

  async function handleToggle(channel: ChannelConfig) {
    await channelApi.update(channel.id, { enabled: !channel.enabled });
    await refresh();
  }

  const kolMap = new Map(kols.map((k) => [k.id, k.label]));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">频道管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理要监听的 Discord 频道，关联受信任的 KOL</p>
        </div>
        <button onClick={() => { setEditing(null); setShowModal(true); }}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          + 添加频道
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">频道名</th>
              <th className="px-4 py-3 font-medium">分组</th>
              <th className="px-4 py-3 font-medium">Channel ID</th>
              <th className="px-4 py-3 font-medium">Guild ID</th>
              <th className="px-4 py-3 font-medium text-center">启用</th>
              <th className="px-4 py-3 font-medium">关联 KOL</th>
              <th className="px-4 py-3 font-medium text-center">解析全部</th>
              <th className="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">加载中…</td></tr>
            )}
            {!loading && channels.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">暂无频道，点击右上角添加</td></tr>
            )}
            {channels.map((ch) => (
              <tr key={ch.id} className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-4 py-3 font-medium">{ch.label}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {ch.group
                    ? <span className="rounded bg-muted px-2 py-0.5 text-foreground">{ch.group}</span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ch.id}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ch.guildId}</td>
                <td className="px-4 py-3 text-center">
                  <Toggle enabled={ch.enabled} onToggle={() => void handleToggle(ch)} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {ch.kolIds.length === 0 && <span className="text-xs text-muted-foreground">无限制</span>}
                    {ch.kolIds.map((kid) => (
                      <span key={kid} className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {kolMap.get(kid) ?? kid}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  {ch.parseAllMessages
                    ? <span className="text-success text-xs font-medium">是</span>
                    : <span className="text-muted-foreground text-xs">否</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEditing(ch); setShowModal(true); }}
                    className="mr-2 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">编辑</button>
                  <button onClick={() => void handleDelete(ch.id)}
                    className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? "编辑频道" : "添加频道"}>
        <ChannelForm initial={editing} kols={kols} allChannels={channels}
          onSave={(data) => void handleSave(data)} onCancel={() => setShowModal(false)} />
      </Modal>
    </div>
  );
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`inline-flex h-6 w-10 items-center rounded-full transition-colors ${enabled ? "bg-success" : "bg-border"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}

const inputClass = "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50";
const labelClass = "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

function ChannelForm({ initial, kols, allChannels, onSave, onCancel }: {
  initial: ChannelConfig | null;
  kols: KolConfig[];
  allChannels: ChannelConfig[];
  onSave: (data: CreateChannel) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [guildId, setGuildId] = useState(initial?.guildId ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [group, setGroup] = useState(initial?.group ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [parseAll, setParseAll] = useState(initial?.parseAllMessages ?? false);
  const [selectedKols, setSelectedKols] = useState<Set<string>>(new Set(initial?.kolIds ?? []));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const existingGroups = [...new Set(
    allChannels.map((c) => c.group).filter((g): g is string => !!g)
  )];

  function toggleKol(kolId: string) {
    setSelectedKols((prev) => {
      const next = new Set(prev);
      if (next.has(kolId)) next.delete(kolId); else next.add(kolId);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ id, guildId, label, group: group.trim() || undefined, enabled, kolIds: [...selectedKols], parseAllMessages: parseAll, notes: notes || undefined });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>频道名称</label>
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="例: #alpha-calls" required />
        </div>
        <div>
          <label className={labelClass}>频道名称</label>
          <GroupCombobox value={group} onChange={setGroup} options={existingGroups} placeholder="例: WWG交易员（可留空）" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Channel ID</label>
          <input className={inputClass} value={id} onChange={(e) => setId(e.target.value)}
            placeholder="Discord 频道 ID" required disabled={!!initial} />
        </div>
        <div>
          <label className={labelClass}>Guild (Server) ID</label>
          <input className={inputClass} value={guildId} onChange={(e) => setGuildId(e.target.value)}
            placeholder="Discord 服务器 ID" required />
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <Toggle enabled={enabled} onToggle={() => setEnabled(!enabled)} />
          <span className="text-sm text-foreground">启用监听</span>
        </div>
        <div className="flex items-center gap-3">
          <Toggle enabled={parseAll} onToggle={() => setParseAll(!parseAll)} />
          <span className="text-sm text-foreground">解析所有消息</span>
        </div>
      </div>

      <div>
        <label className={labelClass}>关联 KOL（仅解析这些用户的消息）</label>
        {kols.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无 KOL，请先在 KOL 管理页面添加</p>
        ) : (
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted p-2">
            {kols.map((kol) => (
              <label key={kol.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-card">
                <input type="checkbox" checked={selectedKols.has(kol.id)} onChange={() => toggleKol(kol.id)}
                  className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary" />
                <span className="text-sm">{kol.label}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{kol.id}</span>
              </label>
            ))}
          </div>
        )}
        {parseAll && <p className="mt-1 text-xs text-muted-foreground">「解析所有消息」已开启，KOL 关联仅作为辅助标记</p>}
      </div>

      <div>
        <label className={labelClass}>备注</label>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="可选备注信息" />
      </div>

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <button type="button" onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">取消</button>
        <button type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          {initial ? "保存更改" : "添加"}
        </button>
      </div>
    </form>
  );
}
