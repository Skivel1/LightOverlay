"use strict";
// Lee la API local de partida de League (https://127.0.0.1:2999/liveclientdata) y publica
// estadisticas por equipo en "lolInGame/stats": kills, oro estimado, torres, dragones y buffs.
//
// IMPORTANTE: el oro de los demas jugadores NO lo entrega la API. Aqui se estima con el valor
// de los items que lleva cada uno (sin consumibles). No incluye oro sin gastar ni piezas
// vendidas o deshechas, asi que es una estimacion, no el oro total real.

const https = require("https");

const STATS_PATH = "lolInGame/stats";
const BUFF_SECONDS = { BARON: 180, ELDER: 150 }; // duracion de los buffs; ajustalos si cambia el parche

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function itemGold(items) {
  let total = 0;
  for (const i of items || []) {
    if (i.consumable) continue;
    total += (Number(i.price) || 0) * (Number(i.count) || 1);
  }
  return total;
}

// Nombres con los que un jugador puede aparecer en los eventos.
function nameKeys(p) {
  const keys = [];
  if (!p) return keys;
  if (p.summonerName) keys.push(p.summonerName);
  if (p.riotId) keys.push(p.riotId);
  if (p.riotIdGameName) {
    keys.push(p.riotIdGameName);
    if (p.riotIdTagLine) keys.push(`${p.riotIdGameName}#${p.riotIdTagLine}`);
  }
  return keys;
}

const emptyTeam = () => ({ kills: 0, deaths: 0, assists: 0, cs: 0, gold: 0, towers: 0, dragons: [] });

// Funcion pura: recibe la respuesta de /allgamedata y devuelve las estadisticas.
function computeStats(d) {
  const players = (d && d.allPlayers) || [];
  const events = (d && d.events && d.events.Events) || [];
  const gameTime = Number(d && d.gameData && d.gameData.gameTime) || 0;
  const teams = { ORDER: emptyTeam(), CHAOS: emptyTeam() };

  const teamByName = {};
  for (const p of players) for (const k of nameKeys(p)) teamByName[k] = p.team;

  for (const p of players) {
    const t = teams[p.team];
    if (!t) continue;
    const s = p.scores || {};
    t.kills += s.kills || 0;
    t.deaths += s.deaths || 0;
    t.assists += s.assists || 0;
    t.cs += s.creepScore || 0;
    t.gold += itemGold(p.items);
  }

  const killerTeam = ev => teamByName[ev.KillerName] ||
    (ev.Assisters || []).map(a => teamByName[a]).find(Boolean) || null;

  const buffs = [];
  for (const ev of events) {
    if (ev.EventName === "TurretKilled") {
      // T1 = torre del equipo ORDER, T2 = torre del equipo CHAOS
      const m = /_T([12])_/.exec(ev.TurretKilled || "");
      if (m) teams[m[1] === "1" ? "CHAOS" : "ORDER"].towers++;
    } else if (ev.EventName === "DragonKill") {
      const team = killerTeam(ev);
      if (team && teams[team]) teams[team].dragons.push(ev.DragonType || "Unknown");
      if (team && ev.DragonType === "Elder") {
        buffs.push({ type: "ELDER", team, endsAt: ev.EventTime + BUFF_SECONDS.ELDER });
      }
    } else if (ev.EventName === "BaronKill") {
      const team = killerTeam(ev);
      if (team) buffs.push({ type: "BARON", team, endsAt: ev.EventTime + BUFF_SECONDS.BARON });
    }
  }
  const active = buffs.filter(b => b.endsAt > gameTime).sort((a, b) => b.endsAt - a.endsAt)[0];

  // Equipo del jugador local (el del agente): el overlay lo pone a la izquierda, como en el champ select.
  const me = d && d.activePlayer;
  const localTeam = (me && nameKeys(me).map(k => teamByName[k]).find(Boolean)) || "ORDER";

  return {
    time: Math.floor(gameTime),
    localTeam,
    teams,
    goldDiff: teams.ORDER.gold - teams.CHAOS.gold, // positivo = ventaja de ORDER
    buff: active
      ? { type: active.type, team: active.team, remaining: Math.ceil(active.endsAt - gameTime), duration: BUFF_SECONDS[active.type] }
      : null,
  };
}

function fetchLive(port, host) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, port, path: "/liveclientdata/allgamedata", timeout: 2000,
      rejectUnauthorized: false, // certificado propio de Riot, solo en localhost
    }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Consulta la API cada segundo. Fuera de partida publica null una sola vez.
function startInGame(publisher, opts = {}) {
  const port = opts.port || 2999;
  const host = opts.host || "127.0.0.1";
  const interval = opts.interval || 1000;
  let state = "unknown"; // "in" | "out"
  let timer = null;
  let stopped = false;

  const tick = async () => {
    try {
      const stats = computeStats(await fetchLive(port, host));
      if (state !== "in") log("[InGame] Partida detectada.");
      state = "in";
      publisher.publish(STATS_PATH, stats);
    } catch {
      if (state !== "out") {
        if (state === "in") log("[InGame] Partida terminada.");
        state = "out";
        publisher.publish(STATS_PATH, null);
      }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { computeStats, startInGame, STATS_PATH };
