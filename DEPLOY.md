# 部署与发布指南 (DEPLOY)

jsona 由三部分组成，发布/部署彼此独立：

| 部分 | 包名 / 位置 | 托管方式 | 是否需要 |
|---|---|---|---|
| 解析核心 | `jsona-core` (npm) | npm registry | 发布 CLI 时必须 |
| 命令行 | `jsona-view` (npm, `bin: jsona`) | npm registry | 可选 |
| 前端查看器 | `packages/web/dist` | 静态托管 (Vercel / GH Pages / 任意) | 可选，可纯离线 |
| 分享/同步后端 | `server/` | 有状态容器 (Railway / Render / Fly / VPS) | 仅启用分享/同步/AI 时需要 |

> 前端可完全离线运行，**不依赖任何后端**。只有「短链分享 / GitHub 登录同步 / BYOK AI」才需要后端。

---

## 一、npm 发布流程（core / cli）

### 1.1 前置

- 已 `npm login`（账号开启 2FA 时见下方 1.3）。
- 已构建产物：`pnpm --filter jsona-core build` 与 `pnpm --filter jsona-view build`（dist 存在）。
- 顺序：**先发 `jsona-core`，再发 `jsona-view`**（cli 依赖 core）。

### 1.2 发布命令

```powershell
# 1) core
cd d:/Y/WY/2026/jsona/packages/core
npm publish --access public

# 2) cli（core 发完后再发）
cd d:/Y/WY/2026/jsona/packages/cli
npm publish --access public
```

### 1.3 ⚠️ 2FA 认证方式（重要经验，2026-08-15 实测）

若 npm 账号的 2FA 绑定的是**设备 PIN / 通行密钥（passkey / WebAuthn）**——
**不是** Google Authenticator 这类 6 位 TOTP 验证器——则：

- `npm publish` **不会**提示输入 6 位 OTP，`--otp` 参数无效（账号不产生 TOTP 码）。
- granular access token 上的 "bypass 2FA" 选项**对该类账号通常不生效**，用 token 发布会稳定返回：
  ```
  403 Forbidden - ... Two-factor authentication or granular access token
  with bypass 2fa enabled is required to publish packages.
  ```
- **正确做法**：直接运行 `npm publish --access public`，终端会打印一个
  `https://www.npmjs.com/auth/cli/...` 的认证链接。**手动在浏览器打开该链接完成一次设备验证**，认证成功后发布即继续进行并成功。

> 即：passkey 类 2FA 的发布流程 = 执行 publish 命令 → 复制终端里的 npmjs.com/auth/cli 链接 → 浏览器打开认证 → 自动完成发布。

### 1.4 发布后验证

```powershell
npm view jsona-core version    # 应返回 0.1.0
npm view jsona-view version    # 应返回 0.1.1 之类
```

### 1.5 发补丁 / 新版本

1. 在对应包目录改 `package.json` 的 `version`（遵循 semver：`patch` 修 bug、`minor` 加功能、`major` 破坏性）。
2. 重新 `build`（core / cli 都是 `tsc` 输出到 dist）。
3. 重复 1.2 + 1.3 的「publish → 浏览器打开链接认证」流程。
4. 每次发布都需重新走一次浏览器认证链接（链接一次性有效）。

---

## 二、前端 web 部署（Vercel，静态）

web 是纯静态 SPA（`packages/web/dist`），**不能**用 Vercel 的 serverless 跑后端逻辑，
但静态托管完全没问题。

### 2.1 一键接入（根 `vercel.json` 已就绪）

仓库根的 `vercel.json` 已配置好构建参数：

```json
{
  "framework": "vite",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter @jsona/web build",
  "outputDirectory": "packages/web/dist"
}
```

Vercel 会自动读取它，**无需手动改项目设置**。关键点：

- **必须在仓库根构建**（不能设 root directory 到 `packages/web`），因为 web 依赖 workspace 的 `jsona-core`。
- 连接 GitHub 仓库后，Vercel 检测到 `pnpm-lock.yaml` 会自动使用 pnpm。
- 若用 CLI 部署（非 GitHub 连接）：`vercel --prod`（从仓库根执行）。

### 2.2 纯离线部署（推荐起步）

