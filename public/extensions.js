/* ==========================================================================
   LLMflare-Anon · 智能调度面板
   包含：免费模型筛选 / 路由组 / 额度 / 健康度 / 模型测试
   设计原则：
     1. 按需加载 —— 只请求当前子页签的数据，切走不重复拉取
     2. 增量渲染 —— 只重建受影响的容器，避免整页重排
     3. 零依赖 —— 不引入任何框架，首屏不额外阻塞
   ========================================================================== */

const TOKEN_KEY = "llm-anon-token";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const esc = (value) =>
  String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);

const currentToken = () => sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";

/* 与主控制台一致的轻提示 */
function toast(message, kind = "ok") {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind === "error" ? "bad" : kind;
  el.dataset.show = "true";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.dataset.show = "false"; }, 3600);
}

async function api(path, options = {}) {
  const token = currentToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || data.message || `HTTP ${response.status}`);
  return data;
}

/* --------------------------------- 状态 --------------------------------- */
const state = {
  ready: false,
  tab: "free",
  meta: null,
  preview: null,        // { providers: [...] }
  groups: [],           // 路由组草稿
  defaultGroupId: "",
  quota: null,
  health: null,
  testTarget: { providerId: "", model: "" },
  busy: false,
};

const loaded = { free: false, routes: false, quota: false, health: false, test: false };
const TABS = [
  { key: "free", label: "免费模型" },
  { key: "routes", label: "路由组" },
  { key: "quota", label: "额度" },
  { key: "health", label: "健康度" },
  { key: "test", label: "模型测试" },
];

/* -------------------------------- 徽标渲染 ------------------------------- */
function badgeOf(model) {
  const tier = model.badge?.tier || (model.free ? "verified" : "guess");
  const label = model.badge?.label || (model.free ? "免费" : "付费");
  return `<span class="fm-badge fm-badge--${esc(tier)}">${esc(label)}</span>`;
}

const pct = (value, limit) => {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((Number(value || 0) / Number(limit)) * 100));
};

function meter(used, limit, label) {
  if (!limit) return `<span class="muted">不限</span>`;
  const ratio = pct(used, limit);
  const tone = ratio >= 90 ? "bad" : ratio >= 70 ? "warn" : "ok";
  return `<div class="meter" title="${esc(label)}：${used} / ${limit}">
    <div class="meter-track"><i class="meter-bar meter-bar--${tone}" style="width:${ratio}%"></i></div>
    <small>${Number(used || 0)} / ${Number(limit)}</small>
  </div>`;
}

/* --------------------------------- 骨架 --------------------------------- */
function skeleton(rows = 3) {
  return Array.from({ length: rows }, () => `<div class="fm-skel" aria-hidden="true"></div>`).join("");
}

function ensureShell() {
  const host = $("#extBody");
  if (!host || state.ready) return;
  state.ready = true;

  host.innerHTML = `
    <div class="seg" role="tablist" aria-label="智能调度分区">
      ${TABS.map((tab) => `<button class="seg-btn${tab.key === state.tab ? " is-active" : ""}" role="tab" type="button" data-ext-tab="${tab.key}" aria-selected="${tab.key === state.tab}">${tab.label}</button>`).join("")}
    </div>
    <div id="extPaneFree" class="ext-pane" hidden></div>
    <div id="extPaneRoutes" class="ext-pane" hidden></div>
    <div id="extPaneQuota" class="ext-pane" hidden></div>
    <div id="extPaneHealth" class="ext-pane" hidden></div>
    <div id="extPaneTest" class="ext-pane" hidden></div>
  `;

  host.addEventListener("click", onShellClick);
  host.addEventListener("change", onShellChange);
  host.addEventListener("submit", onSubmit);
}

