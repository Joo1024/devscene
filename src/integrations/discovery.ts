import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Environment, identity, Location, location } from "../core/domain";

const exec = promisify(execFile);
const ignored = new Set([
  ".git",
  "node_modules",
  ".venv",
  "vendor",
  "Library",
  ".Trash",
]);
export type Discovery = { locations: Location[]; errors: string[] };
export async function git(directory: string, args: string[]): Promise<string> {
  return (
    await exec("git", ["-C", directory, ...args], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout.trimEnd();
}
export async function scanLocal(environment: Environment): Promise<Discovery> {
  const found = new Map<string, Location>();
  const errors: string[] = [];
  const visited = new Map<string, number>();
  let budget = 15000;
  async function checkout(directory: string): Promise<void> {
    const canonical = await fs.realpath(directory).catch(() => directory);
    const l = location(environment, canonical, "scan");
    if (found.has(l.id)) return;
    found.set(l.id, l);
    try {
      const common = await fs.realpath(
        path.resolve(
          canonical,
          await git(canonical, ["rev-parse", "--git-common-dir"]),
        ),
      );
      const own = await fs.realpath(
        path.resolve(
          canonical,
          await git(canonical, ["rev-parse", "--git-dir"]),
        ),
      );
      l.checkout = {
        repositoryId: identity(environment, common),
        commonDir: common,
        root: canonical,
        kind: common === own ? "main" : "worktree",
        branch: await git(canonical, [
          "symbolic-ref",
          "--short",
          "-q",
          "HEAD",
        ]).catch(() => "(detached HEAD)"),
        head: await git(canonical, ["rev-parse", "--verify", "HEAD"]).catch(
          () => "(unborn)",
        ),
        remote: await git(canonical, ["remote", "get-url", "origin"]).catch(
          () => undefined,
        ),
      };
      const entries = (
        await git(canonical, ["worktree", "list", "--porcelain", "-z"])
      ).split("\0");
      for (const entry of entries)
        if (entry.startsWith("worktree ")) {
          const target = entry.slice(9);
          try {
            await fs.access(target);
            await checkout(target);
          } catch {
            const missing = location(environment, target, "scan", false);
            found.set(missing.id, missing);
            errors.push(`Git 登记路径缺失：${target}`);
          }
        }
    } catch (err) {
      errors.push(`Git 信息不可读取 ${canonical}: ${String(err)}`);
    }
  }
  async function walk(directory: string, depth: number): Promise<void> {
    const canonical = await fs.realpath(directory);
    if ((visited.get(canonical) ?? -1) >= depth) return;
    if (--budget < 0) throw new Error("超过 15000 个目录扫描上限，请缩小范围");
    visited.set(canonical, depth);
    const children = await fs.readdir(canonical, { withFileTypes: true });
    if (children.some((c) => c.name === ".git")) await checkout(canonical);
    if (depth <= 0) return;
    for (const child of children)
      if (
        child.isDirectory() &&
        !ignored.has(child.name) &&
        !child.name.startsWith(".")
      ) {
        try {
          await walk(path.join(canonical, child.name), depth - 1);
        } catch (err) {
          errors.push(`${path.join(canonical, child.name)}: ${String(err)}`);
          if (budget < 0) return;
        }
      }
  }
  for (const root of environment.roots) {
    try {
      await walk(root, environment.depth);
    } catch (err) {
      errors.push(`${root}: ${String(err)}`);
    }
  }
  return { locations: [...found.values()], errors };
}
export async function scanSSH(environment: Environment): Promise<Discovery> {
  // The only remote command is a bundled read-only scanner, passed over stdin.
  const script = await fs.readFile(
    path.join(__dirname, "remote_scan.py"),
    "utf8",
  );
  const config = Buffer.from(
    JSON.stringify({ roots: environment.roots, depth: environment.depth }),
  ).toString("base64");
  const child = execFile(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      environment.target!,
      `python3 - ${config}`,
    ],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  const result = new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr || `SSH 退出 ${code}`)),
    );
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(script);
  const report = JSON.parse(await result) as {
    locations: {
      path: string;
      exists: boolean;
      checkout?: {
        commonDir: string;
        root: string;
        kind: "main" | "worktree";
        branch: string;
        head: string;
        remote?: string;
      };
    }[];
    errors: string[];
  };
  if (!Array.isArray(report.locations) || !Array.isArray(report.errors))
    throw new Error("SSH 返回格式无效");
  return {
    locations: report.locations.map((raw) => ({
      ...location(environment, raw.path, "scan", raw.exists),
      checkout: raw.checkout
        ? {
            ...raw.checkout,
            repositoryId: identity(environment, raw.checkout.commonDir),
          }
        : undefined,
    })),
    errors: report.errors,
  };
}
