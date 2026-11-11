import type { Env, Provider, RouteGroup } from "./types";
import { getProviders, saveProviders } from "./store";
import { discoverProviderModels, enabledProviderModels, normalizeProviderFreeModels } from "./providers";
import { classifyProviderModels, freeModelIds, registerUpstreamFree, type FreeModelVerdict } from "./free-models";
import { testMany, testModel, type TestOptions } from "./model-test";
import { getHealth, listHealth, resetHealth } from "./health";
import { normalizeQuota, peekQuota, hasQuota } from "./quota";
import { planRoute, ROUTING_MODE_LABELS } from "./routing";
import {
  advanceRotateCursor,
  bootstrapGroups,
  getRotateCursor,
  getRouteStore,
  normalizeGroup,
  saveRouteStore,
} from "./route-store";
import { error, json, readJson } from "./utils";

/**
 * 管理端扩展接口：免费模型、模型测试、健康度、额度、路由组。
 *
 * 挂载点：src/admin.ts 的 handleAdmin 中、`authorized` 校验之后调用本函数，
 * 命中返回 Response，未命中返回 null 继续走原有逻辑。
 * 鉴权完全复用项目既有的会话（cookie/Bearer），不新增第二套登录。
 */

const PREFIX = "/admin/ext";

function notFound(path: string): Response {
  return error(`扩展接口不存在：${path}`, 404, "not_found");
}

/** 刷新单个提供商：发现模型 → 采集免费清单 → 回写 */
async function refreshOne(
  env: Env,
  provider: Provider,
  options: { autoEnableFree: boolean },
): Promise<{ provider: Provider; report: Record<string, unknown> }> {
  const before = provider.freeModels || [];
  const catalog = await discoverProviderModels(provider, env);
  registerUpstreamFree(provider.id, catalog.freeModels);

  const next: Provider = {
    ...provider,
    models: catalog.models,
    freeModels: normalizeProviderFreeModels({ type: provider.type, models: catalog.models, freeModels: catalog.freeModels }),
  };

  if (next.enabledModels === undefined) {
    // 原本「全选」语义保持不变
  } else if (options.autoEnableFree) {
    // 免费模型自动并入启用列表（即：筛选结果直接变成可勾选白名单）
    const merged = new Set([...next.enabledModels, ...(next.freeModels ?? [])]);
    next.enabledModels = catalog.models.filter((model) => merged.has(model));
  } else {
    next.enabledModels = next.enabledModels.filter((model) => catalog.models.includes(model));
  }

  if (!next.defaultModel || !enabledProviderModels(next).includes(next.defaultModel)) {
    next.defaultModel = enabledProviderModels(next)[0];
  }

  const freeModels = next.freeModels ?? [];
  const beforeSet = new Set(before);
  const afterSet = new Set(freeModels);
  return {
    provider: next,
    report: {
      providerId: provider.id,
      providerName: provider.name,
      ok: true,
      totalModels: catalog.models.length,
      freeModels,
      freeCount: freeModels.length,
      enabledCount: enabledProviderModels(next).length,
      added: freeModels.filter((model) => !beforeSet.has(model)),
      removed: before.filter((model) => !afterSet.has(model)),
    },
  };
}