function showTab(tab) {
  state.tab = tab;
  $$(".seg-btn", $("#extBody")).forEach((btn) => {
    const active = btn.dataset.extTab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  for (const key of TABS.map((item) => item.key)) {
    const pane = $(`#extPane${key[0].toUpperCase()}${key.slice(1)}`);
    if (pane) pane.hidden = key !== tab;
  }
  loadTab(tab);
}

/* ------------------------------- 数据加载 ------------------------------- */
async function loadTab(tab, force = false) {
  if (loaded[tab] && !force) return;
  const pane = $(`#extPane${tab[0].toUpperCase()}${tab.slice(1)}`);
  if (pane) pane.innerHTML = `<div class="glass panel"><div class="fm-stack">${skeleton(4)}</div></div>`;
  try {
    if (tab === "free") await loadFree();
    if (tab === "routes") await loadRoutes();
    if (tab === "quota") await loadQuota();
    if (tab === "health") await loadHealth();
    if (tab === "test") await loadTest();
    loaded[tab] = true;
  } catch (error) {
    if (pane) {
      pane.innerHTML = `<div class="glass panel"><p class="fm-empty">加载失败：${esc(error.message)}</p>
        <button class="btn btn--soft btn--sm" type="button" data-ext-refresh="${tab}">重试</button></div>`;
    }
  }
}

async function loadMeta() {
  if (state.meta) return state.meta;
  const [meta, preview] = await Promise.all([
    api("/admin/ext/meta"),
    api("/admin/ext/free-models/preview"),
  ]);
  state.meta = meta;
  state.preview = preview;
  return meta;
}

/* ------------------------------ 1. 免费模型 ------------------------------ */
async function loadFree() {
  const data = state.preview || (await api("/admin/ext/free-models/preview"));
  state.preview = data;
  renderFree(data);
}

function renderFree(data) {
  const pane = $("#extPaneFree");
  if (!pane) return;
  const rows = data.providers || [];
  const totalFree = rows.reduce((sum, row) => sum + Number(row.freeCount || 0), 0);
  const totalModels = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);

  const cards = rows.length
    ? rows.map((row) => {
        const models = row.models || [];
        const freeOnes = models.filter((model) => model.free);
        return `
        <article class="glass panel fm-card">
          <header class="fm-card-head">
            <div>
              <h3>${esc(row.providerName)} ${row.enabled ? "" : '<span class="fm-badge fm-badge--guess">已停用</span>'}</h3>
              <p class="muted">${esc(row.type)} · 共 ${row.total} 个模型 · <strong>${row.freeCount}</strong> 个免费</p>
            </div>
            <button class="btn btn--soft btn--sm" type="button" data-ext-refresh-one="${esc(row.providerId)}">刷新该提供商</button>
          </header>
          ${freeOnes.length
            ? `<ul class="fm-models">${freeOnes.slice(0, 12).map((model) => `
                <li>
                  <code>${esc(model.model)}</code>
                  ${badgeOf(model)}
                  <small class="muted">${esc(model.reason || "")}</small>
                </li>`).join("")}
                ${freeOnes.length > 12 ? `<li class="muted">…另有 ${freeOnes.length - 12} 个免费模型</li>` : ""}
              </ul>`
            : `<p class="fm-empty">未识别到免费模型。可手动把模型加入该提供商的免费白名单。</p>`}
        </article>`;
      }).join("")
    : `<p class="fm-empty">还没有添加提供商。</p>`;

  pane.innerHTML = `
    <div class="toolbar">
      <p class="muted">识别规则：上游目录零价格 &gt; 手动白名单 &gt; 命名推断。刷新会把免费模型自动并入启用白名单。</p>
      <div class="fm-actions">
        <span class="pill">免费 ${totalFree} / 共 ${totalModels}</span>
        <button class="btn btn--primary btn--sm" type="button" data-ext-refresh-all>重新筛选全部</button>
      </div>
    </div>
    <div class="fm-grid">${cards}</div>
  `;
}

/* ------------------------------- 2. 路由组 ------------------------------- */
async function loadRoutes() {
  const [store, meta] = await Promise.all([api("/admin/ext/route-groups"), loadMeta()]);
  state.groups = store.groups || [];
  state.defaultGroupId = store.defaultGroupId || "";
  renderRoutes();
  return meta;
}

function providerOptions(selected) {
  const rows = state.preview?.providers || [];
  return rows.map((row) => `<option value="${esc(row.providerId)}"${row.providerId === selected ? " selected" : ""}>${esc(row.providerName)}</option>`).join("");
}

function renderRoutes() {
  const pane = $("#extPaneRoutes");
  if (!pane) return;
  const modes = state.meta?.routingModes || [];
  const providers = state.preview?.providers || [];

  const cards = state.groups.length
    ? state.groups.map((group, index) => `
      <article class="glass panel fm-card" data-group-index="${index}">
        <header class="fm-card-head">
          <div>
            <h3>${esc(group.name)} <code class="fm-id">group/${esc(group.id)}</code></h3>
            <p class="muted">成员 ${group.members.length} 个 · 最多尝试 ${group.maxAttempts} 次</p>
          </div>
          <div class="fm-actions">
            <button class="btn btn--ghost btn--sm" type="button" data-group-preview="${index}">演练</button>
            <button class="btn btn--ghost btn--sm" type="button" data-group-remove="${index}">删除</button>
          </div>
        </header>
        <div class="fm-form">
          <label class="field"><span>调度模式</span>
            <select data-group-field="mode" data-index="${index}">
              ${modes.map((mode) => `<option value="${esc(mode.value)}"${mode.value === group.mode ? " selected" : ""}>${esc(mode.label)}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span>最多尝试</span>
            <input type="number" min="1" max="10" value="${group.maxAttempts}" data-group-field="maxAttempts" data-index="${index}">
          </label>
          <label class="field fm-inline"><span>只走免费</span>
            <input type="checkbox" data-group-field="freeOnly" data-index="${index}"${group.freeOnly ? " checked" : ""}>
          </label>
        </div>
        <div class="fm-members">
          ${providers.map((row) => {
            const member = group.members.find((item) => item.providerId === row.providerId);
            return `<label class="fm-member">
              <input type="checkbox" data-member-provider="${esc(row.providerId)}" data-index="${index}"${member ? " checked" : ""}>
              <span>${esc(row.providerName)}</span>
              <input type="text" placeholder="留空=默认模型" value="${esc(member?.model || "")}" data-member-model="${esc(row.providerId)}" data-index="${index}">
            </label>`;
          }).join("") || `<p class="fm-empty">还没有可用提供商</p>`}
        </div>
        <div class="fm-preview" data-preview-slot="${index}"></div>
      </article>`).join("")
    : `<p class="fm-empty">还没有路由组。点「一键生成」会按现有提供商各建一组，或手动新建。</p>`;

  pane.innerHTML = `
    <div class="toolbar">
      <p class="muted">客户端用 <code>model: "group/&lt;id&gt;"</code> 走多上游调度；未建组时网关行为与原来完全一致。</p>
      <div class="fm-actions">
        <button class="btn btn--soft btn--sm" type="button" data-ext-bootstrap>一键生成</button>
        <button class="btn btn--primary btn--sm" type="button" data-ext-add-group>新建路由组</button>
        <button class="btn btn--soft btn--sm" type="button" data-ext-save-groups>保存全部</button>
      </div>
    </div>
    <label class="field fm-inline fm-default">
      <span>默认组（请求未指定模型时使用）</span>
      <select id="extDefaultGroup">
        <option value="">不启用</option>
        ${state.groups.map((group) => `<option value="${esc(group.id)}"${group.id === state.defaultGroupId ? " selected" : ""}>${esc(group.name)}</option>`).join("")}
      </select>
    </label>
    <div class="fm-grid">${cards}</div>
  `;
}

/* -------------------------------- 3. 额度 -------------------------------- */
async function loadQuota() {
  const [data, preview] = await Promise.all([
    api("/admin/ext/quota"),
    state.preview ? Promise.resolve(state.preview) : api("/admin/ext/free-models/preview"),
  ]);
  state.preview = preview;
  state.quota = data;
  renderQuota();
}

function renderQuota() {
  const pane = $("#extPaneQuota");
  if (!pane) return;
  const rows = state.quota?.quota || [];
  const providers = state.preview?.providers || [];
  const withQuota = new Map(rows.map((row) => [row.providerId, row]));

  const cards = providers.map((provider) => {
    const row = withQuota.get(provider.providerId);
    const policy = row?.policy || {};
    const snapshot = row || {};
    return `
      <article class="glass panel fm-card" data-quota-provider="${esc(provider.providerId)}">
        <header class="fm-card-head">
          <div><h3>${esc(provider.providerName)}</h3>
            <p class="muted">${row ? "已设置额度，超出后调度自动跳过" : "未设置额度（不限）"}</p>
          </div>
        </header>
        ${row ? `<div class="fm-meters">
          ${meter(snapshot.minuteUsed, snapshot.minuteLimit, "每分钟请求")}
          ${meter(snapshot.dayUsed, snapshot.dayLimit, "今日请求")}
          ${meter(snapshot.monthTokens, snapshot.monthTokenLimit, "本月 Token")}
          ${meter(snapshot.monthRequests, snapshot.monthRequestLimit, "本月请求")}
        </div>${snapshot.exhaustedBy ? `<p class="fm-empty">额度已耗尽（${esc(snapshot.exhaustedBy)}），${Math.ceil((snapshot.retryAfterMs || 0) / 1000)} 秒后重置，期间调度会自动跳过。</p>` : ""}` : ""}
        <div class="fm-form">
          <label class="field"><span>每分钟请求</span><input type="number" min="0" placeholder="不限" value="${policy.requestsPerMinute ?? ""}" data-quota-field="requestsPerMinute"></label>
          <label class="field"><span>每日请求</span><input type="number" min="0" placeholder="不限" value="${policy.dailyRequests ?? ""}" data-quota-field="dailyRequests"></label>
          <label class="field"><span>每月 Token</span><input type="number" min="0" placeholder="不限" value="${policy.monthlyTokens ?? ""}" data-quota-field="monthlyTokens"></label>
          <label class="field"><span>每月请求</span><input type="number" min="0" placeholder="不限" value="${policy.monthlyRequests ?? ""}" data-quota-field="monthlyRequests"></label>
        </div>
        <div class="fm-actions">
          <button class="btn btn--primary btn--sm" type="button" data-quota-save="${esc(provider.providerId)}">保存额度</button>
          <button class="btn btn--ghost btn--sm" type="button" data-quota-clear="${esc(provider.providerId)}">清除限制</button>
        </div>
      </article>`;
  }).join("");

  pane.innerHTML = `
    <div class="toolbar"><p class="muted">三层窗口：分钟级、日级、月级。额度用尽时调度直接跳过该提供商，不会硬发请求。</p></div>
    <div class="fm-grid">${cards || `<p class="fm-empty">还没有提供商。</p>`}</div>
  `;
}

/* ------------------------------- 4. 健康度 ------------------------------- */
async function loadHealth() {
  const data = await api("/admin/ext/health");
  state.health = data;
  renderHealth();
}

function renderHealth() {
  const pane = $("#extPaneHealth");
  if (!pane) return;
  const rows = state.health?.health || [];
  const tone = (item) => (item.circuit === "open" ? "bad" : item.circuit === "half-open" ? "warn" : "ok");

  const body = rows.length
    ? rows.map((item) => `
      <tr>
        <td><span class="status-dot" style="background:var(--${tone(item)}-ink, var(--ink-dim))"></span>${esc(item.providerName || item.providerId)}</td>
        <td>${esc(item.model || "全部模型")}</td>
        <td><span class="fm-badge fm-badge--${tone(item)}">${esc(item.circuit || "closed")}</span></td>
        <td>${item.consecutiveFailures ?? 0}</td>
        <td>${item.lastStatus ?? "—"}</td>
        <td>${item.retryAfterMs ? `${Math.ceil(item.retryAfterMs / 1000)}s` : "—"}</td>
        <td><button class="btn btn--ghost btn--sm" type="button" data-health-reset="${esc(item.providerId)}" data-health-model="${esc(item.model || "")}">重置</button></td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="fm-empty">暂无失败记录，所有通道健康。</td></tr>`;

  pane.innerHTML = `
    <div class="toolbar">
      <p class="muted">连续失败触发熔断，按指数退避自动恢复；半开状态会用一次真实请求探测。</p>
      <button class="btn btn--soft btn--sm" type="button" data-health-reset-all>全部重置</button>
    </div>
    <div class="glass panel table-slot">
      <table class="fm-table">
        <thead><tr><th>提供商</th><th>模型</th><th>状态</th><th>连续失败</th><th>最近状态码</th><th>恢复倒计时</th><th>操作</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

/* ------------------------------ 5. 模型测试 ------------------------------ */
async function loadTest() {
  state.preview = state.preview || (await api("/admin/ext/free-models/preview"));
  renderTest();
}

function renderTest() {
  const pane = $("#extPaneTest");
  if (!pane) return;
  const providers = state.preview?.providers || [];
  const active = providers.find((row) => row.providerId === state.testTarget.providerId) || providers[0];
  if (active && !state.testTarget.providerId) state.testTarget.providerId = active.providerId;
  const models = active?.models || [];
  const selectedModel = models.some((item) => item.model === state.testTarget.model) ? state.testTarget.model : models[0]?.model || "";
  state.testTarget.model = selectedModel;

  pane.innerHTML = `
    <div class="split split--even">
      <article class="glass panel">
        <header class="panel-head"><h3>单模型测试</h3></header>
        <div class="fm-form">
          <label class="field"><span>提供商</span>
            <select id="extTestProvider">${providerOptions(state.testTarget.providerId)}</select>
          </label>
          <label class="field"><span>模型</span>
            <select id="extTestModel">${models.map((item) => `<option value="${esc(item.model)}"${item.model === selectedModel ? " selected" : ""}>${esc(item.model)}${item.free ? " · 免费" : ""}</option>`).join("")}</select>
          </label>
          <label class="field"><span>提示词</span><input id="extTestPrompt" type="text" value="你好，请用一句话自我介绍"></label>
        </div>
        <div class="fm-actions">
          <button class="btn btn--primary btn--sm" type="button" data-ext-test-one>测试当前模型</button>
          <button class="btn btn--soft btn--sm" type="button" data-ext-test-all>批量测试全部</button>
        </div>
        <div id="extTestResult" class="fm-result muted">等待测试…</div>
      </article>
      <article class="glass panel">
        <header class="panel-head"><h3>说明</h3></header>
        <ul class="fm-tips">
          <li>测试会真实发起一次最小请求，消耗少量上游额度。</li>
          <li>返回首字延迟、总耗时与回复摘要，用于判断通道是否可用。</li>
          <li>测试结果不会写入用量统计，也不影响熔断状态。</li>
        </ul>
      </article>
    </div>
  `;
}

/* -------------------------------- 交互 -------------------------------- */
function onShellClick(event) {
  const tabBtn = event.target.closest("[data-ext-tab]");
  if (tabBtn) return showTab(tabBtn.dataset.extTab);

  const retry = event.target.closest("[data-ext-refresh]");
  if (retry) return loadTab(retry.dataset.extRefresh, true);

  if (event.target.closest("[data-ext-refresh-all]")) return refreshAll();
  const one = event.target.closest("[data-ext-refresh-one]");
  if (one) return refreshOne(one.dataset.extRefreshOne);

  if (event.target.closest("[data-ext-bootstrap]")) return bootstrapGroups();
  if (event.target.closest("[data-ext-add-group]")) return addGroup();
  if (event.target.closest("[data-ext-save-groups]")) return saveGroups();

  const remove = event.target.closest("[data-group-remove]");
  if (remove) {
    state.groups.splice(Number(remove.dataset.groupRemove), 1);
    return renderRoutes();
  }

  const preview = event.target.closest("[data-group-preview]");
  if (preview) return previewGroup(Number(preview.dataset.groupPreview));

  const quotaSave = event.target.closest("[data-quota-save]");
  if (quotaSave) return saveQuota(quotaSave.dataset.quotaSave);
  const quotaClear = event.target.closest("[data-quota-clear]");
  if (quotaClear) return clearQuota(quotaClear.dataset.quotaClear);

  if (event.target.closest("[data-health-reset-all]")) return resetHealthAll();
  const reset = event.target.closest("[data-health-reset]");
  if (reset) return resetHealthOne(reset.dataset.healthReset, reset.dataset.healthModel);

  if (event.target.closest("[data-ext-test-one]")) return testOne();
  if (event.target.closest("[data-ext-test-all]")) return testAll();
}

function onShellChange(event) {
  const el = event.target;

  if (el.dataset.groupField) {
    const group = state.groups[Number(el.dataset.index)];
    if (!group) return;
    const field = el.dataset.groupField;
    if (field === "freeOnly") group.freeOnly = el.checked;
    else if (field === "maxAttempts") group.maxAttempts = Math.max(1, Math.min(10, Number(el.value) || 3));
    else group[field] = el.value;
    return;
  }

  if (el.dataset.memberProvider) {
    const group = state.groups[Number(el.dataset.index)];
    if (!group) return;
    const providerId = el.dataset.memberProvider;
    if (el.checked) {
      if (!group.members.some((item) => item.providerId === providerId)) group.members.push({ providerId });
    } else {
      group.members = group.members.filter((item) => item.providerId !== providerId);
    }
    return;
  }

  if (el.dataset.memberModel) {
    const group = state.groups[Number(el.dataset.index)];
    if (!group) return;
    const member = group.members.find((item) => item.providerId === el.dataset.memberModel);
    if (member) member.model = el.value.trim() || undefined;
    return;
  }

  if (el.id === "extDefaultGroup") {
    state.defaultGroupId = el.value;
    return;
  }

  if (el.id === "extTestProvider") {
    state.testTarget = { providerId: el.value, model: "" };
    return renderTest();
  }

  if (el.id === "extTestModel") {
    state.testTarget.model = el.value;
  }
}

function onSubmit(event) {
  event.preventDefault();
}

/* ------------------------------ 免费模型动作 ----------------------------- */
async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  toast("正在筛选免费模型…");
  try {
    const data = await api("/admin/ext/free-models/refresh", { method: "POST", body: JSON.stringify({ autoEnableFree: true }) });
    const summary = data.summary || {};
    toast(`完成：${summary.providers || 0} 个提供商，识别 ${summary.totalFree || 0} 个免费模型${summary.failed ? `，${summary.failed} 个失败` : ""}`);
    delete state.preview;
    loaded.free = false;
    await loadFree();
    loaded.free = true;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
  }
}

async function refreshOne(providerId) {
  if (state.busy) return;
  state.busy = true;
  toast("正在刷新该提供商的免费模型…");
  try {
    const data = await api("/admin/ext/free-models/refresh-one", { method: "POST", body: JSON.stringify({ providerId, autoEnableFree: true }) });
    toast(`完成：该提供商共 ${data.providerModels ?? 0} 个模型，${data.report?.freeCount ?? 0} 个免费`);
    delete state.preview;
    loaded.free = false;
    await loadFree();
    loaded.free = true;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
  }
}

/* ------------------------------- 路由组动作 ------------------------------ */
async function bootstrapGroups() {
  try {
    const data = await api("/admin/ext/route-groups/bootstrap", { method: "POST" });
    state.groups = data.groups || [];
    state.defaultGroupId = data.defaultGroupId || "";
    renderRoutes();
    toast(`已生成 ${state.groups.length} 个路由组`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function addGroup() {
  const index = state.groups.length + 1;
  const providers = state.preview?.providers || [];
  state.groups.push({
    id: `group-${Date.now().toString(36)}`,
    name: `路由组 ${index}`,
    enabled: true,
    mode: "smart",
    members: providers.slice(0, 2).map((row) => ({ providerId: row.providerId })),
    maxAttempts: 3,
    firstByteTimeoutMs: 30000,
    freeOnly: false,
  });
  renderRoutes();
}

async function saveGroups() {
  try {
    const data = await api("/admin/ext/route-groups", {
      method: "PUT",
      body: JSON.stringify({ groups: state.groups, defaultGroupId: state.defaultGroupId || undefined }),
    });
    state.groups = data.groups || state.groups;
    state.defaultGroupId = data.defaultGroupId || "";
    renderRoutes();
    toast("路由组已保存");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function previewGroup(index) {
  const group = state.groups[index];
  const slot = $(`[data-preview-slot="${index}"]`);
  if (!group || !slot) return;
  slot.innerHTML = `<p class="muted">演练中…</p>`;
  try {
    await saveGroupsSilently();
    const data = await api(`/admin/ext/route-preview?groupId=${encodeURIComponent(group.id)}`);
    slot.innerHTML = `
      <p class="muted">模式：${esc(data.group?.modeLabel || data.group?.mode || "")}</p>
      <ol class="fm-steps">
        ${(data.attempts || []).map((item) => `<li><strong>${esc(item.providerName)}</strong> · <code>${esc(item.model)}</code>
          ${item.free ? '<span class="fm-badge fm-badge--verified">免费</span>' : ""}
          <small class="muted">${esc(item.reason || "")}</small></li>`).join("") || `<li class="muted">没有可用通道</li>`}
      </ol>
      ${(data.skipped || []).length ? `<p class="muted">跳过：${(data.skipped || []).map((item) => esc(item.reason)).join("；")}</p>` : ""}
    `;
  } catch (error) {
    slot.innerHTML = `<p class="fm-empty">演练失败：${esc(error.message)}</p>`;
  }
}

async function saveGroupsSilently() {
  const data = await api("/admin/ext/route-groups", {
    method: "PUT",
    body: JSON.stringify({ groups: state.groups, defaultGroupId: state.defaultGroupId || undefined }),
  });
  state.groups = data.groups || state.groups;
  return data;
}

/* -------------------------------- 额度动作 ------------------------------ */
function quotaCard(providerId) {
  return $(`[data-quota-provider="${providerId}"]`);
}

async function saveQuota(providerId) {
  const card = quotaCard(providerId);
  if (!card) return;
  const quota = {};
  $$("[data-quota-field]", card).forEach((input) => {
    const value = Number(input.value);
    if (input.value !== "" && Number.isFinite(value) && value > 0) quota[input.dataset.quotaField] = value;
  });
  try {
    await api("/admin/ext/quota", { method: "PUT", body: JSON.stringify({ providerId, quota }) });
    toast("额度已保存");
    loaded.quota = false;
    await loadQuota();
    loaded.quota = true;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearQuota(providerId) {
  try {
    await api("/admin/ext/quota", { method: "PUT", body: JSON.stringify({ providerId, quota: {} }) });
    toast("已清除该提供商的额度限制");
    loaded.quota = false;
    await loadQuota();
    loaded.quota = true;
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ------------------------------- 健康度动作 ----------------------------- */
async function resetHealthOne(providerId, model) {
  try {
    await api("/admin/ext/health/reset", { method: "POST", body: JSON.stringify({ providerId, model: model || undefined }) });
    toast("已重置该通道");
    await loadHealth();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function resetHealthAll() {
  try {
    const data = await api("/admin/ext/health/reset", { method: "POST", body: JSON.stringify({ all: true }) });
    toast(`已重置 ${data.reset ?? 0} 个提供商`);
    await loadHealth();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ------------------------------- 测试动作 ------------------------------- */
function testResultBox(html) {
  const box = $("#extTestResult");
  if (box) {
    box.classList.remove("muted");
    box.innerHTML = html;
  }
}

async function testOne() {
  const { providerId, model } = state.testTarget;
  if (!providerId || !model) return toast("请先选择提供商与模型", "error");
  const prompt = $("#extTestPrompt")?.value || "你好";
  testResultBox(`<p class="muted">测试中…</p>`);
  try {
    const data = await api("/admin/ext/models/test", { method: "POST", body: JSON.stringify({ providerId, model, prompt }) });
    const result = data.result || data;
    testResultBox(`
      <p><span class="fm-badge fm-badge--${result.ok ? "ok" : "bad"}">${result.ok ? "可用" : "失败"}</span>
        ${result.latencyMs != null ? `<span class="muted">首字 ${result.latencyMs} ms</span>` : ""}</p>
      ${result.reply ? `<pre class="code-out">${esc(result.reply).slice(0, 1200)}</pre>` : `<p class="fm-empty">${esc(result.error || result.message || "无回复")}</p>`}
    `);
  } catch (error) {
    testResultBox(`<p class="fm-empty">测试失败：${esc(error.message)}</p>`);
  }
}

async function testAll() {
  testResultBox(`<p class="muted">批量测试中，可能需要几十秒…</p>`);
  try {
    const data = await api("/admin/ext/models/test", { method: "POST", body: JSON.stringify({}) });
    const summary = data.summary || {};
    const rows = summary.results || summary.items || [];
    testResultBox(`
      <p class="muted">共 ${summary.total ?? rows.length ?? 0} 项，成功 ${summary.passed ?? 0}，失败 ${summary.failed ?? 0}${summary.freePassed ? `（其中免费模型可用 ${summary.freePassed}）` : ""}</p>
      <table class="fm-table">
        <thead><tr><th>提供商</th><th>模型</th><th>结果</th><th>延迟</th></tr></thead>
        <tbody>${rows.slice(0, 50).map((item) => `<tr>
          <td>${esc(item.providerName || item.providerId || "")}</td>
          <td><code>${esc(item.model || "")}</code></td>
          <td><span class="fm-badge fm-badge--${item.ok ? "ok" : "bad"}">${item.ok ? "可用" : "失败"}</span></td>
          <td>${item.latencyMs != null ? `${item.latencyMs} ms` : "—"}</td>
        </tr>`).join("")}</tbody>
      </table>
    `);
  } catch (error) {
    testResultBox(`<p class="fm-empty">批量测试失败：${esc(error.message)}</p>`);
  }
}

/* -------------------------------- 启动 -------------------------------- */
function activate() {
  ensureShell();
  showTab(state.tab);
}

window.addEventListener("llm:view", (event) => {
  if (event.detail === "extensions") activate();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    if ($(".view.is-active")?.dataset.view === "extensions") activate();
  });
} else if ($(".view.is-active")?.dataset.view === "extensions") {
  activate();
}
