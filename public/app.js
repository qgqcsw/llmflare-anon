/* ==========================================================================
   LLMflare-Anon · 控制台脚本
   鉴权：账号密码会话（llmf 风格），ADMIN_TOKEN 仅用于首次建号与应急
   ========================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const TOKEN_KEY = "llm-anon-token";

let adminToken = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
let providersCache = [];
let keysCache = [];
let modelCatalog = [];
let modelSelection = new Set();
let modelFreeModels = new Set();
let draftFreeModels = new Set();
let lastUsageData = null;

const usagePaging = { models: { page: 1, pageSize: 10 }, logs: { page: 1, pageSize: 10 } };
let usageRequestSequence = 0;

/* ------------------------------- 基础工具 ------------------------------- */
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);

const formatNumber = (value) => {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN", { notation: number >= 100000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
};

const formatDuration = (value) => {
  if (value == null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number < 1000 ? `${Math.round(number)} ms` : `${(number / 1000).toFixed(2)} s`;
};

const formatTime = (value) => {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const notify = (message, kind = "ok") => {
  const el = $("#status");
  if (!el) return;
  const normalized = kind === "error" ? "bad" : kind;
  el.textContent = message;
  el.dataset.kind = normalized;
  el.dataset.show = "true";
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { el.dataset.show = "false"; }, 3600);
};

const setToken = (token, remember) => {
  adminToken = token || "";
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (!adminToken) return;
  if (remember) localStorage.setItem(TOKEN_KEY, adminToken);
  else sessionStorage.setItem(TOKEN_KEY, adminToken);
};

const clearToken = () => setToken("", false);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}), ...(options.headers || {}) },
  });
  if (response.status === 401 && !path.startsWith("/admin/auth/")) {
    clearToken();
    showGate();
    throw new Error("登录已失效，请重新登录");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || data.message || `HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

/* ------------------------------- 视图切换 ------------------------------- */
const VIEWS = {
  overview: { title: "用量总览", sub: "请求、Token 与延迟的实时观察" },
  providers: { title: "AI 提供商", sub: "上游、模型白名单与鉴权方式" },
  keys: { title: "客户端密钥", sub: "网关签发的访问密钥与独立限额" },
  playground: { title: "接口测试", sub: "用客户端密钥验证兼容接口" },
  settings: { title: "账号安全", sub: "账号信息、密码与接口基址" },
};

function switchView(name) {
  const meta = VIEWS[name] || VIEWS.overview;
  $("#viewTitle").textContent = meta.title;
  $("#viewSub").textContent = meta.sub;
  $$(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === name));
  $$("[data-view]").forEach((button) => {
    if (button.classList.contains("nav-item") || button.classList.contains("tab")) {
      button.classList.toggle("is-active", button.dataset.view === name);
    }
  });
  if (name === "settings") loadMe().catch(() => {});
  if (name === "overview" && !lastUsageData) loadUsage().catch((error) => notify(error.message, "bad"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$("[data-view]").forEach((button) => {
  if (button.classList.contains("nav-item") || button.classList.contains("tab")) {
    button.addEventListener("click", () => switchView(button.dataset.view));
  }
});

/* ------------------------------- 登录 / 建号 ------------------------------- */
function showGate(stage = "login") {
  $("#workspace").hidden = true;
  $("#loginPanel").hidden = false;
  setStage(stage);
}

function setStage(stage) {
  const bootstrap = stage === "bootstrap";
  $("#loginStage").hidden = bootstrap;
  $("#bootstrapStage").hidden = !bootstrap;
  $("#loginHint").textContent = "";
}

$("#toBootstrap")?.addEventListener("click", () => setStage("bootstrap"));
$("#toLogin")?.addEventListener("click", () => setStage("login"));

/* ============================================================
   主题切换：深色（黑曜石）/ 浅色（白瓷）
   - 选择写入 localStorage，刷新后保持
   - 同步 <meta name="theme-color">，让移动端状态栏跟随
   - 画布图表需在主题变化后重绘（Canvas 不继承 CSS 变量）
   ============================================================ */
const THEME_KEY = "llm-anon-theme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyTheme(theme, options = {}) {
  const next = theme === "light" ? "light" : "dark";
  const root = document.documentElement;
  root.setAttribute("data-theme", next);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "light" ? "#f4f7fb" : "#06070b");

  $$("#themeToggleTop, #themeToggleGate").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(next === "light"));
    btn.setAttribute("title", next === "light" ? "切换到深色主题" : "切换到浅色主题");
    btn.setAttribute("aria-label", next === "light" ? "切换到深色主题" : "切换到浅色主题");
  });

  if (options.persist !== false) {
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* 隐私模式忽略 */ }
  }

  // 切换瞬间启用颜色过渡，避免生硬跳变；过渡结束后移除，避免影响日常交互性能
  root.classList.add("theme-anim");
  window.setTimeout(() => root.classList.remove("theme-anim"), 320);

  if (options.redraw !== false) redrawCharts();
}

/** 主题变化后重绘依赖当前数据的图表 */
function redrawCharts() {
  try {
    if (typeof lastUsageData !== "undefined" && lastUsageData) drawUsageChart(lastUsageData);
  } catch (err) { /* 图表尚未初始化时忽略 */ }
}

function toggleTheme() {
  applyTheme(currentTheme() === "light" ? "dark" : "light");
}

function initTheme() {
  // 引导脚本已在 <head> 设好 data-theme，这里只同步按钮状态与 meta
  applyTheme(currentTheme(), { persist: false, redraw: false });

  $$("#themeToggleTop, #themeToggleGate").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
  });

  // 未手动选择过时，跟随系统主题变化
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onSystemChange = (event) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { saved = null; }
    if (saved !== "light" && saved !== "dark") {
      applyTheme(event.matches ? "light" : "dark", { persist: false });
    }
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", onSystemChange);
}

initTheme();

async function bootAuth() {
  let state = { hasAccount: false, bootstrapAvailable: false, authenticated: false };
  try {
    const response = await fetch("/admin/auth/state", { headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {} });
    state = await response.json();
  } catch {
    /* 网络异常时保持登录门 */
  }

  if (adminToken && state.authenticated) {
    await enterWorkspace(state);
    return;
  }

  clearToken();
  showGate(state.hasAccount ? "login" : "bootstrap");
  const canBootstrap = !state.hasAccount && state.bootstrapAvailable;
  $("#toBootstrap").hidden = !canBootstrap;
  if (!state.hasAccount && !state.bootstrapAvailable) {
    $("#loginHint").textContent = "尚未设置 ADMIN_TOKEN，无法初始化账号。请先在部署环境配置该密钥。";
  }
}

async function enterWorkspace(state = {}) {
  $("#loginPanel").hidden = true;
  $("#workspace").hidden = false;
  $("#accountName").textContent = state.username || "管理员";
  $("#accountVia").textContent = state.via === "token" ? "ADMIN_TOKEN 应急登录" : "会话登录";
  $("#avatarText").textContent = (state.username || "A").slice(0, 1).toUpperCase();
  try {
    await Promise.all([loadProviders(), loadKeys(), loadUsage()]);
  } catch (error) {
    notify(error.message, "bad");
  }
  loadMe().catch(() => {});
}

$("#loginForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#loginForm button[type=submit]");
  submit.disabled = true;
  $("#loginHint").textContent = "";
  try {
    const data = await fetch("/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value, remember: $("#loginRemember").checked }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      return payload;
    });
    setToken(data.token, $("#loginRemember").checked);
    $("#loginPassword").value = "";
    await enterWorkspace({ username: data.username, via: "session" });
    notify(`欢迎回来，${data.username}`);
  } catch (error) {
    $("#loginHint").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#bootstrapForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#bootstrapForm button[type=submit]");
  submit.disabled = true;
  $("#loginHint").textContent = "";
  try {
    const data = await fetch("/admin/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: $("#bootstrapUsername").value.trim(),
        password: $("#bootstrapPassword").value,
        adminToken: $("#bootstrapToken").value,
      }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      return payload;
    });
    setToken(data.token, true);
    $("#bootstrapToken").value = "";
    $("#bootstrapPassword").value = "";
    await enterWorkspace({ username: data.username, via: "session" });
    notify("管理员账号已创建");
  } catch (error) {
    $("#loginHint").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function doLogout() {
  try {
    if (adminToken) await api("/admin/auth/logout", { method: "POST" });
  } catch {
    /* 忽略：本地清除即可 */
  }
  clearToken();
  showGate("login");
}
$("#logoutBtn")?.addEventListener("click", doLogout);
$("#logoutBtnTop")?.addEventListener("click", doLogout);

/* ------------------------------- 账号信息 ------------------------------- */
async function loadMe() {
  const data = await api("/admin/auth/me");
  $("#accountName").textContent = data.username || "管理员";
  $("#accountVia").textContent = data.via === "token" ? "ADMIN_TOKEN 应急登录" : "会话登录";
  $("#avatarText").textContent = (data.username || "A").slice(0, 1).toUpperCase();
  $("#meUsername").textContent = data.username || "—";
  $("#meVia").textContent = data.via === "token" ? "ADMIN_TOKEN（应急通道）" : "账号密码会话";
  $("#meCreatedAt").textContent = formatTime(data.createdAt);
  $("#meUpdatedAt").textContent = formatTime(data.updatedAt);
  $("#baseUrlOpenAI").textContent = `${location.origin}/v1`;
  $("#baseUrlAnthropic").textContent = `${location.origin}`;
}

$("#passwordForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#passwordForm button[type=submit]");
  const next = $("#newPassword").value;
  if (next !== $("#confirmPassword").value) {
    notify("两次输入的新密码不一致", "bad");
    return;
  }
  submit.disabled = true;
  try {
    const data = await api("/admin/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: $("#currentPassword").value, newPassword: next }),
    });
    if (data?.token) setToken(data.token, true);
    $("#passwordForm").reset();
    notify("密码已更新，其他设备已退出登录");
    loadMe().catch(() => {});
  } catch (error) {
    notify(error.message, "bad");
  } finally {
    submit.disabled = false;
  }
});

/* ------------------------------- 提供商 ------------------------------- */
const supportsFreeModelGroups = (type) => ["openrouter", "siliconflow", "zhipu"].includes(type);
const isOpenRouterFreeModelId = (model) => model === "openrouter/free" || model.endsWith(":free");
const isProviderFreeModelId = (type, model) => type === "openrouter" && isOpenRouterFreeModelId(model);
const supportsAnonymous = (type) => type === "openai-compatible";

async function loadProviders() {
  const { data } = await api("/admin/providers");
  providersCache = data;
  $("#providerList").innerHTML = data.length
    ? data
        .map((provider) => {
          const enabledModels = provider.enabledModels ?? provider.models ?? [];
          const authBadge =
            provider.authMode === "none"
              ? '<span class="badge badge--anon">匿名访问</span>'
              : provider.hasApiKey
                ? '<span class="badge badge--ok">密钥已存</span>'
                : provider.type === "workers-ai"
                  ? '<span class="badge">Binding</span>'
                  : '<span class="badge badge--bad">缺少密钥</span>';
          const modelLine = provider.models.length
            ? `${enabledModels.length}/${provider.models.length} 个模型已启用 · ${enabledModels.slice(0, 4).map(escapeHtml).join(" · ")}${enabledModels.length > 4 ? " …" : ""}`
            : "尚未登记模型";
          return `<article class="glass card">
            <div class="card-head">
              <div>
                <p class="card-name">${escapeHtml(provider.name)} ${provider.enabled === false ? '<span class="badge badge--warn">已停用</span>' : ""}</p>
                <p class="card-id">${escapeHtml(provider.id)}</p>
              </div>
              <div class="row"><span class="badge">${escapeHtml(provider.type)}</span>${authBadge}</div>
            </div>
            <p class="card-meta">${modelLine}</p>
            ${provider.baseUrl ? `<p class="card-models">${escapeHtml(provider.baseUrl)}</p>` : ""}
            <div class="card-actions">
              <button class="btn btn--ghost btn--sm" data-edit-provider="${provider.id}" type="button">编辑</button>
              <button class="btn btn--ghost btn--sm" data-model-provider="${provider.id}" type="button" ${provider.models.length ? "" : "disabled"}>选择模型</button>
              <button class="btn btn--ghost btn--sm" data-discover-provider="${provider.id}" type="button">刷新模型</button>
              <button class="btn btn--danger btn--sm" data-delete-provider="${provider.id}" type="button">删除</button>
            </div>
          </article>`;
        })
        .join("")
    : '<p class="glass card empty">还没有提供商。点击右上角「新增提供商」开始配置上游。</p>';
  renderTestModelOptions();
}

function syncProviderAuthMode() {
  const anonymous = $("#providerAuthMode").value === "none";
  $("#providerKeyField").hidden = anonymous;
  $("#providerApiKey").disabled = anonymous;
  if (anonymous) $("#providerApiKey").value = "";
  $("#providerHint").textContent = anonymous
    ? "匿名模式：网关不会向上游发送 Authorization 头，也不会保存任何 Key。请确认 Base URL 指向支持匿名调用的接口。"
    : "内置云端提供商只需填写各自 API Key；Workers AI 填 REST Token 与 Account ID。";
}

function syncAuthModeVisibility() {
  const allowAnonymous = supportsAnonymous($("#providerType").value);
  $("#providerAuthMode").hidden = !allowAnonymous;
  $("#providerAuthModeLabel").hidden = !allowAnonymous;
  if (!allowAnonymous) $("#providerAuthMode").value = "bearer";
  syncProviderAuthMode();
}

function resetProviderDialog() {
  $("#providerForm").reset();
  delete $("#providerDialog").dataset.providerId;
  $("#providerType").disabled = false;
  $("#providerApiKey").placeholder = "";
  $("#providerDialogTitle").textContent = "新增提供商";
  $("#saveProvider").textContent = "保存";
  draftFreeModels.clear();
  $("#modelCount").textContent = "尚未获取。";
  $("#providerAuthMode").value = "bearer";
  syncAuthModeVisibility();
}

function openProviderEditor(providerId) {
  const provider = providersCache.find((item) => item.id === providerId);
  if (!provider) return;
  resetProviderDialog();
  $("#providerDialog").dataset.providerId = provider.id;
  $("#providerDialogTitle").textContent = `编辑 ${provider.name}`;
  $("#saveProvider").textContent = "保存修改";
  $("#providerName").value = provider.name;
  $("#providerType").value = provider.type;
  $("#providerType").disabled = true;
  $("#providerAuthMode").value = provider.authMode === "none" ? "none" : "bearer";
  syncAuthModeVisibility();
  $("#providerApiKey").placeholder = provider.hasApiKey ? "已保存；留空则保持不变" : "填写新的 API Key";
  $("#providerBaseUrl").value = provider.baseUrl || "";
  $("#providerModels").value = (provider.models || []).join("\n");
  draftFreeModels = new Set(provider.freeModels || []);
  $("#modelCount").textContent = `当前 ${provider.models.length} 个模型；可重新自动获取。`;
  $("#providerDialog").showModal();
}

/* ------------------------------- 模型选择 ------------------------------- */
function visibleModelCatalog() {
  const query = $("#modelSearch").value.trim().toLowerCase();
  const onlyFree = !$("#freeModelsFilter").hidden && $("#onlyFreeModels").checked;
  const providerType = $("#modelDialog").dataset.providerType;
  const isFree = (model) => modelFreeModels.has(model) || isProviderFreeModelId(providerType, model);
  return modelCatalog.filter((model) => model.toLowerCase().includes(query) && (!onlyFree || isFree(model)));
}

function updateModelSelectionCount() {
  $("#modelSelectionCount").textContent = `已选 ${modelSelection.size} / ${modelCatalog.length} · 当前显示 ${visibleModelCatalog().length}`;
}

function modelChoice(model, free) {
  const tag = free === undefined ? "" : `<span class="free-tag">${free ? "免费" : "付费"}</span>`;
  return `<label class="choice"><input type="checkbox" value="${escapeHtml(model)}" ${modelSelection.has(model) ? "checked" : ""}><span>${escapeHtml(model)}</span>${tag}</label>`;
}

function renderModelChoices() {
  const visible = visibleModelCatalog();
  if (!visible.length) {
    $("#modelChoices").innerHTML = '<p class="empty">没有符合当前条件的模型。</p>';
  } else if (!supportsFreeModelGroups($("#modelDialog").dataset.providerType)) {
    $("#modelChoices").innerHTML = visible.map((model) => modelChoice(model)).join("");
  } else {
    const providerType = $("#modelDialog").dataset.providerType;
    const isFree = (model) => modelFreeModels.has(model) || isProviderFreeModelId(providerType, model);
    const groups = [
      ["免费模型", visible.filter(isFree), true],
      ["非免费模型", visible.filter((model) => !isFree(model)), false],
    ];
    $("#modelChoices").innerHTML = groups
      .filter(([, models]) => models.length)
      .map(([label, models, free]) => `<section><p class="muted" style="margin:.4rem .2rem">${label} · ${models.length}</p>${models.map((model) => modelChoice(model, free)).join("")}</section>`)
      .join("");
  }
  updateModelSelectionCount();
}

function openModelDialog(providerId) {
  const provider = providersCache.find((item) => item.id === providerId);
  if (!provider) return;
  modelCatalog = [...(provider.models || [])];
  modelSelection = new Set(provider.enabledModels ?? provider.models ?? []);
  modelFreeModels = new Set(provider.freeModels ?? modelCatalog.filter((model) => isProviderFreeModelId(provider.type, model)));
  $("#modelDialog").dataset.providerId = provider.id;
  $("#modelDialog").dataset.providerType = provider.type;
  $("#modelDialogTitle").textContent = `${provider.name} · 选择模型`;
  $("#modelSearch").value = "";
  $("#onlyFreeModels").checked = false;
  $("#freeModelsFilter").hidden = !supportsFreeModelGroups(provider.type);
  renderModelChoices();
  $("#modelDialog").showModal();
}

/* ------------------------------- 客户端密钥 ------------------------------- */
async function loadKeys() {
  const { data } = await api("/admin/keys");
  keysCache = data;
  $("#keyList").innerHTML = data.length
    ? data
        .map((key) => {
          const limits =
            [
              key.requestsPerMinute ? `${key.requestsPerMinute} RPM` : "",
              key.dailyRequestLimit ? `24h ${formatNumber(key.dailyRequestLimit)} 次` : "",
              key.monthlyTokenLimit ? `月度 ${formatNumber(key.monthlyTokenLimit)} Token` : "",
              key.maxOutputTokensPerRequest ? `单次输出 ${formatNumber(key.maxOutputTokensPerRequest)} Token` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "未设置用量限制";
          return `<article class="glass card">
            <div class="card-head">
              <div>
                <p class="card-name">${escapeHtml(key.name)} <span class="badge ${key.enabled ? "badge--ok" : "badge--warn"}">${key.enabled ? "启用" : "停用"}</span></p>
                <p class="card-id">${escapeHtml(key.prefix)}</p>
              </div>
              <p class="muted">${formatTime(key.createdAt)}</p>
            </div>
            <p class="card-meta">${escapeHtml(limits)}</p>
            <div class="card-actions">
              <button class="btn btn--ghost btn--sm" data-edit-key="${key.id}" type="button">限额</button>
              <button class="btn btn--ghost btn--sm" data-toggle-key="${key.id}" type="button">${key.enabled ? "停用" : "启用"}</button>
              <button class="btn btn--danger btn--sm" data-delete-key="${key.id}" type="button">吊销</button>
            </div>
          </article>`;
        })
        .join("")
    : '<p class="glass card empty">还没有客户端密钥。生成后明文只显示一次。</p>';
}

function resetKeyDialog() {
  $("#keyForm").reset();
  delete $("#keyDialog").dataset.keyId;
  $("#keyDialogTitle").textContent = "新建客户端密钥";
  $("#saveKey").textContent = "生成密钥";
  $("#customKey").disabled = false;
  $("#customKey").placeholder = "留空则自动生成";
}

function openKeyEditor(keyId) {
  const key = keysCache.find((item) => item.id === keyId);
  if (!key) return;
  resetKeyDialog();
  $("#keyDialog").dataset.keyId = key.id;
  $("#keyDialogTitle").textContent = `设置 ${key.name} 的限额`;
  $("#saveKey").textContent = "保存限额";
  $("#keyName").value = key.name;
  $("#customKey").disabled = true;
  $("#customKey").placeholder = "编辑限额时不更改密钥";
  $("#keyRpm").value = key.requestsPerMinute || "";
  $("#keyDailyRequests").value = key.dailyRequestLimit || "";
  $("#keyMonthlyTokens").value = key.monthlyTokenLimit || "";
  $("#keyMaxOutputTokens").value = key.maxOutputTokensPerRequest || "";
  $("#keyDialog").showModal();
}

/* ------------------------------- 用量看板 ------------------------------- */
const CHART_SERIES = ["--accent", "--accent-2", "--accent-3", "--ok", "--warn", "--bad"];

/** 读取当前主题的 CSS 变量实值，供 Canvas 使用（Canvas 不继承 CSS 变量） */
function themeVar(name, fallback = "#4cc9f0") {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 图表调色板：跟随主题实时取值，切换主题后下一次重绘自动生效 */
function chartColors() {
  return CHART_SERIES.map((token) => themeVar(token));
}

function drawUsageChart(data) {
  const canvas = $("#usageChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth || 640;
  const cssHeight = 260;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const rows = data?.dailyProviders || [];
  const days = [...new Set(rows.map((item) => item.day))].sort();
  if (!days.length) {
    ctx.fillStyle = axisColor;
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("这个周期还没有用量记录", cssWidth / 2, cssHeight / 2);
    $("#usageLegend").innerHTML = "";
    return;
  }

  const providers = [...new Map(rows.map((item) => [item.provider_id, { id: item.provider_id, name: item.provider_name }])).values()];
  const palette = chartColors();
  const gridColor = themeVar("--hairline-faint", "rgba(255,255,255,.06)");
  const axisColor = themeVar("--ink-dim", "rgba(127,135,155,.85)");
  const pointColor = themeVar("--ink", "rgba(255,255,255,.9)");
  const colorOf = new Map(providers.map((provider, index) => [provider.id, palette[index % palette.length]]));
  const valueOf = new Map(rows.map((item) => [`${item.day}|${item.provider_id}`, item]));

  const padL = 52, padR = 46, padT = 14, padB = 30;
  const plotW = Math.max(40, cssWidth - padL - padR);
  const plotH = Math.max(40, cssHeight - padT - padB);
  const maxTokens = Math.max(1, ...rows.map((item) => Number(item.output_tokens) || 0));
  const maxRequests = Math.max(4, ...rows.map((item) => Number(item.requests) || 0));
  const niceMax = (value) => {
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
    return Math.ceil(value / magnitude) * magnitude;
  };
  const tokenMax = niceMax(maxTokens);
  const requestMax = Math.ceil(maxRequests / 4) * 4;

  // 网格
  ctx.font = "10px ui-monospace, monospace";
  for (let index = 0; index <= 4; index += 1) {
    const y = padT + (plotH * index) / 4;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y + .5);
    ctx.lineTo(padL + plotW, y + .5);
    ctx.stroke();
    ctx.fillStyle = axisColor;
    ctx.textAlign = "right";
    ctx.fillText(formatNumber(tokenMax * (1 - index / 4)), padL - 8, y + 3);
    ctx.textAlign = "left";
    ctx.fillText(String(Math.round(requestMax * (1 - index / 4))), padL + plotW + 8, y + 3);
  }

  const slot = plotW / days.length;
  const groupW = Math.min(slot * .62, 54);
  const barW = Math.max(2, groupW / Math.max(1, providers.length));

  days.forEach((day, dayIndex) => {
    const centerX = padL + slot * dayIndex + slot / 2;
    const startX = centerX - groupW / 2;
    providers.forEach((provider, providerIndex) => {
      const item = valueOf.get(`${day}|${provider.id}`);
      const tokens = Number(item?.output_tokens) || 0;
      const height = tokens ? Math.max(2, (tokens / tokenMax) * plotH) : 0;
      if (!height) return;
      const x = startX + providerIndex * barW;
      const y = padT + plotH - height;
      const gradient = ctx.createLinearGradient(0, y, 0, padT + plotH);
      const color = colorOf.get(provider.id);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, themeVar("--accent-tint-1", "rgba(76,201,240,.12)"));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      const radius = Math.min(3, barW / 2);
      ctx.roundRect(x + .5, y, Math.max(1.5, barW - 1.5), height, [radius, radius, 0, 0]);
      ctx.fill();
    });

    // 请求数折线点
    const totalRequests = providers.reduce((sum, provider) => sum + (Number(valueOf.get(`${day}|${provider.id}`)?.requests) || 0), 0);
    const pointY = padT + plotH - (totalRequests / requestMax) * plotH;
    ctx.fillStyle = pointColor;
    ctx.beginPath();
    ctx.arc(centerX, pointY, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = axisColor;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(day).slice(5), centerX, cssHeight - 10);
  });

  $("#usageLegend").innerHTML = `${providers
    .map((provider) => `<span><i style="background:${colorOf.get(provider.id)}"></i>${escapeHtml(provider.name)}</span>`)
    .join("")}<span><i style="background:${pointColor};border-radius:50%"></i>请求数</span>`;
}

async function loadUsage() {
  const requestSequence = ++usageRequestSequence;
  const params = new URLSearchParams({
    days: $("#usageRange").value,
    modelPage: String(usagePaging.models.page),
    modelPageSize: String(usagePaging.models.pageSize),
    logPage: String(usagePaging.logs.page),
    logPageSize: String(usagePaging.logs.pageSize),
  });
  const data = await api(`/admin/usage?${params}`);
  if (requestSequence !== usageRequestSequence) return;
  lastUsageData = data;

  const summary = data.summary;
  $("#usageRequests").textContent = formatNumber(summary.requests);
  $("#usageTokens").textContent = formatNumber(summary.totalTokens);
  $("#usageSuccess").textContent = `${summary.successRate}%`;
  $("#usageFirstToken").textContent = formatDuration(summary.avgFirstTokenMs);
  $("#usageTps").textContent = summary.avgOutputTps ? `${Number(summary.avgOutputTps).toFixed(1)}` : "—";
  $("#usageDuration").textContent = formatDuration(summary.avgDurationMs);

  $("#usageCoverage").textContent = summary.requests
    ? `${summary.meteredRequests}/${summary.requests} 次请求含 Token 计量`
    : "暂无计量数据";
  $("#usageUpdatedAt").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;

  drawUsageChart(data);

  const providerRows = (items) =>
    items.length
      ? items
          .map(
            (item) =>
              `<tr><td>${escapeHtml(item.name)}</td><td class="num">${formatNumber(item.requests)}</td><td class="num">${formatNumber(item.total_tokens)}</td><td class="num">${formatNumber(item.errors)}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
  $("#usageProviders").innerHTML = `<table class="data-table"><thead><tr><th>提供商</th><th>请求</th><th>Token</th><th>错误</th></tr></thead><tbody>${providerRows(data.providers)}</tbody></table>`;

  $("#usageModels").innerHTML = data.models.length
    ? `<table class="data-table"><thead><tr><th>模型</th><th>请求</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>TPS</th><th>首字</th></tr></thead><tbody>${data.models
        .map(
          (item) =>
            `<tr><td title="${escapeHtml(item.provider_name)}">${escapeHtml(item.name)}</td><td class="num">${formatNumber(item.requests)}</td><td class="num">${formatNumber(item.input_tokens)}</td><td class="num">${formatNumber(item.output_tokens)}</td><td class="num">${formatNumber(Number(item.input_tokens) + Number(item.output_tokens))}</td><td class="num">${item.avg_output_tps == null ? "—" : Number(item.avg_output_tps).toFixed(1)}</td><td class="num">${formatDuration(item.avg_first_token_ms)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : '<p class="empty">暂无模型数据</p>';

  $("#usageLogs").innerHTML = data.logs.length
    ? `<table class="data-table"><thead><tr><th>时间 / 模型</th><th>输入/输出</th><th>首字</th><th>耗时</th><th>TPS</th><th>状态</th></tr></thead><tbody>${data.logs
        .map((item) => {
          const source = item.usage_source === "exact" ? "精确" : item.usage_source === "mixed" ? "混合" : item.usage_source === "estimated" ? "估算" : "无";
          const ok = Number(item.status) < 400 && Number(item.completed);
          return `<tr><td>${formatTime(Number(item.created_at))}<br><small class="muted">${escapeHtml(item.provider_name)} · ${escapeHtml(item.model)}</small></td><td class="num">${formatNumber(item.input_tokens)} / ${formatNumber(item.output_tokens)}</td><td class="num">${formatDuration(item.first_token_ms)}</td><td class="num">${formatDuration(item.duration_ms)}</td><td class="num">${item.output_tps == null ? "—" : Number(item.output_tps).toFixed(1)}</td><td><span class="status-dot ${ok ? "is-ok" : "is-bad"}"></span>${escapeHtml(String(item.status))} · ${source}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : '<p class="empty">暂无请求记录</p>';

  renderPagination("model", data.pagination.models, usagePaging.models);
  renderPagination("log", data.pagination.logs, usagePaging.logs);
}

function renderPagination(prefix, pagination, state) {
  const totalPages = Math.max(1, Math.ceil(Number(pagination.total) / Number(pagination.pageSize)));
  $(`#${prefix}PageInfo`).textContent = `${formatNumber(pagination.total)} 条 · 第 ${pagination.page}/${totalPages} 页`;
  $(`#${prefix}Prev`).disabled = Number(pagination.page) <= 1;
  $(`#${prefix}Next`).disabled = Number(pagination.page) >= totalPages;
  state.page = Number(pagination.page);
  state.pageSize = Number(pagination.pageSize);
}

async function refreshUsage(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "刷新中…";
  try {
    await loadUsage();
    notify("用量数据已刷新");
  } catch (error) {
    notify(error.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ------------------------------- 测试台 ------------------------------- */
function renderTestModelOptions() {
  const select = $("#testModel");
  const previous = select.value;
  const fragment = document.createDocumentFragment();
  const available = new Set();
  let count = 0;
  for (const provider of providersCache.filter((item) => item.enabled !== false)) {
    const enabledModels = provider.enabledModels ?? provider.models ?? [];
    if (!enabledModels.length) continue;
    const group = document.createElement("optgroup");
    group.label = provider.name;
    for (const model of enabledModels) {
      const publicId = `${provider.name}/${model}`;
      const option = document.createElement("option");
      option.value = publicId;
      option.textContent = `${provider.name} / ${model}`;
      group.append(option);
      available.add(publicId);
      count += 1;
    }
    fragment.append(group);
  }
  if (!count) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无已启用模型";
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  select.disabled = count === 0;
  if (available.has(previous)) select.value = previous;
}

$("#testForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || $("#testForm button[type=submit]");
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "发送中…";
  $("#testResult").textContent = "请求中…";
  try {
    const endpoint = $("#testEndpoint").value;
    const prompt = $("#testPrompt").value;
    const model = $("#testModel").value;
    const body =
      endpoint === "messages"
        ? { model, max_tokens: 512, messages: [{ role: "user", content: prompt }] }
        : endpoint === "responses"
          ? { model, input: prompt }
          : { model, messages: [{ role: "user", content: prompt }], max_tokens: 512 };
    const response = await fetch(`/v1/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${$("#testKey").value}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 保留原文（SSE 或纯文本） */
    }
    $("#testResult").textContent = `HTTP ${response.status}\n\n${pretty}`;
  } catch (error) {
    $("#testResult").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

/* ------------------------------- 事件绑定 ------------------------------- */
$$("[data-open]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.open === "providerDialog") resetProviderDialog();
    if (button.dataset.open === "keyDialog") resetKeyDialog();
    $(`#${button.dataset.open}`).showModal();
  }),
);

$$("[data-close]").forEach((button) =>
  button.addEventListener("click", () => {
    const dialog = button.closest("dialog");
    if (dialog) dialog.close();
  }),
);

$("#providerForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#saveProvider");
  submit.disabled = true;
  try {
    const providerId = $("#providerDialog").dataset.providerId;
    const type = $("#providerType").value;
    const models = $("#providerModels")
      .value.split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const freeModels = supportsFreeModelGroups(type)
      ? models.filter((model) => draftFreeModels.has(model) || isProviderFreeModelId(type, model))
      : [];
    const authMode = supportsAnonymous(type) ? $("#providerAuthMode").value : "bearer";
    const payload = {
      name: $("#providerName").value.trim(),
      type,
      authMode,
      apiKey: authMode === "none" ? undefined : $("#providerApiKey").value || undefined,
      baseUrl: $("#providerBaseUrl").value.trim() || undefined,
      models,
      freeModels,
    };
    await api(providerId ? `/admin/providers/${providerId}` : "/admin/providers", {
      method: providerId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetProviderDialog();
    $("#providerDialog").close();
    await loadProviders();
    notify(providerId ? "提供商已更新" : "提供商已添加");
  } catch (error) {
    notify(error.message, "bad");
  } finally {
    submit.disabled = false;
  }
});

$("#discoverDraft")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "正在连接…";
  $("#modelCount").textContent = "正在向提供商查询模型目录。";
  try {
    const result = await api("/admin/providers/discover", {
      method: "POST",
      body: JSON.stringify({
        id: $("#providerDialog").dataset.providerId,
        type: $("#providerType").value,
        authMode: supportsAnonymous($("#providerType").value) ? $("#providerAuthMode").value : "bearer",
        apiKey: $("#providerApiKey").value || undefined,
        baseUrl: $("#providerBaseUrl").value.trim() || undefined,
      }),
    });
    draftFreeModels = new Set(result.freeModels || []);
    $("#providerModels").value = (result.data || []).join("\n");
    $("#modelCount").textContent = `已获取 ${result.count} 个模型${result.freeCount ? `（${result.freeCount} 个免费）` : ""}。`;
    notify(`已获取 ${result.count} 个模型`);
  } catch (error) {
    $("#modelCount").textContent = error.message;
    notify(error.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

$("#keyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#saveKey");
  submit.disabled = true;
  try {
    const keyId = $("#keyDialog").dataset.keyId;
    const number = (selector) => {
      const raw = $(selector).value;
      return raw ? Number(raw) : keyId ? null : undefined;
    };
    const payload = {
      name: $("#keyName").value.trim(),
      key: keyId ? undefined : $("#customKey").value || undefined,
      requestsPerMinute: number("#keyRpm"),
      dailyRequestLimit: number("#keyDailyRequests"),
      monthlyTokenLimit: number("#keyMonthlyTokens"),
      maxOutputTokensPerRequest: number("#keyMaxOutputTokens"),
    };
    const data = await api(keyId ? `/admin/keys/${keyId}` : "/admin/keys", {
      method: keyId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    $("#keyDialog").close();
    if (keyId) {
      resetKeyDialog();
      notify("密钥限额已更新");
    } else {
      $("#revealedKey").textContent = data.key;
      $("#revealDialog").showModal();
      $("#keyForm").reset();
      resetKeyDialog();
    }
    await loadKeys();
  } catch (error) {
    notify(error.message, "bad");
  } finally {
    submit.disabled = false;
  }
});

$("#copyKey")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#revealedKey").textContent);
    notify("密钥已复制");
  } catch {
    notify("复制失败，请手动选中", "warn");
  }
});

$("#usageRange")?.addEventListener("change", () => {
  usagePaging.models.page = 1;
  usagePaging.logs.page = 1;
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#refreshUsage")?.addEventListener("click", (event) => refreshUsage(event.currentTarget));
$("#modelPageSize")?.addEventListener("change", (event) => {
  usagePaging.models.pageSize = Number(event.target.value);
  usagePaging.models.page = 1;
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#logPageSize")?.addEventListener("change", (event) => {
  usagePaging.logs.pageSize = Number(event.target.value);
  usagePaging.logs.page = 1;
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#modelPrev")?.addEventListener("click", () => {
  usagePaging.models.page = Math.max(1, usagePaging.models.page - 1);
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#modelNext")?.addEventListener("click", () => {
  usagePaging.models.page += 1;
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#logPrev")?.addEventListener("click", () => {
  usagePaging.logs.page = Math.max(1, usagePaging.logs.page - 1);
  loadUsage().catch((error) => notify(error.message, "bad"));
});
$("#logNext")?.addEventListener("click", () => {
  usagePaging.logs.page += 1;
  loadUsage().catch((error) => notify(error.message, "bad"));
});

$("#modelSearch")?.addEventListener("input", renderModelChoices);
$("#onlyFreeModels")?.addEventListener("change", renderModelChoices);
$("#modelChoices")?.addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (event.target.checked) modelSelection.add(event.target.value);
  else modelSelection.delete(event.target.value);
  updateModelSelectionCount();
});
$("#selectAllModels")?.addEventListener("click", () => {
  visibleModelCatalog().forEach((model) => modelSelection.add(model));
  renderModelChoices();
});
$("#clearAllModels")?.addEventListener("click", () => {
  visibleModelCatalog().forEach((model) => modelSelection.delete(model));
  renderModelChoices();
});
$("#providerType")?.addEventListener("change", () => {
  draftFreeModels.clear();
  $("#modelCount").textContent = "类型已更改，请重新获取模型。";
  syncAuthModeVisibility();
});
$("#providerAuthMode")?.addEventListener("change", syncProviderAuthMode);

$("#modelForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || $("#modelForm button[value=default]");
  button.disabled = true;
  try {
    const providerId = $("#modelDialog").dataset.providerId;
    const enabledModels = modelCatalog.filter((model) => modelSelection.has(model));
    await api(`/admin/providers/${providerId}`, { method: "PUT", body: JSON.stringify({ enabledModels }) });
    $("#modelDialog").close();
    await loadProviders();
    notify(`已启用 ${enabledModels.length} 个模型`);
  } catch (error) {
    notify(error.message, "bad");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const { editProvider, deleteProvider, discoverProvider, modelProvider, deleteKey, editKey, toggleKey } = target.dataset;
  try {
    if (editProvider) openProviderEditor(editProvider);
    else if (editKey) openKeyEditor(editKey);
    else if (modelProvider) openModelDialog(modelProvider);
    else if (discoverProvider) {
      target.disabled = true;
      const label = target.textContent;
      target.textContent = "获取中…";
      try {
        const result = await api(`/admin/providers/${discoverProvider}/discover`, { method: "POST" });
        await loadProviders();
        notify(`已刷新 ${result.count} 个模型`);
      } finally {
        target.disabled = false;
        target.textContent = label;
      }
    } else if (deleteProvider) {
      const provider = providersCache.find((item) => item.id === deleteProvider);
      if (!confirm(`确定删除提供商「${provider?.name || deleteProvider}」？该操作不可撤销。`)) return;
      await api(`/admin/providers/${deleteProvider}`, { method: "DELETE" });
      await loadProviders();
      notify("提供商已删除");
    } else if (toggleKey) {
      const key = keysCache.find((item) => item.id === toggleKey);
      if (!key) return;
      await api(`/admin/keys/${toggleKey}`, { method: "PUT", body: JSON.stringify({ enabled: !key.enabled }) });
      await loadKeys();
      notify(key.enabled ? "密钥已停用" : "密钥已启用");
    } else if (deleteKey) {
      const key = keysCache.find((item) => item.id === deleteKey);
      if (!confirm(`确定吊销密钥「${key?.name || deleteKey}」？使用该密钥的客户端将立即失效。`)) return;
      await api(`/admin/keys/${deleteKey}`, { method: "DELETE" });
      await loadKeys();
      notify("密钥已吊销");
    }
  } catch (error) {
    notify(error.message, "bad");
  }
});

/* 窗口尺寸变化时重绘图表 */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastUsageData && !$("#workspace").hidden) drawUsageChart(lastUsageData);
  }, 160);
});

/* ------------------------------- 启动 ------------------------------- */
bootAuth();
