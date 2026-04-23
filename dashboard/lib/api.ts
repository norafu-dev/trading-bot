import type {
  KolConfig,
  ChannelConfig,
  RawDiscordMessage,
  TradingAccountConfig,
  BrokerTypeInfo,
  BrokerConfigField,
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
  list: (channelIds?: string | string[], limit = 200) => {
    const params = new URLSearchParams();
    if (channelIds) {
      const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
      if (ids.length > 0) params.set("channelId", ids.join(","));
    }
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
  export: (params: {
    channelIds: string[];
    authorIds: string[];
    dateFrom: string;
    dateTo: string;
    limit?: number;
  }) =>
    api<ExportResult>("/discord/export", {
      method: "POST",
      body: JSON.stringify(params),
    }),
};

// ==================== Trading Config API ====================

export interface TestConnectionResult {
  success: boolean;
  error?: string;
  account?: unknown;
}

export const tradingConfigApi = {
  getBrokerTypes: () =>
    api<{ brokerTypes: BrokerTypeInfo[] }>("/trading/config/broker-types"),
  getCcxtExchanges: () =>
    api<{ exchanges: string[] }>("/trading/config/ccxt/exchanges"),
  getCcxtCredentialFields: (exchange: string) =>
    api<{ fields: BrokerConfigField[] }>(
      `/trading/config/ccxt/exchanges/${encodeURIComponent(exchange)}/credentials`,
    ),
  listAccounts: () =>
    api<{ accounts: TradingAccountConfig[] }>("/trading/config"),
  upsertAccount: (account: TradingAccountConfig) =>
    api<TradingAccountConfig>(`/trading/config/accounts/${account.id}`, {
      method: "PUT",
      body: JSON.stringify(account),
    }),
  deleteAccount: (id: string) =>
    api<{ success: boolean }>(`/trading/config/accounts/${id}`, {
      method: "DELETE",
    }),
  testConnection: (account: TradingAccountConfig) =>
    api<TestConnectionResult>("/trading/config/test-connection", {
      method: "POST",
      body: JSON.stringify(account),
    }),
};

export interface ExportRecord {
  messageId: string;
  channelId: string;
  authorId: string;
  authorUsername: string;
  timestamp: string;
  text: string;
  images: string[];
  rawContent: string;
  hasEmbeds: boolean;
}

export interface ExportResult {
  ok: boolean;
  channelIds: string[];
  dateFrom: string;
  dateTo: string;
  total: number;
  messages: ExportRecord[];
}
