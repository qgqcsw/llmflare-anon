import type { Env, Provider, QuotaPolicy } from "./types";

/**
 * 额度窗口调度（借鉴 magpie 的 quota 视图，落地在 Workers KV）。
 *
 * 三层窗口：分钟请求数 / 日请求数 / 月 token + 月请求数。
 * 三段式：reserve（先占坑）→ commit（按真实用量校正）→ release（失败回滚）。
 * 每个窗口都返回 retryAfterMs 与 exhaustedBy，供路由层决定跳过还是等待。
 */

export type QuotaScope = "provider" | "model";

export interface QuotaWindowSnapshot {
  minuteUsed: number;
  minuteLimit?: number;
  dayUsed: number;
  dayLimit?: number;
  monthTokens: number;
  monthTokenLimit?: number;
  monthRequests: number;
  monthRequestLimit?: number;
  /** 距下一个窗口释放还有多久 */
  retryAfterMs: number;
  /** 哪个窗口已耗尽 */
  exhaustedBy?: "minute" | "day" | "monthTokens" | "monthRequests";
  /** 已用比例 0..1（未配置额度视为 0） */
  ratio: number;
  resetAt: { minute: number; day: number; month: number };
}

export interface QuotaState {
  minuteStart: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
  monthKey: string;
  monthTokens: number;
  monthCount: number;
  updatedAt: number;
}

export interface QuotaReservation {
  key: string;
  id: string;
  tokens: number;
  ok: boolean;
  snapshot: QuotaWindowSnapshot;
}

const MINUTE = 60_000;
const PREFIX = "quota:v1:";

export function quotaKey(scope: QuotaScope, id: string): string {
  return `${PREFIX}${scope}:${id}`;
}

