import type { Provider } from "./types";

/**
 * 免费模型判定的可解释规则引擎。
 *
 * 与 src/providers.ts 中既有的 inferredProviderFreeModels 互补而非替代：
 * - providers.ts 负责「从上游目录里算出哪些免费」，是权威来源；
 * - 本文件负责把结论变成「可解释、可分级、可解释给用户看」的判定，
 *   并补上用户白名单、命名规则、实测探测三类额外证据。
 *
 * 全部纯函数，无 IO，便于单测与前端复用。
 */

export type FreeRuleId = "price" | "upstream" | "declared" | "probe" | "naming" | "whitelist";

export interface FreeRuleResult {
  id: FreeRuleId;
  /** 人类可读规则名，直接用于 UI */
  label: string;
  matched: boolean;
  /** 命中/未命中的具体证据 */
  detail?: string;
}

export type FreeBadgeTier = "verified" | "declared" | "likely" | "guess";

export interface FreeModelVerdict {
  providerId: string;
  model: string;
  free: boolean;
  /** 0..100，用于排序与「建议勾选」阈值 */
  confidence: number;
  /** 规则明细，命中的排在前面 */
  rules: FreeRuleResult[];
  /** 一句话主判定依据 */
  reason: string;
  badge: FreeBadge;
}

export interface FreeBadge {
  free: boolean;
  tier: FreeBadgeTier;
  label: string;
  confidence: number;
}

/** 上游权威免费清单（来自 providers.ts 的推断结果），进程内缓存 */
const upstreamFree = new Map<string, Set<string>>();

