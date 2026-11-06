import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialData, identity, location, validateData } from "../core/domain";
import { Store } from "../core/persistence";

test("full path, namespace and explicit case rules define identity", () => {
  const e = initialData().environments[0];
  assert.notEqual(identity(e, "/a/repo"), identity(e, "/b/repo"));
  assert.notEqual(
    identity(e, "/a/repo"),
    identity({ ...e, id: "remote" }, "/a/repo"),
  );
  assert.notEqual(identity(e, "/a/Repo"), identity(e, "/a/repo"));
  assert.equal(
    identity({ ...e, caseSensitive: false }, "/a/Repo"),
    identity({ ...e, caseSensitive: false }, "/a/repo"),
  );
  assert.equal(identity(e, "/a/../b/repo/"), identity(e, "/b/repo"));
});
test("atomic store export/import preserves workset and environment identity", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workscene-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const l = location(store.data.environments[0], "/a/repo", "manual");
  store.data.manualLocations.push(l);
  store.data.worksets.push({ id: "w", name: "Ship", locationIds: [l.id] });
  store.save();
  assert.deepEqual(new Store(dir).data, store.data);
  const exported = store.export();
  store.import(exported);
  assert.deepEqual(store.data, exported);
  assert.ok(fs.existsSync(path.join(dir, "organization.before-import.json")));
  assert.throws(() => store.import({ ...exported, version: 99 }));
  assert.deepEqual(store.data, exported);
  assert.equal(
    fs.statSync(path.join(dir, "organization.json")).mode & 0o777,
    0o600,
  );
  store.cache[store.data.environments[0].id] = {
    locations: [l],
    status: "online",
    errors: [],
  };
  store.import(exported);
  assert.deepEqual(store.cache, {});
  assert.deepEqual(new Store(dir).cache, {});
});
test("invalid and cross-environment alias references are rejected", () => {
  const data = initialData();
  data.worksets.push({ id: "x", name: "Invalid", locationIds: ["missing"] });
  assert.throws(() => validateData(data));
  const invalid = initialData();
  invalid.environments[0].id = "__proto__";
  assert.throws(() => validateData(invalid));
});

test("v1 organization migration keeps identity and worksets, backs up the original, and drops stale facts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workscene-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = initialData(),
    e = data.environments[0],
    l = location(e, "/repo", "manual");
  l.checkout = {
    repositoryId: identity(e, "/repo/.git"),
    commonDir: "/repo/.git",
    root: "/repo",
    kind: "main",
    branch: "old",
    head: "abc",
  };
  const legacy = {
    ...data,
    version: 1,
    manualLocations: [l],
    worksets: [{ id: "w", name: "Task", locationIds: [l.id] }],
  };
  fs.writeFileSync(path.join(dir, "organization.json"), JSON.stringify(legacy));
  const store = new Store(dir);
  assert.equal(store.data.version, 2);
  assert.equal(store.data.manualLocations[0].id, l.id);
  assert.equal("checkout" in store.data.manualLocations[0], false);
  assert.equal("exists" in store.data.manualLocations[0], false);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, "organization.before-migration-v1.json"),
        "utf8",
      ),
    ),
    legacy,
  );
  assert.deepEqual(store.data.worksets, legacy.worksets);
  store.import(legacy);
  assert.equal(store.data.version, 2);
});
