/**
 * CraftStatus — Zero-Dependency Minecraft Status API  v3.8.1
 * ------------------------------------------------------------------
 * Changelog v3.8.1:
 *  - FIX: Light theme complete overhaul (all components)
 *  - FIX: Sparkline cleaner (auto-downsample to 40pts, thicker lines)
 *  - FIX: LIVE countdown stable (prevents overlapping refreshes)
 *  - FIX: Progress bar visible in both themes
 *  - FIX: Sample players readable in light theme
 *  - FIX: Software hides when equals version
 *  - FIX: Unique SVG gradient IDs (BOTH mode safe)
 *  - IMPROVED: Theme toggle smaller + rotate on hover
 *  - KEPT: v3.8.0 (advanced sparkline, custom interval)
 */

"use strict";

const http  = require("http");
const net   = require("net");
const dgram = require("dgram");
const dns   = require("dns").promises;

// =====================================================================
// Version + Config
// =====================================================================
const VERSION = "3.8.1";

const PORT         = Number.isFinite(Number(process.env.PORT)) ? Number(process.env.PORT) : 3000;
const BIND         = process.env.BIND || "0.0.0.0";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const TRUST_PROXY  = process.env.TRUST_PROXY === "1";
const CACHE_TTL    = Math.max(0, Number(process.env.CACHE_TTL) || 15000);
const CACHE_MAX    = 500;
const SRV_TTL      = 5 * 60 * 1000;
const SRV_CACHE_MAX = 500;

const DEFAULT_TIMEOUT      = 5000;
const MIN_TIMEOUT          = 1000;
const MAX_TIMEOUT          = 10000;
const DEFAULT_JAVA_PORT    = 25565;
const DEFAULT_BEDROCK_PORT = 19132;

const RATE_WINDOW      = 60 * 1000;
const RATE_MAX         = 120;
const RATE_MAX_BUCKETS = 10000;

const FAVICON_MAX_BYTES = 256 * 1024;
const SAMPLE_MAX        = 20;
const BATCH_MAX_HOSTS   = 10;

const DNS_TIMEOUT_MS      = 4000;
const JAVA_RECV_BUF_MAX   = 1024 * 1024;
const POST_BODY_MAX_BYTES = 8 * 1024;

const EDITIONS = ["java", "bedrock", "auto", "both"];

// =====================================================================
// Metrics
// =====================================================================
const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  statusRequests: 0,
  batchRequests: 0,
  dnsRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rateLimited: 0,
  errors: 0,
  byEdition: { java: 0, bedrock: 0, auto: 0, both: 0 }
};

// =====================================================================
// Utility
// =====================================================================
function withTimeout(promise, ms, code) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error(code || "TIMEOUT");
      err.code = code || "TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

function safeResolveSrv(name) {
  return withTimeout(dns.resolveSrv(name), DNS_TIMEOUT_MS, "DNS_TIMEOUT");
}
function safeResolve4(name) {
  return withTimeout(dns.resolve4(name), DNS_TIMEOUT_MS, "DNS_TIMEOUT");
}
function safeResolve6(name) {
  return withTimeout(dns.resolve6(name), DNS_TIMEOUT_MS, "DNS_TIMEOUT");
}
function safeLookup(name) {
  return withTimeout(
    dns.lookup(name, { all: true, order: "ipv4first" }),
    DNS_TIMEOUT_MS, "DNS_TIMEOUT"
  );
}

// =====================================================================
// Java protocol helpers
// =====================================================================
function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while (true) {
    if ((v & 0xffffff80) === 0) { bytes.push(v); break; }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

function encodeString(str) {
  const data = Buffer.from(str, "utf8");
  return Buffer.concat([encodeVarInt(data.length), data]);
}

function createPacket(packetId, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([encodeVarInt(packetId), payload]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0, result = 0, byte;
  do {
    if (offset + numRead >= buffer.length) return null;
    byte = buffer[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5 || result > 0x0FFFFFFF) return null;
  } while ((byte & 0x80) !== 0);
  return { value: result >>> 0, size: numRead };
}

function parsePacket(buffer) {
  const lenInfo = readVarInt(buffer, 0);
  if (!lenInfo) return null;
  const start = lenInfo.size;
  if (buffer.length < start + lenInfo.value) return null;
  const body = buffer.subarray(start, start + lenInfo.value);
  const idInfo = readVarInt(body, 0);
  if (!idInfo) return null;
  return {
    packetId: idInfo.value,
    payload: body.subarray(idInfo.size),
    totalSize: start + lenInfo.value
  };
}

// =====================================================================
// MOTD helpers
// =====================================================================
function stripColorCodes(text) {
  if (typeof text !== "string") return "";
  let clean = text;
  clean = clean.replace(/&x(?:&[0-9a-fA-F]){6}/gi, "");
  clean = clean.replace(/\u00A7x(?:\u00A7[0-9a-fA-F]){6}/g, "");
  clean = clean.replace(/\u00A7#[0-9a-fA-F]{6}/g, "");
  clean = clean.replace(/&[0-9a-fk-orA-FK-OR]/g, "");
  clean = clean.replace(/\u00A7[0-9a-fk-orA-FK-OR]/g, "");
  clean = clean.replace(/%gradient(?:#[0-9a-fA-F]{6})?(?:#[0-9a-fA-F]{6})?%/g, "");
  return clean.trim();
}

const MC_COLOR_MAP = {
  black: "0", dark_blue: "1", dark_green: "2", dark_aqua: "3",
  dark_red: "4", dark_purple: "5", gold: "6", gray: "7",
  dark_gray: "8", blue: "9", green: "a", aqua: "b",
  red: "c", light_purple: "d", yellow: "e", white: "f"
};

const EMPTY_STYLE = Object.freeze({
  color: null, bold: false, italic: false,
  underline: false, strike: false, obf: false
});

function makeChildStyle(parent, component) {
  const s = {
    color: parent ? parent.color : null,
    bold:  parent ? parent.bold  : false,
    italic: parent ? parent.italic : false,
    underline: parent ? parent.underline : false,
    strike: parent ? parent.strike : false,
    obf:   parent ? parent.obf   : false
  };
  if (!component || typeof component !== "object") return s;
  if (typeof component.color === "string") {
    const c = component.color.toLowerCase();
    if (c === "reset") {
      s.color = null;
      s.bold = s.italic = s.underline = s.strike = s.obf = false;
    } else if (MC_COLOR_MAP[c]) {
      s.color = MC_COLOR_MAP[c];
    } else if (/^#[0-9a-fA-F]{6}$/.test(component.color)) {
      s.color = component.color;
    }
  }
  if (typeof component.bold          === "boolean") s.bold = component.bold;
  if (typeof component.italic        === "boolean") s.italic = component.italic;
  if (typeof component.underlined    === "boolean") s.underline = component.underlined;
  if (typeof component.strikethrough === "boolean") s.strike = component.strikethrough;
  if (typeof component.obfuscated    === "boolean") s.obf = component.obfuscated;
  return s;
}

function styleToCodes(style) {
  if (!style) return "";
  let codes = "";
  if (style.color)   codes += "\u00A7" + style.color;
  if (style.bold)    codes += "\u00A7l";
  if (style.italic)  codes += "\u00A7o";
  if (style.underline) codes += "\u00A7n";
  if (style.strike)  codes += "\u00A7m";
  if (style.obf)     codes += "\u00A7k";
  return codes;
}

function extractText(value, parentStyle) {
  if (value == null) return "";
  if (typeof value === "string") return styleToCodes(parentStyle) + value;
  if (Array.isArray(value)) return value.map(v => extractText(v, parentStyle)).join("");
  if (typeof value !== "object") return "";

  const style = makeChildStyle(parentStyle || EMPTY_STYLE, value);
  const codes = styleToCodes(style);
  let out = "";

  if (typeof value.text === "string") {
    out += codes + value.text;
  } else if (typeof value.translate === "string") {
    const t = value.fallback || value.translate;
    out += codes + t;
    if (Array.isArray(value.with) && value.with.length) {
      out += " " + value.with.map(w => extractText(w, style)).join(" ");
    }
  }
  if (value.extra) out += extractText(value.extra, style);
  return out;
}

// =====================================================================
// SRV lookup with bounded cache
// =====================================================================
const srvCache = new Map();

function evictOldest(map, max) {
  while (map.size >= max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

async function resolveMinecraftSRV(host) {
  if (net.isIP(host)) return null;
  if (!host.includes(".")) return null;
  try {
    const records = await safeResolveSrv("_minecraft._tcp." + host);
    if (!records || !records.length) return null;
    records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
    const best = records[0];
    if (!best.name || best.name === "." || !best.port) return null;
    return {
      target: best.name.replace(/\.$/, ""),
      port: best.port,
      priority: best.priority,
      weight: best.weight
    };
  } catch (_) { return null; }
}

async function resolveMinecraftSRVCached(host) {
  const key = host.toLowerCase();
  const e = srvCache.get(key);
  if (e && Date.now() < e.expiresAt) {
    srvCache.delete(key);
    srvCache.set(key, e);
    return e.value;
  }
  const val = await resolveMinecraftSRV(host);
  if (srvCache.size >= SRV_CACHE_MAX) evictOldest(srvCache, SRV_CACHE_MAX);
  srvCache.set(key, { value: val, expiresAt: Date.now() + SRV_TTL });
  return val;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of srvCache) if (v.expiresAt <= now) srvCache.delete(k);
}, 5 * 60 * 1000).unref();

// =====================================================================
// Pinned DNS lookup
// =====================================================================
function createPinnedLookup(addresses) {
  const list = addresses.map(a => ({
    address: a.address,
    family: a.family || (net.isIPv6(a.address) ? 6 : 4)
  }));
  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    options = options || {};
    const wantFamily = options.family;
    let candidates = list;
    if (wantFamily === 4 || wantFamily === 6) {
      const filtered = list.filter(a => a.family === wantFamily);
      if (filtered.length) candidates = filtered;
    }
    if (!candidates.length) {
      const err = new Error("No validated address available");
      err.code = "ENOTFOUND";
      return callback(err);
    }
    if (options.all) {
      return callback(null, candidates.map(a => ({ address: a.address, family: a.family })));
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

// =====================================================================
// Java Server List Ping
// =====================================================================
function pingJava(host, port, timeout, handshakeHost, lookup) {
  const hsHost = handshakeHost || host;

  return new Promise((resolve) => {
    let socket;
    try {
      const opts = { host, port };
      if (typeof lookup === "function") opts.lookup = lookup;
      socket = net.createConnection(opts);
    } catch (_) {
      return resolve({ success: false, error: "REQUEST_FAILED" });
    }
    socket.setNoDelay(true);
    socket.setTimeout(timeout);

    let finished   = false;
    let recvBuf    = Buffer.alloc(0);
    let phase      = "waiting-status";
    let statusObj  = null;
    let pingSentAt = 0;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      try { socket.setTimeout(0); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    socket.on("connect", () => {
      try {
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port, 0);
        const handshakePayload = Buffer.concat([
          encodeVarInt(-1),
          encodeString(hsHost),
          portBuf,
          encodeVarInt(1)
        ]);
        socket.write(createPacket(0x00, handshakePayload));
        socket.write(createPacket(0x00));
      } catch (_) {
        finish({ success: false, error: "REQUEST_FAILED" });
      }
    });

    socket.on("data", (chunk) => {
      recvBuf = recvBuf.length ? Buffer.concat([recvBuf, chunk]) : chunk;
      if (recvBuf.length > JAVA_RECV_BUF_MAX) {
        return finish({ success: false, error: "RESPONSE_TOO_LARGE" });
      }
      while (true) {
        const pkt = parsePacket(recvBuf);
        if (!pkt) break;
        recvBuf = recvBuf.subarray(pkt.totalSize);

        if (pkt.packetId === 0x00 && phase === "waiting-status") {
          try {
            const lenInfo = readVarInt(pkt.payload, 0);
            if (!lenInfo) return finish({ success: false, error: "BAD_STATUS" });
            const jsonStr = pkt.payload
              .subarray(lenInfo.size, lenInfo.size + lenInfo.value)
              .toString("utf8");
            statusObj = JSON.parse(jsonStr);
          } catch (_) {
            return finish({ success: false, error: "INVALID_JSON" });
          }
          pingSentAt = Date.now();
          const ts = Buffer.alloc(8);
          ts.writeBigInt64BE(BigInt(pingSentAt), 0);
          socket.write(createPacket(0x01, ts));
          phase = "waiting-pong";
        } else if (pkt.packetId === 0x01 && phase === "waiting-pong") {
          return finish({ success: true, data: statusObj, ping: Date.now() - pingSentAt });
        }
      }
    });

    socket.on("timeout", () => finish({ success: false, error: "TIMEOUT" }));
    socket.on("error",   () => finish({ success: false, error: "CONNECTION_FAILED" }));
    socket.on("close",   () => finish({ success: false, error: "CONNECTION_CLOSED" }));
  });
}

// =====================================================================
// Bedrock RakNet
// =====================================================================
const RAKNET_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

function pingBedrock(pinnedIp, port, timeout) {
  return new Promise((resolve) => {
    const family = net.isIPv6(pinnedIp) ? "udp6" : "udp4";
    let socket;
    try { socket = dgram.createSocket(family); }
    catch (_) { return resolve({ success: false, error: "SOCKET_ERROR" }); }

    const startedAt = Date.now();
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ success: false, error: "TIMEOUT" }),
      timeout
    );

    socket.on("error", () => finish({ success: false, error: "SOCKET_ERROR" }));

    socket.on("message", (msg) => {
      if (msg.length < 35) return;
      if (msg.readUInt8(0) !== 0x1c) return;
      try {
        const strlen = msg.readUInt16BE(33);
        if (35 + strlen > msg.length) return;
        const info = msg.subarray(35, 35 + strlen).toString("utf8");
        const parts = info.split(";");
        finish({
          success: true,
          ping: Date.now() - startedAt,
          data: {
            motd:       parts[1] || "",
            protocol:   parseInt(parts[2], 10) || null,
            version:    parts[3] || null,
            online:     parseInt(parts[4], 10) || 0,
            max:        parseInt(parts[5], 10) || 0,
            serverGUID: parts[6] || null,
            motd2:      parts[7] || "",
            gameMode:   parts[8] || null
          }
        });
      } catch (_) {
        finish({ success: false, error: "PARSE_ERROR" });
      }
    });

    const buf = Buffer.alloc(1 + 8 + 16 + 8);
    buf.writeUInt8(0x01, 0);
    buf.writeBigInt64BE(BigInt(Date.now()), 1);
    RAKNET_MAGIC.copy(buf, 9);
    const guid = BigInt.asIntN(
      64,
      (BigInt(Date.now()) << 32n) ^ BigInt(Math.floor(Math.random() * 0xffffffff))
    );
    buf.writeBigInt64BE(guid, 25);

    try {
      socket.connect(port, pinnedIp, () => {
        socket.send(buf, (err) => {
          if (err) finish({ success: false, error: "SEND_FAILED" });
        });
      });
    } catch (_) {
      finish({ success: false, error: "SEND_FAILED" });
    }
  });
}

// =====================================================================
// Cache
// =====================================================================
const cache = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
  cache.delete(key);
  cache.set(key, e);
  return e.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) evictOldest(cache, CACHE_MAX);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
}

// =====================================================================
// Validation + SSRF guard
// =====================================================================
const BLOCKED_IPV4_PATTERNS = [
  /^0\./, /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./, /^192\.0\.2\./, /^192\.168\./,
  /^198\.(1[89]|51)\./, /^203\.0\.113\./,
  /^22[4-9]\./, /^23\d\./, /^24\d\./, /^25[0-5]\./
];

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /\.local$/i, /\.internal$/i, /\.home$/i, /\.lan$/i
];

const BLOCKED_IPV6_PATTERNS = [
  /^::$/, /^::1$/, /^fe80:/i, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i,
  /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i, /^::ffff:0:/i
];

function isPrivateIPv4(ip) { return BLOCKED_IPV4_PATTERNS.some(rx => rx.test(ip)); }
function isPrivateIPv6(ip) {
  const lower = String(ip).toLowerCase();
  if (BLOCKED_IPV6_PATTERNS.some(rx => rx.test(lower))) return true;
  // fe80::/10 (fe80–febf) link-local
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  // IPv4-mapped in dotted form: ::ffff:a.b.c.d
  let m = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(lower);
  if (m) return isPrivateIPv4(m[1]);
  // IPv4-mapped in hex form: ::ffff:7f00:1
  m = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return false;
}

function isPrivateHost(host) {
  if (!host) return true;
  const lower = String(host).toLowerCase().trim();
  if (BLOCKED_HOST_PATTERNS.some(rx => rx.test(lower))) return true;
  if (net.isIPv4(lower)) return isPrivateIPv4(lower);
  if (net.isIPv6(lower)) return isPrivateIPv6(lower);
  return false;
}

async function resolveAndValidate(host) {
  if (isPrivateHost(host)) return { ok: false, code: "PRIVATE_ADDRESS" };
  if (net.isIP(host)) {
    const isV6 = net.isIPv6(host);
    return { ok: true, addresses: [{ address: host, family: isV6 ? 6 : 4 }] };
  }
  const srv = await resolveMinecraftSRVCached(host);
  const target = (srv && srv.target) ? srv.target : host;

  let addrs = [];
  try { addrs = await safeLookup(target); } catch (_) {}
  if (!addrs.length && target !== host) {
    try { addrs = await safeLookup(host); } catch (_) {}
  }
  if (!addrs.length) return { ok: false, code: "DNS_LOOKUP_FAILED" };

  for (const a of addrs) {
    if (net.isIPv4(a.address) && isPrivateIPv4(a.address)) return { ok: false, code: "PRIVATE_ADDRESS" };
    if (net.isIPv6(a.address) && isPrivateIPv6(a.address)) return { ok: false, code: "PRIVATE_ADDRESS" };
  }
  addrs.sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));
  return { ok: true, addresses: addrs };
}

