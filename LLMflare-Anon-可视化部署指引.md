# LLMflare-Anon 可视化页面手动部署指引

> 全程只在浏览器里点击操作，**不需要在本地安装 Node.js、不需要命令行、不需要 wrangler CLI**。
> 唯一需要用到「命令行」的地方，是文末「附录 A」的可选方案。
>
> 适用版本：`llmflare-anon` v1.3.0-anon.0
> 目标平台：Cloudflare Workers（免费计划即可）

---

## 目录

- [0. 开始前的准备清单](#0-开始前的准备清单)
- [1. 第一步：创建 KV 命名空间](#1-第一步创建-kv-命名空间)
- [2. 第二步：创建 D1 数据库](#2-第二步创建-d1-数据库)
- [3. 第三步：把仓库上传到 GitHub](#3-第三步把仓库上传到-github)
- [4. 第四步：在网页上新建 wrangler.jsonc（最关键的一步）](#4-第四步在网页上新建-wranglerjsonc最关键的一步)
- [5. 第五步：连接 GitHub 创建 Worker](#5-第五步连接-github-创建-worker)
- [6. 第六步：等待首次构建并验证服务就绪](#6-第六步等待首次构建并验证服务就绪)
- [7. 第七步：设置 ADMIN_TOKEN 密钥](#7-第七步设置-admin_token-密钥)
- [8. 第八步：在 D1 里建表（12 条 SQL）](#8-第八步在-d1-里建表12-条-sql)
- [9. 第九步：初始化管理员账号](#9-第九步初始化管理员账号)
- [10. 第十步：添加 AI 供应商](#10-第十步添加-ai-供应商)
- [11. 第十一步：生成客户端访问密钥并联调](#11-第十一步生成客户端访问密钥并联调)
- [12. 第十二步（可选）：绑定自定义域名](#12-第十二步可选绑定自定义域名)
- [13. 常见坑速查表](#13-常见坑速查表)
- [14. 最终验收清单](#14-最终验收清单)
- [15. 后续维护：更新、回滚、删除](#15-后续维护更新回滚删除)
- [附录 A：如果完全不想用 Workers Builds](#附录-a如果完全不想用-workers-builds)

---

## 0. 开始前的准备清单

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Cloudflare 账号 | 已注册、已开通 Workers | 免费计划足够 |
| GitHub 账号 | 能创建仓库 | 用来存放源码 |
| AI 供应商 Key | 至少一个 | 例如 Groq、OpenRouter、Google AI Studio 的免费 Key；也支持完全匿名的供应商 |
| 交付包 | `llmflare-anon.tar.gz` | 已解压成 `llmflare-anon/` 文件夹备用 |

**需要你在 Cloudflare 里创建的资源一共 3 个**（后文逐步操作）：

1. 一个 **KV 命名空间**（存 Provider 配置、管理员账号、会话）
2. 一个 **D1 数据库**（存用量统计）
3. 一个 **Worker**（跑代码 + 托管前端页面）

> ⚠️ **重要概念**：这个项目是「Worker + 静态资源 + KV + D1」的组合，不是纯前端项目。所以不能只拖一个 zip 上去就完事，必须走一遍绑定配置。

---

## 1. 第一步：创建 KV 命名空间

**为什么需要**：Provider 配置、API Key、管理员账号密码摘要、登录会话全部存在这里（绑定名必须是 `CONFIG`）。

**操作步骤：**

1. 登录 https://dash.cloudflare.com
2. 左侧菜单 → **Storage & Databases**（存储和数据库）→ **KV**
   - 旧版界面路径：**Workers & Pages** → 左侧 **KV**
3. 点击 **Create instance**（旧版：**Create a namespace**）
4. **Namespace name** 填：`llmflare-CONFIG`
   - 名字可以随意取，但建议带上 `CONFIG` 便于识别；**绑定名**在代码里写死了是 `CONFIG`，和这里的命名空间名字无关
5. 点击 **Create / Add**
6. 创建完成后，回到 KV 列表页，找到刚创建的这一行：

```
┌──────────────────┬──────────────────────────────────┐
│ Namespace Name   │ ID                               │
├──────────────────┼──────────────────────────────────┤
│ llmflare-CONFIG  │ 8f3a1c2e9b7d4f60a5c8e1d2b3f4a5c6 │ ← 复制这串
└──────────────────┴──────────────────────────────────┘
```

7. **复制这个 ID**（32 位十六进制，无连字符），临时粘贴到记事本。记为 **`<KV_ID>`**

> 📌 **坑 1**：KV ID 是 32 位十六进制。如果复制到的是带连字符的 UUID（36 位），那多半是 D1 ID，别搞混。
> 📌 **坑 2**：如果界面上 ID 列被折叠，点命名空间名字进入详情页，ID 会显示在页面上方。

---

## 2. 第二步：创建 D1 数据库

**为什么需要**：记录每次请求的 Token、耗时、成功率、首字延迟、TPS（绑定名必须是 `USAGE`）。

**操作步骤：**

1. 左侧菜单 → **Storage & Databases** → **D1 SQL Database**
   - 旧版路径：**Workers & Pages** → **D1**
2. 点击 **Create database**
3. **Database name** 填：`llmflare-usage`（建议保持一致，便于对照）
4. **Location hint**（可选）：选 `APAC`（亚太）或留空自动
5. 点击 **Create**
6. 进入数据库详情页，在 **Database ID** 一栏复制 UUID。记为 **`<D1_ID>`

```
Database name:  llmflare-usage
Database ID:    a1b2c3d4-5e6f-7890-abcd-ef1234567890   ← 36 位 UUID，复制这串
```

> 📌 **坑 3**：**此时先不要建表**。表结构我们放到第 8 步统一执行，因为此时 Worker 还没部署，先建表容易漏掉第 8 步的核对。

---

## 3. 第三步：把仓库上传到 GitHub

1. 打开 https://github.com/new 新建一个空仓库
   - **Repository name**：`llmflare-anon`
   - 可见性：Public 或 Private（都支持）
   - **不要**勾选 `Add a README file` / `Add .gitignore` / `Choose a license`，保持完全空白
2. 创建后进入仓库页，点 **Add file ▾ → Upload files**
3. 在你电脑上解压 `llmflare-anon.tar.gz`，把解压出来的 **`llmflare-anon` 文件夹里的全部内容**（不是外层文件夹本身）拖进上传区
   - 正确做法：进入 `llmflare-anon/` 内部，全选 `src`、`public`、`test`、`docs`、`migrations`、`scripts`、`package.json` 等，一起拖进浏览器
   - 上传后仓库根目录应该能直接看到 `package.json`、`src/`、`public/`
4. 底部 **Commit message** 填：`feat: LLMflare-Anon v1.3.0-anon.0`
5. 点 **Commit changes**

> 📌 **坑 4（必看）**：`package.json`、`src/`、`public/` 必须在仓库**根目录**，不能是 `llmflare-anon/llmflare-anon/src/`。上传完成后务必刷新确认层级正确，否则第 5 步构建会找不到入口文件。
>
> 📌 GitHub 网页上传限制：单文件 ≤ 25 MiB、一次 ≤ 100 个文件。本项目 42 个文件、最大 1.59 MB，一次拖拽即可完成。
>
> 📌 `LLMflare-Anon-发布指引.md` 里的 `llmflare-anon-vs-upstream.patch` 是给开发者用的，**不需要上传**。

---

## 4. 第四步：在网页上新建 wrangler.jsonc（最关键的一步）

### 4.1 为什么必须做这一步

Cloudflare 的 Git 集成（Workers Builds）在构建时会读取仓库根目录的配置文件来确定「入口文件在哪、有哪些绑定」。

**如果没有这个文件**，Cloudflare 会自动运行 **autoconfig**：它会去猜框架、然后**在你的仓库里自动创建一个 Pull Request**，往你的仓库塞一堆它自己生成的配置。这既不可控，也很容易把项目改坏。

**所以：先手动建好 `wrangler.jsonc`，再连接 Worker。**

### 4.2 在网页上创建文件

1. 进入你的 GitHub 仓库页
2. 点 **Add file ▾ → Create new file**
3. 文件名（左上角输入框）填：`wrangler.jsonc`
4. 把下面这段内容完整粘贴到大文本区：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "llmflare",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": false,
  "keep_vars": true,
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/v1/*", "/admin/*", "/health"]
  },
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "把这里替换成第 1 步复制的 KV_ID" }
  ],
  "d1_databases": [
    {
      "binding": "USAGE",
      "database_name": "llmflare-usage",
      "database_id": "把这里替换成第 2 步复制的 D1_ID",
      "migrations_dir": "./migrations"
    }
  ],
  "ai": { "binding": "AI" },
  "observability": { "enabled": true, "head_sampling_rate": 1 }
}
```

5. **把两个占位字符串替换成真实 ID**（这一步不能忘，否则构建直接失败）：
   - `"把这里替换成第 1 步复制的 KV_ID"` → 你的 32 位 KV ID
   - `"把这里替换成第 2 步复制的 D1_ID"` → 你的 36 位 D1 UUID
6. 底部 **Commit message** 填：`chore: add wrangler.jsonc for Workers Builds`
7. 点 **Commit changes**（可直接提交到 main）

### 4.3 逐字段说明（便于你核对）

| 字段 | 作用 | 能否改 |
| --- | --- | --- |
| `name` | Worker 名字 | **建议保持 `llmflare`**，和第 5 步创建的 Worker 名保持一致 |
| `main` | 入口文件 | 必须 `src/index.ts` |
| `compatibility_date` | 运行时行为版本 | 保持 `2026-08-25`，改动可能导致行为漂移 |
| `compatibility_flags` | 启用 Node 兼容层 | 必须有 `nodejs_compat` |
| `keep_vars` | **保留控制台里手动设置的变量** | **本次特意加上**，见 4.4 |
| `assets.directory` | 前端静态文件目录 | `./public` |
| `assets.binding` | 静态资源绑定名 | `ASSETS`（代码里写死） |
| `assets.run_worker_first` | 这些路径先走 Worker 逻辑，不直接返回静态文件 | 必须包含 `/v1/*`、`/admin/*`、`/health` |
| `kv_namespaces[0].binding` | KV 绑定名 | **必须 `CONFIG`** |
| `d1_databases[0].binding` | D1 绑定名 | **必须 `USAGE`** |
| `ai.binding` | Workers AI 绑定 | `AI`，用于内置免费模型 |
| `observability` | 打开日志与可观测性 | 建议开启，方便查错 |

### 4.4 为什么加了 `keep_vars: true`

这是一个**真实踩过的坑**：Cloudflare 每次部署时会以仓库里的配置文件为「唯一真相」。如果只是在控制台的 *Variables and Secrets* 里手动加了变量（比如 `ADMIN_TOKEN`），下一次部署时**这些明文变量会被清空**。

`keep_vars: true` 的作用是：部署时保留控制台里已配置的、本次配置文件中没有声明的变量，不再静默清空。

> 📌 **注意**：`keep_vars` 只对「明文变量」类绑定有明确保护作用，对加密 Secret 的保护并不完整。因此第 7 步设置完 `ADMIN_TOKEN` 后，**每次重新部署都要回控制台确认它还在**。如果不见了，重新添加一次即可 —— 因为账号体系已经建好，`ADMIN_TOKEN` 丢了不影响日常登录（详见第 9 步说明）。
>
> 📌 **坑 5**：仓库自带的 `.gitignore` 里写了 `wrangler.jsonc`（上游作者本地开发时的习惯）。这意味着**如果你是用 `git` 命令行提交，`git add -A` 会静默跳过这个文件**。在 GitHub 网页上新建文件不受 `.gitignore` 影响，所以本文用网页方式创建；如果你改用命令行推送，必须执行 `git add -f wrangler.jsonc` 强制添加。

---

## 5. 第五步：连接 GitHub 创建 Worker

### 5.1 创建并连接仓库

1. 进入 https://dash.cloudflare.com → 左侧 **Workers & Pages**
2. 点击 **Create application**
   - 旧版界面：**Create** → **Workers** 标签页 → **Connect to Git**
3. 选择 **GitHub**（页面写的是 `Import a repository` / `Connect GitHub`）
4. 第一次使用需要授权：点 **Connect GitHub** → 在弹出的 GitHub 页面里点 **Authorize**
   - 如果只想给单个仓库授权，选 **Only select repositories**，勾选 `llmflare-anon`
5. 回到 Cloudflare，在仓库列表里选中 `llmflare-anon` → **Begin setup**
6. 填写以下配置：

| 配置项 | 填写值 |
| --- | --- |
| **Project name / Worker name** | `llmflare`（**必须与 wrangler.jsonc 里的 `name` 一致**） |
| **Production branch** | `main` |
| **Build command** | `npm ci` |
| **Deploy command** | `npm run deploy` |
| **Root directory** | 留空（仓库根目录） |

7. 展开 **Advanced settings / Environment variables（构建变量）** —— **本次不需要填任何东西**，因为 KV/D1 的 ID 已经直接写进 `wrangler.jsonc` 了
8. 点击 **Save and Deploy**（旧版：**Deploy**）

### 5.2 关于「Deploy command 为什么是 `npm run deploy`」

`package.json` 里定义了：

```json
"deploy": "npm run sync:cf-models && wrangler deploy"
```

这个脚本会先同步一份 Workers AI 的模型清单到 `public/workers-ai-models.json`（让后台模型选择弹窗能显示 Workers AI 的完整模型列表），再执行部署。直接写 `npx wrangler deploy` 也能上线，但 Workers AI 的模型清单会缺失，属于功能降级。

### 5.3 如果你已经在别的地方建了同名 Worker

必须先到 **Settings → Builds → Disconnect** 断开旧连接，再重新连接一次仓库；否则会报「已存在」。

---

## 6. 第六步：等待首次构建并验证服务就绪

### 6.1 看构建日志

1. 进入 Worker 详情页 → **Deployments**（部署）
2. 最上方会有一条状态为 `Building` 的部署记录
3. 点击它 → **View build log**，可以实时看日志

**正常日志的关键片段（按顺序出现）：**

```
Cloning repository...
Installing dependencies...        ← npm ci
Detected wrangler.jsonc
Syncing Workers AI models...       ← sync:cf-models
Uploading... 
Deployed llmflare triggers
Build completed successfully
```

**耗时参考**：首次构建通常 2 ~ 5 分钟（要装 `wrangler`、`vitest`、`typescript` 等依赖）。

### 6.2 拿到访问地址

构建成功后，在 Worker 详情页顶部或 **Settings → Domains & Routes** 里能看到：

```
https://llmflare.<你的子域>.workers.dev
```

把这个地址记为 **`<WORKER_URL>`**。

### 6.3 用「就绪检查」接口验证（强烈建议）

项目内置了一个专门用来做部署验收的接口。在浏览器地址栏直接打开：

```
<WORKER_URL>/health?check=ready
```

**部署完全正确时，返回：**

```json
{ "ok": true, "service": "llmflare-anon", "d1": "ready", "kv": "ready" }
```

**如果返回 `"ok": false`，按下面这张表定位：**

| 返回内容 | 原因 | 去哪修 |
| --- | --- | --- |
| `"d1": "error: no such table: ..."` 或 `D1_ERROR` | 表还没建 | **第 8 步**，去 D1 控制台执行 SQL |
| `"d1": "error: ..."` 且提到 binding / undefined | D1 绑定没生效 | 检查 `wrangler.jsonc` 里 `binding` 是不是 `USAGE`、ID 是否正确，然后重新部署 |
| `"kv": "missing"` | KV 绑定没生效 | 检查 `kv_namespaces` 的 `binding` 是不是 `CONFIG` |
| `503` + `d1` 报错 | 同上 | 同上 |

> 📌 **坑 6**：**这个检查必须在第 8 步建表之后再跑一次**。第一次部署完直接打开大概率是 `d1` 报错，因为表还没建 —— 这是正常的，不要以为部署失败了。
>
> 📌 先跑 `/health`（不带参数）确认 Worker 活着，返回 `{"ok":true,"service":"llmflare-anon"}` 就说明代码已经跑起来了。

---

## 7. 第七步：设置 ADMIN_TOKEN 密钥

**为什么需要**：`ADMIN_TOKEN` 在这版里**只做两件事**：

1. **首次初始化管理员账号**时，作为「你确实是部署者」的校验凭据（防止别人抢先注册）；
2. 账号密码忘记时的**应急通道**。

日常后台登录用你自己设的账号密码，不再需要输入 `ADMIN_TOKEN`。

**操作步骤：**

1. 进入 Worker 详情页 → **Settings**（设置）
2. 找到 **Variables and Secrets**（变量和密钥）
3. 点击 **Add**（添加）
4. 填写：

| 字段 | 填写值 |
| --- | --- |
| **Type** | 选 **Secret**（密钥，加密存储），**不要选 Text** |
| **Variable name** | `ADMIN_TOKEN`（全大写，一字不差） |
| **Value** | 一个足够长的随机串，例如 40 位以上 |

5. 点 **Add / Save**
6. 点击页面底部或顶部的 **Deploy**（保存后通常需要一次重新部署才生效）
   - 如果界面提示「需要重新部署才能生效」，点 **Deploy**；也可以到 **Deployments → Retry deployment** 重新跑一次

**生成一个合格随机串的方法**（任选其一）：

- 在浏览器控制台（F12 → Console）执行：`crypto.randomUUID() + crypto.randomUUID()`
- 或者用一串你自己都记不住的 40 位大小写字母数字混合

> 📌 **坑 7**：`ADMIN_TOKEN` 千万不要和「客户端访问密钥」（第 11 步生成的 `llmf_` 开头的 Key）混用，两者职责完全不同。
>
> 📌 **坑 8**：如果你在第 7 步之前就点过 `Deploy`，那没问题；但如果第 7 步之后又因为改代码触发了重新构建，**回来确认这个 Secret 还在**。丢了就重新加一遍，不影响已建好的账号。

---

## 8. 第八步：在 D1 里建表（12 条 SQL）

**为什么需要**：用量统计、TPS 计算、客户端限流都依赖这些表。**不建表，后台的统计图表会全部空白或报错。**

### 8.1 进入 SQL 控制台

1. 左侧菜单 → **Storage & Databases** → **D1 SQL Database**
2. 点击 `llmflare-usage`
3. 顶部标签页选 **Console**（控制台）

### 8.2 逐条执行（一条一条来，不要一次全粘）

> 为什么要逐条：D1 控制台的 SQL 输入框对「多条语句」的支持不稳定，一次粘贴整段容易只执行第一条而不报错，导致你误以为建好了。**逐条执行 + 每条执行后看结果**最稳。

**第 1 条**（建用量主表）：

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  client_key_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  streaming INTEGER NOT NULL DEFAULT 0
);
```

**第 2 条**：

```sql
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_events(created_at);
```

**第 3 条**：

```sql
CREATE INDEX IF NOT EXISTS idx_usage_provider_created ON usage_events(provider_name, created_at);
```

**第 4 条**：

```sql
CREATE INDEX IF NOT EXISTS idx_usage_model_created ON usage_events(model, created_at);
```

**第 5 条**（流式指标：首字延迟）：

```sql
ALTER TABLE usage_events ADD COLUMN first_token_ms INTEGER;
```

**第 6 条**：

```sql
ALTER TABLE usage_events ADD COLUMN duration_ms INTEGER;
```

**第 7 条**：

```sql
ALTER TABLE usage_events ADD COLUMN output_tps REAL;
```

**第 8 条**：

```sql
ALTER TABLE usage_events ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'unavailable';
```

**第 9 条**：

```sql
ALTER TABLE usage_events ADD COLUMN completed INTEGER NOT NULL DEFAULT 1;
```

**第 10 条**（回填历史数据）：

```sql
UPDATE usage_events
SET usage_source = CASE WHEN total_tokens IS NULL THEN 'unavailable' ELSE 'exact' END,
    duration_ms = latency_ms;
```

**第 11 条**（客户端限流窗口表）：

```sql
CREATE TABLE IF NOT EXISTS client_rate_windows (
  client_key_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_key_id, window_start)
);
```

**第 12 条**：

```sql
CREATE INDEX IF NOT EXISTS idx_client_rate_windows_start
  ON client_rate_windows(window_start);
```

### 8.3 核对是否建全了

在同一个 Console 里执行：

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

**期望看到 3 张表**：

```
client_rate_windows
usage_events
_d1_migrations   ← 如果没有这个也正常（本文没用 wrangler 迁移命令）
```

再执行一条确认列数（`usage_events` 应该有 **19 列**）：

```sql
PRAGMA table_info(usage_events);
```

**期望出现的列名**：`id, created_at, client_key_id, endpoint, provider_id, provider_name, provider_type, model, status, latency_ms, input_tokens, output_tokens, total_tokens, streaming, first_token_ms, duration_ms, output_tps, usage_source, completed`

### 8.4 回到就绪检查

重新打开：

```
<WORKER_URL>/health?check=ready
```

**这次必须返回全绿：**

```json
{ "ok": true, "service": "llmflare-anon", "d1": "ready", "kv": "ready" }
```

看到 `"ok": true` 且 `"d1": "ready"`，说明后端链路全部打通。**这是部署成功的硬性验收点。**

> 📌 **坑 9**：第 5~9 条是 `ALTER TABLE ... ADD COLUMN`，**不能重复执行**。如果手抖跑了第二次，会报 `duplicate column name`。这个报错说明「已经加过了」，可以直接跳过继续，不用回滚。
>
> 📌 **坑 10**：`UPDATE` 那条（第 10 条）在空表上执行会显示「0 rows affected」，这是正常的，不是失败。

---

## 9. 第九步：初始化管理员账号

### 9.1 打开登录页

浏览器访问：

```
<WORKER_URL>
```

会看到**黑曜石风格的登录界面**（深色玻璃质感卡片，标题「LLMflare」）。

### 9.2 首次访问：创建管理员账号

因为此时还没有任何账号，页面会自动切换到 **「初始化管理员账号」** 表单（而不是登录表单）。填写：

| 字段 | 要求 | 示例 |
| --- | --- | --- |
| **用户名** | 3–32 个字符，仅字母/数字/点/下划线/短横线 | `admin` |
| **密码** | 至少 10 个字符，且必须包含「大写字母、小写字母、数字、符号」中的**至少两类** | `Obsidian#2026` |
| **ADMIN_TOKEN** | 第 7 步设置的那串密钥 | 粘贴你生成的长随机串 |

点 **创建账号 / 初始化**。

**成功表现**：直接进入后台仪表盘，不需要再登录一次（系统会自动签发会话）。

### 9.3 密码规则明细（不满足会被挡回）

- 长度 **≥ 10** 且 **≤ 200**
- 字符种类 **≥ 2 类**（小写 `a-z` / 大写 `A-Z` / 数字 `0-9` / 符号 四类中至少两类）
- ✅ 可用：`Obsidian#2026`、`llmflare2026`（小写+数字，2 类）、`Flare-Glass-01`
- ❌ 不可用：`1234567890`（只有数字，1 类）、`password`（不足 10 位且只有 1 类）

### 9.4 日常登录与安全机制

| 机制 | 行为 |
| --- | --- |
| 会话时长 | 不勾「记住我」= 12 小时；勾选 = 30 天 |
| 登录失败限流 | 同一 IP 15 分钟内失败 **6 次**即锁定，页面会显示剩余等待秒数 |
| 密码存储 | PBKDF2-SHA256，210,000 次迭代 + 随机盐，**只存摘要** |
| 会话存储 | 令牌的 SHA-256 摘要存进 KV，**KV 里看不到可用凭据** |
| 改密码 | 后台「账号」页 → 修改密码 → 会**清空所有旧会话**并自动签发新会话 |

### 9.5 忘记密码怎么办（应急通道）

如果 `ADMIN_TOKEN` 还在（第 7 步设置的），有两个办法：

**办法一：换浏览器 / 无痕窗口，用 ADMIN_TOKEN 直接访问后台**

```javascript
// 在浏览器控制台（F12 → Console）执行，把引号里的值换掉后回车
localStorage.setItem("llm-anon-token", "粘贴你的ADMIN_TOKEN");
location.reload();
```

> 📌 键名必须是 `llm-anon-token`（前端代码里的常量就是它），写错不会有任何效果。

> 之所以能这样用：代码里 `authenticateAdmin()` 会**先试会话令牌，再试 ADMIN_TOKEN**，两条路都认。所以 `ADMIN_TOKEN` 就是应急后门。

**办法二：清空 KV 里的账号重新初始化**

1. Cloudflare → **Storage & Databases** → **KV** → 点进 `llmflare-CONFIG`
2. 在 **KV Pairs** 列表里找到 key 为 `admin:account:v1` 的那条 → 删除
3. 重新访问 `<WORKER_URL>`，页面会回到「初始化管理员账号」表单，重新建号

> 📌 **坑 11**：`ADMIN_TOKEN` 丢了又没账号，就只能用办法二。这也说明第 7 步那串随机值**一定要先存到密码管理器**。

---

## 10. 第十步：添加 AI 供应商

### 10.1 入口

登录后进入后台 → 左侧导航 **供应商 / Providers** → 右上角 **添加供应商**

### 10.2 表单字段逐个说明

| 字段 | 说明 |
| --- | --- |
| **名称（Name）** | 显示用，会出现在模型名前缀里。例如 `Groq` |
| **类型（Type）** | 决定协议适配逻辑。可选：`Google AI Studio`、`Groq`、`OpenRouter`、`NVIDIA NIM`、`Cloudflare Workers AI`、`SiliconFlow`、`智谱 BigModel`、`Mistral`、`自定义 OpenAI 兼容` |
| **Base URL** | 类型选好后一般自动填好，自定义类型需手填 |
| **API Key** | 见 10.3 —— 支持**完全匿名**的上游 |
| **Account ID** | **仅 Cloudflare Workers AI 类型需要**（用 REST 方式时） |
| **默认模型** | 可选，不填则用白名单第一个 |

### 10.3 三种鉴权模式（本版本新增能力）

这是这个分支相对上游最大的改动之一。添加供应商时有一个 **「上游鉴权方式 / Auth Mode」** 选项：

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| **Bearer（默认）** | 请求上游时带上 `Authorization: Bearer <你的Key>` | 绝大多数需要 Key 的供应商 |
| **None（匿名）** | **完全不发送任何 Authorization 头，也不保存 Key** | 支持匿名访问的上游（如部分本地/内网网关、公开推理端点） |

**选 None 之后的变化：**

- 「API Key」输入框可以**留空**，保存不再被拦
- 点「获取模型」时**不会**再提示「请先填写提供商 API Key」
- 发出的请求里**绝对不会**出现 `Authorization` 头 —— 代码里的判断是 `authMode !== "none" && apiKey`，所以即使有人后续手工往 KV 里塞回一个 Key，也不会被发给上游

> 📌 **坑 12（历史大坑，本版已修）**：上游版本要求必须有 Key 才能「获取模型」，导致匿名供应商只能填假 Key → 假 Key 被发给上游 → 对话报 401。本版通过 `authMode` 字段从根上解决了这个问题。**如果你用的是上游原版，会踩这个坑；用本交付包不会。**

### 10.4 获取模型列表并勾选白名单

1. 填好类型、Base URL、Key（或选 None）后，点 **获取模型 / Fetch models**
2. 系统会列出该账号可访问的全部模型，并按分组展示
3. 如果供应商支持，会出现 **「只看免费模型」** 开关：
   - OpenRouter / NVIDIA / SiliconFlow / 智谱 支持自动识别免费模型
   - 识别依据是平台返回的价格字段、标签或模型名（`:free` 后缀也算免费）
4. **勾选你允许客户端访问的模型**（只有勾选的才会出现在 `/v1/models` 里）
5. 点 **保存**

> 📌 **坑 13**：Mistral 的模型目录**不会**被整体标记为免费 —— 因为它只告诉你能访问哪些模型，不提供足以证明零价格的信息。免费套餐的「月度额度」和「模型本身免费」是两回事。
>
> 📌 **坑 14**：保存后模型名的公开格式是 `供应商名称/上游模型ID`，例如 `Groq/openai/gpt-oss-20b`。**这个完整名称必须原样写进客户端配置**，写错会返回 `400 model_not_enabled`。

### 10.5 Cloudflare Workers AI 的两种接法

| 接法 | 需要填 | 说明 |
| --- | --- | --- |
| **原生 Binding** | 什么都不用填 | `wrangler.jsonc` 里已经有 `"ai": { "binding": "AI" }`，直接可用 |
| **REST API** | Account ID + API Token | 适合想跑在别的账号下，或需要跨账号调用 |

> 📌 Account ID 在 Cloudflare 控制台右侧栏或 URL 里能找到（32 位十六进制）。

---

## 11. 第十一步：生成客户端访问密钥并联调

### 11.1 生成密钥

1. 后台 → 左侧 **访问密钥 / Client Keys**
2. 点 **生成密钥**
3. 填写：

| 字段 | 建议 |
| --- | --- |
| **名称** | 便于区分用途，如 `我的笔记本`、`Codex` |
| **RPM（每分钟请求数）** | 留空不限，或按需填 |
| **24 小时请求上限** | 滚动窗口，留空不限 |
| **本月 Token 上限** | 按 UTC 自然月统计 |
| **单次最大输出 Token** | 防止一次跑爆额度 |

4. 点 **创建**
5. **立刻复制弹出的密钥**（`llmf_` 开头）

> 📌 **坑 15（非常重要）**：这个密钥**只显示一次**。后台只保存哈希，关闭弹窗后就再也看不到完整值，只能删了重建。**先粘贴到密码管理器或立即写进客户端配置。**
>
> 📌 **坑 16**：不要把「管理员账号密码」和这个「客户端访问密钥」搞混：前者登后台，后者调 API。

### 11.2 在后台直接测（不用装任何东西）

后台有 **「在线测试 / Playground」** 页面：

1. 选一个已启用的模型
2. 输入一句话，例如 `你好，用一句话介绍你自己`
3. 勾选 **流式**
4. 点发送

**正常表现**：文字**逐个字往外冒**（不是等全部生成完才一次性出现）。如果是一次性出现，说明客户端配置成了非流式，或上游不支持流式。

### 11.3 用浏览器地址栏测（最原始的验证）

把下面这段粘到浏览器控制台（F12 → Console），把两个值替换掉：

```javascript
const KEY = "llmf_你的客户端密钥";
const BASE = "https://llmflare.你的子域.workers.dev";

fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "Groq/openai/gpt-oss-20b",   // 换成你后台 /v1/models 里看到的完整名字
    messages: [{ role: "user", content: "你好" }],
    stream: false
  })
}).then(r => r.json()).then(console.log).catch(console.error);
```

**先验证模型清单接口能不能通：**

```
<WORKER_URL>/v1/models
```
（需带 `Authorization: Bearer <客户端密钥>`，可以直接在后台「在线测试」里看，或上面的 fetch 里把 URL 换成 `/v1/models` 并用 GET）

### 11.4 接入真实客户端

**OpenAI 兼容客户端 / SDK：**

```
Base URL:  <WORKER_URL>/v1
API Key:   llmf_你的客户端密钥
Model:     供应商名称/上游模型ID
```

**Claude Code（走 Anthropic Messages 协议）：**

```bash
export ANTHROPIC_BASE_URL="<WORKER_URL>"        # 注意：不要带 /v1
export ANTHROPIC_AUTH_TOKEN="llmf_你的客户端密钥"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

启动后用 `/model` 选模型，`/status` 确认 Base URL 与 Token 已生效。

> 📌 **坑 17**：`ANTHROPIC_BASE_URL` 填**域名根地址**，不要加 `/v1`。加了会变成 `/v1/v1/messages`，直接 404。

**Codex（走 Responses 协议）：**

```toml
# ~/.codex/config.toml
model = "Groq/openai/gpt-oss-20b"
model_provider = "llmflare"

[model_providers.llmflare]
name = "LLMflare"
base_url = "<WORKER_URL>/v1"
env_key = "LLMFLARE_API_KEY"
wire_api = "responses"
```

然后在启动 Codex 的同一个终端里：`export LLMFLARE_API_KEY="llmf_你的客户端密钥"`

### 11.5 验证用量统计有没有记录

1. 第 11.2 步发过几次对话后，回到后台 **仪表盘**
2. 「按 Provider」和「按模型」两张表应该出现记录
3. 确认这几列有值：**请求数、Token、成功率、首字延迟、TPS**

> 📌 **坑 18**：**Token 数是估算值**时要留意 —— 只有上游返回了 `usage` 才是精确值。上游没返回时网关会旁路估算，表里 `usage_source` 列为 `unavailable` 或 `estimated`。**这些数字适合看趋势，不能拿来对账。**
>
> 📌 **坑 19**：如果仪表盘全空，先确认是走了 `/v1/*` 路径（静态页面请求不会记账），再确认第 8 步的表真的建全了。

---

## 12. 第十二步（可选）：绑定自定义域名

1. Worker 详情页 → **Settings** → **Domains & Routes**
2. 点 **Add** → **Custom domain**
3. 输入你的域名，例如 `llm.example.com`
4. 点 **Add domain**

**前提**：这个域名必须已经托管在**同一个 Cloudflare 账号**下（NS 已指向 Cloudflare）。DNS 记录会自动创建，无需手动添加 CNAME。

> 📌 挂了自定义域名之后，`<WORKER_URL>` 全部换成 `https://llm.example.com`。Claude Code 的 `ANTHROPIC_BASE_URL`、Codex 的 `base_url`、OpenAI SDK 的 Base URL 都要同步改。
>
> 📌 `workers.dev` 子域默认开着（`workers_dev: true`），自定义域名和它**并存可用**，方便对比排错。

---

## 附：深浅主题切换（本版新增）

### 使用方式

登录页右下角、登录后顶栏右上角各有一个圆形按钮，点一下即切换：

| 当前主题 | 按钮图标 | 点击后 |
| --- | --- | --- |
| 深色（黑曜石） | ☀️ 太阳 | 切到浅色 |
| 浅色（白瓷） | 🌙 月亮 | 切到深色 |

### 行为细节

- **记忆偏好**：选择写入浏览器 `localStorage`（键名 `llm-anon-theme`），下次打开自动沿用。
- **首次访问跟随系统**：没有手动选择过时，会读取 `prefers-color-scheme`；之后若系统主题变化，页面也会跟着变。
- **手动选择后不再被系统覆盖**：一旦你点过按钮，就以你的选择为准。
- **移动端状态栏同步**：切换时会更新 `<meta name="theme-color">`，iOS/Android 浏览器顶栏颜色跟着变。
- **图表会重绘**：用量柱状图是 Canvas 绘制的，Canvas 不继承 CSS 变量，所以切换主题时脚本会重新读取令牌并重绘，颜色不会残留。

### 实现要点（便于二次修改）

| 文件 | 作用 |
| --- | --- |
| `public/tokens.css` | 全部颜色令牌。深色在 `:root`，浅色在 `html[data-theme="light"]` |
| `public/styles.css` | 只用 `var(--xxx)`，不含硬编码色值 |
| `public/app.js` | `applyTheme()` / `toggleTheme()` / `initTheme()`，以及 Canvas 的 `themeVar()` |
| `public/index.html` | `<head>` 内的防闪烁引导脚本 + 两个切换按钮 |

> 📌 **坑 27**：想改品牌色，**只改 `tokens.css`**，不要去 `styles.css` 里找颜色。浅色主题需要单独调（因为白底上要压深才够对比度），两套主题的 `--accent` 值是不同的。

> 📌 **坑 28**：不要在 `<head>` 删掉那段引导脚本。它负责在首帧渲染前定好主题，删了会在浅色模式下先闪一下黑底。

---

## 13. 常见坑速查表

| # | 现象 | 根本原因 | 解决办法 |
| --- | --- | --- | --- |
| 1 | 构建日志报 `KV namespace not found` / 部署失败 | `wrangler.jsonc` 里 KV ID 还是占位符，或复制错了 | 回第 4 步替换成真实 32 位 ID |
| 2 | 构建日志报 `d1 database ... not found` | D1 ID 是 UUID 但填错/填成名字 | 回第 2 步复制 36 位 UUID |
| 3 | 构建报 `Could not resolve "src/index.ts"` | 上传时多了外层目录，根目录没有 `src/` | 重新整理仓库层级（坑 4） |
| 4 | Cloudflare 自动建了一个 PR 改你的仓库 | 仓库里没有 `wrangler.jsonc`，触发了 autoconfig | 先关掉那个 PR，按第 4 步手动建文件，再重新连接 |
| 5 | 用命令行 `git add -A` 后 `wrangler.jsonc` 没进仓库 | `.gitignore` 里有 `wrangler.jsonc` | `git add -f wrangler.jsonc`（坑 5） |
| 6 | `/health` 返回 `kv: missing` 或 `d1: error` | 绑定名不是 `CONFIG` / `USAGE` | 检查 `wrangler.jsonc` 的 `binding` 字段，重新部署 |
| 7 | 后台登录页打不开，只看到空白或 404 | `assets.run_worker_first` 漏了路由 | 确认含 `/v1/*`、`/admin/*`、`/health`，重新部署 |
| 8 | 部署一次之后 `ADMIN_TOKEN` 不见了 | 部署以配置文件为真相，清空了控制台明文变量 | 已加 `keep_vars: true`；仍丢失就重新添加一次（不影响已有账号） |
| 9 | 「初始化账号」页不出现，直接要登录 | KV 里已有 `admin:account:v1`（之前建过号） | 用账号密码登录；忘了就删 KV 里那条记录（9.5 办法二） |
| 10 | 建号时提示 `ADMIN_TOKEN 校验失败` | 控制台里的值和你输入的不一致，或设置后没重新部署 | 回第 7 步核对，保存后点一次 Deploy |
| 11 | 建号时提示「密码至少 10 个字符」/「需包含至少两类」 | 密码太弱 | 按 9.3 的规则重设 |
| 12 | 登录提示「还可尝试 N 次」然后被锁 | 连续失败 6 次触发 IP 限流 | 等 15 分钟；或换网络/IP；或走 9.5 应急通道 |
| 13 | 添加匿名供应商被拦「请先填写 API Key」 | 用了上游原版，没有 `authMode` 字段 | 用本交付包（v1.3.0-anon.0） |
| 14 | 匿名供应商对话报 `401 Unauthorized` | 上游其实不支持匿名，或假 Key 被发出去了 | 确认 `authMode` 选了 `None`；用 curl 直连上游验证是否真匿名 |
| 15 | 客户端返回 `400 model_not_enabled` | 模型名没写全，或该模型没勾进白名单 | 用后台 `/v1/models` 返回的**完整名称**；或回后台勾上 |
| 16 | 客户端返回 `503 provider_unavailable` | 没有任何已启用且有模型白名单的 Provider | 检查 Provider 是否 `enabled` 且至少勾了一个模型 |
| 17 | 客户端返回 `401 API Key 无效` | 客户端密钥错了 / 被停用 / 用成了 ADMIN_TOKEN | 重新生成客户端密钥（11.1） |
| 18 | 客户端返回 `429` | 触发了 RPM / 24h / 月度 Token / 单次输出上限 | 后台改该密钥的限额，或换密钥 |
| 19 | Claude Code 报 404 | `ANTHROPIC_BASE_URL` 加了 `/v1` | 去掉 `/v1`（坑 17） |
| 20 | 仪表盘图表空白 | 表没建 / 没走 `/v1/*` / 缓存 | 重跑 8.3 核对 SQL；发一次真实对话再看 |
| 21 | 流式响应变成一次性输出 | 客户端 `stream: false`，或中间有代理缓冲 | 客户端开 `stream: true`；确认没有反向代理缓冲 |
| 22 | Token 数与供应商后台对不上 | 上游未返回 `usage`，网关侧估算 | 看 `usage_source` 列；不作为账依据（坑 18） |
| 23 | 构建成功但访问是旧页面 | 浏览器/CDN 缓存 | 强刷（Ctrl/Cmd+Shift+R），或换无痕窗口 |
| 24 | 部署卡在 `Building` 超过 10 分钟 | 依赖安装慢或构建队列排队 | 等；或到 Deployments 点 **Retry deployment** |
| 25 | 免费计划提示构建分钟数用完 | Workers Builds 免费额度限制 | 等下月重置；或改用附录 A 方案 |

---

## 14. 最终验收清单

按顺序打勾，全部通过才算部署完成：

**基础设施**

- [ ] KV 命名空间已创建，ID 已复制（32 位十六进制）
- [ ] D1 数据库已创建，ID 已复制（36 位 UUID）
- [ ] `wrangler.jsonc` 已在仓库根目录，两个 ID 均已替换成真实值
- [ ] `wrangler.jsonc` 里 `name` 与 Cloudflare 上的 Worker 名一致

**部署**

- [ ] GitHub 仓库已连接，Workers Builds 构建成功
- [ ] `<WORKER_URL>/health` 返回 `{"ok":true,...}`
- [ ] `<WORKER_URL>/health?check=ready` 返回 `"d1":"ready"` 且 `"kv":"ready"`
- [ ] 控制台 `Settings → Variables and Secrets` 里 `ADMIN_TOKEN` 存在且类型是 **Secret**

**数据库**

- [ ] D1 里 `SELECT name FROM sqlite_master WHERE type='table'` 能列出 `usage_events` 和 `client_rate_windows`

**账号**

- [ ] 用用户名 + 密码 + ADMIN_TOKEN 成功建号
- [ ] 退出后能用账号密码重新登录
- [ ] 密码修改功能可用（改完自动保持登录）

**供应商与模型**

- [ ] 至少一个 Provider 已保存且 `enabled`
- [ ] 「获取模型」成功拉到模型列表
- [ ] 已勾选白名单（至少一个模型）
- [ ] `GET /v1/models`（带客户端密钥）能看到 `供应商名称/模型ID` 格式的条目

**联调**

- [ ] 后台「在线测试」能流式输出
- [ ] 用 `stream: true` 的外部请求能逐字返回
- [ ] 仪表盘出现至少 1 条用量记录，且首字延迟 / TPS 有数值

---

## 15. 后续维护：更新、回滚、删除

### 15.1 更新代码

1. 在 GitHub 网页上改文件（或重新上传改动的文件）
2. 提交到 `main` 分支
3. Cloudflare 会**自动触发一次构建和部署**，无需手动操作
4. 到 **Deployments** 看新记录，跑一次 `/health?check=ready` 复核

> 📌 更新后**必须**回控制台确认 `ADMIN_TOKEN` 是否还在（坑 8）。

### 15.2 回滚到上一个版本

1. Worker 详情页 → **Deployments**
2. 在 **Version History / 部署记录** 里找到上一个正常版本
3. 点该记录右侧的 **⋯ → Rollback / Deploy this version**
4. 确认

> 📌 回滚只回滚**代码**，不动 KV 和 D1 里的数据。

### 15.3 重新部署（不改进代码）

**Deployments** → 找到目标记录 → **⋯ → Retry deployment**

### 15.4 完全删除

**顺序很重要**：先删 Worker，再删资源，避免残留占用。

1. Worker → **Settings** → 拉到底 → **Delete** → 输入 Worker 名确认
2. **Storage & Databases → D1** → `llmflare-usage` → **Settings** → **Delete** → 输入库名确认
3. **Storage & Databases → KV** → `llmflare-CONFIG` → 删除命名空间
4. GitHub 仓库按需删除（**Settings → Danger Zone → Delete this repository**）

> 📌 **坑 26**：删除 KV 命名空间会**同时删除所有 Provider 配置和 API Key**，操作不可恢复。删之前先在后台把 Provider 列表导出/截图留档。

### 15.5 安全建议

- 定期轮换 `ADMIN_TOKEN`（后台无法改，只能到控制台改 Secret，改完重新部署）
- 定期轮换客户端访问密钥（后台可停用/删除旧的）
- 如果接入的是**付费** Provider，务必在上游**关闭 Pay-as-you-go 或设置消费上限** —— Token 限制是基于已完成请求的统计，并发请求可能造成少量超额
- 公开部署建议加 **Cloudflare Access** 或 **WAF 规则**，限制 `/admin/*` 的访问来源
- 不要使用绑定高额余额的主 Key

---

## 附录 A：如果完全不想用 Workers Builds

**适用场景**：Workers Builds 免费额度用完，或不想让 Cloudflare 读你的 GitHub 仓库。

这条路**仍然不需要命令行**，但要接受两个限制：① 无法自动重新部署，每次改代码都要手动粘贴；② 代码以「单文件 Worker」形式存在，`src/` 下多个 TS 文件需要先打包。

**不推荐**，仅作应急。步骤：

1. Worker → **Quick edit / Edit code**（在线编辑器）
2. 用 `npx wrangler deploy --dry-run --outdir=dist` 在本地产出打包文件后粘贴（这一步又需要命令行了）
3. 绑定 Manual 配置

> 📌 结论：**附录 A 实际上省不掉命令行**。如果你完全不想碰命令行，请老老实实用第 1~11 步的 Workers Builds 方案。

---

## 附录 B：本文涉及的所有 URL 一览

| 用途 | 地址 |
| --- | --- |
| Cloudflare 控制台 | https://dash.cloudflare.com |
| Workers & Pages | https://dash.cloudflare.com/?to=/:account/workers-and-pages |
| KV 列表 | https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces |
| D1 列表 | https://dash.cloudflare.com/?to=/:account/workers/d1 |
| 新建 GitHub 仓库 | https://github.com/new |
| 服务健康检查 | `<WORKER_URL>/health` |
| 就绪检查 | `<WORKER_URL>/health?check=ready` |
| 模型清单（需 Bearer） | `<WORKER_URL>/v1/models` |
| 后台登录页 | `<WORKER_URL>` |

---

*本文基于 `llmflare-anon` v1.3.0-anon.0 源码逐项核对撰写。原始项目：[Jiao77/LLMflare](https://github.com/Jiao77/LLMflare)（MIT）。*
