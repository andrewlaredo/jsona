# jsona

**结构优先、本地优先的 JSON / YAML / TOML / CSV 查看器与处理工具。**

打开文件即可用，数据默认不离开你的机器；可选连接分享服务器获得短链与 GitHub 账号同步。

## 特性

- **多格式解析**：JSON / YAML / TOML / CSV，自动探测格式，剥离 BOM。
- **结构优先查看**：树视图（虚拟滚动，超大文件不卡）、列视图、表格视图、图谱视图（react-force-graph 力导向 + 3D）、Diff 对比。
- **就地编辑**：Monaco 编辑器 + 实时解析校验 + 下载真实序列化（按格式导出）。
- **AI 助手（三层架构）**：
  - **L1 本地**：离线结构分析、路径查找、差异解释，零上传。
  - **L2 云端**：可选连接后端，**BYOK（自带密钥）**——你填自己的 OpenAI / Anthropic / 兼容网关 Key，jsona 零成本代理转发，不托管模型、不收 token 费。
  - **L3 MCP**：`jsona mcp` 以标准 MCP Server 运行（stdio / HTTP-SSE / OAuth / WebSocket 四传输），提供 `jsona_query` / `jsona_schema` / `jsona_diff` / `jsona_ask`(sampling) / `jsona_roots`(roots) 工具与 `jsona://help` / `jsona://samples` 资源、prompts。
- **分享与同步（可选后端）**：短链分享、GitHub 登录的 workspace 同步。

## 三大包

| 包 | 说明 | 许可证 |
|---|---|---|
| `packages/core` | 解析 / 序列化 / 图构建 / 差异（纯函数，零依赖） | MIT |
| `packages/web` | 前端查看器（React + Vite，可纯离线） | MIT* |
| `packages/cli` | 命令行 `jsona`：`query` / `format` / `minify` / `sort` / `diff` / `mcp` | MIT |
| `server` | 可选分享 / 同步后端（Node + SQLite-WASM） | MIT* |

> *许可证状态见下。

## 5 秒上手

```bash
# 前端（纯离线，打开即用）
pnpm install
pnpm dev            # 启动 web，浏览器打开提示的地址

# 命令行
cd packages/cli
pnpm build
node dist/index.js query 'data.users[*].name' input.json
node dist/index.js mcp        # 启动 MCP server
```

## 环境变量

- **前端**（`packages/web/.env`）：`VITE_API_BASE`（指向分享服务器，如 `http://localhost:8787`；不配则纯离线）。
- **后端**（`server/.env`，见 `server/.env.example`）：`SESSION_SECRET`、`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（启用登录）、`BYOK_MASTER_KEY`（AI 密钥加密主密钥）、`PUBLIC_ORIGINS`（CORS）、`DB_PATH`、`RATE_*`。

> 纯离线使用**不需要任何环境变量**。只有分享短链 / GitHub 登录 / BYOK AI 才需要后端与相应变量。

## 许可证（待定）

`core` 与 `cli` 为 **MIT**。`web` 当前 `package.json` 写 **GPL-3.0-or-later**，与根仓库 MIT 存在冲突——**发布前需统一**（见 `开发计划.md` 的「收尾与发布 Checklist」A.1）。在解决前，请以各子包 `package.json` 的 `license` 字段为准。

## 文档

- `开发计划.md`：完整路线图、架构决策、已实现状态与收尾清单。
- `server/README.md`：分享服务器部署与配置。
- `DEPLOY.md`：npm 发布流程（含 passkey 2FA 认证方式）、前端 Vercel 静态部署、后端有状态容器部署、整体架构与收费状态。
