// Real Electron + official VS Code Stable. No simulated extension reports.
// DISPLAY must point at a desktop with a window manager (or run on macOS).
import { _electron as electron } from "@playwright/test";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const work = path.join(root, "work", `e2e-${Date.now()}`);
await mkdir(work, { recursive: true });
const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, "config") };
const repo = path.join(work, "projects", "api");
const linked = path.join(work, "external-worktree");
await mkdir(path.join(repo, "server"), { recursive: true });
await mkdir(path.join(repo, "client"), { recursive: true });
execFileSync("git", ["init", "-b", "main", repo]);
await writeFile(
  path.join(repo, "README.md"),
  "WorkScene real window fixture\n",
);
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=WorkScene Test",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "-m",
  "fixture",
]);
execFileSync("git", ["-C", repo, "worktree", "add", "--detach", linked]);
const workspace = path.join(work, "API.code-workspace");
await writeFile(
  workspace,
  JSON.stringify({
    folders: [
      { path: path.join(repo, "server") },
      { path: path.join(repo, "client") },
    ],
  }),
);
const user = path.join(work, "vscode-user");
await mkdir(path.join(user, "User"), { recursive: true });
await writeFile(
  path.join(user, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
  }),
);
const vscode = process.env.WORKSCENE_VSCODE;
if (!vscode)
  throw new Error(
    "Set WORKSCENE_VSCODE to the official VS Code Stable executable",
  );
const cli =
  process.env.WORKSCENE_CODE_CLI ||
  path.join(path.dirname(vscode), "bin", "code");
