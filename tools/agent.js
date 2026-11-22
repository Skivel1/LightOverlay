"use strict";
// Agente LWO: corre en el PC con League of Legends, lee el champ select del cliente (LCU)
// y publica el estado al servidor por WebSocket. Reemplaza a LWOAgent + LCUHook (C#).
//
// Uso:  node agent.js "wss://tu-servidor/ws?token=TOKEN_AGENT"
//       (o variable LWO_URL, o la URL en agent.url.txt junto a este archivo)

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");
const WebSocket = require("ws");

const SESSION_PATH = "lolChampSelect/session";
const SUMMONERS_PATH = "lolChampSelect/summoners";
const LCU_SESSION_URI = "/lol-champ-select/v1/session";
const LCU_EVENT = "OnJsonApiEvent_lol-champ-select_v1_session";

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const maskUrl = u => u.replace(/(token=)[^&]+/i, "$1***");

// ---------- Conexion al servidor remoto ----------
class Publisher {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.last = new Map(); // ruta -> ultimo mensaje, se reenvia al reconectar
  }

  publish(p, value) {
    const msg = JSON.stringify({ Type: "Update", Path: p, Content: JSON.stringify(value ?? null) });
    this.last.set(p, msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
  }

  start() { this._connect(); }

  _connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let watchdog;
    const arm = () => { // el servidor manda ping cada 30 s: si deja de hacerlo, la conexion esta muerta
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), 75000);
    };
    ws.on("open", () => {
      log("[Agent] Conectado al servidor.");
      arm();
      for (const msg of this.last.values()) ws.send(msg);
    });
    ws.on("ping", arm);
    ws.on("unexpected-response", (_req, res) => {
      log(`[Agent] El servidor rechazo la conexion (HTTP ${res.statusCode}). Revisa el token.`);
    });
    ws.on("error", e => log(`[Agent] Error de conexion: ${e.message}`));
    ws.on("close", () => {
      clearTimeout(watchdog);
      if (this.ws === ws) { this.ws = null; setTimeout(() => this._connect(), 3000); }
    });
  }
}

// ---------- Logica del champ select (equivale a LCUHook.HandleSessionChangedAsync) ----------
class SessionProcessor {
  // fetchSummoner(id) -> objeto del invocador (LCU) o null
  constructor(publisher, fetchSummoner) {
    this.publisher = publisher;
    this.fetchSummoner = fetchSummoner;
    this.summoners = new Map();
    this.chain = Promise.resolve(); // procesa los eventos en orden
  }

  handle(session) {
    this.chain = this.chain.then(() => this._handle(session)).catch(e => log("[Agent] Error:", e.message));
    return this.chain;
  }

  async _handle(session) {
    if (!session) { this.publisher.publish(SESSION_PATH, null); return; }

    const players = [...(session.myTeam || []), ...(session.theirTeam || [])];
    let changed = false;
    for (const p of players) {
      const id = p.summonerId;
      if (!id || id <= 0 || this.summoners.has(id)) continue;

      const name = p.gameName || p.summonerName || "";
      if (name) { // registro base inmediato con lo que ya trae el payload
        this.summoners.set(id, { summonerId: id, gameName: p.gameName || "", tagLine: p.tagLine || "", displayName: name });
        changed = true;
      }
      try {
        const s = await this.fetchSummoner(id);
        if (s && s.summonerId > 0) {
          this.summoners.set(id, {
            summonerId: s.summonerId,
            gameName: s.gameName || "",
            tagLine: s.tagLine || "",
            displayName: s.gameName || s.displayName || "",
            profileIconId: s.profileIconId,
          });
          changed = true;
        }
      } catch { /* bots o invocadores no consultables */ }
    }
    if (changed) this.publisher.publish(SUMMONERS_PATH, Object.fromEntries(this.summoners));
    this.publisher.publish(SESSION_PATH, session);
  }
}