不配置任何环境变量，直接部署即可：

- web 启动后**完全本地优先**，JSON/YAML/TOML/CSV 查看、图谱、Diff、MCP 本地功能全部可用。
- 「分享短链 / GitHub 同步 / AI 面板」因无 `VITE_API_BASE` 而隐藏或降级。

### 2.3 接入后端（启用分享/同步/AI）

在 Vercel 项目的 **Environment Variables** 中加（生产/预览环境）：

| 变量 | 值 | 说明 |
|---|---|---|
| `VITE_API_BASE` | `https://你的server域名` | 指向第三节部署的后端，如 `https://share.onrender.com` |

重新触发一次部署使变量生效。此后 web 的「服务器短链」「工作区同步」「AI 设置」入口出现。

> `VITE_` 前缀的变量在**构建时**注入，改了需重新部署（不是运行时读取）。

---

## 三、后端 server 部署（有状态容器）

> ⚠️ **不能部署到 Vercel**。server 用 `node-sqlite3-wasm` 需要持久化磁盘写文件，
> 且是常驻 express 进程（监听 8787），与 Vercel 的短时 serverless 模型不兼容。

### 3.1 推荐平台

| 平台 | 成本 | 适配度 |
|---|---|---|
| Railway / Render / Fly.io（容器） | 免费额度起 | ⭐ 最合适，支持常驻进程 + 持久卷 |
| 任意 VPS（Docker 部署） | ~$5/月 | ⭐ 完全可控，适合长期 |
| Vercel + 外接 libSQL | 中 | 需改 db 层，工作量大，不推荐 |

### 3.2 Render 一键部署（Blueprint，推荐）

仓库 `server/render.yaml` 已备好 Blueprint（Docker + 持久盘 `/app/data`）：

1. 将仓库推到 GitHub（见第三节末尾「0. 前置：推到 GitHub」）。
2. Render Dashboard → **New → Blueprint** → 选择该 GitHub 仓库。
3. Render 读取 `render.yaml` 自动创建 Web Service。填入缺失的 env（见 3.3）：
   - `PUBLIC_URL` = 服务公网域名（Render 会分配 `*.onrender.com`，可用自定义域名后回填）
   - `PUBLIC_ORIGINS` = Vercel 前端域名
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（如启用登录）
   - `PRO_LOGINS` / `TEAM_LOGINS`（可选白名单）
   - `SESSION_SECRET` / `BYOK_MASTER_KEY`：Blueprint 已用 `generateValue: true` 自动生成，**务必保存 Render 控制台显示的值**（只显示一次）。
4. 部署后访问 `/api/health` 应返回 `{"ok":true,...}`。

> Render 免费实例无外网请求时约 15 分钟休眠，醒来首次请求会因 WASM 初始化慢而超时（见 3.2-b 的实测说明）；有流量后常驻则正常。

### 3.2-b ⚠️ 实测经验（2026-08-19）

- **`node-sqlite3-wasm` 首次初始化很慢**：在本地 Windows 实测首次加载约 **11 秒**（之后复用缓存 < 1 秒）。
  因此健康检查/首次请求务必给足超时（≥15s），不要设 3~5 秒的短超时判活。
- **Docker 镜像内无 `.env` 文件**：`Dockerfile` 的 CMD 已改为 `node dist/server.js`
  （纯读平台注入的环境变量），**不要**在镜像里 COPY `.env`（会泄露密钥）。
- Render 反向代理已在 Blueprint 中设 `TRUST_PROXY=1`，限流可看到真实客户端 IP。

### 3.2-c Docker 通用部署（Railway / VPS）

```bash
cd server
docker build -t jsona-share .
docker run -d -p 8787:8787 \
  -e PUBLIC_URL=https://share.jsona.app \
  -e PUBLIC_ORIGINS=https://jsona.app \
  -e SESSION_SECRET=<long-random> \
  -e GITHUB_CLIENT_ID=<...> -e GITHUB_CLIENT_SECRET=<...> \
  -e BYOK_MASTER_KEY=<long-random> \
  -v jsona-data:/app/data jsona-share
```

