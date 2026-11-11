import type { Env } from "./types";

/**
 * 上游健康度与熔断。
 *
 * 设计要点：
 * 1. 记录粒度到 provider + model，不因一个模型失败就把整个提供商拉黑；
 * 2. 指数退避 + 半开探测，避免「刚恢复又被一次抖动拉黑」；
 * 3. 区分可重试与不可重试，参数错误不参与无限重试（省钱也省额度）。
 */

export type FailureKind =
  | "rate_limit"
  | "quota_exhausted"
  | "auth"
  | "timeout"
  | "upstream_5xx"
  | "network"
  | "bad_request"
  | "unknown";

export interface HealthState {
  failures: number;
  successStreak: number;
  openUntil: number;
  lastError?: string;
  lastStatus?: number;
  lastKind?: FailureKind;
  updatedAt: number;
}

export interface HealthSnapshot extends HealthState {
  available: boolean;
  cooldownRemainingMs: number;
  halfOpen: boolean;
}

const PREFIX = "health:v1:";
const BASE_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
/** 半开窗口：冷却结束后放少量请求试水 */
const HALF_OPEN_WINDOW_MS = 30_000;
const MEMO_TTL_MS = 3_000;

/**
 * 内存快路径：按 Env 实例隔离。
 * 用 WeakMap 而不是模块级 Map，避免同一 isolate 内不同 Env/测试实例互相串用熔断状态。
 */
type MemoBucket = Map<string, { state: HealthState; expiresAt: number }>;
const memoStore = new WeakMap<object, MemoBucket>();

function memoOf(env: Env): MemoBucket {
  let bucket = memoStore.get(env as unknown as object);
  if (!bucket) {
    bucket = new Map();
    memoStore.set(env as unknown as object, bucket);
  }
  return bucket;
}

export function healthKey(providerId: string, model?: string): string {
  return `${PREFIX}${providerId}${model ? `:${model}` : ""}`;
}

export function emptyHealth(now = Date.now()): HealthState {
  return { failures: 0, successStreak: 0, openUntil: 0, updatedAt: now };
}

/** 是否值得重试 */
export function isRetryable(kind: FailureKind): boolean {
  return kind === "rate_limit" || kind === "timeout" || kind === "upstream_5xx" || kind === "network" || kind === "unknown";
}

/** 是否应立即把该通道切走 */
export function shouldFailover(kind: FailureKind): boolean {
  return kind !== "bad_request";
}

/** 把 HTTP 状态与错误文案归类 */
export function classifyStatus(status: number, message?: string): FailureKind {
  const text = (message || "").toLowerCase();
  if (status === 429) {
    return /quota|exceeded|insufficient|balance|额度|余额/.test(text) ? "quota_exhausted" : "rate_limit";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504 || status === 524) return "timeout";
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "bad_request";
  if (/timeout|timed out|abort/.test(text)) return "timeout";
  if (/network|fetch failed|econnreset|enotfound/.test(text)) return "network";
  return "unknown";
}

function backoffMs(failures: number): number {
  const exp = Math.min(Math.max(failures, 1), 6);
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (exp - 1));
}

export function snapshot(state: HealthState, now = Date.now()): HealthSnapshot {
  const cooldownRemainingMs = Math.max(0, state.openUntil - now);
  return {
    ...state,
    available: cooldownRemainingMs === 0,
    cooldownRemainingMs,
    halfOpen: cooldownRemainingMs === 0 && state.failures > 0 && now - state.openUntil < HALF_OPEN_WINDOW_MS,
  };
}

async function read(env: Env, key: string, now: number): Promise<HealthState> {
  const memo = memoOf(env);
  const cached = memo.get(key);
  if (cached && cached.expiresAt > now) return cached.state;
  const raw = await env.CONFIG.get<HealthState>(key, "json");
  const state = raw ? { ...emptyHealth(now), ...raw } : emptyHealth(now);
  memo.set(key, { state, expiresAt: now + MEMO_TTL_MS });
  return state;
}

async function write(env: Env, key: string, state: HealthState): Promise<void> {
  memoOf(env).set(key, { state, expiresAt: state.updatedAt + MEMO_TTL_MS });
  await env.CONFIG.put(key, JSON.stringify(state), { expirationTtl: 86_400 });
}

export async function getHealth(env: Env, providerId: string, model?: string, now = Date.now()): Promise<HealthSnapshot> {
  return snapshot(await read(env, healthKey(providerId, model), now), now);
}

export async function recordSuccess(env: Env, providerId: string, model?: string, now = Date.now()): Promise<HealthSnapshot> {
  const key = healthKey(providerId, model);
  const state = await read(env, key, now);
  const next: HealthState = { failures: 0, successStreak: state.successStreak + 1, openUntil: 0, updatedAt: now };
  await write(env, key, next);
  return snapshot(next, now);
}

export async function recordFailure(
  env: Env,
  providerId: string,
  kind: FailureKind,
  options: { model?: string; status?: number; message?: string; now?: number } = {},
): Promise<HealthSnapshot> {
  const now = options.now ?? Date.now();
  const key = healthKey(providerId, options.model);
  const state = await read(env, key, now);
  const failures = state.failures + 1;
  // 配额耗尽单独给更长冷却，避免撞墙式重试
  const cooldown = kind === "quota_exhausted" ? Math.max(60_000, backoffMs(failures)) : backoffMs(failures);
  const next: HealthState = {
    failures,
    successStreak: 0,
    openUntil: now + cooldown,
    lastError: options.message?.slice(0, 300),
    lastStatus: options.status,
    lastKind: kind,
    updatedAt: now,
  };
  await write(env, key, next);
  return snapshot(next, now);
}

/** 手动恢复（管理端一键解除熔断） */
export async function resetHealth(env: Env, providerId: string, model?: string): Promise<void> {
  const key = healthKey(providerId, model);
  memoOf(env).delete(key);
  await env.CONFIG.delete(key);
}

export async function listHealth(
  env: Env,
  providerIds: string[],
  now: number = Date.now(),
): Promise<Array<HealthSnapshot & { providerId: string }>> {
  const out: Array<HealthSnapshot & { providerId: string }> = [];
  for (const providerId of providerIds) {
    out.push({ ...snapshot(await read(env, healthKey(providerId), now), now), providerId });
  }
  return out;
}