// ---------- Cliente de League (LCU) ----------
function findLcuCredentials() {
  return new Promise(resolve => {
    const parse = out => {
      const port = /--app-port=(\d+)/.exec(out || "");
      const token = /--remoting-auth-token=([\w-]+)/.exec(out || "");
      return port && token ? { port: Number(port[1]), token: token[1] } : null;
    };
    if (process.platform === "win32") {
      const cmd = "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (_e, out) => resolve(parse(out)));
    } else {
      execFile("ps", ["-A", "-o", "args"], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
        (_e, out) => resolve(parse((out || "").split("\n").filter(l => l.includes("LeagueClientUx")).join("\n"))));
    }
  });
}

const basicAuth = c => "Basic " + Buffer.from("riot:" + c.token).toString("base64");

function lcuGet(creds, uri) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: "127.0.0.1", port: creds.port, path: uri, timeout: 5000,
      headers: { Authorization: basicAuth(creds), Accept: "application/json" },
      rejectUnauthorized: false, // el LCU usa un certificado propio de Riot, solo en localhost
    }, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Una sesion con el cliente: resuelve cuando se cierra la conexion.
function runLcuSession(creds, processor) {
  return new Promise(resolve => {
    const ws = new WebSocket(`wss://127.0.0.1:${creds.port}/`, {
      headers: { Authorization: basicAuth(creds) },
      rejectUnauthorized: false,
    });
    ws.on("open", async () => {
      log("[LCU] Conectado al cliente de League.");
      ws.send(JSON.stringify([5, LCU_EVENT])); // suscripcion WAMP
      try { // estado actual, por si el agente arranca con el champ select ya abierto
        const r = await lcuGet(creds, LCU_SESSION_URI);
        processor.handle(r.status === 200 ? JSON.parse(r.body) : null);
      } catch { /* se actualizara con el siguiente evento */ }
    });
    ws.on("message", data => {
      const text = data.toString();
      if (!text) return;
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!Array.isArray(m) || m[0] !== 8 || !m[2] || m[2].uri !== LCU_SESSION_URI) return;
      const evt = m[2];
      processor.handle(evt.eventType === "Delete" || evt.data == null ? null : evt.data);
    });
    ws.on("error", e => log("[LCU] Error:", e.message));
    ws.on("close", () => { log("[LCU] Desconectado del cliente de League."); resolve(); });
  });
}

async function lcuLoop(processor) {
  let waiting = false;
  for (;;) {
    const creds = await findLcuCredentials();
    if (!creds) {
      if (!waiting) { log("[LCU] Esperando al cliente de League of Legends..."); waiting = true; }
      await sleep(3000);
      continue;
    }
    waiting = false;
    const fetchSummoner = async id => {
      const r = await lcuGet(creds, `/lol-summoner/v1/summoners/${id}`);
      return r.status === 200 ? JSON.parse(r.body) : null;
    };
    processor.fetchSummoner = fetchSummoner;
    await runLcuSession(creds, processor);
    await sleep(1500);
  }
}

// ---------- Arranque ----------
function readUrl() {
  const dir = process.pkg ? path.dirname(process.execPath) : __dirname;
  let url = process.argv[2] || process.env.LWO_URL;
  const file = path.join(dir, "agent.url.txt");
  if (!url && fs.existsSync(file)) url = fs.readFileSync(file, "utf8").trim();
  return url;
}

async function main() {
  const url = readUrl();
  if (!url) {
    console.log('Uso: node agent.js "wss://tu-servidor/ws?token=TOKEN_AGENT"');
    console.log("(o define LWO_URL, o pon la URL en agent.url.txt junto al agente)");
    process.exit(1);
  }
  log(`[Agent] Servidor: ${maskUrl(url)}`);
  const publisher = new Publisher(url);
  publisher.start();
  await lcuLoop(new SessionProcessor(publisher, async () => null));
}

if (require.main === module) main();
module.exports = { Publisher, SessionProcessor };