function validateHost(host) {
  if (!host || typeof host !== "string") return { ok: false, error: "host is required" };
  const h = host.trim();
  if (h.length < 1 || h.length > 253) return { ok: false, error: "host length invalid" };
  if (/[\s<>"'`;|&$\\]/.test(h)) return { ok: false, error: "host contains illegal characters" };
  return { ok: true, value: h };
}

function validatePort(port) {
  if (port === undefined || port === null || port === "") return { ok: true, value: null };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return { ok: false, error: "port must be an integer between 1 and 65535" };
  }
  return { ok: true, value: p };
}

function clampTimeout(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.min(Math.max(Math.floor(n), MIN_TIMEOUT), MAX_TIMEOUT);
}

// =====================================================================
// Rate limiter
// =====================================================================
const buckets = new Map();

function pruneBuckets() {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}

setInterval(pruneBuckets, 60 * 1000).unref();

function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  if (buckets.size >= RATE_MAX_BUCKETS) pruneBuckets();
  if (buckets.size >= RATE_MAX_BUCKETS) {
    const first = buckets.keys().next().value;
    if (first !== undefined) buckets.delete(first);
  }
  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW };
    buckets.set(ip, b);
  }
  b.count++;
  if (b.count > RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

// =====================================================================
// Software detection
// =====================================================================
function detectSoftware(versionName) {
  if (!versionName) return null;
  const v = String(versionName).toLowerCase();
  if (v.includes("paper"))    return "Paper";
  if (v.includes("purpur"))   return "Purpur";
  if (v.includes("spigot"))   return "Spigot";
  if (v.includes("bukkit"))   return "Bukkit";
  if (v.includes("forge"))    return "Forge";
  if (v.includes("fabric"))   return "Fabric";
  if (v.includes("velocity")) return "Velocity";
  if (v.includes("bungee"))   return "BungeeCord";
  if (v.includes("vanilla"))  return "Vanilla";
  return null;
}

// =====================================================================
// Result builders
// =====================================================================
const FAVICON_PREFIX_REGEX = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]/;

function sanitizeFavicon(fav) {
  if (typeof fav !== "string") return null;
  if (fav.length === 0 || fav.length > FAVICON_MAX_BYTES) return null;
  if (!FAVICON_PREFIX_REGEX.test(fav)) return null;
  return fav;
}

function sanitizeSample(sample) {
  if (!Array.isArray(sample)) return null;
  if (!sample.length) return null;
  return sample.slice(0, SAMPLE_MAX).map(p => {
    const rawName = (p && p.name != null) ? p.name : "";
    const name = (typeof rawName === "string") ? rawName : extractText(rawName);
    return {
      name: String(name).slice(0, 512),
      id:   String((p && p.id) || "").slice(0, 64)
    };
  });
}

function buildJavaResult(host, port, r, checkedAt, srvInfo) {
  if (!r.success) return buildOfflineResult(host, port, "java", r.error, checkedAt);
  const d = r.data || {};
  const motdRaw = typeof d.description === "string" ? d.description : extractText(d.description);
  const versionName = d.version ? d.version.name : null;

  return {
    success: true,
    online: true,
    edition: "java",
    host,
    port: srvInfo ? srvInfo.port : port,
    queried_host: host,
    queried_port: port,
    srv: srvInfo ? {
      target: srvInfo.target,
      port: srvInfo.port,
      priority: srvInfo.priority,
      weight: srvInfo.weight
    } : null,
    version: d.version
      ? { name: versionName || null, protocol: d.version.protocol ?? null }
      : null,
    software: detectSoftware(versionName),
    motd: stripColorCodes(motdRaw),
    motd_raw: motdRaw,
    players: {
      online: Number(d.players?.online || 0),
      max:    Number(d.players?.max    || 0),
      sample: sanitizeSample(d.players?.sample)
    },
    ping: r.ping,
    latency: r.ping,
    favicon: sanitizeFavicon(d.favicon),
    checked_at: checkedAt
  };
}

function buildBedrockResult(host, port, r, checkedAt) {
  if (!r.success) return buildOfflineResult(host, port, "bedrock", r.error, checkedAt);
  const d = r.data;
  const line1 = d.motd || "";
  const line2 = d.motd2 || "";
  const motdRaw = line2 ? (line1 + "\n" + line2) : line1;

  return {
    success: true,
    online: true,
    edition: "bedrock",
    host, port,
    version: d.version,
    protocol: d.protocol,
    motd: stripColorCodes(motdRaw),
    motd_raw: motdRaw,
    players: { online: d.online, max: d.max, sample: null },
    gameType: d.gameMode || null,
    serverId: d.serverGUID || null,
    favicon: null,
    ping: r.ping,
    latency: r.ping,
    checked_at: checkedAt
  };
}

function buildOfflineResult(host, port, edition, error, checkedAt) {
  return {
    success: true,
    online: false,
    edition,
    host, port,
    ping: null,
    error,
    checked_at: checkedAt
  };
}

// =====================================================================
// High-level checks
// =====================================================================
async function checkJava(host, port, timeout, opts) {
  const noFallback = !!(opts && opts.noFallback);
  const checkedAt = new Date().toISOString();
  const effectivePort = port || DEFAULT_JAVA_PORT;

  let srvInfo = null;
  let targetHost = host;
  let targetPort = effectivePort;

  if (!port || port === DEFAULT_JAVA_PORT) {
    srvInfo = await resolveMinecraftSRVCached(host);
    if (srvInfo) {
      targetHost = srvInfo.target;
      targetPort = srvInfo.port;
    }
  }

  const v = await resolveAndValidate(targetHost);
  if (!v.ok) {
    return buildOfflineResult(host, effectivePort, "java", v.code, checkedAt);
  }
  const lookup = createPinnedLookup(v.addresses);

  const r = await pingJava(targetHost, targetPort, timeout, host, lookup);

  const shouldFallback =
    !r.success &&
    srvInfo &&
    !noFallback &&
    (r.error === "CONNECTION_FAILED" || r.error === "CONNECTION_CLOSED");

  if (shouldFallback) {
    const v2 = await resolveAndValidate(host);
    if (v2.ok && !isPrivateHost(host)) {
      const lookup2 = createPinnedLookup(v2.addresses);
      const fallback = await pingJava(host, effectivePort, timeout, host, lookup2);
      if (fallback.success) {
        return buildJavaResult(host, effectivePort, fallback, checkedAt, null);
      }
    }
  }

  return buildJavaResult(host, effectivePort, r, checkedAt, srvInfo);
}

async function checkBedrock(host, port, timeout) {
  const checkedAt = new Date().toISOString();
  const effectivePort = port || DEFAULT_BEDROCK_PORT;

  const v = await resolveAndValidate(host);
  if (!v.ok) {
    return buildOfflineResult(host, effectivePort, "bedrock", v.code, checkedAt);
  }
  const pinnedIp = v.addresses[0].address;

  const r = await pingBedrock(pinnedIp, effectivePort, timeout);
  return buildBedrockResult(host, effectivePort, r, checkedAt);
}

async function autoDetect(host, port, timeout, prefer) {
  const preferred = (prefer === "bedrock") ? "bedrock" : "java";
  const secondary = (preferred === "java") ? "bedrock" : "java";

  const runCheck = (ed) => ed === "java"
    ? checkJava(host, port, timeout, { noFallback: true })
    : checkBedrock(host, port, timeout);

  let prefResult, secResult;
  try {
    [prefResult, secResult] = await Promise.all([
      runCheck(preferred),
      runCheck(secondary)
    ]);
  } catch (err) {
    return {
      success: true,
      online: false,
      edition: "auto",
      host,
      port: port || null,
      ping: null,
      error: "CHECK_FAILED",
      attempts: [],
      checked_at: new Date().toISOString()
    };
  }

  const attempts = [
    {
      edition: preferred,
      online:  !!prefResult.online,
      error:   prefResult.online ? null : (prefResult.error || null),
      ping:    prefResult.ping ?? null
    },
    {
      edition: secondary,
      online:  !!secResult.online,
      error:   secResult.online ? null : (secResult.error || null),
      ping:    secResult.ping ?? null
    }
  ];

  if (prefResult.online) {
    prefResult.attempts = attempts;
    return prefResult;
  }
  if (secResult.online) {
    secResult.attempts = attempts;
    return secResult;
  }

  return {
    success: true,
    online: false,
    edition: "auto",
    host,
    port: port || null,
    ping: null,
    error: attempts[0]?.error || "NO_EDITION_ONLINE",
    attempts,
    checked_at: new Date().toISOString()
  };
}

async function checkBoth(host, port, timeout) {
  const [javaRes, bedrockRes] = await Promise.all([
    checkJava(host, port, timeout, { noFallback: true }),
    checkBedrock(host, port, timeout)
  ]);

  return {
    success: true,
    edition: "both",
    host,
    port: port || null,
    online: !!(javaRes.online || bedrockRes.online),
    java: javaRes,
    bedrock: bedrockRes,
    checked_at: new Date().toISOString()
  };
}

// =====================================================================
// HTTP helpers
// =====================================================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  }, corsHeaders(), extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function sendPreflight(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function rejectIfBodyTooLarge(req, res) {
  const len = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(len) && len > POST_BODY_MAX_BYTES) {
    sendJson(res, 413, { success: false, error: "Payload too large" });
    return true;
  }
  return false;
}

// =====================================================================
// Landing page HTML
// =====================================================================
const LANDING_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f0f0f">
<title>CraftStatus — Minecraft Server Status</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=VT323&family=Vazirmatn:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}

/* ============================================================ */
/* === THEME VARIABLES                                       === */
/* ============================================================ */
:root{
  --bg:#0f0f0f;--card:#1a1a1a;--card-2:#242424;--border:#2a2a2a;
  --accent:#4ade80;--accent-2:#4aedd9;--danger:#ef4444;--warn:#fbbf24;
  --text:#e5e5e5;--muted:#8a8a8a;--muted-2:#5a5a5a;
  --motd-bg:#000000;--motd-fg:#ffffff;
  --bar-track:#000000;
  --code-bg:#000000;--code-fg:#4ade80;
  --grid-line:#2a2a2a;
  --pill-bg:#242424;--pill-fg:#e5e5e5;--pill-border:#2a2a2a;
  --inner-bg:#151515;
}
:root[data-theme="light"]{
  --bg:#eef1f5;
  --card:#ffffff;
  --card-2:#f5f7fa;
  --border:#d8dde5;
  --accent:#16a34a;
  --accent-2:#0e7490;
  --danger:#dc2626;
  --warn:#d97706;
  --text:#111827;
  --muted:#5b6573;
  --muted-2:#64748b;
  --motd-bg:#1a1a1a;
  --motd-fg:#f5f5f5;
  --bar-track:#d8dde5;
  --code-bg:#f8fafc;
  --code-fg:#0f766e;
  --grid-line:#94a3b8;
  --pill-bg:#f1f5f9;
  --pill-fg:#0f172a;
  --pill-border:#d8dde5;
  --inner-bg:#f8fafc;
}

