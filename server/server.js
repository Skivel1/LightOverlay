"use strict";
// Servidor LWO en Node. Hace tres cosas:
//   1. Sirve el overlay y el admin (carpeta web/) en /lol_picksandbans/
//   2. Cachea los assets de Data Dragon en /assets/cdragon/ (reemplaza CacheDragon)
//   3. Guarda el estado y lo retransmite por WebSocket en /ws (reemplaza LWOServer en C#)
// El protocolo de mensajes es el mismo que usa el front actual:
//   { Type: "Subscribe", Content: "ruta" }  |  { Type: "Update", Path: "ruta", Content: "<json>" }

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 9345);
const HOST = process.env.HOST || "127.0.0.1"; // en Docker: HOST=0.0.0.0
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const CACHE_DIR = path.join(DATA_DIR, "cache");
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, "web"));
const SEED_FILE = path.join(__dirname, "seed-state.json");
const ROOMS_FILE = process.env.ROOMS_FILE || path.join(ROOT, "rooms.json");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_WS_BYTES = 1024 * 1024;
const DDRAGON = "https://ddragon.leagueoflegends.com/cdn/";

// Que rutas del estado puede escribir cada rol. "view" (el overlay en OBS) solo lee.
const WRITE_RULES = {
  agent: ["lolChampSelect/session", "lolChampSelect/summoners", "lolInGame/stats"],
  admin: ["lolChampSelect/admin"],
  view: [],
  all: ["lolChampSelect", "lolInGame"], // modo token unico (LWO_TOKEN)
};

function fail(msg) { console.error("[config] " + msg); process.exit(1); }
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

// ---------- Configuracion de salas y tokens ----------
// Cada sala tiene su propio estado y tres tokens: agent, admin y view.
function loadRooms() {
  let raw = process.env.LWO_ROOMS;
  // Modo token unico: LWO_TOKEN -> una sola sala "default" donde ese token sirve para todo.
  if (!raw && process.env.LWO_TOKEN) {
    console.warn("[config] Modo token unico (LWO_TOKEN).");
    return new Map([[sha(process.env.LWO_TOKEN), { room: "default", role: "all" }]]);
  }
  if (!raw && fs.existsSync(ROOMS_FILE)) raw = fs.readFileSync(ROOMS_FILE, "utf8");
  if (!raw) fail("Faltan las salas. Define LWO_TOKEN, LWO_ROOMS o crea rooms.json.");
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { fail("rooms invalido: " + e.message); }
  const byTokenHash = new Map(); // sha256(token) -> { room, role }
  for (const [room, roles] of Object.entries(cfg)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(room)) fail(`Nombre de sala invalido: "${room}"`);
    for (const [role, token] of Object.entries(roles)) {
      if (!Object.hasOwn(WRITE_RULES, role)) fail(`Rol desconocido "${role}" en la sala "${room}"`);
      if (typeof token !== "string" || token.length < 16) fail(`Token demasiado corto (min. 16) en "${room}/${role}"`);
      const h = sha(token);
      if (byTokenHash.has(h)) fail(`Token repetido en "${room}/${role}"`);
      byTokenHash.set(h, { room, role });
    }
  }
  if (!byTokenHash.size) fail("No hay ninguna sala configurada.");
  return byTokenHash;
}
const TOKENS = loadRooms();
function authenticate(token) { return token ? TOKENS.get(sha(token)) || null : null; }
// ---------- Estado compartido (arbol JSON direccionado por rutas) ----------
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

// "a[0]/b" -> ["a","0","b"]  (misma convencion que el servidor C#)
function toSegments(p) {
  if (typeof p !== "string") return null;
  const segs = p.replace(/\[/g, "/").replace(/\]/g, "").split("/").filter(Boolean);
  if (!segs.length || segs.length > 20) return null;
  for (const s of segs) {
    if (UNSAFE.has(s) || s.length > 100) return null;
    if (/^\d+$/.test(s) && Number(s) > 10000) return null;
  }
  return segs;
}
function related(a, b) { // una ruta es prefijo de la otra
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}
function getAt(root, segs) {
  let cur = root;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object" || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}
function setAt(root, segs, value) {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    let next = cur[segs[i]];
    if (next === null || typeof next !== "object") {
      next = /^\d+$/.test(segs[i + 1]) ? [] : {};
      cur[segs[i]] = next;
    }
    cur = next;
  }
  cur[segs[segs.length - 1]] = value;
}
function canWrite(role, segs) {
  return WRITE_RULES[role].some(rule => {
    const r = rule.split("/");
    return r.length <= segs.length && r.every((s, i) => s === segs[i]);
  });
}
function parseContent(c) {
  if (typeof c !== "string") return c === undefined ? null : c;
  try { return JSON.parse(c); } catch { return c; }
}

let seedCache = null;
function loadSeed() {
  if (!seedCache) seedCache = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  return structuredClone(seedCache);
}

class Room {
  constructor(name) {
    this.name = name;
    this.clients = new Set();
    this.timer = null;
    this.file = path.join(DATA_DIR, `state-${name}.json`);
    this.state = loadSeed(); // lolChampionData + valores por defecto del admin
    try { // solo se persiste lolChampSelect (admin, session, summoners)
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved.lolChampSelect === "object") {
        this.state.lolChampSelect = Object.assign(this.state.lolChampSelect || {}, saved.lolChampSelect);
      }
    } catch { /* primera vez o archivo ilegible: se parte del seed */ }
  }
  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
  }
  flush() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ lolChampSelect: this.state.lolChampSelect || {} }));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error(`[state] No se pudo guardar "${this.name}": ${e.message}`); }
  }
}
const rooms = new Map();
for (const { room } of TOKENS.values()) if (!rooms.has(room)) rooms.set(room, new Room(room));

