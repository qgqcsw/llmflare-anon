import type { Env, Provider, RouteGroup, RouteMember, RoutingMode } from "./types";
import { enabledProviderModels, internalModelId, providerAuthMode } from "./providers";
import { classifyStatus, getHealth, recordFailure, recordSuccess, shouldFailover, isRetryable, type FailureKind } from "./health";
import { commitQuota, hasQuota, peekQuota, releaseQuota, reserveQuota } from "./quota";
import { isFreeModel } from "./free-models";

/**
 * 路由组与故障转移（借鉴 magpie 的 group + 多模式调度）。
 *
 * magpie 的 smart / order / rotate / usage / pace 全部落地，
 * 并补两项更贴免费场景的 free-first / cheapest。
 */

export const ROUTING_MODES: RoutingMode[] = ["smart", "order", "rotate", "usage", "pace", "free-first", "cheapest"];

export const ROUTING_MODE_LABELS: Record<RoutingMode, string> = {
  smart: "智能（免费优先 + 额度宽裕 + 权重）",
  order: "按配置顺序",
  rotate: "轮询",
  usage: "按本月用量最少",
  pace: "按剩余额度最宽裕",
  "free-first": "免费优先",
  cheapest: "按成本最低",
};

export interface RouteBudget {
  usedTokens: number;
  limitTokens?: number;
  /** 已用比例 0..1，未配置额度视为 0（最宽裕） */
  ratio: number;
  retryAfterMs: number;
}

export interface RouteTarget {
  provider: Provider;
  model: string;
  free: boolean;
  reason: string;
  budget: RouteBudget;
}

export interface RouteSkipped {
  member: RouteMember;
  providerName?: string;
  reason: string;
}

export interface RouteDecision {
  group: RouteGroup;
  attempts: RouteTarget[];
  skipped: RouteSkipped[];
}

export interface RouteContext {
  env: Env;
  providers: Provider[];
  now?: number;
  rotateCursor?: Record<string, number>;
  /** 客户端显式指定的模型；给出时成员必须支持它，否则跳过 */
  requestedModel?: string;
}

export function makeGroup(input: Partial<RouteGroup> & { id: string; name: string; members: RouteMember[] }): RouteGroup {
  return {
    enabled: input.enabled !== false,
    mode: input.mode && ROUTING_MODES.includes(input.mode) ? input.mode : "smart",
    maxAttempts: input.maxAttempts && input.maxAttempts >= 1 ? Math.min(10, Math.floor(input.maxAttempts)) : 3,
    firstByteTimeoutMs: input.firstByteTimeoutMs && input.firstByteTimeoutMs >= 1000 ? Math.floor(input.firstByteTimeoutMs) : 30_000,
    freeOnly: input.freeOnly === true,
    ...input,
  } as RouteGroup;
}

/** 解析成员对应的具体模型（受 enabledModels 约束） */
export function resolveMemberModel(provider: Provider, member: RouteMember): string | null {
  const enabled = enabledProviderModels(provider);
  if (member.model) {
    const internal = internalModelId(provider, member.model);
    return internal && enabled.includes(internal) ? internal : null;
  }
  if (provider.defaultModel && enabled.includes(provider.defaultModel)) return provider.defaultModel;
  return enabled[0] || null;
}

/** 成本档位：免费 0，匿名 1，Workers AI 2，自带 Key 3 */
function costTier(provider: Provider, free: boolean): number {
  if (free) return 0;
  if (providerAuthMode(provider) === "none") return 1;
  if (provider.type === "workers-ai") return 2;
  return 3;
}

/**
 * 选出本次请求的候选序列。
 * 过滤顺序：存在 → 启用 → 模型可用 → freeOnly → 熔断 → 额度 → 排序 → 截断。
 */
export async function planRoute(ctx: RouteContext, group: RouteGroup): Promise<RouteDecision> {
  const now = ctx.now ?? Date.now();
  const skipped: RouteSkipped[] = [];
  const candidates: RouteTarget[] = [];

  for (const member of group.members) {
    const provider = ctx.providers.find((item) => item.id === member.providerId);
    if (!provider) {
      skipped.push({ member, reason: "提供商不存在" });
      continue;
    }
    if (!provider.enabled) {
      skipped.push({ member, providerName: provider.name, reason: "提供商已停用" });
      continue;
    }
    let model: string | null;
    if (ctx.requestedModel) {
      const internal = internalModelId(provider, ctx.requestedModel);
      model = internal && enabledProviderModels(provider).includes(internal) ? internal : null;
      if (!model) {
        skipped.push({ member, providerName: provider.name, reason: `该提供商未启用模型 ${ctx.requestedModel}` });
        continue;
      }
    } else {
      model = resolveMemberModel(provider, member);
      if (!model) {
        skipped.push({ member, providerName: provider.name, reason: "模型未启用或已不存在" });
        continue;
      }
    }
    const free = isFreeModel(provider, model);
    if (group.freeOnly && !free) {
      skipped.push({ member, providerName: provider.name, reason: "组设置为仅免费模型" });
      continue;
    }

    // 提供商级熔断（如整体 429/套餐耗尽）与其模型级记录都要看，取更严格的一方
    const [modelHealth, providerHealth] = await Promise.all([
      getHealth(ctx.env, provider.id, model, now),
      model ? getHealth(ctx.env, provider.id, undefined, now) : Promise.resolve(null),
    ]);
    const health = !modelHealth.available ? modelHealth : providerHealth && !providerHealth.available ? providerHealth : modelHealth;
    if (!health.available) {
      const seconds = Math.ceil(health.cooldownRemainingMs / 1000);
      skipped.push({
        member,
        providerName: provider.name,
        reason: `熔断中（${seconds}s，${health.lastKind || "unknown"}）`,
      });
      continue;
    }

    let budget: RouteBudget = { usedTokens: 0, limitTokens: undefined, ratio: 0, retryAfterMs: 0 };
    if (hasQuota(provider.quota)) {
      const quota = await peekQuota(ctx.env, "provider", provider.id, provider.quota!, now);
      if (quota.exhaustedBy) {
        skipped.push({
          member,
          providerName: provider.name,
          reason: `额度耗尽（${quota.exhaustedBy}，${Math.ceil(quota.retryAfterMs / 1000)}s 后重置）`,
        });
        continue;
      }
      budget = {
        usedTokens: quota.monthTokens,
        limitTokens: quota.monthTokenLimit,
        ratio: quota.ratio,
        retryAfterMs: quota.retryAfterMs,
      };
    }

    candidates.push({
      provider,
      model,
      free,
      reason: free ? "免费模型" : `按需付费（成本档位 ${costTier(provider, free)}）`,
      budget,
    });
  }

  const ordered = applyMode(group, candidates, ctx);
  return { group, attempts: ordered.slice(0, Math.max(1, group.maxAttempts)), skipped };
}