function norm(model: string): string {
  return model.replace(/^models\//, "").trim();
}

function key(model: string): string {
  return norm(model).toLowerCase();
}

/** 注册/更新某个提供商的上游免费清单（由模型发现流程调用） */
export function registerUpstreamFree(providerId: string, models: string[]): number {
  const set = new Set(models.map(key));
  upstreamFree.set(providerId, set);
  return set.size;
}

export function clearUpstreamFree(providerId?: string): void {
  if (providerId) upstreamFree.delete(providerId);
  else upstreamFree.clear();
}

export function getUpstreamFree(providerId: string): Set<string> {
  return upstreamFree.get(providerId) || new Set<string>();
}

/** 命名规则：仅作为「上游没给结论」时的兜底推断 */
const NAMING_RULES: Partial<Record<Provider["type"], { include: RegExp[]; exclude?: RegExp[]; detail: string }>> = {
  openrouter: { include: [/^openrouter\/free$/i, /:free$/i], detail: "模型 ID 带 :free 后缀（OpenRouter 官方免费路由）" },
  zhipu: {
    include: [/^glm-[\d.]+-flash/i, /^glm-4(?:\.\d)?v-flash/i, /^cogview-3-flash$/i, /^cogvideox-flash$/i],
    detail: "智谱 flash 系列为官方免费档",
  },
  google: { include: [/^gemini-[\d.]+-flash(?:-lite)?$/i], exclude: [/preview|exp/i], detail: "Gemini Flash 档位在免费配额内可用（有速率限制）" },
  groq: { include: [/^llama-[\d.]+-[\d.]+b-(?:instant|versatile)$/i, /^whisper/i, /^gemma2?-9b/i], detail: "Groq 免费档模型命名" },
  siliconflow: {
    include: [/^qwen\/qwen(?:2(?:\.5)?)?-[\d.]+b-instruct$/i, /^qwen\/qwen3-8b$/i, /^thudm\/glm-4-9b/i],
    exclude: [/^pro\//i],
    detail: "SiliconFlow 文档列明的免费小模型",
  },
  mistral: { include: [/^mistral-(?:small|tiny|nemo)/i, /^open-mistral/i], detail: "Mistral 免费实验档命名" },
};

const RULE_WEIGHT: Record<FreeRuleId, number> = {
  upstream: 98,
  declared: 96,
  probe: 92,
  price: 100,
  whitelist: 88,
  naming: 72,
};

const RULE_LABEL: Record<FreeRuleId, string> = {
  price: "价格为零",
  upstream: "上游目录判定",
  declared: "用户白名单",
  probe: "实测探测",
  naming: "命名规则",
  whitelist: "内置清单",
};

export interface ClassifyOptions {
  /** 实测探测结论，优先级仅次于价格 */
  probe?: { free: boolean; detail: string };
  /** 显式传入上游免费清单（缺省用进程内缓存） */
  upstreamFreeModels?: string[];
}

/** 判定单个模型，返回可解释规则明细与徽标 */
export function classifyModel(
  provider: Pick<Provider, "id" | "type" | "freeModels">,
  model: string,
  options: ClassifyOptions = {},
): FreeModelVerdict {
  const id = norm(model);
  const idKey = key(id);
  const rules: FreeRuleResult[] = [];

  const upstream = options.upstreamFreeModels
    ? new Set(options.upstreamFreeModels.map(key))
    : getUpstreamFree(provider.id);
  const upstreamHit = upstream.has(idKey);
  if (upstream.size || options.upstreamFreeModels) {
    rules.push({
      id: "upstream",
      label: RULE_LABEL.upstream,
      matched: upstreamHit,
      detail: upstreamHit ? "上游模型目录标注为零价格/免费档" : undefined,
    });
  }

  if (options.probe) {
    rules.push({
      id: "probe",
      label: RULE_LABEL.probe,
      matched: options.probe.free,
      detail: options.probe.detail,
    });
  }

  const declared = new Set((provider.freeModels || []).map(key));
  const declaredHit = declared.has(idKey);
  rules.push({
    id: "declared",
    label: RULE_LABEL.declared,
    matched: declaredHit,
    detail: declaredHit ? "已在提供商配置中声明为免费" : undefined,
  });

  const naming = NAMING_RULES[provider.type];
  if (naming) {
    const excluded = (naming.exclude || []).some((re) => re.test(id));
    const named = !excluded && naming.include.some((re) => re.test(id));
    rules.push({
      id: "naming",
      label: RULE_LABEL.naming,
      matched: named,
      detail: named ? naming.detail : excluded ? "命中排除规则（预览/实验/Pro 档）" : undefined,
    });
  }

  const matchedRules = rules.filter((rule) => rule.matched);
  const free = matchedRules.length > 0;
  const confidence = free ? Math.max(...matchedRules.map((rule) => RULE_WEIGHT[rule.id])) : 0;
  const ordered = [...rules].sort(
    (a, b) => Number(b.matched) - Number(a.matched) || RULE_WEIGHT[b.id] - RULE_WEIGHT[a.id],
  );

  const primary = ordered[0];
  return {
    providerId: provider.id,
    model: id,
    free,
    confidence,
    rules: ordered,
    reason: free ? primary.detail || primary.label : "未命中任何免费规则",
    badge: badgeOf(free, free ? primary.id : undefined, confidence),
  };
}

function badgeOf(free: boolean, ruleId: FreeRuleId | undefined, confidence: number): FreeBadge {
  if (!free || !ruleId) return { free: false, tier: "guess", label: "付费", confidence: 0 };
  const tier: FreeBadgeTier =
    ruleId === "price" || ruleId === "upstream" || ruleId === "probe"
      ? "verified"
      : ruleId === "declared"
        ? "declared"
        : ruleId === "whitelist" || ruleId === "naming"
          ? "likely"
          : "guess";
  const label = tier === "verified" ? "免费" : tier === "declared" ? "免费·白名单" : tier === "likely" ? "免费·推断" : "疑似免费";
  return { free: true, tier, label, confidence };
}

/** 批量判定某个提供商的模型列表 */
export function classifyProviderModels(
  provider: Pick<Provider, "id" | "type" | "freeModels">,
  models: string[],
  options: ClassifyOptions = {},
): FreeModelVerdict[] {
  return models.map((model) => classifyModel(provider, model, options));
}

/** 只取免费模型 ID（去重、保持原顺序） */
export function freeModelIds(
  provider: Pick<Provider, "id" | "type" | "freeModels">,
  models: string[],
  options: ClassifyOptions = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    const verdict = classifyModel(provider, model, options);
    const modelKey = key(model);
    if (verdict.free && !seen.has(modelKey)) {
      seen.add(modelKey);
      out.push(norm(model));
    }
  }
  return out;
}

/** 请求模型是否免费（支持 provider/model 与裸 model 两种写法） */
export function isFreeModel(
  provider: Pick<Provider, "id" | "type" | "freeModels" | "name">,
  model: string,
): boolean {
  const bare = model.startsWith(`${provider.name}/`) ? model.slice(provider.name.length + 1) : model;
  return classifyModel(provider, bare).free;
}
