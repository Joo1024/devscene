import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Application } from '../core/application';
import { atomicWrite } from '../core/persistence';

export async function startBridge(app: Application) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(body)); };
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth),Buffer.from(expected))) { reply(401, {error:'unauthorized'}); return; }
    if (req.method !== 'POST') { reply(405,{error:'POST required'}); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) { reply(413,{error:'report too large'}); req.destroy(); return; } chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/v1/report') reply(200, {session:app.report(data)});
      else if (req.url === '/v1/poll') reply(200, {requests:app.poll(data)});
      else if (req.url === '/v1/exit') { app.exit(data.instanceId); reply(200,{ok:true}); }
      else if (req.url === '/v1/result') { app.report(data.report); reply(200,{operation:app.result(data.report.instanceId,data.id,data.state,data.message)}); }
      else reply(404,{error:'unknown route'});
    } catch (err) { reply(400,{error:String(err)}); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const port = (server.address() as {port:number}).port;
  const file = path.join(app.store.directory,'connection.json');
  atomicWrite(file,{protocol:1,port,token});
  const timer = setInterval(() => app.sweep(),1000); timer.unref();
  return {port,token,close:async () => { clearInterval(timer); fs.rmSync(file,{force:true}); await new Promise<void>(resolve => server.close(() => resolve())); }};
}
