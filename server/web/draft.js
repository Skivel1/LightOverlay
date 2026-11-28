/* Draft overlay (1920x1080). Usa el socket y el estado de state.js.
   URL: draft.html?token=<view>   (opcional: &bg=none para fondo transparente) */

// state.js se suscribe a admin/session/summoners al conectar si initDone es true
var initDone = true;
function Main() {}
function UpdatePB() { render(); }
function UpdateChampionData() { loadChamps(); render(); }

if (new URLSearchParams(location.search).get("bg") === "none")
    document.body.classList.add("nobg");

var FX_LOCK_MS = 1400, FX_STAMP_MS = 1200;

var championsById = {}, championsByIndex = [], loadedVersion = "";
var picks = { 1: [], 2: [] }, strips = { 1: [], 2: [] }, bans = { 1: [], 2: [] }, fearless = { 1: [], 2: [] };
var lastLocked = {}, lastBanned = {}, fxReady = false;
var timerKey = null, timerAt = 0, timerLeft = 0, lastLabel = "";
var pipCount = { 1: -1, 2: -1 };

/* ---- Sonido de inicio (portado de overlay.js) ---- */
// Archivo en server/web/assets/media/. Tambien por URL: ?audio=otro.mp3 (o ?audio=off) y ?volume=0.5
var INTRO_AUDIO = "LCK_Select.mp3";
var INTRO_VOLUME = 1;          // 0 a 1

var hadSession = false;        // hubo una seleccion en esta carga de la pagina
var introAudio = null;

function SetupIntroAudio() {
    var q = new URLSearchParams(location.search);
    var file = q.get("audio") || INTRO_AUDIO;
    var vol = parseFloat(q.get("volume"));
    if (isNaN(vol)) vol = INTRO_VOLUME;
    if (file === "off") return;

    introAudio = new Audio("assets/media/" + encodeURIComponent(file));
    introAudio.preload = "auto";
    introAudio.volume = Math.max(0, Math.min(1, vol));
}

function PlayIntroSound() {
    if (!introAudio) SetupIntroAudio();
    if (!introAudio) return;
    try {
        introAudio.currentTime = 0;
        var p = introAudio.play();
        if (p && p.catch) p.catch(function (err) { console.warn("No se pudo reproducir el audio de inicio:", err); });
    } catch (err) {
        console.warn("No se pudo reproducir el audio de inicio:", err);
    }
}

function $(id) { return document.getElementById(id); }
function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
}

/* ---- escritura al DOM solo si cambia ---- */
function txt(e, v) { v = v == null ? "" : String(v); if (e._t !== v) { e._t = v; e.textContent = v; } }
function bg(e, url) { var v = url ? "url(\"" + url + "\")" : ""; if (e._b !== v) { e._b = v; e.style.backgroundImage = v; } }
function cls(e, name, on) { on = !!on; var k = "_c_" + name; if (e[k] !== on) { e[k] = on; e.classList.toggle(name, on); } }
function attr(e, name, v) { if (e["_a_" + name] !== v) { e["_a_" + name] = v; if (v) e.setAttribute(name, v); else e.removeAttribute(name); } }

function plain(v) { return (v || "").toString().replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim(); }
function sel(v) { return plain(v); }

