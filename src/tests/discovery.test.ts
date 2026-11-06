import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initialData } from "../core/domain";
import { scanLocal } from "../integrations/discovery";
const exec = promisify(execFile);
test("real Git: nested repos, same names, external detached worktree, missing registrations and bounded depth", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "workscene-git-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = path.join(base, "roots");
  const repo = path.join(roots, "a", "project");
  const twin = path.join(roots, "b", "project");
  const linked = path.join(base, "outside worktree");
  const missing = path.join(base, "missing");
  const git = (cwd: string, args: string[]) =>
    exec("git", ["-C", cwd, ...args]);
  for (const dir of [repo, twin]) {
    await fs.mkdir(dir, { recursive: true });
    await git(dir, ["init", "-b", "main"]);
    await fs.writeFile(path.join(dir, "a.txt"), "hello");
    await git(dir, ["add", "a.txt"]);
    await git(dir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
  }
  await git(repo, ["worktree", "add", "--detach", linked]);
  await git(repo, ["worktree", "add", "--detach", missing]);
  await fs.rm(missing, { recursive: true });
  const before = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  const e = { ...initialData().environments[0], roots: [roots], depth: 2 };
  const result = await scanLocal(e);
  assert.equal(result.locations.filter((l) => l.name === "project").length, 2);
  const main = result.locations.find((l) => l.path === repo)!;
  const worktree = result.locations.find((l) => l.path === linked)!;
  assert.equal(main.checkout?.kind, "main");
  assert.equal(worktree.checkout?.kind, "worktree");
  assert.equal(worktree.checkout?.branch, "(detached HEAD)");
  assert.equal(main.checkout?.repositoryId, worktree.checkout?.repositoryId);
  assert.equal(result.locations.find((l) => l.path === missing)?.exists, false);
  assert.ok(result.errors.length > 0);
  assert.equal(
    (await git(repo, ["worktree", "list", "--porcelain"])).stdout,
    before,
    "scanner must not prune registration",
  );
  assert.equal((await scanLocal({ ...e, depth: 0 })).locations.length, 0);
  const failure = await scanLocal({
    ...e,
    roots: [path.join(base, "not-there")],
  });
  assert.equal(failure.locations.length, 0);
  assert.ok(failure.errors.length);
});
test("bundled SSH scanner executes read-only against real git without SSH transport simulation claims", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "workscene-remote-script-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await exec("git", ["init", base]);
  const script = path.resolve(__dirname, "../integrations/remote_scan.py");
  const config = Buffer.from(
    JSON.stringify({ roots: [base], depth: 0 }),
  ).toString("base64");
  const result = JSON.parse((await exec("python3", [script, config])).stdout);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0].checkout.kind, "main");
  assert.equal(result.locations[0].checkout.head, "(unborn)");
});
