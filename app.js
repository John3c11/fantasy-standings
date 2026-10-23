/* Durr Butt Fantasy — reads the league Google Sheet live and renders the site. */
(function () {
  "use strict";

  const CFG = window.LEAGUE_CONFIG;
  const app = document.getElementById("app");
  document.getElementById("tagline").textContent = CFG.tagline;

  /* ============================== data ============================== */

  const cache = {};

  function sheetUrl(gid) {
    return "https://docs.google.com/spreadsheets/d/" + CFG.sheetId +
      "/gviz/tq?tqx=out:csv&headers=1&gid=" + gid;
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
      if (any) out.push(o);
    }
    out.columns = head.filter(Boolean);
    return out;
  }

  function load(tab) {
    if (!cache[tab]) {
      cache[tab] = fetch(sheetUrl(CFG.tabs[tab]))
        .then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then((t) => toObjects(parseCSV(t)));
    }
    return cache[tab];
  }

  function loadMany(names) {
    return Promise.all(names.map(load)).then((arr) => {
      const o = {};
      names.forEach((n, i) => (o[n] = arr[i]));
      return o;
    });
  }

  /* ============================== helpers ============================== */

  function num(v) {
    if (v === undefined || v === null) return NaN;
    const s = String(v).replace(/[,+]/g, "").trim();
    if (s === "") return NaN;
    if (s.endsWith("%")) return parseFloat(s) / 100;
    return parseFloat(s);
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

  function chips(items, current, routeFor) {
    return '<div class="chips">' + items.map((it) =>
      '<a class="chip' + (String(it) === String(current) ? " on" : "") + '" href="#/' + routeFor(it) + '"' +
      (String(it) === String(current) ? ' aria-current="page"' : "") + ">" + esc(it) + "</a>").join("") + "</div>";
  }

  function scoreCard(g, label) {
    const a = num(g["P1 Points"]), b = num(g["P2 Points"]);
    const row = (who, pts, won) => '<div class="game-row' + (won ? " won" : "") + '"><span class="who">' + esc(who) +
      '</span><span class="pts">' + pts.toFixed(2) + "</span></div>";
    return '<a class="game" href="#/game/' + gameRoute(g.Year, g.Week, g["Player 1"], g["Player 2"]) + '" aria-label="Box score: ' +
      esc(g["Player 1"]) + " vs " + esc(g["Player 2"]) + '">' + (label ? '<div class="game-label">' + esc(label) + "</div>" : "") +
      row(g["Player 1"], a, a > b) + row(g["Player 2"], b, b > a) + "</a>";
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
        section(latestLabel + " results", '<div class="scores">' + latest.map((g) => scoreCard(g, post.length ? g.Week : "")).join("") + "</div>") +
        '<div class="grid-2">' +
        section(yr + " standings", table("home-st", [
          { key: "Player", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Player), r.Player) },
          { key: "Record", label: "W-L", num: true, sortVal: (r) => wins(r.Record) * 1000 + num(r["Points For"]) / 10 },
          { key: "Points For", label: "PF", num: true, render: (r) => fmt(r["Points For"]) },
          { key: "Luck", label: "Luck", num: true, render: (r) => signed(r.Luck) },
        ], st, { sortKey: "Record" }), link("season/" + yr, "Full season →")) +
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
      if (post.length) html.push(section("Playoffs", '<div class="scores">' + post.map((g) => scoreCard(g, g.Week)).join("") + "</div>"));

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

  function pageCareer(pArg) {
    return loadMany(["allTime", "standings", "allGames", "mvps", "elo", "projections"]).then((d) => {
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

      const st = d.standings.filter((r) => r.Player === p);
      const cols = standingsCols().slice(1);
      cols.unshift({ key: "Year", label: "Year", num: true, render: (r) => link("season/" + r.Year, r.Year) });
      html.push(section("Season by season", table("career-st-" + p, cols, st, { sortKey: "Year" })));

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

  function pageRecords() {
    return loadMany(["allGames", "standings", "lineups", "projections", "rosters", "positions"]).then((d) => {
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
      const best = (rows, val, asc) => rows.reduce((b, r) => {
        const v = val(r);
        if (isNaN(v)) return b;
        return !b || (asc ? v < b.v : v > b.v) ? { r: r, v: v } : b;
      }, null);
      const out = [];
      const add = (sec, label, hit, value, manager, detail, whenHtml) => {
        if (!hit) return;
        out.push({ sec: sec, label: label, value: value, manager: manager, detail: detail, when: whenHtml });
      };

      /* --- game records --- */
      const wins = ag.filter((r) => num(r.Win) === 1), lossesR = ag.filter((r) => num(r.Loss) === 1);
      const gameRec = (label, rows, val, asc, show) => {
        const h = best(rows, val, asc);
        if (!h) return;
        const r = h.r;
        add("Game records", label, h, show ? show(h.v) : h.v.toFixed(2), r.Player,
          "vs " + esc(r.Opponent) + " (" + num(r.Points).toFixed(2) + " – " + num(r["Opp Points"]).toFixed(2) + ")",
          when(r.Year, r.Week, r.Player, r.Opponent));
      };
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
      const seasonRec = (label, val, asc, show) => {
        const h = best(done, val, asc);
        if (!h) return;
        add("Season records", label, h, show ? show(h.v) : String(h.v), h.r.Player,
          "Went " + esc(h.r.Record) + ", finished #" + esc(h.r.Place), link("season/" + h.r.Year, h.r.Year + " season"));
      };
      seasonRec("Most wins", (r) => wins_(r.Record), false);
      seasonRec("Most points for", (r) => num(r["Points For"]), false, (v) => v.toFixed(2));
      seasonRec("Fewest points for", (r) => num(r["Points For"]), true, (v) => v.toFixed(2));
      seasonRec("Most points against", (r) => num(r["Points Against"]), false, (v) => v.toFixed(2));
      seasonRec("Luckiest season", (r) => num(r.Luck), false, (v) => signed(v));
      seasonRec("Unluckiest season", (r) => num(r.Luck), true, (v) => signed(v));
      seasonRec("Most weekly high scores", (r) => num(r["Weekly Highs"]), false);
      seasonRec("Most weekly low scores", (r) => num(r["Weekly Lows"]), false);

      /* --- streaks --- */
      const streak = (flag) => {
        let top = null;
        uniq(ag.map((r) => r.Player)).forEach((p) => {
          const g = ag.filter((r) => r.Player === p).sort((a, b) => (a.Year - b.Year) || (weekSortKey(a.Week) - weekSortKey(b.Week)));
          let run = 0, start = 0;
          g.forEach((r, i) => {
            if (num(r[flag]) === 1) { if (run === 0) start = i; run++; if (!top || run > top.n) top = { n: run, p: p, a: g[start], b: r }; }
            else run = 0;
          });
        });
        return top;
      };
      [["Longest win streak", "Win"], ["Longest losing streak", "Loss"]].forEach((x) => {
        const t = streak(x[1]);
        if (t) add("Streaks", x[0], t, t.n + " games", t.p,
          "From " + when(t.a.Year, t.a.Week, t.p, t.a.Opponent) + " to " + when(t.b.Year, t.b.Week, t.p, t.b.Opponent), "");
      });

      /* --- lineup records (weeks 1-14) --- */
      const lu = d.lineups.filter((r) => isNum(r.Week) && +r.Week <= 14 && isNum(r.Optimal));
      const luRec = (label, rows, val, asc, show) => {
        const h = best(rows, val, asc);
        if (!h) return;
        const r = h.r;
        add("Lineup records", label, h, show(h.v), r.Manager,
          "Scored " + fmt(r.Score) + " of a possible " + fmt(r.Optimal) + (r.Result === "L" ? ", lost to " + esc(r.Opponent) : ""),
          whenRW(r.Year, r.Week, r.Manager));
      };
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
      const hb = best(sa, (o) => o.bench, false);
      if (hb) add("Lineup records", "Most bench points left (season)", hb, hb.v.toFixed(1), hb.r.m, "", link("season/" + hb.r.y, hb.r.y + " season"));
      const hs = best(sa, (o) => o.sil, false);
      if (hs && hs.v > 0) add("Lineup records", "Most self-inflicted losses (season)", hs, String(hs.v), hs.r.m, "Losses they'd have won with their own bench", link("season/" + hs.r.y, hs.r.y + " season"));

      /* --- projection records --- */
      const pj = d.projections.filter((r) => r.Result === "W" || r.Result === "L");
      const up = best(pj.filter((r) => num(r["Upset Loss"]) === 1), (r) => num(r.Proj) - num(r["Opp Proj"]), false);
      if (up) add("Projections", "Biggest upset loss", up, "Proj +" + up.v.toFixed(1), up.r.Manager,
        "Projected " + fmt(up.r.Proj, 1) + "–" + fmt(up.r["Opp Proj"], 1) + ", lost " + fmt(up.r.Score) + "–" + fmt(up.r["Opp Score"]) + " to " + esc(up.r.Opponent),
        whenRW(up.r.Year, up.r.Week, up.r.Manager));
      [["Most points over projection", false], ["Most points under projection", true]].forEach((x) => {
        const h = best(pj, (r) => num(r["Vs Proj"]), x[1]);
        if (h) add("Projections", x[0], h, signed(h.v, 2), h.r.Manager, "Scored " + fmt(h.r.Score) + " vs projected " + fmt(h.r.Proj), whenRW(h.r.Year, h.r.Week, h.r.Manager));
      });

      /* --- render the record sections --- */
      const secs = uniq(out.map((o) => o.sec));
      let html = '<div class="hero"><span class="kicker">League history</span><h1>Records</h1></div>' +
        '<p class="note">Tap a date to open that game’s box score.</p>';
      secs.forEach((sec) => {
        html += section(sec, '<div class="scroll"><table class="records"><thead><tr><th scope="col">Record</th><th scope="col" class="num">Value</th><th scope="col">Manager</th><th scope="col">Detail</th><th scope="col">When</th></tr></thead><tbody>' +
          out.filter((o) => o.sec === sec).map((o) =>
            '<tr><td class="rec-label">' + esc(o.label) + '</td><td class="num rec-val">' + esc(o.value) + '</td><td class="name">' + link("career/" + enc(o.manager), o.manager) +
            '</td><td class="detail">' + o.detail + '</td><td class="when">' + o.when + "</td></tr>").join("") + "</tbody></table></div>");
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
    });
  }
  const wins_ = (rec) => wins(rec);

  /* ============================== trades & pickups ============================== */

  function pageTrades(yArg) {
    return loadMany(["moves"]).then((d) => {
      const mv = d.moves.filter((r) => r.Player && r.Manager);
      const yrs = uniq(mv.map((r) => r.Year)).filter(isNum).sort((a, b) => b - a);
      const yr = yrs.includes(yArg) ? yArg : "All";
      const inYr = yr === "All" ? mv : mv.filter((r) => r.Year === yr);
      const val = (r) => num(r.Value) || 0;
      const valTxt = (v) => '<span class="' + (v > 0 ? "pos" : v < 0 ? "neg" : "") + '">' + signed(v) + "</span>";

      /* group traded players into trades: same year + week + the same two managers */
      const trades = {};
      inYr.filter((r) => r["How Acquired"] === "Trade" && r.From).forEach((r) => {
        const pair = [r.Manager, r.From].sort();
        const k = r.Year + "|" + r["First Week"] + "|" + pair.join("|");
        const t = trades[k] = trades[k] || { y: r.Year, w: r["First Week"], a: pair[0], b: pair[1], got: {} };
        (t.got[r.Manager] = t.got[r.Manager] || []).push(r);
      });
      const tradeList = Object.values(trades).sort((x, z) => (z.y - x.y) || (z.w - x.w));
      const sideTotal = (t, m) => (t.got[m] || []).reduce((s, r) => s + val(r), 0);

      const tradeCard = (t) => {
        const va = sideTotal(t, t.a), vb = sideTotal(t, t.b);
        const winner = va > vb ? t.a : vb > va ? t.b : null;
        const side = (m, v) => '<div class="trade-side' + (winner === m ? " won" : "") + '"><div class="trade-who">' + link("career/" + enc(m), m) +
          '<span class="trade-val">' + valTxt(v) + "</span></div><ul>" +
          ((t.got[m] || []).map((r) => "<li><span>" + plink(r.Player) + ' <span class="muted">' + esc(r.Pos || "") + '</span></span><span class="mono">' +
            fmt(r["Started Pts"], 1) + " pts · " + valTxt(val(r)) + "</span></li>").join("") || '<li class="muted">Nothing tracked</li>') + "</ul></div>";
        return '<article class="trade"><div class="game-label">' + esc(t.y) + " · Week " + esc(t.w) +
          (winner ? " · " + esc(winner) + " won by " + Math.abs(va - vb).toFixed(1) : " · Even") + "</div>" +
          '<div class="trade-body">' + side(t.a, va) + side(t.b, vb) + "</div></article>";
      };

      /* per-manager summary */
      const ms = uniq(mv.map((r) => r.Manager)).sort();
      const summary = ms.map((m) => {
        let tw = 0, tl = 0, net = 0;
        tradeList.forEach((t) => {
          if (t.a !== m && t.b !== m) return;
          const o = t.a === m ? t.b : t.a;
          const mine = sideTotal(t, m), theirs = sideTotal(t, o);
          net += mine - theirs;
          if (mine > theirs) tw++; else if (theirs > mine) tl++;
        });
        const wv = inYr.filter((r) => r.Manager === m && r["How Acquired"] === "Waiver");
        const dr = inYr.filter((r) => r.Manager === m && r["How Acquired"] === "Draft");
        return { m: m, trades: tw + tl, tw: tw, tl: tl, net: net, adds: wv.length,
          wval: wv.reduce((s, r) => s + val(r), 0), dval: dr.reduce((s, r) => s + val(r), 0) };
      });

      const topList = (how, n) => inYr.filter((r) => r["How Acquired"] === how).sort((a, b) => val(b) - val(a)).slice(0, n);
      const moveCols = [
        { key: "Player", label: "Player", cls: "name", render: (r) => plink(r.Player) },
        { key: "Pos", label: "Pos" },
        { key: "Manager", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.Manager), r.Manager) },
        { key: "Year", label: "Year", num: true },
        { key: "First Week", label: "Added Wk", num: true },
        { key: "Starts", label: "Starts", num: true },
        { key: "Started Pts", label: "Started Pts", num: true, render: (r) => fmt(r["Started Pts"], 1) },
        { key: "PPG", label: "PPG", num: true, render: (r) => fmt(r.PPG) },
        { key: "Value", label: "Value", num: true, render: (r) => valTxt(val(r)) },
      ];

      return '<div class="hero"><span class="kicker">Transactions</span><h1>Trades &amp; pickups</h1></div>' +
        chips(["All"].concat(yrs), yr, (y) => (y === "All" ? "trades" : "trades/" + y)) +
        '<p class="note"><b>Value</b> = points a player scored as a starter, minus what a typical bench player at his position would have scored in the same starts. Trades are won by the side whose new players added more Value. Theme-team weeks don’t count.</p>' +
        section("Manager scorecard", table("tr-sum-" + yr, [
          { key: "m", label: "Manager", cls: "name", render: (r) => link("career/" + enc(r.m), r.m) },
          { key: "trades", label: "Trades", num: true, sortVal: (r) => r.trades, render: (r) => r.trades },
          { key: "tw", label: "Trade W-L", num: true, sortVal: (r) => r.tw - r.tl, render: (r) => r.tw + "-" + r.tl },
          { key: "net", label: "Net Trade Value", num: true, sortVal: (r) => r.net, render: (r) => valTxt(r.net) },
          { key: "adds", label: "Pickups", num: true, sortVal: (r) => r.adds, render: (r) => r.adds },
          { key: "wval", label: "Pickup Value", num: true, sortVal: (r) => r.wval, render: (r) => valTxt(r.wval) },
          { key: "dval", label: "Draft Value", num: true, sortVal: (r) => r.dval, render: (r) => valTxt(r.dval) },
        ], summary, { sortKey: "net" })) +
        section("Trades", tradeList.length ? '<div class="trades">' + tradeList.map(tradeCard).join("") + "</div>" : '<p class="note">No trades found.</p>',
          tradeList.length + " trade" + (tradeList.length === 1 ? "" : "s")) +
        section("Best waiver pickups", table("tr-wv-" + yr, moveCols, topList("Waiver", 15), { sortKey: "Value" })) +
        section("Best draft values", table("tr-dr-" + yr, moveCols.filter((c) => c.key !== "First Week"), topList("Draft", 10), { sortKey: "Value" }));
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

  function pagePlayers() {
    return loadMany(["rosters", "positions"]).then((d) => {
      const list = playerIndex(d.rosters, d.positions).sort((a, b) => b.tot - a.tot);
      return '<div class="hero"><span class="kicker">NFL players</span><h1>Players</h1></div>' +
        '<label class="search"><span>Search</span><input id="player-search" type="search" placeholder="Type a player or position (e.g. RB)" autocomplete="off"></label>' +
        '<p class="note">Every player who’s been on a roster in the league, by total points scored while rostered.</p>' +
        '<div class="scroll"><table class="plist"><thead><tr><th scope="col">Player</th><th scope="col">Pos</th><th scope="col" class="num">Seasons</th><th scope="col" class="num">Games</th><th scope="col" class="num">Total Pts</th></tr></thead><tbody>' +
        list.map((p) => '<tr data-q="' + esc((p.name + " " + p.pos).toLowerCase()) + '"><td class="name">' + plink(p.name) + "</td><td>" + esc(p.pos) +
          '</td><td class="num">' + p.years.size + '</td><td class="num">' + p.gp + '</td><td class="num">' + p.tot.toFixed(1) + "</td></tr>").join("") +
        "</tbody></table></div>";
    });
  }

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

  /* ============================== game log ============================== */

  function pageGames(yArg, wArg) {
    return loadMany(["games"]).then((d) => {
      const played = playedGames(d.games);
      const yrs = uniq(played.map((g) => g.Year)).sort((a, b) => b - a);
      const yr = yrs.includes(yArg) ? yArg : yrs[0];
      const inYear = played.filter((g) => g.Year === yr);
      const weeks = uniq(inYear.map((g) => g.Week)).sort((a, b) => weekSortKey(a) - weekSortKey(b));
      const wk = weeks.includes(wArg) ? wArg : weeks[weeks.length - 1];
      const games = inYear.filter((g) => g.Week === wk);
      const label = (w) => (isRegularWeek(w) ? "Wk " + w : w);
      return '<div class="hero"><span class="kicker">Game log</span><h1>' + esc(yr) + " · " + esc(isRegularWeek(wk) ? "Week " + wk : wk) + "</h1></div>" +
        chips(yrs, yr, (y) => "games/" + y) +
        '<div class="chips weeks">' + weeks.map((w) =>
          '<a class="chip' + (w === wk ? " on" : "") + '" href="#/games/' + enc(yr) + "/" + enc(w) + '"' + (w === wk ? ' aria-current="page"' : "") + ">" + esc(label(w)) + "</a>").join("") + "</div>" +
        '<p class="note">Tap a game for both lineups.</p>' +
        '<div class="scores">' + games.map((g) => scoreCard(g)).join("") + "</div>";
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
        '<div class="box-grid">' + side(p1, s1, s1 > s2) + side(p2, s2, s2 > s1) + "</div>" +
        '<p class="note">Highlighted bench score = the best player left on the bench. ' + link("games/" + enc(y) + "/" + enc(w), "← All " + wkLabel + " games") +
        " · " + link("rivalries/" + enc(p1) + "/" + enc(p2), "Full rivalry") + "</p>";
    });
  }

  /* ============================== router ============================== */

  function route() {
    const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").map(decodeURIComponent);
    const name = parts[0] || "home";
    document.querySelectorAll(".nav a").forEach((a) => {
      const on = a.dataset.route === name;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    let p;
    if (name === "season") p = pageSeason(parts[1]);
    else if (name === "career") p = pageCareer(parts[1]);
    else if (name === "rivalries") p = pageRivalries(parts[1], parts[2]);
    else if (name === "rankings") p = pageRankings();
    else if (name === "games") p = pageGames(parts[1], parts[2]);
    else if (name === "records") p = pageRecords();
    else if (name === "trades") p = pageTrades(parts[1]);
    else if (name === "players") p = pagePlayers();
    else if (name === "player") p = pagePlayer(parts[1]);
    else if (name === "game") p = pageGame(parts[1], parts[2], parts[3], parts[4]);
    else p = pageHome();
    if (!app.innerHTML) app.innerHTML = '<div class="state">Loading…</div>';
    p.then((html) => { app.innerHTML = html; })
      .catch((err) => {
        console.error(err);
        app.innerHTML = '<div class="state err">Couldn’t load data from the league sheet (' + esc(err.message) +
          '). Check that the sheet is shared as “Anyone with the link can view.”</div>';
      });
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
