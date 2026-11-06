import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Application } from "../core/application";
import { Store } from "../core/persistence";
import { Environment, location } from "../core/domain";
import { startBridge } from "../integrations/bridge";
import { vscodeCLI, openLocationArguments } from "../integrations/vscode";

const exec = promisify(execFile);
app.setName("WorkScene");
// A fixed standard path allows the local UI extension host to discover the broker.
app.setPath("userData", path.join(app.getPath("appData"), "WorkScene"));
if (!app.requestSingleInstanceLock()) app.quit();
else
  void app
    .whenReady()
    .then(async () => {
      let store: Store;
      try {
        store = new Store(app.getPath("userData"));
      } catch (err) {
        dialog.showErrorBox(
          "WorkScene 配置无法读取",
          `原始文件已保留，请从备份恢复 organization.json。\n${String(err)}`,
        );
        app.quit();
        return;
      }
      const service = new Application(store);
      const bridge = await startBridge(service);
      let window: BrowserWindow;
      function createWindow() {
        window = new BrowserWindow({
          width: 1380,
          height: 900,
          minWidth: 1000,
          minHeight: 700,
          title: "WorkScene",
          backgroundColor: "#f7f8fa",
          webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        void window.loadFile(
          path.join(__dirname, "../presentation/index.html"),
        );
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "WorkScene",
            submenu: [{ role: "about" }, { role: "quit" }],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "视图",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
        ]),
      );
      const codePath = vscodeCLI(process.platform);
      const extensionPath = app.isPackaged
        ? path.join(process.resourcesPath, "workscene-connector.vsix")
        : path.join(__dirname, "../../release/workscene-connector.vsix");
      ipcMain.handle("workscene", async (event, action, payload) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("未知界面来源");
        switch (action) {
          case "snapshot":
            return service.snapshot();
          case "chooseDirectory": {
            const result = await dialog.showOpenDialog(window, {
              properties: ["openDirectory"],
            });
            return result.filePaths[0];
          }
          case "saveEnvironment": {
            const e = payload as Environment;
            service.saveEnvironment({ ...e, id: e.id || randomUUID() });
            return true;
          }
          case "scan":
            await service.scan(String(payload));
            return service.snapshot();
          case "addLocation": {
            const e = service
              .environments()
              .find((e) => e.id === payload.environmentId);
            if (!e) throw new Error("环境不存在");
            const p =
              e.kind === "local"
                ? await fs.realpath(payload.path)
                : payload.path;
            if (e.kind === "local" && !(await fs.stat(p)).isDirectory())
              throw new Error("请选择目录");
            service.addLocation(
              location(e, p, "manual", e.kind === "local" ? true : null),
            );
            return true;
          }
          case "saveWorkset":
            service.saveWorkset(payload.name, payload.locationIds, payload.id);
            return true;
          case "deleteWorkset":
            store.data.worksets = store.data.worksets.filter(
              (w) => w.id !== payload,
            );
            store.save();
            return true;
          case "activate":
            return service.requestActivation(
              payload.sessionId,
              payload.locationId,
              payload.requestId,
            );
          case "open":
            return service.openLocation(
              String(payload),
              async (target, environment) => {
                await exec(
                  codePath,
                  openLocationArguments(environment, target.path),
                  { timeout: 15000 },
                );
              },
            );
          case "installExtension":
            await exec(codePath, ["--install-extension", extensionPath], {
              timeout: 60000,
            });
            return {
              message:
                "扩展已安装。请在 VS Code 中重新加载已有窗口，并检查左下角 WorkScene 状态。",
            };
          case "showExtension":
            await fs.access(extensionPath);
            shell.showItemInFolder(extensionPath);
            return true;
          case "export": {
            const result = await dialog.showSaveDialog(window, {
              defaultPath: "workscene-organization.json",
              filters: [{ name: "WorkScene 配置", extensions: ["json"] }],
            });
            if (!result.canceled && result.filePath) {
              await fs.writeFile(
                result.filePath,
                JSON.stringify(store.export(), null, 2),
                { mode: 0o600 },
              );
              return result.filePath;
            }
            return null;
          }
          case "import": {
            const result = await dialog.showOpenDialog(window, {
              properties: ["openFile"],
              filters: [{ name: "WorkScene 配置", extensions: ["json"] }],
            });
            if (result.canceled) return false;
            const file = result.filePaths[0];
            if ((await fs.stat(file)).size > 10 * 1024 * 1024)
              throw new Error("配置文件超过 10 MB");
            const value = JSON.parse(await fs.readFile(file, "utf8"));
            const confirm = await dialog.showMessageBox(window, {
              type: "question",
              message: "用导入文件替换环境与工作集？",
              detail:
                "当前组织数据会自动备份。导入不会连接远端或扫描目录。跨机器导入后，请检查路径与 SSH 别名。",
              buttons: ["取消", "导入并备份"],
              defaultId: 0,
              cancelId: 0,
            });
            if (confirm.response !== 1) return false;
            store.import(value);
            service.sessions.clear();
            return true;
          }
          case "diagnostics": {
            const probe = async (command: string, args: string[]) => {
              try {
                return (
                  (
                    await exec(command, args, { timeout: 5000 })
                  ).stdout.trim() || "可用"
                );
              } catch (err) {
                return String(err);
              }
            };
            return {
              version: app.getVersion(),
              platform: process.platform,
              userData: store.directory,
              packaged: app.isPackaged,
              protocol: 1,
              bridge: "127.0.0.1（令牌已隐藏）",
              git: await probe("git", ["--version"]),
              ssh: await probe("ssh", ["-V"]),
              code: await probe(codePath, ["--version"]),
              extension: extensionPath,
              connectedWindows: service.activeSessions().length,
              warnings: store.warnings,
              environmentStatus: Object.fromEntries(
                Object.entries(store.cache).map(([id, c]) => [
                  id,
                  {
                    status: c.status,
                    lastSuccess: c.lastSuccess,
                    errors: c.errors,
                  },
                ]),
              ),
            };
          }
          default:
            throw new Error("未知操作");
        }
      });
      createWindow();
      app.on("second-instance", () => {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
      app.on("before-quit", () => {
        void bridge.close();
      });
    })
    .catch((err) => {
      dialog.showErrorBox("WorkScene 启动失败", String(err));
      app.quit();
    });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