要点：
- **必须挂载卷**到 `/app/data`（SQLite 持久化）。不挂则重启数据丢失。
- 反向代理后加 `-e TRUST_PROXY=1`，否则所有请求共享一个限流配额。
- `SESSION_SECRET` / `BYOK_MASTER_KEY` 生成：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。

### 3.3 环境变量清单（来自 `server/.env.example`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 默认 8787 |
| `PUBLIC_URL` | 是 | 公网可达基址，用于短链响应 |
| `SESSION_SECRET` | 是 | 签名 session cookie，长随机 |
| `BYOK_MASTER_KEY` | 启用 AI 时 | AES-256-GCM 主密钥，加密用户自带 Key |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 启用登录时 | GitHub OAuth |
| `GITHUB_ALLOWED_USERS` | 否 | 限定的 GitHub 登录名，空=允许任意 |
| `PUBLIC_ORIGINS` | 是 | CORS 允许的 web 源，逗号分隔或 `*` |
| `DB_PATH` | 否 | SQLite 路径，默认 `./data/share.db` |
| `SHARE_TTL` / `WORKSPACE_TTL` | 否 | 短链 / 工作区过期秒数 |
| `TRUST_PROXY` | 否 | 反向代理后设 `1`（Render Blueprint 已内置） |
| `RATE_WINDOW_MS` / `RATE_WRITE_MAX` / `RATE_READ_MAX` | 否 | 限流窗口与阈值 |
| `MAX_SHARE_BYTES` / `MAX_WORKSPACES_PER_USER` | 否 | 负载上限 |
| `PRO_LOGINS` / `TEAM_LOGINS` | 否 | 逗号分隔的 GitHub 登录名 → 提升为 Pro/Team 配额；空=全部 Free |

### 3.4 前置：推到 GitHub

Render 与 Vercel 都通过 GitHub 仓库连接（Blueprint / Import Project 均需仓库）。当前本地还没有 git 仓库，需先初始化并推送：

```powershell
cd d:/Y/WY/2026/jsona
git init
git add -A
git commit -m "init: jsona monorepo (core/cli/web/server)"
git branch -M main
git remote add origin git@github.com:<你的用户名>/jsona.git
git push -u origin main
```

> `.gitignore` 已排除 `node_modules/`、`dist/`、`.env`、`*.log`，密钥不会进仓库。
> 注意：`server/.env`（含 GitHub 密钥）被忽略，**不要**手动 `git add -f`。

### 3.5 GitHub OAuth 设置

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Authorization callback URL = `https://<你的server>/api/oauth/callback`（Render 域名，非本地）。
3. 把 Client ID / Secret 填入 Render 环境变量的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。
4. 重启 server，web 的「使用 GitHub 登录」按钮激活。

> 本地 `.env` 里的 GitHub 凭据是**本地测试**用的，回调 URL 是 `localhost`；
> 生产环境需**另建一个 OAuth App**（回调域名指向 Render），不可混用。

---

## 四、整体架构（典型部署）

```
┌─────────────┐         ┌──────────────────────┐
│  Vercel     │  HTTP   │  有状态容器           │
│  web (SPA)  │ ──────▶ │  server (express)    │
│  dist 静态  │VITE_    │  8787 + SQLite 卷     │
│  托管       │ API_BASE│  分享/同步/BYOK AI    │
└─────────────┘         └──────────────────────┘

npm: jsona-core (解析核心) ──▶ jsona-view (CLI bin: jsona)
```

- web 与 server 通过 `VITE_API_BASE` 解耦：web 可独立存在，server 可独立部署。
- CLI（`jsona-view`）完全独立，安装即用，不依赖 web 或 server。

---

## 五、收费 / 套餐（当前状态）

配额门禁已实现于 `server/src/plans.ts`（free / pro / team 三档，含文档大小、分享数、TTL、密码保护）。
**但 tier 来源目前是 GitHub 登录名白名单**（`PRO_LOGINS` / `TEAM_LOGINS` 环境变量），
**并非真实支付**——属占位/雏形。

接入真实付费计费时只需替换 `tierFromAllowList()` 一个函数（改为查订单 / 订阅表），
配额强制逻辑无需改动。前端定价页、支付（Stripe / 微信 / 支付宝）、账单中心为待补环节。
