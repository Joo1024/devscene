import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Application } from "../core/application";
import { Store, atomicWrite } from "../core/persistence";
import { startBridge } from "../integrations/bridge";

// Runs the actual compiled connector with a small VS Code API mock and real loopback servers.
// Only its interval/clock are controlled: no mock of the retry logic or application protocol.
function folder(directory: string) {
  return {
    uri: {
      scheme: "file",
      authority: "",
      path: directory,
      fsPath: directory,
      toString: () => pathToFileURL(directory).href,
    },
  };
}
async function harness(
  t: { after(fn: () => Promise<void>): void },
  folders: ReturnType<typeof folder>[] = [],
  staleGitRoot?: string | ReturnType<typeof folder>["uri"],
) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "workscene-connector-test-"),
  );
  const directory = path.join(base, "WorkScene");
  let clock = Date.now();
  const store = new Store(directory);
  let app = new Application(store, () => clock);
  let bridge = await startBridge(app);
  const failedResults = new Set<string>();
  const droppedResults = new Set<string>();
  const attempts = new Map<string, number>();
  let polls = 0,
    commands = 0,
    cycles = 0,
    tooltip = "";
  let pulse: () => void = () => {};
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const data = JSON.parse(body.toString());
    if (req.url === "/v1/poll") polls++;
    if (req.url === "/v1/result") {
      attempts.set(data.id, (attempts.get(data.id) ?? 0) + 1);
      if (droppedResults.has(data.id)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
        setImmediate(() => res.destroy());
        return;
      }
      if (failedResults.has(data.id)) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "injected result delivery failure" }));
        return;
      }
    }
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: bridge.port,
        path: req.url,
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 500, {
          "Content-Type": "application/json",
        });
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(503);
      res.end("{}");
    });
    upstream.end(body);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const descriptor = () =>
    atomicWrite(path.join(directory, "connection.json"), {
      protocol: 1,
      brokerId: bridge.brokerId,
      port: (proxy.address() as { port: number }).port,
      token: bridge.token,
    });
  descriptor();
  const disposable = () => ({ dispose() {} });
  const status = {
    text: "",
    show() {},
    dispose() {},
    set tooltip(value: string) {
      tooltip = value;
      cycles++;
    },
  };
  const vscode = {
    env: { uriScheme: "vscode", uiKind: 1 },
    UIKind: { Desktop: 1 },
    StatusBarAlignment: { Left: 1 },
    version: "1.145.2",
    extensions: {
      getExtension: () =>
        staleGitRoot
          ? {
              isActive: true,
              exports: {
                getAPI: () => ({
                  repositories: [
                    {
                      rootUri:
                        typeof staleGitRoot === "string"
                          ? folder(staleGitRoot).uri
                          : staleGitRoot,
                      state: { HEAD: { name: "stale", commit: "abc" } },
                    },
                  ],
                }),
              },
            }
          : undefined,
    },
    workspace: {
      workspaceFolders: folders,
      onDidChangeWorkspaceFolders: disposable,
    },
    window: {
      createStatusBarItem: () => status,
      state: { focused: true },
      onDidChangeWindowState: disposable,
      onDidChangeActiveTextEditor: disposable,
    },
    commands: {
      getCommands: async () => ["workbench.action.focusWindow"],
      executeCommand: async () => {
        commands++;
      },
      registerCommand: disposable,
    },
  };
  const module = {
    exports: {} as {
      activate(context: unknown): Promise<void>;
      deactivate(): Promise<void>;
    },
  };
  class Clock extends Date {
    static now() {
      return clock;
    }
  }
  const source = fs.readFileSync(
    path.resolve(__dirname, "../extension/extension.js"),
    "utf8",
  );
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      require: (name: string) => (name === "vscode" ? vscode : require(name)),
      process: {
        platform: "linux",
        env: { ...process.env, XDG_CONFIG_HOME: base },
      },
      Date: Clock,
      setTimeout,
      clearTimeout,
      setInterval: (fn: () => void) => {
        pulse = fn;
        return 1;
      },
      clearInterval: () => {},
    },
    { filename: "actual-connector.js" },
  );
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("connector tick timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  t.after(async () => {
    await module.exports.deactivate();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await bridge.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  await module.exports.activate({ subscriptions: [] });
  await wait(() => cycles > 0);
  return {
    get app() {
      return app;
    },
    get polls() {
      return polls;
    },
    get commands() {
      return commands;
    },
    get tooltip() {
      return tooltip;
    },
    failedResults,
    droppedResults,
    attempts,
    async tick() {
      const before = cycles;
      pulse();
      await wait(() => cycles > before);
    },
    advance(ms: number) {
      clock += ms;
    },
    async restart() {
      await bridge.close();
      app = new Application(store, () => clock);
      bridge = await startBridge(app);
      descriptor();
    },
  };
}

