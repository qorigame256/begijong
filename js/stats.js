/*
 * stats.js — 戦績とレート（仕様書 6.6章）。画面も保存も持たない（記録は ui.js が部屋主のブラウザの localStorage に保存する）。
 * ブラウザでは window.Stats、node では require。
 *
 *   記録（store）: {v: 1, players: {名前: {rate, games, ranks: [1位〜4位の回数], points: 通算ポイント, rounds: 打った局, wins: 和了, dealins: 放銃}}}
 *   Stats.normalize(何でも) → 決まった形の記録（読めない分は捨てる）
 *   Stats.record(store, game) → {store: 新しい記録, rows: [{seat, name, before, after}]}（数えない対局なら rows は空で store はそのまま）
 *     game: {names[4], humans: 人が座っていた席, length: "east" | "south", final: game.js の final, tally: {rounds, wins[4], dealins[4]}}
 *   Stats.list(store, names) → 表の行（レートの高い順）。names を渡すと、その名前の人だけ。
 *   Stats.remove(store, name) → その人を消した記録。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Stats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // レートの数値（Claude が置いた仮の値。天鳳のレートに似た形。仕様書 6.6章）
  const START = 1500; // 初めのレート。CPU の席もこの値とみなす
  const RANK_POINT = [30, 10, -10, -30]; // 順位の点
  const GAP_DIV = 40; // (卓の平均 − 自分) をこれで割って足す
  const GAMES_STEP = 0.002, GAMES_FLOOR = 0.2; // 対局数の補正 = max(GAMES_FLOOR, 1 − GAMES_STEP × それまでの対局数)
  const LENGTH_RATE = { east: 1, south: 1.5 };
  const MIN_HUMANS = 2; // 人がこの数以上座っていた対局だけ数える
  const NAME_MAX = 12;

  const num = (x, d) => (typeof x === "number" && isFinite(x) ? x : d);
  const count = x => Math.max(0, Math.floor(num(x, 0)));
  function blank() { return { rate: START, games: 0, ranks: [0, 0, 0, 0], points: 0, rounds: 0, wins: 0, dealins: 0 }; }
  function normalize(s) {
    // players は継承を持たない辞書にする（「constructor」「__proto__」などの名前で Object の持ち物を拾わないため）
    const out = { v: 1, players: Object.create(null) };
    const src = s && typeof s === "object" && s.players && typeof s.players === "object" ? s.players : {};
    for (const name of Object.keys(src)) {
      const p = src[name];
      if (!p || typeof p !== "object" || !name || name.length > NAME_MAX) continue;
      out.players[name] = {
        rate: num(p.rate, START), games: count(p.games),
        ranks: [0, 1, 2, 3].map(i => count(Array.isArray(p.ranks) ? p.ranks[i] : 0)),
        points: num(p.points, 0), rounds: count(p.rounds), wins: count(p.wins), dealins: count(p.dealins),
      };
    }
    return out;
  }

  function record(store, game) {
    const st = normalize(store);
    const humans = (game.humans || []).filter(s => s >= 0 && s < 4 && typeof game.names[s] === "string" && game.names[s]);
    if (humans.length < MIN_HUMANS || !game.final) return { store: st, rows: [] };
    const before = s => (humans.includes(s) && st.players[game.names[s]] ? st.players[game.names[s]].rate : START);
    const avg = [0, 1, 2, 3].reduce((a, s) => a + before(s), 0) / 4;
    const scale = LENGTH_RATE[game.length] || 1;
    const t = game.tally || { rounds: 0, wins: [0, 0, 0, 0], dealins: [0, 0, 0, 0] };
    // レートは全員の対局前の値から計算してから、まとめて入れる
    const changes = humans.map(s => {
      const name = game.names[s], p = st.players[name] || blank(), rank = game.final.order.indexOf(s);
      const factor = Math.max(GAMES_FLOOR, 1 - GAMES_STEP * p.games);
      return { s, name, rank, delta: (RANK_POINT[rank] + (avg - before(s)) / GAP_DIV) * factor * scale };
    });
    const rows = [];
    for (const c of changes) {
      const p = st.players[c.name] || (st.players[c.name] = blank());
      const from = p.rate;
      p.rate += c.delta;
      p.games++;
      p.ranks[c.rank]++;
      p.points = Math.round((p.points + game.final.points[c.rank]) * 10) / 10;
      p.rounds += count(t.rounds);
      p.wins += count(t.wins[c.s]);
      p.dealins += count(t.dealins[c.s]);
      rows.push({ seat: c.s, name: c.name, before: from, after: p.rate });
    }
    return { store: st, rows };
  }

  function list(store, names) {
    const st = normalize(store);
    const keep = names ? new Set(names) : null;
    return Object.keys(st.players).filter(n => !keep || keep.has(n)).map(name => {
      const p = st.players[name];
      return {
        name, rate: p.rate, games: p.games, ranks: p.ranks.slice(), points: p.points,
        avgRank: p.games ? p.ranks.reduce((a, n, i) => a + n * (i + 1), 0) / p.games : null,
        winRate: p.rounds ? p.wins / p.rounds : null, dealinRate: p.rounds ? p.dealins / p.rounds : null,
      };
    }).sort((a, b) => b.rate - a.rate || b.games - a.games || (a.name < b.name ? -1 : 1));
  }

  function remove(store, name) {
    const st = normalize(store);
    delete st.players[name];
    return st;
  }

  return { normalize, record, list, remove, START, RANK_POINT, LENGTH_RATE, MIN_HUMANS };
});
