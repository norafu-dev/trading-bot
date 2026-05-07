"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChannelConfig, KolConfig } from "@shared/types";
import { channelApi, kolApi } from "@/lib/api";
import type { CreateChannel, UpdateChannel } from "@/lib/api";
import { Modal } from "../components/modal";
import { GroupCombobox } from "@/components/ui/group-combobox";

type SortKey = "enabled" | null;
type SortDir = "asc" | "desc";

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [showModal, setShowModal] = useState(false);
  // null = original config order; click 启用 header to toggle asc/desc.
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSortClick(key: NonNullable<SortKey>) {
    if (sortKey === key) {
      // Three-state cycle so users can return to original order:
      //   off → desc → asc → off
      if (sortDir === "desc") setSortDir("asc");
      else { setSortKey(null); setSortDir("desc"); }
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

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
    if (!confirm("\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u4e2a\u9891\u9053\u5417\uff1f")) return;
    await channelApi.remove(id);
    await refresh();
  }

  async function handleToggle(channel: ChannelConfig) {
    await channelApi.update(channel.id, { enabled: !channel.enabled });
    await refresh();
  }

  const kolMap = new Map(kols.map((k) => [k.id, k.label]));
  const channelMap = new Map(channels.map((c) => [c.id, c.label]));

  // Apply sort without mutating channels (keeps file order as the off state).
  const displayChannels = sortKey === null
    ? channels
    : [...channels].sort((a, b) => {
        // enabled is the only sortable key right now; trues group first when desc.
        const av = a.enabled ? 1 : 0;
        const bv = b.enabled ? 1 : 0;
        return sortDir === "desc" ? bv - av : av - bv;
      });

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{"\u9891\u9053\u7ba1\u7406"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{"\u7ba1\u7406\u8981\u76d1\u542c\u7684 Discord \u9891\u9053\uff0c\u5173\u8054\u53d7\u4fe1\u4efb\u7684 KOL"}</p>
        </div>
        <button onClick={() => { setEditing(null); setShowModal(true); }}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          + {"\u6dfb\u52a0\u9891\u9053"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">{"\u9891\u9053\u540d"}</th>
              <th className="px-4 py-3 font-medium">{"\u5206\u7ec4"}</th>
              <th className="px-4 py-3 font-medium">Channel ID</th>
              <th className="px-4 py-3 font-medium">Guild ID</th>
              <th
                className="px-4 py-3 font-medium text-center cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSortClick("enabled")}
                title={"\u70b9\u51fb\u5207\u6362\u6392\u5e8f\uff1a\u539f\u987a\u5e8f / \u542f\u7528\u4f18\u5148 / \u7981\u7528\u4f18\u5148"}
              >
                <span className="inline-flex items-center gap-1">
                  {"\u542f\u7528"}
                  {sortKey === "enabled"
                    ? <span className="text-primary text-xs">{sortDir === "desc" ? "\u25bc" : "\u25b2"}</span>
                    : <span className="opacity-30 text-xs">{"\u2195"}</span>}
                </span>
              </th>
              <th className="px-4 py-3 font-medium">{"\u5173\u8054 KOL"}</th>
              <th className="px-4 py-3 font-medium">{"\u5173\u8054\u9891\u9053"}</th>
              <th className="px-4 py-3 font-medium text-center">{"\u89e3\u6790\u5168\u90e8"}</th>
              <th className="px-4 py-3 font-medium text-right">{"\u64cd\u4f5c"}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">{"\u52a0\u8f7d\u4e2d\u2026"}</td></tr>
            )}
            {!loading && channels.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">{"\u6682\u65e0\u9891\u9053\uff0c\u70b9\u51fb\u53f3\u4e0a\u89d2\u6dfb\u52a0"}</td></tr>
            )}
            {displayChannels.map((ch) => (
              <tr key={ch.id} className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-4 py-3 font-medium">{ch.label}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {ch.group
                    ? <span className="rounded bg-muted px-2 py-0.5 text-foreground">{ch.group}</span>
                    : <span className="text-muted-foreground">&mdash;</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ch.id}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ch.guildId}</td>
                <td className="px-4 py-3 text-center">
                  <Toggle enabled={ch.enabled} onToggle={() => void handleToggle(ch)} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {ch.kolIds.length === 0 && <span className="text-xs text-muted-foreground">{"\u65e0\u9650\u5236"}</span>}
                    {ch.kolIds.map((kid) => (
                      <span key={kid} className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {kolMap.get(kid) ?? kid}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(!ch.linkedChannelIds || ch.linkedChannelIds.length === 0) && (
                      <span className="text-xs text-muted-foreground">&mdash;</span>
                    )}
                    {(ch.linkedChannelIds ?? []).map((lid) => (
                      <span key={lid} className="inline-flex items-center rounded-md bg-secondary/60 px-2 py-0.5 text-xs font-medium text-foreground">
                        {channelMap.get(lid) ?? lid}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  {ch.parseAllMessages
                    ? <span className="text-success text-xs font-medium">{"\u662f"}</span>
                    : <span className="text-muted-foreground text-xs">{"\u5426"}</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEditing(ch); setShowModal(true); }}
                    className="mr-2 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">{"\u7f16\u8f91"}</button>
                  <button onClick={() => void handleDelete(ch.id)}
                    className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10">{"\u5220\u9664"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? "\u7f16\u8f91\u9891\u9053" : "\u6dfb\u52a0\u9891\u9053"}>
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
  const [linkedChannels, setLinkedChannels] = useState<Set<string>>(new Set(initial?.linkedChannelIds ?? []));
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

  function toggleLinkedChannel(chId: string) {
    setLinkedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(chId)) next.delete(chId); else next.add(chId);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      id, guildId, label,
      group: group.trim() || undefined,
      enabled,
      kolIds: [...selectedKols],
      parseAllMessages: parseAll,
      linkedChannelIds: [...linkedChannels],
      notes: notes || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{"\u9891\u9053\u540d\u79f0"}</label>
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder={"\u4f8b: #alpha-calls"} required />
        </div>
        <div>
          <label className={labelClass}>{"\u5206\u7ec4"}</label>
          <GroupCombobox value={group} onChange={setGroup} options={existingGroups} placeholder={"\u4f8b: WWG\u4ea4\u6613\u5458\uff08\u53ef\u7559\u7a7a\uff09"} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Channel ID</label>
          <input className={inputClass} value={id} onChange={(e) => setId(e.target.value)}
            placeholder={"Discord \u9891\u9053 ID"} required disabled={!!initial} />
        </div>
        <div>
          <label className={labelClass}>Guild (Server) ID</label>
          <input className={inputClass} value={guildId} onChange={(e) => setGuildId(e.target.value)}
            placeholder={"Discord \u670d\u52a1\u5668 ID"} required />
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <Toggle enabled={enabled} onToggle={() => setEnabled(!enabled)} />
          <span className="text-sm text-foreground">{"\u542f\u7528\u76d1\u542c"}</span>
        </div>
        <div className="flex items-center gap-3">
          <Toggle enabled={parseAll} onToggle={() => setParseAll(!parseAll)} />
          <span className="text-sm text-foreground">{"\u89e3\u6790\u6240\u6709\u6d88\u606f"}</span>
        </div>
      </div>

      <div>
        <label className={labelClass}>{"\u5173\u8054 KOL\uff08\u4ec5\u89e3\u6790\u8fd9\u4e9b\u7528\u6237\u7684\u6d88\u606f\uff09"}</label>
        {kols.length === 0 ? (
          <p className="text-xs text-muted-foreground">{"\u6682\u65e0 KOL\uff0c\u8bf7\u5148\u5728 KOL \u7ba1\u7406\u9875\u9762\u6dfb\u52a0"}</p>
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
        {parseAll && <p className="mt-1 text-xs text-muted-foreground">{"\u300c\u89e3\u6790\u6240\u6709\u6d88\u606f\u300d\u5df2\u5f00\u542f\uff0cKOL \u5173\u8054\u4ec5\u4f5c\u4e3a\u8f85\u52a9\u6807\u8bb0"}</p>}
      </div>

      <div>
        <label className={labelClass}>{"\u5173\u8054\u9891\u9053\uff08\u5408\u5e76\u663e\u793a\u8fd9\u4e9b\u9891\u9053\u7684\u6d88\u606f\uff09"}</label>
        {allChannels.filter((c) => c.id !== id).length === 0 ? (
          <p className="text-xs text-muted-foreground">{"\u6682\u65e0\u5176\u4ed6\u9891\u9053\u53ef\u5173\u8054"}</p>
        ) : (
          <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted p-2">
            {allChannels.filter((c) => c.id !== id).map((ch) => (
              <label key={ch.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-card">
                <input type="checkbox" checked={linkedChannels.has(ch.id)} onChange={() => toggleLinkedChannel(ch.id)}
                  className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary" />
                <span className="text-sm">{ch.label}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{ch.id}</span>
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{"\u9009\u4e2d\u540e\uff0c\u5728\u6d88\u606f\u9875\u9762\u67e5\u770b\u8be5\u9891\u9053\u65f6\u4f1a\u5408\u5e76\u663e\u793a\u5173\u8054\u9891\u9053\u7684\u6d88\u606f"}</p>
      </div>

      <div>
        <label className={labelClass}>{"\u5907\u6ce8"}</label>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={"\u53ef\u9009\u5907\u6ce8\u4fe1\u606f"} />
      </div>

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <button type="button" onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">{"\u53d6\u6d88"}</button>
        <button type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
          {initial ? "\u4fdd\u5b58\u66f4\u6539" : "\u6dfb\u52a0"}
        </button>
      </div>
    </form>
  );
}
