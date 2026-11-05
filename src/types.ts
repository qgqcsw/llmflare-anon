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
