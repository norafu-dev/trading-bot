"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RawDiscordMessage, ChannelConfig, KolConfig } from "@shared/types";
import { messageApi, channelApi, discordApi, kolApi, pipelineApi } from "@/lib/api";
import type { DiscordStatus } from "@/lib/api";

const CH_ORDER_KEY = "messages-channel-order";

function loadChOrder(): string[] | null {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(CH_ORDER_KEY) : null;
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch { return null; }
}

function applyChOrder(channels: ChannelConfig[], order: string[] | null): ChannelConfig[] {
  if (!order) return channels;
  const map = new Map(channels.map((c) => [c.id, c]));
  const sorted: ChannelConfig[] = [];
  for (const id of order) { const c = map.get(id); if (c) { sorted.push(c); map.delete(id); } }
  for (const c of map.values()) sorted.push(c);
  return sorted;
}

function authorColor(id: string): string {
  const colors = ["#5865F2","#57F287","#FEE75C","#EB459E","#ED4245","#3BA55C","#F47B67","#9B59B6"];
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) & 0xffff;
  return colors[n % colors.length];
}

/** Strip Discord mention tokens: <@ID> <@!ID> <@&ID> <#ID> <:emoji:ID> <a:emoji:ID> */
function stripMentions(text: string): string {
  return text
    .replace(/<@[!&]?\d+>/g, "")   // user / role mentions
    .replace(/<#\d+>/g, "")         // channel mentions
    .replace(/<a?:\w+:\d+>/g, "")   // custom emoji
    .trim();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `\u4eca\u5929 ${hhmm}`;
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `\u6628\u5929 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function groupMessages(msgs: RawDiscordMessage[]) {
  const groups: { author: string; authorId: string; messages: RawDiscordMessage[] }[] = [];
  for (const msg of msgs) {
    const last = groups[groups.length - 1];
    const sameAuthor = last && last.authorId === msg.authorId;
    const closeInTime = sameAuthor && last.messages.length > 0 &&
      new Date(msg.receivedAt).getTime() - new Date(last.messages[last.messages.length - 1].receivedAt).getTime() < 300_000;
    if (sameAuthor && closeInTime) { last.messages.push(msg); }
    else { groups.push({ author: msg.authorUsername, authorId: msg.authorId, messages: [msg] }); }
  }
  return groups;
}

/**
 * "Replay" button — feeds the listed messageIds back through the live
 * pipeline (pre-pipeline → aggregator → dispatcher → router) and force-flushes
 * the aggregator so results appear on /signals and /events immediately,
 * not after the 30s idle window. Hidden until the parent group is hovered to
 * keep production-style noise out of the feed.
 */
function ReplayButton({ messageIds }: { messageIds: string[] }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await pipelineApi.inject(messageIds);
      setFeedback(
        r.injected.length > 0
          ? `已注入 ${r.injected.length} 条 — 去 /signals 或 /events 看结果`
          : `没找到这 ${messageIds.length} 条消息（可能已从内存里淘汰）`,
      );
      setTimeout(() => setFeedback(null), 5000);
    } catch (e) {
      setFeedback(`失败：${(e as Error).message}`);
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setBusy(false);
    }
  }

  if (feedback) {
    return <span className="text-xs text-amber-400">{feedback}</span>;
  }

  return (
    <button
      onClick={() => void handleClick()}
      disabled={busy}
      className="ml-auto rounded-md border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground opacity-0 transition-all hover:border-primary/50 hover:bg-primary/10 hover:text-primary group-hover/replay:opacity-100 disabled:opacity-50"
      title={`重放这 ${messageIds.length} 条消息走解析管线`}
    >
      {busy ? "注入中…" : `↻ 重放${messageIds.length > 1 ? ` (${messageIds.length})` : ""}`}
    </button>
  );
}

function AuthorAvatar({ authorId, displayName, kol, size = 36 }: {
  authorId: string; displayName: string; kol: KolConfig | undefined; size?: number;
}) {
  const [imgError, setImgError] = useState(false);
  const hasAvatar = !!kol?.avatarPath && !imgError;
  return (
    <div className="shrink-0 rounded-full overflow-hidden flex items-center justify-center font-bold text-white"
      style={{ width: size, height: size, backgroundColor: hasAvatar ? "transparent" : authorColor(authorId), fontSize: size * 0.42 }}>
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={kolApi.avatarUrl(authorId)} alt={displayName} width={size} height={size}
          className="h-full w-full object-cover" onError={() => setImgError(true)} />
      ) : (
        displayName.charAt(0).toUpperCase()
      )}
    </div>
  );
}

export default function MessagesPage() {
  const [messages, setMessages] = useState<RawDiscordMessage[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [kols, setKols] = useState<KolConfig[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);
  const feedEnd = useRef<HTMLDivElement>(null);
  const shouldScroll = useRef(true);
  const dragChIdx = useRef<number | null>(null);
  const [dropChIdx, setDropChIdx] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      // Resolve linked channels for the selected channel (Option A: merged view)
      let channelIds: string | string[] | undefined = selectedChannel ?? undefined;
      if (selectedChannel) {
        const ch = channels.find((c) => c.id === selectedChannel);
        if (ch?.linkedChannelIds && ch.linkedChannelIds.length > 0) {
          channelIds = [selectedChannel, ...ch.linkedChannelIds];
        }
      }
      const msgs = await messageApi.list(channelIds);
      setMessages(msgs);
    } catch { /* offline */ }
  }, [selectedChannel, channels]);

  useEffect(() => {
    channelApi.list().then((list) => setChannels(applyChOrder(list, loadChOrder()))).catch(() => {});
    kolApi.list().then(setKols).catch(() => {});
    discordApi.status().then(setDiscordStatus);
  }, []);

  const handleChDragStart = useCallback((idx: number) => { dragChIdx.current = idx; }, []);
  const handleChDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragChIdx.current !== null && dragChIdx.current !== idx) setDropChIdx(idx);
  }, []);
  const handleChDrop = useCallback((idx: number) => {
    const from = dragChIdx.current;
    if (from === null || from === idx) return;
    setChannels((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(idx, 0, moved);
      localStorage.setItem(CH_ORDER_KEY, JSON.stringify(next.map((c) => c.id)));
      return next;
    });
    dragChIdx.current = null;
    setDropChIdx(null);
  }, []);
  const handleChDragEnd = useCallback(() => { dragChIdx.current = null; setDropChIdx(null); }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    // Jump straight to the bottom when new messages arrive while the user is
    // already near the bottom — no smooth animation. The 3-second poll would
    // make a long animation feel like the page is constantly drifting; an
    // instant jump matches what Discord and Telegram do natively.
    if (shouldScroll.current) feedEnd.current?.scrollIntoView({ behavior: "auto" });
  }, [messages]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    shouldScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function toggleGroup(name: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  const enabledChannels = channels.filter((c) => c.enabled);
  type Section = { name: string | null; items: ChannelConfig[] };
  const sectionMap = new Map<string | null, ChannelConfig[]>();
  for (const ch of enabledChannels) {
    const key = ch.group ?? null;
    if (!sectionMap.has(key)) sectionMap.set(key, []);
    sectionMap.get(key)!.push(ch);
  }
  const sections: Section[] = [];
  if (sectionMap.has(null)) sections.push({ name: null, items: sectionMap.get(null)! });
  for (const [name, items] of sectionMap) {
    if (name !== null) sections.push({ name, items });
  }

  const channelMap = new Map(channels.map((c) => [c.id, c]));
  const kolMap = new Map(kols.map((k) => [k.id, k]));
  const msgGroups = groupMessages(messages);

  // Show channel source badge when viewing "all" or a merged channel view
  const selectedCh = selectedChannel ? channelMap.get(selectedChannel) : null;
  const isMergedView = !selectedChannel || (selectedCh?.linkedChannelIds && selectedCh.linkedChannelIds.length > 0);

  const statusDot =
    discordStatus?.status === "connected" ? "bg-success" :
    discordStatus?.status === "connecting" ? "bg-yellow-500" : "bg-muted-foreground";
  const statusText =
    discordStatus?.status === "connected" ? "\u5df2\u8fde\u63a5" :
    discordStatus?.status === "connecting" ? "\u8fde\u63a5\u4e2d\u2026" : "\u672a\u8fde\u63a5";

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="flex w-52 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${statusDot}`} />
            <span className="text-muted-foreground">{statusText}</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          <button onClick={() => setSelectedChannel(null)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
              selectedChannel === null ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}>
            <span className="text-base leading-none">#</span>
            {"\u5168\u90e8\u9891\u9053"}
          </button>

          {sections.map((section) => {
            const isCollapsed = section.name ? collapsedGroups.has(section.name) : false;
            return (
              <div key={section.name ?? "__ungrouped__"} className="mt-2">
                {section.name && (
                  <button onClick={() => toggleGroup(section.name!)}
                    className="flex w-full items-center gap-1 px-2 py-1 text-left">
                    <svg className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                      fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                    </svg>
                    <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
                      {section.name}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {section.items.map((ch) => {
                      const flatIdx = enabledChannels.indexOf(ch);
                      return (
                        <button key={ch.id} draggable
                          onDragStart={() => handleChDragStart(flatIdx)}
                          onDragOver={(e) => handleChDragOver(e, flatIdx)}
                          onDrop={() => handleChDrop(flatIdx)}
                          onDragEnd={handleChDragEnd}
                          onClick={() => setSelectedChannel(ch.id)}
                          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                            selectedChannel === ch.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          } ${dropChIdx === flatIdx ? "ring-1 ring-primary/50" : ""}`}>
                          <span className="cursor-grab select-none opacity-30 text-xs">&#x283F;</span>
                          <span className="text-base leading-none">#</span>
                          {ch.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {messages.length} {"\u6761\u6d88\u606f"}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-6 py-5 bg-background" onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {"\u6682\u65e0\u6d88\u606f \u2014 \u8bf7\u5148\u5728\u300cKOL \u7ba1\u7406\u300d\u300c\u9891\u9053\u7ba1\u7406\u300d\u914d\u7f6e\u5e76\u5f00\u542f\u76d1\u542c"}
          </div>
        )}

        {msgGroups.map((group, gi) => {
          const kol = kolMap.get(group.authorId);
          const displayName = kol?.label ?? group.author;
          return (
            <div key={gi} className="group/replay mt-5 first:mt-0">
              <div className="flex items-start gap-3">
                <AuthorAvatar authorId={group.authorId} displayName={displayName} kol={kol} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold" style={{ color: authorColor(group.authorId) }}>{displayName}</span>
                    <span className="text-xs text-muted-foreground">{formatTime(group.messages[0].receivedAt)}</span>
                    {isMergedView && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {channelMap.get(group.messages[0].channelId)?.label ?? group.messages[0].channelId}
                      </span>
                    )}
                    <ReplayButton messageIds={group.messages.map((m) => m.messageId)} />
                  </div>

                  {group.messages.map((msg) => (
                    <div key={msg.messageId} className="mt-1">
                      {msg.reference && (
                        <div className="mb-1 flex items-start gap-1.5 pl-1">
                          <div className="mt-1 h-3 w-3 shrink-0 rounded-tl border-l-2 border-t-2 border-border" />
                          <div className="flex min-w-0 items-center gap-1.5 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {msg.reference.authorId && (
                              <span className="shrink-0 font-medium" style={{ color: authorColor(msg.reference.authorId) }}>
                                {kolMap.get(msg.reference.authorId)?.label ?? "\u672a\u77e5 KOL"}
                              </span>
                            )}
                            <span className="truncate max-w-xs">
                              {msg.reference.contentSnippet
                                ? msg.reference.contentSnippet
                                : msg.reference.hasAttachments ? "\ud83d\udcce \u56fe\u7247/\u9644\u4ef6" : "\uff08\u6d88\u606f\u5df2\u5220\u9664\uff09"}
                            </span>
                          </div>
                        </div>
                      )}

                      {(() => { const txt = stripMentions(msg.content); return txt ? (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{txt}</p>
                      ) : null; })()}

                      {msg.embeds.map((embed, ei) => (
                        <div key={ei} className="mt-1.5 max-w-lg rounded-lg border-l-4 border-primary bg-muted px-3 py-2.5">
                          {embed.title && <p className="text-sm font-semibold text-foreground">{embed.title}</p>}
                          {embed.description && <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">{embed.description}</p>}
                          {embed.fields.length > 0 && (
                            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                              {embed.fields.map((f, fi) => (
                                <div key={fi}>
                                  <p className="text-xs font-medium text-muted-foreground">{f.name}</p>
                                  <p className="text-sm text-foreground">{f.value}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          {embed.image && (
                            <a href={embed.image} target="_blank" rel="noreferrer" className="mt-2 block">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={embed.image} alt="embed image"
                                className="max-h-80 max-w-full rounded-md border border-border object-contain shadow-sm" />
                            </a>
                          )}
                          {embed.thumbnail && (
                            <a href={embed.thumbnail} target="_blank" rel="noreferrer" className="mt-2 block">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={embed.thumbnail} alt="thumbnail"
                                className="max-h-48 max-w-full rounded-md border border-border object-contain shadow-sm" />
                            </a>
                          )}
                        </div>
                      ))}

                      {msg.attachments?.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {msg.attachments.map((att, ai) => {
                            const isImage = att.contentType?.startsWith("image/") ||
                              /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name);
                            return isImage ? (
                              <a key={ai} href={att.url} target="_blank" rel="noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={att.url} alt={att.name}
                                  className="max-h-64 max-w-xs rounded-lg border border-border object-cover shadow-sm" />
                              </a>
                            ) : (
                              <a key={ai} href={att.url} target="_blank" rel="noreferrer"
                                className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors">
                                <span>??</span>
                                <span className="max-w-[200px] truncate">{att.name}</span>
                              </a>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={feedEnd} />
      </div>
    </div>
  );
}
