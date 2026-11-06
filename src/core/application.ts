import { randomUUID } from 'node:crypto';
import { Environment, Location, location, Operation, Session, SessionReport, SESSION_TTL, validateData } from './domain';
import { Store } from './persistence';
import { Discovery, scanLocal, scanSSH } from '../integrations/discovery';

export class Application {
  sessions = new Map<string, Session>();
  operations = new Map<string, Operation>();
  private sessionLocations = new Map<string, Location>();
  private scans = new Set<string>();
  constructor(readonly store: Store, readonly now: () => number = Date.now) {}
  environments(): Environment[] { return this.store.data.environments; }
  locations(): Location[] {
    const all = new Map<string, Location>();
    for (const l of this.store.data.manualLocations) all.set(l.id, l);
    for (const e of this.environments()) for (const l of this.store.cache[e.id]?.locations ?? []) all.set(l.id, l);
    for (const l of this.sessionLocations.values()) if (!all.has(l.id)) all.set(l.id, l);
    return [...all.values()];
  }
  activeSessions(): Session[] { return [...this.sessions.values()].filter(s => this.now() - s.lastConfirmed < SESSION_TTL); }
  private associate(report: SessionReport): { locationIds: string[]; unresolved: string[] } {
    const ids = new Set<string>(); const unresolved: string[] = [];
    for (const folder of report.folders) {
      try {
        const uri = new URL(folder.uri);
        const authority = decodeURIComponent(uri.host);
        const e = uri.protocol === 'file:' && !uri.host ? this.environments().find(e => e.kind === 'local') : uri.protocol === 'vscode-remote:' && authority.startsWith('ssh-remote+') ? this.environments().find(e => e.kind === 'ssh' && e.aliases.includes(authority.slice(11))) : undefined;
        if (!e) { unresolved.push(folder.uri); continue; }
        const directory = folder.canonicalPath && e.kind === 'local' ? folder.canonicalPath : decodeURIComponent(uri.pathname);
        const l = location(e, directory, 'session', null);
        this.sessionLocations.set(l.id, l); ids.add(l.id);
        // Only a known checkout ancestor, or extension-provided checkout root, can add checkout membership.
        const candidates = this.locations().filter(c => c.environmentId === e.id && c.checkout && (l.id === c.id || (e.caseSensitive ? directory : directory.toLowerCase()).startsWith((e.caseSensitive ? c.path : c.path.toLowerCase()).replace(/\/$/, '') + '/')));
        const closest = candidates.sort((a,b) => b.path.length - a.path.length)[0];
        if (closest) ids.add(closest.id);
        if (folder.checkoutRoot && e.kind === 'local') {
          const root = location(e, folder.checkoutRoot, 'session', null);
          if (directory === root.path || directory.startsWith(root.path.replace(/\/$/, '') + '/')) { this.sessionLocations.set(root.id, root); ids.add(root.id); }
        }
      } catch { unresolved.push(folder.uri); }
    }
    return { locationIds: [...ids], unresolved };
  }
  report(report: SessionReport): Session {
    validateReport(report);
    if (!this.sessions.has(report.instanceId) && this.sessions.size >= 500) throw new Error('会话数量超过上限');
    const session: Session = { ...report, ...this.associate(report), source: 'extension', toolEnvironmentId: this.environments().find(e => e.kind === 'local')!.id, lastConfirmed: this.now() };
    this.sessions.set(report.instanceId, session);
    return session;
  }
  exit(id: string): void { this.sessions.delete(id); this.sweep(); }
  sweep(): void {
    for (const [id,s] of this.sessions) if (this.now() - s.lastConfirmed > SESSION_TTL * 10) this.sessions.delete(id);
    for (const op of this.operations.values()) {
      if (['pending','accepted'].includes(op.state)) {
        if (this.now() >= op.expiresAt) { op.state = 'timeout'; op.message = '目标未在有效期内返回结果'; }
        else if (!this.activeSessions().some(s => s.instanceId === op.targetId)) { op.state = 'failed'; op.message = '目标会话已退出或过期'; }
      }
      if (this.now() - op.createdAt > 10 * 60_000) this.operations.delete(op.id);
    }
    const activeIds = new Set(this.activeSessions().flatMap(s => s.locationIds));
    for (const id of this.sessionLocations.keys()) if (!activeIds.has(id)) this.sessionLocations.delete(id);
  }
  requestActivation(targetId: string, locationId?: string, id: string = randomUUID()): Operation {
    this.sweep();
    const old = this.operations.get(id);
    if (old) {
      if (old.targetId !== targetId || old.locationId !== locationId) throw new Error('重复请求 ID 的目标不一致');
      return old;
    }
    const session = this.activeSessions().find(s => s.instanceId === targetId);
    if (!session || (locationId && !session.locationIds.includes(locationId))) throw new Error('目标会话或目录关联已失效，请刷新后重新选择');
    const supported = session.capabilities.includes('activateSession');
    const op: Operation = { id, protocol: 1, kind: 'activateSession', targetId, locationId, expectedUris: session.folders.map(f => f.uri).sort(), createdAt: this.now(), expiresAt: this.now() + 12_000, state: supported ? 'pending' : 'unsupported', message: supported ? '等待目标扩展接收' : '此 VS Code 版本未提供窗口聚焦命令，请升级稳定版' };
    this.operations.set(id, op); return op;
  }
  poll(report: SessionReport): Operation[] {
    const session = this.report(report); this.sweep(); const requests: Operation[] = [];
    for (const op of this.operations.values()) if (op.targetId === session.instanceId && op.state === 'pending') {
      if (JSON.stringify(op.expectedUris) !== JSON.stringify(session.folders.map(f => f.uri).sort()) || (op.locationId && !session.locationIds.includes(op.locationId))) { op.state = 'failed'; op.message = '执行前目录关联已变化'; }
      else if (!session.capabilities.includes('activateSession')) { op.state = 'unsupported'; op.message = '窗口已撤回激活能力'; }
      else { op.state = 'accepted'; op.message = '目标扩展已接收，尚未确认激活'; requests.push({...op}); }
    }
    return requests;
  }
  result(targetId: string, id: string, state: string, message: string): Operation {
    this.sweep(); const op = this.operations.get(id);
    if (!op || op.targetId !== targetId) throw new Error('结果目标与请求不匹配');
    if (!['activated','executed','unsupported','failed'].includes(state)) throw new Error('结果状态无效');
    if (op.state !== 'accepted') return op;
    const s = this.activeSessions().find(s => s.instanceId === targetId);
    if (!s || (op.locationId && !s.locationIds.includes(op.locationId)) || JSON.stringify(op.expectedUris) !== JSON.stringify(s.folders.map(f => f.uri).sort())) { op.state = 'failed'; op.message = '回执时目标目录已变化'; return op; }
    op.state = state as Operation['state']; op.message = message.slice(0,1000); return op;
  }
  async scan(id: string, adapter?: (e: Environment) => Promise<Discovery>): Promise<void> {
    const e = this.environments().find(e => e.id === id); if (!e) throw new Error('环境不存在');
    if (this.scans.has(id)) throw new Error('此环境正在扫描');
    this.scans.add(id);
    const previous = this.store.cache[id] ?? { locations: [], status: 'unknown' as const, errors: [] };
    try {
      const found = await (adapter ?? (e.kind === 'local' ? scanLocal : scanSSH))(e);
      // Partial scans never erase the last successful snapshot.
      this.store.cache[id] = found.errors.length ? { ...previous, locations: [...new Map([...previous.locations, ...found.locations].map(l => [l.id,l])).values()], status: 'error', errors: found.errors } : { locations: found.locations, status: 'online', lastSuccess: this.now(), errors: [] };
    } catch (err) { this.store.cache[id] = { ...previous, status: e.kind === 'ssh' ? 'offline' : 'error', errors: [String(err)] }; }
    finally { this.scans.delete(id); }
    this.store.saveCache();
    for (const session of this.activeSessions()) Object.assign(session, this.associate(session));
  }
  saveEnvironment(value: Environment): void {
    const data = this.store.export(); const existing = data.environments.findIndex(e => e.id === value.id);
    if (existing >= 0) {
      const old = data.environments[existing];
      if (old.kind !== value.kind || old.caseSensitive !== value.caseSensitive || old.target !== value.target) throw new Error('环境身份规则不可修改；不同账号或命名空间请添加新环境');
      data.environments[existing] = value;
    } else data.environments.push(value);
    this.store.data = validateData(data); this.store.save();
    for (const session of this.activeSessions()) Object.assign(session, this.associate(session));
  }
  addLocation(l: Location): void {
    const next = this.store.export(); next.manualLocations = [...next.manualLocations.filter(x => x.id !== l.id), {...l, source:'manual'}];
    this.store.data = validateData(next); this.store.save();
  }
  saveWorkset(name: string, ids: string[], id: string = randomUUID()): void {
    if (!name.trim()) throw new Error('请输入工作集名称');
    const next = this.store.export();
    for (const lid of ids) {
      const l = this.locations().find(l => l.id === lid); if (!l) throw new Error('位置不存在');
      if (!next.manualLocations.some(x => x.id === lid)) next.manualLocations.push({...l, source:'manual'});
    }
    next.worksets = [...next.worksets.filter(w => w.id !== id), { id, name: name.trim(), locationIds: [...new Set(ids)] }];
    this.store.data = validateData(next); this.store.save();
  }
  snapshot() {
    this.sweep();
    return { environments: this.environments(), locations: this.locations(), sessions: this.activeSessions(), expiredSessions: [...this.sessions.values()].filter(s => this.now() - s.lastConfirmed >= SESSION_TTL), worksets: this.store.data.worksets, cache: this.store.cache, operations: [...this.operations.values()], scanning: [...this.scans], warnings: this.store.warnings };
  }
}
export function validateReport(value: unknown): asserts value is SessionReport {
  const r = value as SessionReport;
  if (!r || r.protocol !== 1 || r.tool !== 'vscode-stable' || typeof r.instanceId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(r.instanceId) || typeof r.toolVersion !== 'string' || typeof r.workspaceName !== 'string' || typeof r.focused !== 'boolean' || !Array.isArray(r.folders) || r.folders.length > 200 || !Array.isArray(r.capabilities) || r.capabilities.some(c => c !== 'activateSession')) throw new Error('会话协议格式或版本无效');
  for (const f of r.folders) if (!f || typeof f.uri !== 'string' || f.uri.length > 16000 || (f.canonicalPath !== undefined && (typeof f.canonicalPath !== 'string' || !f.canonicalPath.startsWith('/'))) || (f.checkoutRoot !== undefined && (typeof f.checkoutRoot !== 'string' || !f.checkoutRoot.startsWith('/')))) throw new Error('目录报告格式无效');
}
