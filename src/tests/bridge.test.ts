import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { Application } from "../core/application";
import { Store } from "../core/persistence";
import { startBridge } from "../integrations/bridge";
test("real loopback protocol: authentication, origin rejection, heartbeat, operation result and exit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workscene-bridge-"));
  const app = new Application(new Store(dir));
  const bridge = await startBridge(app);
  t.after(async () => {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${bridge.port}`;
  const report = {
    protocol: 1,
    tool: "vscode-stable",
    toolVersion: "1.110",
    instanceId: "session-test",
    workspaceName: "Empty",
    folders: [],
    focused: true,
    capabilities: ["activateSession"],
  };
  const post = (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(endpoint + "/v1/" + route, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${bridge.token}`, ...headers },
    });
  assert.equal(
    (
      await fetch(endpoint + "/v1/report", {
        method: "POST",
        body: JSON.stringify(report),
      })
    ).status,
    401,
  );
  assert.equal(
    (await post("report", report, { Origin: "https://evil.invalid" })).status,
    401,
  );
  assert.equal((await post("report", report)).status, 200);
  assert.equal(app.activeSessions().length, 1);
  assert.equal(
    fs.statSync(path.join(dir, "connection.json")).mode & 0o777,
    0o600,
  );
  const op = app.requestActivation("session-test");
  const poll = (await (await post("poll", report)).json()) as any;
  assert.equal(poll.requests[0].id, op.id);
  assert.equal(
    (
      await post("result", {
        id: op.id,
        report,
        state: "activated",
        message: "focused",
      })
    ).status,
    200,
  );
  assert.equal(op.state, "activated");
  assert.equal(
    (
      await post("result", {
        id: "removed-operation",
        report,
        state: "activated",
        message: "late",
      })
    ).status,
    410,
  );
  // Raw latin1 matters: the HTTP parser can return equal string lengths but unequal UTF-8 byte lengths.
  const malformed = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(bridge.port, "127.0.0.1", () => {
      socket.write(
        Buffer.from(
          `POST /v1/report HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nAuthorization: ${"é".repeat(71)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
          "latin1",
        ),
      );
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("raw HTTP timeout")),
    );
  });
  assert.match(malformed, /^HTTP\/1.1 401/);
  assert.equal(
    (await post("report", report)).status,
    200,
    "malformed authentication must not kill the broker",
  );
  assert.equal(
    (await post("exit", { instanceId: "session-test" })).status,
    200,
  );
  assert.equal(app.activeSessions().length, 0);
});
