import { handleHealthApi, type HealthEnv, purgeExpired } from './health';
import { isXiaomiLongPollUrl, listDevices, pollQrLogin, SERVERS, startQrLogin } from './xiaomi-cloud';

interface Env extends HealthEnv {
  ASSETS: Fetcher;
}

// Workers free plan allows 50 subrequests per invocation; keep headroom for the login calls.
const SUBREQUEST_BUDGET = 44;
const POLL_WAIT_MS = 20_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (url.pathname === '/api/xiaomi/qr' && req.method === 'POST') {
    const start = await startQrLogin();
    // Proxy the QR image so the page does not depend on Xiaomi's hotlinking rules.
    const img = await fetch(start.qr);
    const bytes = new Uint8Array(await img.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return json({
      qr: `data:${img.headers.get('content-type') ?? 'image/png'};base64,${btoa(bin)}`,
      loginUrl: start.loginUrl,
      lp: start.lp,
      timeout: start.timeout,
    });
  }

  if (url.pathname === '/api/xiaomi/poll' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { lp?: string; server?: string };
    if (!body.lp || !isXiaomiLongPollUrl(body.lp)) return json({ error: 'invalid lp' }, 400);
    const servers = body.server && (SERVERS as readonly string[]).includes(body.server) ? [body.server] : SERVERS;

    const session = await pollQrLogin(body.lp, POLL_WAIT_MS);
    if (!session) return json({ status: 'pending' });
    const devices = await listDevices(session, servers, SUBREQUEST_BUDGET);
    return json({ status: 'ok', devices });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health' || url.pathname.startsWith('/api/health/')) return handleHealthApi(req, url, env);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, url);
      } catch (e) {
        // never log request bodies or tokens
        return json({ error: (e as Error).message || 'Unknown error' }, 502);
      }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeExpired(env));
  },
} satisfies ExportedHandler<Env>;
