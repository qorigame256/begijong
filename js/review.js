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
 *     鳴きの場面（仕様書 6.11章「鳴きの判断の振り返り」）: {kind: "call", n, view: 鳴きの問いの自分の席の view,
 *           act: 答え {type: "pass"|"ron"|"pon"|"chi"|"minkan", own: 手から出した牌の id（pass・ron は []）},
 *           aiBest: Mortal のおすすめ（"pass"|"ron"|"pon"|"chi"|"kan"。聞けなかったら null）, aiOwn: Mortal が鳴くとした手の牌の id（無ければ null）, memo}
 *     打牌の場面には kind が無い（v1 のまま。古い記録もそのまま読める）。
 *   Review.normalize(何でも) → 決まった形の記録（読めない分は捨てる）
 *   Review.scene(view, action, hint) → 場面（hint は mortal.js の hint の答え。無ければ null）。鳴きの問いの答えなら鳴きの場面
 *   Review.callRows(scene) → 鳴きの場面の表の行（Assist.callRows に、答えた行 act と Mortal の行 ai の印を足したもの）
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

  const CALL_ACTS = ["pass", "ron", "pon", "chi", "minkan"];
  const AI_CALL = ["pass", "ron", "pon", "chi", "kan"];
  function scene(view, action, hint) {
    const snap = JSON.parse(JSON.stringify(view));
    delete snap.result; delete snap.final;
    if (view.options && view.options.kind === "call") {
      const type = action.type === "kan" ? "minkan" : action.type;
      const own = type === "pon" || type === "chi" ? action.tiles.slice() : type === "minkan" ? view.hand.filter(t => kindOf(t) === kindOf(view.options.tile)) : [];
      const h = hint && hint.kind === "call" ? hint : null;
      return { kind: "call", n: 0, view: snap, act: { type, own }, aiBest: h ? String(h.best) : null, aiOwn: h && Array.isArray(h.own) ? h.own.slice() : null, memo: "" };
    }
    const h = hint && hint.kind === "turn" ? hint : null;
    return {
      n: 0, view: snap, cut: action.id, riichi: !!action.riichi,
      ai: h ? h.discards.slice(0, AI_MAX).map(x => x.id) : null,
      aiRiichi: h && isId(h.riichi) ? h.riichi : null,
      aiBest: h ? String(h.best) : null, memo: "",
    };
  }

  function okView(v) {
    return !!v && Array.isArray(v.hand) && Array.isArray(v.rivers) && Array.isArray(v.melds) && Array.isArray(v.scores) &&
      Array.isArray(v.doraInd) && Array.isArray(v.names) && !!v.options;
  }
  function okScene(s) {
    if (!s || !okView(s.view)) return false;
    if (s.kind === "call") {
      const o = s.view.options;
      return o.kind === "call" && isId(o.tile) && !!s.act && CALL_ACTS.includes(s.act.type) && Array.isArray(s.act.own) && s.act.own.every(isId);
    }
    return Array.isArray(s.view.options.discards) && isId(s.cut);
  }
  function normScene(s) {
    const n = Number.isInteger(s.n) ? s.n : 0;
    if (s.kind === "call") {
      return {
        kind: "call", n, view: s.view, act: { type: s.act.type, own: s.act.own.slice() },
        aiBest: AI_CALL.includes(s.aiBest) ? s.aiBest : null,
        aiOwn: Array.isArray(s.aiOwn) && s.aiOwn.every(isId) ? s.aiOwn.slice() : null,
        memo: memoText(s.memo),
      };
    }
    return {
      n, view: s.view, cut: s.cut, riichi: s.riichi === true,
      ai: Array.isArray(s.ai) ? s.ai.filter(isId).slice(0, AI_MAX) : null,
      aiRiichi: isId(s.aiRiichi) ? s.aiRiichi : null, aiBest: typeof s.aiBest === "string" ? s.aiBest : null,
      memo: memoText(s.memo), // 打牌の場面
    };
  }
  function normalize(o) {
    const games = [];
    if (o && Array.isArray(o.games)) {
      for (const g of o.games) {
        if (!g || typeof g !== "object" || !Array.isArray(g.scenes)) continue;
        const scenes = g.scenes.filter(okScene).slice(0, SCENES_MAX).map(normScene);
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
    if (sc.kind === "call") return [];
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

  /** 鳴きの場面の表の行。Assist.callRows の各行に act（実際に答えた行）と ai（Mortal のおすすめの行）を足す。 */
  function callRows(sc) {
    const list = Assist.callRows(sc.view);
    if (!list) return [];
    const same = (a, b) => a.length === b.length && a.slice().sort((x, y) => x - y).every((x, i) => x === b.slice().sort((p, q) => p - q)[i]);
    const kinds = ids => ids.map(kindOf).sort((x, y) => x - y).join(",");
    const aiType = sc.aiBest === "kan" ? "minkan" : sc.aiBest;
    return list.map(r => {
      const own = r.type === "pon" || r.type === "chi";
      const act = r.type === sc.act.type && (!own || same(r.own, sc.act.own));
      // Mortal の答えは牌の種類で選択肢を選んでいる（mortal.js の sameTiles）。赤の違いで行が分かれたら id で、合わなければ種類で突き合わせる
      const ai = !!aiType && r.type === aiType && (!own || !sc.aiOwn || same(r.own, sc.aiOwn) ||
        (!list.some(x => x.type === r.type && same(x.own, sc.aiOwn)) && kinds(r.own) === kinds(sc.aiOwn)));
      return Object.assign({}, r, { act, ai });
    });
  }

  return { normalize, scene, put, drop, rows, callRows, memoText, GAMES_MAX, SCENES_MAX, MEMO_MAX };
});
