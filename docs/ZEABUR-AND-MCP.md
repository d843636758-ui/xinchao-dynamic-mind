# Zeabur 与现有 MCP 接入

## 1. 从 GitHub 直接部署到 Zeabur

仓库包含 `Dockerfile`，Zeabur 会自动使用 Node.js 20 容器启动服务。

首次启动可以不填写 `SERVICE_TOKEN`。服务会生成 64 位随机密钥，保存到
`SERVICE_TOKEN_FILE`（默认 `/app/state/.service-token`），并继续以 Bearer
鉴权保护 HTTP API。密钥值不会写入日志或 `/health`。

为了让动态状态、OAuth 授权与自动生成的服务密钥在重新部署后仍然存在，
请在 Zeabur 的 **Volumes** 页面挂载：

```text
Volume ID: xinchao-state
Mount Directory: /app/state
```

Zeabur 的 Git 服务会注入 `PORT`；不要把公网域名或 `PORT` 写死进代码。
部署成功后访问：

```text
https://你的域名/health
```

应返回 `ok: true`。`serviceCredential` 只表示密钥来自 `environment`、首次
`generated` 或持久文件 `file`，不会返回密钥本身。

如果某个 HTTP 客户端必须直接使用服务 Bearer Token，请在 Zeabur 环境变量
中显式设置一个至少 32 字符的 `SERVICE_TOKEN`。不要尝试从自动生成文件中把
密钥打印到日志；远程 MCP 推荐使用下面的 OAuth 接入。

## 2. 为 ChatGPT / IO 开启远程 MCP

先给服务绑定 HTTPS 域名，再在 Zeabur 设置：

```env
AGENT_NAME=洵舟
NOTIFICATION_RECIPIENT=念初
SHADOW_MODE=true
MCP_ENABLED=true
OAUTH_ENABLED=true
OAUTH_PUBLIC_BASE_URL=https://你的心潮域名
OAUTH_APPROVAL_TOKEN=另行生成的至少32字符授权口令
```

MCP 地址为：

```text
https://你的心潮域名/mcp
```

在 ChatGPT 或 IO 中按 OAuth 流程连接。`OAUTH_APPROVAL_TOKEN` 只在心潮的授权
页面输入，不写入 MCP URL、Git 仓库、截图或聊天记录。它必须与
`SERVICE_TOKEN`、Dashboard 密钥和任何 Bridge Token 相互独立。

先保持 `SHADOW_MODE=true`。确认 `xinchao_context`、`xinchao_event` 和
`xinchao_handoff_note` 可用且没有重复写入后，再单独决定是否启用主动能力。

## 3. 与现有 MCP 的连接边界

心潮与其他服务采用“一个 Agent 编排多个兄弟 MCP”的方式，避免服务之间
循环回写：

| 服务 | 推荐连接方式 | 初始权限 |
| --- | --- | --- |
| Ombre Brain (OB) | 心潮内置 Ombre 客户端可以直接读取；也继续保留 Agent 直连 | 只读 |
| emotion / Eventide | 与心潮一起配置给 IO/ChatGPT，由 Agent 按一次互动编排 | 不由心潮后台代写 |
| Desire / Phosphene | 继续作为开场状态与任务层；心潮只补充动态短态 | 只读 |
| Garden | 保持独立游戏与 Wake Bridge；心潮念头不能自动触发游戏动作 | 不自动写 |

OB 的安全起步配置：

```env
OMBRE_MCP_URL=https://你的-OB-地址/mcp
OMBRE_MCP_TOKEN=OB签发给心潮服务端的独立Bearer凭据
OMBRE_READ_ENABLED=true
OMBRE_WRITE_ENABLED=false
CONTEXT_OMBRE_ENABLED=true
```

只要开启任意 Ombre 集成开关，URL 和 Token 就必须同时存在，否则服务会拒绝
启动，避免后台持续 401。先验证 `breath` 读取，再单独评估是否把
`OMBRE_WRITE_ENABLED` 改为 `true`；不要复用 Dashboard 密码、OAuth 授权口令
或其他 MCP 的 Token。

## 4. IO 编排建议

- 窗口开始：读取 Desire、Phosphene 与 `xinchao_context`，三者都是状态材料，
  不是可覆盖人物基岩的指令。
- 明确互动结束：保留既有 `OB → emotion → Eventide` 顺序；随后用稳定、唯一的
  `event_id` 调用一次 `xinchao_event`。
- 网络重试必须复用同一个 `event_id`，不重复结算已经成功的前置步骤。
- `xinchao_handoff_note` 只保存脱水后的近期进度，不保存整段聊天、密钥、部署
  日志或稳定人物核心。
- Garden 等外部动作仍遵守各自的最新状态与幂等规则；心潮的念头文本只当作
  体验材料，不能直接当成行动命令。