// ---------- HTTP: estaticos y cache de Data Dragon ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2",
};

function safeJoin(base, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const full = path.join(base, decoded);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function sendFile(req, res, file, cacheControl) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
}

const inflight = new Map();
async function fetchToCache(rel, file) {
  const r = await fetch(DDRAGON + rel, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error("upstream " + r.status); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  console.log(`[cdragon] descargado ${rel}`);
}

async function handleCdragon(req, res, rel) {
  if (!/^[A-Za-z0-9_.\-/]{1,200}$/.test(rel) || rel.includes("..") || !/\.(json|png|jpg)$/.test(rel)) {
    res.writeHead(400); return res.end("Bad asset path");
  }
  const file = safeJoin(CACHE_DIR, rel);
  if (!file) { res.writeHead(403); return res.end("Forbidden"); }
  if (!fs.existsSync(file)) {
    try {
      if (!inflight.has(rel)) inflight.set(rel, fetchToCache(rel, file).finally(() => inflight.delete(rel)));
      await inflight.get(rel);
    } catch (e) {
      console.error(`[cdragon] fallo ${rel}: ${e.message}`);
      res.writeHead(e.status === 404 ? 404 : 502); return res.end("Asset no disponible");
    }
  }
  sendFile(req, res, file, "public, max-age=86400");
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  const pathname = req.url.split("?")[0];

  if (pathname === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

  if (pathname.startsWith("/assets/cdragon/")) {
    return handleCdragon(req, res, pathname.slice("/assets/cdragon/".length));
  }
  if (pathname.startsWith("/lol_picksandbans/")) {
    let rel = pathname.slice("/lol_picksandbans/".length) || "overlay.html";
    const file = safeJoin(WEB_DIR, rel);
    if (!file) { res.writeHead(403); return res.end("Forbidden"); }
    return sendFile(req, res, file, "no-cache");
  }
  res.writeHead(404); res.end("Not found");
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_BYTES,
  perMessageDeflate: { threshold: 1024 }, // comprime el lolChampionData (~400 KB)
});

server.on("upgrade", (req, socket, head) => {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return reject(400, "Bad Request"); }
  if (url.pathname !== "/ws") return reject(404, "Not Found");

  const origin = req.headers.origin; // el agente no es un navegador y no manda Origin
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.log(`[WS] Origen rechazado: ${origin}`);
    return reject(403, "Forbidden");
  }
  const auth = authenticate(url.searchParams.get("token"));
  if (!auth) { console.log("[WS] Conexion rechazada: token invalido"); return reject(401, "Unauthorized"); }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.room = rooms.get(auth.room);
    ws.role = auth.role;
    ws.subs = new Set();
    ws.isAlive = true;
    ws.msgCount = 0;
    wss.emit("connection", ws);
  });
});

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); }

wss.on("connection", ws => {
  const room = ws.room;
  room.clients.add(ws);
  console.log(`[WS] +${ws.role} en "${room.name}" (${room.clients.size})`);
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => ws.terminate());
  ws.on("close", () => {
    room.clients.delete(ws);
    console.log(`[WS] -${ws.role} en "${room.name}" (${room.clients.size})`);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    if (++ws.msgCount > 300) { console.log("[WS] Demasiados mensajes, cerrando conexion"); return ws.terminate(); }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.Type !== "string") return;

    if (msg.Type === "Subscribe") {
      const segs = toSegments(msg.Content);
      if (!segs || ws.subs.size >= 50) return;
      ws.subs.add(segs.join("/"));
      const value = getAt(room.state, segs);
      if (value !== undefined && value !== null) {
        send(ws, { Type: "Update", Path: msg.Content, Content: JSON.stringify(value) });
      }
    } else if (msg.Type === "Update") {
      const segs = toSegments(msg.Path);
      if (!segs || !canWrite(ws.role, segs)) {
        console.log(`[WS] ${ws.role} intento escribir en una ruta no permitida`);
        return;
      }
      setAt(room.state, segs, parseContent(msg.Content));
      room.scheduleSave();
      const out = JSON.stringify({
        Type: "Update",
        Path: msg.Path,
        Content: typeof msg.Content === "string" ? msg.Content : JSON.stringify(msg.Content ?? null),
      });
      for (const client of room.clients) {
        if (client === ws) continue;
        for (const sub of client.subs) {
          if (related(sub.split("/"), segs)) { send(client, out); break; }
        }
      }
    }
  });
});

setInterval(() => { for (const ws of wss.clients) ws.msgCount = 0; }, 1000).unref();
setInterval(() => { // heartbeat: elimina conexiones muertas
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

function shutdown() {
  for (const room of rooms.values()) if (room.timer) { clearTimeout(room.timer); room.flush(); }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`LWO server escuchando en http://${HOST}:${PORT}`);
  console.log(`  Overlay: /lol_picksandbans/overlay.html?token=<token view>`);
  console.log(`  Admin:   /lol_picksandbans/admin.html?token=<token admin>`);
  console.log(`  Agente:  ws(s)://<host>/ws?token=<token agent>`);
  console.log(`  Salas:   ${[...rooms.keys()].join(", ")}`);
});
