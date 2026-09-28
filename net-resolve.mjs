// A worker's name resolution for the head and its git hosts, without depending on DNS (worker.mjs). Some home routers and
// ISPs fail to resolve wildcard-DNS names like the head's https://129-154-229-134.sslip.io, and the Mac then drops off
// the cluster. So every connection the worker makes (the WebSocket, HTTPS requests, git's curl) goes through a lookup that
// asks the system DNS first (RESOLVE_TIMEOUT_MS) and, when that fails, falls back to the IP embedded in an
// a-b-c-d.sslip.io / nip.io name, the head's pinned `headIp` (config.json, saved from the connection's remote address),
// or the last good address (cacheFile). Only the address changes: the hostname stays the TLS SNI name and the Host header,
// so the certificate still validates. Only node built-ins.
//   createResolver({pins, lookup, timeoutMs, cacheFile, log, onDnsError}) → {resolve(host), lookup, cached(host)}
//   embeddedIp(host)                 '129-154-229-134.sslip.io' → '129.154.229.134', or null
//   netFetch(url, {method, headers, body, signal, lookup, ...tls})  a small fetch over http(s).request with that lookup
//   pinGitRemote({git, dir, repo, resolver})   http.curloptResolve=<host>:<port>:<ip> in a repo's local config (git ≥ 2.37)
//   reconnectDelay(attempt)          exponential backoff with jitter, capped at 15 s
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const RESOLVE_TIMEOUT_MS = 3000;
export const RECONNECT_MAX_MS = 15_000;
export const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT']);
export const isDnsError = (e) => DNS_CODES.has(e?.code);

// The IPv4 address an sslip.io / nip.io name carries, dashed or dotted, with or without a label before it
// ('1-2-3-4.sslip.io', 'www.1.2.3.4.nip.io', 'app-1-2-3-4.sslip.io').
const EMBED_RE = /(?:^|[.-])((?:\d{1,3}[.-]){3}\d{1,3})\.(?:sslip|nip)\.io\.?$/i;
export function embeddedIp(host) {
  const m = EMBED_RE.exec(String(host || ''));
  const ip = m?.[1].replace(/-/g, '.');
  return ip && net.isIPv4(ip) ? ip : null;
}
// '::ffff:1.2.3.4' (an IPv4 peer on a dual-stack socket) → '1.2.3.4'.
export const plainAddress = (a) => (typeof a === 'string' ? a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') : null);

// pins: {host: ip} or host → ip (the head's headIp). lookup: dns.lookup's signature (tests pass a failing one).
// onDnsError(host, error, fallback): every failed system lookup, and the address used instead (null: none).
export function createResolver({ pins = {}, lookup = dns.lookup, timeoutMs = RESOLVE_TIMEOUT_MS, cacheFile = null, log = () => {}, onDnsError = () => {} } = {}) {
  const pin = (host) => (typeof pins === 'function' ? pins(host) : pins[host]) || null;
  let cache = {};
  if (cacheFile) { try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch {} }
  const falling = new Set(); // hosts served from a fallback now (logged once per outage)
  function remember(host, address) {
    if (cache[host]?.address === address) return;
    cache[host] = { address, at: Date.now() };
    if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 }); } catch {} }
  }
  function systemLookup(host, family) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error(`DNS lookup of ${host} timed out after ${timeoutMs} ms`), { code: 'ETIMEOUT', hostname: host })), timeoutMs);
      t.unref?.();
      lookup(host, { family: family || 0, all: true }, (e, list) => {
        clearTimeout(t);
        if (e) reject(e);
        else if (!list?.length) reject(Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND', hostname: host }));
        else resolve(list);
      });
    });
  }
  // [{address, family}], the system's answer when it has one; else the one fallback address; else the DNS error.
  async function resolve(host, family = 0) {
    const literal = net.isIP(host);
    if (literal) return [{ address: host, family: literal }];
    try {
      const list = await systemLookup(host, family);
      remember(host, list[0].address);
      if (falling.delete(host)) log(`DNS resolves ${host} again`);
      return list;
    } catch (e) {
      const address = embeddedIp(host) || pin(host) || cache[host]?.address || null;
      onDnsError(host, e, address);
      if (!address) throw e;
      if (!falling.has(host)) { falling.add(host); log(`DNS lookup of ${host} failed (${e.code || e.message}): using ${address}`, 'warn'); }
      return [{ address, family: net.isIP(address) || 4 }];
    }
  }
  // For net/tls/http(s).request and ws: (hostname, options, callback), with options.all for happy eyeballs.
  function lookupFn(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; } else if (typeof options === 'number') options = { family: options };
    resolve(hostname, options?.family).then((list) => (options?.all ? cb(null, list) : cb(null, list[0].address, list[0].family)), (e) => cb(e));
  }
  return { resolve, lookup: lookupFn, cached: (host) => cache[host]?.address || null };
}

// A fetch-like request with a custom lookup (the built-in fetch takes none): {ok, status, headers, remoteAddress, body
// (the response stream), text(), json()}. extra: TLS options (ca, servername…).
export function netFetch(url, { method = 'GET', headers = {}, body, signal, lookup, ...extra } = {}) {
  const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
  const h = body != null ? { 'content-length': Buffer.byteLength(body), ...headers } : headers;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: h, lookup, signal, agent: false, ...extra }, (res) => {
      const text = async () => { let s = ''; res.setEncoding('utf8'); for await (const c of res) s += c; return s; };
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, remoteAddress: plainAddress(res.socket?.remoteAddress),
        body: res, text, json: async () => JSON.parse(await text()) });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// git reads http.curloptResolve from 2.37 on: 'git version 2.39.5 (Apple Git-154)' → true.
export function gitResolves(versionText) {
  const m = /(\d+)\.(\d+)/.exec(versionText || '');
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 37));
}
// 'https://github.com/o/r.git' + '140.82.112.3' → 'github.com:443:140.82.112.3'; null for ssh/file remotes and IP hosts.
export function curlResolveEntry(repo, address) {
  let u;
  try { u = new URL(repo); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !address || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return null;
  return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}:${net.isIPv6(address) ? `[${address}]` : address}`;
}
// The entry for a remote now (resolver: system DNS, else a fallback), or null when it has no host to pin or none resolves.
export async function resolveEntry(repo, resolver) {
  let host;
  try { host = new URL(repo).hostname; } catch { return null; }
  if (!curlResolveEntry(repo, '0.0.0.0')) return null;
  const list = await resolver.resolve(host).catch(() => null);
  return list ? curlResolveEntry(repo, list[0].address) : null;
}
// Pins a repo's remote host in its LOCAL config so git's curl never asks DNS for it. git(cwd, args) runs git. A remote
// that doesn't resolve keeps its last pin. Returns the entry set, or null.
export async function pinGitRemote({ git, dir, repo, resolver }) {
  const entry = await resolveEntry(repo, resolver);
  if (entry) await git(dir, ['config', '--local', '--replace-all', 'http.curloptResolve', entry]);
  return entry;
}

// Reconnect delay: 1 s doubling per attempt up to `max`, each drawn from [base/2, base] so a fleet doesn't retry in step.
export function reconnectDelay(attempt, max = RECONNECT_MAX_MS, rand = Math.random) {
  const base = Math.min(max, 1000 * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(base * (0.5 + 0.5 * rand()));
}
