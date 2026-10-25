import { healthSession, isXiaomiLongPollUrl, listDevices, listFitnessDevices, pollQrLogin, SERVERS, ssoSession, startQrLogin } from './xiaomi-cloud';

interface Env {
  ASSETS: Fetcher;
}

// Workers free plan allows 50 subrequests per invocation. Login: long-poll + STS (up to 3), Mi Fitness
// up to 12 (base host + regions on auto-detect), Mi Home SSO 2; the rest is for Mi Home device listing.
const FITNESS_BUDGET = 12;
const MIHOME_BUDGET = 30;
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
    // Only known region codes: the value becomes part of a hostname that receives the session.
    const server = body.server && (SERVERS as readonly string[]).includes(body.server) ? body.server : undefined;
    const servers = server ? [server] : SERVERS;

    const login = await pollQrLogin(body.lp, POLL_WAIT_MS);
    if (!login) return json({ status: 'pending' });

    // Outcome of each step for the page's connection log: hosts, HTTP status and Xiaomi codes only.
    const trail: string[] = [];

    // 1. Mi Fitness (bands 7 Pro / 8 / 9 / 10, watches): the QR logged in to this service.
    const fitness = await healthSession(login, trail)
      .then((s) => listFitnessDevices(s, server, FITNESS_BUDGET))
      .catch((e: Error) => {
        trail.push(`mi fitness: ${e.message.slice(0, 80)}`);
        return { ok: false, devices: [] };
      });
    if (fitness.devices.some((d) => d.key)) return json({ status: 'ok', fitness: { ok: true }, mihome: { ok: null }, devices: fitness.devices, trail });

    // 2. Mi Home Bluetooth devices, reached with the same login (passToken SSO, no second scan).
    let mihome: { ok: boolean | null } = { ok: null };
    let homeDevices: Awaited<ReturnType<typeof listDevices>> = [];
    const home = await ssoSession(login, 'xiaomiio', trail).catch((e: Error) => {
      trail.push(`mi home: ${e.message.slice(0, 80)}`);
      return null;
    });
    if (home) {
      homeDevices = await listDevices(home, servers, MIHOME_BUDGET).catch(() => []);
      mihome = { ok: true };
    } else {
      mihome = { ok: false };
    }
    return json({ status: 'ok', fitness: { ok: fitness.ok }, mihome, devices: [...fitness.devices, ...homeDevices], trail });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
} satisfies ExportedHandler<Env>;