/** 处理 /admin/ext/* ；返回 null 表示不属于本模块 */
export async function handleAdminExtensions(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX) return null;
  const route = url.pathname.slice(PREFIX.length).replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    // ---- 元信息：模式与徽标释义 ----
    if (route === "/meta" && method === "GET") {
      return json({
        routingModes: Object.entries(ROUTING_MODE_LABELS).map(([value, label]) => ({ value, label })),
        badgeTiers: [
          { tier: "verified", label: "免费", hint: "上游目录标注零价格，或实测可用" },
          { tier: "declared", label: "免费·白名单", hint: "由你手动声明为免费" },
          { tier: "likely", label: "免费·推断", hint: "按模型命名规则推断" },
          { tier: "guess", label: "付费", hint: "未命中任何免费规则" },
        ],
      });
    }

    // ---- 免费模型：预览（纯本地，不联网） ----
    if (route === "/free-models/preview" && method === "GET") {
      const providers = await getProviders(env);
      const targetId = url.searchParams.get("providerId");
      const rows = providers
        .filter((provider) => !targetId || provider.id === targetId)
        .map((provider) => {
          const verdicts: FreeModelVerdict[] = classifyProviderModels(provider, provider.models);
          return {
            providerId: provider.id,
            providerName: provider.name,
            type: provider.type,
            enabled: provider.enabled,
            total: provider.models.length,
            freeCount: verdicts.filter((item) => item.free).length,
            models: verdicts.map((item) => ({
              model: item.model,
              free: item.free,
              confidence: item.confidence,
              reason: item.reason,
              badge: item.badge,
              rules: item.rules.map((rule) => ({ id: rule.id, label: rule.label, matched: rule.matched, detail: rule.detail })),
            })),
          };
        });
      return json({ providers: rows });
    }

    // ---- 免费模型：批量刷新并落库 ----
    if (route === "/free-models/refresh" && method === "POST") {
      const body = await readJson<{ providerIds?: string[]; autoEnableFree?: boolean }>(request);
      const autoEnableFree = body.autoEnableFree !== false;
      const providers = await getProviders(env);
      const targets = providers.filter(
        (provider) => provider.enabled && (!body.providerIds || body.providerIds.includes(provider.id)),
      );

      const reports: Array<Record<string, unknown>> = [];
      const updated = new Map<string, Provider>();

      // 受控并发 3，单 provider 失败不影响其它
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, targets.length || 1) }, async () => {
          for (;;) {
            const index = cursor++;
            if (index >= targets.length) return;
            const provider = targets[index];
            try {
              const { provider: next, report } = await refreshOne(env, provider, { autoEnableFree });
              updated.set(provider.id, next);
              reports.push(report);
            } catch (cause) {
              reports.push({
                providerId: provider.id,
                providerName: provider.name,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }
          }
        }),
      );

      const nextProviders = providers.map((provider) => updated.get(provider.id) || provider);
      await saveProviders(env, nextProviders);
      reports.sort((a, b) => String(a.providerName).localeCompare(String(b.providerName)));
      return json({
        ok: true,
        summary: {
          providers: reports.length,
          failed: reports.filter((item) => item.ok === false).length,
          totalFree: reports.reduce((sum, item) => sum + Number(item.freeCount || 0), 0),
          reports,
        },
      });
    }

    // ---- 免费模型：单 provider 刷新 ----
    if (route === "/free-models/refresh-one" && method === "POST") {
      const body = await readJson<{ providerId?: string; autoEnableFree?: boolean }>(request);
      if (!body.providerId) return error("缺少 providerId");
      const providers = await getProviders(env);
      const target = providers.find((provider) => provider.id === body.providerId);
      if (!target) return error("提供商不存在", 404);
      const { provider: next, report } = await refreshOne(env, target, { autoEnableFree: body.autoEnableFree !== false });
      await saveProviders(env, providers.map((provider) => (provider.id === next.id ? next : provider)));
      return json({ ok: true, report, providerModels: next.models.length });
    }

    // ---- 模型一键测试 ----
    if (route === "/models/test" && method === "POST") {
      const body = await readJson<TestOptions & { providerId?: string; model?: string }>(request);
      const providers = await getProviders(env);
      if (body.providerId && body.model) {
        const target = providers.find((provider) => provider.id === body.providerId);
        if (!target) return error("提供商不存在", 404);
        const result = await testModel(env, target, body.model, body);
        return json({ ok: result.ok, result });
      }
      const summary = await testMany(env, providers, body);
      return json({ ok: true, summary });
    }

    // ---- 健康度 ----
    if (route === "/health" && method === "GET") {
      const providers = await getProviders(env);
      const targetId = url.searchParams.get("providerId");
      const ids = targetId ? [targetId] : providers.filter((provider) => provider.enabled).map((provider) => provider.id);
      const health = await listHealth(env, ids);
      return json({
        health: health.map((item) => ({
          ...item,
          providerName: providers.find((provider) => provider.id === item.providerId)?.name,
        })),
      });
    }

    if (route === "/health/reset" && method === "POST") {
      const body = await readJson<{ providerId?: string; model?: string; all?: boolean }>(request);
      if (body.all) {
        const providers = await getProviders(env);
        await Promise.all(providers.map((provider) => resetHealth(env, provider.id)));
        return json({ ok: true, reset: providers.length });
      }
      if (!body.providerId) return error("缺少 providerId");
      await resetHealth(env, body.providerId, body.model);
      return json({ ok: true, health: await getHealth(env, body.providerId, body.model) });
    }

    // ---- 额度视图 ----
    if (route === "/quota" && method === "GET") {
      const providers = await getProviders(env);
      const rows = [];
      for (const provider of providers) {
        if (!hasQuota(provider.quota)) continue;
        rows.push({
          providerId: provider.id,
          providerName: provider.name,
          policy: provider.quota,
          ...(await peekQuota(env, "provider", provider.id, provider.quota!)),
        });
      }
      return json({ quota: rows });
    }

    // ---- 额度写入 / 清除 ----
    if (route === "/quota" && method === "PUT") {
      const body = await readJson<{ providerId?: string; quota?: unknown }>(request);
      if (!body.providerId) return error("缺少 providerId");
      if (body.quota === undefined) return error("缺少 quota 字段（传 {} 表示清除限制）");
      const providers = await getProviders(env);
      const index = providers.findIndex((provider) => provider.id === body.providerId);
      if (index < 0) return error("提供商不存在", 404);
      const quota = normalizeQuota(body.quota);
      const next = { ...providers[index] };
      if (quota) next.quota = quota;
      else delete next.quota;
      providers[index] = next;
      await saveProviders(env, providers);
      return json({ ok: true, providerId: next.id, quota: next.quota ?? null });
    }

    // ---- 路由组 ----
    if (route === "/route-groups" && method === "GET") {
      const store = await getRouteStore(env);
      return json({ ...store, cursor: await getRotateCursor(env) });
    }

    if (route === "/route-groups" && method === "PUT") {
      const body = await readJson<{ groups?: unknown[]; defaultGroupId?: string }>(request);
      const groups: RouteGroup[] = [];
      for (const item of body.groups || []) {
        const group = normalizeGroup(item);
        if (!group) return error("路由组格式不合法（id 与 name 必填）");
        groups.push(group);
      }
      const saved = await saveRouteStore(env, { groups, defaultGroupId: body.defaultGroupId });
      return json({ ok: true, ...saved });
    }

    if (route === "/route-groups/bootstrap" && method === "POST") {
      const providers = await getProviders(env);
      const saved = await saveRouteStore(env, bootstrapGroups(providers));
      return json({ ok: true, ...saved });
    }

    // ---- 路由演练（dry-run，不发请求） ----
    if (route === "/route-preview" && method === "GET") {
      const providers = await getProviders(env);
      const store = await getRouteStore(env);
      const groupId = url.searchParams.get("groupId") || store.defaultGroupId;
      const group = store.groups.find((item) => item.id === groupId);
      if (!group) return error("路由组不存在（请先创建或使用一键生成）", 404);
      const decision = await planRoute({ env, providers, rotateCursor: await getRotateCursor(env) }, group);
      return json({
        group: { id: group.id, name: group.name, mode: group.mode, modeLabel: ROUTING_MODE_LABELS[group.mode] },
        attempts: decision.attempts.map((target, index) => ({
          order: index + 1,
          providerId: target.provider.id,
          providerName: target.provider.name,
          model: target.model,
          free: target.free,
          reason: target.reason,
          budget: target.budget,
        })),
        skipped: decision.skipped.map((item) => ({
          providerId: item.member.providerId,
          providerName: item.providerName,
          model: item.member.model,
          reason: item.reason,
        })),
      });
    }

    return notFound(route);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "扩展接口内部错误", 500, "admin_ext_error");
  }
}

/** 供网关复用：某提供商当前免费模型（上游清单 + 命名推断） */
export function currentFreeModels(provider: Provider): string[] {
  return freeModelIds(provider, provider.models);
}
