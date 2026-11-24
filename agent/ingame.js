  "use strict";
// Lee la API local de partida de League (https://127.0.0.1:2999/liveclientdata) y publica
// estadisticas por equipo en "lolInGame/stats": kills, oro estimado, torres, dragones, buffs
// y timers de objetivos (dragon/elder, bacuolarvas, heraldo, baron).
//
// IMPORTANTE: la API NO entrega el oro de los demas jugadores (solo el de quien juega).
// Por eso el oro se ESTIMA con un modelo de ingresos que se recalcula cada segundo:
//   oro inicial + oro pasivo + CS + kills + asistencias + torres + placas + inhibidores + epicos
// Ademas se usa el valor de los items como suelo (nadie tiene items que no pudo pagar):
// si el modelo se queda corto, se corrige hacia arriba y se mantiene esa correccion.
// Sigue siendo una estimacion: no cuenta shutdowns/rachas ni oro de runas/items.

const https = require("https");

const STATS_PATH = "lolInGame/stats";
const BUFF_SECONDS = { BARON: 180, ELDER: 150 }; // duracion de los buffs; ajustalos si cambia el parche

// ---- Timers de objetivos (en segundos). VERIFICA estos valores con tu parche. ----
const TIMERS = {
  DRAGON_FIRST: 300,      // 5:00
  DRAGON_RESPAWN: 300,    // 5:00 tras matarlo
  SOUL_DRAGONS: 4,        // dragones para el alma
  ELDER_AFTER_SOUL: 360,  // Elder aparece 6:00 despues del alma
  ELDER_RESPAWN: 360,
  GRUBS_FIRST: 480,       // bacuolarvas 8:00
  GRUBS_COUNT: 3,         // cuantas hay
  GRUBS_DESPAWN: 885,     // se van antes del heraldo
  HERALD_FIRST: 900,      // heraldo 15:00
  HERALD_DESPAWN: 1485,   // se va antes del baron
  BARON_FIRST: 1500,      // baron 25:00
  BARON_RESPAWN: 360,     // 6:00 tras matarlo
};
// Nombre del evento de bacuolarvas en la API (sin confirmar; revisa el log "[InGame] Evento nuevo")
const GRUB_EVENTS = ["HordeKill"];
const seenEvents = new Set();

const normalizeToken = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const GRUB_EVENT_KEYS = new Set(GRUB_EVENTS.map(normalizeToken));

// Normaliza los formatos de evento entre parches viejos y nuevos.
function getEpicKind(ev) {
  const eventKey = normalizeToken(ev && ev.EventName);
  if (!eventKey) return null;

  if (eventKey === "DRAGONKILL") {
    return normalizeToken(ev && ev.DragonType) === "ELDER" ? "ELDER" : "DRAGON";
  }
  if (eventKey === "BARONKILL") return "BARON";
  if (eventKey === "HERALDKILL") return "HERALD";
  if (GRUB_EVENT_KEYS.has(eventKey)) return "GRUB";
  if (eventKey !== "EPICMONSTERKILL") return null;

  const monster = normalizeToken((ev && ev.MonsterType) || (ev && ev.DragonType));
  if (!monster) return null;

  if (monster.includes("ELDER")) return "ELDER";
  if (monster.includes("BARON") || monster.includes("NASHOR")) return "BARON";
  if ((monster.includes("RIFT") && monster.includes("HERALD")) || monster.includes("HERALD")) return "HERALD";
  if (monster.includes("HORDE") || monster.includes("GRUB")) return "GRUB";
  if (monster.includes("DRAGON")) return "DRAGON";
  return null;
}

function logEpicEvent(ev, kind) {
  log("[InGame] Épico:", JSON.stringify({
    kind,
    EventName: ev.EventName || null,
    MonsterType: ev.MonsterType || null,
    DragonType: ev.DragonType || null,
    EventTime: ev.EventTime,
    KillerName: ev.KillerName || null,
    Assisters: ev.Assisters || [],
    Stolen: ev.Stolen || null,
  }));
}