html,body{
  height:100%;
  -webkit-text-size-adjust:100%;
  -moz-text-size-adjust:100%;
  text-size-adjust:100%;
}
body{
  font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;
  background:var(--bg);color:var(--text);
  padding:16px 12px 40px;line-height:1.7;
  -webkit-font-smoothing:antialiased;
  transition:background .25s,color .25s;
}
.wrap{max-width:720px;margin:0 auto}
.hd{text-align:center;margin-bottom:20px}
.hd .logo{
  width:64px;height:64px;margin:0 auto 10px;
  background:linear-gradient(135deg,#4ade80,#4aedd9);
  border-radius:14px;display:flex;align-items:center;justify-content:center;
  font-size:32px;box-shadow:0 8px 24px rgba(74,222,128,.25);
}
.hd h1{font-size:22px;font-weight:700;letter-spacing:-.5px}
.hd h1 span{color:var(--accent-2)}
.hd p{color:var(--muted);font-size:12px;margin-top:4px}
.card{
  background:var(--card);border:1px solid var(--border);
  border-radius:12px;padding:16px;margin-bottom:14px;
  transition:background .25s,border-color .25s;
}
.row{display:grid;gap:10px;grid-template-columns:1fr 90px 110px;margin-bottom:12px}
.row .full{grid-column:1/-1}
label{display:block;color:var(--muted);font-size:11px;font-weight:700;margin-bottom:6px}
input,select{
  width:100%;color:var(--text);background:var(--inner-bg);
  border:1px solid var(--border);border-radius:8px;
  padding:11px 12px;font-size:14px;font-family:inherit;
  outline:none;transition:border-color .15s,background .25s;
}
input:focus,select:focus{border-color:var(--accent)}
input[type=text],input[type=number]{direction:ltr;text-align:left;font-family:'VT323',monospace;font-size:18px}
select{cursor:pointer;appearance:none;font-weight:700;font-size:12px;text-align:center;padding-right:12px}
select option{background:var(--card);color:var(--text)}
.btn{
  width:100%;cursor:pointer;font-family:inherit;
  background:var(--accent);color:#0a1a0a;border:0;
  border-radius:10px;padding:14px;font-size:14px;font-weight:700;
  display:flex;align-items:center;justify-content:center;gap:8px;
  transition:.15s;letter-spacing:.5px;
}
:root[data-theme="light"] .btn{color:#ffffff}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.6;cursor:not-allowed}
.btn .spin{
  width:14px;height:14px;border:2px solid rgba(0,0,0,.2);
  border-top-color:#0a1a0a;border-radius:50%;
  animation:sp .8s linear infinite;display:none;
}
:root[data-theme="light"] .btn .spin{
  border-color:rgba(255,255,255,.3);
  border-top-color:#ffffff;
}
.btn.loading .spin{display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
.recent{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.recent:empty{display:none}
.chip{
  background:var(--card-2);border:1px solid var(--border);
  border-radius:6px;padding:6px 10px;font-size:11px;
  color:var(--text);cursor:pointer;font-family:'VT323',monospace;
  direction:ltr;display:inline-flex;align-items:center;gap:6px;
  transition:.15s;
}
.chip:hover{background:var(--inner-bg);border-color:var(--accent)}
.chip .tag{
  background:var(--accent);color:#0a1a0a;font-weight:700;
  font-size:9px;padding:1px 5px;border-radius:3px;font-family:sans-serif;
}
:root[data-theme="light"] .chip .tag{color:#ffffff}
.chip .tag.both{background:linear-gradient(90deg,#4ade80,#4aedd9)}
.chip .det{color:var(--muted);font-size:9px}
.state{text-align:center;padding:32px 12px;color:var(--muted)}
.state .ico{font-size:36px;margin-bottom:10px;opacity:.7}
.state .ttl{font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px}
.state .dsc{font-size:12px}
.skel{padding:8px 0}
.sk{height:14px;background:linear-gradient(90deg,var(--card) 25%,var(--card-2) 50%,var(--card) 75%);
  background-size:200% 100%;animation:sh 1.2s infinite;border-radius:4px;margin:8px 0}
.sk.big{height:60px}
.sk.mid{height:40px;width:60%;margin-left:auto;margin-right:auto}
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
.srv{
  background:var(--card);border:1px solid var(--border);
  border-radius:12px;padding:16px;animation:fade .3s;
  transition:background .25s,border-color .25s;
  position:relative;
}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.head .badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.status-badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 10px;border-radius:20px;font-size:11px;font-weight:700;
}
.status-badge.on{background:rgba(74,222,128,.15);color:var(--accent)}
.status-badge.off{background:rgba(239,68,68,.15);color:var(--danger)}
:root[data-theme="light"] .status-badge.on{background:rgba(22,163,74,.12);color:#15803d}
:root[data-theme="light"] .status-badge.off{background:rgba(220,38,38,.12);color:#b91c1c}
.status-badge .dt{width:6px;height:6px;border-radius:50%;background:currentColor}
.status-badge.on .dt{animation:pulse 1.5s infinite}
@keyframes pulse{50%{opacity:.3}}
.cache-badge{
  background:rgba(74,237,217,.15);color:var(--accent-2);
  font-size:10px;font-weight:700;padding:4px 9px;border-radius:20px;
  direction:ltr;font-family:'VT323',monospace;
}
:root[data-theme="light"] .cache-badge{background:rgba(8,145,178,.12);color:#0e7490}
.ping{
  font-family:'VT323',monospace;font-size:18px;
  padding:4px 10px;border-radius:6px;direction:ltr;
}
.ping.good{background:rgba(74,222,128,.15);color:var(--accent)}
.ping.ok{background:rgba(251,191,36,.15);color:var(--warn)}
.ping.bad{background:rgba(239,68,68,.15);color:var(--danger)}
:root[data-theme="light"] .ping.good{background:rgba(22,163,74,.12);color:#15803d}
:root[data-theme="light"] .ping.ok{background:rgba(217,119,6,.12);color:#b45309}
:root[data-theme="light"] .ping.bad{background:rgba(220,38,38,.12);color:#b91c1c}
.srv-id{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:14px}
.icon{
  width:80px;height:80px;border-radius:10px;
  border:2px solid var(--border);background:var(--inner-bg);
  display:flex;align-items:center;justify-content:center;
  font-size:40px;object-fit:cover;
}
.host-line{
  display:flex;align-items:center;gap:8px;
  background:var(--inner-bg);border:1px solid var(--border);
  border-radius:8px;padding:8px 12px;direction:ltr;
  font-family:'VT323',monospace;font-size:18px;
  max-width:100%;overflow:hidden;
}
.host-line .ed{
  background:#1e3a8a;color:#93c5fd;font-size:9px;
  padding:2px 6px;border-radius:3px;font-family:sans-serif;font-weight:700;
  letter-spacing:.5px;flex-shrink:0;
}
.host-line .ad{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy-ic{
  background:transparent;border:0;color:var(--muted);
  cursor:pointer;padding:2px 4px;font-size:14px;
}
.copy-ic:hover{color:var(--accent)}
.srv-rec{
  font-size:12px;color:#c4b5fd;direction:ltr;
  background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);
  border-radius:6px;padding:5px 10px;font-family:'VT323',monospace;
}
:root[data-theme="light"] .srv-rec{
  background:rgba(124,58,237,.08);
  border-color:rgba(124,58,237,.25);
  color:#6d28d9;
}
.players{
  background:var(--inner-bg);border:1px solid var(--border);
  border-radius:8px;padding:14px;margin-bottom:12px;
}
.players .ttl-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.players .ttl-row .lbl{font-size:12px;color:var(--muted);font-weight:700}
.players .ttl-row .cnt{font-family:'VT323',monospace;font-size:22px;color:var(--accent-2);direction:ltr}
.players .ttl-row .cnt .mx{color:var(--muted)}

/* === Progress bar (FIX v3.8.1) === */
.bar{
  height:8px;
  background:var(--bar-track);
  border-radius:4px;
  overflow:hidden;
  margin-bottom:4px;
  transition:background .25s;
}
.bar-fill{
  height:100%;
  background:linear-gradient(90deg,#4ade80,#4aedd9);
  border-radius:4px;
  transition:width .6s;
}
:root[data-theme="light"] .bar-fill{
  background:linear-gradient(90deg,#16a34a,#0891b2);
}

.smp{margin-top:12px;padding-top:12px;border-top:1px dashed var(--border)}
.smp-ttl{font-size:11px;color:var(--muted);font-weight:700;margin-bottom:8px}
.smp-list{display:flex;flex-wrap:wrap;gap:6px}
.smp-item{
  background:var(--pill-bg);
  color:var(--pill-fg);
  border:1px solid var(--pill-border);
  border-radius:6px;padding:5px 9px;
  font-family:'VT323',monospace;font-size:14px;
  direction:ltr;white-space:nowrap;max-width:100%;
  overflow-x:auto;overflow-y:hidden;line-height:1.5;
  transition:background .25s,color .25s,border-color .25s;
}
.smp-item::-webkit-scrollbar{height:0}

.stats{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
  margin-bottom:12px;
  align-items:start;
}
.st{
  background:var(--inner-bg);border:1px solid var(--border);
  border-radius:8px;padding:12px 14px;
  display:flex;flex-direction:column;justify-content:center;
  gap:4px;min-height:0;min-width:0;
}
.st .lbl{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.3px;line-height:1.4}
.st .val{
  font-size:13px;font-weight:700;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
}
.st .val.mono{font-family:'VT323',monospace;font-size:18px;color:var(--accent-2);direction:ltr;font-weight:400}

/* === MOTD === */
.motd{
  background:var(--motd-bg);color:var(--motd-fg);
  border:1px solid var(--border);
  border-radius:8px;padding:18px 14px;margin-top:12px;
  text-align:center;font-family:'VT323',monospace;
  font-size:17px;line-height:1.8;white-space:pre-wrap;
  word-break:break-word;min-height:50px;
  direction:ltr;unicode-bidi:isolate;letter-spacing:.4px;
  transition:background .25s;
}
.motd > bdi{ display: inline; }
.motd-empty{color:var(--muted-2);font-size:12px;font-style:italic;direction:ltr}
:root[data-theme="light"] .motd-empty{color:#9ca3af}
:root[data-theme="light"] input::placeholder{color:#64748b;opacity:1}
:root[data-theme="light"] .docs-ttl{color:#15803d}
:root[data-theme="light"] .copy-ic:hover{color:#15803d}
:root[data-theme="light"] .hd h1 span{color:#0e7490}

/* ============================================================ */
/* === ADVANCED SPARKLINE (v3.8.1)                           === */
/* ============================================================ */
.spark-wrap{
  margin-top:12px;
  background:var(--inner-bg);
  border:1px solid var(--border);
  border-radius:10px;
  padding:10px 12px 12px;
  direction:ltr;
  transition:border-color .3s, box-shadow .3s, background .25s;
  position:relative;
  overflow:hidden;
}
.spark-wrap.flash{
  animation:spkFlash .8s ease;
}
@keyframes spkFlash{
  0%{ border-color:var(--accent); box-shadow:0 0 0 0 rgba(74,222,128,.5); }
  60%{ border-color:var(--accent); box-shadow:0 0 0 6px rgba(74,222,128,0); }
  100%{ border-color:var(--border); box-shadow:0 0 0 0 rgba(74,222,128,0); }
}
.spark-head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:6px;
  margin-bottom:8px;
}
.spark-title{
  font-size:10px;
  color:var(--muted);
  font-weight:700;
  letter-spacing:.5px;
  display:inline-flex;
  align-items:center;
  gap:6px;
}
.spark-title .count{
  background:var(--card-2);
  color:var(--text);
  padding:1px 6px;
  border-radius:10px;
  font-family:'VT323',monospace;
  font-size:11px;
}
:root[data-theme="light"] .spark-title .count{
  background:#e2e8f0;
  color:#111827;
}
.spark-controls{
  display:inline-flex;
  align-items:center;
  gap:4px;
  flex-wrap:wrap;
}
.spark-btn{
  background:var(--card-2);
  border:1px solid var(--border);
  color:var(--muted);
  border-radius:5px;
  padding:3px 7px;
  font-size:9px;
  font-weight:700;
  cursor:pointer;
  font-family:inherit;
  transition:.15s;
  direction:ltr;
  line-height:1.4;
}
.spark-btn:hover{color:var(--text);border-color:var(--accent)}
.spark-btn.on{
  background:rgba(74,222,128,.18);
  color:var(--accent);
  border-color:var(--accent);
  font-weight:900;
}
:root[data-theme="light"] .spark-btn.on{
  background:rgba(22,163,74,.15);
  color:#15803d;
}
.spark-stats{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  margin-bottom:8px;
  font-family:'VT323',monospace;
  font-size:12px;
}
.spark-stat{
  display:inline-flex;
  align-items:baseline;
  gap:4px;
  padding:2px 8px;
  background:var(--card-2);
  border-radius:12px;
  border:1px solid var(--border);
  transition:background .25s,border-color .25s;
}
:root[data-theme="light"] .spark-stat{
  background:#f1f5f9;
  border-color:#d8dde5;
}
.spark-stat .k{font-size:9px;color:var(--muted);font-family:sans-serif;font-weight:700;text-transform:uppercase}
.spark-stat .v{font-size:13px;color:var(--text)}
:root[data-theme="light"] .spark-stat .v{color:#0f172a}
.spark-stat.good .v{color:var(--accent)}
.spark-stat.warn .v{color:var(--warn)}
.spark-stat.bad  .v{color:var(--danger)}
.spark-stat.avg .v{color:var(--accent-2)}
:root[data-theme="light"] .spark-stat.good .v{color:#15803d}
:root[data-theme="light"] .spark-stat.warn .v{color:#b45309}
:root[data-theme="light"] .spark-stat.bad  .v{color:#b91c1c}
:root[data-theme="light"] .spark-stat.avg .v{color:#0e7490}

/* === Chart area (FIX v3.8.1: taller) === */
.spark-chart{
  position:relative;
  width:100%;
  height:80px;
  margin-top:4px;
}
.spark-chart svg{
  display:block;
  width:100%;
  height:100%;
  overflow:visible;
  max-width:100%;
}
.spark-grid-line{
  stroke:var(--grid-line);
  stroke-dasharray:2 3;
  stroke-width:.7;
  opacity:.55;
}
:root[data-theme="light"] .spark-grid-line{
  opacity:.7;
  stroke-width:.9;
}

/* === Tooltip === */
.spark-tooltip{
  position:absolute;
  pointer-events:none;
  background:var(--card);
  border:1px solid var(--accent);
  border-radius:6px;
  padding:4px 8px;
  font-family:'VT323',monospace;
  font-size:12px;
  color:var(--text);
  white-space:nowrap;
  transform:translate(-50%, -120%);
  opacity:0;
  transition:opacity .12s;
  z-index:5;
  direction:ltr;
  box-shadow:0 4px 12px rgba(0,0,0,.4);
}
:root[data-theme="light"] .spark-tooltip{
  background:#ffffff;
  color:#111827;
  border-color:#16a34a;
  box-shadow:0 6px 16px rgba(0,0,0,.12);
}
.spark-tooltip.on{opacity:1}
.spark-tooltip .t{
  display:block;
  font-size:9px;
  color:var(--muted);
  font-family:sans-serif;
}
.spark-tooltip .v{
  color:var(--accent-2);
  font-size:14px;
}
:root[data-theme="light"] .spark-tooltip .v{color:#0e7490}
:root[data-theme="light"] .spark-tooltip .t{color:#64748b}

.spark-legend{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-top:6px;
  font-size:9px;
  color:var(--muted-2);
  font-family:'VT323',monospace;
  flex-wrap:wrap;
  gap:6px;
}
:root[data-theme="light"] .spark-legend{color:#64748b}
.spark-legend .dots{
  display:flex;
  align-items:center;
  gap:8px;
}
.spark-legend .leg{
  display:inline-flex;
  align-items:center;
  gap:3px;
}
.spark-legend .dot-l{
  width:6px;height:6px;border-radius:50%;
}
.spark-legend .dot-l.good{background:var(--accent)}
.spark-legend .dot-l.avg{background:var(--accent-2)}
.spark-legend .dot-l.bad{background:var(--danger)}
.spark-empty{
  text-align:center;
  padding:20px 8px;
  font-size:11px;
  color:var(--muted-2);
  font-style:italic;
}

/* ============================================================ */
/* === LIVE CONTROLS                                         === */
/* ============================================================ */
.live-bar{
  display:flex;align-items:center;justify-content:space-between;
  gap:8px;margin-top:-4px;margin-bottom:10px;flex-wrap:wrap;
}
.live-bar .left{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.live-bar .right{display:flex;align-items:center;gap:6px}

.live-toggle{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--card-2);border:1px solid var(--border);
  border-radius:20px;padding:5px 10px;font-size:10px;
  cursor:pointer;user-select:none;font-weight:700;
  color:var(--muted);transition:.15s;direction:ltr;
}
.live-toggle:hover{border-color:var(--accent);color:var(--text)}
.live-toggle.on{
  background:rgba(74,222,128,.15);
  border-color:var(--accent);
  color:var(--accent);
}
:root[data-theme="light"] .live-toggle.on{
  background:rgba(22,163,74,.15);
  color:#15803d;
  border-color:#16a34a;
}
.live-toggle .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.live-toggle.on .dot{animation:pulse 1.4s infinite}

.live-interval{
  background:var(--card-2);
  border:1px solid var(--border);
  color:var(--text);
  border-radius:20px;
  padding:5px 8px;
  font-size:10px;
  font-weight:700;
  cursor:pointer;
  font-family:'VT323',monospace;
  direction:ltr;
  outline:none;
  transition:.15s;
  min-width:56px;
  text-align:center;
}
.live-interval:hover{border-color:var(--accent)}
.live-interval:focus{border-color:var(--accent)}

.live-custom{
  background:var(--card-2);
  border:1px solid var(--border);
  color:var(--text);
  border-radius:20px;
  padding:5px 8px;
  font-size:10px;
  font-weight:700;
  font-family:'VT323',monospace;
  direction:ltr;
  outline:none;
  width:64px;
  text-align:center;
  transition:.15s;
}
.live-custom:focus{border-color:var(--accent);color:var(--accent-2)}
.live-custom::placeholder{color:var(--muted-2)}

.next-refresh{
  font-size:10px;
  color:var(--muted);
  font-family:'VT323',monospace;
  direction:ltr;
  padding:4px 10px;
  background:var(--card-2);
  border:1px solid var(--border);
  border-radius:20px;
  transition:.2s;
  display:none;
  min-width:48px;
  text-align:center;
}
.next-refresh.counting{color:var(--accent-2);border-color:var(--accent-2)}

.live-indicator{
  position:absolute;top:12px;right:12px;
  font-size:9px;color:var(--accent);font-weight:700;
  display:inline-flex;align-items:center;gap:4px;
  direction:ltr;padding:3px 7px;
  background:rgba(74,222,128,.1);border-radius:12px;
}
:root[data-theme="light"] .live-indicator{
  background:rgba(22,163,74,.12);
  color:#15803d;
}
.live-indicator .dt{
  width:5px;height:5px;border-radius:50%;background:currentColor;
  animation:pulse 1.4s infinite;
}

/* ============================================================ */

.actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:12px}
.actions button{
  padding:10px 6px;font-size:11px;font-weight:700;
  background:var(--card-2);color:var(--text);
  border:1px solid var(--border);border-radius:8px;cursor:pointer;
  font-family:inherit;transition:.15s;
}
.actions button:hover{background:var(--inner-bg);border-color:var(--accent)}
.actions button.primary{background:var(--accent);color:#0a1a0a;border:0}
:root[data-theme="light"] .actions button.primary{color:#ffffff}
details{margin-top:12px}
summary{cursor:pointer;color:var(--muted);font-size:12px;padding:6px 0;user-select:none;list-style:none}
:root[data-theme="light"] summary{color:#5b6573}
:root[data-theme="light"] details[open] summary{color:#111827}
summary::-webkit-details-marker{display:none}
summary::before{content:"▶ ";transition:.2s;display:inline-block;font-size:10px}
details[open] summary::before{transform:rotate(90deg)}
pre{
  background:var(--code-bg);color:var(--code-fg);
  border:1px solid var(--border);
  border-radius:6px;padding:10px;overflow:auto;
  max-height:320px;font-size:11px;
  direction:ltr;text-align:left;font-family:'VT323',monospace;
  transition:background .25s,color .25s;
}
.offline{
  text-align:center;padding:22px 12px;
  background:rgba(239,68,68,.05);
  border:1px dashed rgba(239,68,68,.3);
  border-radius:8px;margin-top:10px;
}
:root[data-theme="light"] .offline{
  background:rgba(220,38,38,.04);
  border-color:rgba(220,38,38,.25);
}
.offline .ico{font-size:36px;margin-bottom:8px}
.offline .ttl{font-size:14px;font-weight:700;color:var(--danger);margin-bottom:4px}
.offline .dsc{font-size:12px;color:var(--muted)}
.offline .code{
  display:inline-block;margin-top:8px;
  background:rgba(239,68,68,.15);color:#fca5a5;
  padding:4px 10px;border-radius:5px;
  font-family:'VT323',monospace;font-size:14px;direction:ltr;
}
:root[data-theme="light"] .offline .code{background:rgba(220,38,38,.1);color:#b91c1c}
.docs-ttl{font-size:13px;font-weight:700;margin-bottom:10px;color:var(--accent)}
.doc{
  background:var(--inner-bg);border:1px solid var(--border);
  border-radius:8px;padding:10px 12px;margin-bottom:8px;
  transition:.15s;cursor:pointer;
}
.doc:hover{background:var(--card-2);border-color:var(--accent)}
.doc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.doc-name{font-size:12px;font-weight:700}
.doc-method{
  background:var(--accent);color:#0a1a0a;font-size:9px;
  padding:2px 6px;border-radius:3px;font-weight:700;font-family:sans-serif;
}
:root[data-theme="light"] .doc-method{color:#ffffff}
.doc-url{
  direction:ltr;text-align:left;
  font-family:'VT323',monospace;font-size:13px;
  color:var(--accent-2);word-break:break-all;
}
.toast{
  position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(80px);
  background:var(--card);border:1px solid var(--border);
  color:var(--text);padding:10px 18px;border-radius:8px;
  font-size:13px;opacity:0;transition:.3s;pointer-events:none;
  box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:100;white-space:nowrap;
}
:root[data-theme="light"] .toast{
  background:#1a1a1a;
  border-color:#2a2a2a;
  color:#f5f5f5;
  box-shadow:0 10px 30px rgba(0,0,0,.25);
}
.toast.on{transform:translateX(-50%) translateY(0);opacity:1}
.ft{text-align:center;color:var(--muted-2);font-size:11px;margin-top:20px;line-height:2}

/* === BOTH mode === */
.both-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.both-card{
  background:var(--inner-bg);border:1px solid var(--border);
  border-radius:10px;padding:12px;
  display:flex;flex-direction:column;gap:8px;
}
:root[data-theme="light"] .both-card{background:#f8fafc}
.both-card.on{border-color:rgba(74,222,128,.4)}
.both-card.off{border-color:rgba(239,68,68,.25)}
.both-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.both-head .ed-ico{ font-size:20px; line-height:1; }
.both-head .ed-name{
  font-weight:700;font-size:13px;color:var(--accent-2);
  font-family:'VT323',monospace;letter-spacing:.5px;
}
.both-head .status-badge{margin-inline-start:auto;font-size:10px;padding:3px 8px}
.both-stat{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px}
.both-stat .k{color:var(--muted);font-weight:700;font-size:10px;letter-spacing:.3px}
.both-stat .v{color:var(--text);font-weight:700;direction:ltr;font-family:'VT323',monospace;font-size:13px}
.both-stat .v.big{font-size:16px;color:var(--accent-2)}
.both-motd{
  background:var(--motd-bg);color:var(--motd-fg);
  border:1px solid var(--border);
  border-radius:6px;padding:8px 6px;margin-top:4px;
  text-align:center;font-family:'VT323',monospace;
  font-size:12px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;min-height:32px;
  direction:ltr;unicode-bidi:isolate;
}
.both-motd > bdi{ display:inline; }
.both-err{
  background:rgba(239,68,68,.05);
  border:1px dashed rgba(239,68,68,.3);
  border-radius:6px;padding:10px;text-align:center;font-size:11px;color:var(--muted);
}
:root[data-theme="light"] .both-err{
  background:rgba(220,38,38,.04);
  border-color:rgba(220,38,38,.25);
}
.both-err .code{
  display:inline-block;margin-top:4px;
  background:rgba(239,68,68,.15);color:#fca5a5;
  padding:3px 8px;border-radius:4px;
  font-family:'VT323',monospace;font-size:12px;direction:ltr;
}
:root[data-theme="light"] .both-err .code{background:rgba(220,38,38,.1);color:#b91c1c}

/* === Theme toggle (FIX v3.8.1: smaller) === */
.theme-toggle{
  position:fixed;top:14px;left:14px;z-index:200;
  width:32px;height:32px;
  background:var(--card);
  border:1px solid var(--border);
  border-radius:50%;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;color:var(--text);
  box-shadow:0 2px 8px rgba(0,0,0,.15);
  transition:.25s;
  font-family:inherit;
  padding:0;
  line-height:1;
}
.theme-toggle:hover{
  background:var(--card-2);
  border-color:var(--accent);
  transform:rotate(15deg);
}
.theme-toggle:active{transform:scale(.9)}
:root[data-theme="light"] .theme-toggle{
  background:#ffffff;
  border-color:#d8dde5;
  box-shadow:0 2px 8px rgba(0,0,0,.08);
}
:root[data-theme="light"] .theme-toggle:hover{background:#f5f7fa}

@media(max-width:600px){
  body{padding:12px 10px 32px}
  .wrap{max-width:100%}
  .row{grid-template-columns:1fr 1fr;gap:8px}
  .row .full{grid-column:1/-1}
  .host-line{font-size:15px;padding:7px 10px}
  .host-line .ad{min-width:0}
  .stats{grid-template-columns:1fr 1fr;gap:6px}
  .st{
    padding:10px 12px;
    display:flex;flex-direction:row;align-items:baseline;
    justify-content:space-between;gap:8px;
  }
  .st .lbl{font-size:9px;margin:0;flex-shrink:0}
  .st .val{font-size:12px;text-align:left}
  .st .val.mono{font-size:16px}
  .players{padding:12px}
  .players .ttl-row .cnt{font-size:18px}
  .motd{font-size:15px;padding:14px 10px;min-height:44px;letter-spacing:.2px}
  .actions{grid-template-columns:1fr 1fr;gap:6px}
  .actions button{padding:11px 8px;font-size:11px}
  .icon{width:64px;height:64px;font-size:32px}
  .doc-url{font-size:11px}
  .recent .chip{font-size:10px;padding:5px 8px}
  .both-grid{grid-template-columns:1fr;gap:8px}
  .theme-toggle{top:10px;left:10px;width:30px;height:30px;font-size:13px}
  .spark-chart{height:70px}
  .spark-btn{padding:3px 6px;font-size:8px}
  .live-bar .left{gap:4px}
  .live-custom{width:56px}
  .spark-stats{gap:4px}
  .spark-stat{padding:2px 6px;font-size:11px}
  .spark-stat .v{font-size:12px}
}
@media(max-width:380px){
  .stats{grid-template-columns:1fr}
  .actions{grid-template-columns:1fr}
  .row{grid-template-columns:1fr}
  .spark-chart{height:60px}
  .spark-stats{gap:3px}
  .spark-stat{padding:1px 5px}
  .spark-stat .k{display:none}
}
</style>
</head>
<body>

<button class="theme-toggle" id="themeBtn" title="تغییر تم">🌙</button>

<div class="wrap">

<header class="hd">
  <div class="logo">⛏</div>
  <h1>Craft<span>Status</span></h1>
  <p>وضعیت سرور ماینکرفت — Java + Bedrock</p>
</header>

<main class="card">
  <div class="row">
    <div class="full">
      <label>آدرس سرور</label>
      <input id="host" type="text" value="play.hypixel.net" placeholder="play.example.com"
        autocomplete="off" spellcheck="false" autocapitalize="off">
    </div>
    <div>
      <label>پورت</label>
      <input id="port" type="number" placeholder="auto" min="1" max="65535" inputmode="numeric">
    </div>
    <div>
      <label>نسخه</label>
      <select id="edition">
        <option value="auto">AUTO</option>
        <option value="java">JAVA</option>
        <option value="bedrock">BEDROCK</option>
        <option value="both">BOTH</option>
      </select>
    </div>
  </div>

  <div class="live-bar">
    <div class="left">
      <div class="live-toggle" id="liveBtn" title="خاموش/روشن کردن بروزرسانی خودکار">
        <span class="dot"></span>
        <span id="liveLabel">LIVE OFF</span>
      </div>
      <select class="live-interval" id="liveInterval" title="بازه‌های از پیش تعیین شده">
        <option value="1">1s</option>
        <option value="3">3s</option>
        <option value="5">5s</option>
        <option value="10" selected>10s</option>
        <option value="15">15s</option>
        <option value="30">30s</option>
        <option value="60">1m</option>
        <option value="300">5m</option>
        <option value="custom">✎</option>
      </select>
      <input class="live-custom" id="liveCustom" type="number"
        placeholder="sec" min="1" max="3600" inputmode="numeric"
        style="display:none" title="ثانیه دلخواه (1-3600)">
    </div>
    <div class="right">
      <div class="next-refresh" id="nextRefresh">⟳ —</div>
    </div>
  </div>

  <button class="btn" id="go">
    <span class="spin"></span>
    <span>بررسی سرور</span>
  </button>
  <div class="recent" id="recent"></div>
</main>

<section id="out"></section>

<div class="card">
  <div class="docs-ttl">◆ API Endpoints</div>
  <div class="doc" data-copy="/api/status?host=play.hypixel.net&edition=auto">
    <div class="doc-head"><span class="doc-name">Auto-detect با SRV</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/status?host=play.hypixel.net&edition=auto</div>
  </div>
  <div class="doc" data-copy="/api/status?host=play.example.com&edition=both">
    <div class="doc-head"><span class="doc-name">Both (Java + Bedrock)</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/status?host=...&edition=both</div>
  </div>
  <div class="doc" data-copy="/api/status/batch?hosts=play.hypixel.net,play.cubecraft.net">
    <div class="doc-head"><span class="doc-name">Batch (max 10)</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/status/batch?hosts=...</div>
  </div>
  <div class="doc" data-copy="/api/dns?host=play.example.com">
    <div class="doc-head"><span class="doc-name">DNS / SRV</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/dns?host=play.example.com</div>
  </div>
  <div class="doc" data-copy="/api/metrics">
    <div class="doc-head"><span class="doc-name">Metrics</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/metrics</div>
  </div>
  <div class="doc" data-copy="/api/health">
    <div class="doc-head"><span class="doc-name">Health</span><span class="doc-method">GET</span></div>
    <div class="doc-url">/api/health</div>
  </div>
</div>

<footer class="ft">CraftStatus v3.8.1 — Zero-Dependency</footer>
</div>

<div class="toast" id="toast"></div>

<script>
"use strict";
var $ = function(id){ return document.getElementById(id); };
var RECENT_KEY = "mcst_recent_v6";
var RECENT_MAX = 6;
var PING_KEY = "mcst_pings_v1";
var PING_MAX = 180;
var SPARK_KEY = "mcst_spark_v1";

var OBF_RUNES = ["█","▓","▒","░","◼","◻"];
var obfCache = new Map();

function escapeHtml(v){
  return String(v == null ? "" : v).replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

var MC_COLORS = {
  "0":"#000000","1":"#0000AA","2":"#00AA00","3":"#00AAAA",
  "4":"#AA0000","5":"#AA00AA","6":"#FFAA00","7":"#AAAAAA",
  "8":"#555555","9":"#5555FF","a":"#55FF55","b":"#55FFFF",
  "c":"#FF5555","d":"#FF55FF","e":"#FFFF55","f":"#FFFFFF"
};
var MC_ADJUST = {
  "0":"#888888","1":"#5c8cff","2":"#44cc44","3":"#44dddd",
  "4":"#ff5555","5":"#dd66ff","6":"#ffcc44","8":"#aaaaaa","9":"#7777ff"
};

function adjustColor(hex){
  for(var k in MC_COLORS){
    if(MC_COLORS[k].toLowerCase() === hex.toLowerCase()){
      return MC_ADJUST[k] || hex;
    }
  }
  return hex;
}

function hex2rgb(h){
  var m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(h);
  return m ? {r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)} : null;
}

function renderGradient(text, h1, h2){
  var c1 = hex2rgb(h1), c2 = hex2rgb(h2);
  if(!c1 || !c2) return escapeHtml(text);
  var out = "", len = text.length;
  for(var i = 0; i < len; i++){
    var t = len > 1 ? i / (len - 1) : 0;
    var r = Math.round(c1.r + (c2.r - c1.r) * t);
    var g = Math.round(c1.g + (c2.g - c1.g) * t);
    var b = Math.round(c1.b + (c2.b - c1.b) * t);
    out += '<span style="color:rgb('+r+','+g+','+b+')">' + escapeHtml(text[i]) + '</span>';
  }
  return out;
}

function renderStyleCodes(str){
  var parts = str.split(/(\\u00A7(?:#[0-9a-fA-F]{6}|[0-9a-fk-orA-FK-OR]))/);
  var out = "";
  var color = null, bold = false, italic = false,
      underline = false, strike = false, obf = false;

  for(var i = 0; i < parts.length; i++){
    var part = parts[i];
    if(!part) continue;

    if(part.length >= 2 && part.charCodeAt(0) === 0xA7){
      var body = part.slice(1);
      if(body.charAt(0) === "#" && body.length === 7){
        color = body; bold = italic = underline = strike = obf = false;
        continue;
      }
      var c = body.charAt(0).toLowerCase();
      if(MC_COLORS[c]){
        color = adjustColor(MC_COLORS[c]);
        bold = italic = underline = strike = obf = false;
        continue;
      }
      if(c === "l"){ bold = true; continue; }
      if(c === "o"){ italic = true; continue; }
      if(c === "n"){ underline = true; continue; }
      if(c === "m"){ strike = true; continue; }
      if(c === "k"){ obf = true; continue; }
      if(c === "r"){ color = null; bold = italic = underline = strike = obf = false; continue; }
      continue;
    }

    var text = part;
    if(obf){
      var key = text;
      var cached = obfCache.get(key);
      if(!cached){
        cached = text.replace(/[^\\s]/g, function(){
          return OBF_RUNES[Math.floor(Math.random()*OBF_RUNES.length)];
        });
        if(obfCache.size > 500) obfCache.clear();
        obfCache.set(key, cached);
      }
      text = cached;
    }

    var safe = escapeHtml(text);
    var st = "";
    if(color)     st += "color:" + color + ";";
    if(bold)      st += "font-weight:900;";
    if(italic)    st += "font-style:italic;";
    if(underline && strike) st += "text-decoration:underline line-through;";
    else if(underline) st += "text-decoration:underline;";
    else if(strike)    st += "text-decoration:line-through;";
    out += st ? '<span style="'+st+'">'+safe+'</span>' : safe;
  }
  return out;
}

function renderMOTD(raw){
  if(raw == null) return "";
  var str = String(raw);
  if(!str) return "";

  str = str.replace(/&x((?:&[0-9a-fA-F]){6})/gi, function(_, h){
    return "\\u00A7#" + h.replace(/&/g, "");
  });
  str = str.replace(/\\u00A7x((?:\\u00A7[0-9a-fA-F]){6})/g, function(_, h){
    return "\\u00A7#" + h.replace(/\\u00A7/g, "");
  });
  str = str.replace(/&([0-9a-fk-orA-FK-OR])/g, "\\u00A7$1");

  var gp = /%gradient(?:#([0-9a-fA-F]{6}))?(?:#([0-9a-fA-F]{6}))?%(.*?)(?:%gradient%|$)/g;
  var out = "", last = 0, m;
  while((m = gp.exec(str)) !== null){
    if(m.index > last) out += renderStyleCodes(str.slice(last, m.index));
    out += renderGradient(m[3], m[1], m[2]);
    last = gp.lastIndex;
  }
  if(last < str.length) out += renderStyleCodes(str.slice(last));
  return out;
}

var tTimer;
function toast(msg){
  var t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(tTimer);
  tTimer = setTimeout(function(){ t.classList.remove("on"); }, 1800);
}

function copy(text){
  if(!text) return;
  var done = function(){ toast("کپی شد ✓"); };
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text).then(done).catch(function(){ fallbackCopy(text, done); });
  } else { fallbackCopy(text, done); }
}
function fallbackCopy(text, cb){
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); cb && cb(); } catch(_) {}
  document.body.removeChild(ta);
}

// ============ THEME ============
var THEME_KEY = "mcst_theme_v1";
function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  var btn = $("themeBtn");
  if(btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
  var meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute("content", theme === "light" ? "#eef1f5" : "#0f0f0f");
}
(function initTheme(){
  var saved = "dark";
  try { saved = localStorage.getItem(THEME_KEY) || "dark"; } catch(_){}
  applyTheme(saved);
})();

// ============ SPARK PREFERENCES ============
function loadSparkPrefs(){
  var prefs = { mode: "line", smooth: false, grid: true, window: 30 };
  try {
    var raw = JSON.parse(localStorage.getItem(SPARK_KEY) || "null");
    if(raw && typeof raw === "object"){
      if(["line","area","bars"].indexOf(raw.mode) !== -1) prefs.mode = raw.mode;
      prefs.smooth = !!raw.smooth;
      prefs.grid = !!raw.grid;
      if([15,30,60,120,180].indexOf(raw.window) !== -1) prefs.window = raw.window;
    }
  } catch(_){}
  return prefs;
}
function saveSparkPrefs(p){
  try { localStorage.setItem(SPARK_KEY, JSON.stringify(p)); } catch(_){}
}
var sparkPrefs = loadSparkPrefs();

// ============ PING HISTORY ============
function pingKey(host, port, edition){
  return (host||"").toLowerCase() + "|" + (port||"auto") + "|" + (edition||"auto");
}
function loadPings(){
  try { return JSON.parse(localStorage.getItem(PING_KEY) || "{}"); }
  catch(_){ return {}; }
}
function savePings(obj){
  try { localStorage.setItem(PING_KEY, JSON.stringify(obj)); } catch(_){}
}
function pushPing(host, port, edition, ping){
  if(ping == null || !isFinite(ping)) return;
  var key = pingKey(host, port, edition);
  var all = loadPings();
  var arr = Array.isArray(all[key]) ? all[key] : [];
  arr.push({ t: Date.now(), v: Math.round(ping) });
  if(arr.length > PING_MAX) arr = arr.slice(arr.length - PING_MAX);
  all[key] = arr;
  savePings(all);
}
function getPings(host, port, edition, max){
  var all = loadPings();
  var arr = all[pingKey(host, port, edition)];
  if(!Array.isArray(arr)) return [];
  if(max && arr.length > max) return arr.slice(arr.length - max);
  return arr;
}

// ============ SPARKLINE ============
function fmtTime(ms){
  var d = new Date(ms);
  var hh = String(d.getHours()).padStart(2, "0");
  var mm = String(d.getMinutes()).padStart(2, "0");
  var ss = String(d.getSeconds()).padStart(2, "0");
  return hh + ":" + mm + ":" + ss;
}

function renderSparkline(host, port, edition, currentPing, flash){
  var p = sparkPrefs;
  var arr = getPings(host, port, edition, p.window);
  var wrapCls = "spark-wrap" + (flash ? " flash" : "");
  var wrapAttrs = ' data-host="'+escapeHtml(host)+'" data-port="'+escapeHtml(port==null?"":port)+'" data-ed="'+escapeHtml(edition)+'"';

  var toolbar =
    '<div class="spark-controls">' +
      '<button class="spark-btn'+(p.mode==="line"?" on":"")+'" data-spark="mode" data-value="line">LINE</button>' +
      '<button class="spark-btn'+(p.mode==="area"?" on":"")+'" data-spark="mode" data-value="area">AREA</button>' +
      '<button class="spark-btn'+(p.mode==="bars"?" on":"")+'" data-spark="mode" data-value="bars">BARS</button>' +
      '<button class="spark-btn'+(p.smooth?" on":"")+'" data-spark="toggle" data-key="smooth" title="نرم">∿</button>' +
      '<button class="spark-btn'+(p.grid?" on":"")+'" data-spark="toggle" data-key="grid" title="شبکه">▦</button>' +
      '<button class="spark-btn" data-spark="window" title="تعداد نمونه">' + p.window + '</button>' +
    '</div>';

  if(!arr.length && currentPing == null){
    return '<div class="'+wrapCls+'"'+wrapAttrs+'>' +
      '<div class="spark-head">' +
        '<span class="spark-title">📈 PING HISTORY</span>' +
        toolbar +
      '</div>' +
      '<div class="spark-empty">داده‌ای برای نمایش نیست — اولین چک را انجام بده</div>' +
      '</div>';
  }

  // ===== Downsample to max 40 pts =====
  var MAX_POINTS = 40;
  var sampled = arr;
  if(arr.length > MAX_POINTS){
    var step = arr.length / MAX_POINTS;
    sampled = [];
    for(var s = 0; s < MAX_POINTS; s++){
      var startIdx = Math.floor(s * step);
      var endIdx = Math.min(arr.length, Math.floor((s + 1) * step));
      var sum = 0, cnt = 0;
      for(var k = startIdx; k < endIdx; k++){ sum += arr[k].v; cnt++; }
      var avgBucket = cnt > 0 ? Math.round(sum / cnt) : 0;
      var midIdx = Math.floor((startIdx + endIdx) / 2);
      sampled.push({ t: arr[midIdx].t, v: avgBucket });
    }
  }

  var values = sampled.map(function(x){ return x.v; });
  var min = Math.min.apply(null, values);
  var max = Math.max.apply(null, values);
  var avg = values.reduce(function(a,b){ return a+b; }, 0) / values.length;
  var last = values[values.length - 1];

  if(max === min){ max = min + 10; }
  var pad = (max - min) * 0.25 || 5;
  var lo = Math.max(0, min - pad);
  var hi = max + pad;

  var W = 320, H = 80, P = 10;
  var innerH = H - 2 * P;
  var stepX = values.length > 1 ? (W - 2*P) / (values.length - 1) : 0;

  function xAt(i){ return P + i * stepX; }
  function yAt(v){
    var t = (v - lo) / (hi - lo);
    return (H - P) - t * innerH;
  }

  // Build path
  var pathD = "";
  if(p.smooth && values.length > 2){
    pathD = "M" + xAt(0).toFixed(2) + " " + yAt(values[0]).toFixed(2);
    for(var i = 0; i < values.length - 1; i++){
      var x0 = xAt(i),     y0 = yAt(values[i]);
      var x1 = xAt(i + 1), y1 = yAt(values[i + 1]);
      var cx = (x0 + x1) / 2;
      pathD += " C" + cx.toFixed(2) + " " + y0.toFixed(2) +
               ", " + cx.toFixed(2) + " " + y1.toFixed(2) +
               ", " + x1.toFixed(2) + " " + y1.toFixed(2);
    }
  } else {
    for(var j = 0; j < values.length; j++){
      pathD += (j === 0 ? "M" : " L") + xAt(j).toFixed(2) + " " + yAt(values[j]).toFixed(2);
    }
  }

  var areaD = pathD + " L" + xAt(values.length - 1).toFixed(2) + " " + (H - P) +
              " L" + xAt(0).toFixed(2) + " " + (H - P) + " Z";

  var curCls = last < 80 ? "good" : last < 200 ? "warn" : "bad";
  var curColor = curCls === "good" ? "var(--accent)" :
                 curCls === "warn" ? "var(--warn)" :
                 "var(--danger)";

  // Grid
  var gridSvg = "";
  if(p.grid){
    var levels = [0.25, 0.5, 0.75];
    for(var gi = 0; gi < levels.length; gi++){
      var yg = P + innerH * levels[gi];
      gridSvg += '<line x1="'+P+'" y1="'+yg.toFixed(2)+'" x2="'+(W-P)+'" y2="'+yg.toFixed(2)+'" class="spark-grid-line"/>';
    }
  }

  // Average line
  var avgY = yAt(avg);
  gridSvg += '<line x1="'+P+'" y1="'+avgY.toFixed(2)+'" x2="'+(W-P)+'" y2="'+avgY.toFixed(2)+
    '" stroke="var(--accent-2)" stroke-width="1" stroke-dasharray="4 3" opacity=".6"/>';

  // Chart
  var gradId = "spkGrad_" + Math.random().toString(36).slice(2, 9);
  var chart = "";
  if(p.mode === "bars"){
    var barW = values.length > 0 ? Math.max(2, (W - 2*P) / values.length - 1.5) : 4;
    for(var bi = 0; bi < values.length; bi++){
      var xb = xAt(bi) - barW / 2;
      var yb = yAt(values[bi]);
      var hb = (H - P) - yb;
      var col = values[bi] < 80 ? "var(--accent)" : values[bi] < 200 ? "var(--warn)" : "var(--danger)";
      chart += '<rect x="'+xb.toFixed(2)+'" y="'+yb.toFixed(2)+
               '" width="'+barW.toFixed(2)+'" height="'+hb.toFixed(2)+
               '" rx="1" fill="'+col+'" opacity="0.85"/>';
    }
  } else if(p.mode === "area"){
    chart =
      '<defs>' +
        '<linearGradient id="'+gradId+'" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="currentColor" stop-opacity="0.5"/>' +
          '<stop offset="100%" stop-color="currentColor" stop-opacity="0.05"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="'+areaD+'" fill="url(#'+gradId+')"/>' +
      '<path d="'+pathD+'" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>';
  } else {
    chart =
      '<path d="'+pathD+'" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>';
  }

  // Dots on key points
  var dots = "";
  if(p.mode !== "bars"){
    var peaks = [];
    for(var pi = 0; pi < values.length; pi++) peaks.push({ i: pi, v: values[pi] });
    peaks.sort(function(a,b){ return b.v - a.v; });
    var topPeaks = peaks.slice(0, Math.min(2, peaks.length));
    var botPeaks = peaks.slice(-Math.min(2, peaks.length));

    var marked = {};
    for(var mi = 0; mi < topPeaks.length; mi++) marked[topPeaks[mi].i] = "high";
    for(var ni = 0; ni < botPeaks.length; ni++) marked[botPeaks[ni].i] = "low";
    marked[values.length - 1] = "last";

    for(var key in marked){
      var ki = parseInt(key, 10);
      var kind = marked[key];
      var kr = kind === "last" ? 3.2 : 2.4;
      var kop = kind === "last" ? 1 : 0.7;
      var kfill = kind === "last" ? "currentColor" :
                  kind === "high" ? "var(--danger)" : "var(--accent)";
      dots += '<circle cx="'+xAt(ki).toFixed(2)+'" cy="'+yAt(values[ki]).toFixed(2)+
              '" r="'+kr+'" fill="'+kfill+'" opacity="'+kop+'"/>';
    }
  }

  var firstT = sampled[0] && sampled[0].t ? fmtTime(sampled[0].t) : "—";
  var lastT  = sampled[sampled.length-1] && sampled[sampled.length-1].t ? fmtTime(sampled[sampled.length-1].t) : "—";

  var stats =
    '<div class="spark-stats">' +
      '<span class="spark-stat good"><span class="k">min</span><span class="v">'+min+'ms</span></span>' +
      '<span class="spark-stat avg"><span class="k">avg</span><span class="v">'+Math.round(avg)+'ms</span></span>' +
      '<span class="spark-stat warn"><span class="k">max</span><span class="v">'+max+'ms</span></span>' +
      '<span class="spark-stat"><span class="k">now</span><span class="v" style="color:'+curColor+'">'+last+'ms</span></span>' +
      '<span class="spark-stat"><span class="k">n</span><span class="v">'+arr.length+'</span></span>' +
    '</div>';

  var chartBlock =
    '<div class="spark-chart" data-spark-chart="1" data-host="'+escapeHtml(host)+'" data-port="'+escapeHtml(port||"")+'" data-ed="'+escapeHtml(edition)+'">' +
      '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="color:'+curColor+'" data-spark-svg="1">' +
        gridSvg +
        chart +
        dots +
      '</svg>' +
      '<div class="spark-tooltip" id="sparkTip"></div>' +
    '</div>';

  var legend =
    '<div class="spark-legend">' +
      '<span>' + firstT + ' → ' + lastT + '</span>' +
      '<span class="dots">' +
        '<span class="leg"><span class="dot-l good"></span> &lt;80</span>' +
        '<span class="leg"><span class="dot-l avg"></span> avg</span>' +
        '<span class="leg"><span class="dot-l bad"></span> &gt;200</span>' +
      '</span>' +
      '<span>' + Math.round(lo) + '–' + Math.round(hi) + 'ms</span>' +
    '</div>';

  return '<div class="'+wrapCls+'"'+wrapAttrs+'>' +
    '<div class="spark-head">' +
      '<span class="spark-title">📈 PING HISTORY <span class="count">'+arr.length+'</span></span>' +
      toolbar +
    '</div>' +
    stats +
    chartBlock +
    legend +
    '</div>';
}

// ============ SPARK TOOLTIP ============
document.addEventListener("mousemove", function(e){
  var chart = e.target.closest("[data-spark-chart]");
  if(!chart){ hideSparkTooltip(); return; }
  handleSparkHover(chart, e.clientX, e.clientY);
});
document.addEventListener("touchmove", function(e){
  var chart = e.target.closest("[data-spark-chart]");
  if(!chart){ hideSparkTooltip(); return; }
  var t = e.touches && e.touches[0];
  if(!t) return;
  handleSparkHover(chart, t.clientX, t.clientY);
}, { passive: true });
document.addEventListener("mouseleave", hideSparkTooltip);
document.addEventListener("touchend", hideSparkTooltip);

function hideSparkTooltip(){
  var tip = $("sparkTip");
  if(tip) tip.classList.remove("on");
}

function handleSparkHover(chartEl, clientX, clientY){
  var host = chartEl.getAttribute("data-host");
  var port = chartEl.getAttribute("data-port");
  var ed = chartEl.getAttribute("data-ed");
  var arr = getPings(host, port, ed, sparkPrefs.window);
  if(!arr.length) return;

  var svg = chartEl.querySelector("svg");
  var tip = chartEl.querySelector(".spark-tooltip");
  if(!svg || !tip) return;

  var rect = svg.getBoundingClientRect();
  var relX = clientX - rect.left;
  var ratio = Math.max(0, Math.min(1, relX / rect.width));

  var idx = Math.round(ratio * (arr.length - 1));
  idx = Math.max(0, Math.min(arr.length - 1, idx));
  var sample = arr[idx];
  if(!sample) return;

  var pctX = arr.length > 1 ? idx / (arr.length - 1) : 0.5;

  tip.innerHTML =
    '<span class="t">#'+(idx + 1)+' · '+fmtTime(sample.t)+'</span>' +
    '<span class="v">'+sample.v+'ms</span>';
  tip.style.left = (pctX * 100) + "%";
  tip.style.top = "0";
  tip.classList.add("on");
}

// ============ LIVE ============
var LIVE_KEY = "mcst_live_v3";
var LIVE_INT_KEY = "mcst_live_int_v2";
var liveTimer = null;
var countdownTimer = null;
var liveEnabled = false;
var liveIntervalSec = 10;
var nextRefreshAt = 0;
var refreshInFlight = false;

function loadLivePrefs(){
  var en = "0", iv = "10";
  try {
    en = localStorage.getItem(LIVE_KEY) || "0";
    iv = localStorage.getItem(LIVE_INT_KEY) || "10";
  } catch(_){}
  liveEnabled = en === "1";
  var n = parseInt(iv, 10);
  liveIntervalSec = (n >= 1 && n <= 3600) ? n : 10;
}

function saveLivePrefs(){
  try {
    localStorage.setItem(LIVE_KEY, liveEnabled ? "1" : "0");
    localStorage.setItem(LIVE_INT_KEY, String(liveIntervalSec));
  } catch(_){}
}

function updateLiveLabel(){
  var lbl = $("liveLabel");
  if(!lbl) return;
  lbl.textContent = liveEnabled ? "LIVE ON" : "LIVE OFF";
}

function updateCountdown(){
  var el = $("nextRefresh");
  if(!el) return;
  if(!liveEnabled){
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "inline-block";
  var remain = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  if(remain <= 3) el.classList.add("counting");
  else el.classList.remove("counting");

  var txt;
  if(remain < 60) txt = remain + "s";
  else if(remain < 3600){
    var m = Math.floor(remain / 60);
    var s = remain % 60;
    txt = m + "m" + (s > 0 ? " " + s + "s" : "");
  } else {
    var h = Math.floor(remain / 3600);
    var m2 = Math.floor((remain % 3600) / 60);
    txt = h + "h" + (m2 > 0 ? " " + m2 + "m" : "");
  }
  el.textContent = "⟳ " + txt;
}

function startCountdown(){
  if(countdownTimer) clearInterval(countdownTimer);
  nextRefreshAt = Date.now() + liveIntervalSec * 1000;
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 200);
}

function stopCountdown(){
  if(countdownTimer){ clearInterval(countdownTimer); countdownTimer = null; }
  var el = $("nextRefresh");
  if(el){ el.style.display = "none"; }
}

function tickLive(){
  if(!$("out").querySelector(".live-indicator")){
    startCountdown();
    return;
  }
  if(refreshInFlight){
    return;
  }
  refreshInFlight = true;
  startCountdown();
  Promise.resolve(check(true)).then(function(){ refreshInFlight = false; })
                               .catch(function(){ refreshInFlight = false; });
}

function setLive(enabled){
  liveEnabled = enabled;
  saveLivePrefs();
  var btn = $("liveBtn");
  if(btn){
    if(enabled) btn.classList.add("on");
    else btn.classList.remove("on");
  }
  updateLiveLabel();
  if(liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  if(enabled){
    startCountdown();
    liveTimer = setInterval(tickLive, liveIntervalSec * 1000);
  } else {
    stopCountdown();
  }
}

function setLiveInterval(sec){
  liveIntervalSec = sec;
  saveLivePrefs();
  if(liveEnabled){
    if(liveTimer){ clearInterval(liveTimer); liveTimer = null; }
    startCountdown();
    liveTimer = setInterval(tickLive, liveIntervalSec * 1000);
  } else {
    updateCountdown();
  }
}

function reflectIntervalInUI(){
  var sel = $("liveInterval");
  var cust = $("liveCustom");
  if(!sel || !cust) return;
  var presetVals = ["1","3","5","10","15","30","60","300"];
  if(presetVals.indexOf(String(liveIntervalSec)) !== -1){
    sel.value = String(liveIntervalSec);
    cust.style.display = "none";
    cust.value = "";
  } else {
    sel.value = "custom";
    cust.style.display = "inline-block";
    cust.value = String(liveIntervalSec);
  }
}

(function initLive(){
  loadLivePrefs();
  reflectIntervalInUI();
  var btn = $("liveBtn");
  if(btn && liveEnabled) btn.classList.add("on");
  updateLiveLabel();
  if(liveEnabled){
    startCountdown();
    liveTimer = setInterval(tickLive, liveIntervalSec * 1000);
  }
})();

// ============ RECENT ============
function loadRecent(){ try { return JSON.parse(localStorage.getItem(RECENT_KEY)||"[]"); } catch(_){ return []; } }
function saveRecent(l){ try { localStorage.setItem(RECENT_KEY, JSON.stringify(l.slice(0,RECENT_MAX))); } catch(_){} }

function pushRecent(h, p, chosenEd, detectedEd){
  var k = h+":"+(p||"auto")+":"+chosenEd;
  var l = loadRecent().filter(function(x){ return x.k !== k; });
  l.unshift({ k:k, h:h, p:p||"", e:chosenEd, d:detectedEd||chosenEd });
  saveRecent(l); renderRecent();
}

function renderRecent(){
  var l = loadRecent(), el = $("recent");
  if(!l.length){ el.innerHTML = ""; return; }
  el.innerHTML = l.map(function(x){
    var label = escapeHtml(x.h) + (x.p ? ":"+escapeHtml(x.p) : "");
    var tag = escapeHtml((x.e||"").toUpperCase());
    var tagCls = x.e === "both" ? "tag both" : "tag";
    var det = "";
    if(x.e === "auto" && x.d && x.d !== "auto"){
      det = '<span class="det">→'+escapeHtml(x.d.toUpperCase())+'</span>';
    }
    return '<button class="chip" data-h="'+escapeHtml(x.h)+'" data-p="'+escapeHtml(x.p)+'" data-e="'+escapeHtml(x.e)+'">'+
      '<span class="'+tagCls+'">'+tag+'</span>'+label+det+'</button>';
  }).join("");
}

function pingCls(ms){ if(ms==null) return ""; return ms < 80 ? "good" : ms < 200 ? "ok" : "bad"; }
function pingTxt(ms){ return ms == null ? "—" : ms + "ms"; }

function renderSample(sample){
  if(!Array.isArray(sample) || !sample.length) return "";
  var items = sample.slice(0, 20).map(function(p){
    var raw = (p && p.name) ? String(p.name) : "?";
    return '<span class="smp-item"><bdi>' + renderMOTD(raw) + '</bdi></span>';
  }).join("");
  return '<div class="smp">' +
    '<div class="smp-ttl">▸ نمونه بازیکنان ('+sample.length+')</div>' +
    '<div class="smp-list">'+items+'</div>' +
    '</div>';
}

function renderBothCard(edition, r){
  if(!r) return "";
  var title = edition.toUpperCase();
  var icon  = edition === "bedrock" ? "🟦" : "⛏";
  var cls   = r.online ? "on" : "off";
  var head, body;

  if(r.online){
    var p = r.players || {};
    var v = r.version;
    var ver = typeof v === "string" ? v : (v && v.name ? v.name : "—");
    var proto = (v && typeof v === "object") ? v.protocol : r.protocol;
    var motdHtml = renderMOTD(r.motd_raw || r.motd || "");

    head = '<span class="ed-ico">'+icon+'</span>' +
           '<span class="ed-name">'+title+'</span>' +
           '<span class="status-badge on"><span class="dt"></span>آنلاین</span>';

    body =
      '<div class="both-stat">' +
        '<span class="k">PLAYERS</span>' +
        '<span class="v big">'+escapeHtml(p.online||0)+'/'+escapeHtml(p.max||0)+'</span>' +
      '</div>' +
      '<div class="both-stat">' +
        '<span class="k">VERSION</span>' +
        '<span class="v">'+escapeHtml(ver)+'</span>' +
      '</div>' +
      '<div class="both-stat">' +
        '<span class="k">PING</span>' +
        '<span class="v">'+pingTxt(r.ping)+'</span>' +
      '</div>' +
      (motdHtml ? '<div class="both-motd"><bdi>'+motdHtml+'</bdi></div>' : '');
  } else {
    head = '<span class="ed-ico">'+icon+'</span>' +
           '<span class="ed-name">'+title+'</span>' +
           '<span class="status-badge off"><span class="dt"></span>آفلاین</span>';
    body = '<div class="both-err"><div>در دسترس نیست</div>' +
           (r.error ? '<div class="code">'+escapeHtml(r.error)+'</div>' : '') + '</div>';
  }

  return '<div class="both-card '+cls+'">' +
    '<div class="both-head">'+head+'</div>' +
    body +
  '</div>';
}

function render(data){
  var el = $("out");

  // === BOTH MODE ===
  if(data.edition === "both"){
    var anyOnline = !!data.online;
    var headLabel = anyOnline ? "حداقل یکی آنلاین" : "هر دو آفلاین";
    var cacheBadge = data.cached ? '<span class="cache-badge">⚡ cache</span>' : '';
    var liveInd = liveEnabled ? '<div class="live-indicator"><span class="dt"></span>LIVE</div>' : '';
    el.innerHTML =
      '<div class="srv">' +
        liveInd +
        '<div class="head">' +
          '<div class="badges">' +
            '<div class="status-badge '+(anyOnline?'on':'off')+'">' +
              '<span class="dt"></span>'+headLabel+
            '</div>' +
            cacheBadge +
          '</div>' +
        '</div>' +
        '<div class="both-grid">' +
          renderBothCard("java", data.java) +
          renderBothCard("bedrock", data.bedrock) +
        '</div>' +
        '<div class="actions">' +
          '<button class="primary" data-cv="'+escapeHtml(JSON.stringify(data,null,2))+'">📋 JSON</button>' +
          '<button data-refresh="1">🔄 بروزرسانی</button>' +
          '<button data-share="1">📤 اشتراک</button>' +
        '</div>' +
        '<details><summary>پاسخ JSON</summary><pre>'+escapeHtml(JSON.stringify(data,null,2))+'</pre></details>' +
      '</div>';
    return;
  }

  // === SINGLE EDITION ===
  if(data.online === true){
    var p = data.players || {};
    var v = data.version;
    var ver = typeof v === "string" ? v : (v && v.name ? v.name : "—");
    var proto = (v && typeof v === "object") ? v.protocol : data.protocol;
    var pct = p.max > 0 ? Math.min(100, Math.round(p.online / p.max * 100)) : 0;
    var motdHtml = renderMOTD(data.motd_raw || data.motd || "");

    var motdBlock = motdHtml
      ? '<div class="motd"><bdi>' + motdHtml + '</bdi></div>'
      : '<div class="motd motd-empty">— بدون MOTD —</div>';

    // Hide software if equals version
    var softwareClean = data.software;
    if (softwareClean && ver && softwareClean.toLowerCase() === ver.toLowerCase()) {
      softwareClean = null;
    }

    var addr = (data.queried_host || data.host || "") + (data.port ? ":"+data.port : "");
    var srvHtml = data.srv
      ? '<div class="srv-rec">SRV → ' + escapeHtml(data.srv.target) + ':' + data.srv.port + '</div>'
      : '';
    var iconHtml = (data.edition === "java" && data.favicon)
      ? '<img class="icon" src="'+escapeHtml(data.favicon)+'" alt="icon">'
      : '<div class="icon">'+(data.edition === "bedrock" ? "🟦" : "⛏")+'</div>';
    var cacheBadge = data.cached ? '<span class="cache-badge">⚡ cache</span>' : '';
    var liveInd = liveEnabled ? '<div class="live-indicator"><span class="dt"></span>LIVE</div>' : '';

    var hostKey = data.queried_host || data.host || "";
    var portKey = data.queried_port || data.port;
    var edKey   = data.edition || "java";
    var hadPings = getPings(hostKey, portKey, edKey).length > 0;
    if(!data.cached) pushPing(hostKey, portKey, edKey, data.ping);
    var shouldFlash = hadPings || liveEnabled;
    var sparklineBlock = renderSparkline(hostKey, portKey, edKey, data.ping, shouldFlash);

    el.innerHTML =
      '<div class="srv">'+
        liveInd +
        '<div class="head">'+
          '<div class="badges">'+
            '<div class="status-badge on"><span class="dt"></span>آنلاین</div>'+
            cacheBadge+
          '</div>'+
          (data.ping != null ? '<div class="ping '+pingCls(data.ping)+'">'+pingTxt(data.ping)+'</div>' : '')+
        '</div>'+
        '<div class="srv-id">'+
          iconHtml+
          '<div class="host-line">'+
            '<span class="ed">'+escapeHtml((data.edition||"").toUpperCase())+'</span>'+
            '<span class="ad">'+escapeHtml(addr)+'</span>'+
            '<button class="copy-ic" data-cv="'+escapeHtml(addr)+'">📋</button>'+
          '</div>'+
          srvHtml+
        '</div>'+
        '<div class="players">'+
          '<div class="ttl-row">'+
            '<div class="lbl">▸ بازیکنان آنلاین</div>'+
            '<div class="cnt">'+escapeHtml(p.online)+'<span class="mx">/'+escapeHtml(p.max)+'</span></div>'+
          '</div>'+
          '<div class="bar"><div class="bar-fill" style="width:'+pct+'%"></div></div>'+
          renderSample(p.sample)+
        '</div>'+
        sparklineBlock +
        '<div class="stats">'+
          '<div class="st"><div class="lbl">VERSION</div><div class="val">'+escapeHtml(ver)+'</div></div>'+
          '<div class="st"><div class="lbl">SOFTWARE</div><div class="val">'+escapeHtml(softwareClean||"—")+'</div></div>'+
          '<div class="st"><div class="lbl">PROTOCOL</div><div class="val mono">'+escapeHtml(proto!=null?proto:"—")+'</div></div>'+
          '<div class="st"><div class="lbl">LATENCY</div><div class="val mono">'+pingTxt(data.ping)+'</div></div>'+
        '</div>'+
        motdBlock+
        '<div class="actions">'+
          '<button class="primary" data-cv="'+escapeHtml(JSON.stringify(data,null,2))+'">📋 JSON</button>'+
          '<button data-refresh="1">🔄 بروزرسانی</button>'+
          '<button data-share="1">📤 اشتراک</button>'+
        '</div>'+
        '<details><summary>پاسخ JSON</summary><pre>'+escapeHtml(JSON.stringify(data,null,2))+'</pre></details>'+
      '</div>';
  } else {
    var attempts = "";
    if(Array.isArray(data.attempts) && data.attempts.length){
      attempts = '<div class="smp"><div class="smp-ttl">▸ تلاش‌ها</div><div class="smp-list">'+
        data.attempts.map(function(a){
          return '<span class="smp-item">'+escapeHtml((a.edition||"").toUpperCase())+' — '+escapeHtml(a.error||"—")+'</span>';
        }).join("")+'</div></div>';
    }
    var addr2 = (data.host||"")+(data.port?":"+data.port:"");
    el.innerHTML =
      '<div class="srv">'+
        '<div class="head"><div class="badges"><div class="status-badge off"><span class="dt"></span>آفلاین</div></div></div>'+
        '<div class="srv-id">'+
          '<div class="icon">'+(data.edition==="bedrock"?"🟦":"⛏")+'</div>'+
          '<div class="host-line">'+
            '<span class="ed">'+escapeHtml((data.edition||"").toUpperCase())+'</span>'+
            '<span class="ad">'+escapeHtml(addr2)+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="offline">'+
          '<div class="ico">✕</div>'+
          '<div class="ttl">سرور در دسترس نیست</div>'+
          '<div class="dsc">پاسخی از سرور دریافت نشد یا آدرس اشتباه است.</div>'+
          (data.error ? '<div class="code">'+escapeHtml(data.error)+'</div>' : '')+
        '</div>'+
        attempts+
        '<details><summary>پاسخ JSON</summary><pre>'+escapeHtml(JSON.stringify(data,null,2))+'</pre></details>'+
      '</div>';
  }
}

function showLoading(){
  $("out").innerHTML =
    '<div class="srv"><div class="skel">'+
    '<div class="sk big"></div><div class="sk mid"></div>'+
    '<div class="sk"></div><div class="sk"></div><div class="sk"></div>'+
    '</div></div>';
}
function showEmpty(){
  $("out").innerHTML =
    '<div class="card"><div class="state">'+
    '<div class="ico">⛏</div>'+
    '<div class="ttl">آماده بررسی</div>'+
    '<div class="dsc">آدرس سرور رو وارد کن و دکمه بررسی رو بزن.</div>'+
    '</div></div>';
}
function showError(msg){
  $("out").innerHTML =
    '<div class="card"><div class="state">'+
    '<div class="ico">✕</div>'+
    '<div class="ttl">خطا</div>'+
    '<div class="dsc">'+escapeHtml(msg)+'</div>'+
    '</div></div>';
}

async function check(force){
  var host = $("host").value.trim();
  var port = $("port").value.trim();
  var ed = $("edition").value;
  if(!host){ toast("آدرس سرور رو وارد کن"); return; }

  var isLiveRefresh = force && liveEnabled && !!$("out").querySelector(".live-indicator");
  var btn = $("go");

  if(isLiveRefresh){
    btn.classList.add("live-pulse");
    btn.querySelector("span:last-child").textContent = "⟳";
  } else {
    btn.classList.add("loading");
    btn.querySelector("span:last-child").textContent = "در حال بررسی...";
    showLoading();
  }

  var params = new URLSearchParams({ host: host, edition: ed });
  if(port) params.set("port", port);
  if(force) params.set("refresh", "1");

  try {
    var r = await fetch("/api/status?" + params.toString());
    var data = await r.json();
    if(!r.ok && data && data.error){
      showError(data.error + (data.detail ? " — " + data.detail : ""));
    } else {
      render(data);
      if(data.online) pushRecent(host, port, ed, data.edition || ed);
    }
    try {
      var up = new URLSearchParams();
      up.set("host", host);
      up.set("edition", ed);
      if(port) up.set("port", port);
      history.replaceState(null, "", "?" + up.toString());
    } catch(_){}
  } catch(e){
    showError(e.message || "خطای شبکه");
  } finally {
    btn.classList.remove("loading");
    btn.classList.remove("live-pulse");
    btn.querySelector("span:last-child").textContent = "بررسی سرور";
    refreshInFlight = false;
    if(liveEnabled) startCountdown();
  }
}

// ============ EVENTS ============

$("go").addEventListener("click", function(){ check(false); });
$("host").addEventListener("keydown", function(e){ if(e.key === "Enter") check(false); });
$("port").addEventListener("keydown", function(e){ if(e.key === "Enter") check(false); });

$("themeBtn").addEventListener("click", function(){
  var current = document.documentElement.getAttribute("data-theme") || "dark";
  var next = current === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch(_){}
  toast(next === "light" ? "☀️ حالت روشن" : "🌙 حالت تاریک");
});

$("liveBtn").addEventListener("click", function(){
  setLive(!liveEnabled);
  if(liveEnabled){
    toast("🔄 LIVE روشن ("+liveIntervalSec+"s)");
    var h = $("host").value.trim();
    if(h && $("out").querySelector(".live-indicator")){
      check(true);
    }
  } else {
    toast("⏸️ LIVE خاموش");
  }
});

$("liveInterval").addEventListener("change", function(){
  var v = this.value;
  var cust = $("liveCustom");
  if(v === "custom"){
    cust.style.display = "inline-block";
    cust.focus();
    var n = parseInt(cust.value, 10);
    if(Number.isFinite(n) && n >= 1 && n <= 3600){
      setLiveInterval(n);
      toast("⏱️ بازه: " + n + "s");
    }
  } else {
    cust.style.display = "none";
    var sec = parseInt(v, 10);
    if(Number.isFinite(sec) && sec >= 1){
      setLiveInterval(sec);
      toast("⏱️ بازه: " + sec + "s");
    }
  }
});

$("liveCustom").addEventListener("change", function(){
  var n = parseInt(this.value, 10);
  if(!Number.isFinite(n) || n < 1){ n = 1; }
  if(n > 3600) n = 3600;
  this.value = String(n);
  setLiveInterval(n);
  toast("⏱️ بازه دلخواه: " + n + "s");
});
$("liveCustom").addEventListener("keydown", function(e){
  if(e.key === "Enter") this.blur();
});

document.addEventListener("click", function(e){
  var btn = e.target.closest("[data-spark]");
  if(btn){
    var action = btn.getAttribute("data-spark");
    if(action === "mode"){
      var val = btn.getAttribute("data-value");
      if(["line","area","bars"].indexOf(val) !== -1){
        sparkPrefs.mode = val;
        saveSparkPrefs(sparkPrefs);
        rerenderSparkline();
      }
    } else if(action === "toggle"){
      var key = btn.getAttribute("data-key");
      if(key === "smooth" || key === "grid"){
        sparkPrefs[key] = !sparkPrefs[key];
        saveSparkPrefs(sparkPrefs);
        rerenderSparkline();
      }
    } else if(action === "window"){
      var windows = [15, 30, 60, 120, 180];
      var idx = windows.indexOf(sparkPrefs.window);
      var next = windows[(idx + 1) % windows.length];
      sparkPrefs.window = next;
      saveSparkPrefs(sparkPrefs);
      rerenderSparkline();
      toast("نمونه‌ها: " + next);
    }
    return;
  }

  var chip = e.target.closest(".chip");
  if(chip){
    $("host").value = chip.dataset.h;
    $("port").value = chip.dataset.p;
    $("edition").value = chip.dataset.e;
    check(false);
    return;
  }
  var cv = e.target.closest("[data-cv]");
  if(cv){ copy(cv.dataset.cv); return; }
  var refresh = e.target.closest("[data-refresh]");
  if(refresh){
    check(true);
    if(liveEnabled) setLive(true);
    return;
  }
  var share = e.target.closest("[data-share]");
  if(share){
    var h = $("host").value.trim();
    var pt = $("port").value.trim();
    var edd = $("edition").value;
    var up = new URLSearchParams();
    up.set("host", h);
    up.set("edition", edd);
    if(pt) up.set("port", pt);
    var url = location.origin + location.pathname + "?" + up.toString();
    if(navigator.share){
      navigator.share({
        title: "CraftStatus — " + h,
        text: "وضعیت سرور " + h,
        url: url
      }).then(function(){ toast("اشتراک گذاشته شد ✓"); })
        .catch(function(){});
    } else {
      copy(url);
    }
    return;
  }
  var doc = e.target.closest(".doc");
  if(doc){ copy(location.origin + doc.dataset.copy); return; }
});

function rerenderSparkline(){
  var wrap = document.querySelector(".spark-wrap");
  if(!wrap) return;
  var srv = wrap.closest(".srv");
  if(!srv) return;

  var pingBadge = srv.querySelector(".ping");
  var curPing = null;
  if(pingBadge){
    var m = /(\\d+)ms/.exec(pingBadge.textContent);
    if(m) curPing = parseInt(m[1], 10);
  }

  var h = wrap.getAttribute("data-host") || "";
  var pt = wrap.getAttribute("data-port") || "";
  var e2 = wrap.getAttribute("data-ed") || "java";
  var newSpark = renderSparkline(h, pt, e2, curPing, true);
  wrap.outerHTML = newSpark;
}

renderRecent();
showEmpty();

(function loadFromUrl(){
  try {
    var p = new URLSearchParams(location.search);
    var h = p.get("host");
    var pt = p.get("port");
    var e = p.get("edition");
    if(h){
      $("host").value = h;
      if(pt) $("port").value = pt;
      if(e && ["auto","java","bedrock","both"].indexOf(e) !== -1){
        $("edition").value = e;
      }
      setTimeout(function(){ check(false); }, 250);
    }
  } catch(_){}
})();
</script>
</body>
</html>`;

// =====================================================================
// Cache key normalization
// =====================================================================
function normalizePort(port, edition) {
  if (port === null || port === undefined) return "auto";
  if (edition === "java"    && port === DEFAULT_JAVA_PORT)    return "auto";
  if (edition === "bedrock" && port === DEFAULT_BEDROCK_PORT) return "auto";
  return String(port);
}

function makeCacheKey(host, port, edition, prefer) {
  return edition + "|" + (prefer || "") + "|" + host.toLowerCase() + "|" + normalizePort(port, edition);
}

// =====================================================================
// Status handler
// =====================================================================
async function handleStatus(req, res, url, forcedEdition) {
  metrics.statusRequests++;
  metrics.totalRequests++;

  const query      = Object.fromEntries(url.searchParams.entries());
  const hostRaw    = query.host;
  const portRaw    = query.port;
  const timeoutRaw = query.timeout;
  const preferRaw  = (query.prefer || "").toLowerCase().trim();
  const edition    = String(forcedEdition || query.edition || "auto").toLowerCase().trim();

  const hostCheck = validateHost(hostRaw);
  if (!hostCheck.ok) return sendJson(res, 400, { success: false, error: hostCheck.error });
  const host = hostCheck.value;

  if (!EDITIONS.includes(edition)) {
    return sendJson(res, 400, { success: false, error: "edition must be one of: " + EDITIONS.join(", ") });
  }
  const prefer = ["java", "bedrock"].includes(preferRaw) ? preferRaw : null;

  const portCheck = validatePort(portRaw);
  if (!portCheck.ok) return sendJson(res, 400, { success: false, error: portCheck.error });
  const port = portCheck.value;
  const hasPort = port !== null;

  const timeout = clampTimeout(timeoutRaw);

  if (metrics.byEdition[edition] === undefined) metrics.byEdition[edition] = 0;
  metrics.byEdition[edition]++;

  const skipCache = query.refresh === "1";
  const cacheKey = makeCacheKey(host, port, edition, prefer);
  if (!skipCache) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      metrics.cacheHits++;
      return sendJson(
        res, 200,
        Object.assign({}, cached, { cached: true }),
        { "X-Cache": "HIT" }
      );
    }
    metrics.cacheMisses++;
  }

  if (isPrivateHost(host)) {
    return sendJson(res, 400, {
      success: false,
      error: "This host is blocked for security reasons (private/reserved address).",
      code: "PRIVATE_ADDRESS"
    });
  }

  try {
    let result;
    if (edition === "auto") {
      result = await autoDetect(host, hasPort ? port : null, timeout, prefer);
    } else if (edition === "java") {
      result = await checkJava(host, hasPort ? port : null, timeout);
    } else if (edition === "bedrock") {
      result = await checkBedrock(host, hasPort ? port : null, timeout);
    } else if (edition === "both") {
      result = await checkBoth(host, hasPort ? port : null, timeout);
    }
    if (result) cacheSet(cacheKey, result);
    sendJson(res, 200, result, { "X-Cache": skipCache ? "BYPASS" : "MISS" });
  } catch (err) {
    metrics.errors++;
    sendJson(res, 500, {
      success: false,
      error: "Internal error while checking server status",
      detail: String(err && err.message ? err.message : err)
    });
  }
}

// =====================================================================
// /api/status/batch
// =====================================================================
async function handleBatch(req, res, url) {
  metrics.batchRequests++;
  metrics.totalRequests++;

  const raw = url.searchParams.get("hosts");
  if (!raw) {
    return sendJson(res, 400, { success: false, error: "hosts query parameter is required" });
  }

  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) {
    return sendJson(res, 400, { success: false, error: "hosts list is empty" });
  }
  if (parts.length > BATCH_MAX_HOSTS) {
    return sendJson(res, 400, { success: false, error: "too many hosts (max " + BATCH_MAX_HOSTS + ")" });
  }

  const edition = (url.searchParams.get("edition") || "auto").toLowerCase().trim();
  if (!EDITIONS.includes(edition)) {
    return sendJson(res, 400, { success: false, error: "edition must be one of: " + EDITIONS.join(", ") });
  }
  const timeout = clampTimeout(url.searchParams.get("timeout"));
  metrics.byEdition[edition]++;

  const items = parts.map(spec => {
    const idx = spec.lastIndexOf(":");
    let hostPart = spec, portPart = null;
    if (idx > -1 && /^\d+$/.test(spec.slice(idx + 1))) {
      hostPart = spec.slice(0, idx);
      portPart = Number(spec.slice(idx + 1));
    }
    return { host: hostPart.trim(), port: portPart };
  });

  const results = await Promise.all(items.map(async (item) => {
    const hc = validateHost(item.host);
    if (!hc.ok) return { success: false, host: item.host, error: hc.error };
    const pc = validatePort(item.port);
    if (!pc.ok) return { success: false, host: hc.value, port: item.port, error: pc.error };

    try {
      const key = makeCacheKey(hc.value, pc.value, edition, null);
      const cached = cacheGet(key);
      if (cached) {
        metrics.cacheHits++;
        return Object.assign({}, cached, { cached: true });
      }
      metrics.cacheMisses++;
      let r;
      if (edition === "auto")         r = await autoDetect(hc.value, pc.value, timeout, null);
      else if (edition === "java")    r = await checkJava(hc.value, pc.value, timeout);
      else if (edition === "bedrock") r = await checkBedrock(hc.value, pc.value, timeout);
      else if (edition === "both")    r = await checkBoth(hc.value, pc.value, timeout);
      if (r) cacheSet(key, r);
      return r;
    } catch (e) {
      return { success: false, host: hc.value, error: "CHECK_FAILED" };
    }
  }));

  sendJson(res, 200, {
    success: true,
    count: results.length,
    edition,
    results
  });
}

// =====================================================================
// /api/dns
// =====================================================================
async function handleDns(req, res, url) {
  metrics.dnsRequests++;
  metrics.totalRequests++;

  const hostRaw = url.searchParams.get("host");
  const hostCheck = validateHost(hostRaw);
  if (!hostCheck.ok) return sendJson(res, 400, { success: false, error: hostCheck.error });
  const host = hostCheck.value;

  const out = { success: true, host, srv: null, a: [], aaaa: [], errors: {} };

  try {
    const records = await safeResolveSrv("_minecraft._tcp." + host);
    out.srv = records.map(r => ({
      priority: r.priority, weight: r.weight,
      port: r.port, target: r.name.replace(/\.$/, "")
    }));
  } catch (e) { out.errors.srv = e.code || e.message; }

  try { out.a = await safeResolve4(host); }
  catch (e) { out.errors.a = e.code || e.message; }

  try { out.aaaa = await safeResolve6(host); }
  catch (e) { out.errors.aaaa = e.code || e.message; }

  if (out.srv && out.srv.length && !out.a.length && !out.aaaa.length) {
    out.srv.sort((a,b) => (a.priority - b.priority) || (b.weight - a.weight));
    const srvTarget = out.srv[0].target;
    try { out.srv_target_a = await safeResolve4(srvTarget); }
    catch (e) { out.errors.srv_target_a = e.code || e.message; }
    try { out.srv_target_aaaa = await safeResolve6(srvTarget); }
    catch (e) { out.errors.srv_target_aaaa = e.code || e.message; }
  }

  if (out.srv && out.srv.length) {
    out.srv.sort((a,b) => (a.priority - b.priority) || (b.weight - a.weight));
    out.best_srv = out.srv[0];
  }

  sendJson(res, 200, out);
}

// =====================================================================
// /api/metrics
// =====================================================================
function handleMetrics(req, res) {
  metrics.totalRequests++;
  const totalLookups = metrics.cacheHits + metrics.cacheMisses;
  sendJson(res, 200, {
    success: true,
    version: VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    started_at: new Date(metrics.startedAt).toISOString(),
    requests: {
      total: metrics.totalRequests,
      status: metrics.statusRequests,
      batch: metrics.batchRequests,
      dns: metrics.dnsRequests,
      rate_limited: metrics.rateLimited,
      errors: metrics.errors
    },
    by_edition: Object.assign({}, metrics.byEdition),
    cache: {
      size: cache.size,
      max: CACHE_MAX,
      ttl_ms: CACHE_TTL,
      hits: metrics.cacheHits,
      misses: metrics.cacheMisses,
      hit_ratio: totalLookups > 0 ? Number((metrics.cacheHits / totalLookups).toFixed(4)) : 0,
      srv_size: srvCache.size,
      srv_max: SRV_CACHE_MAX,
      srv_ttl_ms: SRV_TTL
    },
    rate_limiter: {
      bucket_count: buckets.size,
      bucket_max: RATE_MAX_BUCKETS,
      window_ms: RATE_WINDOW,
      max_per_window: RATE_MAX
    }
  });
}

// =====================================================================
// HTTP server
// =====================================================================
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendPreflight(res);
    if (rejectIfBodyTooLarge(req, res)) return;

    const ip = getClientIp(req);
    const rl = rateLimit(ip);
    if (!rl.allowed) {
      metrics.rateLimited++;
      res.setHeader("Retry-After", String(rl.retryAfter));
      return sendJson(res, 429, { success: false, error: "Too many requests. Try again later." });
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { success: false, error: "Method not allowed" });
    }

    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const path = url.pathname;

    if (path === "/" || path === "/index.html") return sendHtml(res, LANDING_HTML);

    if (path === "/api/health") {
      return sendJson(res, 200, {
        success: true, status: "ok",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        version: VERSION,
        cache_size: cache.size,
        srv_cache_size: srvCache.size,
        cache_ttl_ms: CACHE_TTL
      });
    }

    if (path === "/api/metrics")          return handleMetrics(req, res);
    if (path === "/api/dns")              return handleDns(req, res, url);
    if (path === "/api/status/batch")     return handleBatch(req, res, url);
    if (path === "/api/status")           return handleStatus(req, res, url, null);
    if (path === "/api/status/java")      return handleStatus(req, res, url, "java");
    if (path === "/api/status/bedrock")   return handleStatus(req, res, url, "bedrock");
    if (path === "/api/status/both")      return handleStatus(req, res, url, "both");

    return sendJson(res, 404, { success: false, error: "Not found" });
  } catch (err) {
    metrics.errors++;
    try { return sendJson(res, 500, { success: false, error: "Internal server error" }); }
    catch (_) { try { res.destroy(); } catch (__) {} }
  }
});

server.on("connection", (socket) => { try { socket.setNoDelay(true); } catch(_) {} });

// =====================================================================
// Process-level error handling + graceful shutdown
// =====================================================================
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[" + signal + "] Shutting down...");
  server.close(() => { console.log("HTTP server closed."); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("uncaughtException", (e) => {
  try { console.error("[uncaughtException]", e && e.stack ? e.stack : e); } catch (_) {}
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  try { console.error("[unhandledRejection]", e); } catch (_) {}
});

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, BIND, () => {
  console.log("");
  console.log("==============================================");
  console.log("  ⛏  CraftStatus  v" + VERSION);
  console.log("  Minecraft Java (TCP+SRV) + Bedrock (RakNet)");
  console.log("  Editions: AUTO | JAVA | BEDROCK | BOTH");
  console.log("  Sparkline: line/area/bars · smooth · grid · hover");
  console.log("  Live: 1s → 3600s custom · countdown · pulse");
  console.log("  Theme: dark · light (full override)");
  console.log("==============================================");
  console.log("  Local  : http://127.0.0.1:" + PORT);
  console.log("  Status : http://127.0.0.1:" + PORT + "/api/status?host=...&edition=auto");
  console.log("  Both   : http://127.0.0.1:" + PORT + "/api/status?host=...&edition=both");
  console.log("  Batch  : http://127.0.0.1:" + PORT + "/api/status/batch?hosts=...");
  console.log("  DNS    : http://127.0.0.1:" + PORT + "/api/dns?host=...");
  console.log("  Metrics: http://127.0.0.1:" + PORT + "/api/metrics");
  console.log("  Health : http://127.0.0.1:" + PORT + "/api/health");
  console.log("==============================================");
  console.log("");
});

server.on("error", (err) => {
  console.error("Server error:", err && err.message ? err.message : err);
});
