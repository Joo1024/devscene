import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initialData, ScanCache, UserData, validateData } from "./domain";

export function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
export class Store {
  data: UserData;
  cache: Record<string, ScanCache> = {};
  warnings: string[] = [];
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "organization.json");
    this.data = fs.existsSync(file)
      ? validateData(JSON.parse(fs.readFileSync(file, "utf8")))
      : initialData();
    if (!fs.existsSync(file)) this.save();
    try {
      const cache = JSON.parse(
        fs.readFileSync(path.join(directory, "discovery-cache.json"), "utf8"),
      );
      if (cache.version !== 1 || !cache.environments)
        throw new Error("缓存版本无效");
      for (const [id, entry] of Object.entries(cache.environments)) {
        const c = entry as ScanCache;
        if (
          !this.data.environments.some((e) => e.id === id) ||
          !c ||
          !["unknown", "online", "offline", "error"].includes(c.status) ||
          !Array.isArray(c.errors) ||
          c.errors.some((e) => typeof e !== "string") ||
          (c.lastSuccess !== undefined && !Number.isFinite(c.lastSuccess))
        )
          throw new Error("缓存状态无效");
        validateData({
          ...this.data,
          manualLocations: c.locations,
          worksets: [],
        });
      }
      this.cache = cache.environments;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        this.warnings.push(`发现缓存无法读取，可重新扫描：${String(err)}`);
    }
  }
  save(): void {
    atomicWrite(
      path.join(this.directory, "organization.json"),
      validateData(this.data),
    );
  }
  saveCache(): void {
    atomicWrite(path.join(this.directory, "discovery-cache.json"), {
      version: 1,
      environments: this.cache,
    });
  }
  export(): UserData {
    return structuredClone(this.data);
  }
  import(value: unknown): void {
    const next = validateData(value);
    atomicWrite(
      path.join(this.directory, "organization.before-import.json"),
      this.data,
    );
    atomicWrite(path.join(this.directory, "organization.json"), next);
    this.data = next;
    // Imported identities may describe another machine. Never reuse an older machine's cache.
    this.cache = {};
    this.saveCache();
  }
}
