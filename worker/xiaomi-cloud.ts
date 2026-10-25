// Xiaomi account QR login + device key lookup, ported from
// PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT). Runs inside the Worker so the session
// (ssecurity / serviceToken) never reaches the browser and is never stored.

export const SERVERS = ['sg', 'de', 'us', 'cn', 'i2', 'ru', 'tw', 'in'] as const;
export type Server = (typeof SERVERS)[number];

export interface CloudDevice {
  server: string;
  name: string;
  model: string;
  did: string;
  mac?: string;
  key?: string;
}

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function digest(alg: 'SHA-256' | 'SHA-1', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data.slice() as Uint8Array<ArrayBuffer>));
}

/** RC4 with the first 1024 keystream bytes dropped (Xiaomi "ENCRYPT-RC4"). */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  let j = 0;
  const out = new Uint8Array(data.length);
  for (let n = -1024; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    if (n >= 0) out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function toJson(text: string): Record<string, unknown> {
  return JSON.parse(text.replace('&&&START&&&', ''));
}

function randomChars(n: number, from: number, to: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(from + Math.floor(Math.random() * (to - from + 1)))).join('');
}

// ------------------------------------------------------------- QR login ---

export interface QrStart {
  qr: string;
  loginUrl: string;
  lp: string;
  timeout: number;
}

export async function startQrLogin(): Promise<QrStart> {
  const params = new URLSearchParams({
    _qrsize: '480',
    qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
    callback: 'https://sts.api.io.mi.com/sts',
    _hasLogo: 'false',
    sid: 'xiaomiio',
    serviceParam: '',
    _locale: 'en_GB',
    _dc: String(Date.now()),
  });
  const r = await fetch(`https://account.xiaomi.com/longPolling/loginUrl?${params}`);
  if (!r.ok) throw new Error(`Xiaomi loginUrl HTTP ${r.status}`);
  const d = toJson(await r.text());
  if (typeof d.qr !== 'string' || typeof d.lp !== 'string') throw new Error('Xiaomi không trả về mã QR');
  return { qr: d.qr, loginUrl: String(d.loginUrl ?? ''), lp: d.lp, timeout: Number(d.timeout ?? 300) };
}

/** Only Xiaomi's own long-polling endpoint may be proxied. */
export function isXiaomiLongPollUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const hostOk = url.hostname === 'account.xiaomi.com' || url.hostname.endsWith('.account.xiaomi.com');
    // e.g. https://sgp.lp.account.xiaomi.com/lp/s?k=lp_…
    return url.protocol === 'https:' && hostOk && (url.pathname.startsWith('/lp/') || url.pathname.startsWith('/longPolling/'));
  } catch {
    return false;
  }
}