// ---- Valores de oro (temporada 2026 / parche 26.x). Ajustalos aqui si cambian. ----
const GOLD = {
  START: 500,              // oro inicial por jugador
  PASSIVE_START: 100,      // el oro pasivo empieza en 1:40
  PASSIVE_PER_SEC: 2.04,   // 20.4 cada 10 s
  CS: 21,                  // promedio por minion/monstruo (aprox.; sube un poco en late)
  KILL_BASE: 300,          // bounty base de un campeon (300 hasta nivel 6)
  KILL_PER_LEVEL: 10,      // +10 por nivel de la victima desde el 7 (420 en nivel 18)
  ASSIST_RATIO: 0.5,       // bolsa de asistencias = 50% del bounty, repartida entre asistentes
  FIRST_BLOOD_KILL: 100,   // extra en la primera sangre
  FIRST_BLOOD_ASSIST: 50,
  PLATE: 120,              // oro local por placa
  PLATE_DECAY_START: 660,  // las placas de torre exterior pierden valor desde 11:00...
  PLATE_DECAY_PER_MIN: 10, // ...10 por minuto...
  PLATE_DECAY_MAX: 40,     // ...hasta 40 menos (a las 15:00)
  FIRST_TURRET: 300,       // bonus de la primera torre de la partida
  INHIB: 50,               // inhibidor destruido
  // Oro de epicos POR JUGADOR del equipo. Deja en 0 los que no sepas para tu parche.
  EPIC: { BARON: 300, DRAGON: 0, HERALD: 0, GRUB: 0 },
  // Por tier de torre: oro global (lo recibe CADA jugador del equipo) y placas (todas caen
  // cuando la torre cae, porque las placas son segmentos de su vida).
  TURRET: {
    outer: { global: 50, plates: 5 },
    inner: { global: 25, plates: 5 },
    inhib: { global: 25, plates: 5 },
    nexus: { global: 25, plates: 0 },
  },
};

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

// Interpreta el nombre de una torre y devuelve { owner, tier } (owner = equipo DUEÑO de la torre).
// Formato actual:  "Turret_TChaos_L1_P3_2254202041_0"  (P3 exterior, P2 interior, P1 inhibidor)
// Formato antiguo: "Turret_T2_L_03_A"                  (T1 = ORDER, T2 = CHAOS; 03/02/01; mid: 05/04/03)
// Si no reconoce el tier devuelve tier = null (la torre igual se cuenta, solo sin oro de torre/placas).
const seenTurrets = new Set();
function parseTurret(name) {
  let owner = null, tier = null, m;
  if ((m = /^Turret_T(Order|Chaos)_[^_]*_P(\d+)_/i.exec(name || ""))) {
    owner = m[1].toLowerCase() === "order" ? "ORDER" : "CHAOS";
    tier = { 3: "outer", 2: "inner", 1: "inhib" }[Number(m[2])] || null;
  } else if ((m = /^Turret_T([12])_([LCR])_(\d+)_A/i.exec(name || ""))) {
    owner = m[1] === "1" ? "ORDER" : "CHAOS";
    const n = Number(m[3]);
    tier = (m[2].toUpperCase() === "C"
      ? { 5: "outer", 4: "inner", 3: "inhib", 2: "nexus", 1: "nexus" }
      : { 3: "outer", 2: "inner", 1: "inhib" })[n] || null;
  } else if ((m = /T(Order|Chaos)/i.exec(name || ""))) { // ultimo recurso: solo el equipo dueño
    owner = m[1].toLowerCase() === "order" ? "ORDER" : "CHAOS";
  }
  if (!seenTurrets.has(name)) { // para verificar el mapeo en una partida real
    seenTurrets.add(name);
    log(`[InGame] Torre destruida: ${name} -> dueno ${owner || "?"}, tier ${tier || "desconocido"}`);
  }
  return { owner, tier };
}

const killBounty = level => GOLD.KILL_BASE + Math.max(0, (Number(level) || 1) - 6) * GOLD.KILL_PER_LEVEL;

