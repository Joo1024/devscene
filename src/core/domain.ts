import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const PROTOCOL = 1;
export const SESSION_TTL = 35_000;
export type Environment = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  target?: string;
  aliases: string[];
  roots: string[];
  depth: number;
  caseSensitive: boolean;
};
export type Checkout = {
  repositoryId: string;
  commonDir: string;
  root: string;
  kind: "main" | "worktree";
  branch: string;
  head: string;
  remote?: string;
};
export type Location = {
  id: string;
  environmentId: string;
  path: string;
  name: string;
  source: "scan" | "manual" | "session";
  exists: boolean | null;
  checkout?: Checkout;
};
export type ScanCache = {
  locations: Location[];
  lastSuccess?: number;
  status: "unknown" | "online" | "offline" | "error";
  errors: string[];
};
export type Workset = { id: string; name: string; locationIds: string[] };
export type UserData = {
  version: 1;
  environments: Environment[];
  manualLocations: Location[];
  worksets: Workset[];
};
export type FolderReport = {
  uri: string;
  canonicalPath?: string;
  checkoutRoot?: string;
  git?: { rootUri: string; branch?: string; head?: string };
};
export type SessionReport = {
  protocol: 1;
  tool: "vscode-stable";
  toolVersion: string;
  instanceId: string;
  workspaceName: string;
  folders: FolderReport[];
  focused: boolean;
  activeFile?: string;
  capabilities: "activateSession"[];
};
export type Session = SessionReport & {
  source: "extension";
  toolEnvironmentId: string;
  lastConfirmed: number;
  locationIds: string[];
  unresolved: string[];
};
export type OperationState =
  | "pending"
  | "accepted"
  | "executed"
  | "activated"
  | "unsupported"
  | "failed"
  | "timeout";
export type Operation = {
  id: string;
  protocol: 1;
  kind: "activateSession" | "openLocation";
  targetId: string;
  locationId?: string;
  expectedUris: string[];
  createdAt: number;
  expiresAt: number;
  state: OperationState;
  message: string;
};
export function identity(environment: Environment, directory: string): string {
  if (!path.posix.isAbsolute(directory) || directory.includes("\0"))
    throw new Error("需要绝对 POSIX 路径");
  const normalized = path.posix.normalize(directory).replace(/\/$/, "") || "/";
  return createHash("sha256")
    .update(
      `${environment.id}\0${environment.caseSensitive ? normalized : normalized.toLowerCase()}`,
    )
    .digest("hex");
}
export function location(
  environment: Environment,
  directory: string,
  source: Location["source"],
  exists: boolean | null = true,
): Location {
  const normalized = path.posix.normalize(directory);
  return {
    id: identity(environment, normalized),
    environmentId: environment.id,
    path: normalized,
    name: path.posix.basename(normalized) || "/",
    source,
    exists,
  };
}
export function initialData(): UserData {
  return {
    version: 1,
    environments: [
      {
        id: randomUUID(),
        name: "本机",
        kind: "local",
        aliases: [],
        roots: [],
        depth: 3,
        caseSensitive: true,
      },
    ],
    manualLocations: [],
    worksets: [],
  };
}
export function validateData(value: unknown): UserData {
  const v = value as UserData;
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.environments) ||
    !Array.isArray(v.manualLocations) ||
    !Array.isArray(v.worksets)
  )
    throw new Error("不支持的配置格式或版本");
  if (
    v.environments.length > 100 ||
    v.manualLocations.length > 20000 ||
    v.worksets.length > 1000
  )
    throw new Error("配置超出数量限制");
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const e of v.environments) {
    if (
      typeof e.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) ||
      ["__proto__", "constructor", "prototype"].includes(e.id) ||
      ids.has(e.id) ||
      typeof e.name !== "string" ||
      !e.name.trim() ||
      e.name.length > 200 ||
      !["local", "ssh"].includes(e.kind) ||
      typeof e.caseSensitive !== "boolean" ||
      !Number.isInteger(e.depth) ||
      e.depth < 0 ||
      e.depth > 8 ||
      !Array.isArray(e.roots) ||
      e.roots.length > 100 ||
      !Array.isArray(e.aliases) ||
      e.aliases.length > 100
    )
      throw new Error("环境配置无效");
    ids.add(e.id);
    if (
      e.kind === "ssh" &&
      (!e.target || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(e.target))
    )
      throw new Error("SSH 目标必须是系统 SSH 别名或 user@host");
    for (const root of e.roots) identity(e, root);
    for (const alias of e.aliases) {
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(alias) || aliases.has(alias))
        throw new Error("SSH 别名必须唯一，不能跨环境自动合并");
      aliases.add(alias);
    }
  }
  if (v.environments.filter((e) => e.kind === "local").length !== 1)
    throw new Error("必须保留且仅保留一个本机环境");
  const locIds = new Set<string>();
  for (const l of v.manualLocations) {
    const e = v.environments.find((e) => e.id === l.environmentId);
    if (
      !e ||
      typeof l.path !== "string" ||
      l.path.length > 16000 ||
      typeof l.name !== "string" ||
      !l.name ||
      !["manual", "scan", "session"].includes(l.source) ||
      ![true, false, null].includes(l.exists) ||
      l.id !== identity(e, l.path) ||
      locIds.has(l.id)
    )
      throw new Error("位置身份或环境无效");
    if (
      l.checkout &&
      (typeof l.checkout.commonDir !== "string" ||
        l.checkout.repositoryId !== identity(e, l.checkout.commonDir) ||
        l.checkout.root !== l.path ||
        !["main", "worktree"].includes(l.checkout.kind) ||
        typeof l.checkout.branch !== "string" ||
        typeof l.checkout.head !== "string")
    )
      throw new Error("Checkout 元数据无效");
    locIds.add(l.id);
  }
  const wsIds = new Set<string>();
  for (const w of v.worksets) {
    if (
      typeof w.id !== "string" ||
      !w.id ||
      wsIds.has(w.id) ||
      typeof w.name !== "string" ||
      !w.name.trim() ||
      w.name.length > 200 ||
      !Array.isArray(w.locationIds) ||
      w.locationIds.some((id) => !locIds.has(id)) ||
      new Set(w.locationIds).size !== w.locationIds.length
    )
      throw new Error("工作集引用无效");
    wsIds.add(w.id);
  }
  return structuredClone(v);
}
