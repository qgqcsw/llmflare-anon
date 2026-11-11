import { describe, expect, it } from "vitest";
import type { Env, Provider, RouteGroup } from "../src/types";
import { classifyModel, isFreeModel } from "../src/free-models";
import { classifyStatus, isRetryable, shouldFailover, recordFailure, recordSuccess, getHealth, resetHealth } from "../src/health";
import { reserveQuota, releaseQuota, peekQuota, normalizeQuota, snapshotOf, emptyState } from "../src/quota";
import { planRoute, makeGroup } from "../src/routing";
import { normalizeGroup, getRouteStore, saveRouteStore, advanceRotateCursor, getRotateCursor } from "../src/route-store";

/** 内存版 KV，行为对齐 Workers KV 的 get/put/delete/list */
function makeEnv(): Env {
  const store = new Map<string, string>();
  const CONFIG = {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })) };
    },
  };
  return { CONFIG, USAGE: {} } as unknown as Env;
}

function makeProvider(input: Partial<Provider> & { id: string; name: string }): Provider {
  return {
    type: "openai-compatible",
    enabled: true,
    models: [],
    ...input,
  } as Provider;
}

describe("免费模型识别", () => {
  it("OpenRouter 的 :free 后缀由命名规则判为免费（推断级）", () => {
    const provider = makeProvider({ id: "p1", name: "OR", type: "openrouter" });
    const verdict = classifyModel(provider, "meta-llama/llama-3.1-8b-instruct:free");
    expect(verdict.free).toBe(true);
    expect(verdict.badge.tier).toBe("likely");
    expect(verdict.rules.find((rule) => rule.id === "naming")?.matched).toBe(true);
  });

  it("用户白名单命中时徽标为 declared", () => {
    const provider = makeProvider({ id: "p2", name: "P2", freeModels: ["my-model"] });
    const verdict = classifyModel(provider, "my-model");
    expect(verdict.free).toBe(true);
    expect(verdict.badge.tier).toBe("declared");
  });

  it("上游免费目录命中优先于命名推断", () => {
    const provider = makeProvider({ id: "p3", name: "P3", type: "openrouter" });
    const verdict = classifyModel(provider, "some/paid-model:free", { upstreamFreeModels: ["some/paid-model:free"] });
    expect(verdict.free).toBe(true);
    expect(verdict.rules.find((rule) => rule.id === "upstream")?.matched).toBe(true);
  });

  it("未命中任何规则时判为付费", () => {
    const provider = makeProvider({ id: "p4", name: "P4" });
    const verdict = classifyModel(provider, "gpt-4o");
    expect(verdict.free).toBe(false);
    expect(verdict.badge.tier).toBe("guess");
  });

  it("Gemini preview/exp 被排除规则挡掉", () => {
    const provider = makeProvider({ id: "p5", name: "G", type: "google" });
    expect(classifyModel(provider, "gemini-2.0-flash").free).toBe(true);
    expect(classifyModel(provider, "gemini-2.0-flash-exp").free).toBe(false);
  });

  it("isFreeModel 兼容带提供商名前缀的模型名", () => {
    const provider = makeProvider({ id: "p6", name: "Zhipu", type: "zhipu" });
    expect(isFreeModel(provider, "Zhipu/glm-4-flash")).toBe(true);
    expect(isFreeModel(provider, "glm-4-flash")).toBe(true);
  });
});

