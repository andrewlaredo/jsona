# jsona Share Server — Windows Server 2019 部署步骤

> 目标：把 jsona 后端（分享短链 / GitHub 同步 / BYOK AI）部署到 Windows Server 2019 x64 服务器。
> 服务用纯 Node.js 运行（`node-sqlite3-wasm` 为 WASM 实现，无原生编译，无需 Docker）。

## 前置

| 项 | 要求 |
|---|---|
| OS | Windows Server 2019 x64 |
| Node.js | **20.x LTS**（需 ≥20.6，`--env-file` 语法依赖 20.6+） |
| 端口 | 8787（可改） |
| 域名 | 建议有，否则 GitHub OAuth 回调不便用 HTTPS |

---

## 一、安装 Node.js

1. 到 https://nodejs.org 下载 **Node.js 20 LTS Windows x64 (.msi)**。
2. 双击安装，一路 Next（保持默认 `C:\Program Files\nodejs`，会自动加入 PATH）。
3. 验证：
   ```powershell
   node -v
   npm -v
   ```

## 二、获取 server 代码

两种方式任选：

**方式 A：Git clone（推荐，后续更新方便）**
```powershell
# 安装 Git for Windows 后：
git clone https://github.com/andrewlaredo/jsona.git C:\jsona
cd C:\jsona\server
```

**方式 B：上传本地文件夹**
从开发机把 `server/` 整个目录复制到服务器（**不含 node_modules**）。

## 三、安装依赖并构建

在 `C:\jsona\server` 下执行：

```powershell
# 1. 安装依赖（含构建所需的 typescript）
npm install

# 2. 构建 dist
npm run build

# 3. 验证 dist 产出
dir dist
```

> 若 `npm install` 因网络慢失败，可换国内镜像：
> `npm config set registry https://registry.npmmirror.com` 后再装。

## 四、配置 .env

```powershell
copy .env.example .env
notepad .env
```

**必须改的：**

| 变量 | 值 |
|---|---|
| `PUBLIC_URL` | `https://share.你的域名.com`（有域名）或 `http://服务器IP:8787` |
| `PUBLIC_ORIGINS` | 你的 Vercel 前端域名，如 `https://jsona-xxxx.vercel.app` |
| `SESSION_SECRET` | 长随机串，见下 |
| `BYOK_MASTER_KEY` | 64 位 hex 随机串，见下 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 生产 OAuth App（如启用登录） |
| `TRUST_PROXY` | 若用 IIS/nginx 反代设 `1`，直连保留 `0` |

**生成两个密钥**（在服务器任意目录执行）：
```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
跑两次，分别填进 `SESSION_SECRET`（32 字节 hex）和 `BYOK_MASTER_KEY`（64 位 hex）。

> ⚠️ `.env` 含密钥，**不要**提交到 git、不要上传到公开位置。

## 五、防火墙放行端口

管理员 PowerShell：
```powershell
New-NetFirewallRule -DisplayName "jsona-share-8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

## 六、前台启动测试

```powershell
cd C:\jsona\server
node --env-file=.env dist/server.js
```

看到 `[jsona-share] listening on 8787` 后，浏览器访问：
```
http://服务器IP:8787/api/health
```
应返回 `{"ok":true,"oauth":false,"store":"sqlite","shares":0,...}`。

> 首次启动 `node-sqlite3-wasm` 初始化较慢（约 10 秒），属正常现象。
> 验证后 `Ctrl+C` 停掉。

## 七、注册为 Windows 服务（开机自启 + 崩溃重启）

推荐 **NSSM**（Non-Sucking Service Manager），纯命令行、稳定：

1. 下载 https://nssm.cc/download，解压 `win64/nssm.exe` 放到 `C:\tools\nssm.exe`。

2. 管理员 PowerShell 安装服务：
   ```powershell
   # 参数：node 路径、脚本参数、工作目录
   C:\tools\nssm.exe install jsona-share "C:\Program Files\nodejs\node.exe" "--env-file=C:\jsona\server\.env C:\jsona\server\dist\server.js"
   C:\tools\nssm.exe set jsona-share AppDirectory "C:\jsona\server"
   C:\tools\nssm.exe set jsona-share AppStdout "C:\jsona\server\service.log"
   C:\tools\nssm.exe set jsona-share AppStderr "C:\jsona\server\service.err.log"
   C:\tools\nssm.exe set jsona-share AppRestartDelay 5000
   C:\tools\nssm.exe set jsona-share Start SERVICE_AUTO_START
   C:\tools\nssm.exe start jsona-share
   ```

3. 验证服务：
   ```powershell
   sc query jsona-share
   ```
   应显示 `RUNNING`。

> 备选：PM2。`npm i -g pm2` 后 `pm2 start dist/server.js --name jsona-share` + `pm2 save` + `pm2-startup`，但 NSSM 更贴近 Windows 原生服务。

## 八、（可选）HTTPS + 域名

GitHub OAuth 回调必须是 HTTPS。若启用登录，建议配 HTTPS：

**方案 A：IIS + URL Rewrite**
1. 服务器管理器 → 添加 IIS 角色。
2. 安装 URL Rewrite 模块（Microsoft 下载）。
3. 站点绑定域名 + SSL 证书（可用 Let's Encrypt 或商业证书）。
4. URL Rewrite：把 `/*` 反向代理到 `http://localhost:8787`。

**方案 B：Caddy 2（推荐，自动 HTTPS）**
```powershell
# 下载 caddy_2.x_windows_amd64.zip，放 C:\caddy\
# C:\caddy\Caddyfile:
# share.你的域名.com {
#     reverse_proxy 127.0.0.1:8787
# }
C:\caddy\caddy.exe run
```
Caddy 自动申请 Let's Encrypt 证书。

## 九、回填 Vercel

部署完成后：
1. Vercel → Project → Settings → Environment Variables。
2. 加 `VITE_API_BASE=https://share.你的域名.com`（或 `http://服务器IP:8787`）。
3. **Redeploy**。

## 十、GitHub OAuth（如启用）

生产环境需**另建** OAuth App（本地 `.env` 那套是 localhost 回调，不能复用）：
1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Authorization callback URL = `https://share.你的域名.com/api/oauth/callback`。
3. Client ID / Secret 填入 `C:\jsona\server\.env`。
4. 重启服务：`nssm restart jsona-share`。

---

## 数据与备份

- **数据文件**：`C:\jsona\server\data\share.db`（SQLite，WAL 模式）。
- 备份 = 停止服务后复制 `data\share.db`（或热备：复制 `.db` + `.db-wal` + `.db-shm`）。
- 建议每日定时任务（任务计划程序）复制到异地目录。

## 升级更新

```powershell
cd C:\jsona
git pull
cd server
npm install
npm run build
nssm restart jsona-share
```

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `database is locked` | 有旧进程占着 DB，`taskkill /F /IM node.exe` 后重启 |
| 服务启动失败 | 查 `C:\jsona\server\service.err.log` |
| `/api/health` 502 | 服务没起来或端口被占，`netstat -ano | findstr 8787` |
| 首次请求慢 | WASM 初始化约 10s，属正常；有流量后常驻 |
