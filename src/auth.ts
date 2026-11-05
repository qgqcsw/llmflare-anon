/**
 * 管理员账号体系
 *
 * 设计要点：
 * 1. 密码用 PBKDF2-SHA256（210k 迭代）加盐哈希，只存哈希，永不回传明文。
 * 2. 会话令牌只存 SHA-256 摘要，KV 里看不到可用凭据；短 TTL + 可选"记住我"。
 * 3. ADMIN_TOKEN 降级为两个用途：
 *    - 首次建号（bootstrap）的验证凭据，避免"默认密码"这种致命设计；
 *    - 应急通道（账号密码忘记/泄露时仍可进入管理台重置）。
 * 4. 登录失败按 IP 做渐进限流，防止暴力破解。
 * 5. 全部复用现有 CONFIG(KV) 绑定，不新增任何 Cloudflare 资源。
 */
import type { Env } from "./types";
import { bearer, sha256, secureToken, timingSafeEqual } from "./utils";

const ACCOUNT_KEY = "admin:account:v1";
const SESSION_PREFIX = "admin:session:";
const THROTTLE_PREFIX = "admin:throttle:";

const PBKDF2_ITERATIONS = 210_000;
const SESSION_TTL_SHORT = 60 * 60 * 12; // 12 小时
const SESSION_TTL_LONG = 60 * 60 * 24 * 30; // 30 天（记住我）
export const MAX_LOGIN_FAILURES = 6;
const THROTTLE_WINDOW = 60 * 15; // 15 分钟窗口
const MIN_PASSWORD_LENGTH = 10;

export interface AdminAccount {
  username: string;
  salt: string;
  hash: string;
  iterations: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSession {
  username: string;
  createdAt: string;
  expiresAt: number;
}

export interface AuthState {
  authenticated: boolean;
  hasAccount: boolean;
  bootstrapAvailable: boolean;
  username?: string;
}

/** 账号是否已初始化 */
export async function getAccount(env: Env): Promise<AdminAccount | null> {
  return (await env.CONFIG.get(ACCOUNT_KEY, "json")) as AdminAccount | null;
}

/** ADMIN_TOKEN 存在时才允许首次建号 */
export function bootstrapAvailable(env: Env): boolean {
  return Boolean(env.ADMIN_TOKEN);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const saltBuffer = salt.slice().buffer as ArrayBuffer;
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, material, 256);
  return toBase64(new Uint8Array(bits));
}

export interface PasswordPolicyError {
  message: string;
}

