import type { Env, Provider, RouteGroup, RouteMember, RouteStoreState, RoutingMode } from "./types";
import { ROUTING_MODES, makeGroup } from "./routing";

/**
 * 路由组持久化（KV）。
 *
 * 取舍：
 * - 与 providers 分开存（route-groups:v1），互不干扰，便于单独回滚；
 * - 读取时做防御性归一化，即使手工改坏 KV 也不会让网关整体 500；
 * - 轮询游标与配置分离存储，避免每次轮询都写配置。
 */

const GROUPS_KEY = "route-groups:v1";
const CURSOR_KEY = "route-cursor:v1";

function normalizeMember(input: unknown): RouteMember | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const providerId = typeof raw.providerId === "string" ? raw.providerId.trim() : "";
  if (!providerId) return null;
  const member: RouteMember = { providerId };
  if (typeof raw.model === "string" && raw.model.trim()) member.model = raw.model.trim();
  if (typeof raw.weight === "number" && Number.isFinite(raw.weight)) member.weight = raw.weight;
  return member;
}

export function normalizeGroup(input: unknown): RouteGroup | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;

  const members = Array.isArray(raw.members)
    ? raw.members.map(normalizeMember).filter((item): item is RouteMember => item !== null)
    : [];
  // 同一 provider 可以挂多个不同 model，但完全重复的成员没有意义
  const seen = new Set<string>();
  const unique = members.filter((member) => {
    const key = `${member.providerId}::${member.model || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const mode: RoutingMode = ROUTING_MODES.includes(raw.mode as RoutingMode) ? (raw.mode as RoutingMode) : "smart";
  const maxAttempts =
    typeof raw.maxAttempts === "number" && raw.maxAttempts >= 1 && raw.maxAttempts <= 10
      ? Math.floor(raw.maxAttempts)
      : 3;
  const firstByteTimeoutMs =
    typeof raw.firstByteTimeoutMs === "number" && raw.firstByteTimeoutMs >= 1000
      ? Math.floor(raw.firstByteTimeoutMs)
      : 30_000;

  return makeGroup({
    id,
    name,
    enabled: raw.enabled !== false,
    mode,
    members: unique,
    maxAttempts,
    firstByteTimeoutMs,
    freeOnly: raw.freeOnly === true,
  });
}

export async function getRouteStore(env: Env): Promise<RouteStoreState> {
  const raw = await env.CONFIG.get<RouteStoreState>(GROUPS_KEY, "json");
  const groups = (raw?.groups || []).map(normalizeGroup).filter((group): group is RouteGroup => group !== null);
  const defaultGroupId = groups.find((group) => group.id === raw?.defaultGroupId)?.id || groups[0]?.id;
  return { groups, defaultGroupId };
}

export async function saveRouteStore(env: Env, state: RouteStoreState): Promise<RouteStoreState> {
  const groups = (state.groups || []).map(normalizeGroup).filter((group): group is RouteGroup => group !== null);
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error(`路由组 ID 重复：${group.id}`);
    ids.add(group.id);
  }
  const defaultGroupId = groups.find((group) => group.id === state.defaultGroupId)?.id || groups[0]?.id;
  const next: RouteStoreState = { groups, defaultGroupId };
  await env.CONFIG.put(GROUPS_KEY, JSON.stringify(next));
  return next;
}

export async function getRotateCursor(env: Env): Promise<Record<string, number>> {
  return (await env.CONFIG.get<Record<string, number>>(CURSOR_KEY, "json")) || {};
}

/** 推进轮询游标：只对 rotate 组自增，避免无谓写入 */
export async function advanceRotateCursor(env: Env, groupIds: string[], size: number): Promise<void> {
  if (!groupIds.length || size <= 0) return;
  const cursor = await getRotateCursor(env);
  for (const id of groupIds) cursor[id] = ((cursor[id] ?? 0) + 1) % size;
  await env.CONFIG.put(CURSOR_KEY, JSON.stringify(cursor), { expirationTtl: 604_800 });
}

/** 一键脚手架：把所有已启用提供商的默认模型串成一个 smart 组 */
export function bootstrapGroups(providers: Array<Pick<Provider, "id" | "name" | "enabled" | "defaultModel">>): RouteStoreState {
  const members: RouteMember[] = providers
    .filter((provider) => provider.enabled)
    .map((provider) =>
      provider.defaultModel ? { providerId: provider.id, model: provider.defaultModel } : { providerId: provider.id },
    );
  const groups = members.length
    ? [makeGroup({ id: "default", name: "全部提供商（智能）", members, mode: "smart" })]
    : [];
  return { groups, defaultGroupId: groups[0]?.id };
}
