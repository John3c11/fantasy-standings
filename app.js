/* Durr Butt Fantasy — reads the league Google Sheet live and renders the site. */
(function () {
  "use strict";

  const CFG = window.LEAGUE_CONFIG;
  const app = document.getElementById("app");
  document.getElementById("tagline").textContent = CFG.tagline;

  /* ============================== data ============================== */

  const cache = {};

  // The plain CSV export keeps every cell as typed. The gviz endpoint is the fallback, but it
  // blanks out text in a mostly-number column (that's how "Round 1" in Week went missing).
  function exportUrl(gid) {
    return "https://docs.google.com/spreadsheets/d/" + CFG.sheetId + "/export?format=csv&gid=" + gid;
  }
  function sheetUrl(gid) {
    return "https://docs.google.com/spreadsheets/d/" + CFG.sheetId +
      "/gviz/tq?tqx=out:csv&headers=1&gid=" + gid;
  }
  function fetchCsv(gid) {
    const get = (url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then((t) => {
      if (/^\s*<(!doctype|html)/i.test(t)) throw new Error("Got a web page instead of CSV");
      return t;
    });
    return get(exportUrl(gid)).catch(() => get(sheetUrl(gid)));
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toObjects(rows) {
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const o = {};
      let any = false;
      head.forEach((h, i) => {
        if (!h) return;
        const v = (rows[r][i] || "").trim();
        o[h] = v;
        if (v !== "") any = true;
      });
      if (any) { Object.defineProperty(o, "_row", { value: r + 1 }); out.push(o); }
    }
    out.columns = head.filter(Boolean);
    return out;
  }

  function load(tab) {
    if (!cache[tab]) {
      cache[tab] = fetchCsv(CFG.tabs[tab])
        .then((t) => toObjects(parseCSV(t)))
        .then((rows) => (tab === "games" ? tidyNames(rows, ["Player 1", "Player 2", "Winner"]) : rows));
    }
    return cache[tab];
  }

  // "keenan", "Keenan " or "Keen​an" in a typed row all become the usual "Keenan"
  function tidyNames(rows, cols) {
    const key = (v) => v.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const counts = {};
    rows.forEach((r) => cols.forEach((c) => {
      if (!r[c]) return;
      const k = key(r[c]);
      (counts[k] = counts[k] || {})[r[c]] = (counts[k][r[c]] || 0) + 1;
    }));
    const best = {};
    Object.keys(counts).forEach((k) => {
      best[k] = Object.keys(counts[k]).sort((a, b) => counts[k][b] - counts[k][a])[0];
    });
    rows.forEach((r) => cols.forEach((c) => { if (r[c]) r[c] = best[key(r[c])]; }));
    return rows;
  }

  function loadMany(names) {
    // MVPs are rebuilt from Moves so a team defense can never be a team's MVP.
    const want = names.includes("mvps") && !names.includes("moves") ? names.concat(["moves"]) : names;
    return Promise.all(want.map(load)).then((arr) => {
      const o = {};
      want.forEach((n, i) => (o[n] = arr[i]));
      if (o.mvps && o.moves) o.mvps = playerMvps(o.mvps, o.moves);
      return o;
    });
  }

  /* ---------- team defenses ---------- */
  const isDefPos = (p) => /^(DEF|D\/ST|DST|D)$/i.test(String(p || "").trim());

  // Each team's MVP for a season = most started points by one non-defense player (all stints added up).
  const mvpCache = new WeakMap();
  // Defense names: anything that sat in a DEF slot, has no Yahoo player ID, or is listed as DEF in Positions.
  function defenseNames(rosters, positions) {
    const set = new Set();
    rosters.forEach((r) => { if (r.Player && r.Player !== "(Empty)" && (isDefPos(r.Slot) || !r["Player ID"])) set.add(r.Player); });
    (positions || []).forEach((r) => { if (r.Player && isDefPos(r["Final Pos"] || r["Derived Pos"])) set.add(r.Player); });
    return set;
  }

  function playerMvps(sheetMvps, moves) {
    if (mvpCache.has(moves)) return mvpCache.get(moves);
    const team = {}, per = {};
    moves.forEach((r) => {
      if (!r.Year || !r.Manager || !r.Player) return;
      const pts = num(r["Started Pts"]) || 0;
      const tk = r.Year + "|" + r.Manager;
      team[tk] = (team[tk] || 0) + pts;
      if (isDefPos(r.Pos)) return;
      const pk = tk + "|" + r.Player;
      const o = (per[pk] = per[pk] || { Year: r.Year, Manager: r.Manager, MVP: r.Player, Pos: r.Pos, Acquired: r["How Acquired"], pts: 0, first: 99 });
      o.pts += pts;
      const fw = num(r["First Week"]);
      if (fw < o.first) { o.first = fw; o.Acquired = r["How Acquired"]; }
    });
    const best = {};
    Object.values(per).forEach((o) => {
      const tk = o.Year + "|" + o.Manager;
      if (!best[tk] || o.pts > best[tk].pts) best[tk] = o;
    });
    const out = Object.keys(best).filter((k) => best[k].pts > 0).map((k) => {
      const o = best[k];
      return { Year: o.Year, Manager: o.Manager, MVP: o.MVP, Pos: o.Pos, Acquired: o.Acquired,
        "Started Pts": o.pts.toFixed(2), "Share of Team Pts": team[k] ? (o.pts / team[k] * 100).toFixed(0) + "%" : "" };
    });
    // keep any sheet MVP row Moves can't rebuild, unless it's a defense
    sheetMvps.forEach((r) => {
      if (!best[r.Year + "|" + r.Manager] && !isDefPos(r.Pos)) out.push(r);
    });
    out.columns = sheetMvps.columns;
    mvpCache.set(moves, out);
    return out;
  }

  /* ============================== helpers ============================== */

  // Strict like Sheets: "1,210.5", "+3.2" and "85%" are numbers; "112,4", "12 pts" or "1O5" are not.
  function num(v) {
    if (v === undefined || v === null) return NaN;
    let s = String(v).trim();
    if (s === "") return NaN;
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?%?$/.test(s)) s = s.replace(/,/g, "");
    const pctSign = s.endsWith("%");
    if (pctSign) s = s.slice(0, -1).trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
    const n = parseFloat(s);
    return pctSign ? n / 100 : n;
  }
  const isNum = (v) => !isNaN(num(v));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d) => (isNum(v) ? num(v).toFixed(d == null ? 2 : d) : esc(v || "—"));
  const pct = (v, d) => (isNum(v) ? (num(v) * 100).toFixed(d == null ? 1 : d) + "%" : "—");
  const signed = (v, d) => {
    if (!isNum(v)) return "—";
    const n = num(v);
    return (n > 0 ? "+" : "") + n.toFixed(d == null ? 1 : d);
  };
  const wins = (rec) => { const m = String(rec || "").match(/^(\d+)-(\d+)/); return m ? +m[1] : 0; };
  const losses = (rec) => { const m = String(rec || "").match(/^(\d+)-(\d+)/); return m ? +m[2] : 0; };
  const uniq = (a) => Array.from(new Set(a));
  const isRegularWeek = (w) => /^\d+$/.test(String(w).trim());
  const link = (route, text, cls) => '<a href="#/' + route + '"' + (cls ? ' class="' + cls + '"' : "") + ">" + esc(text) + "</a>";
  const enc = encodeURIComponent;
  const plink = (name) => (name ? '<a class="plink" href="#/player/' + enc(name) + '">' + esc(name) + "</a>" : "");

  function playedGames(games) {
    return games.filter((g) => g["Player 1"] && isNum(g["P1 Points"]) && isNum(g["P2 Points"]));
  }

  function years(standings) {
    return uniq(standings.map((r) => r.Year).filter(isNum)).sort((a, b) => b - a);
  }

  function managers(allTime) {
    return allTime.map((r) => r.Player).filter(Boolean).sort();
  }

  /* sortable table: cols = [{key, label, num, render, sortVal, cls}] */
  function table(id, cols, rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<p class="empty">' + esc(opts.empty || "Nothing here yet.") + "</p>";
    const st = tableState[id] || { key: opts.sortKey, asc: !!opts.sortAsc };
    tableState[id] = st;
    let data = rows.slice();
    if (st.key) {
      const col = cols.find((c) => c.key === st.key);
      const val = col && col.sortVal ? col.sortVal : (r) => (col && col.num ? num(r[st.key]) : String(r[st.key] || ""));
      data.sort((a, b) => {
        let x = val(a), y = val(b);
        if (typeof x === "number" && isNaN(x)) x = st.asc ? Infinity : -Infinity;
        if (typeof y === "number" && isNaN(y)) y = st.asc ? Infinity : -Infinity;
        return (x < y ? -1 : x > y ? 1 : 0) * (st.asc ? 1 : -1);
      });
    }
    const head = cols.map((c) => {
      const sorted = st.key === c.key;
      const cls = [c.num ? "num" : "", opts.sortable === false ? "" : "sortable", sorted ? "sorted" : "", sorted && st.asc ? "asc" : ""].join(" ");
      const inner = opts.sortable === false ? esc(c.label)
        : '<button type="button" data-table="' + id + '" data-key="' + esc(c.key) + '">' + esc(c.label) + "</button>";
      return '<th scope="col" class="' + cls + '"' + (sorted ? ' aria-sort="' + (st.asc ? "ascending" : "descending") + '"' : "") + ">" + inner + "</th>";
    }).join("");
    const body = data.map((r, i) => {
      const rc = opts.rowClass ? opts.rowClass(r) : "";
      return '<tr class="' + rc + '">' + cols.map((c) =>
        '<td class="' + (c.cls || (c.num ? "num" : "")) + '">' + (c.render ? c.render(r, i) : esc(r[c.key])) + "</td>").join("") + "</tr>";
    }).join("");
    return '<div class="scroll"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }
  const tableState = {};

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-table]");
    if (!b) return;
    const st = tableState[b.dataset.table];
    if (st.key === b.dataset.key) st.asc = !st.asc;
    else { st.key = b.dataset.key; st.asc = false; }
    route();
  });

  function section(title, inner, kicker) {
    return '<section class="section"><div class="section-head"><h2>' + esc(title) + "</h2>" +
      (kicker ? '<span class="kicker">' + kicker + "</span>" : "") + "</div>" + inner + "</section>";
  }

  // One compact bar of filters. Each group: { label, type: "select" | "seg", items: [[route, text]], current: route }
  function filterBar(groups) {
    return '<div class="fbar">' + groups.map((g) => {
      if (g.type === "seg") {
        return '<div class="fseg" role="group" aria-label="' + esc(g.label) + '">' + g.items.map((it) =>
          '<a class="fseg-btn' + (it[0] === g.current ? " on" : "") + '" href="#/' + it[0] + '"' + (it[0] === g.current ? ' aria-current="page"' : "") + ">" + esc(it[1]) + "</a>").join("") + "</div>";
      }
      return '<label class="fsel"><span>' + esc(g.label) + '</span><select data-go>' + g.items.map((it) =>
        '<option value="' + esc(it[0]) + '"' + (it[0] === g.current ? " selected" : "") + ">" + esc(it[1]) + "</option>").join("") + "</select></label>";
    }).join("") + "</div>";
  }
  app.addEventListener("change", (e) => {
    if (e.target.matches && e.target.matches("select[data-go]")) location.hash = "#/" + e.target.value;
  });

  function chips(items, current, routeFor) {
    return '<div class="chips">' + items.map((it) =>
      '<a class="chip' + (String(it) === String(current) ? " on" : "") + '" href="#/' + routeFor(it) + '"' +
      (String(it) === String(current) ? ' aria-current="page"' : "") + ">" + esc(it) + "</a>").join("") + "</div>";
  }

  // Who won: higher score, unless the Winner cell in Games says "Tie" (e.g. the 2022 final).
  const declaredTie = (g) => /^tie$/i.test(String(g.Winner || "").trim());
  function gameWinner(g) {
    if (declaredTie(g)) return "";
    const a = num(g["P1 Points"]), b = num(g["P2 Points"]);
    return a > b ? g["Player 1"] : b > a ? g["Player 2"] : "";
  }

  function scoreCard(g, label) {
    const a = num(g["P1 Points"]), b = num(g["P2 Points"]), w = gameWinner(g);
    if (!w) label = (label ? label + " · " : "") + (declaredTie(g) ? "Declared a tie" : "Tie");
    const row = (who, pts, won) => '<div class="game-row' + (won ? " won" : "") + '"><span class="who">' + esc(who) +
      '</span><span class="pts">' + pts.toFixed(2) + "</span></div>";
    return '<a class="game" href="#/game/' + gameRoute(g.Year, g.Week, g["Player 1"], g["Player 2"]) + '" aria-label="Box score: ' +
      esc(g["Player 1"]) + " vs " + esc(g["Player 2"]) + '">' + (label ? '<div class="game-label">' + esc(label) + "</div>" : "") +
      row(g["Player 1"], a, w === g["Player 1"]) + row(g["Player 2"], b, w === g["Player 2"]) + "</a>";
  }

  function gameRoute(y, w, a, b) { return [y, w, a, b].map(enc).join("/"); }

  /* playoff labels -> the NFL week their rosters live in */
  function rosterWeek(w) {
    const t = String(w).toLowerCase().trim();
    if (/^\d+$/.test(t)) return +t;
    const n = +(t.match(/\d+/) || [0])[0];
    if (/3rd/.test(t)) return 17;
    if (/5th/.test(t)) return 16;
    return 14 + n;
  }

  function weekSortKey(w) { return rosterWeek(w) * 10 + (/round/i.test(w) ? 0 : /3rd|5th/i.test(w) ? 1 : 2); }

  /* ============================== elo ============================== */

  const COLORS = ["#FFB000", "#F5F5F0", "#7CC6FE", "#FF8A80", "#C3B1E1", "#FFD6A5", "#80DEEA", "#F48FB1", "#B5E48C", "#FFE066"];

  function eloSeries(elo) {
    const names = (elo.columns || []).filter((c) => c !== "Week");
    const weeks = elo.map((r) => r.Week);
    const series = names.map((n, i) => ({ name: n, color: COLORS[i % COLORS.length], vals: elo.map((r) => num(r[n])) }));
    return { weeks, series };
  }

  let eloFocus = null;

  function eloChart(elo, only) {
    const { weeks, series } = eloSeries(elo);
    const show = only ? series.filter((s) => s.name === only) : series;
    if (!weeks.length || !show.length) return '<p class="note">No Elo data yet.</p>';
    const W = 1100, H = 420, L = 54, R = 16, T = 16, B = 46;
    const all = show.flatMap((s) => s.vals.filter((v) => !isNaN(v)));
    let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    lo = Math.floor((lo - 15) / 50) * 50; hi = Math.ceil((hi + 15) / 50) * 50;
    const x = (i) => L + (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let grid = "";
    for (let v = lo; v <= hi; v += 50) {
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="rgba(245,245,240,0.15)"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(v) + 5) + '" text-anchor="end" fill="#C9D6CB" font-family="Share Tech Mono" font-size="14">' + v + "</text>";
    }
    // season boundaries + labels
    let lastYear = "";
    weeks.forEach((w, i) => {
      const yr = String(w).slice(0, 4);
      if (yr !== lastYear) {
        lastYear = yr;
        grid += '<line x1="' + x(i) + '" x2="' + x(i) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="rgba(245,245,240,0.35)" stroke-dasharray="4 4"/>' +
          '<text x="' + (x(i) + 4) + '" y="' + (H - B + 22) + '" fill="#F5F5F0" font-family="Saira Condensed" font-weight="700" font-size="17">' + yr + "</text>";
      }
    });
    const lines = show.map((s) => {
      const dim = !only && eloFocus && eloFocus !== s.name;
      const pts = s.vals.map((v, i) => (isNaN(v) ? null : x(i).toFixed(1) + "," + y(v).toFixed(1))).filter(Boolean).join(" ");
      return '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="' + (eloFocus === s.name || only ? 4 : 2.5) +
        '" stroke-linejoin="round" opacity="' + (dim ? 0.18 : 1) + '"/>';
    }).join("");
    const svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Elo rating over time' + (only ? " for " + esc(only) : "") + '">' + grid + lines + "</svg>";
    const legend = only ? "" : '<div class="legend">' + series.map((s) =>
      '<button type="button" data-elo="' + esc(s.name) + '" class="' + (eloFocus === s.name ? "on" : "") + '" aria-pressed="' + (eloFocus === s.name) + '">' +
      '<span class="sw" style="background:' + s.color + '"></span>' + esc(s.name) + "</button>").join("") + "</div>";
    return '<div class="chart">' + svg + legend + "</div>";
  }

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-elo]");
    if (!b) return;
    eloFocus = eloFocus === b.dataset.elo ? null : b.dataset.elo;
    route();
  });

  function eloTable(elo) {
    const { weeks, series } = eloSeries(elo);
    if (!weeks.length) return "";
    const n = weeks.length;
    const rows = series.map((s) => {
      const v = s.vals;
      const cur = v[n - 1];
      let pk = -Infinity, pkw = "", lo = Infinity;
      v.forEach((x, i) => { if (x > pk) { pk = x; pkw = weeks[i]; } if (x < lo) lo = x; });
      const back = v[Math.max(0, n - 4)];
      return { name: s.name, elo: cur, peak: pk, peakWeek: pkw, low: lo, trend: cur - back };
    });
    rows.sort((a, b) => b.elo - a.elo);
    rows.forEach((r, i) => (r.rank = i + 1));
    return table("elo", [
      { key: "rank", label: "#", num: true, cls: "rank", render: (r) => r.rank, sortVal: (r) => r.rank },
      { key: "name", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.name), r.name) },
      { key: "elo", label: "Elo", num: true, render: (r) => r.elo.toFixed(0), sortVal: (r) => r.elo },
      { key: "trend", label: "Last 3 Wks", num: true, sortVal: (r) => r.trend,
        render: (r) => '<span class="' + (r.trend > 0 ? "pos" : r.trend < 0 ? "neg" : "") + '">' + signed(r.trend, 0) + "</span>" },
      { key: "peak", label: "Peak", num: true, render: (r) => r.peak.toFixed(0), sortVal: (r) => r.peak },
      { key: "peakWeek", label: "Peak Week", render: (r) => esc(r.peakWeek) },
      { key: "low", label: "Lowest", num: true, render: (r) => r.low.toFixed(0), sortVal: (r) => r.low },
    ], rows, { sortKey: "elo" });
  }

  /* ============================== pages ============================== */

  function standingsCols() {
    return [
      { key: "Player", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Player), r.Player) },
      { key: "Record", label: "Record", num: true, sortVal: (r) => wins(r.Record) * 1000 + num(r["Points For"]) / 10 },
      { key: "Avg Points", label: "Avg", num: true, render: (r) => fmt(r["Avg Points"]) },
      { key: "Avg Points Against", label: "Avg Agst", num: true, render: (r) => fmt(r["Avg Points Against"]) },
      { key: "Points For", label: "PF", num: true, render: (r) => fmt(r["Points For"]) },
      { key: "Points Against", label: "PA", num: true, render: (r) => fmt(r["Points Against"]) },
      { key: "High Score", label: "High", num: true, render: (r) => fmt(r["High Score"]) },
      { key: "All-Play Record", label: "All-Play", num: true, sortVal: (r) => wins(r["All-Play Record"]) },
      { key: "Luck", label: "Luck", num: true, render: (r) => '<span class="' + (num(r.Luck) > 0 ? "pos" : num(r.Luck) < 0 ? "neg" : "") + '">' + signed(r.Luck) + "</span>" },
      { key: "Weekly Highs", label: "Wk Highs", num: true },
      { key: "Weekly Lows", label: "Wk Lows", num: true },
      { key: "Place", label: "Finish", num: true, render: (r) => (isNum(r.Place) ? "#" + r.Place : "—") },
    ];
  }

  function pageHome() {
    return loadMany(["games", "standings", "elo"]).then((d) => {
      const yrs = years(d.standings);
      const yr = yrs[0];
      const played = playedGames(d.games).filter((g) => g.Year === yr);
      const reg = played.filter((g) => isRegularWeek(g.Week));
      const lastWeek = reg.length ? Math.max.apply(null, reg.map((g) => +g.Week)) : null;
      const post = played.filter((g) => !isRegularWeek(g.Week));
      const latest = post.length ? post.slice(-4) : reg.filter((g) => +g.Week === lastWeek);
      const latestLabel = post.length ? "Playoffs" : "Week " + lastWeek;
      const st = d.standings.filter((r) => r.Year === yr);
      const html =
        '<div class="hero"><span class="kicker">' + esc(yr) + " season · " + esc(latestLabel) + "</span><h1>" + esc(CFG.name) + " Fantasy</h1></div>" +
        section(latestLabel + " results", '<div class="scores">' + latest.map((g) => scoreCard(g, post.length ? g.Week : "")).join("") + "</div>",
          latest.length ? link("recap/" + enc(yr) + "/" + enc(latest[latest.length - 1].Week), "Read the recap →") : "") +
        '<div class="grid-2">' +
        section(yr + " standings", table("home-st", [
          { key: "Player", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Player), r.Player) },
          { key: "Record", label: "W-L", num: true, sortVal: (r) => wins(r.Record) * 1000 + num(r["Points For"]) / 10 },
          { key: "Points For", label: "PF", num: true, render: (r) => fmt(r["Points For"]) },
          { key: "Luck", label: "Luck", num: true, render: (r) => signed(r.Luck) },
        ], st, { sortKey: "Record" }), link("preview", "This week’s matchups →") + " &nbsp; " + link("odds", "Playoff odds →") + " &nbsp; " + link("season/" + yr, "Full season →")) +
        section("Power rankings", eloTableCompact(d.elo), link("rankings", "Elo chart →")) +
        "</div>";
      return html;
    });
  }

  function eloTableCompact(elo) {
    const { weeks, series } = eloSeries(elo);
    if (!weeks.length) return '<p class="note">No Elo data yet.</p>';
    const n = weeks.length;
    const rows = series.map((s) => ({ name: s.name, elo: s.vals[n - 1], trend: s.vals[n - 1] - s.vals[Math.max(0, n - 4)] }))
      .sort((a, b) => b.elo - a.elo);
    return table("home-elo", [
      { key: "rank", label: "#", cls: "rank", render: (r, i) => i + 1 },
      { key: "name", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.name), r.name) },
      { key: "elo", label: "Elo", num: true, render: (r) => r.elo.toFixed(0) },
      { key: "trend", label: "3 Wk", num: true, render: (r) => '<span class="' + (r.trend > 0 ? "pos" : r.trend < 0 ? "neg" : "") + '">' + signed(r.trend, 0) + "</span>" },
    ], rows, { sortable: false });
  }

  function pageSeason(yrArg) {
    return loadMany(["standings", "games", "mvps", "lineupIQ", "projections"]).then((d) => {
      const yrs = years(d.standings);
      const yr = yrs.includes(yrArg) ? yrArg : yrs[0];
      const st = d.standings.filter((r) => r.Year === yr);
      const hasPlace = st.some((r) => isNum(r.Place));
      const lastPlace = st.length;
      const html = [];
      html.push('<div class="hero"><span class="kicker">Season</span><h1>' + esc(yr) + "</h1></div>");
      html.push(chips(yrs, yr, (y) => "season/" + y));
      html.push(section("Standings", table("season-st-" + yr, standingsCols(), st, {
        sortKey: hasPlace ? "Place" : "Record", sortAsc: hasPlace,
        rowClass: (r) => (num(r.Place) === 1 ? "gold" : num(r.Place) === lastPlace ? "last" : ""),
      }), "Tap a column to sort"));

      const post = playedGames(d.games).filter((g) => g.Year === yr && !isRegularWeek(g.Week));
      const mb = playoffBracket(d.games, yr, true);
      if (mb) html.push(mb);

      const mv = d.mvps.filter((r) => r.Year === yr);
      if (mv.length) html.push(section("Team MVPs", table("season-mvp-" + yr, [
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "MVP", label: "MVP", cls: "name", render: (r) => plink(r.MVP) },
        { key: "Pos", label: "Pos" },
        { key: "Acquired", label: "Acquired" },
        { key: "Started Pts", label: "Started Pts", num: true, render: (r) => fmt(r["Started Pts"]) },
        { key: "Share of Team Pts", label: "Share", num: true },
      ], mv, { sortKey: "Started Pts" })));

      const iq = d.lineupIQ.filter((r) => r.Year === yr);
      if (iq.length) html.push(section("Lineup IQ", table("season-iq-" + yr, [
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "Lineup Efficiency", label: "Efficiency", num: true, render: (r) => pct(r["Lineup Efficiency"]) },
        { key: "Bench Pts Left", label: "Bench Pts Left", num: true, render: (r) => fmt(r["Bench Pts Left"], 1) },
        { key: "Self-Inflicted Losses", label: "Self-Inflicted Ls", num: true },
        { key: "Started on Bye", label: "Started on Bye", num: true },
        { key: "Started a Zero", label: "Started a Zero", num: true },
      ], iq, { sortKey: "Lineup Efficiency" }), "Weeks 1–14"));

      const pj = projectionSummary(d.projections, (r) => r.Year === yr, "Manager");
      if (pj.length) html.push(section("Projections", table("season-pj-" + yr, projCols("Manager"), pj, { sortKey: "luck" }),
        "Proj Luck = actual wins − projected wins"));
      return html.join("");
    });
  }

  /* ============================== playoff bracket ============================== */

  // Seeds = regular-season wins, then points for (top 6 make it, top 2 get byes).
  function seedsFor(games, yr) {
    const t = {};
    playedGames(games).filter((g) => g.Year === yr && isRegularWeek(g.Week) && +g.Week <= 14).forEach((g) => {
      const a = num(g["P1 Points"]), b = num(g["P2 Points"]);
      [[g["Player 1"], a, b], [g["Player 2"], b, a]].forEach(([m, pf, pa]) => {
        const o = (t[m] = t[m] || { m: m, w: 0, pf: 0 });
        o.pf += pf;
        if (pf > pa) o.w += 1; else if (pf === pa) o.w += 0.5;
      });
    });
    return Object.values(t).sort((x, y) => y.w - x.w || y.pf - x.pf).map((o) => o.m);
  }

  // mini = small, non-interactive copy for the Season page (the whole thing links to the full bracket)
  function playoffBracket(games, yr, mini) {
    let seeds = seedsFor(games, yr);
    if (seeds.length < 6) return "";
    {
      const pg = playedGames(games).filter((g) => g.Year === yr);
      const inR = (re) => new Set(pg.filter((g) => re.test(g.Week)).flatMap((g) => [g["Player 1"], g["Player 2"]]));
      const r1s = inR(/round\s*1/i), r2s = inR(/round\s*2/i);
      if (r1s.size === 4) {
        const byes = r2s.size ? seeds.filter((m) => r2s.has(m) && !r1s.has(m)) : [];
        if (byes.length === 2 || !r2s.size) {
          const top2 = byes.length === 2 ? byes : seeds.filter((m) => !r1s.has(m)).slice(0, 2);
          seeds = top2.concat(seeds.filter((m) => r1s.has(m)), seeds.filter((m) => !r1s.has(m) && !top2.includes(m)));
        }
      }
    }
    const seedOf = {};
    seeds.forEach((m, i) => (seedOf[m] = i + 1));
    const post = playedGames(games).filter((g) => g.Year === yr && !isRegularWeek(g.Week));
    const regWeeks = playedGames(games).filter((g) => g.Year === yr && isRegularWeek(g.Week)).map((g) => +g.Week);
    const projected = !post.length && Math.max.apply(null, regWeeks.concat([0])) < 14;
    const byLabel = (re) => post.filter((g) => re.test(g.Week));
    const has = (g, m) => g && (g["Player 1"] === m || g["Player 2"] === m);
    const winner = (g) => (g && g.played ? gameWinner(g) : "");
    const tied = (g) => g && g.played && !gameWinner(g);
    const loser = (g) => (g && g.played ? (winner(g) === g["Player 1"] ? g["Player 2"] : g["Player 1"]) : "");
    const mark = (g) => (g ? Object.assign({ played: true }, g) : null);
    const stub = (a, b, wk) => ({ "Player 1": a || "", "Player 2": b || "", Week: wk, Year: yr, played: false });
    const r1 = byLabel(/round\s*1/i), r2 = byLabel(/round\s*2/i), fin = byLabel(/round\s*3|final|champ/i);
    const [s1, s2, s3, s4, s5, s6] = seeds;
    // Round 1: 4v5 feeds the 1 seed, 3v6 feeds the 2 seed
    const r1Top = mark(r1.find((g) => has(g, s4) || has(g, s5))) || stub(s4, s5, "Round 1");
    const r1Bot = mark(r1.find((g) => (has(g, s3) || has(g, s6)) && !(r1Top.played && g.Week === r1Top.Week && g["Player 1"] === r1Top["Player 1"] && g["Player 2"] === r1Top["Player 2"])) ||
      r1.find((g) => !(r1Top.played && g["Player 1"] === r1Top["Player 1"] && g["Player 2"] === r1Top["Player 2"]))) || stub(s3, s6, "Round 1");
    const semiTop = mark(r2.find((g) => has(g, s1))) || stub(s1, winner(r1Top), "Round 2");
    const semiBot = mark(r2.find((g) => has(g, s2))) || stub(s2, winner(r1Bot), "Round 2");
    const final = mark(fin[0]) || stub(winner(semiTop), winner(semiBot), "Round 3");
    // if the league re-seeded, draw each Round 1 game next to the semifinal its winner actually played in
    if (r1Top.played && r1Bot.played && semiTop.played && has(semiTop, winner(r1Bot)) && !has(semiTop, winner(r1Top))) {
      const t = Object.assign({}, r1Top);
      Object.assign(r1Top, r1Bot); Object.assign(r1Bot, t);
    }
    const champ = winner(final);
    const coChamps = tied(final) ? [final["Player 1"], final["Player 2"]] : null;

    const line = (g, side, other) => {
      const m = g[side], pts = num(g[side === "Player 1" ? "P1 Points" : "P2 Points"]);
      const won = g.played && (m === winner(g) || tied(g));
      return '<div class="bk-team' + (won ? " won" : "") + (g.played && !won ? " out" : "") + '"><span class="bk-seed">' + (m && seedOf[m] ? seedOf[m] : "") +
        '</span><span class="bk-name">' + (m ? esc(m) : "TBD") + '</span><span class="bk-pts">' + (g.played ? pts.toFixed(2) : "") + "</span></div>";
    };
    const box = (g) => {
      // higher seed on top
      const flip = g["Player 1"] && g["Player 2"] && (seedOf[g["Player 1"]] || 99) > (seedOf[g["Player 2"]] || 99);
      const inner = flip ? line(g, "Player 2") + line(g, "Player 1") : line(g, "Player 1") + line(g, "Player 2");
      if (mini) return '<div class="bk-match' + (g.played ? "" : " pending") + '">' + inner + "</div>";
      return g.played
        ? '<a class="bk-match" href="#/game/' + gameRoute(g.Year, g.Week, g["Player 1"], g["Player 2"]) + '" aria-label="Box score: ' + esc(g["Player 1"]) + " vs " + esc(g["Player 2"]) + '">' + inner + "</a>"
        : '<div class="bk-match pending">' + inner + "</div>";
    };

    const champName = (m) => (mini ? '<span class="bk-champ-name">' + esc(m) + "</span>" : link("career/" + enc(m), m));
    const grid =
      '<div class="bracket' + (mini ? " mini" : "") + '">' +
      '<div class="bk-col"><div class="bk-head">Round 1</div><div class="bk-slots">' +
        '<div class="bk-slot">' + box(r1Top) + "</div>" +
        '<div class="bk-slot">' + box(r1Bot) + "</div></div></div>" +
      '<div class="bk-col"><div class="bk-head">Semifinals</div><div class="bk-slots join">' +
        '<div class="bk-slot">' + box(semiTop) + "</div>" +
        '<div class="bk-slot">' + box(semiBot) + "</div></div></div>" +
      '<div class="bk-col"><div class="bk-head">Final</div><div class="bk-slots">' +
        '<div class="bk-slot">' + box(final) + "</div></div></div>" +
      '<div class="bk-col last"><div class="bk-head">Champion</div><div class="bk-slots">' +
        '<div class="bk-slot"><div class="bk-champ' + (champ || coChamps ? "" : " tbd") + '">' +
        (coChamps ? '<span class="bk-trophy">Co-champions</span>' + coChamps.map(champName).join("") +
          (declaredTie(final) ? '<span class="bk-why">Final declared a tie</span>' : "")
          : champ ? '<span class="bk-trophy">Champion</span>' + champName(champ) : "TBD") +
        "</div></div></div></div>" +
      "</div>";
    if (mini) {
      return section(projected ? "Playoff picture" : "Playoffs",
        '<a class="bk-mini" href="#/games/' + enc(yr) + '/bracket" aria-label="Open the full ' + esc(yr) + ' bracket">' + grid + "</a>",
        link("games/" + enc(yr) + "/bracket", "Full bracket →"));
    }
    const bracket = '<div class="scroll">' + grid + "</div>" +
      '<p class="note bk-note">Byes: ' + esc(s1) + " (1 seed) and " + esc(s2) + " (2 seed). Seeds by regular-season wins, then points for.</p>";

    // everything else: 3rd place, 5th place, toilet bowl
    const used = new Set([r1Top, r1Bot, semiTop, semiBot, final].filter((g) => g.played).map((g) => g.Week + "|" + g["Player 1"] + "|" + g["Player 2"]));
    const rest = post.filter((g) => !used.has(g.Week + "|" + g["Player 1"] + "|" + g["Player 2"]));
    const placement = rest.filter((g) => /3rd|5th/i.test(g.Week)).sort((a, b) => (/3rd/i.test(a.Week) ? 0 : 1) - (/3rd/i.test(b.Week) ? 0 : 1));
    const toilet = rest.filter((g) => /toilet/i.test(g.Week)).sort((a, b) => rosterWeek(a.Week) - rosterWeek(b.Week));
    const placementHtml = placement.length
      ? '<div class="bk-sub"><h3>Placement games</h3><div class="scores">' + placement.map((g) => scoreCard(g, g.Week)).join("") + "</div></div>"
      : "";
    return section(projected ? "Playoff picture" : "Playoffs", bracket + placementHtml,
      projected ? "If the season ended today" : "Top 6 make it · top 2 get a bye") +
      toiletBowl(toilet, seeds, seedOf, projected);
  }

  // Bottom two, best of three. Loser of the series finishes last.
  function toiletBowl(games, seeds, seedOf, projected) {
    const pair = games.length ? [games[0]["Player 1"], games[0]["Player 2"]] : seeds.slice(-2);
    if (pair.length < 2 || (!games.length && !projected)) return "";
    pair.sort((a, b) => (seedOf[a] || 99) - (seedOf[b] || 99));
    const wins = { [pair[0]]: 0, [pair[1]]: 0 };
    const cols = [0, 1, 2].map((i) => {
      const g = games[i];
      if (!g) return null;
      const pts = (m) => num(g["Player 1"] === m ? g["P1 Points"] : g["P2 Points"]);
      const w = pts(pair[0]) >= pts(pair[1]) ? pair[0] : pair[1];
      wins[w]++;
      return { g: g, pts: pts, w: w };
    });
    const decided = wins[pair[0]] >= 2 || wins[pair[1]] >= 2;
    const loser = decided ? (wins[pair[0]] < wins[pair[1]] ? pair[0] : pair[1]) : "";
    const cell = (c, m) => !c ? '<td class="tb-g muted">—</td>'
      : '<td class="tb-g' + (c.w === m ? " won" : "") + '"><a href="#/game/' + gameRoute(c.g.Year, c.g.Week, c.g["Player 1"], c.g["Player 2"]) + '">' + c.pts(m).toFixed(2) + "</a></td>";
    const row = (m) => '<tr class="' + (m === loser ? "tb-loser" : "") + '"><td class="tb-team"><span class="tb-who"><span class="bk-seed">' + (seedOf[m] || "") + "</span>" +
      link("career/" + enc(m), m) + (m === loser ? '<span class="tb-tag">Last place</span>' : "") + "</span></td>" +
      cols.map((c) => cell(c, m)).join("") + '<td class="tb-wins">' + wins[m] + "</td></tr>";
    return section("Toilet Bowl", '<div class="scroll"><table class="toilet"><thead><tr><th scope="col">Team</th>' +
      '<th scope="col" class="num">G1</th><th scope="col" class="num">G2</th><th scope="col" class="num">G3</th><th scope="col" class="num">W</th></tr></thead><tbody>' +
      row(pair[0]) + row(pair[1]) + "</tbody></table></div>" +
      '<p class="note">' + (loser ? esc(loser) + " lost the series and finished last." : projected ? "If the season ended today, these two would play it." : "Series in progress. First to two wins stays out of last place.") + "</p>",
      "Bottom 2 · best of 3 · loser finishes last");
  }

  function projectionSummary(rows, filter, groupKey) {
    const use = rows.filter((r) => filter(r) && (r.Result === "W" || r.Result === "L" || r.Result === "T"));
    const groups = {};
    use.forEach((r) => {
      const k = groupKey === "Manager" ? r.Manager : r.Year;
      (groups[k] = groups[k] || []).push(r);
    });
    return Object.keys(groups).map((k) => {
      const g = groups[k];
      const pw = g.filter((r) => r["Proj Result"] === "W").length, pl = g.filter((r) => r["Proj Result"] === "L").length;
      const aw = g.filter((r) => r.Result === "W").length, al = g.filter((r) => r.Result === "L").length;
      const vs = g.map((r) => num(r["Vs Proj"])).filter((v) => !isNaN(v));
      const de = g.map((r) => num(r["Decision Eff"])).filter((v) => !isNaN(v));
      return {
        key: k, projRec: pw + "-" + pl, actRec: aw + "-" + al, luck: aw - pw,
        ul: g.reduce((s, r) => s + (num(r["Upset Loss"]) || 0), 0),
        uw: g.reduce((s, r) => s + (num(r["Upset Win"]) || 0), 0),
        vs: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN,
        de: de.length ? de.reduce((a, b) => a + b, 0) / de.length : NaN,
        pw: pw, aw: aw,
      };
    });
  }

  function projCols(groupLabel) {
    return [
      { key: "key", label: groupLabel, cls: groupLabel === "Manager" ? "name" : "num",
        render: (r) => (groupLabel === "Manager" ? link("career/" + enc(r.key), r.key) : esc(r.key)) },
      { key: "projRec", label: "Proj Record", num: true, sortVal: (r) => r.pw },
      { key: "actRec", label: "Actual", num: true, sortVal: (r) => r.aw },
      { key: "luck", label: "Proj Luck", num: true, sortVal: (r) => r.luck,
        render: (r) => '<span class="' + (r.luck > 0 ? "pos" : r.luck < 0 ? "neg" : "") + '">' + signed(r.luck, 0) + "</span>" },
      { key: "ul", label: "Upset Ls", num: true, sortVal: (r) => r.ul, render: (r) => r.ul },
      { key: "uw", label: "Upset Ws", num: true, sortVal: (r) => r.uw, render: (r) => r.uw },
      { key: "vs", label: "Avg vs Proj", num: true, sortVal: (r) => r.vs, render: (r) => signed(r.vs) },
      { key: "de", label: "Decision Eff", num: true, sortVal: (r) => r.de, render: (r) => pct(r.de) },
    ];
  }

  function h2hFor(allGames, p) {
    const mine = allGames.filter((r) => r.Player === p && isNum(r.Points));
    const opps = uniq(mine.map((r) => r.Opponent)).filter(Boolean);
    return opps.map((o) => {
      const g = mine.filter((r) => r.Opponent === o);
      const w = g.reduce((s, r) => s + (num(r.Win) || 0), 0), l = g.reduce((s, r) => s + (num(r.Loss) || 0), 0);
      const avg = (k) => g.reduce((s, r) => s + num(r[k]), 0) / g.length;
      return { opp: o, w: w, l: l, pct: w + l ? w / (w + l) : NaN, pf: avg("Points"), pa: avg("Opp Points") };
    });
  }

  /* ============================== best lineups / all-time teams ============================== */

  const LINEUP_SLOTS = [["QB", ["QB"]], ["RB", ["RB"]], ["RB", ["RB"]], ["WR", ["WR"]], ["WR", ["WR"]], ["TE", ["TE"]], ["FLEX", ["RB", "WR", "TE"]], ["K", ["K"]], ["DEF", ["DEF"]]];

  // candidates: [{ name, pos, val, ...extra }] — fills each slot with the best unused player who fits
  // players with 4+ games come first; shorter stints only fill slots that would otherwise be empty
  function fillLineup(cands) {
    const used = new Set();
    const sorted = cands.slice().sort((a, b) => b.val - a.val);
    const full = sorted.filter((x) => !x.gp || x.gp >= 4), part = sorted.filter((x) => x.gp && x.gp < 4);
    const out = LINEUP_SLOTS.map(([slot, ok]) => {
      const c = full.find((x) => ok.includes(x.pos) && !used.has(x.name));
      if (c) used.add(c.name);
      return { slot: slot, ok: ok, c: c };
    });
    out.forEach((x) => {
      if (x.c) return;
      x.c = part.find((y) => x.ok.includes(y.pos) && !used.has(y.name));
      if (x.c) used.add(x.c.name);
    });
    return out;
  }

  const countsOk = (r) => r.Counts === undefined || r.Counts === "" || r.Counts === "Yes";
  const playedRow = (r) => isNum(r.Points) && !(num(r.Points) === 0 && (!isNum(r["Proj Pts"]) || num(r["Proj Pts"]) === 0));

  // best seasons: points per game while on the roster (weeks 1-14, 4+ games). who = a manager, or "" for the whole league.
  function seasonCands(d, who) {
    const posOf = posLookup(d);
    const by = {};
    d.rosters.forEach((r) => {
      if (!r.Player || r.Player === "(Empty)" || !isNum(r.Week) || +r.Week > 14 || !countsOk(r) || !playedRow(r)) return;
      if (who && r.Manager !== who) return;
      const k = r.Year + "|" + r.Player + "|" + (who ? "" : r.Manager);
      const o = (by[k] = by[k] || { name: r.Player, pos: posOf[r.Player], y: r.Year, m: r.Manager, gp: 0, tot: 0 });
      o.gp++; o.tot += num(r.Points);
    });
    const best = {};
    Object.values(by).filter((o) => o.gp >= (who ? 1 : 4) && o.pos).forEach((o) => {
      o.val = o.tot / o.gp;
      if (!best[o.name] || o.val > best[o.name].val) best[o.name] = o;   // a player's single best season
    });
    return Object.values(best);
  }

  // best single weeks (started only)
  function weekCands(d, who) {
    const posOf = posLookup(d);
    const best = {};
    d.rosters.forEach((r) => {
      if (!r.Player || r.Player === "(Empty)" || r.Started !== "Yes" || !isNum(r.Points) || !isNum(r.Week) || !countsOk(r)) return;
      if (who && r.Manager !== who) return;
      const pos = posOf[r.Player];
      if (!pos) return;
      const v = num(r.Points);
      if (!best[r.Player] || v > best[r.Player].val) best[r.Player] = { name: r.Player, pos: pos, y: r.Year, w: r.Week, m: r.Manager, val: v };
    });
    return Object.values(best);
  }

  function lineupTable(lineup, kind, showMgr) {
    const total = lineup.reduce((t, x) => t + (x.c ? x.c.val : 0), 0);
    return '<div class="scroll"><table class="lineup-tbl"><thead><tr><th scope="col">Slot</th><th scope="col">Player</th>' + (showMgr ? '<th scope="col">Manager</th>' : "") +
      '<th scope="col" class="num">' + (kind === "season" ? "Year" : "When") + '</th><th scope="col" class="num">' + (kind === "season" ? "PPG" : "Pts") + "</th></tr></thead><tbody>" +
      lineup.map((x) => '<tr><td class="slot">' + esc(x.slot) + "</td>" + (x.c
        ? '<td class="name">' + plink(x.c.name) + (x.slot === "FLEX" ? ' <span class="tag">' + esc(x.c.pos) + "</span>" : "") + "</td>" +
          (showMgr ? '<td class="name">' + link("career/" + enc(x.c.m), x.c.m) + "</td>" : "") +
          '<td class="num">' + (kind === "season" ? esc(x.c.y) + (x.c.gp < 4 ? ' <span class="muted" title="Only ' + x.c.gp + ' games">*</span>' : "") : esc(x.c.y) + " · Wk " + esc(x.c.w)) + "</td>" +
          '<td class="num rec-val">' + x.c.val.toFixed(kind === "season" ? 1 : 2) + "</td>"
        : '<td colspan="' + (showMgr ? 4 : 3) + '" class="muted">Nobody yet</td>') + "</tr>").join("") +
      '<tr class="lineup-total"><td colspan="' + (showMgr ? 4 : 3) + '">Total</td><td class="num rec-val">' + total.toFixed(1) + "</td></tr></tbody></table></div>" +
      (lineup.some((x) => x.c && x.c.gp && x.c.gp < 4) ? '<p class="note">* Fewer than 4 games, used only to fill an empty slot.</p>' : "");
  }

  function pageAllTime() {
    return loadMany(["rosters", "positions"]).then((d) => {
      return '<div class="hero"><span class="kicker">League history</span><h1>All-time teams</h1></div>' +
        '<p class="note">The best lineup you could build from every player who’s been on a league roster. Each player appears once, at his best. ' + link("records", "← Records") + "</p>" +
        section("Best seasons", lineupTable(fillLineup(seasonCands(d, "")), "season", true), "Points per game, weeks 1–14, 4+ games") +
        section("Best single weeks", lineupTable(fillLineup(weekCands(d, "")), "week", true), "Starters only");
    });
  }

  /* ---------- manager profile pieces ---------- */
  function playingStyle(d, p) {
    const ms = uniq(d.standings.map((r) => r.Player)).filter(Boolean);
    const seasons = (m) => Math.max(1, uniq(d.standings.filter((r) => r.Player === m).map((r) => r.Year)).length);
    const per = (m, f) => d.moves.filter((r) => r.Manager === m && f(r)).length / seasons(m);
    const stat = {};
    ms.forEach((m) => {
      const lu = d.lineups.filter((r) => r.Manager === m && isNum(r.Week) && +r.Week <= 14 && isNum(r.Efficiency));
      const tradesN = uniq(d.moves.filter((r) => r.Manager === m && r["How Acquired"] === "Trade").map((r) => r.Year + "|" + r["First Week"] + "|" + r.From)).length / seasons(m);
      stat[m] = { trades: tradesN, adds: per(m, (r) => r["How Acquired"] === "Waiver"),
        eff: lu.length ? lu.reduce((t, r) => t + num(r.Efficiency), 0) / lu.length : NaN,
        draft: d.moves.filter((r) => r.Manager === m && r["How Acquired"] === "Draft").reduce((t, r) => t + (num(r.Value) || 0), 0) / seasons(m),
        luck: d.standings.filter((r) => r.Player === m && isNum(r.Luck)).reduce((t, r) => t + num(r.Luck), 0) };
    });
    const avg = (k) => { const v = ms.map((m) => stat[m][k]).filter((x) => !isNaN(x)); return v.reduce((a, b) => a + b, 0) / (v.length || 1); };
    const rank = (k) => ms.filter((m) => !isNaN(stat[m][k])).sort((a, b) => stat[b][k] - stat[a][k]).indexOf(p) + 1;
    const me = stat[p];
    if (!me) return "";
    const tags = [];
    if (me.trades >= avg("trades") * 1.4 && me.trades >= 1) tags.push(["Wheeler-dealer", "makes " + me.trades.toFixed(1) + " trades a season (league average " + avg("trades").toFixed(1) + ")"]);
    else if (me.trades <= avg("trades") * 0.5) tags.push(["Doesn’t trade", "only " + me.trades.toFixed(1) + " trades a season"]);
    if (me.adds >= avg("adds") * 1.25) tags.push(["Waiver hawk", me.adds.toFixed(0) + " pickups a season (average " + avg("adds").toFixed(0) + ")"]);
    else if (me.adds <= avg("adds") * 0.75) tags.push(["Set and forget", "only " + me.adds.toFixed(0) + " pickups a season"]);
    const er = rank("eff"), dr = rank("draft"), lr = rank("luck"), n = ms.length;
    if (er && er <= 2) tags.push(["Lineup sharp", "#" + er + " in lineup efficiency (" + pct(me.eff, 1) + ")"]);
    else if (er && er >= n - 1) tags.push(["Bench blunderer", "#" + er + " of " + n + " in lineup efficiency"]);
    if (dr && dr <= 2) tags.push(["Draft-day ace", "#" + dr + " in draft value per season"]);
    else if (dr && dr >= n - 1) tags.push(["Draft-day disaster", "#" + dr + " of " + n + " in draft value"]);
    if (lr === 1) tags.push(["Lucky", "the league’s luckiest manager (" + signed(me.luck, 1) + " wins from luck)"]);
    else if (lr === n) tags.push(["Snakebitten", "the league’s unluckiest manager (" + signed(me.luck, 1) + " wins from luck)"]);
    if (!tags.length) tags.push(["Balanced", "right around league average at everything"]);
    return '<div class="style-tags">' + tags.map((t) => '<div class="style-tag"><b>' + esc(t[0]) + "</b><span>" + esc(t[1]) + "</span></div>").join("") + "</div>";
  }

  function trophyCase(d, p) {
    const st = d.standings.filter((r) => r.Player === p && isNum(r.Place));
    const lastOf = (y) => Math.max.apply(null, d.standings.filter((r) => r.Year === y && isNum(r.Place)).map((r) => num(r.Place)));
    const titles = st.filter((r) => num(r.Place) === 1).map((r) => r.Year).sort();
    const seconds = st.filter((r) => num(r.Place) === 2).map((r) => r.Year).sort();
    const thirds = st.filter((r) => num(r.Place) === 3).map((r) => r.Year).sort();
    const lasts = st.filter((r) => num(r.Place) === lastOf(r.Year)).map((r) => r.Year).sort();
    const held = recordList(d).filter((o) => o.rows[0] && o.rows[0][1] === p);
    const shelf = (cls, label, yrs) => yrs.length ? '<div class="trophy ' + cls + '"><span class="t-n">' + yrs.length + '</span><span class="t-l">' + esc(label) + '</span><span class="t-y">' + yrs.map(esc).join(" · ") + "</span></div>" : "";
    const cups = shelf("gold", yrs1(titles.length, "Title"), titles) + shelf("silver", yrs1(seconds.length, "Runner-up"), seconds) + shelf("bronze", "3rd place", thirds) + shelf("last", yrs1(lasts.length, "Last-place finish"), lasts);
    return (cups ? '<div class="trophies">' + cups + "</div>" : '<p class="empty">No hardware yet.</p>') +
      heldList("Records held", held.filter((o) => !DUBIOUS.test(o.label))) + heldList("Dubious honors", held.filter((o) => DUBIOUS.test(o.label)));
  }
  const yrs1 = (n, w) => (n === 1 ? w : w + "s");
  const DUBIOUS = /lowest|worst|losing|fewest|unluck|points against|bench|self-inflicted|zero-point|on a bye|upset loss|under projection|last-place|drought|without a title|bad beat|volatile|hurt|bust/i;
  const heldList = (title, list) => (list.length ? '<h3 class="held-h">' + esc(title) + " (" + list.length + ")</h3>" + '<ul class="held' + (/dubious/i.test(title) ? " bad" : "") + '">' +
    list.map((o) => "<li>" + link("records", o.label) + ' <span class="num">' + esc(o.rows[0][0]) + "</span></li>").join("") + "</ul>" : "");

  function pageCareer(pArg) {
    return loadMany(uniq(["allTime", "elo"].concat(RECORD_TABS))).then((d) => {
      const ms = managers(d.allTime);
      const p = ms.includes(pArg) ? pArg : ms[0];
      const at = d.allTime.find((r) => r.Player === p) || {};
      const html = [];
      html.push('<div class="hero"><span class="kicker">Career</span><h1>' + esc(p) + "</h1></div>");
      html.push(chips(ms, p, (m) => "career/" + enc(m)));
      const tile = (lbl, val) => '<div class="tile"><span class="lbl">' + esc(lbl) + '</span><span class="val">' + val + "</span></div>";
      html.push('<div class="tiles">' +
        tile("Titles", esc(at.Titles || "0")) +
        tile("Record", esc(at.Record || "—")) +
        tile("Win %", isNum(at["Win %"]) ? pct(at["Win %"]) : esc(at["Win %"] || "—")) +
        tile("Playoff Record", esc(at["Playoff Record"] || "—")) +
        tile("Playoff Apps", esc(at["Playoff Apps"] || "0")) +
        tile("Avg Finish", esc(at["Avg Finish"] || "—")) +
        tile("Pts / Game", fmt(at["Pts/Game"])) +
        tile("Career High", fmt(at["Career High"])) + "</div>");
      html.push('<div class="grid-2 even">' + section("Trophy case", trophyCase(d, p)) + section("Playing style", playingStyle(d, p), "Compared with the rest of the league") + "</div>");
      html.push(section("Best-ever lineup", '<div class="grid-2 even"><div><h3 class="sub-h">Best seasons</h3>' + lineupTable(fillLineup(seasonCands(d, p)), "season", false) +
        '</div><div><h3 class="sub-h">Best single weeks</h3>' + lineupTable(fillLineup(weekCands(d, p)), "week", false) + "</div></div>",
        "Built only from players " + esc(p) + " rostered · " + link("alltime", "League all-time team →")));

      const st = d.standings.filter((r) => r.Player === p);
      const cols = standingsCols().slice(1);
      cols.unshift({ key: "Year", label: "Year", num: true, render: (r) => link("season/" + r.Year, r.Year) });
      html.push(section("Season by season", table("career-st-" + p, cols, st, { sortKey: "Year" })));

      const myCards = years(d.standings).map((y) => (cardsForYear(d, y).find((c) => c.m === p))).filter(Boolean);
      if (myCards.length) html.push(section("Cards", '<div class="cards">' + myCards.map((c) => cardHtml(c, true)).join("") + "</div>", "One per season"));
      html.push(section("Elo", eloChart(d.elo, p)));

      html.push(section("Head-to-head", table("career-h2h-" + p, [
        { key: "opp", label: "Opponent", cls: "name", render: (r) => link("rivalries/" + enc(p) + "/" + enc(r.opp), r.opp) },
        { key: "rec", label: "Record", num: true, sortVal: (r) => r.w, render: (r) => r.w + "-" + r.l },
        { key: "pct", label: "Win %", num: true, sortVal: (r) => r.pct, render: (r) => pct(r.pct, 0) },
        { key: "pf", label: "Avg For", num: true, sortVal: (r) => r.pf, render: (r) => r.pf.toFixed(1) },
        { key: "pa", label: "Avg Against", num: true, sortVal: (r) => r.pa, render: (r) => r.pa.toFixed(1) },
      ], h2hFor(d.allGames, p), { sortKey: "pct" })));

      const mv = d.mvps.filter((r) => r.Manager === p);
      if (mv.length) html.push(section("Team MVPs", table("career-mvp-" + p, [
        { key: "Year", label: "Year", num: true },
        { key: "MVP", label: "MVP", cls: "name", render: (r) => plink(r.MVP) },
        { key: "Pos", label: "Pos" },
        { key: "Acquired", label: "Acquired" },
        { key: "Started Pts", label: "Started Pts", num: true, render: (r) => fmt(r["Started Pts"]) },
        { key: "Share of Team Pts", label: "Share", num: true },
      ], mv, { sortKey: "Year" })));

      const pj = projectionSummary(d.projections, (r) => r.Manager === p, "Year");
      if (pj.length) html.push(section("Projections", table("career-pj-" + p, projCols("Year"), pj, { sortKey: "key" })));
      return html.join("");
    });
  }

  function pageRivalries(a, b) {
    return loadMany(["allGames"]).then((d) => {
      const ag = d.allGames.filter((r) => isNum(r.Points));
      const ps = uniq(ag.map((r) => r.Player)).filter(Boolean).sort();
      const html = ['<div class="hero"><span class="kicker">Rivalries</span><h1>Head-to-head</h1></div>'];
      if (a && b && ps.includes(a) && ps.includes(b) && a !== b) {
        const g = ag.filter((r) => r.Player === a && r.Opponent === b);
        const w = g.reduce((s, r) => s + (num(r.Win) || 0), 0), l = g.reduce((s, r) => s + (num(r.Loss) || 0), 0);
        const avg = (k) => (g.length ? g.reduce((s, r) => s + num(r[k]), 0) / g.length : 0);
        const tile = (lbl, val) => '<div class="tile"><span class="lbl">' + esc(lbl) + '</span><span class="val">' + val + "</span></div>";
        html.push(section(a + " vs " + b,
          '<div class="tiles">' + tile(a + " wins", w) + tile(b + " wins", l) + tile(a + " avg", avg("Points").toFixed(1)) + tile(b + " avg", avg("Opp Points").toFixed(1)) + "</div>" +
          table("riv-" + a + "-" + b, [
            { key: "Year", label: "Year", num: true },
            { key: "Week", label: "Week" },
            { key: "Game Type", label: "Type" },
            { key: "Points", label: a, num: true, render: (r) => fmt(r.Points) },
            { key: "Opp Points", label: b, num: true, render: (r) => fmt(r["Opp Points"]) },
            { key: "Win", label: "Winner", cls: "name", render: (r) => (num(r.Win) === 1 ? esc(a) : num(r.Loss) === 1 ? esc(b) : "Tie") },
            { key: "box", label: "", sortVal: () => 0, render: (r) => link("game/" + gameRoute(r.Year, r.Week, a, b), "Box score") },
          ], g, { sortKey: "Year" }) + link("rivalries", "← Back to the grid")));
        return html.join("");
      }
      html.push('<p class="note">Read across a row: that person’s record against each person on top. Tap any record for the full game log.</p>');
      const cell = (p, o) => {
        if (p === o) return '<td class="self">—</td>';
        const g = ag.filter((r) => r.Player === p && r.Opponent === o);
        if (!g.length) return "<td></td>";
        const w = g.reduce((s, r) => s + (num(r.Win) || 0), 0), l = g.reduce((s, r) => s + (num(r.Loss) || 0), 0);
        const cls = w > l ? "up" : w < l ? "down" : "even";
        return '<td class="cell ' + cls + '"><a href="#/rivalries/' + enc(p) + "/" + enc(o) + '" aria-label="' + esc(p) + " vs " + esc(o) + ": " + w + "-" + l + '">' + w + "-" + l + "</a></td>";
      };
      html.push('<div class="scroll"><table class="h2h"><thead><tr><th scope="col">Row vs column</th>' +
        ps.map((o) => '<th scope="col">' + esc(o) + "</th>").join("") + "</tr></thead><tbody>" +
        ps.map((p) => '<tr><th scope="row">' + esc(p) + "</th>" + ps.map((o) => cell(p, o)).join("") + "</tr>").join("") +
        "</tbody></table></div>");
      return html.join("");
    });
  }

  function pageRankings() {
    return loadMany(["elo"]).then((d) =>
      '<div class="hero"><span class="kicker">Elo ratings</span><h1>Power rankings</h1></div>' +
      '<p class="note">Everyone starts at 1500. Beat someone rated higher and you gain more. Playoff games count 1.5×, toilet bowl games don’t count, and ratings drift back toward 1500 between seasons. Tap a name to highlight their line.</p>' +
      section("Current", eloTable(d.elo)) +
      section("History", eloChart(d.elo)));
  }

  /* ============================== records ============================== */

  const RECORD_TABS = ["allGames", "standings", "lineups", "projections", "rosters", "positions", "moves", "mvps"];
  function pageRecords() { return loadMany(RECORD_TABS).then((d) => buildRecords(d, false)); }
  // onlyOut = just return the list of records (used by Career for "records held")
  const recordsCache = new WeakMap();
  function recordList(d) {
    if (!recordsCache.has(d.allGames)) recordsCache.set(d.allGames, buildRecords(d, true));
    return recordsCache.get(d.allGames);
  }
  function buildRecords(d, onlyOut) {
    {
      const ag = d.allGames.filter((r) => r.Player && isNum(r.Points) && isNum(r["Opp Points"]));
      // year|rosterWeek|manager -> game (week label + opponent), so any record can link to its box score
      const gameAt = {};
      ag.forEach((r) => { gameAt[r.Year + "|" + rosterWeek(r.Week) + "|" + r.Player] = r; });
      const wkText = (w) => (isRegularWeek(w) ? "Wk " + w : w);
      const when = (y, wLabel, m, opp) => {
        const txt = esc(y) + " · " + esc(wkText(wLabel));
        return opp ? '<a href="#/game/' + gameRoute(y, wLabel, m, opp) + '">' + txt + "</a>" : txt;
      };
      const whenRW = (y, rw, m) => {
        const g = gameAt[y + "|" + rw + "|" + m];
        return g ? when(y, g.Week, m, g.Opponent) : esc(y) + " · Wk " + esc(rw);
      };
      // best() keeps the top 5 (sorted) so every record can expand to a top-5 list
      const TOPN = 5;
      const best = (rows, val, asc) => {
        const scored = [];
        rows.forEach((r) => { const v = val(r); if (!isNaN(v)) scored.push({ r: r, v: v }); });
        if (!scored.length) return null;
        scored.sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
        return { r: scored[0].r, v: scored[0].v, top: scored.slice(0, TOPN) };
      };
      const fromList = (list) => (list.length ? { r: list[0].r, v: list[0].v, top: list.slice(0, TOPN) } : null);
      const out = [];
      // f(r, v) -> [value, manager, detail, whenHtml]
      const put = (sec, label, h, f) => {
        if (!h) return;
        out.push({ sec: sec, label: label, rows: h.top.map((x) => f(x.r, x.v)) });
      };

      /* --- game records --- */
      const wins = ag.filter((r) => num(r.Win) === 1), lossesR = ag.filter((r) => num(r.Loss) === 1);
      const gameDetail = (r) => "vs " + esc(r.Opponent) + " (" + num(r.Points).toFixed(2) + " – " + num(r["Opp Points"]).toFixed(2) + ")";
      const gameRec = (label, rows, val, asc, show) =>
        put("Game records", label, best(rows, val, asc), (r, v) => [show ? show(v) : v.toFixed(2), r.Player, gameDetail(r), when(r.Year, r.Week, r.Player, r.Opponent)]);
      gameRec("Highest score", ag, (r) => num(r.Points), false);
      gameRec("Lowest score", ag, (r) => num(r.Points), true);
      gameRec("Biggest blowout", wins, (r) => num(r.Points) - num(r["Opp Points"]), false, (v) => "+" + v.toFixed(2));
      gameRec("Closest game", wins, (r) => num(r.Points) - num(r["Opp Points"]), true, (v) => "+" + v.toFixed(2));
      gameRec("Highest losing score", lossesR, (r) => num(r.Points), false);
      gameRec("Lowest winning score", wins, (r) => num(r.Points), true);
      gameRec("Highest combined score", wins, (r) => num(r.Points) + num(r["Opp Points"]), false);
      gameRec("Lowest combined score", wins, (r) => num(r.Points) + num(r["Opp Points"]), true);

      /* --- season records (finished seasons only) --- */
      const done = d.standings.filter((r) => isNum(r.Place));
      const seasonLink = (r) => link("season/" + r.Year, r.Year + " season");
      const wentDetail = (r) => "Went " + esc(r.Record) + ", finished #" + esc(r.Place);
      const seasonRec = (label, val, asc, show, rows) =>
        put("Season records", label, best(rows || done, val, asc), (r, v) => [show ? show(v, r) : String(v), r.Player, wentDetail(r), seasonLink(r)]);
      const wpct = (rec) => { const w = wins_(rec), l = losses(rec); return w + l ? w / (w + l) : NaN; };
      seasonRec("Best record", (r) => wpct(r.Record), false, (v, r) => r.Record);
      seasonRec("Worst record", (r) => wpct(r.Record), true, (v, r) => r.Record);
      seasonRec("Most points for", (r) => num(r["Points For"]), false, (v) => v.toFixed(2));
      seasonRec("Fewest points for", (r) => num(r["Points For"]), true, (v) => v.toFixed(2));
      seasonRec("Most points against", (r) => num(r["Points Against"]), false, (v) => v.toFixed(2));
      seasonRec("Luckiest season", (r) => num(r.Luck), false, (v) => signed(v));
      seasonRec("Unluckiest season", (r) => num(r.Luck), true, (v) => signed(v));
      seasonRec("Most weekly high scores", (r) => num(r["Weekly Highs"]), false);
      seasonRec("Most weekly low scores", (r) => num(r["Weekly Lows"]), false);

      /* --- streaks: every separate run, longest first --- */
      const gKey = (r) => r.Year * 1000 + weekSortKey(r.Week);
      const people = uniq(d.standings.map((r) => r.Player)).filter(Boolean);
      const runsOf = (rows, test) => {
        const runs = [];
        uniq(rows.map((r) => r.Player)).forEach((p) => {
          const g = rows.filter((r) => r.Player === p).sort((a, b) => gKey(a) - gKey(b));
          let start = -1;
          g.forEach((r, i) => {
            if (test(r)) { if (start < 0) start = i; }
            else if (start >= 0) { runs.push({ n: i - start, p: p, a: g[start], b: g[i - 1] }); start = -1; }
          });
          if (start >= 0) runs.push({ n: g.length - start, p: p, a: g[start], b: g[g.length - 1] });
        });
        return fromList(runs.sort((x, y) => y.n - x.n).map((t) => ({ r: t, v: t.n })));
      };
      const runRow = (label, h, unit) => put("Streaks", label, h, (t, v) => [v + " " + unit, t.p,
        "From " + when(t.a.Year, t.a.Week, t.p, t.a.Opponent) + " to " + when(t.b.Year, t.b.Week, t.p, t.b.Opponent), ""]);
      runRow("Longest win streak", runsOf(ag, (r) => num(r.Win) === 1), "games");
      runRow("Longest losing streak", runsOf(ag, (r) => num(r.Loss) === 1), "games");

      /* --- lineup records (weeks 1-14) --- */
      const lu = d.lineups.filter((r) => isNum(r.Week) && +r.Week <= 14 && isNum(r.Optimal));
      const luRec = (label, rows, val, asc, show) => put("Lineup records", label, best(rows, val, asc), (r, v) => [show(v), r.Manager,
        "Scored " + fmt(r.Score) + " of a possible " + fmt(r.Optimal) + (r.Result === "L" ? ", lost to " + esc(r.Opponent) : ""), whenRW(r.Year, r.Week, r.Manager)]);
      luRec("Most points left on bench", lu, (r) => num(r["Bench Left"]), false, (v) => v.toFixed(2));
      luRec("Worst lineup efficiency", lu, (r) => num(r.Efficiency), true, (v) => pct(v));
      luRec("Most painful self-inflicted loss", lu.filter((r) => num(r["Self-Inflicted Loss"]) === 1), (r) => num(r["Bench Left"]), false, (v) => v.toFixed(2) + " left");
      const seasonAgg = {};
      lu.forEach((r) => {
        const k = r.Year + "|" + r.Manager;
        const o = seasonAgg[k] = seasonAgg[k] || { y: r.Year, m: r.Manager, bench: 0, sil: 0 };
        o.bench += num(r["Bench Left"]) || 0; o.sil += num(r["Self-Inflicted Loss"]) || 0;
      });
      const sa = Object.values(seasonAgg);
      const yLink = (y) => link("season/" + y, y + " season");
      put("Lineup records", "Most bench points left (season)", best(sa, (o) => o.bench, false), (o, v) => [v.toFixed(1), o.m, "", yLink(o.y)]);
      put("Lineup records", "Most self-inflicted losses (season)", best(sa.filter((o) => o.sil > 0), (o) => o.sil, false),
        (o, v) => [String(v), o.m, "Losses they'd have won with their own bench", yLink(o.y)]);

      /* --- projection records --- */
      const pj = d.projections.filter((r) => r.Result === "W" || r.Result === "L");
      put("Projections", "Biggest upset loss", best(pj.filter((r) => num(r["Upset Loss"]) === 1), (r) => num(r.Proj) - num(r["Opp Proj"]), false), (r, v) => ["Proj +" + v.toFixed(1), r.Manager,
        "Projected " + fmt(r.Proj, 1) + "–" + fmt(r["Opp Proj"], 1) + ", lost " + fmt(r.Score) + "–" + fmt(r["Opp Score"]) + " to " + esc(r.Opponent), whenRW(r.Year, r.Week, r.Manager)]);
      [["Most points over projection", false], ["Most points under projection", true]].forEach((x) =>
        put("Projections", x[0], best(pj, (r) => num(r["Vs Proj"]), x[1]), (r, v) => [signed(v, 2), r.Manager, "Scored " + fmt(r.Score) + " vs projected " + fmt(r.Proj), whenRW(r.Year, r.Week, r.Manager)]));

      /* ================= more records ================= */
      const regRows = ag.filter((r) => isRegularWeek(r.Week));
      const weekRows = {};
      regRows.forEach((r) => { (weekRows[r.Year + "|" + r.Week] = weekRows[r.Year + "|" + r.Week] || []).push(r); });
      const rankInWeek = (r) => {
        const list = weekRows[r.Year + "|" + r.Week].map((x) => num(x.Points)).sort((a, b) => b - a);
        return { rank: list.indexOf(num(r.Points)) + 1, n: list.length };
      };
      const gameRow = (detail) => (r, v) => [v.toFixed(2), r.Player, detail + gameDetail(r), when(r.Year, r.Week, r.Player, r.Opponent)];
      put("Game records", "Bad beat", best(regRows.filter((r) => num(r.Loss) === 1 && rankInWeek(r).rank === 2), (r) => num(r.Points), false), gameRow("2nd-best score of the week and still lost, "));
      put("Game records", "Worst win", best(regRows.filter((r) => { const k = rankInWeek(r); return num(r.Win) === 1 && k.rank >= k.n - 1; }), (r) => num(r.Points), true), gameRow("One of the week's 2 lowest scores and still won, "));

      const champRows = [];
      uniq(ag.map((r) => r.Year)).forEach((y) => {
        const rounds = ag.filter((r) => r.Year === y && /^round\s*\d+$/i.test(r.Week));
        if (!rounds.length) return;
        const top = Math.max.apply(null, rounds.map((r) => +r.Week.match(/\d+/)[0]));
        rounds.filter((r) => +r.Week.match(/\d+/)[0] === top).forEach((r) => champRows.push(r));
      });
      gameRec("Highest score in a championship", champRows, (r) => num(r.Points), false);
      gameRec("Lowest score in a championship", champRows, (r) => num(r.Points), true);

      const wkTot = Object.keys(weekRows).map((k) => ({ y: k.split("|")[0], w: k.split("|")[1], tot: weekRows[k].reduce((s, r) => s + num(r.Points), 0), n: weekRows[k].length }));
      [["Highest-scoring week (league)", false], ["Lowest-scoring week (league)", true]].forEach((x) =>
        put("Game records", x[0], best(wkTot, (o) => o.tot, x[1]), (o, v) => [v.toFixed(2), "", "All " + o.n + " teams combined, " + (v / o.n).toFixed(1) + " per team",
          '<a href="#/games/' + enc(o.y) + "/" + enc(o.w) + '">' + esc(o.y) + " · Wk " + esc(o.w) + "</a>"]));

      seasonRec("Best points per game", (r) => num(r["Avg Points"]), false, (v) => v.toFixed(2));
      seasonRec("Worst points per game", (r) => num(r["Avg Points"]), true, (v) => v.toFixed(2));
      const sdOf = (y, m) => {
        const sc = regRows.filter((r) => r.Year === y && r.Player === m).map((r) => num(r.Points));
        if (sc.length < 3) return NaN;
        const mu = sc.reduce((a, b) => a + b, 0) / sc.length;
        return Math.sqrt(sc.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (sc.length - 1));
      };
      seasonRec("Most consistent season", (r) => sdOf(r.Year, r.Player), true, (v) => "±" + v.toFixed(1) + " pts");
      seasonRec("Most volatile season", (r) => sdOf(r.Year, r.Player), false, (v) => "±" + v.toFixed(1) + " pts");
      seasonRec("Most wins, missed playoffs", (r) => wins_(r.Record), false, null, done.filter((r) => num(r.Place) > 6));
      seasonRec("Fewest wins, made playoffs", (r) => wins_(r.Record), true, null, done.filter((r) => num(r.Place) <= 6));
      const seedOf = {};
      uniq(d.standings.map((r) => r.Year)).forEach((y) => {
        d.standings.filter((r) => r.Year === y).slice().sort((a, b) => (wins_(b.Record) - wins_(a.Record)) || (num(b["Points For"]) - num(a["Points For"])))
          .forEach((r, i) => (seedOf[y + "|" + r.Player] = i + 1));
      });
      put("Season records", "Lowest-seeded champion", best(done.filter((r) => num(r.Place) === 1), (r) => seedOf[r.Year + "|" + r.Player], false),
        (r, v) => ["#" + v + " seed", r.Player, "Went " + esc(r.Record) + " and won it all", seasonLink(r)]);
      const turn = [];
      d.standings.forEach((r) => {
        if (!isNum(r.Place)) return;
        const prev = d.standings.find((x) => x.Player === r.Player && +x.Year === +r.Year - 1);
        if (prev) turn.push({ r: r, prev: prev, gain: wins_(r.Record) - wins_(prev.Record) });
      });
      put("Season records", "Biggest turnaround", best(turn.filter((o) => o.gain > 0), (o) => o.gain, false), (o, v) => ["+" + v + " wins", o.r.Player,
        esc(o.prev.Year) + ": " + esc(o.prev.Record) + " → " + esc(o.r.Year) + ": " + esc(o.r.Record), seasonLink(o.r)]);
      seasonRec("Best all-play record", (r) => wpct(r["All-Play Record"]), false, (v) => pct(v));

      /* --- hall of fame (careers) --- */
      const finishedYears = uniq(done.map((r) => r.Year)).sort((a, b) => a - b);
      const lastPlaceOf = (y) => Math.max.apply(null, done.filter((r) => r.Year === y).map((r) => num(r.Place)));
      const career = people.map((p) => {
        const mine = done.filter((r) => r.Player === p);
        const yearsOf = (f) => mine.filter(f).map((r) => r.Year).sort();
        const reg = regRows.filter((r) => r.Player === p);
        const w = reg.reduce((s, r) => s + (num(r.Win) || 0), 0), l = reg.reduce((s, r) => s + (num(r.Loss) || 0), 0);
        let run = 0, bestRun = 0, bestEnd = "", dry = 0, bestDry = 0, dryEnd = "";
        finishedYears.forEach((y) => {
          const r = mine.find((x) => x.Year === y);
          if (!r) { run = 0; dry = 0; return; }
          if (num(r.Place) <= 6) { run++; dry = 0; if (run > bestRun) { bestRun = run; bestEnd = y; } }
          else { dry++; run = 0; if (dry > bestDry) { bestDry = dry; dryEnd = y; } }
        });
        return { p: p, titles: yearsOf((r) => num(r.Place) === 1), seconds: yearsOf((r) => num(r.Place) === 2),
          lasts: yearsOf((r) => num(r.Place) === lastPlaceOf(r.Year)), run: bestRun, runEnd: bestEnd, dry: bestDry, dryEnd: dryEnd,
          wpct: w + l ? w / (w + l) : NaN, w: w, l: l, ppg: reg.length ? reg.reduce((s, r) => s + num(r.Points), 0) / reg.length : NaN,
          total: ag.filter((r) => r.Player === p).reduce((s, r) => s + num(r.Points), 0) };
      });
      const hof = (label, val, show, detail, rows) =>
        put("Hall of Fame", label, best((rows || career).filter((c) => val(c) > 0), val, false), (c, v) => [show(v, c), c.p, detail(c), ""]);
      hof("Most titles", (c) => c.titles.length, (v) => String(v), (c) => c.titles.join(", "));
      hof("Most runner-up finishes", (c) => c.seconds.length, (v) => String(v), (c) => c.seconds.join(", "));
      hof("Most last-place finishes", (c) => c.lasts.length, (v) => String(v), (c) => c.lasts.join(", "));
      hof("Longest playoff streak", (c) => c.run, (v) => v + (v === 1 ? " season" : " seasons"), (c) => "Through " + c.runEnd);
      hof("Longest playoff drought", (c) => c.dry, (v) => v + (v === 1 ? " season" : " seasons"), (c) => "Through " + c.dryEnd);
      hof("Most title games without a title", (c) => c.seconds.length, (v) => String(v), (c) => "Lost the final in " + c.seconds.join(", "), career.filter((c) => !c.titles.length));
      hof("Best career win %", (c) => c.wpct, (v) => pct(v), (c) => "Regular season: " + c.w + "-" + c.l);
      hof("Best career points per game", (c) => c.ppg, (v) => v.toFixed(2), () => "Regular season");
      hof("Most points all-time", (c) => c.total, (v) => v.toFixed(1), () => "All games, playoffs included");

      /* --- more streaks --- */
      runRow("Longest 130+ point streak", runsOf(ag, (r) => num(r.Points) >= 130), "games");
      const wkAvg = {}, weekHigh = {};
      Object.keys(weekRows).forEach((k) => {
        wkAvg[k] = weekRows[k].reduce((s, r) => s + num(r.Points), 0) / weekRows[k].length;
        weekHigh[k] = Math.max.apply(null, weekRows[k].map((r) => num(r.Points)));
      });
      runRow("Longest above-average streak", runsOf(regRows, (r) => num(r.Points) > wkAvg[r.Year + "|" + r.Week]), "weeks");
      runRow("Most consecutive weekly high scores", runsOf(regRows, (r) => num(r.Points) === weekHigh[r.Year + "|" + r.Week]), "weeks");

      /* --- rivalries --- */
      const pairs = {};
      ag.forEach((r) => {
        if (!r.Opponent || r.Player > r.Opponent) return;
        const k = r.Player + "|" + r.Opponent;
        const o = pairs[k] = pairs[k] || { a: r.Player, b: r.Opponent, aw: 0, bw: 0, n: 0, diff: 0 };
        o.n++; o.diff += num(r.Points) - num(r["Opp Points"]);
        if (num(r.Win) === 1) o.aw++; else if (num(r.Loss) === 1) o.bw++;
      });
      const pl = Object.values(pairs);
      const rivLink = (o) => link("rivalries/" + enc(o.a) + "/" + enc(o.b), "Full rivalry");
      put("Rivalries", "Most lopsided rivalry", best(pl.filter((o) => o.n >= 3), (o) => Math.abs(o.aw - o.bw) + o.n / 1000, false), (o) => {
        const aTop = o.aw >= o.bw;
        return [aTop ? o.aw + "-" + o.bw : o.bw + "-" + o.aw, aTop ? o.a : o.b, "vs " + esc(aTop ? o.b : o.a), rivLink(o)];
      });
      put("Rivalries", "Most played matchup", best(pl, (o) => o.n, false), (o, v) => [v + " games", o.a, "vs " + esc(o.b) + ", series " + o.aw + "-" + o.bw, rivLink(o)]);
      put("Rivalries", "Biggest rivalry point differential", best(pl, (o) => Math.abs(o.diff), false), (o, v) => {
        const aTop = o.diff >= 0;
        return ["+" + v.toFixed(1), aTop ? o.a : o.b, "vs " + esc(aTop ? o.b : o.a) + " over " + o.n + " games", rivLink(o)];
      });

      /* --- more lineup records --- */
      const perfect = {};
      lu.forEach((r) => {
        if (num(r.Efficiency) < 0.9995) return;
        perfect[r.Manager] = (perfect[r.Manager] || 0) + 1;
        const k = r.Year + "|" + r.Manager; perfect[k] = (perfect[k] || 0) + 1;
      });
      put("Lineup records", "Most perfect lineups (season)", best(Object.keys(perfect).filter((k) => k.includes("|")).map((k) => ({ y: k.split("|")[0], m: k.split("|")[1], n: perfect[k] })), (o) => o.n, false),
        (o, v) => [String(v), o.m, "Started the best possible lineup", yLink(o.y)]);
      put("Lineup records", "Most perfect lineups (career)", best(people.map((p) => ({ p: p, n: perfect[p] || 0 })).filter((o) => o.n > 0), (o) => o.n, false),
        (o, v) => [String(v), o.p, "Weeks 1–14, all seasons", ""]);
      const effSeason = {};
      lu.forEach((r) => { const k = r.Year + "|" + r.Manager; const o = effSeason[k] = effSeason[k] || { y: r.Year, m: r.Manager, s: 0, n: 0 }; if (isNum(r.Efficiency)) { o.s += num(r.Efficiency); o.n++; } });
      put("Lineup records", "Best lineup efficiency (season)", best(Object.values(effSeason).filter((o) => o.n >= 6), (o) => o.s / o.n, false),
        (o, v) => [pct(v), o.m, "Average over " + o.n + " weeks", yLink(o.y)]);
      const startedReal = d.rosters.filter((r) => r.Started === "Yes" && isNum(r.Week) && +r.Week <= 14);
      const byeC = {}, zeroC = {};
      startedReal.forEach((r) => {
        if (/bye/i.test(r.Note || "")) byeC[r.Manager] = (byeC[r.Manager] || 0) + 1;
        else if (isNum(r.Points) && num(r.Points) === 0) zeroC[r.Manager] = (zeroC[r.Manager] || 0) + 1;
      });
      put("Lineup records", "Most players started on a bye (career)", best(Object.keys(byeC).map((m) => ({ m: m, n: byeC[m] })), (o) => o.n, false), (o, v) => [String(v), o.m, "Weeks 1–14, all seasons", ""]);
      put("Lineup records", "Most zero-point starts (career)", best(Object.keys(zeroC).map((m) => ({ m: m, n: zeroC[m] })), (o) => o.n, false), (o, v) => [String(v), o.m, "Started a player who scored 0", ""]);

      /* --- transactions --- */
      const mv = d.moves.filter((r) => r.Player && r.Manager);
      const tr = {};
      mv.filter((r) => r["How Acquired"] === "Trade" && r.From).forEach((r) => {
        const pair = [r.Manager, r.From].sort(), k = r.Year + "|" + r["First Week"] + "|" + pair.join("|");
        const t = tr[k] = tr[k] || { y: r.Year, w: r["First Week"], a: pair[0], b: pair[1], got: {} };
        (t.got[r.Manager] = t.got[r.Manager] || []).push(r);
      });
      const tv = (t, m) => (t.got[m] || []).reduce((s, r) => s + (num(r.Value) || 0), 0);
      put("Transactions", "Biggest trade win", best(Object.values(tr), (t) => Math.abs(tv(t, t.a) - tv(t, t.b)), false), (t, v) => {
        const aWin = tv(t, t.a) >= tv(t, t.b), win = aWin ? t.a : t.b, lose = aWin ? t.b : t.a;
        return ["+" + v.toFixed(1) + " value", win,
          "Got " + (t.got[win] || []).map((r) => plink(r.Player)).join(", ") + " from " + esc(lose) + " for " + ((t.got[lose] || []).map((r) => plink(r.Player)).join(", ") || "nothing tracked"),
          link("trades/" + t.y, t.y + " · Wk " + t.w)];
      });
      const mvRec = (label, how) => put("Transactions", label, best(mv.filter((r) => r["How Acquired"] === how && !isDefPos(r.Pos)), (r) => num(r.Value), false),
        (r, v) => [signed(v) + " value", r.Manager, plink(r.Player) + " (" + esc(r.Pos || "") + "): " + esc(r.Starts) + " starts, " + fmt(r["Started Pts"], 1) + " pts", link("trades/" + r.Year, r.Year + " season")]);
      mvRec("Best waiver pickup", "Waiver");
      mvRec("Best draft value", "Draft");
      const owners = {};
      const defs = defenseNames(d.rosters, d.positions);
      d.rosters.forEach((r) => { if (r.Player && r.Player !== "(Empty)" && !defs.has(r.Player)) (owners[r.Player] = owners[r.Player] || new Set()).add(r.Manager); });
      put("Transactions", "Journeyman", best(Object.keys(owners).map((p) => ({ p: p, n: owners[p].size })), (o) => o.n, false),
        (o, v) => [v + " managers", "", plink(o.p) + " has been on " + Array.from(owners[o.p]).map(esc).join(", "), ""]);
      put("Transactions", "MVP who carried the most", best(d.mvps, (r) => num(r["Share of Team Pts"]), false),
        (r, v) => [pct(v, 0) + " of team pts", r.Manager, plink(r.MVP) + " (" + esc(r.Pos || "") + "), " + fmt(r["Started Pts"], 1) + " started pts", seasonLink(r)]);

      /* --- more projection records --- */
      const pjAgg = {};
      pj.forEach((r) => {
        const k = r.Year + "|" + r.Manager;
        const o = pjAgg[k] = pjAgg[k] || { y: r.Year, m: r.Manager, uw: 0, de: 0, n: 0 };
        o.uw += num(r["Upset Win"]) || 0;
        if (isNum(r["Decision Eff"])) { o.de += num(r["Decision Eff"]); o.n++; }
      });
      const pa = Object.values(pjAgg);
      put("Projections", "Most upset wins (season)", best(pa.filter((o) => o.uw > 0), (o) => o.uw, false), (o, v) => [String(v), o.m, "Won games they were projected to lose", yLink(o.y)]);
      put("Projections", "Best decision efficiency (season)", best(pa.filter((o) => o.n >= 6), (o) => o.de / o.n, false), (o, v) => [pct(v), o.m, "Started Yahoo's highest-projected lineup most often", yLink(o.y)]);

      // put sections in a sensible order
      const ORDER = ["Game records", "Season records", "Hall of Fame", "Streaks", "Rivalries", "Lineup records", "Transactions", "Projections"];
      out.sort((a, b) => ORDER.indexOf(a.sec) - ORDER.indexOf(b.sec));

      if (onlyOut) return out;
      /* --- render the record sections --- */
      const secs = uniq(out.map((o) => o.sec));
      const mgrCell = (m) => (m ? link("career/" + enc(m), m) : "—");
      let html = '<div class="hero"><span class="kicker">League history</span><h1>Records</h1></div>' +
        '<p class="note">Tap a record to see the top 5. Tap a date to open that game’s box score. ' + link("alltime", "All-time teams →") + "</p>" +
        '<div class="chips"><button type="button" class="chip" data-rec-all="open">Show all top 5s</button><button type="button" class="chip" data-rec-all="close">Collapse all</button></div>';
      let recId = 0;
      secs.forEach((sec) => {
        html += section(sec, '<div class="scroll"><table class="records"><thead><tr><th scope="col">Record</th><th scope="col" class="num">Value</th><th scope="col">Manager</th><th scope="col">Detail</th><th scope="col">When</th><th scope="col" class="rec-tog-h"><span class="sr">Top 5</span></th></tr></thead>' +
          out.filter((o) => o.sec === sec).map((o) => {
            const id = "rec" + recId++;
            const [v, m, det, wh] = o.rows[0];
            const has = o.rows.length > 1;
            const trOpen = has ? '<tr class="rec-row has-alts" tabindex="0" aria-expanded="false" aria-controls="' + id + '" title="Show top ' + o.rows.length + '">' : '<tr class="rec-row">';
            return '<tbody class="rec-group">' + trOpen + '<td class="rec-label">' + esc(o.label) + '</td><td class="num rec-val">' + esc(v) + '</td><td class="name">' + mgrCell(m) +
              '</td><td class="detail">' + det + '</td><td class="when">' + wh + '</td><td class="rec-tog" aria-hidden="true">' + (has ? "▾" : "") + "</td></tr></tbody>" +
              (o.rows.length > 1 ? '<tbody class="rec-alts" id="' + id + '" hidden>' + o.rows.slice(1).map((x, i) =>
                '<tr class="alt"><td class="rec-rank">' + (i + 2) + '</td><td class="num">' + esc(x[0]) + '</td><td class="name">' + mgrCell(x[1]) +
                '</td><td class="detail">' + x[2] + '</td><td class="when">' + x[3] + "</td><td></td></tr>").join("") + "</tbody>" : "");
          }).join("") + "</table></div>");
      });

      /* --- top performances by position --- */
      const posOf = {};
      d.positions.forEach((r) => { if (r.Player) posOf[r.Player] = r["Final Pos"] || r["Derived Pos"]; });
      const rs = d.rosters.filter((r) => isNum(r.Points) && (r.Counts === undefined || r.Counts === "" || r.Counts === "Yes"));
      const boards = [["QB", (r) => r.Started === "Yes" && posOf[r.Player] === "QB"], ["RB", (r) => r.Started === "Yes" && posOf[r.Player] === "RB"],
        ["WR", (r) => r.Started === "Yes" && posOf[r.Player] === "WR"], ["TE", (r) => r.Started === "Yes" && posOf[r.Player] === "TE"],
        ["K", (r) => r.Started === "Yes" && posOf[r.Player] === "K"], ["DEF", (r) => r.Started === "Yes" && posOf[r.Player] === "DEF"],
        ["Bench", (r) => r.Started !== "Yes"]];
      const tpRows = [];
      boards.forEach((b) => {
        rs.filter(b[1]).sort((x, z) => num(z.Points) - num(x.Points)).slice(0, 3).forEach((r, i) => tpRows.push({ cat: b[0], i: i + 1, r: r }));
      });
      html += section("Top performances", '<div class="scroll"><table class="records"><thead><tr><th scope="col">Pos</th><th scope="col">#</th><th scope="col">Player</th><th scope="col" class="num">Pts</th><th scope="col">Manager</th><th scope="col">When</th></tr></thead><tbody>' +
        tpRows.map((t) => '<tr' + (t.i === 1 ? ' class="first"' : "") + '><td class="rec-label">' + (t.i === 1 ? esc(t.cat) : "") + '</td><td class="rank">' + t.i +
          '</td><td class="name">' + plink(t.r.Player) + '</td><td class="num rec-val">' + num(t.r.Points).toFixed(2) + '</td><td class="name">' + link("career/" + enc(t.r.Manager), t.r.Manager) +
          '</td><td class="when">' + whenRW(t.r.Year, t.r.Week, t.r.Manager) + "</td></tr>").join("") + "</tbody></table></div>",
        "Started players · Bench = best games left on a bench");
      return html;
    }
  }
  const wins_ = (rec) => wins(rec);

  /* ============================== trades & pickups ============================== */

  const TRADE_VIEWS = [["trades", "Trades"], ["pickups", "Waiver pickups"], ["draft", "Draft"]];

  function pageTrades(yArg, viewArg, mArg) {
    return loadMany(["moves"]).then((d) => {
      const mv = d.moves.filter((r) => r.Player && r.Manager);
      const yrs = uniq(mv.map((r) => r.Year)).filter(isNum).sort((a, b) => b - a);
      const yr = yrs.includes(yArg) ? yArg : "All";
      const view = TRADE_VIEWS.some((v) => v[0] === viewArg) ? viewArg : "trades";
      const ms = uniq(mv.map((r) => r.Manager)).sort();
      const who = ms.includes(mArg) ? mArg : "";
      const inYr = yr === "All" ? mv : mv.filter((r) => r.Year === yr);
      const val = (r) => num(r.Value) || 0;
      const valTxt = (v) => '<span class="' + (v > 0 ? "pos" : v < 0 ? "neg" : "") + '">' + signed(v) + "</span>";
      const go = (y, v, m) => "trades/" + enc(y) + "/" + v + (m ? "/" + enc(m) : "");
      const posTag = (r) => (r.Pos ? ' <span class="tag">' + esc(r.Pos) + "</span>" : "");

      const head = '<div class="hero"><span class="kicker">Transactions</span><h1>Trades &amp; pickups</h1></div>' +
        '<div class="chips tabs">' + TRADE_VIEWS.map((v) => '<a class="chip' + (v[0] === view ? " on" : "") + '" href="#/' + go(yr, v[0], who) + '"' +
          (v[0] === view ? ' aria-current="page"' : "") + ">" + v[1] + "</a>").join("") + "</div>" +
        filterBar([{ label: "Year", items: ["All"].concat(yrs).map((y) => [go(y, view, who), y === "All" ? "All years" : y]), current: go(yr, view, who) }]
          .concat(view === "trades" ? [{ label: "Manager", items: [["", "Everyone"]].concat(ms.map((m) => [m, m])).map((x) => [go(yr, view, x[0]), x[1]]), current: go(yr, view, who) }] : []));
      const valueNote = '<p class="note"><b>Value</b> = points a player scored in your starting lineup, minus what a typical bench player at his position would have scored in those same starts. Theme-team weeks don’t count.</p>';

      /* ---------------- trades ---------------- */
      if (view === "trades") {
        const trades = {};
        inYr.filter((r) => r["How Acquired"] === "Trade" && r.From).forEach((r) => {
          const pair = [r.Manager, r.From].sort();
          const k = r.Year + "|" + r["First Week"] + "|" + pair.join("|");
          const t = trades[k] = trades[k] || { y: r.Year, w: r["First Week"], a: pair[0], b: pair[1], got: {} };
          (t.got[r.Manager] = t.got[r.Manager] || []).push(r);
        });
        const sideTotal = (t, m) => (t.got[m] || []).reduce((s, r) => s + val(r), 0);
        const all = Object.values(trades).sort((x, z) => (z.y - x.y) || (z.w - x.w));
        all.forEach((t) => { t.va = sideTotal(t, t.a); t.vb = sideTotal(t, t.b); t.win = t.va > t.vb ? t.a : t.vb > t.va ? t.b : ""; t.margin = Math.abs(t.va - t.vb); });

        const board = ms.map((m) => {
          const mine = all.filter((t) => t.a === m || t.b === m);
          let w = 0, l = 0, net = 0, bestT = null;
          mine.forEach((t) => {
            const d1 = (t.a === m ? t.va - t.vb : t.vb - t.va);
            net += d1;
            if (d1 > 0) w++; else if (d1 < 0) l++;
            if (!bestT || d1 > bestT.d) bestT = { t: t, d: d1 };
          });
          return { m: m, n: mine.length, w: w, l: l, net: net, bestT: bestT };
        }).filter((o) => o.n > 0);

        const shown = who ? all.filter((t) => t.a === who || t.b === who) : all;
        const side = (t, m, v) => '<div class="tl-side' + (t.win === m ? " won" : "") + '"><div class="tl-who"><span>' + link("career/" + enc(m), m) + " got</span>" +
          '<span class="tl-val">' + valTxt(v) + "</span></div><ul>" +
          ((t.got[m] || []).map((r) => "<li>" + plink(r.Player) + posTag(r) + '<span class="tl-pv">' + valTxt(val(r)) + "</span></li>").join("") ||
            '<li class="muted">Nothing tracked</li>') + "</ul></div>";
        const card = (t) => '<article class="tl"><div class="tl-head"><span>' + esc(t.y) + " · Week " + esc(t.w) + "</span>" +
          (t.win ? '<span class="tl-verdict">' + esc(t.win) + " wins by " + t.margin.toFixed(1) + "</span>" : '<span class="tl-verdict even">Even</span>') + "</div>" +
          '<div class="tl-body">' + side(t, t.a, t.va) + side(t, t.b, t.vb) + "</div></article>";

        return head + valueNote.replace("Theme-team", "A trade is won by the side whose new players added more Value. Theme-team") +
          (board.length ? section("Trade scorecard", table("tr-board-" + yr, [
            { key: "m", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.m), r.m) },
            { key: "n", label: "Trades", num: true },
            { key: "w", label: "W-L", num: true, sortVal: (r) => r.w - r.l, render: (r) => r.w + "-" + r.l },
            { key: "net", label: "Net Value", num: true, sortVal: (r) => r.net, render: (r) => valTxt(r.net) },
            { key: "bestT", label: "Best trade", sortVal: (r) => (r.bestT ? r.bestT.d : -Infinity), render: (r) => {
              if (!r.bestT || r.bestT.d <= 0) return '<span class="muted">—</span>';
              const t = r.bestT.t, o = t.a === r.m ? t.b : t.a;
              return valTxt(r.bestT.d) + ' <span class="muted">vs ' + esc(o) + ", " + esc(t.y) + " Wk " + esc(t.w) + "</span>";
            } },
          ], board, { sortKey: "net" })) : "") +
          section(who ? who + "’s trades" : "Every trade",
            (shown.length ? '<div class="tl-list">' + shown.map(card).join("") + "</div>" : '<p class="empty">No trades ' + (yr === "All" ? "yet" : "in " + esc(yr)) + (who ? " for " + esc(who) : "") + ".</p>"),
            shown.length + " trade" + (shown.length === 1 ? "" : "s"));
      }

      /* ---------------- pickups / draft ---------------- */
      const how = view === "pickups" ? "Waiver" : "Draft";
      const pool = inYr.filter((r) => r["How Acquired"] === how);
      const players = pool.filter((r) => !isDefPos(r.Pos));
      const board = ms.map((m) => {
        const mine = pool.filter((r) => r.Manager === m);
        const top = mine.filter((r) => !isDefPos(r.Pos)).sort((a, b) => val(b) - val(a))[0];
        return { m: m, n: mine.length, tot: mine.reduce((s, r) => s + val(r), 0), hits: mine.filter((r) => val(r) > 0).length, top: top };
      }).filter((o) => o.n > 0);
      const label = view === "pickups" ? "Pickups" : "Picks";
      const listCols = [
        { key: "Player", label: "Player", cls: "name", sortVal: (r) => r.Player, render: (r) => plink(r.Player) + posTag(r) },
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "Year", label: view === "pickups" ? "Added" : "Year", num: true, sortVal: (r) => num(r.Year) * 100 + num(r["First Week"]),
          render: (r) => esc(r.Year) + (view === "pickups" ? " · Wk " + esc(r["First Week"]) : "") },
        { key: "Starts", label: "Starts", num: true },
        { key: "Started Pts", label: "Started Pts", num: true, render: (r) => fmt(r["Started Pts"], 1) },
        { key: "Value", label: "Value", num: true, render: (r) => valTxt(val(r)) },
      ];
      const best = players.slice().sort((a, b) => val(b) - val(a)).slice(0, 15);
      const worst = players.filter((r) => num(r.Starts) > 0).sort((a, b) => val(a) - val(b)).slice(0, 5);
      return head + valueNote +
        section(view === "pickups" ? "Pickup scorecard" : "Draft scorecard", table("tr-" + view + "-board-" + yr, [
          { key: "m", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.m), r.m) },
          { key: "n", label: label, num: true },
          { key: "hits", label: "Paid off", num: true, sortVal: (r) => r.hits, render: (r) => r.hits + ' <span class="muted">(' + pct(r.n ? r.hits / r.n : 0, 0) + ")</span>" },
          { key: "tot", label: "Total Value", num: true, sortVal: (r) => r.tot, render: (r) => valTxt(r.tot) },
          { key: "top", label: view === "pickups" ? "Best pickup" : "Best pick", sortVal: (r) => (r.top ? val(r.top) : -Infinity),
            render: (r) => (r.top ? plink(r.top.Player) + " " + valTxt(val(r.top)) : '<span class="muted">—</span>') },
        ], board, { sortKey: "tot" }), "Paid off = added positive Value") +
        section(view === "pickups" ? "Best pickups" : "Biggest steals", table("tr-" + view + "-best-" + yr, listCols, best, { sortKey: "Value" }), "Defenses not included") +
        (worst.length ? section(view === "pickups" ? "Pickups that hurt" : "Biggest busts", table("tr-" + view + "-worst-" + yr, listCols, worst, { sortKey: "Value", sortAsc: true }),
          "Started and lost Value") : "");
    });
  }

  /* ============================== players ============================== */

  function playerIndex(rosters, positions) {
    const posOf = {};
    positions.forEach((r) => { if (r.Player) posOf[r.Player] = r["Final Pos"] || r["Derived Pos"]; });
    const by = {};
    rosters.forEach((r) => {
      if (!r.Player || r.Player === "(Empty)") return;
      const o = by[r.Player] = by[r.Player] || { name: r.Player, pos: posOf[r.Player] || "", years: new Set(), tot: 0, gp: 0 };
      o.years.add(r.Year);
      if (isNum(r.Points)) { o.tot += num(r.Points); o.gp++; }
    });
    return Object.values(by);
  }

  /* ============================== position rankings ============================== */

  const RANK_POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
  // League-wide starters at each position (8 teams; FLEX adds RB/WR/TE depth) -> "starter-level week" cutoff
  const STARTER_N = { QB: 8, RB: 20, WR: 20, TE: 10, K: 8, DEF: 8 };
  const TIER_NAMES = ["Elite", "Strong starters", "Starters", "Flex & fill-ins", "Depth"];

  function posLookup(d) {
    if (d._posOf) return d._posOf;
    const posOf = {};
    d.positions.forEach((r) => { if (r.Player) posOf[r.Player] = String(r["Final Pos"] || r["Derived Pos"] || "").toUpperCase(); });
    defenseNames(d.rosters, d.positions).forEach((n) => (posOf[n] = "DEF"));
    Object.keys(posOf).forEach((k) => { if (isDefPos(posOf[k])) posOf[k] = "DEF"; });
    return (d._posOf = posOf);
  }

  const rankCache = {};
  // scope: "reg" = weeks 1-14, "all" = every week on file. Theme-team weeks (Counts = No) never count.
  function positionRanks(d, yr, pos, scope) {
    const key = yr + "|" + pos + "|" + scope;
    if (rankCache[key]) return rankCache[key];
    const posOf = posLookup(d);
    const inScope = (r) => r.Year === yr && isNum(r.Week) && (scope === "all" || +r.Week <= 14) &&
      r.Player && r.Player !== "(Empty)" && posOf[r.Player] === pos && (r.Counts === undefined || r.Counts === "" || r.Counts === "Yes");
    const rows = d.rosters.filter(inScope);
    // played = has a score, and isn't a 0 with a 0 projection (inactive)
    const played = (r) => isNum(r.Points) && !(num(r.Points) === 0 && (!isNum(r["Proj Pts"]) || num(r["Proj Pts"]) === 0));
    const seen = new Set(), weekly = {};
    const by = {};
    rows.forEach((r) => {
      const wk = r.Player + "|" + r.Week;
      if (seen.has(wk)) return;
      seen.add(wk);
      const o = (by[r.Player] = by[r.Player] || { name: r.Player, mgrs: [], gp: 0, tot: 0, starts: 0, top3: 0, topN: 0, best: -Infinity, bestWk: "" });
      if (!o.mgrs.includes(r.Manager)) o.mgrs.push(r.Manager);
      if (!played(r)) return;
      const pts = num(r.Points);
      o.gp++; o.tot += pts;
      if (r.Started === "Yes") o.starts++;
      if (pts > o.best) { o.best = pts; o.bestWk = r.Week; }
      (weekly[r.Week] = weekly[r.Week] || []).push({ o: o, pts: pts });
    });
    const N = STARTER_N[pos] || 12;
    Object.values(weekly).forEach((list) => {
      list.sort((a, b) => b.pts - a.pts);
      list.forEach((x, i) => { if (i < 3) x.o.top3++; if (i < N) x.o.topN++; });
    });
    const weeksInScope = uniq(rows.map((r) => r.Week)).length;
    const minGames = Math.max(1, Math.min(6, Math.round(weeksInScope * 0.4)));
    const all = Object.values(by).filter((o) => o.gp > 0);
    all.forEach((o) => { o.ppg = o.tot / o.gp; o.startPct = o.starts / o.gp; });
    const qual = all.filter((o) => o.gp >= minGames).sort((a, b) => b.ppg - a.ppg || b.tot - a.tot);
    // replacement level = average PPG of the 3 players just outside starter range
    const repl = qual.slice(N, N + 3);
    const replPpg = repl.length ? repl.reduce((s, o) => s + o.ppg, 0) / repl.length : (qual.length ? qual[qual.length - 1].ppg : 0);
    qual.forEach((o, i) => { o.rank = i + 1; o.por = o.tot - o.gp * replPpg; });
    // tiers: aim for breaks near 25%, 60%, 100% and 150% of the starter count,
    // then nudge each break to the biggest PPG drop nearby so tiers split where the talent does
    const breaks = [];
    [0.25, 0.6, 1, 1.5].forEach((f) => {
      const target = Math.max(1, Math.round(N * f));
      const lo = Math.max((breaks[breaks.length - 1] || 0) + 1, Math.round(target * 0.7)), hi = Math.min(qual.length - 1, Math.round(target * 1.3));
      let bi = -1, bg = -1;
      for (let i = lo; i <= hi; i++) { const g = qual[i - 1].ppg - qual[i].ppg; if (g > bg) { bg = g; bi = i; } }
      if (bi > 0) breaks.push(bi);
    });
    let t = 0;
    qual.forEach((o, i) => {
      while (t < breaks.length && i >= breaks[t]) t++;
      o.tier = Math.min(t, TIER_NAMES.length - 1);
    });
    const out = { pos: pos, yr: yr, scope: scope, N: N, list: qual, unq: all.length - qual.length, minGames: minGames, replPpg: replPpg, weeks: weeksInScope };
    return (rankCache[key] = out);
  }

  // Each manager's starters at one position: points per week from that slot group
  function positionRooms(d, yr, pos, scope) {
    const posOf = posLookup(d);
    const rows = d.rosters.filter((r) => r.Year === yr && isNum(r.Week) && (scope === "all" || +r.Week <= 14) &&
      (r.Counts === undefined || r.Counts === "" || r.Counts === "Yes"));
    const weeks = {}, room = {};
    rows.forEach((r) => {
      if (!r.Manager) return;
      (weeks[r.Manager] = weeks[r.Manager] || new Set()).add(r.Week);
      if (r.Started !== "Yes" || posOf[r.Player] !== pos || !isNum(r.Points)) return;
      const o = (room[r.Manager] = room[r.Manager] || { m: r.Manager, tot: 0, players: {} });
      o.tot += num(r.Points);
      o.players[r.Player] = (o.players[r.Player] || 0) + num(r.Points);
    });
    return Object.keys(weeks).map((m) => {
      const o = room[m] || { m: m, tot: 0, players: {} };
      const top = Object.keys(o.players).sort((a, b) => o.players[b] - o.players[a])[0] || "";
      return { m: m, tot: o.tot, wk: weeks[m].size, ppw: weeks[m].size ? o.tot / weeks[m].size : 0, top: top, topPts: top ? o.players[top] : 0,
        used: Object.keys(o.players).length };
    }).sort((a, b) => b.ppw - a.ppw).map((o, i) => Object.assign(o, { rank: i + 1 }));
  }

  // "WR4 (2025)" style finishes for one player across seasons
  function playerFinishes(d, name) {
    const pos = posLookup(d)[name];
    if (!pos || !RANK_POS.includes(pos)) return [];
    const yrs = uniq(d.rosters.filter((r) => r.Player === name).map((r) => r.Year)).sort((a, b) => b - a);
    return yrs.map((y) => {
      const R = positionRanks(d, y, pos, "reg");
      const o = R.list.find((x) => x.name === name);
      return o ? { y: y, pos: pos, rank: o.rank, ppg: o.ppg, tier: TIER_NAMES[o.tier] } : null;
    }).filter(Boolean);
  }

  function pageRanks(yArg, posArg, scopeArg) {
    return loadMany(["rosters", "positions"]).then((d) => {
      const yrs = uniq(d.rosters.map((r) => r.Year).filter(isNum)).sort((a, b) => b - a);
      const yr = yrs.includes(yArg) ? yArg : yrs[0];
      const pos = RANK_POS.includes(String(posArg || "").toUpperCase()) ? String(posArg).toUpperCase() : "QB";
      const scope = scopeArg === "all" ? "all" : "reg";
      const R = positionRanks(d, yr, pos, scope);
      const base = (y, p, sc) => "ranks/" + enc(y) + "/" + p + "/" + sc;
      const head = '<div class="hero"><span class="kicker">Position rankings</span><h1>' + esc(yr) + " " + esc(pos) + "s</h1></div>" +
        '<div class="chips tabs"><a class="chip" href="#/players">All players</a><a class="chip on" aria-current="page" href="#/' + base(yr, pos, scope) + '">Rankings</a></div>' +
        filterBar([
          { label: "Year", items: yrs.map((y) => [base(y, pos, scope), y]), current: base(yr, pos, scope) },
          { label: "Position", type: "seg", items: RANK_POS.map((p) => [base(yr, p, scope), p]), current: base(yr, pos, scope) },
          { label: "Weeks", items: [[base(yr, pos, "reg"), "Weeks 1–14"], [base(yr, pos, "all"), "Include playoffs"]], current: base(yr, pos, scope) },
        ]);
      if (!R.list.length) return head + '<div class="state">No ' + esc(pos) + " data for " + esc(yr) + ".</div>";

      const thead = '<thead><tr><th scope="col" class="num">#</th><th scope="col">Player</th><th scope="col">Rostered by</th>' +
        '<th scope="col" class="num">PPG</th><th scope="col" class="num">Total</th><th scope="col" class="num">Games</th>' +
        '<th scope="col" class="num">Top 3 wks</th><th scope="col" class="num">Top ' + R.N + ' wks</th><th scope="col" class="num">Pts over repl.</th>' +
        '<th scope="col" class="num">Started</th></tr></thead>';
      let lastTier = -1;
      const body = R.list.map((o) => {
        const div = o.tier !== lastTier ? '<tr class="tier-row"><td colspan="10">' + esc(TIER_NAMES[o.tier]) + "</td></tr>" : "";
        lastTier = o.tier;
        return div + '<tr><td class="num rk">' + o.rank + '</td><td class="name">' + plink(o.name) + "</td><td>" +
          o.mgrs.slice(0, 2).map((m) => link("career/" + enc(m), m)).join(" → ") + (o.mgrs.length > 2 ? ' <span class="muted">+' + (o.mgrs.length - 2) + "</span>" : "") + '</td><td class="num rec-val">' + o.ppg.toFixed(2) +
          '</td><td class="num">' + o.tot.toFixed(1) + '</td><td class="num">' + o.gp + '</td><td class="num">' + o.top3 +
          '</td><td class="num">' + o.topN + '</td><td class="num"><span class="' + (o.por > 0 ? "pos" : o.por < 0 ? "neg" : "") + '">' + signed(o.por, 1) +
          '</span></td><td class="num">' + pct(o.startPct, 0) + "</td></tr>";
      }).join("");
      const rankTable = section("Rankings", '<div class="scroll"><table class="ranks">' + thead + "<tbody>" + body + "</tbody></table></div>" +
        '<p class="note">Ranked by points per game while on a league roster (players need ' + R.minGames + "+ games; " + R.unq + " didn't qualify). " +
        "Top " + R.N + " wks = weeks he finished as a starter-level " + esc(pos) + " among rostered players. Pts over repl. = points above a " +
        R.replPpg.toFixed(1) + "-PPG replacement " + esc(pos) + ". Started = how often his manager played him.</p>",
        (scope === "reg" ? "Weeks 1–14" : "All weeks") + " · " + R.weeks + " weeks");

      const rooms = positionRooms(d, yr, pos, scope);
      const roomTable = section(pos + " rooms", table("rooms-" + yr + pos + scope, [
        { key: "rank", label: "#", num: true, render: (r) => r.rank },
        { key: "m", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.m), r.m) },
        { key: "ppw", label: "Pts / week", num: true, render: (r) => r.ppw.toFixed(2) },
        { key: "tot", label: "Total", num: true, render: (r) => r.tot.toFixed(1) },
        { key: "used", label: "Players used", num: true },
        { key: "top", label: "Top contributor", sortVal: (r) => r.top, render: (r) => (r.top ? plink(r.top) + ' <span class="muted">' + r.topPts.toFixed(1) + "</span>" : "—") },
      ], rooms, { sortKey: "ppw" }), "Starters only · flex counts at real position");
      return head + rankTable + roomTable;
    });
  }

  function pagePlayers() {
    return loadMany(["rosters", "positions"]).then((d) => {
      const list = playerIndex(d.rosters, d.positions).sort((a, b) => b.tot - a.tot);
      return '<div class="hero"><span class="kicker">NFL players</span><h1>Players</h1></div>' +
        '<div class="chips tabs"><a class="chip on" aria-current="page" href="#/players">All players</a><a class="chip" href="#/ranks">Rankings</a></div>' +
        '<label class="search"><span>Search</span><input id="player-search" type="search" placeholder="Type a player or position (e.g. RB)" autocomplete="off"></label>' +
        '<p class="note">Every player who’s been on a roster in the league, by total points scored while rostered.</p>' +
        '<div class="scroll"><table class="plist"><thead><tr><th scope="col">Player</th><th scope="col">Pos</th><th scope="col" class="num">Seasons</th><th scope="col" class="num">Games</th><th scope="col" class="num">Total Pts</th></tr></thead><tbody>' +
        list.map((p) => '<tr data-q="' + esc((p.name + " " + p.pos).toLowerCase()) + '"><td class="name">' + plink(p.name) + "</td><td>" + esc(p.pos) +
          '</td><td class="num">' + p.years.size + '</td><td class="num">' + p.gp + '</td><td class="num">' + p.tot.toFixed(1) + "</td></tr>").join("") +
        "</tbody></table></div>";
    });
  }

  // in-page jumps (the hash is used for routing, so scroll instead)
  app.addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]");
    if (!j) return;
    e.preventDefault();
    const el = document.getElementById(j.dataset.jump);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const setRec = (tr, open) => {
    tr.setAttribute("aria-expanded", String(open));
    const box = document.getElementById(tr.getAttribute("aria-controls"));
    if (box) box.hidden = !open;
  };
  app.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.has-alts");
    if (tr && !e.target.closest("a, button")) { setRec(tr, tr.getAttribute("aria-expanded") !== "true"); return; }
    const all = e.target.closest("[data-rec-all]");
    if (all) app.querySelectorAll("tr.has-alts").forEach((t) => setRec(t, all.dataset.recAll === "open"));
  });
  app.addEventListener("keydown", (e) => {
    const tr = e.target.closest && e.target.closest("tr.has-alts");
    if (tr && e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setRec(tr, tr.getAttribute("aria-expanded") !== "true"); }
  });

  app.addEventListener("input", (e) => {
    if (e.target.id !== "player-search") return;
    const q = e.target.value.trim().toLowerCase();
    app.querySelectorAll("table.plist tbody tr").forEach((tr) => { tr.hidden = q !== "" && !tr.dataset.q.includes(q); });
  });

  function pagePlayer(name) {
    return loadMany(["rosters", "positions", "moves", "allGames"]).then((d) => {
      const rs = d.rosters.filter((r) => r.Player === name);
      if (!rs.length) return '<div class="state">Player not found.</div>' + link("players", "← All players");
      const pos = (d.positions.find((r) => r.Player === name) || {})["Final Pos"] || "";
      const gameAt = {};
      d.allGames.forEach((r) => { if (r.Player) gameAt[r.Year + "|" + rosterWeek(r.Week) + "|" + r.Player] = r; });
      const boxLink = (r, text) => {
        const g = gameAt[r.Year + "|" + r.Week + "|" + r.Manager];
        return g && isNum(g.Points) ? '<a href="#/game/' + gameRoute(g.Year, g.Week, r.Manager, g.Opponent) + '">' + esc(text) + "</a>" : esc(text);
      };
      const played = rs.filter((r) => isNum(r.Points));
      const tot = played.reduce((s, r) => s + num(r.Points), 0);
      const bestRow = played.reduce((b, r) => (!b || num(r.Points) > num(b.Points) ? r : b), null);
      const starts = rs.filter((r) => r.Started === "Yes").length;
      const yrs = uniq(rs.map((r) => r.Year)).sort((a, b) => b - a);
      const mgrs = uniq(rs.map((r) => r.Manager));
      const tile = (lbl, val) => '<div class="tile"><span class="lbl">' + esc(lbl) + '</span><span class="val">' + val + "</span></div>";
      const html = [];
      html.push('<div class="hero"><span class="kicker">' + esc(pos || "Player") + '</span><h1>' + esc(name) + "</h1></div>");
      html.push('<div class="tiles">' +
        tile("Total Pts", tot.toFixed(1)) +
        tile("PPG", played.length ? (tot / played.length).toFixed(2) : "—") +
        tile("Games", played.length) +
        tile("Times Started", starts) +
        tile("Seasons", yrs.length) +
        tile("Managers", mgrs.length) +
        tile("Best Game", bestRow ? boxLink(bestRow, num(bestRow.Points).toFixed(2)) : "—") + "</div>");

      const fin = playerFinishes(d, name);
      if (fin.length) html.push('<p class="note finishes">' + fin.map((f) =>
        link("ranks/" + enc(f.y) + "/" + f.pos + "/reg", "Finished " + f.pos + f.rank + " in " + f.y) + ' <span class="muted">(' + f.ppg.toFixed(1) + " PPG · " + esc(f.tier) + ")</span>").join(" · ") + "</p>");

      const byYear = yrs.map((y) => {
        const g = rs.filter((r) => r.Year === y), gp = g.filter((r) => isNum(r.Points));
        const t = gp.reduce((s, r) => s + num(r.Points), 0);
        const pj = gp.filter((r) => isNum(r["Proj Pts"]));
        return { y: y, who: uniq(g.map((r) => r.Manager)), weeks: g.length, gp: gp.length, tot: t, ppg: gp.length ? t / gp.length : NaN,
          best: gp.length ? Math.max.apply(null, gp.map((r) => num(r.Points))) : NaN, starts: g.filter((r) => r.Started === "Yes").length,
          vs: pj.length ? pj.reduce((s, r) => s + num(r.Points) - num(r["Proj Pts"]), 0) / pj.length : NaN };
      });
      html.push(section("By season", table("pl-yr-" + name, [
        { key: "y", label: "Year", num: true, sortVal: (r) => +r.y, render: (r) => esc(r.y) },
        { key: "who", label: "Rostered by", sortVal: (r) => r.who.join(), render: (r) => r.who.map((m) => link("career/" + enc(m), m)).join(", ") },
        { key: "weeks", label: "Weeks", num: true, sortVal: (r) => r.weeks, render: (r) => r.weeks },
        { key: "gp", label: "Games", num: true, sortVal: (r) => r.gp, render: (r) => r.gp },
        { key: "tot", label: "Total", num: true, sortVal: (r) => r.tot, render: (r) => r.tot.toFixed(1) },
        { key: "ppg", label: "PPG", num: true, sortVal: (r) => r.ppg, render: (r) => fmt(r.ppg) },
        { key: "best", label: "Best", num: true, sortVal: (r) => r.best, render: (r) => fmt(r.best) },
        { key: "starts", label: "Starts", num: true, sortVal: (r) => r.starts, render: (r) => r.starts },
        { key: "vs", label: "Avg vs Proj", num: true, sortVal: (r) => r.vs, render: (r) => '<span class="' + (r.vs > 0 ? "pos" : r.vs < 0 ? "neg" : "") + '">' + signed(r.vs, 2) + "</span>" },
      ], byYear, { sortKey: "y" })));

      const own = d.moves.filter((r) => r.Player === name);
      if (own.length) html.push(section("Ownership", table("pl-own-" + name, [
        { key: "Year", label: "Year", num: true },
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "How Acquired", label: "Acquired" },
        { key: "From", label: "From", render: (r) => (r.From ? link("career/" + enc(r.From), r.From) : "") },
        { key: "First Week", label: "First Wk", num: true },
        { key: "Weeks Rostered", label: "Weeks", num: true },
        { key: "Starts", label: "Starts", num: true },
        { key: "Started Pts", label: "Started Pts", num: true, render: (r) => fmt(r["Started Pts"], 1) },
        { key: "Value", label: "Value", num: true, render: (r) => '<span class="' + (num(r.Value) > 0 ? "pos" : num(r.Value) < 0 ? "neg" : "") + '">' + signed(r.Value) + "</span>" },
      ], own, { sortKey: "Year" })));

      html.push(section("Week by week", table("pl-wk-" + name, [
        { key: "Year", label: "Year", num: true, sortVal: (r) => num(r.Year) * 100 + num(r.Week) },
        { key: "Week", label: "Wk", num: true, render: (r) => boxLink(r, r.Week) },
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "Slot", label: "Slot" },
        { key: "Proj Pts", label: "Proj", num: true, render: (r) => fmt(r["Proj Pts"], 1) },
        { key: "Points", label: "Pts", num: true, render: (r) => (isNum(r.Points) ? num(r.Points).toFixed(2) : esc((r.Note || "—").toUpperCase())) },
      ], rs, { sortKey: "Year" }), "Tap a week for the box score"));
      html.push(link("players", "← All players"));
      return html.join("");
    });
  }

  /* ============================== playoff odds ============================== */

  const ODDS = { sims: 10000, stakeSims: 5000, playoffSpots: 6, byes: 2, toiletSpots: 2, regWeeks: 14 };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildOddsModel(games) {
    const reg = games.filter((g) => isRegularWeek(g.Week) && +g.Week <= ODDS.regWeeks && g["Player 1"] && g["Player 2"]);
    const yr = uniq(reg.filter((g) => isNum(g["P1 Points"])).map((g) => g.Year)).sort((a, b) => b - a)[0];
    const yrGames = reg.filter((g) => g.Year === yr);
    const played = yrGames.filter((g) => isNum(g["P1 Points"]) && isNum(g["P2 Points"]));
    const left = yrGames.filter((g) => !(isNum(g["P1 Points"]) && isNum(g["P2 Points"])));
    const teams = uniq(yrGames.flatMap((g) => [g["Player 1"], g["Player 2"]])).sort();
    const T = {};
    teams.forEach((t) => (T[t] = { w: 0, l: 0, tie: 0, pf: 0, scores: [] }));
    played.forEach((g) => {
      const a = g["Player 1"], b = g["Player 2"], sa = num(g["P1 Points"]), sb = num(g["P2 Points"]);
      T[a].pf += sa; T[b].pf += sb; T[a].scores.push(sa); T[b].scores.push(sb);
      if (sa > sb) { T[a].w++; T[b].l++; } else if (sb > sa) { T[b].w++; T[a].l++; } else { T[a].tie++; T[b].tie++; }
    });
    const all = teams.flatMap((t) => T[t].scores);
    const lgMean = all.reduce((s, v) => s + v, 0) / Math.max(all.length, 1);
    const lgVar = all.reduce((s, v) => s + (v - lgMean) * (v - lgMean), 0) / Math.max(all.length - 1, 1);
    const K = 3; // weeks of league-average "prior" so a hot start doesn't dominate
    teams.forEach((t) => {
      const sc = T[t].scores, n = sc.length;
      const m = n ? sc.reduce((s, v) => s + v, 0) / n : lgMean;
      const v = n > 1 ? sc.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1) : lgVar;
      T[t].mean = (n * m + K * lgMean) / (n + K);
      T[t].sd = Math.max(Math.sqrt((n * v + K * lgVar) / (n + K)), 10);
    });
    const nextWeek = left.length ? Math.min.apply(null, left.map((g) => +g.Week)) : null;
    return { yr: yr, teams: teams, T: T, left: left, nextWeek: nextWeek, lastPlayed: played.length ? Math.max.apply(null, played.map((g) => +g.Week)) : 0 };
  }

  function simulate(model, sims, seed, forced) {
    const rnd = mulberry32(seed);
    const normal = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const names = model.teams, n = names.length, idx = {};
    names.forEach((t, i) => (idx[t] = i));
    const sched = model.left.map((g) => [idx[g["Player 1"]], idx[g["Player 2"]], g]);
    const tally = names.map(() => ({ playoff: 0, bye: 0, top: 0, toilet: 0, last: 0, wins: 0 }));
    const w = new Float64Array(n), pf = new Float64Array(n), order = names.map((_, i) => i);
    for (let s = 0; s < sims; s++) {
      for (let i = 0; i < n; i++) { const t = model.T[names[i]]; w[i] = t.w + t.tie / 2; pf[i] = t.pf; }
      for (let k = 0; k < sched.length; k++) {
        const a = sched[k][0], b = sched[k][1], ta = model.T[names[a]], tb = model.T[names[b]];
        let sa = ta.mean + ta.sd * normal(), sb = tb.mean + tb.sd * normal();
        if (forced && sched[k][2] === forced.game) {
          const winA = forced.winner === names[a];
          if ((winA && sa < sb) || (!winA && sb < sa)) { const x = sa; sa = sb; sb = x; }
        }
        pf[a] += sa; pf[b] += sb;
        if (sa > sb) w[a]++; else w[b]++;
      }
      order.sort((x, y) => (w[y] - w[x]) || (pf[y] - pf[x]));
      for (let r = 0; r < n; r++) {
        const t = tally[order[r]];
        if (r < ODDS.playoffSpots) t.playoff++;
        if (r < ODDS.byes) t.bye++;
        if (r === 0) t.top++;
        if (r >= n - ODDS.toiletSpots) t.toilet++;
        if (r === n - 1) t.last++;
      }
      for (let i = 0; i < n; i++) tally[i].wins += w[i];
    }
    const out = {};
    names.forEach((t, i) => {
      const x = tally[i];
      out[t] = { playoff: x.playoff / sims, bye: x.bye / sims, top: x.top / sims, toilet: x.toilet / sims, last: x.last / sims, wins: x.wins / sims };
    });
    return out;
  }

  function oddsPct(p) {
    if (p >= 0.995 && p < 1) return ">99%";
    if (p > 0 && p < 0.005) return "<1%";
    return Math.round(p * 100) + "%";
  }
  function oddsBar(p, cls) {
    return '<div class="obar ' + (cls || "") + '"><span style="width:' + (p * 100).toFixed(1) + '%"></span><b>' + oddsPct(p) + "</b></div>";
  }

  function pageOdds() {
    return loadMany(["games"]).then((d) => {
      const m = buildOddsModel(d.games);
      if (!m.teams.length) return '<div class="state">No games yet.</div>';
      const head = '<div class="hero"><span class="kicker">' + esc(m.yr) + " season · after week " + m.lastPlayed + '</span><h1>Playoff odds</h1></div>';
      if (!m.left.length) return head + '<p class="note">The regular season is over, so there’s nothing left to simulate. ' + link("season/" + m.yr, "See the final standings →") + "</p>";
      const res = simulate(m, ODDS.sims, 20260001);
      const rows = m.teams.map((t) => {
        const T = m.T[t], gamesLeft = m.left.filter((g) => g["Player 1"] === t || g["Player 2"] === t).length;
        const pw = res[t].wins, total = T.w + T.l + T.tie + gamesLeft;
        return { t: t, rec: T.w + "-" + T.l + (T.tie ? "-" + T.tie : ""), w: T.w, pf: T.pf, mean: T.mean,
          proj: pw.toFixed(1) + "-" + (total - pw).toFixed(1), pw: pw, r: res[t] };
      });
      const html = [head];
      html.push('<p class="note">The rest of the regular season, simulated ' + ODDS.sims.toLocaleString() + " times. Each team’s weekly score is drawn from its " + esc(m.yr) +
        " scoring average and week-to-week swing (blended with the league average early in the year). Top " + ODDS.playoffSpots + " make the playoffs, top " + ODDS.byes +
        " get a bye, bottom " + ODDS.toiletSpots + " go to the toilet bowl. Ties in record are broken by points for.</p>");
      html.push(section("Odds", table("odds", [
        { key: "t", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.t), r.t) },
        { key: "rec", label: "Record", num: true, sortVal: (r) => r.w * 10000 + r.pf },
        { key: "pf", label: "PF", num: true, sortVal: (r) => r.pf, render: (r) => r.pf.toFixed(1) },
        { key: "mean", label: "Strength", num: true, sortVal: (r) => r.mean, render: (r) => r.mean.toFixed(1) },
        { key: "proj", label: "Proj Final", num: true, sortVal: (r) => r.pw },
        { key: "playoff", label: "Playoffs", sortVal: (r) => r.r.playoff, render: (r) => oddsBar(r.r.playoff) },
        { key: "bye", label: "Bye", sortVal: (r) => r.r.bye, render: (r) => oddsBar(r.r.bye) },
        { key: "top", label: "#1 Seed", sortVal: (r) => r.r.top, render: (r) => oddsBar(r.r.top) },
        { key: "toilet", label: "Toilet Bowl", sortVal: (r) => r.r.toilet, render: (r) => oddsBar(r.r.toilet, "bad") },
      ], rows, { sortKey: "playoff" }), "Strength = expected weekly score"));

      // what's at stake next week: playoff odds if each side wins
      const wk = m.left.filter((g) => +g.Week === m.nextWeek);
      let seed = 777;
      const cards = wk.map((g) => {
        const a = g["Player 1"], b = g["Player 2"];
        const ifA = simulate(m, ODDS.stakeSims, seed++, { game: g, winner: a });
        const ifB = simulate(m, ODDS.stakeSims, seed++, { game: g, winner: b });
        const sideRow = (t, win, lose) => '<div class="stake-row"><span class="who">' + esc(t) + '</span><span class="stake-nums"><span>Win <b>' + oddsPct(win) +
          '</b></span><span>Lose <b>' + oddsPct(lose) + '</b></span><span class="swing">±' + Math.round((win - lose) * 100) + "</span></span></div>";
        const swing = Math.max(ifA[a].playoff - ifB[a].playoff, ifB[b].playoff - ifA[b].playoff);
        return { swing: swing, html: '<div class="game stake"><div class="game-label">Week ' + esc(g.Week) + " · playoff odds</div>" +
          sideRow(a, ifA[a].playoff, ifB[a].playoff) + sideRow(b, ifB[b].playoff, ifA[b].playoff) + "</div>" };
      }).sort((x, y) => y.swing - x.swing);
      html.push(section("What’s at stake in week " + m.nextWeek, '<p class="note">Each person’s playoff odds if they win or lose their next game. The ± is how much that one game is worth. Biggest swings first.</p>' +
        '<div class="scores">' + cards.map((c) => c.html).join("") + "</div>"));
      return html.join("");
    });
  }

  /* ============================== matchup preview ============================== */

  // standard normal CDF (Abramowitz-Stegun)
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  function pagePreview() {
    return loadMany(["games"]).then((d) => {
      const m = buildOddsModel(d.games);
      const head = (k) => '<div class="hero"><span class="kicker">' + esc(k) + '</span><h1>Matchup preview</h1></div>';
      if (!m.teams.length) return head("Preview") + '<p class="empty">No games yet.</p>';
      if (!m.nextWeek) return head(m.yr + " season") + '<p class="empty">No upcoming regular-season games in the sheet. Previews show up once next week’s matchups are entered in Games (with the scores left blank).</p>';
      const wk = m.nextWeek;
      const games = m.left.filter((g) => +g.Week === wk);
      const all = playedGames(d.games);
      const base = simulate(m, ODDS.sims, 20261001);

      // current standings order for seeds
      const order = m.teams.slice().sort((a, b) => ((m.T[b].w + m.T[b].tie / 2) - (m.T[a].w + m.T[a].tie / 2)) || (m.T[b].pf - m.T[a].pf));
      const seed = {};
      order.forEach((t, i) => (seed[t] = i + 1));
      const yrGames = all.filter((g) => g.Year === m.yr && isRegularWeek(g.Week)).sort((a, b) => +a.Week - +b.Week);
      const form = (t) => yrGames.filter((g) => g["Player 1"] === t || g["Player 2"] === t).map((g) => {
        const w = gameWinner(g);
        return { r: !w ? "T" : w === t ? "W" : "L", s: num(g["Player 1"] === t ? g["P1 Points"] : g["P2 Points"]) };
      });
      const ord = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

      const cards = games.map((g, gi) => {
        const a = g["Player 1"], b = g["Player 2"], A = m.T[a], B = m.T[b];
        const pA = normCdf((A.mean - B.mean) / Math.sqrt(A.sd * A.sd + B.sd * B.sd));
        const ifA = simulate(m, ODDS.stakeSims, 20262001 + gi, { game: g, winner: a });
        const ifB = simulate(m, ODDS.stakeSims, 20263001 + gi, { game: g, winner: b });
        const swing = Math.abs(ifA[a].playoff - ifB[a].playoff) + Math.abs(ifB[b].playoff - ifA[b].playoff);
        // series history (every meeting, playoffs included)
        const meets = all.filter((x) => (x["Player 1"] === a && x["Player 2"] === b) || (x["Player 1"] === b && x["Player 2"] === a))
          .sort((x, y) => (x.Year - y.Year) || (weekSortKey(x.Week) - weekSortKey(y.Week)));
        let aw = 0, bw = 0, tie = 0;
        meets.forEach((x) => { const w = gameWinner(x); if (!w) tie++; else if (w === a) aw++; else bw++; });
        const last = meets[meets.length - 1];
        const lastTxt = last ? (() => {
          const w = gameWinner(last), sa = num(last["Player 1"] === a ? last["P1 Points"] : last["P2 Points"]), sb = num(last["Player 1"] === a ? last["P2 Points"] : last["P1 Points"]);
          return '<a href="#/game/' + gameRoute(last.Year, last.Week, last["Player 1"], last["Player 2"]) + '">' + esc(last.Year) + " · " + esc(isRegularWeek(last.Week) ? "Wk " + last.Week : last.Week) + "</a>: " +
            (w ? esc(w) + " won " + Math.max(sa, sb).toFixed(2) + "–" + Math.min(sa, sb).toFixed(2) : "tied " + sa.toFixed(2));
        })() : "First meeting";
        const seriesTxt = !meets.length ? "Never played" : aw === bw ? "Series tied " + aw + "-" + bw + (tie ? "-" + tie : "") :
          esc(aw > bw ? a : b) + " leads " + Math.max(aw, bw) + "-" + Math.min(aw, bw) + (tie ? "-" + tie : "");
        const side = (t, T, p, ifW, ifL, align) => {
          const f = form(t), last5 = f.slice(-5), last3 = f.slice(-3);
          const l3 = last3.length ? last3.reduce((s2, x) => s2 + x.s, 0) / last3.length : NaN;
          return '<div class="pv-side ' + align + '"><div class="pv-name">' + link("career/" + enc(t), t) + "</div>" +
            '<div class="pv-rec">' + T.w + "-" + T.l + (T.tie ? "-" + T.tie : "") + " · " + ord(seed[t]) + "</div>" +
            '<div class="pv-form" aria-label="Last ' + last5.length + ' results">' + last5.map((x) => '<span class="f-' + x.r + '">' + x.r + "</span>").join("") + "</div>" +
            '<dl class="pv-stats"><div><dt>Season PPG</dt><dd>' + (T.scores.length ? (T.pf / T.scores.length).toFixed(1) : "—") + "</dd></div>" +
            "<div><dt>Last 3</dt><dd>" + (isNaN(l3) ? "—" : l3.toFixed(1)) + "</dd></div>" +
            "<div><dt>Playoff odds</dt><dd>" + oddsPct(base[t].playoff) + "</dd></div></dl>" +
            '<div class="pv-stake">With a win <b class="pos">' + oddsPct(ifW[t].playoff) + '</b> · with a loss <b class="neg">' + oddsPct(ifL[t].playoff) + "</b></div></div>";
        };
        return { swing: swing, html: '<article class="pv">' +
          '<div class="pv-top">' + side(a, A, pA, ifA, ifB, "left") +
          '<div class="pv-mid"><div class="pv-proj"><span>' + A.mean.toFixed(1) + '</span><small>proj.</small><span>' + B.mean.toFixed(1) + "</span></div>" +
            '<div class="pv-split" role="img" aria-label="' + esc(a) + " " + Math.round(pA * 100) + "% to win, " + esc(b) + " " + Math.round((1 - pA) * 100) + '%"><span style="width:' + (pA * 100).toFixed(1) + '%"></span></div>' +
            '<div class="pv-pct"><b>' + Math.round(pA * 100) + "%</b><b>" + Math.round((1 - pA) * 100) + "%</b></div></div>" +
          side(b, B, 1 - pA, ifB, ifA, "right") + "</div>" +
          '<div class="pv-foot"><span><b>Series:</b> ' + seriesTxt + "</span><span><b>Last meeting:</b> " + lastTxt + "</span>" +
            (meets.length ? '<span><a href="#/rivalries/' + enc(a) + "/" + enc(b) + '">Full rivalry →</a></span>' : "") + "</div></article>" };
      });
      const maxSwing = Math.max.apply(null, cards.map((c) => c.swing));
      const list = cards.sort((x, y) => y.swing - x.swing).map((c) => (c.swing === maxSwing && maxSwing > 0.1 ? c.html.replace('<article class="pv">', '<article class="pv big"><div class="pv-flag">Biggest playoff stakes</div>') : c.html));
      return head(m.yr + " · Week " + wk) +
        '<p class="note">Win chances and projected scores come from each team’s ' + esc(m.yr) + " scoring so far (the same model as " + link("odds", "Playoff Odds") +
        "). “With a win / with a loss” is each team’s playoff chance depending on how this game goes. Games are sorted by how much is riding on them.</p>" +
        '<div class="pv-list">' + list.join("") + "</div>";
    });
  }

  /* ============================== weekly recap ============================== */

  const pickLine = (seed, lines) => lines[Math.abs([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % lines.length];

  function pageRecap(yArg, wArg) {
    return loadMany(["games", "rosters", "positions", "lineups"]).then((d) => {
      const all = playedGames(d.games);
      const yrs = uniq(all.map((g) => g.Year)).sort((a, b) => b - a);
      if (!yrs.length) return '<div class="state">No games yet.</div>';
      const yr = yrs.includes(yArg) ? yArg : yrs[0];
      const inYr = all.filter((g) => g.Year === yr);
      const weeks = uniq(inYr.map((g) => g.Week)).sort((a, b) => weekSortKey(a) - weekSortKey(b));
      const wk = weeks.includes(wArg) ? wArg : weeks[weeks.length - 1];
      const games = inYr.filter((g) => g.Week === wk);
      const reg = isRegularWeek(wk);
      const wkName = reg ? "Week " + wk : wk;
      const rw = rosterWeek(wk);
      const posOf = posLookup(d);

      // each game from the winner's side
      const G = games.map((g) => {
        const a = num(g["P1 Points"]), b = num(g["P2 Points"]), w = gameWinner(g);
        const aWon = w === g["Player 1"];
        return { g: g, tie: !w, w: aWon || !w ? g["Player 1"] : g["Player 2"], l: aWon || !w ? g["Player 2"] : g["Player 1"],
          ws: aWon || !w ? a : b, ls: aWon || !w ? b : a, margin: Math.abs(a - b), total: a + b };
      });
      const scores = [];
      games.forEach((g) => { scores.push({ m: g["Player 1"], s: num(g["P1 Points"]) }); scores.push({ m: g["Player 2"], s: num(g["P2 Points"]) }); });
      scores.sort((x, y) => y.s - x.s);
      const avg = scores.reduce((t, x) => t + x.s, 0) / (scores.length || 1);
      const boxLink = (x) => '<a href="#/game/' + gameRoute(x.g.Year, x.g.Week, x.g["Player 1"], x.g["Player 2"]) + '">Box score</a>';
      const sc = (v) => v.toFixed(2);

      // rosters for this week
      const ros = d.rosters.filter((r) => r.Year === yr && +r.Week === rw && r.Player && r.Player !== "(Empty)" && isNum(r.Points));
      const starters = ros.filter((r) => r.Started === "Yes").sort((a, b) => num(b.Points) - num(a.Points));
      const bench = ros.filter((r) => r.Started !== "Yes" && r.Slot !== "IR").sort((a, b) => num(b.Points) - num(a.Points));
      // projected team totals from starters' projections (for upsets)
      const proj = {};
      ros.filter((r) => r.Started === "Yes" && isNum(r["Proj Pts"])).forEach((r) => (proj[r.Manager] = (proj[r.Manager] || 0) + num(r["Proj Pts"])));
      const lu = d.lineups.filter((r) => r.Year === yr && +r.Week === rw && isNum(r["Bench Left"]));

      const items = [];   // {key, title, big, who, text, link}
      const text = [];    // plain-text lines for the group chat
      const close = G.slice().sort((a, b) => a.margin - b.margin)[0];
      const blow = G.slice().sort((a, b) => b.margin - a.margin)[0];
      const seed = yr + wk;
      if (close) {
        items.push({ title: "Game of the week", big: "by " + close.margin.toFixed(2), who: close.w,
          text: close.tie ? esc(close.w) + " and " + esc(close.l) + " finished dead even, " + sc(close.ws) + " apiece."
            : esc(close.w) + " " + pickLine(seed + "c", ["edged", "survived", "slipped past", "held off"]) + " " + esc(close.l) + ", " + sc(close.ws) + "–" + sc(close.ls) + ".", link: boxLink(close) });
        text.push("🔥 Game of the week: " + close.w + " " + sc(close.ws) + " – " + sc(close.ls) + " " + close.l);
      }
      if (blow && blow !== close) {
        items.push({ title: "Blowout", big: "+" + blow.margin.toFixed(2), who: blow.w,
          text: esc(blow.w) + " " + pickLine(seed + "b", ["ran over", "flattened", "embarrassed", "cruised past"]) + " " + esc(blow.l) + ", " + sc(blow.ws) + "–" + sc(blow.ls) + ".", link: boxLink(blow) });
        text.push("💥 Blowout: " + blow.w + " beat " + blow.l + " by " + blow.margin.toFixed(2));
      }
      if (scores.length) {
        const top = scores[0], low = scores[scores.length - 1];
        items.push({ title: "Top score", big: sc(top.s), who: top.m, text: esc(top.m) + " led the league, " + (top.s - avg).toFixed(1) + " over the week’s average of " + avg.toFixed(1) + ".", link: "" });
        items.push({ title: "Low score", big: sc(low.s), who: low.m, text: esc(low.m) + " " + pickLine(seed + "l", ["brought up the rear", "had the week’s worst score", "would like this one back"]) + ".", link: "" });
        text.push("🏆 Top score: " + top.m + " " + sc(top.s) + "   🧊 Low score: " + low.m + " " + sc(low.s));
      }
      // upset by projection
      const ups = G.filter((x) => !x.tie && proj[x.w] && proj[x.l] && proj[x.l] > proj[x.w]).sort((a, b) => (proj[b.l] - proj[b.w]) - (proj[a.l] - proj[a.w]))[0];
      if (ups) {
        items.push({ title: "Upset", big: "+" + (proj[ups.l] - proj[ups.w]).toFixed(1), who: ups.w,
          text: esc(ups.w) + " was projected to lose by " + (proj[ups.l] - proj[ups.w]).toFixed(1) + " and beat " + esc(ups.l) + " anyway.", link: boxLink(ups) });
        text.push("😮 Upset: " + ups.w + " beat " + ups.l + " (projected to lose by " + (proj[ups.l] - proj[ups.w]).toFixed(1) + ")");
      }
      // player of the week + bench blunder
      if (starters.length) {
        const p = starters[0];
        items.push({ title: "Player of the week", big: fmt(p.Points), who: p.Manager,
          text: plink(p.Player) + (posOf[p.Player] ? ' <span class="tag">' + esc(posOf[p.Player]) + "</span>" : "") + " put up " + fmt(p.Points) + " for " + esc(p.Manager) + ".", link: "" });
        text.push("⭐ Player of the week: " + p.Player + " " + fmt(p.Points) + " (" + p.Manager + ")");
      }
      const blunder = lu.slice().sort((a, b) => num(b["Bench Left"]) - num(a["Bench Left"]))[0];
      if (blunder && num(blunder["Bench Left"]) > 0) {
        const lost = num(blunder["Self-Inflicted Loss"]) === 1;
        const bb = bench.find((r) => r.Manager === blunder.Manager);
        items.push({ title: lost ? "Self-inflicted loss" : "Bench blunder", big: fmt(blunder["Bench Left"]) + " left", who: blunder.Manager,
          text: esc(blunder.Manager) + " left " + fmt(blunder["Bench Left"]) + " points on the bench" + (bb ? ", including " + plink(bb.Player) + " (" + fmt(bb.Points) + ")" : "") +
            (lost ? ", and the right lineup would have won it." : "."), link: "" });
        text.push("🪑 " + (lost ? "Self-inflicted loss" : "Bench blunder") + ": " + blunder.Manager + " left " + fmt(blunder["Bench Left"]) + " on the bench" + (lost ? " and lost" : ""));
      }

      // standings movement (regular season only)
      let movers = "";
      if (reg) {
        const regGames = inYr.filter((g) => isRegularWeek(g.Week));
        const table_ = (upTo) => {
          const t = {};
          regGames.filter((g) => +g.Week <= upTo).forEach((g) => {
            const w = gameWinner(g);
            [[g["Player 1"], num(g["P1 Points"])], [g["Player 2"], num(g["P2 Points"])]].forEach(([m, pts]) => {
              const o = (t[m] = t[m] || { m: m, w: 0, l: 0, t: 0, pf: 0, streak: 0 });
              o.pf += pts;
              if (!w) { o.t++; o.streak = 0; } else if (w === m) { o.w++; o.streak = o.streak > 0 ? o.streak + 1 : 1; } else { o.l++; o.streak = o.streak < 0 ? o.streak - 1 : -1; }
            });
          });
          const list = Object.values(t).sort((a, b) => (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);
          list.forEach((o, i) => (o.rank = i + 1));
          return list;
        };
        const now = table_(+wk), before = +wk > 1 ? table_(+wk - 1) : [];
        const prevRank = {};
        before.forEach((o) => (prevRank[o.m] = o.rank));
        const rec = (o) => o.w + "-" + o.l + (o.t ? "-" + o.t : "");
        movers = section("Standings after " + wkName, '<div class="scroll"><table class="recap-st"><thead><tr><th scope="col" class="num">#</th><th scope="col">Manager</th><th scope="col" class="num">Record</th>' +
          '<th scope="col" class="num">PF</th><th scope="col" class="num">Move</th><th scope="col" class="num">Streak</th></tr></thead><tbody>' +
          now.map((o) => {
            const mv = prevRank[o.m] ? prevRank[o.m] - o.rank : 0;
            return "<tr" + (o.rank <= 6 ? "" : ' class="out"') + '><td class="num rank">' + o.rank + '</td><td class="name">' + link("career/" + enc(o.m), o.m) + '</td><td class="num">' + rec(o) +
              '</td><td class="num">' + o.pf.toFixed(1) + '</td><td class="num">' + (mv > 0 ? '<span class="pos">▲' + mv + "</span>" : mv < 0 ? '<span class="neg">▼' + -mv + "</span>" : '<span class="muted">–</span>') +
              '</td><td class="num">' + (o.streak > 0 ? "W" + o.streak : o.streak < 0 ? "L" + -o.streak : "—") + "</td></tr>";
          }).join("") + "</tbody></table></div>" + '<p class="note">Top 6 make the playoffs; the line sits under 6th.</p>', "Through " + wkName);
        const up = now.filter((o) => prevRank[o.m]).sort((a, b) => (prevRank[b.m] - b.rank) - (prevRank[a.m] - a.rank))[0];
        if (up && prevRank[up.m] - up.rank >= 2) text.push("📈 Biggest climb: " + up.m + " up " + (prevRank[up.m] - up.rank) + " to #" + up.rank);
        const hot = now.filter((o) => o.streak >= 3).sort((a, b) => b.streak - a.streak)[0];
        const cold = now.filter((o) => o.streak <= -3).sort((a, b) => a.streak - b.streak)[0];
        if (hot) text.push("🔥 " + hot.m + " has won " + hot.streak + " straight");
        if (cold) text.push("🥶 " + cold.m + " has lost " + -cold.streak + " straight");
      }

      // headline
      const lead = close ? (blow && blow.margin > 40 ? blow.w + " rolls, " : "") + (close.margin < 5 ? close.w + " survives a thriller" : close.w + " edges " + close.l) : wkName;
      const headline = wkName + ": " + lead;
      const results = G.map((x) => (x.tie ? x.w + " and " + x.l + " tied " + sc(x.ws) : x.w + " beat " + x.l + " " + sc(x.ws) + "–" + sc(x.ls)));
      const chat = [CFG.name + " · " + yr + " " + wkName + " recap", headline, ""].concat(results, [""], text).join("\n");

      const nav = filterBar([
        { label: "Year", items: yrs.map((y) => ["recap/" + y, y]), current: "recap/" + yr },
        { label: "Week", items: weeks.map((w) => ["recap/" + yr + "/" + enc(w), isRegularWeek(w) ? "Week " + w : w]), current: "recap/" + yr + "/" + enc(wk) },
      ]);
      return '<div class="hero"><span class="kicker">' + esc(yr) + " · " + esc(wkName) + ' recap</span><h1 class="recap-h1">' + esc(headline) + "</h1></div>" + nav +
        '<div class="recap-actions"><button type="button" class="chip" data-copy-recap>Copy for the group chat</button>' +
        '<a class="chip" href="#/games/' + enc(yr) + "/" + (reg ? enc(wk) : "bracket") + '">' + (reg ? "All " + esc(wkName) + " games" : "Playoff bracket") + "</a></div>" +
        '<textarea class="sr" id="recap-text" aria-hidden="true" tabindex="-1">' + esc(chat) + "</textarea>" +
        section("Results", '<ul class="recap-results">' + G.map((x) => "<li>" + (x.tie ? "<b>" + esc(x.w) + "</b> and <b>" + esc(x.l) + "</b> tied"
          : "<b>" + esc(x.w) + "</b> beat " + esc(x.l)) + ' <span class="num">' + sc(x.ws) + "–" + sc(x.ls) + "</span> " + boxLink(x) + "</li>").join("") + "</ul>") +
        section("Highlights", '<div class="recap-grid">' + items.map((it) => '<article class="recap-card"><div class="rc-title">' + esc(it.title) + '</div><div class="rc-big">' + esc(it.big) +
          '</div><div class="rc-who">' + link("career/" + enc(it.who), it.who) + '</div><p class="rc-text">' + it.text + "</p>" + (it.link ? '<div class="rc-link">' + it.link + "</div>" : "") + "</article>").join("") + "</div>") +
        movers;
    });
  }

  // copy the recap text
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy-recap]");
    if (!b) return;
    const t = document.getElementById("recap-text");
    if (!t) return;
    const done = () => { b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = "Copy for the group chat"), 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); document.execCommand("copy"); done(); });
    else { t.select(); document.execCommand("copy"); done(); }
  });

  /* ============================== sheet check (hidden page: #/check) ============================== */

  const PLAYOFF_LABEL = /^(round [123]|3rd place|5th place|toilet bowl [123])$/i;

  function pageCheck() {
    // Games is read raw here (no name tidying) so typos actually show up
    const rawGames = fetchCsv(CFG.tabs.games).then((t) => toObjects(parseCSV(t)));
    return Promise.all([rawGames, loadMany(["rosters", "positions"])]).then(([games, d]) => {
      const checks = [];
      const add = (title, why, rows, cols) => checks.push({ title: title, why: why, rows: rows, cols: cols });
      const gRow = (g) => "Row " + g._row;
      const gameLink = (g) => (isNum(g["P1 Points"]) && isNum(g["P2 Points"]) ? '<a href="#/game/' + gameRoute(g.Year, g.Week, g["Player 1"], g["Player 2"]) + '">' + esc(g.Year) + " · " + esc(g.Week) + "</a>" : esc(g.Year) + " · " + esc(g.Week));
      const entered = games.filter((g) => g["Player 1"] || g["Player 2"]);

      // 1. scores that aren't numbers
      add("Scores that aren’t numbers", "A comma instead of a period, a stray space or a letter makes Sheets treat a score as text, and the game drops out of everything.",
        entered.filter((g) => (g["P1 Points"] !== "" && !isNum(g["P1 Points"])) || (g["P2 Points"] !== "" && !isNum(g["P2 Points"])))
          .map((g) => [gRow(g), esc(g.Year) + " · " + esc(g.Week), esc(g["Player 1"]) + " vs " + esc(g["Player 2"]), "“" + esc(g["P1 Points"]) + "” / “" + esc(g["P2 Points"]) + "”"]),
        ["Games row", "Week", "Game", "Scores as typed"]);

      // 2. names that don't exactly match the usual spelling
      const counts = {};
      entered.forEach((g) => ["Player 1", "Player 2"].forEach((c) => { if (g[c]) counts[g[c]] = (counts[g[c]] || 0) + 1; }));
      const canon = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 8);
      const canonKey = {};
      canon.forEach((n) => (canonKey[n.toLowerCase().replace(/\s+/g, " ")] = n));
      const badNames = [];
      entered.forEach((g) => ["Player 1", "Player 2", "Winner"].forEach((c) => {
        const v = g[c];
        if (!v || canon.includes(v) || (c === "Winner" && /^tie$/i.test(v))) return;
        const fix = canonKey[v.toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ")];
        badNames.push([gRow(g), esc(g.Year) + " · " + esc(g.Week), esc(c), "“" + esc(v) + "”" + (fix ? " → should be “" + esc(fix) + "”" : " → not one of the 8 managers")]);
      }));
      add("Names that don’t match", "The 8 managers are " + canon.map(esc).join(", ") + ". Anything else (wrong capitals, extra spaces, typos) can create a ghost manager.",
        badNames, ["Games row", "Week", "Column", "Problem"]);

      // 3. week labels
      add("Week labels the site doesn’t recognize", "Weeks should be 1–14, or Round 1–3, 3rd Place, 5th Place, Toilet Bowl 1–3.",
        entered.filter((g) => !(isNum(g.Week) && +g.Week >= 1 && +g.Week <= 17) && !PLAYOFF_LABEL.test(g.Week))
          .map((g) => [gRow(g), esc(g.Year), "“" + esc(g.Week) + "”", esc(g["Player 1"]) + " vs " + esc(g["Player 2"])]),
        ["Games row", "Year", "Week as typed", "Game"]);

      // 4. winner column disagrees with the scores
      add("Winner doesn’t match the scores", "If the Winner column is filled in, it should name the higher scorer (or say Tie for a declared tie).",
        entered.filter((g) => g.Winner && isNum(g["P1 Points"]) && isNum(g["P2 Points"]) && !/^tie$/i.test(g.Winner) &&
          g.Winner !== (num(g["P1 Points"]) > num(g["P2 Points"]) ? g["Player 1"] : num(g["P2 Points"]) > num(g["P1 Points"]) ? g["Player 2"] : g.Winner))
          .map((g) => [gRow(g), gameLink(g), esc(g["Player 1"]) + " " + esc(g["P1 Points"]) + " – " + esc(g["P2 Points"]) + " " + esc(g["Player 2"]), "Winner says “" + esc(g.Winner) + "”"]),
        ["Games row", "Week", "Score", "Problem"]);

      // 5. odd scores
      add("Scores that look wrong", "Negative scores or anything over 250 is almost always a typo.",
        entered.filter((g) => ["P1 Points", "P2 Points"].some((c) => isNum(g[c]) && (num(g[c]) < 0 || num(g[c]) > 250)))
          .map((g) => [gRow(g), gameLink(g), esc(g["Player 1"]) + " vs " + esc(g["Player 2"]), esc(g["P1 Points"]) + " – " + esc(g["P2 Points"])]),
        ["Games row", "Week", "Game", "Scores"]);

      // 6. regular-season game counts (one game per manager per week)
      const played = entered.filter((g) => isNum(g["P1 Points"]) && isNum(g["P2 Points"]) && isNum(g.Week) && +g.Week <= 14);
      const fix = (n) => canonKey[String(n).toLowerCase().replace(/\s+/g, " ")] || n;
      const countIssues = [];
      uniq(played.map((g) => g.Year)).sort().forEach((y) => {
        const wks = uniq(played.filter((g) => g.Year === y).map((g) => g.Week)).sort((a, b) => a - b);
        wks.forEach((w) => {
          const inWk = played.filter((g) => g.Year === y && g.Week === w);
          const seen = {};
          inWk.forEach((g) => [g["Player 1"], g["Player 2"]].forEach((m) => { m = fix(m); seen[m] = (seen[m] || 0) + 1; }));
          canon.forEach((m) => {
            if (!seen[m]) countIssues.push([esc(y), "Week " + esc(w), esc(m), "No game entered"]);
            else if (seen[m] > 1) countIssues.push([esc(y), "Week " + esc(w), esc(m), "Listed in " + seen[m] + " games"]);
          });
        });
      });
      add("Missing or doubled games (weeks 1–14)", "Every manager should play exactly once in each regular-season week that has scores.",
        countIssues, ["Year", "Week", "Manager", "Problem"]);

      // 7. rosters: missing weeks, duplicates, and starter totals that don't match the score
      const rkey = (y, w, m) => y + "|" + w + "|" + m;
      const rost = {};
      d.rosters.forEach((r) => {
        const k = rkey(r.Year, r.Week, r.Manager);
        const o = (rost[k] = rost[k] || { pts: 0, players: {}, dup: [] });
        if (r.Started === "Yes" && isNum(r.Points)) o.pts += num(r.Points);
        if (r.Player && r.Player !== "(Empty)") { if (o.players[r.Player]) o.dup.push(r.Player); o.players[r.Player] = 1; }
      });
      const rosterIssues = [];
      const rosterYears = new Set(d.rosters.map((r) => r.Year));
      entered.filter((g) => isNum(g["P1 Points"]) && isNum(g["P2 Points"]) && rosterYears.has(g.Year)).forEach((g) => {
        const w = rosterWeek(g.Week);
        [["Player 1", "P1 Points"], ["Player 2", "P2 Points"]].forEach(([pc, sc]) => {
          const m = fix(g[pc]), o = rost[rkey(g.Year, String(w), m)];
          if (!o) { rosterIssues.push([gameLink(g), esc(m), "No roster rows for this week", ""]); return; }
          if (o.dup.length) rosterIssues.push([gameLink(g), esc(m), "Same player pasted twice", esc(uniq(o.dup).join(", "))]);
          const diff = o.pts - num(g[sc]);
          if (Math.abs(diff) > 0.5) rosterIssues.push([gameLink(g), esc(m), "Starters add up to " + o.pts.toFixed(2) + ", score says " + num(g[sc]).toFixed(2), signed(diff, 2)]);
        });
      });
      add("Rosters that don’t line up with Games", "Checks each game against the Rosters tab: the week was pulled, nobody was pasted twice, and the starters add up to the score in Games.",
        rosterIssues, ["Game", "Manager", "Problem", "Off by"]);

      // 8. players with no position
      const hasPos = new Set(d.positions.filter((r) => r["Final Pos"] || r["Derived Pos"]).map((r) => r.Player));
      const noPos = uniq(d.rosters.filter((r) => r.Player && r.Player !== "(Empty)" && !hasPos.has(r.Player)).map((r) => r.Player));
      add("Players with no position", "These are in Rosters but have no position in the Positions tab, so they’re left out of position rankings and some records.",
        noPos.map((n) => [plink(n)]), ["Player"]);

      const bad = checks.filter((c) => c.rows.length);
      const summary = '<div class="chk-summary ' + (bad.length ? "warn" : "ok") + '">' +
        (bad.length ? "<b>" + bad.length + " of " + checks.length + "</b> checks found something to fix." : "<b>All " + checks.length + " checks passed.</b> The sheet looks clean.") + "</div>" +
        '<ul class="chk-list">' + checks.map((c, i) => '<li class="' + (c.rows.length ? "warn" : "ok") + '"><a href="#/check" data-jump="chk-' + i + '">' +
          '<span class="chk-dot" aria-hidden="true">' + (c.rows.length ? "!" : "✓") + "</span>" + esc(c.title) + '</a><span class="chk-n">' +
          (c.rows.length ? c.rows.length + " to fix" : "OK") + "</span></li>").join("") + "</ul>";
      const details = checks.map((c, i) => '<section class="section chk-sec" id="chk-' + i + '"><div class="section-head"><h2>' + esc(c.title) + '</h2><span class="kicker">' +
        (c.rows.length ? c.rows.length + " to fix" : "All good") + '</span></div><p class="note">' + c.why + "</p>" +
        (c.rows.length ? '<div class="scroll"><table><thead><tr>' + c.cols.map((h) => '<th scope="col">' + esc(h) + "</th>").join("") + "</tr></thead><tbody>" +
          c.rows.slice(0, 200).map((r) => "<tr>" + r.map((x) => "<td>" + x + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>" +
          (c.rows.length > 200 ? '<p class="note">Showing the first 200.</p>' : "") : '<p class="empty">Nothing to fix.</p>') + "</section>").join("");
      return '<div class="hero"><span class="kicker">Commissioner tools</span><h1>Sheet check</h1></div>' +
        '<p class="note">Reads the sheet live and looks for the problems we’ve had to hunt down by hand. “Games row” is the row number in your Games tab. Bookmark this page; it isn’t in the menu.</p>' +
        summary + details;
    });
  }

  /* ============================== trading cards ============================== */

  const CARD_STATS = [
    { k: "SCO", name: "Scoring", w: 0.35, how: "Points per game" },
    { k: "LIN", name: "Lineups", w: 0.15, how: "Average lineup efficiency (weeks 1–14)" },
    { k: "DRA", name: "Drafting", w: 0.15, how: "Value from drafted players" },
    { k: "WAI", name: "Waivers", w: 0.15, how: "Value from waiver pickups" },
    { k: "TRD", name: "Trading", w: 0.10, how: "Net Value from trades" },
    { k: "LCK", name: "Luck", w: 0.10, how: "Actual wins vs all-play wins" },
  ];

  // rank-based 40–99 rating within one season (ties share the average)
  function rateWithin(values) {
    const n = values.length;
    const sorted = values.map((v, i) => ({ v: isNaN(v) ? -Infinity : v, i: i })).sort((a, b) => a.v - b.v);
    const out = new Array(n);
    let j = 0;
    while (j < n) {
      let k = j;
      while (k + 1 < n && sorted[k + 1].v === sorted[j].v) k++;
      const pos = (j + k) / 2;
      for (let t = j; t <= k; t++) out[sorted[t].i] = n > 1 ? Math.round(40 + 59 * pos / (n - 1)) : 70;
      j = k + 1;
    }
    return out;
  }

  const cardCache = {};
  function cardsForYear(d, y) {
    if (cardCache[y]) return cardCache[y];
    const st = d.standings.filter((r) => r.Year === y && r.Player);
    const ms = st.map((r) => r.Player);
    const mv = d.moves.filter((r) => r.Year === y);
    const sumV = (m, how) => mv.filter((r) => r.Manager === m && r["How Acquired"] === how).reduce((s, r) => s + (num(r.Value) || 0), 0);
    // trades: my received value minus what my partners received from me in the same deals
    const net = {};
    ms.forEach((m) => (net[m] = 0));
    mv.filter((r) => r["How Acquired"] === "Trade" && r.From).forEach((r) => {
      const v = num(r.Value) || 0;
      if (r.Manager in net) net[r.Manager] += v;
      if (r.From in net) net[r.From] -= v;
    });
    const lu = d.lineups.filter((r) => r.Year === y && isNum(r.Week) && +r.Week <= 14 && isNum(r.Efficiency));
    const eff = (m) => { const x = lu.filter((r) => r.Manager === m); return x.length ? x.reduce((s, r) => s + num(r.Efficiency), 0) / x.length : NaN; };
    const raw = {
      SCO: st.map((r) => num(r["Avg Points"])),
      LIN: ms.map(eff),
      DRA: ms.map((m) => sumV(m, "Draft")),
      WAI: ms.map((m) => sumV(m, "Waiver")),
      TRD: ms.map((m) => net[m]),
      LCK: st.map((r) => num(r.Luck)),
    };
    const rated = {};
    CARD_STATS.forEach((c) => (rated[c.k] = rateWithin(raw[c.k])));
    const { weeks, series } = eloSeries(d.elo);
    const lastIdx = weeks.map((w, i) => (String(w).startsWith(String(y)) ? i : -1)).filter((i) => i >= 0).pop();
    const cards = st.map((r, i) => {
      const ratings = {};
      CARD_STATS.forEach((c) => (ratings[c.k] = rated[c.k][i]));
      const ovr = Math.round(CARD_STATS.reduce((s, c) => s + c.w * ratings[c.k], 0));
      const ser = series.find((x) => x.name === r.Player);
      const mvp = d.mvps.find((x) => x.Year === y && x.Manager === r.Player);
      return {
        y: y, m: r.Player, ratings: ratings, raw: CARD_STATS.reduce((o, c) => ((o[c.k] = raw[c.k][i]), o), {}),
        ovr: ovr, tier: ovr >= 80 ? "gold" : ovr >= 68 ? "silver" : "bronze",
        rec: r.Record, place: r.Place, champ: num(r.Place) === 1,
        elo: ser && lastIdx != null ? ser.vals[lastIdx] : NaN, mvp: mvp ? mvp.MVP : "",
      };
    });
    cards.sort((a, b) => b.ovr - a.ovr);
    cards.forEach((c, i) => (c.no = i + 1));
    return (cardCache[y] = cards);
  }

  function initials(name) {
    return String(name).split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
  }

  function cardHtml(c, linkIt) {
    const stats = CARD_STATS.map((s) => '<div class="cstat"><span>' + s.k + "</span><b>" + c.ratings[s.k] + "</b></div>").join("");
    const inner =
      '<div class="ctop"><span>' + esc(c.y) + " Series</span><span>No. " + String(c.no).padStart(2, "0") + "</span></div>" +
      '<div class="cart"><span class="cini">' + esc(initials(c.m)) + "</span>" + (c.champ ? '<span class="cchamp">Champion</span>' : "") +
      '<span class="covr"><b>' + c.ovr + "</b>OVR</span></div>" +
      '<div class="cname">' + esc(c.m) + "</div>" +
      '<div class="cstats">' + stats + "</div>" +
      '<div class="cfoot"><span>' + esc(c.rec || "—") + "</span><span>" + (isNum(c.place) ? "Finished #" + esc(c.place) : "In progress") + "</span><span>Elo " +
      (isNaN(c.elo) ? "—" : Math.round(c.elo)) + "</span></div>" +
      (c.mvp ? '<div class="cmvp">MVP · ' + esc(c.mvp) + "</div>" : "");
    return linkIt
      ? '<a class="tcard ' + c.tier + '" href="#/card/' + enc(c.y) + "/" + enc(c.m) + '" aria-label="' + esc(c.m) + " " + esc(c.y) + " card, overall " + c.ovr + '">' + inner + "</a>"
      : '<div class="tcard big ' + c.tier + '">' + inner + "</div>";
  }

  const CARD_TABS = ["standings", "moves", "lineups", "elo", "mvps"];

  function pageCards(yArg) {
    return loadMany(CARD_TABS).then((d) => {
      const yrs = years(d.standings);
      const y = yrs.includes(yArg) ? yArg : yrs[0];
      const cards = cardsForYear(d, y);
      return '<div class="hero"><span class="kicker">Collect them all</span><h1>' + esc(y) + " cards</h1></div>" +
        chips(yrs, y, (x) => "cards/" + x) +
        '<p class="note">Every rating is 40–99, based on where that person ranked in the league that season. <b>OVR</b> weights Scoring 35%, Lineups, Drafting and Waivers 15% each, and Trading and Luck 10% each. Gold 80+, silver 68+, bronze below. Tap a card for the breakdown.</p>' +
        (cards.length ? '<div class="cards">' + cards.map((c) => cardHtml(c, true)).join("") + "</div>" : '<p class="empty">No cards for ' + esc(y) + " yet.</p>");
    });
  }

  function pageCard(y, m) {
    return loadMany(CARD_TABS).then((d) => {
      const c = cardsForYear(d, y).find((x) => x.m === m);
      if (!c) return '<div class="state">Card not found.</div>';
      const rawTxt = (k, v) => (isNaN(v) ? "—" : k === "SCO" ? v.toFixed(2) + " ppg" : k === "LIN" ? pct(v) : k === "LCK" ? signed(v) + " wins" : signed(v) + " value");
      return '<div class="hero"><span class="kicker">' + esc(y) + " card</span><h1>" + esc(m) + "</h1></div>" +
        '<div class="card-detail">' + cardHtml(c, false) +
        '<div class="section"><div class="section-head"><h2>How it’s rated</h2><span class="kicker">Rank among ' + cardsForYear(d, y).length + " managers</span></div>" +
        '<div class="scroll"><table><thead><tr><th scope="col">Stat</th><th scope="col">Based on</th><th scope="col" class="num">This season</th><th scope="col" class="num">Rating</th><th scope="col" class="num">Weight</th></tr></thead><tbody>' +
        CARD_STATS.map((s) => '<tr><td class="name">' + s.k + " · " + esc(s.name) + '</td><td class="muted">' + esc(s.how) + '</td><td class="num">' + rawTxt(s.k, c.raw[s.k]) +
          '</td><td class="num rec-val">' + c.ratings[s.k] + '</td><td class="num">' + Math.round(s.w * 100) + "%</td></tr>").join("") +
        '<tr><td class="name">OVR</td><td class="muted">Weighted total</td><td></td><td class="num rec-val">' + c.ovr + "</td><td></td></tr>" +
        "</tbody></table></div>" +
        '<p class="note">' + link("cards/" + enc(y), "← All " + y + " cards") + " · " + link("career/" + enc(m), m + "’s career") + "</p></div></div>";
    });
  }

  /* ============================== game log ============================== */

  function pageGames(yArg, wArg) {
    return loadMany(["games"]).then((d) => {
      const played = playedGames(d.games);
      const yrs = uniq(played.map((g) => g.Year)).sort((a, b) => b - a);
      const yr = yrs.includes(yArg) ? yArg : yrs[0];
      const inYear = played.filter((g) => g.Year === yr);
      const weeks = uniq(inYear.map((g) => g.Week).filter(isRegularWeek)).sort((a, b) => a - b);
      const postStarted = inYear.some((g) => !isRegularWeek(g.Week));
      // playoff weeks live in the bracket; open it by default once the playoffs have started
      const showBracket = wArg ? !isRegularWeek(wArg) : postStarted;
      const wk = showBracket ? "bracket" : weeks.includes(wArg) ? wArg : weeks[weeks.length - 1];
      const games = inYear.filter((g) => g.Week === wk);
      const label = (w) => (isRegularWeek(w) ? "Wk " + w : w);
      const chip = (w, text) => '<a class="chip' + (w === wk ? " on" : "") + (w === "bracket" ? " bracket-chip" : "") + '" href="#/games/' + enc(yr) + "/" + enc(w) + '"' +
        (w === wk ? ' aria-current="page"' : "") + ">" + esc(text) + "</a>";
      const head = '<div class="hero"><span class="kicker">Game log</span><h1>' + esc(yr) + " · " +
        esc(showBracket ? "Playoff bracket" : isRegularWeek(wk) ? "Week " + wk : wk) + "</h1></div>" +
        filterBar([{ label: "Year", items: yrs.map((y) => ["games/" + y, y]), current: "games/" + yr }]) +
        '<div class="chips weeks">' + weeks.map((w) => chip(w, label(w))).join("") + chip("bracket", "Bracket") + "</div>";
      if (showBracket) return head + (playoffBracket(d.games, yr) || '<div class="state">Not enough games yet to draw a bracket.</div>');
      return head +
        '<p class="note">Tap a game for both lineups. ' + link("recap/" + enc(yr) + "/" + enc(wk), "Read the " + (isRegularWeek(wk) ? "Week " + wk : wk) + " recap →") +
          (yr === yrs[0] ? " &nbsp; " + link("preview", "Next week’s preview →") : "") + "</p>" +
        (games.length ? '<div class="scores">' + games.map((g) => scoreCard(g)).join("") + "</div>" : '<p class="empty">No scores entered for this week yet.</p>');
    });
  }

  const SLOT_ORDER = ["QB", "WR", "RB", "TE", "W/R/T", "K", "DEF", "BN", "IR"];

  function pageGame(y, w, a, b) {
    return loadMany(["games", "rosters", "positions", "lineups"]).then((d) => {
      const g = playedGames(d.games).find((x) => x.Year === y && x.Week === w &&
        ((x["Player 1"] === a && x["Player 2"] === b) || (x["Player 1"] === b && x["Player 2"] === a)));
      if (!g) return '<div class="state">Game not found.</div>';
      const p1 = g["Player 1"], p2 = g["Player 2"];
      const s1 = num(g["P1 Points"]), s2 = num(g["P2 Points"]);
      const gw = gameWinner(g);
      const rw = rosterWeek(w);
      const posOf = {};
      d.positions.forEach((r) => { if (r.Player) posOf[r.Player] = r["Final Pos"] || r["Derived Pos"]; });
      const lu = (m) => d.lineups.find((r) => r.Year === y && +r.Week === rw && r.Manager === m);

      function side(m, score, won) {
        const rows = d.rosters.filter((r) => r.Year === y && +r.Week === rw && r.Manager === m);
        rows.forEach((r, i) => (r._i = i));
        rows.sort((x, z) => (SLOT_ORDER.indexOf(x.Slot) - SLOT_ORDER.indexOf(z.Slot)) || (x._i - z._i));
        const starters = rows.filter((r) => r.Started === "Yes");
        const bench = rows.filter((r) => r.Started !== "Yes");
        const projTot = starters.reduce((s, r) => s + (num(r["Proj Pts"]) || 0), 0);
        const benchBest = Math.max.apply(null, bench.map((r) => num(r.Points)).filter((v) => !isNaN(v)).concat([-Infinity]));
        const line = (r, isBench) => {
          const pts = isNum(r.Points) ? num(r.Points).toFixed(2) : (r.Note ? esc(r.Note.toUpperCase()) : "—");
          const pos = isBench ? (posOf[r.Player] || "") : "";
          const hot = isBench && num(r.Points) === benchBest && benchBest > 0;
          return '<tr class="' + (isBench ? "bench" : "") + '"><td class="slot">' + esc(r.Slot) + (pos ? ' <span class="muted">' + esc(pos) + "</span>" : "") +
            '</td><td class="player">' + plink(r.Player) + '</td><td class="num muted">' + (isNum(r["Proj Pts"]) ? num(r["Proj Pts"]).toFixed(1) : "—") +
            '</td><td class="num' + (hot ? " hotbench" : "") + '">' + pts + "</td></tr>";
        };
        const l = lu(m);
        const extra = l ? '<div class="box-extra"><span>Best possible <b>' + fmt(l.Optimal) + "</b></span><span>Left on bench <b>" + fmt(l["Bench Left"]) +
          "</b></span><span>Efficiency <b>" + pct(l.Efficiency) + "</b></span></div>" : "";
        const tableHtml = rows.length
          ? '<div class="scroll"><table class="box"><thead><tr><th scope="col">Slot</th><th scope="col">Player</th><th scope="col" class="num">Proj</th><th scope="col" class="num">Pts</th></tr></thead><tbody>' +
            starters.map((r) => line(r, false)).join("") +
            '<tr class="divider"><td colspan="4">Bench</td></tr>' + bench.map((r) => line(r, true)).join("") + "</tbody></table></div>"
          : '<p class="note">No roster data for this week.</p>';
        return '<section class="box-side' + (won ? " won" : "") + '"><div class="box-head"><a class="box-name" href="#/career/' + enc(m) + '">' + esc(m) + "</a>" +
          '<span class="box-score">' + score.toFixed(2) + "</span></div>" +
          (rows.length ? '<div class="box-proj">Projected ' + projTot.toFixed(1) + " · " + signed(score - projTot) + " vs proj</div>" : "") +
          extra + tableHtml + "</section>";
      }

      const wkLabel = isRegularWeek(w) ? "Week " + w : w;
      return '<div class="hero"><span class="kicker">' + esc(y) + " · " + esc(wkLabel) + '</span><h1>' + esc(p1) + " vs " + esc(p2) + "</h1></div>" +
        (declaredTie(g) ? '<p class="note"><b>Declared a tie</b> by the league, whatever the final scores say.</p>' : "") +
        '<div class="box-grid">' + side(p1, s1, gw === p1) + side(p2, s2, gw === p2) + "</div>" +
        '<p class="note">Highlighted bench score = the best player left on the bench. ' + (isRegularWeek(w) ? link("games/" + enc(y) + "/" + enc(w), "← All " + wkLabel + " games") : link("games/" + enc(y) + "/bracket", "← " + y + " bracket")) +
        " · " + link("rivalries/" + enc(p1) + "/" + enc(p2), "Full rivalry") + "</p>";
    });
  }

  /* ============================== router ============================== */

  /* "More" menu in the nav (desktop only; phones show every link in a scrolling strip) */
  function setMore(open) {
    const btn = document.querySelector(".nav-more-btn");
    if (!btn) return;
    btn.setAttribute("aria-expanded", String(open));
    document.querySelector(".nav-more").classList.toggle("open", open);
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-more-btn");
    if (btn) { setMore(btn.getAttribute("aria-expanded") !== "true"); return; }
    if (!e.target.closest(".nav-more-menu")) setMore(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.querySelector(".nav-more.open")) { setMore(false); document.querySelector(".nav-more-btn").focus(); }
  });

  function skeleton() {
    const block = (h) => '<div class="sk" style="height:' + h + 'px"></div>';
    return '<div class="sk-wrap" role="status"><span class="sr">Loading the league sheet…</span>' +
      '<div class="sk sk-kicker"></div><div class="sk sk-title"></div>' + block(44) + block(220) + block(160) + "</div>";
  }

  function route() {
    const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").map(decodeURIComponent);
    const name = parts[0] || "home";
    document.querySelectorAll(".nav a").forEach((a) => {
      const navOf = { player: "players", ranks: "players", game: "games", card: "cards", recap: "games", preview: "games", alltime: "records" };
      const on = a.dataset.route === (navOf[name] || name);
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const moreBtn = document.querySelector(".nav-more-btn");
    if (moreBtn) {
      moreBtn.classList.toggle("active", !!document.querySelector(".nav-more-menu a.active"));
      setMore(false);
    }
    // keep the active link in view on the phone nav strip
    const act = document.querySelector(".nav a.active");
    if (act && act.scrollIntoView && window.matchMedia("(max-width: 700px)").matches) act.scrollIntoView({ block: "nearest", inline: "center" });
    let p;
    if (name === "season") p = pageSeason(parts[1]);
    else if (name === "career") p = pageCareer(parts[1]);
    else if (name === "rivalries") p = pageRivalries(parts[1], parts[2]);
    else if (name === "rankings") p = pageRankings();
    else if (name === "games") p = pageGames(parts[1], parts[2]);
    else if (name === "records") p = pageRecords();
    else if (name === "trades") p = pageTrades(parts[1], parts[2], parts[3]);
    else if (name === "check") p = pageCheck();
    else if (name === "recap") p = pageRecap(parts[1], parts[2]);
    else if (name === "alltime") p = pageAllTime();
    else if (name === "preview") p = pagePreview();
    else if (name === "players") p = pagePlayers();
    else if (name === "ranks") p = pageRanks(parts[1], parts[2], parts[3]);
    else if (name === "odds") p = pageOdds();
    else if (name === "cards") p = pageCards(parts[1]);
    else if (name === "card") p = pageCard(parts[1], parts[2]);
    else if (name === "player") p = pagePlayer(parts[1]);
    else if (name === "game") p = pageGame(parts[1], parts[2], parts[3], parts[4]);
    else p = pageHome();
    if (!app.innerHTML) app.innerHTML = skeleton();
    app.classList.add("busy");
    app.setAttribute("aria-busy", "true");
    p.then((html) => { app.innerHTML = html; })
      .catch((err) => {
        console.error(err);
        app.innerHTML = '<div class="state err">Couldn’t load data from the league sheet (' + esc(err.message) +
          '). Check that the sheet is shared as “Anyone with the link can view.”</div>';
      })
      .finally(() => { app.classList.remove("busy"); app.removeAttribute("aria-busy"); });
  }

  let lastName = null;
  window.addEventListener("hashchange", () => {
    const name = (location.hash.replace(/^#\/?/, "") || "").split("/")[0];
    if (name !== lastName) { app.innerHTML = ""; window.scrollTo(0, 0); }
    lastName = name;
    route();
  });
  route();
})();
