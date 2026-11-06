import * as vscode from "vscode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Operation, SessionReport } from "../core/domain";

const exec = promisify(execFile);
async function localCheckoutRoot(
  directory: string,
): Promise<string | undefined> {
  try {
    // Git's UI API can omit repositories above the workspace or undiscovered nested repos.
    // Query the actual directory rather than treating an API-known ancestor as proof.
    const { stdout } = await exec(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      {
        timeout: 2000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return await fs.realpath(stdout.replace(/\r?\n$/, ""));
  } catch {
    return undefined;
  }
}

type Connection = {
  protocol: 1;
  port: number;
  token: string;
  brokerId?: string;
};
class ResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
let stop: (() => Promise<void>) | undefined;
export async function activate(context: vscode.ExtensionContext) {
  if (
    vscode.env.uriScheme !== "vscode" ||
    vscode.env.uiKind !== vscode.UIKind.Desktop
  )
    return;
  const instanceId = randomUUID();
  const dataDir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "WorkScene")
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "WorkScene",
        );
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  );
  status.command = "workscene.status";
  status.text = "$(plug) WorkScene";
  status.show();
  let message = "等待 WorkScene 应用";
  let busy = false;
  let stopped = false;
  const supported = (await vscode.commands.getCommands(true)).includes(
    "workbench.action.focusWindow",
  );
  const completed = new Map<string, { state: string; message: string }>();
  const pendingResults = new Map<
    string,
    { state: string; message: string; expiresAt: number }
  >();
  let connectedBroker: string | undefined;
  async function connection(): Promise<Connection> {
    const config = JSON.parse(
      await fs.readFile(path.join(dataDir, "connection.json"), "utf8"),
    );
    if (
      config.protocol !== 1 ||
      !Number.isInteger(config.port) ||
      config.port < 1 ||
      config.port > 65535 ||
      typeof config.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(config.token) ||
      (config.brokerId !== undefined && typeof config.brokerId !== "string")
    )
      throw new Error("本机接入配置无效");
    return config;
  }
  async function send(
    config: Connection,
    route: string,
    body: unknown,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: config.port,
          path: `/v1/${route}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          timeout: 3000,
        },
        (res) => {
          let data = "";
          res.on("error", reject);
          res.on("aborted", () => reject(new Error("本机响应在完成前中断")));
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const result = JSON.parse(data);
              res.statusCode === 200
                ? resolve(result)
                : reject(
                    new ResponseError(
                      res.statusCode ?? 500,
                      result.error || "连接失败",
                    ),
                  );
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("本机连接超时")));
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  async function report(): Promise<SessionReport> {
    // Git's API may be unavailable in a local UI extension host for SSH windows.
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    const api = gitExtension?.isActive
      ? gitExtension.exports?.getAPI?.(1)
      : undefined;
    const folders = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map(async (f) => {
        const canonicalPath =
          f.uri.scheme === "file"
            ? await fs.realpath(f.uri.fsPath).catch(() => f.uri.fsPath)
            : undefined;
        const repo = api?.repositories
          ?.filter(
            (r: any) =>
              r.rootUri.scheme === f.uri.scheme &&
              r.rootUri.authority === f.uri.authority &&
              (f.uri.path === r.rootUri.path ||
                (f.uri.scheme === "file" &&
                  f.uri.path.startsWith(r.rootUri.path + "/"))),
          )
          .sort(
            (a: any, b: any) => b.rootUri.path.length - a.rootUri.path.length,
          )[0];
        const checkoutRoot = canonicalPath
          ? await localCheckoutRoot(canonicalPath)
          : undefined;
        return {
          uri: f.uri.toString(),
          canonicalPath,
          checkoutRoot,
          git:
            repo &&
            (f.uri.scheme !== "file" || repo.rootUri.fsPath === checkoutRoot)
              ? {
                  rootUri: repo.rootUri.toString(),
                  branch: repo.state?.HEAD?.name,
                  head: repo.state?.HEAD?.commit,
                }
              : undefined,
        };
      }),
    );
    return {
      protocol: 1,
      tool: "vscode-stable",
      toolVersion: vscode.version,
      instanceId,
      workspaceName: vscode.workspace.name || "空窗口",
      folders,
      focused: vscode.window.state.focused,
      activeFile: vscode.window.activeTextEditor?.document.uri.toString(),
      capabilities: supported ? ["activateSession"] : [],
    };
  }
  async function perform(
    op: Operation,
  ): Promise<{ state: string; message: string }> {
    if (completed.has(op.id)) return completed.get(op.id)!;
    const current = await report();
    if (
      op.protocol !== 1 ||
      op.targetId !== instanceId ||
      op.kind !== "activateSession" ||
      Date.now() >= op.expiresAt
    )
      return { state: "failed", message: "目标身份或请求有效期不匹配" };
    if (
      JSON.stringify(current.folders.map((f) => f.uri).sort()) !==
      JSON.stringify(op.expectedUris)
    )
      return { state: "failed", message: "执行前工作区目录已变化" };
    if (!supported)
      return { state: "unsupported", message: "VS Code 未提供窗口聚焦命令" };
    try {
      await vscode.commands.executeCommand("workbench.action.focusWindow");
      if (!vscode.window.state.focused)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            listener.dispose();
            resolve();
          }, 1800);
          const listener = vscode.window.onDidChangeWindowState((s) => {
            if (s.focused) {
              clearTimeout(timer);
              listener.dispose();
              resolve();
            }
          });
        });
      return vscode.window.state.focused
        ? { state: "activated", message: "目标扩展确认该窗口已获得焦点" }
        : {
            state: "executed",
            message: "聚焦命令已执行，但尚未观察到焦点；未确认激活",
          };
    } catch (err) {
      return { state: "failed", message: String(err) };
    }
  }
  async function flushResults(config: Connection): Promise<string | undefined> {
    let warning: string | undefined;
    for (const [id, result] of pendingResults) {
      if (Date.now() >= result.expiresAt) {
        pendingResults.delete(id);
        continue;
      }
      try {
        await send(config, "result", {
          id,
          state: result.state,
          message: result.message,
          report: await report(),
        });
        pendingResults.delete(id);
      } catch (err) {
        // Invalid/gone operations are terminal. Transport/server failures retry within the operation lifetime.
        if (
          err instanceof ResponseError &&
          [400, 404, 410, 422].includes(err.status)
        )
          pendingResults.delete(id);
        else warning = String(err);
      }
    }
    return warning;
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      // Snapshot the descriptor per tick: never deliver an old command's result to a new broker.
      const config = await connection();
      const broker = `${config.brokerId ?? "legacy"}:${config.token}`;
      if (connectedBroker !== broker) {
        pendingResults.clear();
        completed.clear();
        connectedBroker = broker;
      }
      // Heartbeats/new requests always get a chance, regardless of a previous result's retry status.
      const response = await send(config, "poll", await report());
      for (const op of response.requests as Operation[]) {
        const result = await perform(op);
        completed.set(op.id, result);
        pendingResults.set(op.id, { ...result, expiresAt: op.expiresAt });
      }
      const retryWarning = await flushResults(config);
      while (completed.size > 500)
        completed.delete(completed.keys().next().value!);
      message = retryWarning
        ? "已连接 WorkScene · 有操作回执等待重试（未确认完成）"
        : supported
          ? "已连接本机 WorkScene · 支持准确激活"
          : "已连接 · 当前 VS Code 不支持准确激活，请升级";
      status.text = "$(plug) WorkScene";
    } catch (err) {
      message = `尚未连接 WorkScene：${String(err)}`;
      status.text = "$(debug-disconnect) WorkScene";
    } finally {
      busy = false;
      status.tooltip = message;
    }
  }
  const timer = setInterval(() => void tick(), 2000);
  stop = async () => {
    stopped = true;
    clearInterval(timer);
    try {
      await send(await connection(), "exit", { instanceId });
    } catch {}
  };
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("workscene.status", () =>
      vscode.window.showInformationMessage(message),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void tick()),
    vscode.window.onDidChangeWindowState(() => void tick()),
    vscode.window.onDidChangeActiveTextEditor(() => void tick()),
    {
      dispose: () => {
        void stop?.();
      },
    },
  );
  void tick();
}
export async function deactivate() {
  await stop?.();
}
