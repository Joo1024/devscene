# WorkScene

发现、组织和返回开发工作现场的桌面工具。首版面向 macOS 与 **VS Code 稳定版**。

本机与 SSH 目录发现、Git checkout / worktree、真实窗口会话、搜索筛选、工作集、配置导入导出与安装诊断均已实现。窗口总数只表示 **已连接扩展的 VS Code 窗口**。没有上报时显示“尚未检测到有效会话”，不会推断用户没有打开窗口。

当前修复版本为 **0.1.1**，应用与 Connector 应一起升级。修复范围和复现对应关系见[审查修复记录](docs/review-fixes.md)。

## 构建与启动

开发需要 Node.js 24 LTS、npm 和 Git。macOS 建议安装 Xcode Command Line Tools（`xcode-select --install`），并将 VS Code Stable 放到 `/Applications/Visual Studio Code.app`。

```sh
npm ci
npm test
npm run package:extension
npm start
```

`npm start` 会编译并启动 Electron 桌面。应用、核心服务和 VS Code 扩展使用 TypeScript；Electron 让三者共用协议类型，且核心与界面可在 Linux CI 中实际运行。没有前端框架或本地数据库原生依赖。运行时不需要 Node.js 或源码目录，打包应用自带运行时。

```sh
# 在目标 macOS 上构建（默认当前 CPU 架构）
npm run package:mac
# 明确构建 Apple Silicon 或 Intel
npm run package:extension
npx electron-builder --mac dir zip --arm64 --publish never
npx electron-builder --mac dir zip --x64 --publish never

# Linux 开发/验证产物
npm run package:linux
```

产物在 `release/`：`workscene-connector.vsix`、macOS 的 `mac[-arm64]/WorkScene.app` 与 ZIP，或 Linux 的 `linux-unpacked/workscene`。构建使用 `package-lock.json` 锁定依赖；VSIX 被复制到应用资源目录，不依赖仓库路径。当前为未签名开发版本，尚无 Apple 签名、公证或自动更新；正式分发应在 macOS 配置 Developer ID 签名及公证。不能把 Linux 构建成功视作 macOS 运行验证通过。

## 安装与第一次配置

1. 解压 ZIP，把 `WorkScene.app` 放入“应用程序”。未签名开发构建在 macOS 上按系统提示用“右键 → 打开”或“隐私与安全性 → 仍要打开”授权。
2. 在“环境与扫描”编辑本机根目录，默认扫描深度 3；或用“添加目录”保留一个普通目录。点击扫描即可发现仓库及 Git 登记的根目录外 worktree。路径必须为绝对路径。
3. 打开“接入与诊断”，点击“安装扩展”。若 CLI 不可用，点击“定位 VSIX 文件”，在 VS Code 命令面板执行 **Extensions: Install from VSIX...**。也可运行：

   ```sh
   code --install-extension release/workscene-connector.vsix
   ```

4. 在已有 VS Code 窗口执行 **Developer: Reload Window**。扩展必须安装在本机 UI 端；Remote SSH 窗口也从本机 UI 扩展连接 WorkScene。检查状态栏 **WorkScene** 或命令 **WorkScene: Show Connection Status**。
5. 搜索位置，按环境、会话状态或工作集筛选。`⌘K` / `Ctrl+K` 聚焦搜索。选中目录，在右侧明确选择已有窗口；多窗口不会替你猜测。空窗口与无法映射环境的窗口可在“已连接窗口”查看。
6. “在新窗口打开”始终请求新窗口。打开命令成功只表示已提交给 VS Code；收到扩展会话后才更新窗口数量。

## SSH

SSH 环境使用已有系统 `~/.ssh/config`、ssh-agent、密钥和 known_hosts，不保存密码。先在终端确认目标可用且主机密钥已建立信任：

```sh
ssh my-build-host 'git --version && python3 --version'
```

在界面添加 SSH 环境：填写显示名称、系统 SSH 目标（别名或 `user@host`）、VS Code Remote SSH 使用的别名、远端绝对根目录、扫描深度。连接目标与 VS Code 别名可以不同，只有确认是 **同一账号、同一文件系统命名空间** 时才把多个别名映射到同一环境。目标身份规则创建后不可变，更换账号请新建环境。

远端需有 Git 与 Python 3.8+。扫描器通过 SSH stdin 执行，运行 `realpath`、目录读取和 Git 只读查询；不上传文件、不执行 prune/repair。`BatchMode=yes` 和严格主机密钥检查会让需要交互认证的连接明确失败。SSH 8 秒连接超时，整次 60 秒超时，输出上限 8 MiB。失败或部分错误保留上次缓存及其成功时间，成功扫描为空才清空发现快照；工作集与保留目录不受影响。

Remote SSH 扩展本身由 VS Code 提供，需另外安装。非 SSH 类型的远端 URI（Dev Container、WSL、Codespaces）首版只展示未映射会话，不自动推断身份。未配置的 SSH 别名也不会按目录名强行关联。

## 数据、备份与卸载

macOS 数据位于 `~/Library/Application Support/WorkScene/`；Linux 位于 `${XDG_CONFIG_HOME:-~/.config}/WorkScene/`。界面“运行诊断”显示实际路径。

| 文件                              | 用途                                           |
| --------------------------------- | ---------------------------------------------- |
| `organization.json`               | 带版本的环境、保留位置与工作集；原子替换写入   |
| `organization.before-import.json` | 最近一次导入前的组织数据备份                   |
| `discovery-cache.json`            | 环境的发现快照、状态和最后成功时间             |
| `connection.json`                 | 当前本机回环端口与随机接入令牌，0600；退出删除 |

组织数据使用 v2：工作集只保存位置身份，不保存过时的存在状态或 Git 分支。v1 文件首次加载前自动备份到 `organization.before-migration-v1.json`；也支持导入 v1 文件。没有发现事实的位置显示“存在状态待确认”。如需回退到 0.1.0，先退出应用，再从迁移前备份恢复 v1 文件；旧版不支持读取 v2 组织数据。

会话和操作只在内存存在，不导出、不作为永久窗口事实。导出保留环境和位置身份；导入替换组织数据并自动备份，不会自动连接远端。换机器后必须在界面检查根目录与 SSH 别名，导入不会推测两个设备其实是同一机器。不要公开含私有路径或 SSH 主机信息的导出文件。

卸载时删除 `WorkScene.app`，在 VS Code 卸载 **WorkScene Connector**。默认保留上述数据目录；若要彻底清除，退出 WorkScene，备份导出后再手动移除该目录。应用无法读取组织文件时停止启动并保留原文件，不会静默重置用户数据。

## 验证与文档

- [领域模型与模块](docs/architecture.md)
- [本机协议 v1、窗口语义及准确激活](docs/protocol-v1.md)
- [验证记录与复现步骤](docs/validation.md)
- [已知限制](docs/limitations.md)

核心测试：`npm test`。测试会实际创建 Git 仓库/worktree、启动本机 HTTP 服务，并校验故障语义。测试进程需要允许绑定 127.0.0.1。

真实 Linux 桌面端到端测试（需运行中的显示服务和窗口管理器）：

```sh
npm run package:extension
DISPLAY=:0 WORKSCENE_VSCODE=/path/to/VSCode-linux-x64/code node scripts/e2e.mjs
```

该脚本安装实际 VSIX 到独立测试 profile，启动真实 Electron 与 VS Code 多窗口。不会伪造扩展报告。测试配置、Git fixtures、截图和 JSON 证据位于 `work/e2e-<timestamp>/`。源码级端到端脚本当前以 Linux 隔离 profile 为基准；macOS 手工验证流程见验证文档。