/* ---- datos de campeones ---- */
async function loadChamps() {
    var admin = (_S.lolChampSelect && _S.lolChampSelect.admin) || {};
    var version = plain(admin.version);
    if (!version && loadedVersion && championsByIndex.length) return;
    if (!version) {
        try {
            var r = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
            var v = await r.json();
            if (Array.isArray(v) && v.length) version = v[0];
        } catch (e) { console.warn("No se pudo obtener la version de ddragon", e); }
    }
    if (!version) { setTimeout(loadChamps, 5000); return; }
    if (version === loadedVersion && championsByIndex.length) return;
    try {
        var res = await fetch("/assets/cdragon/" + version + "/data/en_US/champion.json");
        var out = await res.json();
        championsById = {}; championsByIndex = [];
        Object.keys(out.data || {}).forEach(function (k) {
            var c = out.data[k];
            championsById[c.key] = c;
            championsByIndex.push(c);
        });
        loadedVersion = version;
        preload();
        render();
    } catch (e) { console.warn("Error cargando champion.json", e); setTimeout(loadChamps, 5000); }
}
function preload() {
    var i = 0;
    (function next() {
        if (i >= championsByIndex.length) return;
        var im = new Image(), id = championsByIndex[i++].id;
        im.onload = im.onerror = next;
        im.src = splashUrl(id);
        new Image().src = tileUrl(id);
    })();
}
function fixId(id) { return id === "Fiddlesticks" ? "FiddleSticks" : id; }
function splashUrl(id) { return "/assets/cdragon/img/champion/centered/" + fixId(id) + "_0.jpg"; }
function tileUrl(id) { return "/assets/cdragon/img/champion/tiles/" + fixId(id) + "_0.jpg"; }

function findChamp(name) {
    var n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!n) return null;
    for (var i = 0; i < championsByIndex.length; i++) {
        var c = championsByIndex[i];
        if (c.id.toLowerCase() === n || c.name.toLowerCase().replace(/[^a-z0-9]/g, "") === n || c.key === n) return c;
    }
    return null;
}

/* ---- construccion del DOM ---- */
function build() {
    [1, 2].forEach(function (t) {
        var pc = $(t === 1 ? "picksL" : "picksR"), sc = $(t === 1 ? "stripsL" : "stripsR");
        for (var i = 0; i < 5; i++) {
            var card = el("div", "card empty", pc);
            var banner = el("div", "banner", card);
            var tag = el("div", "tag", card), role = el("div", "role", card), player = el("div", "player", card);
            picks[t].push({ card: card, banner: banner, tag: tag, role: role, player: player });

            var strip = el("div", "strip empty", sc);
            el("div", "bar", strip);
            strips[t].push(strip);
        }

        var bc = $(t === 1 ? "bansL" : "bansR");
        [["BAN PHASE 1", 3], ["BAN PHASE 2", 2]].forEach(function (g) {
            var grp = el("div", "ban-group", bc);
            txt(el("div", "ban-label", grp), g[0]);
            for (var b = 0; b < g[1]; b++) {
                var ban = el("div", "ban empty", grp);
                el("div", "no", ban);
                bans[t].push(ban);
            }
        });

        var grid = $(t === 1 ? "fearlessL" : "fearlessR").querySelector(".fearless-grid");
        for (var f = 0; f < 10; f++) { var fl = el("div", "fl", grid); fl.style.display = "none"; fearless[t].push(fl); }
    });
}

/* ---- ayudas de la sesion ---- */
function allActions(cs) {
    var out = [];
    (cs.actions || []).forEach(function (grp) { (grp || []).forEach(function (a) { if (a) out.push(a); }); });
    return out;
}
function summonerName(id, cell) {
    var map = _S.lolChampSelect && _S.lolChampSelect.summoners;
    var s = map && id && map[id];
    return (s && (s.gameName || s.displayName)) || ("Summoner " + (cell + 1));
}
function fx(e, name, ms) { cls(e, name, false); void e.offsetWidth; cls(e, name, true); setTimeout(function () { cls(e, name, false); }, ms); }

function phaseLabel(cs, actions) {
    var tp = cs.timer ? cs.timer.phase : "";
    if (tp === "FINALIZATION" || tp === "GAME_STARTING") return "DRAFT COMPLETE";
    if (tp === "PLANNING") return "PLANNING";
    if (tp === "BAN_PICK") {
        var cur = null;
        for (var i = actions.length - 1; i >= 0; i--) if (actions[i].isInProgress) { cur = actions[i]; break; }
        if (!cur) return lastLabel;
        var doneOfType = actions.filter(function (a) { return a.type === cur.type && a.completed; }).length;
        var totalOfType = actions.filter(function (a) { return a.type === cur.type; }).length;
        if (cur.type === "ban")
            return cs.hasSimultaneousBans || totalOfType <= 6 ? (cs.hasSimultaneousBans ? "BAN PHASE" : "BAN PHASE 1") : (doneOfType < 6 ? "BAN PHASE 1" : "BAN PHASE 2");
        return cs.hasSimultaneousPicks ? "PICK PHASE" : (doneOfType < 6 ? "PICK PHASE 1" : "PICK PHASE 2");
    }
    return lastLabel;
}

