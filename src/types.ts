export type ProviderType =
  | "google"
  | "groq"
  | "nvidia"
  | "openrouter"
  | "siliconflow"
  | "zhipu"
  | "mistral"
  | "workers-ai"
  | "openai-compatible";

/**
 * 上游鉴权模式：
 * - bearer：向上游发送 Authorization: Bearer <apiKey>（默认，与原项目行为一致）
 * - none：完全匿名，不发送任何 Authorization 头，也不保存 API Key
 *
 * 该字段是可选字段。历史数据没有此字段时按 bearer 处理，无需数据迁移。
 */
export type ProviderAuthMode = "bearer" | "none";

/**
 * 提供商级额度策略（对齐上游免费额度，用于调度与故障转移）。
 * 全部字段可选：历史数据没有该字段时视为「无限制」，无需数据迁移。
 */
export interface QuotaPolicy {
  /** 每分钟请求数上限 */
  requestsPerMinute?: number;
  /** 每日请求数上限 */
  dailyRequests?: number;
  /** 每月 token 上限 */
  monthlyTokens?: number;
  /** 每月请求数上限 */
  monthlyRequests?: number;
}

/** 路由调度模式，参考 magpie 的分组策略并扩展两种免费场景 */
export type RoutingMode = "smart" | "order" | "rotate" | "usage" | "pace" | "free-first" | "cheapest";

export interface RouteMember {
  providerId: string;
  /** 留空表示使用该提供商的 defaultModel */
  model?: string;
  /** 手动权重，数值越大越优先（smart 模式的平局裁决） */
  weight?: number;
}

export interface RouteGroup {
  id: string;
  name: string;
  enabled: boolean;
  mode: RoutingMode;
  members: RouteMember[];
  /** 组内最多尝试多少个成员 */
  maxAttempts: number;
  /** 单成员首字节超时（毫秒） */
  firstByteTimeoutMs: number;
  /** 是否只允许免费模型 */
  freeOnly?: boolean;
}

export interface RouteStoreState {
  groups: RouteGroup[];
  defaultGroupId?: string;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  authMode?: ProviderAuthMode;
  apiKey?: string;
  baseUrl?: string;
  models: string[];
  freeModels?: string[];
  enabledModels?: string[];
  defaultModel?: string;
  /** 新增：额度策略，可选，缺失表示不限制 */
  quota?: QuotaPolicy;
}

export interface PublicProvider extends Omit<Provider, "apiKey"> { hasApiKey: boolean }

export interface ClientKey {
  id: string;
  name: string;
  hash: string;
  key?: string;
  prefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
  requestsPerMinute?: number;
  dailyRequestLimit?: number;
  monthlyTokenLimit?: number;
  maxOutputTokensPerRequest?: number;
}

export type Env = Cloudflare.Env;

export interface GatewayMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface GatewayRequest {
  model?: string;
  provider?: string;
  messages?: GatewayMessage[];
  input?: unknown;
  stream?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

export interface UsageEvent {
  clientKeyId: string;
  endpoint: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  model: string;
  status: number;
  startedAt: number;
  streaming: boolean;
  protocolAdapted: boolean;
}
