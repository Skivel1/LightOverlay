// state.js se suscribe a admin/session/summoners al conectar si initDone es true
var initDone = true;
function Main() {}
function UpdatePB() {}
function UpdateChampionData() { populate(); }   // state.js lo llama en cada cambio de lolChampSelect/admin

function adminData() { return (_S.lolChampSelect && _S.lolChampSelect.admin) || {}; }
function plain(v) { return (v == null ? "" : String(v)).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim(); }

var inputs = Array.prototype.slice.call(document.querySelectorAll("[data-k]"));

function populate() {
    var a = adminData();
    document.getElementById("status").textContent = "conectado";
    inputs.forEach(function (inp) {
        if (document.activeElement === inp) return;          // no pisar lo que se esta escribiendo
        var v = plain(a[inp.dataset.k]);
        if (inp.value !== v) inp.value = v;
    });
}

inputs.forEach(function (inp) {
    var timer = null;
    inp.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
            var path = "lolChampSelect/admin/" + inp.dataset.k;
            UpdatePath(inp, path, inp.value);
            SendMessage("Update", inp.value, path);
        }, 250);
    });
});