execFileSync(
  cli,
  [
    "--user-data-dir",
    user,
    "--extensions-dir",
    path.join(work, "extensions"),
    "--install-extension",
    path.join(root, "release/workscene-connector.vsix"),
  ],
  { env },
);
const bin = path.join(work, "bin");
await mkdir(bin);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(
  path.join(bin, "code"),
  `#!/bin/sh\nexec ${quote(cli)} --user-data-dir ${quote(user)} --extensions-dir ${quote(path.join(work, "extensions"))} \"$@\"\n`,
);
await chmod(path.join(bin, "code"), 0o700);
env.PATH = `${bin}:${process.env.PATH}`;
const processes = [];
const evidence = {
  started: new Date().toISOString(),
  platform: process.platform,
  work,
  checks: [],
};
const mark = (name, details = {}) => {
  evidence.checks.push({ name, ...details });
  console.log("PASS", name);
};
const wait = async (fn, label, timeout = 60000) => {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const codeArgs = [
  "--no-sandbox",
  "--disable-gpu",
  "--user-data-dir",
  user,
  "--extensions-dir",
  path.join(work, "extensions"),
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--new-window",
];
function launchCode(target) {
  const log = createWriteStream(
    path.join(work, `vscode-${processes.length}.log`),
  );
  const child = spawn(vscode, [...codeArgs, ...(target ? [target] : [])], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  processes.push(child);
}
let desktop;
try {
  desktop = await electron.launch({
    args: ["--no-sandbox", root],
    env,
    timeout: 30000,
  });
  let page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.waitForSelector("#location-count");
  const api = (action, payload) =>
    page.evaluate(
      ({ action, payload }) => window.workscene.call(action, payload),
      { action, payload },
    );
  const snapshot = () => api("snapshot");
  assert.equal((await snapshot()).sessions.length, 0);
  mark("No extension starts with unknown session state");
  await page.screenshot({ path: path.join(work, "first-run.png") });
  await page
    .getByRole("button", { name: "＋ 添加目录", exact: true })
    .first()
    .click();
  await page.locator("#loc-path").fill(repo);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await wait(
    async () => !(await page.locator("#editor").evaluate((el) => el.open)),
    "add location dialog closes",
  );
  await wait(
    async () => (await snapshot()).locations.length === 1,
    "manual directory saved",
  );
  mark("Real desktop form adds a directory");
  const local = (await snapshot()).environments[0];
  await api("saveEnvironment", {
    ...local,
    roots: [path.dirname(repo)],
    depth: 2,
  });
  await api("scan", local.id);
  assert.equal(
    (await snapshot()).locations.filter((l) => l.checkout).length,
    2,
  );
  mark("Desktop discovers main checkout and external worktree");
  await page.locator("#new-workset").click();
  await page.locator("#ws-name").fill("API 发布");
  await page.locator('input[name="ws-location"]').first().check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await wait(
    async () => (await snapshot()).worksets.length === 1,
    "workset saved",
  );
  mark("Real desktop form creates workset");
  const checkout = (await snapshot()).locations.find((l) => l.path === repo);
  launchCode(workspace);
  const first = await wait(
    async () => {
      const s = (await snapshot()).sessions;
      return s.find(
        (x) => x.folders.length === 2 && x.locationIds.includes(checkout.id),
      );
    },
    "first real multi-root VS Code report",
    90000,
  );
  assert.equal(first.locationIds.filter((id) => id === checkout.id).length, 1);
  assert.equal((await snapshot()).sessions.length, 1);
  mark("Real multi-root VS Code window counts once for checkout", {
    instance: first.instanceId,
    version: first.toolVersion,
    capabilities: first.capabilities,
  });
  launchCode(repo);
  await wait(
    async () =>
      (await snapshot()).sessions.filter((s) =>
        s.locationIds.includes(checkout.id),
      ).length === 2,
    "second VS Code window",
    90000,
  );
  mark("Two real windows for same checkout count separately");
  await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
  await wait(
    async () => (await snapshot()).sessions.every((s) => !s.focused),
    "desktop takes focus",
  );
  const op = await api("activate", {
    sessionId: first.instanceId,
    locationId: checkout.id,
  });
  const done = await wait(
    async () => {
      const o = (await snapshot()).operations.find((o) => o.id === op.id);
      return !["pending", "accepted"].includes(o.state) && o;
    },
    "real activation result",
    20000,
  );
  assert.equal(done.state, "activated", done.message);
  mark("Targeted real VS Code instance confirms focus", { result: done.state });
  launchCode();
  await wait(
    async () => (await snapshot()).sessions.some((s) => s.folders.length === 0),
    "real empty window",
    90000,
  );
  mark("Real empty window reports without fabricated folders");
  const external = (await snapshot()).locations.find((l) => l.path === linked);
  const opened = await api("open", external.id);
  assert.match(opened.message, /等待扩展/);
  await wait(
    async () =>
      (await snapshot()).sessions.some((s) =>
        s.locationIds.includes(external.id),
      ),
    "openLocation produces actual new VS Code window",
    90000,
  );
  mark("Open-in-new-window launches VS Code and waits for actual report");
  const nested = path.join(repo, "nested");
  const nestedSource = path.join(nested, "src");
  await mkdir(nestedSource, { recursive: true });
  execFileSync("git", ["init", "-q", nested]);
  launchCode(nestedSource);
  const nestedSession = await wait(
    async () => {
      const state = await snapshot();
      return state.sessions.find((s) =>
        s.folders.some(
          (f) => f.canonicalPath === nestedSource && f.checkoutRoot === nested,
        ),
      );
    },
    "real nested repository checkout metadata",
    90000,
  );
  assert.ok(!nestedSession.locationIds.includes(checkout.id));
  const nestedLocation = (await snapshot()).locations.find(
    (l) => l.path === nested,
  );
  assert.ok(nestedSession.locationIds.includes(nestedLocation.id));
  mark(
    "Nested repository discovered by extension never counts as its scanned parent",
  );
  const beforeRestart = (await snapshot()).sessions
    .map((s) => s.instanceId)
    .sort();
  await desktop.close();
  desktop = await electron.launch({
    args: ["--no-sandbox", root],
    env,
    timeout: 30000,
  });
  page = await desktop.firstWindow();
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.waitForSelector("#location-count");
  await wait(
    async () => (await snapshot()).sessions.length === 5,
    "real windows reconnect after desktop restart",
    30000,
  );
  assert.deepEqual(
    (await snapshot()).sessions.map((s) => s.instanceId).sort(),
    beforeRestart,
  );
  await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
  await wait(
    async () => (await snapshot()).sessions.every((s) => !s.focused),
    "desktop takes focus after restart",
  );
  const retry = await api("activate", {
    sessionId: first.instanceId,
    locationId: checkout.id,
  });
  const result = await wait(
    async () => {
      const op = (await snapshot()).operations.find((o) => o.id === retry.id);
      return !["pending", "accepted"].includes(op.state) && op;
    },
    "activation after real desktop restart",
    20000,
  );
  assert.equal(result.state, "activated", result.message);
  mark(
    "Existing real VS Code windows reconnect and activate after WorkScene restarts",
  );
  const final = await snapshot();
  assert.equal(final.sessions.length, 5);
  assert.equal(final.worksets.length, 1);
  await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
  await wait(
    async () => (await page.locator("#window-count").textContent()) === "5",
    "UI reflects all windows",
  );
  await page.locator("#search").fill("api");
  await page.screenshot({ path: path.join(work, "connected.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  mark("Renderer runs without JavaScript errors");
  evidence.final = {
    connectedWindows: final.sessions.length,
    locations: final.locations.length,
    worksets: final.worksets.length,
  };
  // Termination of VS Code exercises heartbeat convergence even if exit delivery is interrupted.
  for (const child of processes) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await wait(
    async () => (await snapshot()).sessions.length === 0,
    "closed windows expire",
    45000,
  );
  assert.equal((await snapshot()).worksets.length, 1);
  mark("Closing real VS Code processes converges without losing worksets");
} catch (err) {
  evidence.failure = String(err);
  throw err;
} finally {
  evidence.finished = new Date().toISOString();
  await writeFile(
    path.join(work, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("Evidence:", path.join(work, "evidence.json"));
  for (const child of processes) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await desktop?.close();
}
