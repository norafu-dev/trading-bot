import type {
  KolConfig,
  ChannelConfig,
  RawDiscordMessage,
  TradingAccountConfig,
  BrokerTypeInfo,
  BrokerConfigField,
  AccountBalance,
  TradePosition,
  Signal,
  PositionUpdate,
  Operation,
  RiskConfig,
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

// ==================== Trading (balance / positions) API ====================

export interface AccountEquitySummary {
  id: string;
  label: string;
  exchange: string;
  equity: number;
  cash: number;
  usedMargin: number;
  unrealizedPnl: number;
  error: string | null;
}

export interface EquityResult {
  totalEquity: number;
  totalCash: number;
  totalUnrealizedPnl: number;
  accounts: AccountEquitySummary[];
}

export const tradingApi = {
  listAccounts: () =>
    api<{
      accounts: Array<{
        id: string;
        label: string;
        type: string;
        exchange: string | null;
      }>;
    }>("/trading/accounts"),
  getEquity: () => api<EquityResult>("/trading/equity"),
  getBalance: (id: string) => api<AccountBalance>(`/trading/accounts/${id}/balance`),
  getPositions: (id: string) =>
    api<{ positions: TradePosition[] }>(`/trading/accounts/${id}/positions`),
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

// ==================== Signals API ====================

/**
 * Discriminated record returned by `GET /api/signals`. Mirrors the on-disk
 * shape written by SignalStore — `kind` decides which downstream renderer
 * the dashboard uses.
 */
export type SignalRecord =
  | { kind: "signal"; record: Signal }
  | { kind: "update"; record: PositionUpdate };

export interface SignalListResult {
  records: SignalRecord[];
  total: number;
  limit: number;
}

export interface SignalDetailResult {
  signal: Signal;
  updates: PositionUpdate[];
}

export const signalApi = {
  list: (params?: { limit?: number; kolId?: string; since?: string }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.kolId) search.set("kolId", params.kolId);
    if (params?.since) search.set("since", params.since);
    const qs = search.toString();
    return api<SignalListResult>(`/signals${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api<SignalDetailResult>(`/signals/${id}`),
};

// ==================== Events API ====================

export interface EventEntry {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface EventListResult {
  entries: EventEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const eventApi = {
  list: (params?: { limit?: number; type?: string; page?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.type) search.set("type", params.type);
    if (params?.page) search.set("page", String(params.page));
    const qs = search.toString();
    return api<EventListResult>(`/events${qs ? `?${qs}` : ""}`);
  },
};

// ==================== LLM Config API ====================

export interface PublicLlmConfig {
  provider: "openrouter";
  baseUrl: string;
  classifyModel: string;
  extractModel: string;
  confidenceThreshold: number;
  apiKeyConfigured: boolean;
  apiKeyLast4: string;
}

export interface LlmConfigUpdate {
  apiKey?: string;
  baseUrl?: string;
  classifyModel?: string;
  extractModel?: string;
  confidenceThreshold?: number;
}

export type LlmTestResult =
  | {
      ok: true;
      model: string;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      note: string;
    }
  | { ok: false; error: string };

export const llmConfigApi = {
  get: () => api<PublicLlmConfig>("/config/llm"),
  update: (data: LlmConfigUpdate) =>
    api<PublicLlmConfig>("/config/llm", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  test: (data: LlmConfigUpdate) =>
    api<LlmTestResult>("/config/llm/test", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// ==================== Pipeline (dev tool) API ====================

export interface InjectResult {
  ok: boolean;
  injected: string[];
  missing: string[];
  message: string;
}

export const pipelineApi = {
  inject: (messageIds: string[]) =>
    api<InjectResult>("/pipeline/inject", {
      method: "POST",
      body: JSON.stringify({ messageIds }),
    }),
  flush: () => api<{ ok: boolean }>("/pipeline/flush", { method: "POST" }),
};

// ==================== Operations API ====================

export interface OperationListResult {
  operations: Operation[];
  total: number;
  limit: number;
}

export const operationApi = {
  list: (params?: { limit?: number; kolId?: string; status?: Operation["status"] }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.kolId) search.set("kolId", params.kolId);
    if (params?.status) search.set("status", params.status);
    const qs = search.toString();
    return api<OperationListResult>(`/operations${qs ? `?${qs}` : ""}`);
  },
};

// ==================== Risk Config API ====================

export const riskConfigApi = {
  get: () => api<RiskConfig>("/config/risk"),
  update: (data: Partial<RiskConfig>) =>
    api<RiskConfig>("/config/risk", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
};