/** 密码强度校验：长度 + 字符种类，避免"123456"这类弱口令 */
export function validatePassword(password: unknown): PasswordPolicyError | null {
  if (typeof password !== "string") return { message: "密码格式无效" };
  if (password.length < MIN_PASSWORD_LENGTH) return { message: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` };
  if (password.length > 200) return { message: "密码长度超出上限" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (classes < 2) return { message: "密码需包含大小写字母、数字、符号中的至少两类" };
  return null;
}

export function validateUsername(username: unknown): PasswordPolicyError | null {
  if (typeof username !== "string") return { message: "账号格式无效" };
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 32) return { message: "账号长度需为 3-32 个字符" };
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return { message: "账号仅支持字母、数字、点、下划线与短横线" };
  return null;
}

/** 首次建号。已存在账号时拒绝，避免被覆盖接管。 */
export async function createAccount(env: Env, username: string, password: string): Promise<AdminAccount> {
  const existing = await getAccount(env);
  if (existing) throw new Error("管理员账号已存在，请直接登录");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
  const now = new Date().toISOString();
  const account: AdminAccount = {
    username: username.trim(),
    salt: toBase64(salt),
    hash,
    iterations: PBKDF2_ITERATIONS,
    createdAt: now,
    updatedAt: now,
  };
  await env.CONFIG.put(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

/** 改密。调用方需先完成身份校验。 */
export async function updatePassword(env: Env, password: string): Promise<void> {
  const account = await getAccount(env);
  if (!account) throw new Error("管理员账号不存在");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
  const next: AdminAccount = { ...account, salt: toBase64(salt), hash, iterations: PBKDF2_ITERATIONS, updatedAt: new Date().toISOString() };
  await env.CONFIG.put(ACCOUNT_KEY, JSON.stringify(next));
  await destroyAllSessions(env);
}

/** 校验账号密码，恒定时间比较 */
export async function verifyCredentials(env: Env, username: string, password: string): Promise<AdminAccount | null> {
  const account = await getAccount(env);
  if (!account) return null;
  if (account.username !== username.trim()) {
    // 账号不匹配时也做一次等价计算，避免通过响应时间枚举账号
    await derivePasswordHash(password, fromBase64(account.salt), account.iterations);
    return null;
  }
  const candidate = await derivePasswordHash(password, fromBase64(account.salt), account.iterations);
  return timingSafeEqual(candidate, account.hash).then((equal) => (equal ? account : null));
}

/** 创建会话，返回明文令牌（仅此一次可见） */
export async function createSession(env: Env, username: string, remember: boolean): Promise<{ token: string; expiresAt: number }> {
  const token = secureToken();
  const ttl = remember ? SESSION_TTL_LONG : SESSION_TTL_SHORT;
  const expiresAt = Date.now() + ttl * 1000;
  const session: AdminSession = { username, createdAt: new Date().toISOString(), expiresAt };
  await env.CONFIG.put(`${SESSION_PREFIX}${await sha256(token)}`, JSON.stringify(session), { expirationTtl: ttl });
  return { token, expiresAt };
}

/** 解析会话令牌，过期或不合法返回 null */
export async function resolveSession(env: Env, token: string): Promise<AdminSession | null> {
  if (!token) return null;
  const key = `${SESSION_PREFIX}${await sha256(token)}`;
  const session = (await env.CONFIG.get(key, "json")) as AdminSession | null;
  if (!session) return null;
  if (typeof session.expiresAt === "number" && session.expiresAt < Date.now()) {
    await env.CONFIG.delete(key);
    return null;
  }
  return session;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  if (!token) return;
  await env.CONFIG.delete(`${SESSION_PREFIX}${await sha256(token)}`);
}

/**
 * 改密后清空所有会话。
 * KV 不支持前缀删除，这里依赖列表操作（Cloudflare KV 提供 list），按页清理。
 */
export async function destroyAllSessions(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.CONFIG.list({ prefix: SESSION_PREFIX, cursor });
    await Promise.all(page.keys.map((entry) => env.CONFIG.delete(entry.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export interface ThrottleState {
  failures: number;
  resetAt: number;
}

export async function readThrottle(env: Env, ip: string): Promise<ThrottleState | null> {
  const key = `${THROTTLE_PREFIX}${await sha256(ip || "unknown")}`;
  return (await env.CONFIG.get(key, "json")) as ThrottleState | null;
}

/** 记录一次失败；达到阈值后锁定窗口 */
export async function recordFailure(env: Env, ip: string): Promise<ThrottleState> {
  const key = `${THROTTLE_PREFIX}${await sha256(ip || "unknown")}`;
  const current = await readThrottle(env, ip);
  const now = Date.now();
  const state: ThrottleState =
    current && current.resetAt > now ? { failures: current.failures + 1, resetAt: current.resetAt } : { failures: 1, resetAt: now + THROTTLE_WINDOW * 1000 };
  await env.CONFIG.put(key, JSON.stringify(state), { expirationTtl: THROTTLE_WINDOW });
  return state;
}

export async function clearThrottle(env: Env, ip: string): Promise<void> {
  await env.CONFIG.delete(`${THROTTLE_PREFIX}${await sha256(ip || "unknown")}`);
}

export function isLocked(state: ThrottleState | null): boolean {
  return Boolean(state && state.failures >= MAX_LOGIN_FAILURES && state.resetAt > Date.now());
}

export function lockRemainingSeconds(state: ThrottleState | null): number {
  if (!state) return 0;
  return Math.max(0, Math.ceil((state.resetAt - Date.now()) / 1000));
}

/**
 * 统一身份校验：
 * 1. 先试会话令牌（日常路径）
 * 2. 再试 ADMIN_TOKEN（应急通道，兼容既有 API 调用与自动化测试）
 */
export async function authenticateAdmin(request: Request, env: Env): Promise<{ ok: boolean; via: "session" | "token" | "none"; username?: string }> {
  const token = bearer(request);
  if (!token) return { ok: false, via: "none" };
  const session = await resolveSession(env, token);
  if (session) return { ok: true, via: "session", username: session.username };
  if (env.ADMIN_TOKEN && (await timingSafeEqual(token, env.ADMIN_TOKEN))) return { ok: true, via: "token", username: "ADMIN_TOKEN" };
  return { ok: false, via: "none" };
}