// Oro por placa segun el momento: las exteriores pierden valor entre 11:00 y 15:00.
function plateGold(tier, t) {
  if (tier !== "outer") return GOLD.PLATE;
  const decay = ((t - GOLD.PLATE_DECAY_START) / 60) * GOLD.PLATE_DECAY_PER_MIN;
  return GOLD.PLATE - Math.min(GOLD.PLATE_DECAY_MAX, Math.max(0, decay));
}

const emptyTeam = () => ({
  kills: 0, deaths: 0, assists: 0, cs: 0, gold: 0, towers: 0, dragons: [],
  goldParts: { base: 0, cs: 0, kills: 0, assists: 0, towers: 0, plates: 0, epics: 0, items: 0 }, // desglose (para ajustar el modelo)
});

// Calcula el estado de cada objetivo: "spawning" (con cuenta regresiva), "alive" o "done".
function computeObjectives(events, gameTime, teamOf) {
  let lastDragon = null, lastElder = null, soulAt = null, soulTeam = null;
  let grubs = 0, heraldDone = false, lastBaron = null;
  const drakes = { ORDER: 0, CHAOS: 0 };

  for (const ev of events) {
    const epic = getEpicKind(ev);
    if (!epic) continue;

    if (epic === "ELDER") {
      lastElder = ev.EventTime;
      continue;
    }
    if (epic === "DRAGON") {
      lastDragon = ev.EventTime;
      const t = teamOf(ev);
      if (t && ++drakes[t] >= TIMERS.SOUL_DRAGONS && soulAt == null) { soulAt = ev.EventTime; soulTeam = t; }
      continue;
    }
    if (epic === "GRUB") {
      grubs++;
      continue;
    }
    if (epic === "HERALD") {
      heraldDone = true;
      continue;
    }
    if (epic === "BARON") {
      lastBaron = ev.EventTime;
    }
  }

  const timer = (spawnAt, extra) => Object.assign({
    state: gameTime >= spawnAt ? "alive" : "spawning",
    remaining: Math.max(0, Math.ceil(spawnAt - gameTime)),
  }, extra || {});
  const done = extra => Object.assign({ state: "done", remaining: 0 }, extra || {});

  const dragon = soulAt != null
    ? timer(lastElder != null ? lastElder + TIMERS.ELDER_RESPAWN : soulAt + TIMERS.ELDER_AFTER_SOUL, { kind: "ELDER", soulTeam })
    : timer(lastDragon != null ? lastDragon + TIMERS.DRAGON_RESPAWN : TIMERS.DRAGON_FIRST, { kind: "DRAGON" });

  const grubsObj = (grubs >= TIMERS.GRUBS_COUNT || gameTime >= TIMERS.GRUBS_DESPAWN)
    ? done({ taken: grubs, total: TIMERS.GRUBS_COUNT })
    : timer(TIMERS.GRUBS_FIRST, { taken: grubs, total: TIMERS.GRUBS_COUNT });

  const herald = (heraldDone || gameTime >= TIMERS.HERALD_DESPAWN) ? done() : timer(TIMERS.HERALD_FIRST);
  const baron = timer(lastBaron != null ? lastBaron + TIMERS.BARON_RESPAWN : TIMERS.BARON_FIRST);

  return { dragon, grubs: grubsObj, herald, baron };
}

