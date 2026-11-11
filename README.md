# LLMflare-Anon

> **本项目是 [LLMflare](https://github.com/Jiao77/LLMflare) 的独立二次开发版本（derivative work），并非官方分支。**
>
> - **原作者**：[Jiao77](https://github.com/Jiao77)　**原项目**：https://github.com/Jiao77/LLMflare
> - **原始许可证**：[MIT](https://github.com/Jiao77/LLMflare/blob/main/LICENSE)，本项目同样以 MIT 发布，完整保留原始版权声明（见 `LICENSE`）。
> - **二改内容**：为 Provider 增加显式 `authMode` 字段，支持「无鉴权 / 匿名上游」。除此之外未改动任何网关核心逻辑。
> - **同步策略**：刻意**不启用 GitHub 的 Sync fork**。本项目以上游某一提交为基线后独立演进，不自动、也不定期合并上游变更。需要上游修复时请手动比对 `git diff upstream/main` 后择优 cherry-pick。
> - **问题反馈**：本二改引入的问题请反馈到本项目仓库，不要打扰原作者。原项目文档、截图、CI 配置的贡献者仍为原作者。

---

部署在 Cloudflare Workers 上的免费 LLM API 聚合网关。把 Gemini、Groq、OpenRouter、NVIDIA、Workers AI 等供应商集中到一个 Base URL，通过统一的 OpenAI / Anthropic 兼容接口调用。

Free LLM API aggregator powered by Cloudflare Workers. Run multiple providers behind one OpenAI and Anthropic compatible endpoint without hosting a local service or VPS.

`免费 AI 聚合` · `Cloudflare Workers` · `不占本机资源` · `国内网络访问` · `自定义域名` · `OpenAI / Anthropic Compatible`

## 本二改版本新增：无鉴权（匿名）上游

部分自建或第三方中转的 OpenAI-compatible 上游**不需要 API Key**，甚至只要看到 `Authorization` 头就返回 401。原版 LLMflare 无法接入这类上游：模型发现的入口硬校验会拒绝空 Key，编辑表单又无法真正清空已存的 Key。本版本新增一个显式字段解决它。

### 改动清单（5 个文件）

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `ProviderAuthMode = "bearer" \| "none"`，`Provider` 增加可选字段 `authMode` |
| `src/providers.ts` | 新增 `providerAuthMode()` / `providerRequiresApiKey()`；模型发现入口改用 `providerRequiresApiKey()` 判定；模型目录请求改为**条件**加 `Authorization` 头；`upstreamHeaders()` 增加 `authMode !== "none"` 兜底 |
| `src/admin.ts` | `discover` / `POST` / `PUT` 三处归一化 `authMode`；`authMode === "none"` 时服务端强制 `apiKey = undefined` |
| `public/index.html` | 提供商弹窗新增「鉴权方式」下拉；API Key 的 label + input 包进 `#providerKeyField` |
| `public/app.js` | 鉴权方式与 Key 输入框联动隐藏；提交 payload 增加 `authMode`；Provider 列表状态新增「匿名访问」 |

`src/store.ts` 与 `src/index.ts` 的路由逻辑**未改动**。`authMode` 为非敏感字段，会自动经 `PublicProvider` 透传到前端；老数据没有该字段时按 `bearer` 处理，**无需数据迁移**。

### 行为保证

1. **Key 不会复活**：只要 `authMode` 是 `none`，`PUT` 一律把 `apiKey` 置为 `undefined`，无论前端提交什么。
2. **Key 不会外发**：`upstreamHeaders()` 的判断是 `authMode !== "none" && apiKey` —— 即使有人手工在 KV 里塞回 Key，也不会发给上游。
3. **可以自动获取模型**：匿名模式下点「自动获取模型」不再报「请先填写提供商 API Key」。
4. **状态自解释**：列表里显示「匿名访问」，而不是误导性的「缺少密钥」。

### 没有 Key 时到底发了什么

匿名 Provider 的上游请求**完全不带 `Authorization` 头**（不是 `Bearer undefined`，也不是空值）。如果你的上游另有自定义鉴权方式（例如 `X-Api-Key` 或固定 `Referer`），本版本未提供自定义请求头能力，需要自行扩展 `upstreamHeaders()`。

### 适用范围

「鉴权方式」下拉**只对 `OpenAI Compatible` 类型出现**。其他内置类型（Google / Groq / NVIDIA / OpenRouter / SiliconFlow / 智谱 / Mistral / Workers AI）的鉴权方式各不相同，且匿名接入通常没有实际价值，故不开放，避免误配。

### 快速上手

1. 后台 → AI 提供商 → 新增，类型选 `OpenAI Compatible`
2. 「鉴权方式」选「无鉴权 / 匿名上游」→ API Key 输入框自动消失
3. 填 Base URL（例如 `https://example.com/v1`）→ 点「自动获取模型」
4. 勾选需要的模型 → 保存
5. 列表应显示「匿名访问」

> 匿名模式**不等于**免客户端密钥。网关自身的 `llmf_` 客户端访问密钥体系完全不变，`/v1/*` 仍需 `Authorization: Bearer llmf_xxx`。这里取消的只是「网关 → 上游」这一段的鉴权。

## LLMflare 解决什么问题

- **聚合免费 AI 供应商**：集中管理不同平台提供的免费模型、免费额度和 API Key，部分 Provider 支持自动筛选免费模型。
- **不占用本机资源**：网关运行在 Cloudflare Workers，无需在电脑、NAS 或 VPS 上常驻进程，也不消耗本机算力和带宽处理上游请求。
- **更方便地访问国外 API**：客户端只连接自己的 Worker 或自定义域名，上游请求由 Cloudflare 网络发起；在许多国内网络环境中可以直接使用原本难以连接的国外 API，无需在客户端配置代理。
- **支持自定义域名**：可以绑定自己的域名作为统一 API 地址，也可以直接使用 Cloudflare 提供的 `*.workers.dev` 地址。
- **一个 Base URL 接入多个厂商**：统一管理 Provider、API Key 和开放模型，切换供应商时无需反复修改客户端地址。
- **兼容常用协议**：支持 OpenAI Chat Completions、Responses 与 Anthropic Messages。
- **原样流式转发**：上游流式响应直接传给客户端，并在旁路记录首字延迟、TPS 和 Token。
- **模型白名单**：只向客户端暴露已勾选的模型，部分 Provider 支持只看免费模型。
- **隐私优先**：不保存 Prompt 和模型回复；统计只记录模型、Token、耗时和状态等元数据。
- **免费模型自动识别**：按「上游价格 > 实测 > 白名单 > 命名」四级证据打标，免费模型自动进入白名单。
- **多上游故障转移**：把多个 Provider 编成路由组，客户端用 `group/<id>` 调用，撞限流自动换通道。
- **额度感知调度**：分钟/日/月三层窗口，请求前预留、失败整笔回滚，并发不超发。
- **健康度熔断**：连续失败按指数退避拉黑，恢复后自动放回，面板可见状态与倒计时。

> [!WARNING]
> LLMflare 也可以接入按量计费或充值余额的 API 服务，但更建议只添加免费 API 或单独申请的低额度 Key。Provider Key 需要保存在部署者自己的 Cloudflare KV 中；若管理凭据、客户端密钥或部署环境泄露，攻击者可能消耗付费额度并造成财产损失。请勿使用绑定高额余额或无限制付款方式的生产 Key。

![管理员登录（账号密码 + 会话）](docs/images/login.png)

![LLMflare-Anon 用量总览](docs/images/dashboard.png)

![Provider 免费模型筛选与白名单](docs/images/model-selection.png)

> 截图使用演示数据，不包含真实 API Key、域名配置或个人用量。

## 请求架构

LLMflare 把客户端鉴权、模型路由、协议适配和用量统计放在同一个 Worker 中。客户端只持有 `llmf_` 访问密钥；Provider Key 留在部署者自己的 Cloudflare KV，Prompt 与回复正文不会写入 D1。

```mermaid
flowchart LR
    Client[OpenAI SDK / Codex / Claude Code] -->|HTTPS + llmf_ key| Worker[LLMflare Worker]
    Worker --> Auth[客户端密钥鉴权]
    Auth --> Route[按 Provider/模型白名单路由]
    Route --> Adapt{接口与上游能力匹配?}
    Adapt -->|匹配| Pass[原生流式转发]
    Adapt -->|不匹配| Convert[请求与 SSE 事件转换]
    Pass --> Providers[Gemini / Groq / OpenRouter / NVIDIA / Workers AI / ...]
    Convert --> Providers
    Providers -->|JSON 或 SSE| Worker
    Worker -. 元数据 .-> D1[(D1 用量统计)]
    Worker -->|JSON 或逐事件 SSE| Client
    KV[(KV: Provider 配置与 Key)] -.-> Route
```

请求不会先缓冲完整回复再返回。流式转换器读取一个上游 SSE 事件就生成对应的客户端事件，同时旁路计算首字延迟、耗时、Token 和 TPS。

## 3 分钟快速开始

需要 Node.js 20+、Cloudflare 账号，以及至少一个 AI Provider 的 API Key。建议先使用带免费额度的 Provider 完成部署和测试。

```bash
git clone https://github.com/Jiao77/LLMflare.git
cd LLMflare
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create CONFIG
npx wrangler d1 create llmflare-usage
```

Windows PowerShell 请将复制命令改为：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

把命令输出的 KV、D1 ID 填入 `wrangler.jsonc`，然后执行：

```bash
npx wrangler d1 migrations apply USAGE --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

打开 Worker 地址，首次访问会进入「初始化管理员账号」页面：填入用户名、自定义密码和 `ADMIN_TOKEN` 完成建号，随后用账号密码登录后台并添加 Provider。`ADMIN_TOKEN` 只在建号与应急时使用，日常不再需要输入。完整部署、安全配置和自定义域名说明见下方。

> 本版本把原来的「单凭 `ADMIN_TOKEN` 登录」改为**账号密码 + 会话**：口令以 PBKDF2-SHA256 加盐摘要保存，会话令牌仅存哈希并复用既有 KV 命名空间，无需新增任何 Cloudflare 资源。

## 兼容接口

| 接口 | 协议 | 流式传输 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | 支持 |
| `POST /v1/responses` | OpenAI Responses | 支持 |
| `POST /v1/messages` | Anthropic Messages | 支持 |
| `GET /v1/models` | OpenAI Models | — |

客户端使用后台生成的访问密钥：

```http
Authorization: Bearer llmf_your_client_key
```

模型名使用 `供应商名称/上游模型 ID`，例如：

```json
{
  "model": "Groq/openai/gpt-oss-20b",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

Chat Completions 默认直接转发；Responses 在上游原生接口可用时直接透传，其他 Responses 与 Messages 请求走协议适配。转换流不会等待完整回复，而是按事件逐个转换并立即发送给客户端。

```mermaid
flowchart LR
    Client[客户端] --> Gateway[LLMflare<br/>鉴权 · 模型路由]
    Gateway --> Chat[Chat Completions]
    Gateway --> Responses[Responses]
    Gateway --> Messages[Messages]
    Chat -->|直接转发| Provider[上游 Provider]
    Responses -->|原生接口可用| Provider
    Responses -->|否则| Adapter[逐事件流式转换]
    Messages --> Adapter
    Adapter -->|Chat Completions| Provider
    Provider -->|JSON / SSE| Client
```

Responses 适配包括 `instructions`、`input`、reasoning effort 和函数工具；Messages 适配包括 system prompt、文本/图片内容块、`tool_use`、`tool_result`、`tool_choice` 与 Anthropic SSE 事件。

> [!NOTE]
> 协议适配优先保证文本、多模态消息和函数工具调用。Responses 的 Web Search、File Search、Computer Use 等非 `function` 内建工具不会转发给只支持 Chat Completions 的上游；最终能力也受所选模型和 Provider 限制。

## Codex / Claude Code 专项适配

### Codex

Codex 当前使用 Responses 协议接入自定义 Provider。LLMflare 针对 Codex 请求做了以下兼容处理：

- 接收 `instructions`、Responses `input`、`reasoning.effort` 与函数工具定义。
- 在 Chat-only 上游中转换 system/user/tool 消息，并把 `reasoning.effort` 映射为 `reasoning_effort`。
- 过滤上游不支持的 Responses 专属字段，避免兼容接口直接返回参数错误。
- 将文本增量、函数名和分段 JSON 参数转换为带连续 `sequence_number` 的 Responses SSE 事件。
- 客户端中断连接时同步取消上游读取，减少无效请求与免费额度浪费。

```mermaid
flowchart LR
    Codex[Codex<br/>Responses + function tools] --> Gateway[LLMflare /v1/responses]
    Gateway --> Normalize[输入规范化<br/>instructions / input / reasoning]
    Normalize --> ToolMap[function_call 与 tool output 映射]
    ToolMap --> Upstream[免费或自建 Chat 模型]
    Upstream --> StreamMap[文本与工具参数<br/>逐事件转 Responses SSE]
    StreamMap --> Codex
```

在 `~/.codex/config.toml` 中增加自定义 Provider。`model` 必须填写管理后台 `/v1/models` 返回的完整名称：

```toml
model = "NVIDIA/openai/gpt-oss-120b"
model_provider = "llmflare"

[model_providers.llmflare]
name = "LLMflare"
base_url = "https://llm.example.com/v1"
env_key = "LLMFLARE_API_KEY"
wire_api = "responses"
```

再从启动 Codex 的同一个终端注入客户端密钥：

```bash
export LLMFLARE_API_KEY="llmf_your_client_key"
codex
```

Provider 配置字段可参考 [Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)。不要把客户端密钥直接写入 `config.toml` 或提交到仓库。

### Claude Code

Claude Code 使用 Anthropic Messages 协议。LLMflare 为这类长会话补齐了工具调用双向转换、Anthropic SSE 事件、错误类型映射，并为 NVIDIA Messages 请求设置 60 秒首字节截止时间，避免上游 524/长时间无响应让 Agent 一直挂起。

```mermaid
flowchart LR
    Claude[Claude Code<br/>Messages + tool_use] --> Gateway[LLMflare /v1/messages]
    Gateway --> RequestMap[system / content blocks<br/>tool_use / tool_result 转换]
    RequestMap --> Upstream[OpenAI-compatible Provider]
    Upstream --> ResponseMap[tool_calls / finish_reason<br/>错误与 SSE 事件转换]
    ResponseMap --> Claude
```

先在当前终端测试。`ANTHROPIC_BASE_URL` 填域名根地址，不要附加 `/v1`：

```bash
export ANTHROPIC_BASE_URL="https://llm.example.com"
export ANTHROPIC_AUTH_TOKEN="llmf_your_client_key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

启动后可用 `/model` 选择 LLMflare 暴露的 `Provider/模型`，再用 `/status` 确认 Base URL 与 `ANTHROPIC_AUTH_TOKEN` 已生效。若要持久化，可将这些变量放进 `~/.claude/settings.json` 的 `env`，但不要写入会提交的项目级设置。详见 [Claude Code: Connect to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)。

## 支持的 Provider

| Provider | 自动获取模型 | 免费模型筛选 | 备注 |
| --- | ---: | ---: | --- |
| Google AI Studio | ✓ | — | Gemini API |
| Groq | ✓ | — | OpenAI-compatible |
| OpenRouter | ✓ | ✓ | 按价格信息识别免费模型 |
| NVIDIA NIM | ✓ | ✓ | OpenAI-compatible |
| Cloudflare Workers AI | ✓ | — | 支持 REST API Token + Account ID，也支持原生 AI Binding |
| SiliconFlow | ✓ | ✓ | OpenAI-compatible |
| 智谱 BigModel | ✓ | ✓ | OpenAI-compatible |
| Mistral | ✓ | — | 可见模型可能消耗套餐额度或按量计费，不自动判断免费 |
| 自定义 OpenAI-compatible | 视上游而定 | — | 可配置 Base URL |

免费模型筛选依赖各平台模型目录返回的价格、标签或命名信息；平台规则变化时，识别结果也可能变化。是否免费及额度大小始终以上游官方说明为准。项目允许添加收费 API，但出于密钥泄露和意外扣费风险，更建议仅接入免费服务或设置了严格额度限制的专用 Key。

Mistral 的模型目录只表示当前账户可访问的模型，不提供足以证明零价格的信息，因此 LLMflare 不会把整个目录标记为免费。免费套餐中的月度额度与“模型本身免费”是两件事；是否继续按量计费取决于账户的 Pay-as-you-go 设置。

## 管理后台

- 新增、编辑和删除 Provider
- 修改显示名称、API Key、Base URL 与 Account ID
- 自动获取模型并按分组筛选
- 勾选允许通过网关访问的模型
- 生成、自定义、停用和删除客户端访问密钥
- 为每个客户端密钥设置 RPM、过去 24 小时请求、本月 Token 与单次最大输出 Token 限制
- 在线测试兼容接口
- 按 Provider 和模型查看 Token、请求数、成功率、首字延迟与 TPS
- **智能调度面板**（侧边栏「智能调度」）：免费模型筛选、路由组、额度、健康度与批量测试

## 智能调度（本版新增）

在侧边栏「智能调度」中集中管理五件事，全部复用后台既有的账号会话，不新增登录方式。

> 完整判定规则、七种调度模式的排序逻辑、额度的预留/结算机制与常见问题，见 **[docs/智能调度使用指南.md](docs/智能调度使用指南.md)**。

### 1. 免费模型筛选与标记

按四级证据给每个模型打标，点「重新筛选全部」会拉取上游模型目录并把免费模型自动并入启用白名单：

| 徽标 | 含义 | 判定依据 |
| --- | --- | --- |
| 免费 | 已证实 | 上游目录标注零价格，或实测探测可用 |
| 免费·白名单 | 你声明的 | 在提供商配置里手动声明为免费 |
| 免费·推断 | 按命名推断 | OpenRouter `:free`、智谱 flash、Gemini Flash 等官方免费档命名 |
| 付费 | 未命中 | 没有命中任何免费规则 |

判定优先级：上游目录/价格 > 实测探测 > 用户白名单 > 命名规则。免费模型同时并入启用列表，所以在客户端 `/v1/models` 里能直接看到。

### 2. 路由组与故障转移

随手建一个路由组，把多个 Provider 编成一组，客户端用 `model: "group/<组ID>"` 调用即可获得自动故障转移：

```
{
  "model": "group/main",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

路由组会以 `group/<id>` 的形式出现在 `/v1/models` 列表里，Claude Code、Codex 等客户端可以直接在模型下拉里选到。

七种调度模式：

| 模式 | 行为 |
| --- | --- |
| `smart` | 免费优先 → 额度余量最多 → 手动权重 → 原顺序（默认） |
| `order` | 严格按组内成员顺序 |
| `rotate` | 按游标轮转起点，把流量摊到各成员 |
| `usage` | 本月已用 Token 最少者优先 |
| `pace` | 额度使用比例最低者优先，兼顾重置时间 |
| `free-first` | 免费模型一律排前 |
| `cheapest` | 按成本档位：免费 → 匿名 → Workers AI → 自带 Key |

故障转移的判定规则：

- 可重试并切换：`429` 限流、`408/504/524` 超时、`5xx`、网络错误、未知错误。
- 立即切换但不重试：`401/403` 鉴权失败、额度耗尽。
- 不切换直接返回：`400` 参数错误（重试只会得到同样结果，白白消耗额度）。

组内最多尝试成员数、首字节超时、是否「只走免费」都可以在面板里单独设置。**没有创建任何路由组时，网关行为与升级前完全一致**，不会影响既有调用。

### 3. 额度调度

给每个 Provider 单独设置三层窗口：每分钟请求数、每日请求数、本月 Token、本月请求数。任意一层用尽，调度会直接跳过该通道并说明重置时间，不会硬着头皮去撞墙。

请求前先「预留」额度，成功后用真实用量校正，失败则整笔回滚——并发场景下也不会超发。

### 4. 健康度与熔断

连续失败会触发熔断并按指数退避（15 秒起，上限 10 分钟），冷却结束后进入半开状态，用一次真实请求探测是否恢复。面板里能看到每个通道的熔断状态、连续失败数、最近状态码与恢复倒计时，也可以一键重置。

熔断记录同时写在「提供商级」与「提供商+模型级」两层：某个 Key 整体 429 时，其余模型不必各自再撞一次墙。

### 5. 模型一键测试

单模型测试会真实发一次最小请求，返回首字延迟与回复摘要；批量测试按并发 4 跑完全部已启用模型，给出成功/失败清单和免费模型可用数。测试不写入用量统计，也不影响熔断状态。

## 完整部署配置

### 1. 创建资源

```bash
npx wrangler kv namespace create CONFIG
npx wrangler d1 create llmflare-usage
```

### 2. 配置 `wrangler.jsonc`

从 `wrangler.example.jsonc` 复制一份配置，将资源 ID 替换为自己的值：

```jsonc
{
  "name": "llmflare",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "YOUR_KV_NAMESPACE_ID" }
  ],
  "d1_databases": [
    {
      "binding": "USAGE",
      "database_name": "llmflare-usage",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ]
}
```

如果需要 Workers AI 原生 Binding，可再加入：

```jsonc
"ai": { "binding": "AI" }
```

### 3. 初始化并部署

```bash
npx wrangler d1 migrations apply USAGE --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

`ADMIN_TOKEN` 现在只承担两个职责：**首次初始化管理员账号**时的校验凭据，以及账号体系不可用时的**应急登录通道**。日常后台登录使用你自建的账号密码。

- 管理员口令以 PBKDF2-SHA256（含随机盐）摘要保存，明文不落盘。
- 会话令牌仅存 SHA-256 哈希，存于既有 `CONFIG`（KV）命名空间，不新增 Cloudflare 资源。
- 登录失败按客户端 IP 计数，超过阈值临时锁定，缓解暴力破解。
- 修改密码后清除全部旧会话并签发新会话，其他设备需重新登录。
- 不要将 `ADMIN_TOKEN` 提交到 Git、写进前端代码，或与客户端访问密钥混用。

新增迁移后应再次执行同一条 `d1 migrations apply` 命令。客户端限制达到阈值时返回 HTTP 429；月度 Token 按 UTC 自然月统计，过去 24 小时请求限制采用滚动窗口。Token 限制依据已完成请求的统计，因此并发中的请求可能造成少量超额；如需严格财务上限，仍应同时在上游 Provider 关闭 Pay-as-you-go 或设置消费上限。

### 4. 绑定域名（可选）

不配置域名也可以直接使用 `*.workers.dev` 地址。自定义域名可在 Cloudflare Dashboard 的 Worker **Settings → Domains & Routes** 中添加。

## 数据与安全

- Provider API Key 保存在你自己的 Cloudflare KV 中。
- 客户端访问密钥仅保存哈希，后台不会再次展示完整值。
- Prompt、模型回复与流式内容不会写入统计数据库。
- 用量记录只包含 Provider、模型、Token、状态码、耗时、首字延迟和 TPS 等元数据。
- 建议限制后台访问、定期轮换 `ADMIN_TOKEN`，并为公开部署配置 Cloudflare Access 或 WAF 规则。
- 如果接入收费 Provider，请使用独立、低额度、可随时撤销的 API Key，并在上游设置消费上限和告警；不要将绑定高额余额的主 Key 放入公开网关。

## FAQ / Limitations

### 国内访问国外 API 是否一定不需要代理？

客户端只连接 Cloudflare Worker 或自定义域名，上游请求由 Cloudflare 网络发起，因此在许多国内网络环境中可以直接使用国外 API，无需在客户端配置代理。但实际可用性仍受 Cloudflare 域名与线路、所在地区网络、政策及上游平台限制影响，项目无法保证所有地区和运营商始终可直连。

### 无服务器是否等于不会中断？

不是。Workers 避免了自有 VPS 的硬件、系统和单机网络故障，但仍受 Cloudflare、上游 Provider、配额和区域网络状态影响。

### 免费模型是否无限使用？

不是。免费模型仍可能有每分钟请求数、Token、并发、每日额度或共享容量限制。网关不会绕过上游限流。

### 为什么没有 OpenCode Zen Provider？

OpenCode Zen 的免费额度可能与官方客户端、请求来源或反滥用策略关联。同一 API Key 从官方节点可用，但经第三方 Worker 转发时可能返回 `FreeUsageLimitError`。为避免把不稳定能力包装成可靠功能，当前不提供该预设；若上游规则变得明确，可使用自定义 OpenAI-compatible Provider 测试。

### 为什么部分流式请求的 Token 是估算值？

只有上游返回 `usage` 时才能取得精确 Token。上游未返回时，网关会在不阻塞数据转发的前提下旁路估算，因此统计值适合观察趋势，不应作为账单依据。

## 项目地址与来源

- 本二改版本：请替换为你自己的仓库地址（本项目刻意不启用 Sync fork，独立演进）
- 上游原项目：https://github.com/Jiao77/LLMflare
- 上游镜像（原作者维护）：https://gitea.jiao77.com/Jiao77/llmflare

## 鸣谢

- [Jiao77](https://github.com/Jiao77)：LLMflare 原作者，本项目的全部核心代码来自其 MIT 开源工作。
- [LINUX DO](https://linux.do/)：真诚、友善、团结、专业的开源与技术讨论社区。
