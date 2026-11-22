// Barra superior de partida. Lee "lolInGame/stats" (lo publica el agente) y los datos de equipo
// del admin (nombre, logo, color, marcador de la serie).
//
// Parametros de la URL:
//   ?token=...   token del servidor (igual que el overlay de picks y bans)
//   ?swap=1      invierte los lados (por defecto el equipo del jugador local va a la izquierda)

(function () {
  var q = new URLSearchParams(location.search);
  var token = q.get("token") || "";
  var swap = q.get("swap") === "1";
  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws" +
    (token ? "?token=" + encodeURIComponent(token) : "");

  var S = {};
  var $ = function (id) { return document.getElementById(id); };

  function getPath(path) {
    var cur = S;
    var segs = path.split("/");
    for (var i = 0; i < segs.length; i++) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[segs[i]];
    }
    return cur;
  }

  function setPath(path, value) {
    var segs = path.split("/");
    var cur = S;
    for (var i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]] == null || typeof cur[segs[i]] !== "object") cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }

  function parse(content) {
    if (typeof content !== "string") return content == null ? null : content;
    try { return JSON.parse(content); } catch (e) { return content; }
  }

  function send(type, content) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ Type: type, Content: content }));
  }

  var ws = null;
  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = function () {
      send("Subscribe", "lolInGame/stats");
      send("Subscribe", "lolChampSelect/admin");
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m && m.Type === "Update" && m.Path) {
        setPath(m.Path, parse(m.Content));
        render();
      }
    };
    ws.onclose = function () { setTimeout(connect, 2000); };
    ws.onerror = function () {};
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (m < 10 ? "0" : "") + m, ss = (sec < 10 ? "0" : "") + sec;
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function fmtGold(n) {
    n = Math.round(n || 0);
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }

  function fmtLead(n) {
    return "+" + Math.round(n).toLocaleString("en-US");
  }

  function color(c, fallback) {
    return c && typeof c === "string" ? c : fallback;
  }

  function render() {
    var stats = getPath("lolInGame/stats");
    var stage = $("stage");
    stage.classList.toggle("live", !!stats && !!stats.teams);
    if (!stats || !stats.teams) return;

    var admin = getPath("lolChampSelect/admin") || {};
    var localTeam = stats.localTeam === "CHAOS" ? "CHAOS" : "ORDER";
    var leftKey = swap ? (localTeam === "ORDER" ? "CHAOS" : "ORDER") : localTeam;
    var rightKey = leftKey === "ORDER" ? "CHAOS" : "ORDER";
    var L = stats.teams[leftKey], R = stats.teams[rightKey];

    var root = document.documentElement.style;
    root.setProperty("--left", color(admin.leftTeamColor, "rgb(180,28,49)"));
    root.setProperty("--right", color(admin.rightTeamColor, "rgb(89,140,245)"));

    // Equipos
    $("tagL").textContent = admin.leftTeamName || "";
    $("tagR").textContent = admin.rightTeamName || "";
    $("seriesL").textContent = admin.leftTeamScore != null && admin.leftTeamScore !== "" ? admin.leftTeamScore : "";
    $("seriesR").textContent = admin.rightTeamScore != null && admin.rightTeamScore !== "" ? admin.rightTeamScore : "";
    setLogo($("logoL"), admin.leftTeamIcon);
    setLogo($("logoR"), admin.rightTeamIcon);

    // Cifras
    $("killsL").textContent = L.kills;
    $("killsR").textContent = R.kills;
    $("towersL").textContent = L.towers;
    $("towersR").textContent = R.towers;
    $("goldL").textContent = fmtGold(L.gold);
    $("goldR").textContent = fmtGold(R.gold);
    $("clock").textContent = fmtTime(stats.time);

    // Ventaja de oro (positiva = ORDER)
    var diffForLeft = leftKey === "ORDER" ? stats.goldDiff : -stats.goldDiff;
    var leadL = $("leadL"), leadR = $("leadR");
    leadL.classList.toggle("show", diffForLeft > 0);
    leadR.classList.toggle("show", diffForLeft < 0);
    leadL.textContent = diffForLeft > 0 ? fmtLead(diffForLeft) : "";
    leadR.textContent = diffForLeft < 0 ? fmtLead(-diffForLeft) : "";

    // Dragones
    $("dragonsL").innerHTML = dragonDots(L.dragons);
    $("dragonsR").innerHTML = dragonDots(R.dragons);

    // Buff
    var buff = stats.buff;
    var panel = $("buff");
    panel.classList.toggle("show", !!buff);
    if (buff) {
      var holderLeft = buff.team === leftKey;
      panel.style.setProperty("--bc", holderLeft ? "var(--left)" : "var(--right)");
      $("btitle").textContent = (buff.type === "ELDER" ? "ELDER" : "BARON") + " BUFF";
      $("btime").textContent = fmtTime(buff.remaining);
      $("bfill").style.width = Math.max(0, Math.min(100, (buff.remaining / buff.duration) * 100)) + "%";
      var diff = Math.abs(stats.goldDiff);
      var leaderLeft = diffForLeft >= 0;
      var tag = (leaderLeft ? admin.leftTeamName : admin.rightTeamName) || "";
      $("blead").textContent = diff > 0 ? fmtLead(diff) + " " + tag : "";
    }
  }

  function setLogo(img, file) {
    var src = file ? "assets/teams/" + file : "";
    if (src && img.getAttribute("src") !== src) img.setAttribute("src", src);
    if (!src) img.removeAttribute("src");
  }

  function dragonDots(list) {
    return (list || []).map(function (t) {
      return '<span class="dr ' + String(t).toLowerCase().replace(/[^a-z]/g, "") + '"></span>';
    }).join("");
  }

  connect();
})();
