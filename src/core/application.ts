import { randomUUID } from "node:crypto";
import {
  Environment,
  Location,
  location,
  locationReference,
  ScanCache,
  Operation,
  Session,
  SessionReport,
  SESSION_TTL,
} from "./domain";
import { Store } from "./persistence";
import { Discovery, scanLocal, scanSSH } from "../integrations/discovery";
import { resolveVSCodeFolder, validateReport } from "../integrations/vscode";

export class Application {
  sessions = new Map<string, Session>();
  operations = new Map<string, Operation>();
  private sessionLocations = new Map<string, Location>();
  private scans = new Map<string, symbol>();
  constructor(
    readonly store: Store,
    readonly now: () => number = Date.now,
  ) {}
  environments(): Environment[] {
    return this.store.data.environments;
  }
  locations(): Location[] {
    const all = new Map<string, Location>();
    for (const l of this.store.data.manualLocations)
      all.set(l.id, { ...l, source: "manual", exists: null });
    for (const e of this.environments())
      for (const l of this.store.cache[e.id]?.locations ?? []) all.set(l.id, l);
    for (const l of this.sessionLocations.values())
      if (!all.has(l.id)) all.set(l.id, l);
    return [...all.values()];
  }
  activeSessions(): Session[] {
    return [...this.sessions.values()].filter(
      (s) => this.now() - s.lastConfirmed < SESSION_TTL,
    );
  }
  private associate(report: SessionReport): {
    locationIds: string[];
    unresolved: string[];
  } {
    const ids = new Set<string>();
    const unresolved: string[] = [];
    for (const folder of report.folders) {
      try {
        const resolved = resolveVSCodeFolder(folder, this.environments());
        if (!resolved) {
          unresolved.push(folder.uri);
          continue;
        }
        const { environment: e, directory } = resolved;
        const l = location(e, directory, "session", null);
        this.sessionLocations.set(l.id, l);
        ids.add(l.id);
        // Directory containment alone cannot establish checkout membership (nested repos/submodules).
        if (resolved.checkoutPath) {
          const root = location(e, resolved.checkoutPath, "session", null);
          this.sessionLocations.set(root.id, root);
          ids.add(root.id);
        }
      } catch {
        unresolved.push(folder.uri);
      }
    }
    return { locationIds: [...ids], unresolved };
  }
  report(report: SessionReport): Session {
    validateReport(report);
    if (!this.sessions.has(report.instanceId) && this.sessions.size >= 500)
      throw new Error("会话数量超过上限");
    const session: Session = {
      ...report,
      ...this.associate(report),
      source: "extension",
      toolEnvironmentId: this.environments().find((e) => e.kind === "local")!
        .id,
      lastConfirmed: this.now(),
    };
    this.sessions.set(report.instanceId, session);
    return session;
  }
  exit(id: string): void {
    this.sessions.delete(id);
    this.sweep();
  }
  sweep(): void {
    for (const [id, s] of this.sessions)
      if (this.now() - s.lastConfirmed > SESSION_TTL * 10)
        this.sessions.delete(id);
    for (const op of this.operations.values()) {
      if (["pending", "accepted"].includes(op.state)) {
        if (this.now() >= op.expiresAt) {
          op.state = "timeout";
          op.message = "目标未在有效期内返回结果";
        } else if (
          op.kind === "activateSession" &&
          !this.activeSessions().some((s) => s.instanceId === op.targetId)
        ) {
          op.state = "failed";
          op.message = "目标会话已退出或过期";
        }
      }
      if (this.now() - op.createdAt > 10 * 60_000)
        this.operations.delete(op.id);
    }
    const activeIds = new Set(
      this.activeSessions().flatMap((s) => s.locationIds),
    );
    for (const id of this.sessionLocations.keys())
      if (!activeIds.has(id)) this.sessionLocations.delete(id);
  }
  requestActivation(
    targetId: string,
    locationId?: string,
    id: string = randomUUID(),
  ): Operation {
    this.sweep();
    const old = this.operations.get(id);
    if (old) {
      if (
        old.kind !== "activateSession" ||
        old.targetId !== targetId ||
        old.locationId !== locationId
      )
        throw new Error("重复请求 ID 的目标不一致");
      return old;
    }
    const session = this.activeSessions().find(
      (s) => s.instanceId === targetId,
    );
    if (!session || (locationId && !session.locationIds.includes(locationId)))
      throw new Error("目标会话或目录关联已失效，请刷新后重新选择");
    const supported = session.capabilities.includes("activateSession");
    const op: Operation = {
      id,
      protocol: 1,
      kind: "activateSession",
      targetId,
      locationId,
      expectedUris: session.folders.map((f) => f.uri).sort(),
      createdAt: this.now(),
      expiresAt: this.now() + 12_000,
      state: supported ? "pending" : "unsupported",
      message: supported
        ? "等待目标扩展接收"
        : "此 VS Code 版本未提供窗口聚焦命令，请升级稳定版",
    };
    this.operations.set(id, op);
    return op;
  }
  async openLocation(
    locationId: string,
    opener: (location: Location, environment: Environment) => Promise<void>,
    id: string = randomUUID(),
  ): Promise<Operation> {
    this.sweep();
    const old = this.operations.get(id);
    if (old) {
      if (old.kind !== "openLocation" || old.locationId !== locationId)
        throw new Error("重复请求 ID 的目标不一致");
      return old;
    }
    const target = this.locations().find((l) => l.id === locationId);
    const environment = this.environments().find(
      (e) => e.id === target?.environmentId,
    );
    if (!target || !environment) throw new Error("位置不存在");
    const op: Operation = {
      id,
      protocol: 1,
      kind: "openLocation",
      targetId: locationId,
      locationId,
      expectedUris: [],
      createdAt: this.now(),
      expiresAt: this.now() + 15_000,
      state: "accepted",
      message: "打开命令已接收，尚未确认新会话",
    };
    this.operations.set(id, op);
    try {
      await opener(target, environment);
      this.sweep();
      if (op.state === "accepted") {
        op.state = "executed";
        op.message = "新窗口打开命令已执行；等待扩展上报后才计入已连接窗口";
      }
    } catch (err) {
      this.sweep();
      if (op.state === "accepted") {
        op.state = "failed";
        op.message = String(err).slice(0, 1000);
      }
    }
    return op;
  }
  poll(report: SessionReport): Operation[] {
    const session = this.report(report);
    this.sweep();
    const requests: Operation[] = [];
    for (const op of this.operations.values())
      if (
        op.kind === "activateSession" &&
        op.targetId === session.instanceId &&
        op.state === "pending"
      ) {
        if (
          JSON.stringify(op.expectedUris) !==
            JSON.stringify(session.folders.map((f) => f.uri).sort()) ||
          (op.locationId && !session.locationIds.includes(op.locationId))
        ) {
          op.state = "failed";
          op.message = "执行前目录关联已变化";
        } else if (!session.capabilities.includes("activateSession")) {
          op.state = "unsupported";
          op.message = "窗口已撤回激活能力";
        } else {
          op.state = "accepted";
          op.message = "目标扩展已接收，尚未确认激活";
          requests.push({ ...op });
        }
      }
    return requests;
  }
  result(
    targetId: string,
    id: string,
    state: string,
    message: string,
  ): Operation {
    this.sweep();
    const op = this.operations.get(id);
    if (!op || op.kind !== "activateSession" || op.targetId !== targetId)
      throw new Error("结果目标与请求不匹配");
    if (!["activated", "executed", "unsupported", "failed"].includes(state))
      throw new Error("结果状态无效");
    if (op.state !== "accepted") return op;
    const s = this.activeSessions().find((s) => s.instanceId === targetId);
    if (
      !s ||
      (op.locationId && !s.locationIds.includes(op.locationId)) ||
      JSON.stringify(op.expectedUris) !==
        JSON.stringify(s.folders.map((f) => f.uri).sort())
    ) {
      op.state = "failed";
      op.message = "回执时目标目录已变化";
      return op;
    }
    if (state === "activated" && !s.focused) {
      op.state = "executed";
      op.message = "命令已执行，但最新报告未确认焦点";
      return op;
    }
    op.state = state as Operation["state"];
    op.message = message.slice(0, 1000);
    return op;
  }
  async scan(
    id: string,
    adapter?: (e: Environment) => Promise<Discovery>,
  ): Promise<void> {
    const e = this.environments().find((e) => e.id === id);
    if (!e) throw new Error("环境不存在");
    if (this.scans.has(id)) throw new Error("此环境正在扫描");
    const token = Symbol(id);
    this.scans.set(id, token);
    const previous = this.store.cache[id] ?? {
      locations: [],
      status: "unknown" as const,
      errors: [],
    };
    try {
      let next: ScanCache;
      try {
        const found = await (
          adapter ?? (e.kind === "local" ? scanLocal : scanSSH)
        )(structuredClone(e));
        next = found.errors.length
          ? {
              ...previous,
              locations: [
                ...new Map(
                  [...previous.locations, ...found.locations].map((l) => [
                    l.id,
                    l,
                  ]),
                ).values(),
              ],
              status: "error",
              errors: found.errors,
            }
          : {
              locations: found.locations,
              status: "online",
              lastSuccess: this.now(),
              errors: [],
            };
      } catch (err) {
        next = {
          ...previous,
          status: e.kind === "ssh" ? "offline" : "error",
          errors: [String(err)],
        };
      }
      // Import/edit invalidates this token. Neither old successes nor failures may write back.
      if (this.scans.get(id) !== token) return;
      this.store.cache[id] = next;
      this.store.saveCache();
      for (const session of this.activeSessions())
        Object.assign(session, this.associate(session));
    } finally {
      // A newer scan may already be running for the same environment.
      if (this.scans.get(id) === token) this.scans.delete(id);
    }
  }
  importOrganization(value: unknown): void {
    this.store.import(value);
    this.scans.clear();
    this.sessions.clear();
    this.sessionLocations.clear();
    for (const op of this.operations.values())
      if (["pending", "accepted"].includes(op.state)) {
        op.state = "failed";
        op.message = "配置已导入，原目标关联已失效";
      }
  }
  deleteWorkset(id: string): void {
    const next = this.store.export();
    next.worksets = next.worksets.filter((w) => w.id !== id);
    this.store.replace(next);
  }

