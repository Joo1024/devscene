import { _electron as electron } from "@playwright/test";
import {
  cp,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const source = path.resolve("release/linux-unpacked");
const isolated = await mkdtemp(path.join(os.tmpdir(), "workscene-installed-"));
await cp(source, path.join(isolated, "app"), { recursive: true });
const cwd = path.join(isolated, "unrelated-working-directory");
await mkdir(cwd);
const env = { ...process.env, XDG_CONFIG_HOME: path.join(isolated, "config") };
const directory = path.join(env.XDG_CONFIG_HOME, "WorkScene");
await mkdir(directory, { recursive: true });
const environment = {
  id: randomUUID(),
  name: "Local",
  kind: "local",
  aliases: [],
  roots: [],
  depth: 3,
  caseSensitive: true,
};
const idFor = (p) =>
  createHash("sha256").update(`${environment.id}\0${p}`).digest("hex");
const legacy = {
  version: 1,
  environments: [environment],
  manualLocations: [
    {
      id: idFor(cwd),
      environmentId: environment.id,
      path: cwd,
      name: "Legacy location",
      source: "manual",
      exists: true,
      checkout: {
        repositoryId: idFor(cwd + "/.git"),
        commonDir: cwd + "/.git",
        root: cwd,
        kind: "main",
        branch: "obsolete",
        head: "old",
      },
    },
  ],
  worksets: [
    { id: "legacy-workset", name: "Preserved", locationIds: [idFor(cwd)] },
  ],
};
await writeFile(
  path.join(directory, "organization.json"),
  JSON.stringify(legacy),
  { mode: 0o600 },
);
const application = await electron.launch({
  executablePath: path.join(isolated, "app", "workscene"),
  args: ["--no-sandbox"],
  cwd,
  env,
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.waitForSelector("#location-count");
  const diagnostics = await page.evaluate(() =>
    window.workscene.call("diagnostics"),
  );
  assert.equal(diagnostics.packaged, true);
  assert.ok(diagnostics.extension.startsWith(isolated));
  await access(diagnostics.extension);
  const info = await application.evaluate(({ app }) => ({
    path: app.getAppPath(),
    cwd: process.cwd(),
  }));
  assert.ok(info.path.startsWith(isolated));
  assert.equal(info.cwd, cwd);
  const snapshot = await page.evaluate(() => window.workscene.call("snapshot"));
  assert.equal(snapshot.locations[0].exists, null);
  assert.equal(snapshot.locations[0].checkout, undefined);
  assert.equal(snapshot.worksets[0].locationIds[0], idFor(cwd));
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(directory, "organization.before-migration-v1.json"),
        "utf8",
      ),
    ),
    legacy,
  );
  const manual = path.join(isolated, "new-directory");
  await mkdir(manual);
  await page.evaluate(
    ({ id, cwd }) =>
      window.workscene.call("addLocation", { environmentId: id, path: cwd }),
    { id: snapshot.environments[0].id, cwd: manual },
  );
  const after = await page.evaluate(() => window.workscene.call("snapshot"));
  assert.equal(after.locations.length, 2);
  assert.equal(
    JSON.parse(
      await readFile(path.join(directory, "organization.json"), "utf8"),
    ).version,
    2,
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  const evidence = {
    platform: process.platform,
    verified: new Date().toISOString(),
    isolated,
    info,
    packaged: diagnostics.packaged,
    bundledExtension: diagnostics.extension,
    checks: [
      "launch copied app from unrelated cwd",
      "no source runtime path",
      "bundled VSIX exists",
      "v1 organization backs up and migrates to v2 in the installed app",
      "migration preserves worksets without stale existence or checkout facts",
      "application IPC and persistence work",
      "no renderer errors",
    ],
  };
  await mkdir("work", { recursive: true });
  await writeFile(
    "work/installed-evidence.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await application.close();
}
