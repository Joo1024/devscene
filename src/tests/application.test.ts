import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Application } from "../core/application";
import { Store } from "../core/persistence";
import { Environment, location, SessionReport } from "../core/domain";

function setup(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workscene-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const store = new Store(dir);
  const app = new Application(store, () => clock);
  return {
    app,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
    local: store.data.environments[0],
  };
}
function report(
  id = "session-111",
  uris = ["file:///code/repo"],
): SessionReport {
  return {
    protocol: 1,
    tool: "vscode-stable",
    toolVersion: "1.110",
    instanceId: id,
    workspaceName: "Repo",
    folders: uris.map((uri) => ({ uri })),
    focused: false,
    capabilities: ["activateSession"],
  };
}
test("no extension means unknown; multi-root and multiple windows count unique instances", (t) => {
  const { app, local } = setup(t);
  const l = location(local, "/code/repo", "scan");
  l.checkout = {
    repositoryId: "r",
    commonDir: "/code/repo/.git",
    root: l.path,
    kind: "main",
    branch: "main",
    head: "abc",
  };
  app.store.cache[local.id] = { locations: [l], status: "online", errors: [] };
  assert.equal(app.snapshot().sessions.length, 0);
  app.report(
    report("session-111", ["file:///code/repo/a", "file:///code/repo/b"]),
  );
  assert.equal(app.activeSessions().length, 1);
  assert.equal(
    app.activeSessions()[0].locationIds.filter((id) => id === l.id).length,
    1,
  );
  app.report(report("session-222"));
  assert.equal(
    app.activeSessions().filter((s) => s.locationIds.includes(l.id)).length,
    2,
  );
  app.report({ ...report("session-empty", []), workspaceName: "Empty" });
  assert.equal(app.activeSessions().length, 3);
  assert.deepEqual(app.sessions.get("session-empty")!.locationIds, []);
  app.report({
    ...report("session-111"),
    workspaceName: "Changed title",
    activeFile: "file:///code/repo/new.ts",
  });
  assert.equal(app.activeSessions().length, 3);
});
test("SSH requires explicit namespace alias and never matches local path by name", (t) => {
  const { app, local } = setup(t);
  const remote: Environment = {
    ...local,
    id: "remote",
    name: "Build",
    kind: "ssh",
    target: "dev@host",
    aliases: ["build"],
    roots: [],
  };
  app.saveEnvironment(remote);
  app.report(report("session-local"));
  app.report(
    report("session-remote", ["vscode-remote://ssh-remote+build/code/repo"]),
  );
  assert.notEqual(
    app.sessions.get("session-local")!.locationIds[0],
    app.sessions.get("session-remote")!.locationIds[0],
  );
  app.report(
    report("session-unmapped", ["vscode-remote://ssh-remote+other/code/repo"]),
  );
  assert.equal(app.sessions.get("session-unmapped")!.unresolved.length, 1);
  assert.equal(app.sessions.get("session-unmapped")!.locationIds.length, 0);
});
test("expiry, explicit close and reload converge without deleting worksets", (t) => {
  const { app, advance } = setup(t);
  app.report(report());
  const id = app.activeSessions()[0].locationIds[0];
  app.saveWorkset("Release", [id]);
  advance(20000);
  app.report(report("session-reload"));
  advance(16000);
  app.sweep();
  assert.deepEqual(
    app.activeSessions().map((s) => s.instanceId),
    ["session-reload"],
  );
  assert.equal(app.store.data.worksets[0].locationIds[0], id);
  app.exit("session-reload");
  assert.equal(app.activeSessions().length, 0);
  assert.equal(app.store.data.worksets.length, 1);
});
test("operation targets, changed folders, duplicates, acknowledgement and timeout are explicit", (t) => {
  const { app, advance } = setup(t);
  app.report(report());
  const lid = app.activeSessions()[0].locationIds[0];
  const op = app.requestActivation("session-111", lid);
  assert.equal(op.state, "pending");
  assert.equal(app.requestActivation("session-111", lid, op.id), op);
  assert.throws(() => app.requestActivation("session-111", "wrong", op.id));
  assert.equal(app.poll(report()).length, 1);
  assert.equal(op.state, "accepted");
  assert.equal(app.poll(report()).length, 0);
  assert.throws(() =>
    app.result("session-other", op.id, "activated", "wrong target"),
  );
  app.result("session-111", op.id, "executed", "command ran, focus unknown");
  assert.equal(op.state, "executed");
  app.result("session-111", op.id, "activated", "duplicate result");
  assert.equal(op.state, "executed");
  const stale = app.requestActivation("session-111", lid);
  app.poll(report("session-111", ["file:///different"]));
  assert.equal(stale.state, "failed");
  const timed = app.requestActivation("session-111");
  advance(13000);
  app.sweep();
  assert.equal(timed.state, "timeout");
  const vanished = app.requestActivation("session-111");
  app.exit("session-111");
  assert.equal(vanished.state, "failed");
});
test("unsupported capability and malformed protocol fail closed", (t) => {
  const { app } = setup(t);
  app.report({ ...report(), capabilities: [] });
  assert.equal(app.requestActivation("session-111").state, "unsupported");
  assert.throws(() =>
    app.report({ ...report(), protocol: 2 } as unknown as SessionReport),
  );
  assert.throws(() =>
    app.report({
      ...report(),
      tool: "vscode-insiders",
    } as unknown as SessionReport),
  );
});
test("activation success needs the target latest focus evidence", (t) => {
  const { app } = setup(t);
  app.report(report());
  const op = app.requestActivation("session-111");
  app.poll(report());
  app.result("session-111", op.id, "activated", "unsubstantiated");
  assert.equal(op.state, "executed");
  const next = app.requestActivation("session-111");
  app.poll({ ...report(), focused: true });
  app.result("session-111", next.id, "activated", "focused");
  assert.equal(next.state, "activated");
});
test("openLocation has explicit results, expiry and idempotency without claiming activation", async (t) => {
  const { app, local, advance } = setup(t);
  const target = location(local, "/code/new", "manual");
  app.addLocation(target);
  let launches = 0;
  const op = await app.openLocation(target.id, async () => {
    launches++;
  });
  assert.equal(op.kind, "openLocation");
  assert.equal(op.state, "executed");
  assert.equal(app.activeSessions().length, 0);
  await app.openLocation(
    target.id,
    async () => {
      launches++;
    },
    op.id,
  );
  assert.equal(launches, 1);
  const failed = await app.openLocation(target.id, async () => {
    throw new Error("code unavailable");
  });
  assert.equal(failed.state, "failed");
  const expired = await app.openLocation(target.id, async () => {
    advance(16000);
  });
  assert.equal(expired.state, "timeout");
});
test("SSH failure and partial scan preserve snapshot; successful empty scan clears cache", async (t) => {
  const { app, local, advance } = setup(t);
  const remote: Environment = {
    ...local,
    id: "ssh",
    kind: "ssh",
    target: "build",
    aliases: ["build"],
  };
  app.saveEnvironment(remote);
  const l = location(remote, "/srv/repo", "scan");
  await app.scan("ssh", async () => ({ locations: [l], errors: [] }));
  const success = app.store.cache.ssh.lastSuccess;
  advance(1000);
  await app.scan("ssh", async () => {
    throw new Error("offline");
  });
  assert.equal(app.store.cache.ssh.status, "offline");
  assert.equal(app.store.cache.ssh.locations[0].id, l.id);
  assert.equal(app.store.cache.ssh.lastSuccess, success);
  await app.scan("ssh", async () => ({
    locations: [],
    errors: ["root unreadable"],
  }));
  assert.equal(app.store.cache.ssh.locations.length, 1);
  await app.scan("ssh", async () => ({ locations: [], errors: [] }));
  assert.equal(app.store.cache.ssh.status, "online");
  assert.equal(app.store.cache.ssh.locations.length, 0);
});
test("workset persists session-discovered locations through expiry and export/import", (t) => {
  const { app, advance, store } = setup(t);
  app.report(report());
  const l = app.activeSessions()[0].locationIds[0];
  app.saveWorkset("Task", [l]);
  advance(40000);
  app.sweep();
  assert.ok(app.locations().some((x) => x.id === l));
  const data = store.export();
  store.import(data);
  assert.equal(store.data.worksets[0].locationIds[0], l);
  assert.equal(store.data.manualLocations[0].id, l);
});
