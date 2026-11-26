/*
 * review.js — 振り返り（仕様書 6.11章）。「迷った」の印を付けた場面の記録と、振り返りの表の計算。画面も保存も持たない
 * （記録は ui.js が各自の端末の localStorage に保存する）。ブラウザでは window.Review、node では require。
 *
 *   記録（store）: {v: 1, games: [対局]}（新しい対局が先）
 *     対局: {id, at: 始めて印を付けた時刻（ミリ秒）, seat: 自分の席, names[4], length, scenes: [場面]}
 *     場面: {n: 対局の中の打牌の通し番号, view: 切る番の自分の席の view（result・final は除く）, cut: 切った牌の id, riichi: 立直して切ったか,
 *           ai: Mortal のおすすめの切る牌の id を評価の高い順に3つまで（聞けなかったら null）, aiRiichi: Mortal が立直で切るとした牌の id | null,
 *           aiBest: Mortal のいちばんの行動（"dahai" | "reach" | "hora" | "ankan" など。聞けなかったら null）,
 *           memo: 本人が振り返りで書いたメモ（MEMO_MAX 文字まで。無ければ ""）}
 *   Review.normalize(何でも) → 決まった形の記録（読めない分は捨てる）
 *   Review.scene(view, action, hint) → 場面（hint は mortal.js の hint の答え。無ければ null）
 *   Review.put(store, game) → game を先頭に入れ直した記録（場面が空なら外す。GAMES_MAX 対局まで）
 *   Review.drop(store, gid, n) → 対局 gid から通し番号 n の場面を外した記録（場面が空になれば対局ごと外す。並びは変えない）
 *   Review.memoText(何でも) → メモに残す形の文字列（MEMO_MAX 文字まで）
 *   Review.rows(scene) → 表の行 [{key, id, k, red, shanten, total, uke, keep, cut, ai}]（切ったあとのシャンテン数の小さい順 → 受け入れの多い順）
 *     ai = Mortal の順位 1〜3（無ければ 0）。期待値は ui.js が Worker で計算して key（Assist.evKey）で突き合わせる。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./assist.js"));
  else root.Review = factory(root.Assist);
})(typeof self !== "undefined" ? self : this, function (Assist) {
  "use strict";

  const GAMES_MAX = 20; // 端末に残す対局の数（印を付けた対局の新しい方から）
  const SCENES_MAX = 40; // 1対局に残す場面の数
  const AI_MAX = 3; // Mortal のおすすめを残す数（手牌の 1〜3 の印と同じ）
  const MEMO_MAX = 200; // 1場面のメモの文字数
  const memoText = x => (typeof x === "string" ? [...x].slice(0, MEMO_MAX).join("") : "");

  const kindOf = id => (id % 136) >> 2; // 136 以上は牌操作で作った写し（rig.js の _extraId）
  const isRed = id => { const b = id % 136; return b === 16 || b === 52 || b === 88; };
  const isId = x => Number.isInteger(x) && x >= 0;

  function scene(view, action, hint) {
    const snap = JSON.parse(JSON.stringify(view));
    delete snap.result; delete snap.final;
    const h = hint && hint.kind === "turn" ? hint : null;
    return {
      n: 0, view: snap, cut: action.id, riichi: !!action.riichi,
      ai: h ? h.discards.slice(0, AI_MAX).map(x => x.id) : null,
      aiRiichi: h && isId(h.riichi) ? h.riichi : null,
      aiBest: h ? String(h.best) : null, memo: "",
    };
  }

  function okScene(s) {
    const v = s && s.view;
    return !!v && Array.isArray(v.hand) && Array.isArray(v.rivers) && Array.isArray(v.melds) && Array.isArray(v.scores) &&
      Array.isArray(v.doraInd) && Array.isArray(v.names) && v.options && Array.isArray(v.options.discards) && isId(s.cut);
  }
  function normalize(o) {
    const games = [];
    if (o && Array.isArray(o.games)) {
      for (const g of o.games) {
        if (!g || typeof g !== "object" || !Array.isArray(g.scenes)) continue;
        const scenes = g.scenes.filter(okScene).slice(0, SCENES_MAX).map(s => ({
          n: Number.isInteger(s.n) ? s.n : 0, view: s.view, cut: s.cut, riichi: s.riichi === true,
          ai: Array.isArray(s.ai) ? s.ai.filter(isId).slice(0, AI_MAX) : null,
          aiRiichi: isId(s.aiRiichi) ? s.aiRiichi : null, aiBest: typeof s.aiBest === "string" ? s.aiBest : null,
          memo: memoText(s.memo),
        }));
        if (!scenes.length) continue;
        games.push({
          id: String(g.id), at: Number(g.at) || 0, seat: [0, 1, 2, 3].includes(g.seat) ? g.seat : scenes[0].view.seat,
          names: Array.isArray(g.names) ? g.names.map(String).slice(0, 4) : scenes[0].view.names.map(String),
          length: g.length === "east" ? "east" : "south", scenes,
        });
        if (games.length >= GAMES_MAX) break;
      }
    }
    return { v: 1, games };
  }

  function put(store, game) {
    const games = store.games.filter(g => g.id !== game.id);
    if (game.scenes.length) games.unshift(game);
    return { v: 1, games: games.slice(0, GAMES_MAX) };
  }

  function drop(store, gid, n) {
    const games = [];
    for (const g of store.games) {
      if (g.id !== gid) { games.push(g); continue; }
      const scenes = g.scenes.filter(s => s.n !== n);
      if (scenes.length) games.push(Object.assign({}, g, { scenes }));
    }
    return { v: 1, games };
  }

  function rows(sc) {
    const a = Assist.analyze(sc.view);
    if (!a || !a.discards) return [];
    const byKey = new Map();
    for (const [id, d] of a.discards) {
      const key = Assist.evKey(d.k, d.red);
      if (!byKey.has(key)) byKey.set(key, { key, id, k: d.k, red: d.red, shanten: d.shanten, total: d.total, uke: d.uke, keep: d.keep, cut: false, ai: 0 });
    }
    const at = id => byKey.get(Assist.evKey(kindOf(id), isRed(id)));
    const cut = at(sc.cut);
    if (cut) cut.cut = true;
    (sc.ai || []).forEach((id, i) => { const r = at(id); if (r && !r.ai) r.ai = i + 1; });
    return [...byKey.values()].sort((x, y) => x.shanten - y.shanten || y.total - x.total || x.k - y.k || (x.red ? 1 : 0) - (y.red ? 1 : 0));
  }

  return { normalize, scene, put, drop, rows, memoText, GAMES_MAX, SCENES_MAX, MEMO_MAX };
});
