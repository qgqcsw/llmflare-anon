import type { Env, Provider } from "./types";
import { enabledProviderModels, providerAuthMode, providerBaseUrl } from "./providers";
import { isFreeModel } from "./free-models";

/**
 * 模型一键测试 / 批量体检。
 *
 * 目标：把「哪个模型还能用、多快、是不是真免费」变成一次点击的结果。
 * - 兼容 OpenAI 兼容接口与 Workers AI；
 * - 并发受控（默认 4），避免打爆上游免费额度；
 * - 默认 maxTokens=8 + 极短提示词，几乎不消耗额度。
 */

export interface TestOptions {
  concurrency?: number;
  timeoutMs?: number;
  freeOnly?: boolean;
  prompt?: string;
  maxTokens?: number;
  providerIds?: string[];
  models?: string[];
}

export interface TestResult {
  providerId: string;
  providerName: string;
  model: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  firstByteMs?: number;
  reply?: string;
  error?: string;
  errorKind?: string;
  free: boolean;
  testedAt: number;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  freePassed: number;
  results: TestResult[];
  startedAt: number;
  finishedAt: number;
}

const DEFAULT_PROMPT = "只回复两个字：可用";
const DEFAULT_TIMEOUT = 20_000;

function withTimeout(ms: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function extractReply(raw: string): string {
  if (raw.includes("data:")) {
    const parts: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
        };
        const choice = parsed.choices?.[0];
        const text = choice?.delta?.content ?? choice?.message?.content;
        if (typeof text === "string") parts.push(text);
      } catch {
        /* 忽略非 JSON 的 SSE 行 */
      }
    }
    if (parts.length) return parts.join("").slice(0, 200);
  }
  try {
    const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.slice(0, 200);
  } catch {
    /* 非 JSON 回包 */
  }
  return "";
}

/** 测一个 provider 的一个模型 */
export async function testModel(env: Env, provider: Provider, model: string, options: TestOptions = {}): Promise<TestResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const prompt = options.prompt ?? DEFAULT_PROMPT;
  const maxTokens = options.maxTokens ?? 8;
  const base = { providerId: provider.id, providerName: provider.name, model };
  const free = isFreeModel(provider, model);

  if (provider.type === "workers-ai") {
    try {
      const result = await env.AI.run(model as never, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      } as never);
      const latencyMs = Date.now() - started;
      const text =
        typeof result === "object" && result && "response" in result
          ? String((result as { response?: unknown }).response ?? "")
          : String(result ?? "");
      return { ...base, ok: true, status: 200, latencyMs, reply: text.slice(0, 200), free, testedAt: started };
    } catch (cause) {
      return {
        ...base,
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        error: cause instanceof Error ? cause.message : String(cause),
        errorKind: "workers-ai",
        free,
        testedAt: started,
      };
    }
  }

  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) {
    return { ...base, ok: false, status: 0, latencyMs: 0, error: "缺少 Base URL", errorKind: "configuration", free, testedAt: started };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (providerAuthMode(provider) !== "none" && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const { signal, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false }),
    });
    const raw = await response.text();
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      let message = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
        if (typeof parsed.error === "string") message = parsed.error;
        else if (parsed.error?.message) message = parsed.error.message;
      } catch {
        /* 保留原始片段 */
      }
      return {
        ...base,
        ok: false,
        status: response.status,
        latencyMs,
        error: message,
        errorKind: response.status === 429 ? "rate_limit" : response.status >= 500 ? "upstream_5xx" : "bad_request",
        free,
        testedAt: started,
      };
    }
    return { ...base, ok: true, status: response.status, latencyMs, firstByteMs: latencyMs, reply: extractReply(raw), free, testedAt: started };
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    return {
      ...base,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : cause instanceof Error ? cause.message : String(cause),
      errorKind: aborted ? "timeout" : "network",
      free,
      testedAt: started,
    };
  } finally {
    done();
  }
}

/** 批量体检：受控并发 */
export async function testMany(env: Env, providers: Provider[], options: TestOptions = {}): Promise<TestSummary> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
  const tasks: Array<{ provider: Provider; model: string }> = [];

  for (const provider of providers) {
    if (options.providerIds && !options.providerIds.includes(provider.id)) continue;
    if (!provider.enabled) continue;
    for (const model of enabledProviderModels(provider)) {
      if (options.models && !options.models.includes(model)) continue;
      if (options.freeOnly && !isFreeModel(provider, model)) continue;
      tasks.push({ provider, model });
    }
  }

  const results: TestResult[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length || 1) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= tasks.length) return;
        const task = tasks[index];
        try {
          results.push(await testModel(env, task.provider, task.model, options));
        } catch (cause) {
          results.push({
            providerId: task.provider.id,
            providerName: task.provider.name,
            model: task.model,
            ok: false,
            status: 0,
            latencyMs: 0,
            error: cause instanceof Error ? cause.message : String(cause),
            errorKind: "internal",
            free: false,
            testedAt: Date.now(),
          });
        }
      }
    }),
  );

  results.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model));
  const passed = results.filter((item) => item.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    freePassed: results.filter((item) => item.ok && item.free).length,
    results,
    startedAt,
    finishedAt: Date.now(),
  };
}