/* ---- render principal ---- */
function render() {
    if (!picks[1].length) return;
    var S = _S.lolChampSelect || {}, admin = S.admin || {}, cs = S.session;

    var root = document.documentElement.style;
    if (admin.leftTeamColor) root.setProperty("--left", plain(admin.leftTeamColor));
    if (admin.rightTeamColor) root.setProperty("--right", plain(admin.rightTeamColor));

    /* encabezado */
    txt($("nameL"), plain(admin.leftTeamName)); txt($("nameR"), plain(admin.rightTeamName));
    var lL = plain(admin.leftTeamIcon), lR = plain(admin.rightTeamIcon);
    attr($("logoL"), "src", lL ? "assets/teams/" + encodeURIComponent(lL) : "");
    attr($("logoR"), "src", lR ? "assets/teams/" + encodeURIComponent(lR) : "");
    txt($("patch"), plain(admin.patchInfo) ? plain(admin.patchInfo).toUpperCase() : "");
    pips(1, $("pipsL"), parseInt(plain(admin.leftTeamScore), 10) || 0, parseInt(plain(admin.bestOf), 10) || 3);
    pips(2, $("pipsR"), parseInt(plain(admin.rightTeamScore), 10) || 0, parseInt(plain(admin.bestOf), 10) || 3);

    /* torneo */
    var tName = plain(admin.tournamentName), tLogo = plain(admin.tournamentLogo), tEl = $("tournament");
    txt($("tournament-name"), tName);
    attr($("tournament-logo"), "src", tLogo ? "assets/teams/" + encodeURIComponent(tLogo) : "");
    cls(tEl, "on", tName || tLogo); cls(tEl, "has-logo", tLogo);

    /* fearless */
    [[1, admin.leftFearless, "fearlessL"], [2, admin.rightFearless, "fearlessR"]].forEach(function (f) {
        var names = plain(f[1]).split(/[,;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        var seen = {}, list = [];
        names.forEach(function (n) { var c = findChamp(n); if (c && !seen[c.id]) { seen[c.id] = 1; list.push(c); } });
        fearless[f[0]].forEach(function (slot, i) {
            var c = list[i];
            slot.style.display = c ? "" : "none";
            bg(slot, c ? tileUrl(c.id) : "");
        });
        cls($(f[2]), "on", list.length > 0);
    });

var hasSession = !!(cs && cs.myTeam);
    cls($("stage"), "hidden", !hasSession);
    if (!hasSession) { fxReady = false; lastLabel = ""; return; }

    var actions = allActions(cs);

    /* fase y temporizador */
    var label = phaseLabel(cs, actions);
    lastLabel = label;
    txt($("chip"), label);
    cls($("stage"), "complete", label === "DRAFT COMPLETE");

    var t = cs.timer || {};
    var key = t.internalNowInEpochMs + "_" + t.adjustedTimeLeftInPhase + "_" + t.phase;
    if (key !== timerKey) { timerKey = key; timerAt = Date.now(); timerLeft = t.adjustedTimeLeftInPhase || 0; }
    var remain = Math.max(0, timerLeft - (Date.now() - timerAt));
    var showTimer = !t.isInfinite && label !== "DRAFT COMPLETE" && (t.phase === "BAN_PICK" || t.phase === "PLANNING");
    cls($("timer"), "off", !showTimer);
    txt($("timer"), Math.ceil(remain / 1000));
    cls($("timer"), "urgent", showTimer && remain > 0 && remain <= 10000);

    /* equipos: team 1 = izquierda, team 2 = derecha */
    var myTeam = cs.myTeam || [], theirTeam = cs.theirTeam || [];
    if (!myTeam.length) return;
    var myId = myTeam[0].team, theirId = myId === 1 ? 2 : 1;
    var members = {}; members[myId] = myTeam; members[theirId] = theirTeam;

    var inProgress = actions.filter(function (a) { return a.isInProgress; });
    var banActs = {};
    banActs[myId] = actions.filter(function (a) { return a.type === "ban" && a.isAllyAction; });
    banActs[theirId] = actions.filter(function (a) { return a.type === "ban" && !a.isAllyAction; });

    [1, 2].forEach(function (team) {
        var colorSide = team === 1 ? "left" : "right";
        var bannerFile = plain(team === 1 ? admin.leftPickBanner : admin.rightPickBanner);

        for (var i = 0; i < 5; i++) {
            var m = members[team][i], p = picks[team][i], strip = strips[team][i];
            var key2 = team + "_" + i;
            if (!m) {
                cls(p.card, "empty", true); cls(strip, "empty", true);
                cls(p.card, "active", false); cls(p.card, "tentative", false); cls(strip, "tentative", false);
                txt(p.tag, ""); txt(p.player, ""); bg(p.card, ""); bg(strip, ""); lastLocked[key2] = 0;
                continue;
            }

            var act = null;
            for (var k = 0; k < inProgress.length; k++)
                if (inProgress[k].actorCellId === m.cellId && inProgress[k].type === "pick") { act = inProgress[k]; break; }
            var cid = act ? act.championId : m.championId;
            var champ = cid > 0 ? championsById[cid] : null;
            var lockedId = (!act && champ) ? m.championId : 0;

            cls(p.card, "empty", !champ); cls(strip, "empty", !champ);
            cls(p.card, "active", !!act);
            cls(p.card, "tentative", !!(act && champ)); cls(strip, "tentative", !!(act && champ));
            bg(p.card, champ ? splashUrl(champ.id) : ""); bg(strip, champ ? splashUrl(champ.id) : "");
            txt(p.tag, champ ? champ.name : "");
            txt(p.player, summonerName(m.summonerId, m.cellId));

            /* rol */
            var custom = admin.positions && admin.positions[team] && admin.positions[team][i];
            var pos = (custom && custom !== "auto") ? custom : (m.assignedPosition || "fill");
            bg(p.role, "assets/roles/role-" + pos + ".png");

            /* banner mientras se elige */
            var showBanner = !!(act && !champ && bannerFile);
            bg(p.banner, showBanner ? "assets/champselectbanner/" + encodeURIComponent(bannerFile) : "");
            cls(p.card, "has-banner", showBanner);

            /* animacion de confirmacion */
            if (fxReady && lockedId && lastLocked[key2] !== lockedId) {
                fx(p.card, "lock", FX_LOCK_MS); fx(strip, "lock", FX_LOCK_MS); fx(strip, "reveal", 800);
            }
            lastLocked[key2] = lockedId;
        }

        /* bans */
        var acts = banActs[team] || [];
        bans[team].forEach(function (b, idx) {
            var a = acts[idx], cid2 = a ? a.championId : 0, c = cid2 > 0 ? championsById[cid2] : null;
            var done = !!(a && a.completed && c), key3 = team + "_" + idx;
            cls(b, "empty", !c); cls(b, "done", done); cls(b, "active", !!(a && a.isInProgress));
            bg(b, c ? tileUrl(c.id) : "");
            var banned = done ? cid2 : 0;
            if (fxReady && banned && lastBanned[key3] !== banned) fx(b, "stamp", FX_STAMP_MS);
            lastBanned[key3] = banned;
        });
    });

    fxReady = true;
}

function pips(team, box, wins, total) {
    if (pipCount[team] !== total) {
        pipCount[team] = total; box.innerHTML = "";
        for (var i = 0; i < total; i++) el("div", "pip", box);
    }
    for (var j = 0; j < box.children.length; j++) cls(box.children[j], "won", j < wins);
}

build();
loadChamps();
setInterval(render, 200);
