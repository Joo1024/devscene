import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Application } from "../core/application";
import { atomicWrite } from "../core/persistence";

export async function startBridge(app: Application) {
  const token = randomBytes(32).toString("hex");
  const brokerId = randomUUID();
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    const supplied = Buffer.from(auth);
    const expectedBytes = Buffer.from(expected);
    if (
      req.headers.origin ||
      !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "") ||
      !/^Bearer [a-f0-9]{64}$/.test(auth) ||
      supplied.length !== expectedBytes.length ||
      !timingSafeEqual(supplied, expectedBytes)
    ) {
      reply(401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      reply(405, { error: "POST required" });
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) {
          reply(413, { error: "report too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/v1/report") reply(200, { session: app.report(data) });
      else if (req.url === "/v1/poll") reply(200, { requests: app.poll(data) });
      else if (req.url === "/v1/exit") {
        app.exit(data.instanceId);
        reply(200, { ok: true });
      } else if (req.url === "/v1/result") {
        app.report(data.report);
        app.sweep();
        if (!app.operations.has(data.id)) {
          reply(410, {
            code: "operation_gone",
            error: "请求已过期清理或属于之前的接入服务实例",
          });
          return;
        }
        reply(200, {
          operation: app.result(
            data.report.instanceId,
            data.id,
            data.state,
            data.message,
          ),
        });
      } else reply(404, { error: "unknown route" });
    } catch (err) {
      reply(400, { error: String(err) });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const file = path.join(app.store.directory, "connection.json");
  atomicWrite(file, { protocol: 1, brokerId, port, token });
  const timer = setInterval(() => app.sweep(), 1000);
  timer.unref();
  return {
    port,
    token,
    brokerId,
    close: async () => {
      clearInterval(timer);
      fs.rmSync(file, { force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
