import type {
  KolConfig,
  ChannelConfig,
  RawDiscordMessage,
} from "../../shared/types";

// ==================== Generic fetch wrapper ====================

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `HTTP ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ==================== KOL API ====================

export type CreateKol = Omit<KolConfig, "addedAt">;
export type UpdateKol = Partial<Omit<KolConfig, "id" | "addedAt">>;

export const kolApi = {
  list: () => api<KolConfig[]>("/kols"),
  create: (data: CreateKol) =>
    api<KolConfig>("/kols", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdateKol) =>
    api<KolConfig>(`/kols/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  remove: (id: string) => api<void>(`/kols/${id}`, { method: "DELETE" }),
  uploadAvatar: async (id: string, file: File): Promise<KolConfig> => {
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch(`/api/kols/${id}/avatar`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    return res.json() as Promise<KolConfig>;
  },
  avatarUrl: (id: string) => `/api/kols/${id}/avatar`,
};

// ==================== Channel API ====================

export type CreateChannel = Omit<ChannelConfig, "addedAt">;
export type UpdateChannel = Partial<Omit<ChannelConfig, "id" | "addedAt">>;

export const channelApi = {
  list: () => api<ChannelConfig[]>("/channels"),
  create: (data: CreateChannel) =>
    api<ChannelConfig>("/channels", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: string, data: UpdateChannel) =>
    api<ChannelConfig>(`/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  remove: (id: string) => api<void>(`/channels/${id}`, { method: "DELETE" }),
};

// ==================== Message API ====================

export const messageApi = {
  list: (channelId?: string, limit = 200) => {
    const params = new URLSearchParams();
    if (channelId) params.set("channelId", channelId);
    params.set("limit", String(limit));
    return api<RawDiscordMessage[]>(`/messages?${params}`);
  },
  channels: () => api<string[]>("/messages/channels"),
};

// ==================== Discord API ====================

export interface DiscordStatus {
  status: string;
  username?: string;
  monitoredChannels?: number;
  enabledKols?: number;
  messageCount?: number;
  lastError?: string;
  message?: string;
}

export const discordApi = {
  status: () =>
    fetch("/api/discord/status")
      .then((r) => r.json() as Promise<DiscordStatus>)
      .catch(() => ({ status: "unreachable" }) as DiscordStatus),
  reload: () => api<{ ok: boolean }>("/discord/reload", { method: "POST" }),
};