// Funcion casi pura: recibe /allgamedata y devuelve las estadisticas. `memo` (opcional) guarda la
// correccion por jugador entre llamadas; sin memo cada llamada es independiente.
function computeStats(d, memo = {}) {
  const players = (d && d.allPlayers) || [];
  const events = ((d && d.events && d.events.Events) || []).slice().sort((x, y) => x.EventTime - y.EventTime);
  const gameTime = Number(d && d.gameData && d.gameData.gameTime) || 0;
  const teams = { ORDER: emptyTeam(), CHAOS: emptyTeam() };

  // Nueva partida (el reloj retrocede): se descarta la correccion de la anterior.
  if (memo.last != null && gameTime < memo.last) memo.bias = {};
  memo.last = gameTime;
  if (!memo.bias) memo.bias = {};

  const teamByName = {};
  const playerByName = {};
  const sizeByTeam = { ORDER: 0, CHAOS: 0 };
  for (const p of players) {
    sizeByTeam[p.team] = (sizeByTeam[p.team] || 0) + 1;
    for (const k of nameKeys(p)) { teamByName[k] = p.team; playerByName[k] = p; }
  }

  // Libro de oro por jugador, desglosado por origen.
  const pid = p => p.riotId || p.summonerName || nameKeys(p)[0] || "?";
  const ledger = new Map();
  for (const p of players) {
    const s = p.scores || {};
    const passive = Math.max(0, gameTime - GOLD.PASSIVE_START) * GOLD.PASSIVE_PER_SEC;
    ledger.set(pid(p), {
      p, base: GOLD.START + passive, cs: (s.creepScore || 0) * GOLD.CS,
      kills: 0, assists: 0, towers: 0, plates: 0, epics: 0,
    });
  }
  const row = p => (p ? ledger.get(pid(p)) : null);
  // Reparte oro compartido (torres, placas, epicos) en partes iguales entre los jugadores del equipo.
  const shareTeam = (team, field, amount) => {
    const n = sizeByTeam[team] || 5;
    for (const p of players) if (p.team === team) row(p)[field] += amount / n;
  };

  const killerTeam = ev => teamByName[ev.KillerName] ||
    (ev.Assisters || []).map(a => teamByName[a]).find(Boolean) || null;

  const buffs = [];
  let firstBlood = true, firstTurret = true;
  for (const ev of events) {
    // Registra cada tipo de evento la primera vez (para confirmar nombres, p. ej. bacuolarvas).
    if (!seenEvents.has(ev.EventName)) {
      seenEvents.add(ev.EventName);
      log("[InGame] Evento nuevo:", JSON.stringify(ev));
    }

    const epicKind = getEpicKind(ev);
    if (epicKind) logEpicEvent(ev, epicKind);

    if (ev.EventName === "ChampionKill") {
      const killer = playerByName[ev.KillerName];
      const victim = playerByName[ev.VictimName];
      const bounty = killBounty(victim && victim.level);
      const fbKill = firstBlood ? GOLD.FIRST_BLOOD_KILL : 0;
      const fbAssist = firstBlood ? GOLD.FIRST_BLOOD_ASSIST : 0;
      firstBlood = false;
      if (killer) row(killer).kills += bounty + fbKill;
      const assisters = (ev.Assisters || []).map(a => playerByName[a]).filter(Boolean);
      if (assisters.length) {
        const pool = Math.min(bounty * GOLD.ASSIST_RATIO, GOLD.KILL_BASE * GOLD.ASSIST_RATIO) + fbAssist;
        for (const a of assisters) row(a).assists += pool / assisters.length;
      }
    } else if (ev.EventName === "TurretKilled") {
      // Gana el equipo contrario al dueno de la torre; si el nombre no se entiende, el del asesino.
      const { owner, tier } = parseTurret(ev.TurretKilled);
      const team = owner ? (owner === "ORDER" ? "CHAOS" : "ORDER") : killerTeam(ev);
      if (team && teams[team]) {
        teams[team].towers++;
        const cfg = tier && GOLD.TURRET[tier];
        if (cfg) {
          shareTeam(team, "towers", cfg.global * (sizeByTeam[team] || 5)); // global: cada jugador recibe `global`
          shareTeam(team, "plates", cfg.plates * plateGold(tier, ev.EventTime));
        }
        if (firstTurret) { firstTurret = false; shareTeam(team, "towers", GOLD.FIRST_TURRET); }
      }
    } else if (ev.EventName === "InhibKilled") {
      const team = teamByName[ev.KillerName] || null;
      if (team) shareTeam(team, "towers", GOLD.INHIB);
    } else if (epicKind === "DRAGON" || epicKind === "ELDER") {
      const team = killerTeam(ev);
      if (team && teams[team]) {
        const dragonType = ev.DragonType || ev.MonsterType || (epicKind === "ELDER" ? "Elder" : "Dragon");
        teams[team].dragons.push(dragonType);
        if (GOLD.EPIC.DRAGON) shareTeam(team, "epics", GOLD.EPIC.DRAGON * (sizeByTeam[team] || 5));
      }
      if (team && epicKind === "ELDER") {
        buffs.push({ type: "ELDER", team, endsAt: ev.EventTime + BUFF_SECONDS.ELDER });
      }
    } else if (epicKind === "BARON") {
      const team = killerTeam(ev);
      if (team) {
        buffs.push({ type: "BARON", team, endsAt: ev.EventTime + BUFF_SECONDS.BARON });
        if (GOLD.EPIC.BARON) shareTeam(team, "epics", GOLD.EPIC.BARON * (sizeByTeam[team] || 5));
      }
    } else if (epicKind === "HERALD") {
      const team = killerTeam(ev);
      if (team && GOLD.EPIC.HERALD) shareTeam(team, "epics", GOLD.EPIC.HERALD * (sizeByTeam[team] || 5));
    } else if (epicKind === "GRUB") {
      const team = killerTeam(ev);
      if (team && GOLD.EPIC.GRUB) shareTeam(team, "epics", GOLD.EPIC.GRUB * (sizeByTeam[team] || 5));
    }
  }
  const active = buffs.filter(b => b.endsAt > gameTime).sort((a, b) => b.endsAt - a.endsAt)[0];

  // Totales por equipo, con el suelo de items por jugador.
  for (const r of ledger.values()) {
    const t = teams[r.p.team];
    if (!t) continue;
    const s = r.p.scores || {};
    t.kills += s.kills || 0;
    t.deaths += s.deaths || 0;
    t.assists += s.assists || 0;
    t.cs += s.creepScore || 0;

    const model = r.base + r.cs + r.kills + r.assists + r.towers + r.plates + r.epics;
    const id = pid(r.p);
    const floor = itemGold(r.p.items) - model; // si es > 0, el modelo se quedo corto
    if (floor > (memo.bias[id] || 0)) memo.bias[id] = floor;
    const bias = memo.bias[id] || 0;

    t.gold += model + bias;
    const g = t.goldParts;
    g.base += r.base; g.cs += r.cs; g.kills += r.kills; g.assists += r.assists;
    g.towers += r.towers; g.plates += r.plates; g.items += bias;
    g.epics += r.epics;
  }
  for (const t of Object.values(teams)) {
    t.gold = Math.round(t.gold);
    for (const k of Object.keys(t.goldParts)) t.goldParts[k] = Math.round(t.goldParts[k]);
  }

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
    objectives: computeObjectives(events, gameTime, killerTeam),
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
  const noEventsWarnAfterSec = Math.max(1, Number(opts.noEventsWarnAfterSec) || 6);
  let state = "unknown"; // "in" | "out"
  let timer = null;
  let stopped = false;
  let noEventsSince = null;
  let noEventsWarned = false;
  const memo = {}; // correccion de oro por jugador; se reinicia sola al empezar otra partida

  const tick = async () => {
    try {
      const live = await fetchLive(port, host);
      const gameTime = Number(live && live.gameData && live.gameData.gameTime) || 0;
      const eventList = Array.isArray(live && live.events && live.events.Events) ? live.events.Events : [];

      if (gameTime > 0 && eventList.length === 0) {
        if (noEventsSince == null) noEventsSince = Date.now();
        const emptyForSec = (Date.now() - noEventsSince) / 1000;
        if (!noEventsWarned && emptyForSec >= noEventsWarnAfterSec) {
          noEventsWarned = true;
          log("[InGame] La API no trae eventos (¿modo espectador?): los timers de objetivos no se pueden calcular");
        }
      } else {
        noEventsSince = null;
      }

      const stats = computeStats(live, memo);
      if (state !== "in") log("[InGame] Partida detectada.");
      state = "in";
      publisher.publish(STATS_PATH, stats);
    } catch {
      if (state !== "out") {
        if (state === "in") log("[InGame] Partida terminada.");
        state = "out";
        noEventsSince = null;
        noEventsWarned = false;
        memo.bias = {}; memo.last = null;
        seenEvents.clear(); // vuelve a registrar los eventos en la siguiente partida
        publisher.publish(STATS_PATH, null);
      }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { computeStats, startInGame, STATS_PATH };
