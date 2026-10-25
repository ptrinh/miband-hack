// Xiaomi account QR login + device key lookup. Runs inside the Worker so the session
// (ssecurity / serviceToken / passToken) never reaches the browser and is never stored.
//
// - QR login and the Mi Home (xiaomiio) calls are ported from
//   PiotrMachowski/Xiaomi-cloud-tokens-extractor (MIT).
// - The Mi Fitness (sid "miothealth") QR login and POST /app/v1/source/get_source_list follow
//   lzghzr/ha_miband cloud.py (Apache-2.0), cross-checked with AstralSightStudios/AstroBox
//   (AGPL-3.0, reads detail.encrypt_key as the auth key) and argrento/huami-token (MIT,
//   detail.auth_key, continuous-RC4 request variant).

export const SERVERS = ['sg', 'de', 'us', 'cn', 'i2', 'ru', 'tw', 'in'] as const;
export type Server = (typeof SERVERS)[number];

export interface CloudDevice {
  server: string;
  /** Which app's cloud the device came from. */
  source?: 'mifitness' | 'mihome';
  /** Field of the Mi Fitness record the key came from (encrypt_key, auth_key, token…). */
  keyField?: string;
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

/** Mi Fitness service id and its STS callback (as returned by serviceLogin?sid=miothealth). */
export const HEALTH_SID = 'miothealth';
const HEALTH_CALLBACK = 'https://sts-hlth.io.mi.com/healthapp/sts';

/** The QR logs in to Mi Fitness; Mi Home (xiaomiio) is reached afterwards with the passToken. */
export async function startQrLogin(): Promise<QrStart> {
  const params = new URLSearchParams({
    _qrsize: '480',
    qs: `%3Fsid%3D${HEALTH_SID}%26_json%3Dtrue`,
    callback: HEALTH_CALLBACK,
    _hasLogo: 'false',
    sid: HEALTH_SID,
    serviceParam: '',
    _locale: 'en_GB',
    _dc: String(Date.now()),
  });
  const r = await fetch(`https://account.xiaomi.com/longPolling/loginUrl?${params}`);
  if (!r.ok) throw new Error(`Xiaomi loginUrl HTTP ${r.status}`);
  const d = toJson(await r.text());
  if (typeof d.qr !== 'string' || typeof d.lp !== 'string') throw new Error('Xiaomi did not return a QR code');
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

/** What the long-poll returns once the QR is confirmed (never leaves the Worker). */
export interface QrLogin {
  userId: string;
  cUserId: string;
  ssecurity: string;
  passToken: string;
  location: string;
  nonce?: string;
}

/** Waits up to `waitMs` for the QR to be scanned. Returns null while still pending. */
export async function pollQrLogin(lp: string, waitMs: number): Promise<QrLogin | null> {
  let r: Response;
  try {
    r = await fetch(lp, { signal: AbortSignal.timeout(waitMs) });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') return null;
    throw e;
  }
  if (r.status !== 200) return null;
  const d = toJson(await r.text());
  if (!d.ssecurity || !d.location) throw new Error('Xiaomi login failed');
  return {
    userId: String(d.userId ?? ''),
    cUserId: String(d.cUserId ?? ''),
    ssecurity: String(d.ssecurity),
    passToken: String(d.passToken ?? ''),
    location: String(d.location),
    nonce: d.nonce == null ? undefined : String(d.nonce),
  };
}

/** clientSign = base64(SHA1("nonce=<nonce>&<ssecurity>")), appended to the STS location. */
export async function clientSign(nonce: string, ssecurity: string): Promise<string> {
  return b64(await digest('SHA-1', enc.encode(`nonce=${nonce}&${ssecurity}`)));
}

const STS_AGENT = () => `${randomChars(18, 97, 122)}-${randomChars(13, 65, 69)} APP/com.xiaomi.mihome APPV/10.5.201`;

/**
 * Follows the STS location and returns the serviceToken cookie it sets. First as ha_miband does it
 * (plain GET with an app User-Agent, redirects followed), then with a clientSign appended, as the
 * Mi Home extractor does: Mi Fitness' STS answered 200 without a token to the second form alone.
 */
async function fetchServiceToken(location: string, ssecurity: string, nonce?: string, trail?: string[]): Promise<string> {
  const host = new URL(location).host;
  const attempts: { label: string; url: string; manual: boolean }[] = [{ label: 'plain', url: location, manual: false }];
  if (nonce && !/[?&]clientSign=/.test(location)) {
    const signed = `${location}${location.includes('?') ? '&' : '?'}clientSign=${encodeURIComponent(await clientSign(nonce, ssecurity))}`;
    attempts.push({ label: 'clientSign', url: signed, manual: true });
  }
  for (const a of attempts) {
    const r = await fetch(a.url, {
      redirect: a.manual ? 'manual' : 'follow',
      headers: { 'User-Agent': STS_AGENT(), 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookie = r.headers.getSetCookie().map((c) => /^serviceToken=([^;]+)/.exec(c)?.[1]).find(Boolean);
    trail?.push(`sts ${host} (${a.label}): HTTP ${r.status}, token ${cookie ? 'yes' : 'no'}`);
    if (cookie) return cookie;
  }
  throw new Error('Could not get a service token from Xiaomi');
}

/** The Mi Fitness session from the QR login (2 subrequests were spent: long-poll + STS). */
export async function healthSession(login: QrLogin, trail?: string[]): Promise<Session> {
  const token = await fetchServiceToken(login.location, login.ssecurity, login.nonce, trail);
  const s = new Session(login.userId, login.ssecurity, token, login.cUserId);
  if (trail) s.trail = trail;
  return s;
}

/**
 * Single sign-on to another service (e.g. Mi Home's "xiaomiio") with the passToken from the
 * QR login, without another scan. Returns null if Xiaomi asks for a fresh login.
 */
export async function ssoSession(login: QrLogin, sid: string, trail?: string[]): Promise<Session | null> {
  if (!login.passToken) {
    trail?.push(`sso ${sid}: no passToken in the QR login`);
    return null;
  }
  const r = await fetch(`https://account.xiaomi.com/pass/serviceLogin?sid=${encodeURIComponent(sid)}&_json=true`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Cookie: `userId=${login.userId}; cUserId=${login.cUserId}; passToken=${login.passToken}`,
    },
  });
  if (!r.ok) {
    trail?.push(`sso ${sid}: HTTP ${r.status}`);
    return null;
  }
  const d = toJson(await r.text());
  if (!d.ssecurity || !d.location) {
    trail?.push(`sso ${sid}: HTTP 200, code ${d.code ?? '?'}, no session${d.desc ? ` (${String(d.desc).slice(0, 60)})` : ''}`);
    return null;
  }
  const ssecurity = String(d.ssecurity);
  const token = await fetchServiceToken(String(d.location), ssecurity, d.nonce == null ? undefined : String(d.nonce), trail);
  const s = new Session(String(d.userId ?? login.userId), ssecurity, token, String(d.cUserId ?? login.cUserId));
  if (trail) s.trail = trail;
  return s;
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

export type HealthVariant = 'mihome' | 'stream';

/** Continuous RC4 stream over the sorted params, signature over sorted keys (huami-token mi_encrypt_params). */
export async function buildStreamParams(path: string, plain: Record<string, string>, ssecurity: string, nonce: string): Promise<[string, string][]> {
  const signed = await signedNonce(ssecurity, nonce);
  const sorted = (o: Record<string, string>): [string, string][] => Object.keys(o).sort().map((k) => [k, o[k]]);
  const withHash = { ...plain, rc4_hash__: await encSignature(path, signed, sorted(plain)) };
  const keys = Object.keys(withHash).sort();
  const stream = rc4(unb64(signed), enc.encode(keys.map((k) => withHash[k as keyof typeof withHash]).join('')));
  const out: Record<string, string> = {};
  let at = 0;
  for (const k of keys) {
    const len = enc.encode(withHash[k as keyof typeof withHash]).length;
    out[k] = b64(stream.subarray(at, at + len));
    at += len;
  }
  const params = sorted(out);
  params.push(['signature', await encSignature(path, signed, params)], ['_nonce', nonce]);
  return params;
}

export async function decryptResponse(ssecurity: string, nonce: string, body: string): Promise<string> {
  const key = unb64(await signedNonce(ssecurity, nonce));
  return new TextDecoder().decode(rc4(key, unb64(body)));
}

// ---------------------------------------------------------- cloud API ---

export class Session {
  private readonly agent = `${randomChars(18, 97, 122)}-${randomChars(13, 65, 69)} APP/com.xiaomi.mihome APPV/10.5.201`;
  subrequests = 0;

  /** Step-by-step outcome (hosts, HTTP status, Xiaomi codes; never tokens or bodies), shown in the page's log. */
  trail?: string[];

  constructor(
    readonly userId: string,
    private readonly ssecurity: string,
    private readonly serviceToken: string,
    private readonly cUserId = '',
  ) {}

  /**
   * Mi Fitness API call, e.g. path /app/v1/source/get_source_list on hlth.io.mi.com.
   * - 'mihome': Mi Home-style encryption, params in the query (ha_miband).
   * - 'stream': one RC4 stream over the sorted params, form body (huami-token, AstroBox).
   * Returns null on an HTTP error or an undecryptable body.
   */
  async callHealth(host: string, path: string, data: unknown, variant: HealthVariant): Promise<Record<string, unknown> | null> {
    const nonce = makeNonce();
    const json = JSON.stringify(data);
    const params =
      variant === 'mihome' ? await buildEncryptedParams(path, json, this.ssecurity, nonce) : await buildStreamParams(path, { data: json }, this.ssecurity, nonce);
    const query = new URLSearchParams(params);
    const cookies =
      variant === 'mihome'
        ? [`userId=${this.userId}`, `cUserId=${this.cUserId}`, `yetAnotherServiceToken=${this.serviceToken}`, `serviceToken=${this.serviceToken}`, 'locale=en_GB', 'channel=MI_APP_STORE']
        : [`cUserId=${this.cUserId}`, `serviceToken=${this.serviceToken}`, 'locale=en_us'];
    this.subrequests++;
    const r = await fetch(variant === 'mihome' ? `https://${host}${path}?${query}` : `https://${host}${path}`, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': variant === 'mihome' ? this.agent : 'Android-12-9.8.348i-google-Pixel 4',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(variant === 'mihome' ? { 'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4' } : { region_tag: 'ru' }),
        Cookie: cookies.join('; '),
      },
      body: variant === 'mihome' ? undefined : query.toString(),
    });
    const tag = `${host} ${variant}`;
    if (!r.ok) {
      this.trail?.push(`${tag}: HTTP ${r.status}`);
      return null;
    }
    try {
      const res = JSON.parse(await decryptResponse(this.ssecurity, nonce, (await r.text()).trim().replace(/^"|"$/g, '')));
      this.trail?.push(`${tag}: HTTP 200, code ${res?.code ?? '?'}${res?.code !== 0 && res?.message ? ` (${String(res.message).slice(0, 60)})` : ''}`);
      return res;
    } catch {
      this.trail?.push(`${tag}: HTTP 200, reply not decryptable`);
      return null;
    }
  }

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
        const item: CloudDevice = { server, source: 'mihome', name: String(dev.name ?? ''), model: String(dev.model ?? ''), did, mac: dev.mac };
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

// ---------------------------------------------------------- Mi Fitness ---

export const HEALTH_PATH = '/app/v1/source/get_source_list';
/** Regions tried for Mi Fitness when the user leaves the region on auto-detect, most likely first. */
const AUTO_REGIONS = ['sg', 'de', 'us', 'i2', 'ru', 'in'];
/** Regional Mi Fitness hosts (ha_miband); the base host is tried first (huami-token). */
export const healthHost = (server?: string): string =>
  !server || server === 'cn' || !(SERVERS as readonly string[]).includes(server) ? 'hlth.io.mi.com' : `${server}.hlth.io.mi.com`;

/** Fields that have been seen holding the band's 16-byte auth key, most trusted first. */
const KEY_FIELDS = ['encrypt_key', 'encryptKey', 'auth_key', 'authKey', 'token'] as const;

/** Turns a get_source_list response into one row per distinct 32-hex key candidate. */
export function parseSourceList(res: Json | null, server: string): CloudDevice[] {
  const out: CloudDevice[] = [];
  for (const src of res?.result?.list ?? []) {
    let detail: Json = src?.detail ?? {};
    if (typeof detail === 'string') {
      try {
        detail = JSON.parse(detail);
      } catch {
        detail = {};
      }
    }
    const base = {
      server,
      source: 'mifitness' as const,
      name: String(src?.name ?? '').trim(),
      model: String(src?.model ?? ''),
      did: String(src?.identifier ?? src?.did ?? ''),
      mac: typeof detail.mac === 'string' ? detail.mac : typeof src?.mac === 'string' ? src.mac : undefined,
    };
    const seen = new Set<string>();
    for (const field of KEY_FIELDS) {
      const raw = detail[field];
      if (typeof raw !== 'string') continue;
      const key = raw.trim().toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{32}$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...base, key, keyField: field });
    }
    if (!seen.size) out.push(base);
  }
  return out;
}

export interface FitnessResult {
  /** true once Xiaomi answered with code 0 on some host. */
  ok: boolean;
  devices: CloudDevice[];
}

/** Lists the account's Mi Fitness devices (bands, watches) with their auth keys. */
export async function listFitnessDevices(s: Session, server: string | undefined, budget: number): Promise<FitnessResult> {
  // Auto-detect: the base host first, then the regional ones (a Vietnamese account answered with an
  // empty list on the base host; its data is in the "sg" region).
  const hosts = [...new Set([healthHost(), ...(server ? [server] : AUTO_REGIONS).map((r) => healthHost(r))])];
  let variants: HealthVariant[] = ['mihome', 'stream'];
  let ok = false;
  for (const host of hosts) {
    for (const variant of variants) {
      if (s.subrequests + 1 > budget) return { ok, devices: [] };
      const res = (await s.callHealth(host, HEALTH_PATH, { page_size: 50, status: 1 }, variant)) as Json | null;
      if (res?.code !== 0) continue;
      ok = true;
      variants = [variant]; // the encoding Xiaomi accepted; other hosts get only this one
      const devices = parseSourceList(res, host);
      if (devices.length) return { ok, devices };
      break; // this host answered; an empty list will not change with the other variant
    }
  }
  return { ok, devices: [] };
}
