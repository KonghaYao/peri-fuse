# @peri-fuse/langfuse-mcp

基于 [@peri-code/mcpp](https://github.com/peri-code/open-mcp-market/tree/main/packages/mcpp) 的 MCP Server，将本包内 `skills/langfuse/` 目录按 **MCPP 通道 B** 投影为 MCP Resources。

- **协议**：MCP `2026-07-28`（由 `createMcpHandler` / `createMcppServerFactory` 承载，旧版协议请求会被拒绝）
- **挂载**：`skillsDir` 指向包内 `skills/`；更新 skill 时直接替换 `skills/langfuse/` 即可，无需改仓库根 `.claude`

生产使用时，推荐连接 Peri-Fuse 主 server 的 `/mcp` HTTP 端点。它与 dashboard/API 共用同一端口和项目级 Basic API key；默认端口为 `23332`，源码开发端口为 `23432`。

## 资源 URI 示例

```text
skill://langfuse/SKILL.md
skill://langfuse/references/cli.md
skill://langfuse/scripts/analyze.ts
```

## 运行

```bash
# 仓库根目录
pnpm install
pnpm run build

# 主 server HTTP MCP（推荐，先启动 Peri-Fuse）
pnpm svc:start

# 可选 stdio server（构建后使用 Node 22）
pnpm --filter @peri-fuse/langfuse-mcp run build
pnpm --filter @peri-fuse/langfuse-mcp run start:stdio
```

服务端运行只需 Node.js；skill 中的可选分析脚本仍使用 Bun，在 MCP 客户端所在机器执行。HTTP 端点只分发资源，不会代客户端执行脚本或查询项目数据。

## MCP 客户端配置

仓库根目录 `.mcp.json` 已注册 `langfuse`（生产 HTTP）和 `langfuse-dev`（开发 HTTP）。将 `Authorization` 中的 `<base64(publicKey:secretKey)>` 替换为当前项目 API key 的 Basic 编码值；配置使用 placeholder，仓库中不包含真实 key。

也可复制 `packages/langfuse-mcp/mcp.json` 中的片段到你的客户端配置。若客户端只支持 stdio，可使用构建后的 Node 入口并传入 `--stdio`，无需 Bun：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["packages/langfuse-mcp/dist/cli.js", "--stdio"]
}
```