function applyMode(group: RouteGroup, candidates: RouteTarget[], ctx: RouteContext): RouteTarget[] {
  const list = [...candidates];
  if (!list.length) return list;
  const orderOf = (target: RouteTarget) =>
    group.members.findIndex((member) => member.providerId === target.provider.id);
  const weightOf = (target: RouteTarget) =>
    group.members.find((member) => member.providerId === target.provider.id)?.weight ?? 0;

  switch (group.mode) {
    case "order":
      return list.sort((a, b) => orderOf(a) - orderOf(b));

    case "rotate": {
      const cursor = ctx.rotateCursor?.[group.id] ?? 0;
      const start = ((cursor % list.length) + list.length) % list.length;
      return [...list.slice(start), ...list.slice(0, start)];
    }

    case "usage":
      return list.sort((a, b) => a.budget.usedTokens - b.budget.usedTokens || orderOf(a) - orderOf(b));

    case "pace":
      return list.sort(
        (a, b) => a.budget.ratio - b.budget.ratio || a.budget.retryAfterMs - b.budget.retryAfterMs || orderOf(a) - orderOf(b),
      );

    case "cheapest":
      return list.sort(
        (a, b) => costTier(a.provider, a.free) - costTier(b.provider, b.free) || orderOf(a) - orderOf(b),
      );

    case "free-first":
      return list.sort((a, b) => Number(b.free) - Number(a.free) || orderOf(a) - orderOf(b));

    case "smart":
    default:
      return list.sort(
        (a, b) =>
          Number(b.free) - Number(a.free) ||
          a.budget.ratio - b.budget.ratio ||
          weightOf(b) - weightOf(a) ||
          orderOf(a) - orderOf(b),
      );
  }
}

export interface AttemptOutcome {
  ok: boolean;
  status: number;
  kind?: FailureKind;
  message?: string;
  tokens?: number;
}

export interface FailoverAttempt {
  target: RouteTarget;
  outcome: AttemptOutcome;
}

export interface FailoverResult {
  target: RouteTarget;
  outcome: AttemptOutcome;
  /** 实际尝试过的通道（含失败） */
  tried: FailoverAttempt[];
}

/**
 * 依次尝试候选，失败即切换下一个。
 * 关键：预留额度失败绝不硬发请求（并发抢占时直接跳过）。
 */
export async function withFailover(
  decision: RouteDecision,
  run: (target: RouteTarget) => Promise<AttemptOutcome>,
  env: Env,
  clock: () => number = Date.now,
): Promise<FailoverResult | null> {
  const tried: FailoverAttempt[] = [];
  for (const target of decision.attempts) {
    if (!target) continue;
    const now = clock();
    const reservation = hasQuota(target.provider.quota)
      ? await reserveQuota(env, "provider", target.provider.id, target.provider.quota!, 0, now)
      : null;

    if (reservation && !reservation.ok) {
      tried.push({
        target,
        outcome: {
          ok: false,
          status: 429,
          kind: "quota_exhausted",
          message: `额度已被并发请求占用（${reservation.snapshot.exhaustedBy}），跳过`,
        },
      });
      continue;
    }

    let outcome: AttemptOutcome;
    try {
      outcome = await run(target);
    } catch (cause) {
      outcome = {
        ok: false,
        status: 0,
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    tried.push({ target, outcome });

    if (outcome.ok) {
      // 提供商级与模型级同时记成功：任一层恢复都代表通道可用
      await Promise.all([
        recordSuccess(env, target.provider.id, target.model, clock()),
        recordSuccess(env, target.provider.id, undefined, clock()),
      ]);
      if (reservation) await commitQuota(env, reservation, outcome.tokens || 0, clock());
      return { target, outcome, tried };
    }

    const kind = outcome.kind || "unknown";
    // 提供商级与模型级同时记失败：整体不可用时其余模型不必再各撞一次墙
    await Promise.all([
      recordFailure(env, target.provider.id, kind, {
        model: target.model,
        status: outcome.status,
        message: outcome.message,
        now: clock(),
      }),
      recordFailure(env, target.provider.id, kind, {
        status: outcome.status,
        message: outcome.message,
        now: clock(),
      }),
    ]);
    if (reservation) await releaseQuota(env, reservation, clock());

    if (!shouldFailover(kind) && !isRetryable(kind)) break;
  }
  if (!tried.length) return null;
  const last = tried[tried.length - 1];
  return { target: last.target, outcome: last.outcome, tried };
}

export { classifyStatus };
