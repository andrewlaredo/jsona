# jsona

**结构优先、本地优先的 JSON / YAML / TOML / CSV 查看器与处理工具。**

打开文件即可用，数据默认不离开你的机器；可选连接自有分享服务器，获得短链分享与 GitHub 账号同步。

## 特性

- **多格式解析**：JSON / YAML / TOML / CSV，自动探测格式，剥离 BOM，错误定位到行列。
- **结构优先查看**：树视图（虚拟滚动，超大文件不卡）、列视图、表格视图、图谱视图（力导向 2D + 3D）、Diff 对比。
- **就地编辑**：Monaco 编辑器 + 实时解析校验 + 按原格式导出真实序列化。
- **AI 助手**：
  - **本地**：离线结构分析、路径查找、差异解释，零上传。
  - **云端（BYOK）**：填你自己的 OpenAI / Anthropic / 兼容网关 Key，jsona 作为零成本代理转发，不托管模型、不收 token 费。
  - **MCP**：`jsona mcp` 以标准 MCP Server 运行（stdio / HTTP-SSE / OAuth / WebSocket），为 Agent 提供 `jsona_query` / `jsona_schema` / `jsona_diff` / `jsona_ask` 工具。
- **分享与同步（可选）**：短链分享、GitHub 登录的 workspace 多端同步。

## 快速开始

### Web 查看器（纯离线，打开即用）

```bash
pnpm install
pnpm dev       # 浏览器打开提示的地址
```

### 命令行（npm 安装）

```bash
npm i -g jsona-view

jsona query 'data.users[*].name' input.json
jsona format input.yaml -o output.json
jsona mcp     # 启动 MCP server
```

## 包结构

| 包 | 说明 | 许可证 |
|---|---|---|
| `jsona-core` | 解析 / 序列化 / 图构建 / 差异（纯函数，零依赖） | MIT |
| `jsona-view` | 命令行 `jsona`：`query` / `format` / `minify` / `sort` / `diff` / `mcp` / `serve` | MIT |
| `packages/web` | Web 查看器（React + Vite，可纯离线） | GPL-3.0 |
| `server/` | 可选分享 / 同步后端（Node + SQLite-WASM） | 闭源 |

> 数据默认不出本机。只有短链分享、GitHub 同步、BYOK AI 需要连接你自建的 server；纯离线使用无需任何配置。

## 文档

- `README.en.md`：English version.
- `server/README.md`：分享服务器部署与配置。
- `DEPLOY.md`：npm 发布流程、Vercel 静态部署、后端容器部署。
