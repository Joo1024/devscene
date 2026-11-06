import { _electron as electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const source = path.resolve("release/linux-unpacked");
const isolated = await mkdtemp(path.join(os.tmpdir(), "workscene-installed-"));
await cp(source, path.join(isolated, "app"), { recursive: true });
const cwd = path.join(isolated, "unrelated-working-directory");
await mkdir(cwd);
const env = { ...process.env, XDG_CONFIG_HOME: path.join(isolated, "config") };
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
  await page.evaluate(
    ({ id, cwd }) =>
      window.workscene.call("addLocation", { environmentId: id, path: cwd }),
    { id: snapshot.environments[0].id, cwd },
  );
  const after = await page.evaluate(() => window.workscene.call("snapshot"));
  assert.equal(after.locations.length, 1);
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
