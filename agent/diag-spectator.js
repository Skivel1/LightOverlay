"use strict";
// Guarda lo que entrega la API en modo espectador para revisar nombres y eventos.
const https = require("https");
const fs = require("fs");

https.get("https://127.0.0.1:2999/liveclientdata/allgamedata", { rejectUnauthorized: false }, res => {
  let raw = "";
  res.on("data", c => (raw += c));
  res.on("end", () => {
    fs.writeFileSync("spectator-dump.json", raw);
    let d;
    try { d = JSON.parse(raw); } catch (e) { return console.log("Respuesta no JSON:", raw.slice(0, 300)); }

    console.log("activePlayer:", JSON.stringify(d.activePlayer).slice(0, 200));
    console.log("\nJugadores (team | summonerName | riotId | riotIdGameName | championName):");
    for (const p of d.allPlayers || [])
      console.log(` ${p.team} | ${p.summonerName} | ${p.riotId} | ${p.riotIdGameName} | ${p.championName}`);

    console.log("\nEventos:");
    for (const ev of (d.events && d.events.Events) || [])
      console.log(` ${Math.round(ev.EventTime)}s ${ev.EventName} killer=${ev.KillerName ?? "-"} ` +
        `type=${ev.DragonType ?? ev.MonsterType ?? "-"} stolen=${ev.Stolen ?? "-"}`);
  });
}).on("error", e => console.log("No se pudo conectar a la API:", e.message));