test("failed result retries do not starve heartbeats or new operations, and expire without re-execution", async (t) => {
  const h = await harness(t);
  const id = h.app.activeSessions()[0].instanceId;
  const first = h.app.requestActivation(id);
  h.failedResults.add(first.id);
  await h.tick();
  assert.equal(first.state, "accepted");
  assert.equal(h.commands, 1);
  assert.match(h.tooltip, /等待重试/);
  const second = h.app.requestActivation(id);
  const before = h.polls;
  await h.tick();
  assert.equal(h.polls, before + 1);
  assert.equal(second.state, "activated");
  assert.equal(h.commands, 2);
  const attempts = h.attempts.get(first.id);
  h.advance(13000);
  await h.tick();
  assert.equal(first.state, "timeout");
  assert.equal(h.attempts.get(first.id), attempts);
  assert.equal(h.commands, 2);
});

test("broker restart clears old result retries and reconnects the same extension instance", async (t) => {
  const h = await harness(t);
  const id = h.app.activeSessions()[0].instanceId;
  const old = h.app.requestActivation(id);
  h.failedResults.add(old.id);
  await h.tick();
  const attempts = h.attempts.get(old.id);
  await h.restart();
  await h.tick();
  assert.equal(h.app.activeSessions()[0].instanceId, id);
  const next = h.app.requestActivation(id);
  await h.tick();
  assert.equal(next.state, "activated");
  assert.equal(h.commands, 2);
  assert.equal(
    h.attempts.get(old.id),
    attempts,
    "old broker results must not be delivered to the new broker",
  );
});

test("gone operations stop retrying within the same broker while polling remains healthy", async (t) => {
  const h = await harness(t);
  const id = h.app.activeSessions()[0].instanceId;
  const old = h.app.requestActivation(id);
  h.failedResults.add(old.id);
  await h.tick();
  h.app.operations.delete(old.id);
  h.failedResults.clear();
  await h.tick();
  const attempts = h.attempts.get(old.id);
  const next = h.app.requestActivation(id);
  await h.tick();
  assert.equal(h.attempts.get(old.id), attempts);
  assert.equal(next.state, "activated");
  assert.equal(h.app.activeSessions().length, 1);
});

test("a response cut mid-body does not leave the connector busy forever", async (t) => {
  const h = await harness(t);
  const id = h.app.activeSessions()[0].instanceId;
  const first = h.app.requestActivation(id);
  h.droppedResults.add(first.id);
  await h.tick();
  assert.equal(h.commands, 1);
  h.droppedResults.clear();
  const next = h.app.requestActivation(id);
  await h.tick();
  assert.equal(first.state, "activated");
  assert.equal(next.state, "activated");
  assert.equal(h.commands, 2);
});

test("local checkout reporting uses real Git when the Git API is absent or only knows a parent", async (t) => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "workscene-checkout-report-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outer = path.join(base, "outer"),
    nested = path.join(outer, "nested"),
    source = path.join(nested, "src");
  fs.mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "-q", outer]);
  execFileSync("git", ["init", "-q", nested]);
  for (const apiRoot of [undefined, outer]) {
    const h = await harness(t, [folder(source)], apiRoot);
    const reported = h.app.activeSessions()[0].folders[0];
    assert.equal(reported.checkoutRoot, nested);
    assert.equal(reported.git, undefined);
    assert.deepEqual(
      h.app
        .locations()
        .map((l) => l.path)
        .sort(),
      [nested, source].sort(),
    );
  }
});

test("remote subdirectories do not report a checkout root inferred from an API-known ancestor", async (t) => {
  const remote = (directory: string) => ({
    uri: {
      ...folder(directory).uri,
      scheme: "vscode-remote",
      authority: "ssh-remote+build",
      toString: () => `vscode-remote://ssh-remote+build${directory}`,
    },
  });
  const h = await harness(
    t,
    [remote("/outer/nested/src")],
    remote("/outer").uri,
  );
  const report = h.app.activeSessions()[0].folders[0];
  assert.equal(report.checkoutRoot, undefined);
  assert.equal(report.git, undefined);
});