  saveEnvironment(value: Environment): void {
    const data = this.store.export();
    const existing = data.environments.findIndex((e) => e.id === value.id);
    if (existing >= 0) {
      const old = data.environments[existing];
      if (
        old.kind !== value.kind ||
        old.caseSensitive !== value.caseSensitive ||
        old.target !== value.target
      )
        throw new Error("环境身份规则不可修改；不同账号或命名空间请添加新环境");
      data.environments[existing] = value;
    } else data.environments.push(value);
    this.store.replace(data);
    this.scans.delete(value.id);
    const cache = this.store.cache[value.id];
    if (cache) {
      cache.status = "unknown";
      this.store.saveCache();
    }
    for (const session of this.activeSessions())
      Object.assign(session, this.associate(session));
  }
  addLocation(l: Location): void {
    const next = this.store.export();
    next.manualLocations = [
      ...next.manualLocations.filter((x) => x.id !== l.id),
      locationReference(l),
    ];
    this.store.replace(next);
  }
  saveWorkset(name: string, ids: string[], id: string = randomUUID()): void {
    if (!name.trim()) throw new Error("请输入工作集名称");
    const next = this.store.export();
    for (const lid of ids) {
      const l = this.locations().find((l) => l.id === lid);
      if (!l) throw new Error("位置不存在");
      if (!next.manualLocations.some((x) => x.id === lid))
        next.manualLocations.push(locationReference(l));
    }
    next.worksets = [
      ...next.worksets.filter((w) => w.id !== id),
      { id, name: name.trim(), locationIds: [...new Set(ids)] },
    ];
    this.store.replace(next);
  }
  snapshot() {
    this.sweep();
    return {
      environments: this.environments(),
      locations: this.locations(),
      sessions: this.activeSessions(),
      expiredSessions: [...this.sessions.values()].filter(
        (s) => this.now() - s.lastConfirmed >= SESSION_TTL,
      ),
      worksets: this.store.data.worksets,
      cache: this.store.cache,
      operations: [...this.operations.values()],
      scanning: [...this.scans.keys()],
      warnings: this.store.warnings,
    };
  }
}