/** Waits up to `waitMs` for the QR to be scanned. Returns null while still pending. */
export async function pollQrLogin(lp: string, waitMs: number): Promise<Session | null> {
  let r: Response;
  try {
    r = await fetch(lp, { signal: AbortSignal.timeout(waitMs) });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') return null;
    throw e;
  }
  if (r.status !== 200) return null;
  const d = toJson(await r.text());
  if (!d.ssecurity || !d.location) throw new Error('Đăng nhập Xiaomi không thành công');

  const loc = await fetch(String(d.location), { redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = loc.headers.getSetCookie().map((c) => /^serviceToken=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (!cookie) throw new Error('Không lấy được service token từ Xiaomi');
  return new Session(String(d.userId), String(d.ssecurity), cookie);
}


export async function signedNonce(ssecurity: string, nonce: string): Promise<string> {
  const a = unb64(ssecurity);
  const b = unb64(nonce);
  const buf = new Uint8Array(a.length + b.length);
  buf.set(a);
  buf.set(b, a.length);
  return b64(await digest('SHA-256', buf));
}

export function makeNonce(now = Date.now()): string {
  const n = new Uint8Array(12);
  crypto.getRandomValues(n.subarray(0, 8));
  new DataView(n.buffer).setUint32(8, Math.floor(now / 60000));
  return b64(n);
}

async function encSignature(path: string, signed: string, params: [string, string][]): Promise<string> {
  const parts = ['POST', path, ...params.map(([k, v]) => `${k}=${v}`), signed];
  return b64(await digest('SHA-1', enc.encode(parts.join('&'))));
}

/** generate_enc_params: path is the API path without the /app prefix, e.g. /v2/homeroom/gethome. */
export async function buildEncryptedParams(path: string, data: string, ssecurity: string, nonce: string): Promise<[string, string][]> {
  const signed = await signedNonce(ssecurity, nonce);
  const key = unb64(signed);
  const params: [string, string][] = [['data', data]];
  params.push(['rc4_hash__', await encSignature(path, signed, params)]);
  const encrypted: [string, string][] = params.map(([k, v]) => [k, b64(rc4(key, enc.encode(v)))]);
  encrypted.push(['signature', await encSignature(path, signed, encrypted)]);
  encrypted.push(['ssecurity', ssecurity], ['_nonce', nonce]);
  return encrypted;
}

export async function decryptResponse(ssecurity: string, nonce: string, body: string): Promise<string> {
  const key = unb64(await signedNonce(ssecurity, nonce));
  return new TextDecoder().decode(rc4(key, unb64(body)));
}

// ---------------------------------------------------------- cloud API ---

export class Session {
  private readonly agent = `${randomChars(18, 97, 122)}-${randomChars(13, 65, 69)} APP/com.xiaomi.mihome APPV/10.5.201`;
  subrequests = 0;

  constructor(readonly userId: string, private readonly ssecurity: string, private readonly serviceToken: string) {}

  async call(server: string, path: string, data: unknown): Promise<Record<string, unknown> | null> {
    const host = server === 'cn' ? 'api.io.mi.com' : `${server}.api.io.mi.com`;
    const nonce = makeNonce();
    const encrypted = await buildEncryptedParams(path, JSON.stringify(data), this.ssecurity, nonce);

    this.subrequests++;
    const r = await fetch(`https://${host}/app${path}?${new URLSearchParams(encrypted)}`, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': this.agent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: [
          `userId=${this.userId}`,
          `yetAnotherServiceToken=${this.serviceToken}`,
          `serviceToken=${this.serviceToken}`,
          'locale=en_GB',
          'timezone=GMT+00:00',
          'is_daylight=0',
          'dst_offset=0',
          'channel=MI_APP_STORE',
        ].join('; '),
      },
    });
    if (!r.ok) return null;
    return JSON.parse(await decryptResponse(this.ssecurity, nonce, await r.text()));
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Lists every device on the account and fetches the key of each Bluetooth (blt.*) device. */
export async function listDevices(s: Session, servers: readonly string[], budget: number): Promise<CloudDevice[]> {
  const out: CloudDevice[] = [];
  for (const server of servers) {
    if (s.subrequests + 3 > budget) break;
    const homes: { id: string; owner: string }[] = [];
    const h = (await s.call(server, '/v2/homeroom/gethome', { fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7 })) as Json | null;
    for (const home of h?.result?.homelist ?? []) homes.push({ id: String(home.id), owner: s.userId });
    const c = (await s.call(server, '/v2/user/get_device_cnt', { fetch_own: true, fetch_share: true })) as Json | null;
    for (const home of c?.result?.share?.share_family ?? []) homes.push({ id: String(home.home_id), owner: String(home.home_owner) });

    for (const home of homes) {
      if (s.subrequests + 1 > budget) break;
      const d = (await s.call(server, '/v2/home/home_device_list', {
        home_owner: Number(home.owner),
        home_id: Number(home.id),
        limit: 200,
        get_split_device: true,
        support_smart_home: true,
      })) as Json | null;
      for (const dev of d?.result?.device_info ?? []) {
        const did = String(dev.did ?? '');
        const item: CloudDevice = { server, name: String(dev.name ?? ''), model: String(dev.model ?? ''), did, mac: dev.mac };
        if (did.includes('blt') && s.subrequests + 1 <= budget) {
          const k = (await s.call(server, '/v2/device/blt_get_beaconkey', { did, pdid: 1 })) as Json | null;
          if (typeof k?.result?.beaconkey === 'string') item.key = k.result.beaconkey;
        }
        out.push(item);
      }
    }
  }
  return out;
}