function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function monthKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function monthResetAt(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function dayResetAt(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function emptyState(now: number): QuotaState {
  return {
    minuteStart: now - (now % MINUTE),
    minuteCount: 0,
    dayKey: dayKeyOf(now),
    dayCount: 0,
    monthKey: monthKeyOf(now),
    monthTokens: 0,
    monthCount: 0,
    updatedAt: now,
  };
}

/** 就地滚动窗口：把过期计数器归零，无需定时任务 */
export function rollState(state: QuotaState, now: number): QuotaState {
  const next: QuotaState = { ...state };
  if (now - next.minuteStart >= MINUTE) {
    next.minuteStart = now - (now % MINUTE);
    next.minuteCount = 0;
  }
  const dayKey = dayKeyOf(now);
  if (next.dayKey !== dayKey) {
    next.dayKey = dayKey;
    next.dayCount = 0;
  }
  const monthKey = monthKeyOf(now);
  if (next.monthKey !== monthKey) {
    next.monthKey = monthKey;
    next.monthTokens = 0;
    next.monthCount = 0;
  }
  return next;
}

export function snapshotOf(state: QuotaState, policy: QuotaPolicy, now: number): QuotaWindowSnapshot {
  const minuteLeft = policy.requestsPerMinute === undefined ? undefined : policy.requestsPerMinute - state.minuteCount;
  const dayLeft = policy.dailyRequests === undefined ? undefined : policy.dailyRequests - state.dayCount;
  const tokenLeft = policy.monthlyTokens === undefined ? undefined : policy.monthlyTokens - state.monthTokens;
  const requestLeft = policy.monthlyRequests === undefined ? undefined : policy.monthlyRequests - state.monthCount;

  let exhaustedBy: QuotaWindowSnapshot["exhaustedBy"];
  let retryAfterMs = 0;
  if (minuteLeft !== undefined && minuteLeft <= 0) {
    exhaustedBy = "minute";
    retryAfterMs = Math.max(0, state.minuteStart + MINUTE - now);
  } else if (dayLeft !== undefined && dayLeft <= 0) {
    exhaustedBy = "day";
    retryAfterMs = Math.max(0, dayResetAt(now) - now);
  } else if (tokenLeft !== undefined && tokenLeft <= 0) {
    exhaustedBy = "monthTokens";
    retryAfterMs = Math.max(0, monthResetAt(now) - now);
  } else if (requestLeft !== undefined && requestLeft <= 0) {
    exhaustedBy = "monthRequests";
    retryAfterMs = Math.max(0, monthResetAt(now) - now);
  }

  const ratio = policy.monthlyTokens
    ? Math.min(1, state.monthTokens / policy.monthlyTokens)
    : policy.monthlyRequests
      ? Math.min(1, state.monthCount / policy.monthlyRequests)
      : 0;

  return {
    minuteUsed: state.minuteCount,
    minuteLimit: policy.requestsPerMinute,
    dayUsed: state.dayCount,
    dayLimit: policy.dailyRequests,
    monthTokens: state.monthTokens,
    monthTokenLimit: policy.monthlyTokens,
    monthRequests: state.monthCount,
    monthRequestLimit: policy.monthlyRequests,
    retryAfterMs,
    exhaustedBy,
    ratio,
    resetAt: { minute: state.minuteStart + MINUTE, day: dayResetAt(now), month: monthResetAt(now) },
  };
}

/** provider 是否配置了任一层额度 */
export function hasQuota(policy?: QuotaPolicy): boolean {
  return Boolean(policy && Object.keys(policy).length);
}

async function readState(env: Env, key: string, now: number): Promise<QuotaState> {
  const raw = await env.CONFIG.get<QuotaState>(key, "json");
  return rollState(raw || emptyState(now), now);
}

async function writeState(env: Env, key: string, state: QuotaState): Promise<void> {
  const ttl = Math.max(3600, Math.ceil((monthResetAt(state.updatedAt) - state.updatedAt) / 1000) + 3600);
  await env.CONFIG.put(key, JSON.stringify(state), { expirationTtl: ttl });
}

/** 只读：查询当前窗口用量 */
export async function peekQuota(
  env: Env,
  scope: QuotaScope,
  id: string,
  policy: QuotaPolicy,
  now = Date.now(),
): Promise<QuotaWindowSnapshot> {
  const state = await readState(env, quotaKey(scope, id), now);
  return snapshotOf(state, policy, now);
}

/** 预留额度：ok=true 才允许发起上游请求 */
export async function reserveQuota(
  env: Env,
  scope: QuotaScope,
  id: string,
  policy: QuotaPolicy,
  tokens = 0,
  now = Date.now(),
): Promise<QuotaReservation> {
  const key = quotaKey(scope, id);
  const current = await readState(env, key, now);
  const before = snapshotOf(current, policy, now);
  if (before.exhaustedBy) return { key, id, tokens, ok: false, snapshot: before };

  const next: QuotaState = {
    ...current,
    minuteCount: current.minuteCount + 1,
    dayCount: current.dayCount + 1,
    monthCount: current.monthCount + 1,
    monthTokens: current.monthTokens + Math.max(0, tokens),
    updatedAt: now,
  };
  await writeState(env, key, next);
  return { key, id, tokens: Math.max(0, tokens), ok: true, snapshot: snapshotOf(next, policy, now) };
}

/** 用真实用量校正预估（delta 可正可负） */
export async function commitQuota(
  env: Env,
  reservation: QuotaReservation,
  actualTokens: number,
  now = Date.now(),
): Promise<void> {
  const delta = Math.round(actualTokens - reservation.tokens);
  if (!delta) return;
  const state = await readState(env, reservation.key, now);
  await writeState(env, reservation.key, { ...state, monthTokens: Math.max(0, state.monthTokens + delta), updatedAt: now });
}

/** 失败回滚：归还本次占用的请求数与预估 token */
export async function releaseQuota(env: Env, reservation: QuotaReservation, now = Date.now()): Promise<void> {
  const state = await readState(env, reservation.key, now);
  await writeState(env, reservation.key, {
    ...state,
    minuteCount: Math.max(0, state.minuteCount - 1),
    dayCount: Math.max(0, state.dayCount - 1),
    monthCount: Math.max(0, state.monthCount - 1),
    monthTokens: Math.max(0, state.monthTokens - reservation.tokens),
    updatedAt: now,
  });
}

/** 粗估 token：中文 1 字≈1 token，英文 4 字符≈1 token */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** 规整请求体里的额度配置，非法字段丢弃 */
export function normalizeQuota(input: unknown): QuotaPolicy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const policy: QuotaPolicy = {};
  const keys: Array<keyof QuotaPolicy> = ["requestsPerMinute", "dailyRequests", "monthlyTokens", "monthlyRequests"];
  for (const field of keys) {
    const value = raw[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) policy[field] = Math.floor(value);
  }
  return Object.keys(policy).length ? policy : undefined;
}
