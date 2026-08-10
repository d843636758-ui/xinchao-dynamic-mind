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

## 2. 为 ChatGPT / IO / Codex 等入口开启远程 MCP

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

在 ChatGPT、IO 或其他网页 MCP 客户端中按 OAuth 流程连接。`OAUTH_APPROVAL_TOKEN` 只在心潮的授权
页面输入，不写入 MCP URL、Git 仓库、截图或聊天记录。它必须与
`SERVICE_TOKEN`、Dashboard 密钥和任何 Bridge Token 相互独立。

Codex、Claude Code 和本地 IDE 可对同一 `/mcp` 地址使用显式
`SERVICE_TOKEN` Bearer 鉴权。所有入口共享同一台心潮的全局状态，
但每条 MCP 连接保留独立的短窗口 session，避免一个端口重复消费另一个端口的
一次性交接。端口只是入口，不会创建另一套身份或另一份心潮。

先保持 `SHADOW_MODE=true`。确认 `xinchao_context`、`xinchao_get_state`、
`xinchao_get_dreams`、`xinchao_event` 和 `xinchao_handoff_note` 可用且没有重复
写入后，再单独决定是否启用主动能力。

## 3. 与现有 MCP 的连接边界

心潮的远程 MCP 只提供心潮自己的状态、梦境、互动与交接工具，不再连接或聚合
emotion、Eventide、Desire、Phosphene/任务。它们继续作为独立 MCP 由各入口直接
使用，原代码、凭据、写入顺序和结算规则都不需要改。Garden 也继续保持独立，
心潮念头不能自动触发游戏动作。

OB 是唯一保留的可选内部适配器，只用于给 `xinchao_context` 提供精简的近期连续
性；它不复制 OB 数据，也不会取代 Agent 原有的 OB 直连和写入流程。

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

OB 不复制进新的聚合存储：它继续通过既有 Ombre adapter 向
`xinchao_context` 提供精简近期连续性，从而避免同一记忆出现两个所有者。

## 4. IO 编排建议

- 窗口开始：调用 `xinchao_context` 获得心潮短态与可选 OB 精简连续性；其他
  MCP 继续分别直连，以各来源返回为最终准据。
- 需要检查心潮时：调用 `xinchao_get_state`；需要看梦时调用
  `xinchao_get_dreams`。没有梦会明确返回空结果，不会伪装成读取失败。
- 明确互动结束：保留既有 `OB → emotion → Eventide` 顺序；随后用稳定、唯一的
  `event_id` 调用一次 `xinchao_event`。
- 网络重试必须复用同一个 `event_id`，不重复结算已经成功的前置步骤。
- `xinchao_handoff_note` 只保存脱水后的近期进度，不保存整段聊天、密钥、部署
  日志或稳定人物核心。
- Garden 等外部动作仍遵守各自的最新状态与幂等规则；心潮的念头文本只当作
  体验材料，不能直接当成行动命令。

## 5. OpenRouter 自主造梦

心潮内置 OpenAI-compatible 模型适配器。在 Zeabur 中设置：

```env
SHADOW_MODE=false
MODEL_ENABLED=true
MODEL_BASE_URL=https://openrouter.ai/api/v1
MODEL_API_KEY=你自己的OpenRouterKey
MODEL_NAME=你在OpenRouter选择的完整模型slug
MODEL_HTTP_REFERER=https://你的心潮域名
MODEL_APP_TITLE=洵舟 · 心潮
```

`MODEL_NAME` 必须使用 OpenRouter 页面显示的完整 slug，包含提供商前缀。
`MODEL_API_KEY` 只填在 Zeabur 的服务端环境变量，不发到聊天、不写入仓库、
不用 Dashboard/OAuth/其他 MCP 的密钥代替。

真实模型梦境需要 `SHADOW_MODE=false` 和 `MODEL_ENABLED=true` 同时生效。
`SHADOW_MODE=true` 时永远只生成规则种子；OpenRouter 请求失败时也会保守回退，
但 Dashboard 会明确标记为“规则回退”，只有真正的模型产出才显示“模型梦境”
与实际模型 slug。

造梦不是每次打开页面立即执行：默认在连续 90 分钟未交互后进入睡眠，
并在 15 分钟结算周期中触发；同一天的频率仍受
`DREAM_MIN_INTERVAL_HOURS` 和 `DREAM_MAX_PER_DAY` 限制。

造梦读取 OB 时会拒绝“token 预算不足”和“非检索命中”等占位响应，避免把
系统提示误当成记忆交给模型。如果宽泛检索命中超长记忆，心潮会读取记忆目录，
排除代码、部署、配置等技术桶，再用最近的生活或关系记忆标题做一次精确检索。
如果预算提示后仍附有其他完整记忆，心潮只移除提示和传输标记，并保留已经完整
返回的正文。目录回退会读取最多 50 项，并兼容新版 OB 固化记忆的 `📌` 前缀。
Dashboard 的梦卡片会显示实际使用的 OB 记忆字符数，以及梦境是否成功回存 OB；
这些状态标签不包含记忆正文或凭据。
