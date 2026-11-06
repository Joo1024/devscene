# WorkScene 本机接入协议 v1

传输：`POST http://127.0.0.1:<随机端口>/v1/...`，JSON，`Authorization: Bearer <token>`。应用启动时原子写入标准用户数据目录的 `connection.json`：`{ "protocol":1, "port":12345, "token":"64位十六进制字符串" }`。本机 UI 扩展每次请求读取描述文件，因此桌面重启或令牌更新可自动恢复。此文件不得提交或导出。

仅接收 VS Code 稳定版桌面扩展；`vscode.env.uriScheme === 'vscode'`。不同协议版本返回 400。无授权/浏览器 Origin/Host 不合法返回 401；方法错误 405；未知端点 404；报告最大 256 KiB。禁止对外绑定或将端口转发到远端。

## 报告与心跳

`POST /v1/report` 注册/更新会话，`POST /v1/poll` 使用相同报告并拉取该实例操作；实际扩展每 2 秒使用 poll，将上报和执行前再确认合并。

```json
{
  "protocol": 1,
  "tool": "vscode-stable",
  "toolVersion": "1.145.2",
  "instanceId": "d6978893-e9ee-47b4-a870-e128fd9b8ca7",
  "workspaceName": "API",
  "folders": [
    {
      "uri": "file:///Users/example/code/api",
      "canonicalPath": "/Users/example/code/api",
      "checkoutRoot": "/Users/example/code/api"
    },
    { "uri": "vscode-remote://ssh-remote+build/srv/api" }
  ],
  "focused": true,
  "activeFile": "file:///Users/example/code/api/src/main.ts",
  "capabilities": ["activateSession"]
}
```

`canonicalPath`、`checkoutRoot` 为可选可取得的本机元数据；当 Git API 可用时还上报 `git: {rootUri, branch?, head?}`，这些元数据不代替环境与路径身份。远端 URI 的环境必须通过显式别名映射。不能获取 Git API 时省略 checkout 信息，不猜测。工具所在环境始终是运行 UI 扩展的本机，目录可以属于其他环境。

服务端为 Session 增加 `source: extension`、`toolEnvironmentId`、`lastConfirmed`、`locationIds` 和 `unresolved`。收到报告的服务端时间就是心跳确认时间。工具版本/标题/文件更新不创建新实例；扩展重载产生新 UUID，旧会话正常退出或 35 秒后过期。

`POST /v1/exit`：`{"instanceId":"..."}`；立即移除目标会话，使其未完成操作失败。退出交付尽力而为，TTL 负责崩溃恢复。

## 能力与操作

`openLocation` 是桌面系统适配器能力：本机使用 `code --new-window -- <path>`，SSH 使用 `code --new-window --remote ssh-remote+<显式别名> -- <path>`。这只表示打开请求，不能代替 `activateSession`，也不能用来推测已有窗口。桌面 IPC 为该操作生成唯一请求 ID、位置目标和 15 秒期限，保留 accepted / executed / failed / timeout 结果并去重；executed 仅指 CLI 返回，不能宣称窗口已激活。它不经过扩展会话队列。

`activateSession` 是具体扩展实例声明的能力。扩展用 `vscode.commands.getCommands(true)` 检查 `workbench.action.focusWindow` 是否存在。没有命令的旧稳定版只上报，不宣称支持激活。选中具体 Session 后，桌面创建：

```json
{
  "protocol": 1,
  "id": "唯一请求 UUID",
  "kind": "activateSession",
  "targetId": "会话实例 UUID",
  "locationId": "可选的预期关联位置 ID",
  "expectedUris": ["file:///Users/example/code/api"],
  "createdAt": 1790000000000,
  "expiresAt": 1790000012000,
  "state": "pending",
  "message": "等待目标扩展接收"
}
```

服务端与扩展都会检查目标实例、有效期与当前目录 URI 集合。请求到达前工作区变化时失败；位置关联不匹配时失败；多个候选窗口由用户显式选择。不会按标题、进程数或最近打开列表定位窗口。

poll 返回 `{"requests":[...]}`，请求转为 `accepted`。扩展在所属窗口宿主执行 `workbench.action.focusWindow`，观察 `vscode.window.state.focused`（最多再等 1.8 秒），再提交 `POST /v1/result`：

```json
{
  "id": "请求 UUID",
  "report": {
    "protocol": 1,
    "tool": "vscode-stable",
    "toolVersion": "...",
    "instanceId": "...",
    "workspaceName": "...",
    "folders": [],
    "focused": true,
    "capabilities": ["activateSession"]
  },
  "state": "activated",
  "message": "目标扩展确认该窗口已获得焦点"
}
```

| 状态        | 证据与语义                                   |
| ----------- | -------------------------------------------- |
| pending     | 应用创建，尚未由扩展接收                     |
| accepted    | 目标扩展拉取，不能称已激活                   |
| executed    | 命令返回，但未观察到焦点                     |
| activated   | 目标扩展执行命令并观察到焦点                 |
| unsupported | 扩展未提供该能力                             |
| failed      | 目标消失、关联改变、命令失败等，message 解释 |
| timeout     | 有效期内未得到完整结果，执行事实可能未知     |

每个请求只投递一次，扩展缓存已处理请求 ID；回执发送失败可重试，服务端终态不被重复回执覆盖。迟到结果不把超时改成成功。没有失败后自动新开窗口的路径。所有协议消息只用于已授权本机用户，不是给不可信公网客户端的 API。