describe("状态码分类与退避", () => {
  it("区分限流与额度耗尽", () => {
    expect(classifyStatus(429)).toBe("rate_limit");
    expect(classifyStatus(429, "quota exceeded")).toBe("quota_exhausted");
  });

  it("参数错误不可重试，但会触发切换", () => {
    expect(classifyStatus(400)).toBe("bad_request");
    expect(isRetryable("bad_request")).toBe(false);
    expect(shouldFailover("bad_request")).toBe(false);
  });

  it("5xx 与超时可重试", () => {
    expect(classifyStatus(502)).toBe("upstream_5xx");
    expect(isRetryable("upstream_5xx")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
  });

  it("连续失败后熔断，成功后退避清零", async () => {
    const env = makeEnv();
    const now = 1_700_000_000_000;
    await recordFailure(env, "prov-a", "upstream_5xx", { now });
    const after = await getHealth(env, "prov-a", undefined, now);
    expect(after.available).toBe(false);
    expect(after.failures).toBe(1);
    await recordSuccess(env, "prov-a", undefined, now);
    const ok = await getHealth(env, "prov-a", undefined, now);
    expect(ok.available).toBe(true);
    expect(ok.failures).toBe(0);
  });

  it("手动重置可立即解除熔断", async () => {
    const env = makeEnv();
    const now = 1_700_000_000_000;
    await recordFailure(env, "prov-b", "timeout", { now });
    await resetHealth(env, "prov-b");
    const after = await getHealth(env, "prov-b", undefined, now);
    expect(after.available).toBe(true);
  });

  it("失败计数按指数增长冷却时间", async () => {
    const env = makeEnv();
    const now = 1_700_000_000_000;
    const first = await recordFailure(env, "prov-c", "upstream_5xx", { now });
    const second = await recordFailure(env, "prov-c", "upstream_5xx", { now });
    expect(second.cooldownRemainingMs).toBeGreaterThan(first.cooldownRemainingMs);
  });
});

describe("额度窗口", () => {
  it("预留成功会累加三个窗口", async () => {
    const env = makeEnv();
    const policy = { requestsPerMinute: 2, dailyRequests: 10, monthlyTokens: 1000 };
    const result = await reserveQuota(env, "provider", "p-q", policy, 50);
    expect(result.ok).toBe(true);
    const snap = await peekQuota(env, "provider", "p-q", policy);
    expect(snap.minuteUsed).toBe(1);
    expect(snap.dayUsed).toBe(1);
    expect(snap.monthTokens).toBe(50);
  });

  it("分钟额度用尽后拒绝预留", async () => {
    const env = makeEnv();
    const policy = { requestsPerMinute: 1 };
    expect((await reserveQuota(env, "provider", "p-r", policy)).ok).toBe(true);
    const second = await reserveQuota(env, "provider", "p-r", policy);
    expect(second.ok).toBe(false);
    expect(second.snapshot.exhaustedBy).toBe("minute");
    expect(second.snapshot.retryAfterMs).toBeGreaterThan(0);
  });

  it("失败回滚会归还请求数与 token", async () => {
    const env = makeEnv();
    const policy = { requestsPerMinute: 5, monthlyTokens: 1000 };
    const reservation = await reserveQuota(env, "provider", "p-s", policy, 80);
    await releaseQuota(env, reservation);
    const snap = await peekQuota(env, "provider", "p-s", policy);
    expect(snap.minuteUsed).toBe(0);
    expect(snap.monthTokens).toBe(0);
  });

  it("未配置额度时不产生窗口限制", () => {
    const snap = snapshotOf(emptyState(1_700_000_000_000), {}, 1_700_000_000_000);
    expect(snap.exhaustedBy).toBeUndefined();
    expect(snap.minuteLimit).toBeUndefined();
  });

  it("normalizeQuota 丢弃非法值", () => {
    expect(normalizeQuota({ requestsPerMinute: -5, dailyRequests: 100 })).toEqual({ dailyRequests: 100 });
    expect(normalizeQuota({})).toBeUndefined();
    expect(normalizeQuota(null)).toBeUndefined();
  });
});

describe("路由决策", () => {
  const providers: Provider[] = [
    makeProvider({ id: "a", name: "A", models: ["m1"], defaultModel: "m1" }),
    makeProvider({ id: "b", name: "B", type: "openrouter", models: ["m2:free"], defaultModel: "m2:free" }),
    makeProvider({ id: "c", name: "C", models: ["m3"], enabled: false }),
  ];

  const group: RouteGroup = makeGroup({
    id: "g1",
    name: "组一",
    members: [{ providerId: "a" }, { providerId: "b" }, { providerId: "c" }],
  });

  it("停用的提供商被跳过并给出原因", async () => {
    const env = makeEnv();
    const decision = await planRoute({ env, providers }, group);
    // smart 模式免费优先，所以 B（免费模型）排在 A 之前
    expect(decision.attempts.map((item) => item.provider.id).sort()).toEqual(["a", "b"]);
    expect(decision.skipped.some((item) => item.reason.includes("已停用"))).toBe(true);
  });

  it("free-first 把免费模型排到最前", async () => {
    const env = makeEnv();
    const decision = await planRoute({ env, providers }, { ...group, mode: "free-first" });
    expect(decision.attempts[0].free).toBe(true);
    expect(decision.attempts[0].provider.id).toBe("b");
  });

  it("freeOnly 过滤掉付费通道", async () => {
    const env = makeEnv();
    const decision = await planRoute({ env, providers }, { ...group, freeOnly: true });
    expect(decision.attempts.map((item) => item.provider.id)).toEqual(["b"]);
    expect(decision.skipped.some((item) => item.reason.includes("仅免费"))).toBe(true);
  });

  it("熔断中的通道不进入尝试序列", async () => {
    const env = makeEnv();
    await recordFailure(env, "a", "upstream_5xx", { now: Date.now() });
    const decision = await planRoute({ env, providers }, group);
    expect(decision.attempts.map((item) => item.provider.id)).toEqual(["b"]);
    expect(decision.skipped.some((item) => item.reason.includes("熔断"))).toBe(true);
  });

  it("额度耗尽的通道被跳过", async () => {
    const env = makeEnv();
    const limited = [
      makeProvider({ id: "a", name: "A", models: ["m1"], defaultModel: "m1", quota: { dailyRequests: 1 } }),
      providers[1],
    ];
    await reserveQuota(env, "provider", "a", { dailyRequests: 1 });
    const decision = await planRoute({ env, providers: limited }, group);
    expect(decision.attempts.map((item) => item.provider.id)).toEqual(["b"]);
    expect(decision.skipped.some((item) => item.reason.includes("额度耗尽"))).toBe(true);
  });

  it("maxAttempts 限制尝试数量", async () => {
    const env = makeEnv();
    const decision = await planRoute({ env, providers }, { ...group, maxAttempts: 1 });
    expect(decision.attempts).toHaveLength(1);
  });

  it("requestedModel 只保留支持该模型的成员", async () => {
    const env = makeEnv();
    const decision = await planRoute({ env, providers, requestedModel: "m2:free" }, group);
    expect(decision.attempts.map((item) => item.provider.id)).toEqual(["b"]);
    expect(decision.attempts[0].model).toBe("m2:free");
  });

  it("rotate 模式按游标轮转起点", async () => {
    const env = makeEnv();
    const base = await planRoute({ env, providers, rotateCursor: { g1: 0 } }, { ...group, mode: "rotate" });
    const shifted = await planRoute({ env, providers, rotateCursor: { g1: 1 } }, { ...group, mode: "rotate" });
    expect(base.attempts[0].provider.id).toBe("a");
    expect(shifted.attempts[0].provider.id).toBe("b");
  });
});

describe("路由组持久化", () => {
  it("normalizeGroup 拒绝缺少 id/name 的输入", () => {
    expect(normalizeGroup(null)).toBeNull();
    expect(normalizeGroup({ name: "x", members: [] })).toBeNull();
    expect(normalizeGroup({ id: "x", members: [] })).toBeNull();
  });

  it("normalizeGroup 去重成员并兜底默认值", () => {
    const group = normalizeGroup({
      id: "gx",
      name: "测试",
      members: [{ providerId: "a" }, { providerId: "a" }, { providerId: "b", model: "m" }],
      mode: "不存在的模式",
      maxAttempts: 999,
    });
    expect(group).not.toBeNull();
    expect(group!.members).toHaveLength(2);
    expect(group!.mode).toBe("smart");
    expect(group!.maxAttempts).toBe(3);
    expect(group!.firstByteTimeoutMs).toBe(30_000);
  });

  it("保存后能原样读回", async () => {
    const env = makeEnv();
    const state = {
      groups: [makeGroup({ id: "g1", name: "组一", members: [{ providerId: "a" }] })],
      defaultGroupId: "g1",
    };
    await saveRouteStore(env, state);
    const loaded = await getRouteStore(env);
    expect(loaded.groups).toHaveLength(1);
    expect(loaded.defaultGroupId).toBe("g1");
  });

  it("空存储返回空组列表而不是报错", async () => {
    const env = makeEnv();
    const loaded = await getRouteStore(env);
    expect(loaded.groups).toEqual([]);
  });

  it("轮转游标按组大小取模推进", async () => {
    const env = makeEnv();
    await advanceRotateCursor(env, ["g1"], 3);
    await advanceRotateCursor(env, ["g1"], 3);
    const cursor = await getRotateCursor(env);
    expect(cursor.g1).toBe(2);
  });
});
