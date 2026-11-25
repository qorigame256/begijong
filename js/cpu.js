/*
 * cpu.js — CPU の打ち手。game.view(seat) で見える情報だけで決める（他家の手・山の中は見ない）。
 * ブラウザでは window.Cpu、node では require。
 *   Cpu.decide(view, options, extra) → game.act に渡す行動。
 *     extra.noRonFrom: この席たちからはロンしない（接待）。
 *     extra.level: 強さ "weak" | "normal" | "strong"（無ければ normal）。extra.rng: 弱い CPU が使う乱数（無ければ Math.random）。
 *   強さの違い（仕様書 4.5章）:
 *     weak   受け入れの枚数を見ずに切る。ときどき（TUNE.weakSlip）シャンテン数も見ずに、値打ちの低い牌から切る。立直にも降りない。
 *     normal 受け入れの多い牌を切る。立直されて手が遠い（2シャンテン以上）ときだけ降りる。
 *     strong normal に加えて、立直されたら1シャンテンでも、通りそうな牌で進められないときは降りる。立直されている間は、遠い手から鳴かない。
 *            （3つ鳴いた相手も警戒する形は、測ると順位が良くならなかったので入れていない。2026-11-20）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"));
  else root.Cpu = factory(root.MJ);
})(typeof self !== "undefined" ? self : this, function (MJ) {
  "use strict";

  const kindOf = id => (id % 136) >> 2; // 136 以上は牌操作で作った写し（rig.js の _extra）
  const isRed = id => { const b = id % 136; return b === 16 || b === 52 || b === 88; };
  function countsOf(ids) {
    const c = new Array(34).fill(0);
    for (const t of ids) c[kindOf(t)]++;
    return c;
  }
  const isTanyaoKind = k => k < 27 && k % 9 >= 1 && k % 9 <= 7;

  const LEVELS = ["weak", "normal", "strong"];
  // 数値は Claude が置いた仮の目安（tools/luck-rate.js の --cpu0 で測って決めた）
  const TUNE = {
    weakSlip: 0.3, // 弱い: シャンテン数を見ずに切る確率
    pushUke: 8, // 強い: 警戒中の1シャンテンで押すのに要る受け入れの枚数
    pushDanger: 4, // 強い: 警戒中の1シャンテンで切ってよい牌の危なさの上限（4 は筋・字牌・筋でない端の牌まで。筋でない 2〜8 は切らない）
  };

  /** この席から見えている牌の枚数（自分の手・全員の副露・捨て牌・ドラ表示牌）。 */
  function visibleCounts(view, handIds) {
    const c = countsOf(handIds);
    for (const ms of view.melds) for (const m of ms) for (const t of m.tiles) c[kindOf(t)]++;
    for (const rv of view.rivers) for (const e of rv) if (!e.called) c[kindOf(e.id)]++;
    for (const t of view.doraInd) c[kindOf(t)]++;
    return c;
  }
  function myHand(view) { return view.drawn !== null && view.drawn !== undefined ? view.hand.concat([view.drawn]) : view.hand.slice(); }
  function jikazeOf(view) { return 27 + (view.seat - view.oya + 4) % 4; }
  function isYakuhai(view, k) { return k >= 31 || k === 27 + view.bakaze || k === jikazeOf(view); }
  function doraKinds(view) { return view.doraInd.map(t => MJ.doraOf(kindOf(t))); }

  /** 牌を残しておきたい度合い（小さいほど先に切る）。 */
  function keepValue(view, id, dora) {
    const k = kindOf(id);
    let v;
    if (k >= 27) v = isYakuhai(view, k) ? 0.4 : 0;
    else {
      const n = k % 9;
      v = n === 0 || n === 8 ? 0.3 : n === 1 || n === 7 ? 0.6 : 1;
    }
    if (dora.includes(k)) v += 3;
    if (isRed(id)) v += 3;
    return v;
  }
  /** 警戒する相手の席（立直しているほかの人）。 */
  function threatsOf(view) {
    return [0, 1, 2, 3].filter(o => o !== view.seat && view.riichi[o]);
  }
  /** 警戒する相手（threats）に対する牌 k の危なさ（0 が全員の現物）。 */
  function danger(view, k, vis, threats) {
    let total = 0;
    for (const o of threats) {
      const river = view.rivers[o].map(e => kindOf(e.id));
      if (river.includes(k)) continue;
      if (k >= 27) { total += vis[k] >= 3 ? 0.5 : vis[k] === 2 ? 1.5 : 3; continue; }
      const n = k % 9;
      const lowSuji = n >= 3 && river.includes(k - 3), highSuji = n <= 5 && river.includes(k + 3);
      if (n <= 2) total += highSuji ? (n === 0 ? 1 : 2) : n === 0 ? 4 : 5;
      else if (n >= 6) total += lowSuji ? (n === 8 ? 1 : 2) : n === 8 ? 4 : 5;
      else total += lowSuji && highSuji ? 2 : 6;
    }
    return total;
  }

  function decideTurn(view, o, level, rng) {
    if (o.tsumo) return { type: "tsumo" };
    // 九種九牌は宣言しない（本人決定 2026-11-20。仕様書 4.5章）。o.kyushu があっても、ふつうに打って進める
    const hand = myHand(view), nm = view.melds[view.seat].length;
    const c = countsOf(hand);
    const sNow = MJ.shanten(c, nm);
    for (const k of o.ankan) {
      c[k] -= 4;
      const ok = MJ.shanten(c, nm + 1) <= sNow;
      c[k] += 4;
      if (ok) return { type: "ankan", kind: k };
    }
    for (const id of o.kakan) {
      const k = kindOf(id);
      c[k]--;
      const ok = MJ.shanten(c, nm) <= sNow;
      c[k]++;
      if (ok) return { type: "kakan", id };
    }
    const vis = visibleCounts(view, hand);
    const dora = doraKinds(view);
    // 同じ種類は1回だけ調べる（赤でない方を先に切る）
    const seen = new Set(), cands = [];
    for (const id of o.discards.slice().sort((a, b) => (isRed(a) ? 1 : 0) - (isRed(b) ? 1 : 0))) {
      const k = kindOf(id);
      if (seen.has(k)) continue;
      seen.add(k);
      c[k]--;
      const s = MJ.shanten(c, nm);
      let uke = 0;
      for (let j = 0; j < 34; j++) {
        if (c[j] >= 4) continue;
        c[j]++;
        if (MJ.shanten(c, nm) < s) uke += Math.max(0, 4 - vis[j]); // 牌操作の写しで5枚以上見えても負にしない
        c[j]--;
      }
      c[k]++;
      cands.push({ id, k, s, uke, keep: keepValue(view, id, dora) });
    }
    if (level === "weak") {
      // 弱い: 受け入れを見ない。ときどきシャンテン数も見ない。降りない
      if (rng() < TUNE.weakSlip) cands.sort((a, b) => a.keep - b.keep || a.s - b.s);
      else cands.sort((a, b) => a.s - b.s || a.keep - b.keep);
      const weak = cands[0];
      if (weak.s === 0 && weak.uke > 0 && o.riichi.includes(weak.id)) return { type: "discard", id: weak.id, riichi: true };
      return { type: "discard", id: weak.id };
    }
    cands.sort((a, b) => a.s - b.s || b.uke - a.uke || a.keep - b.keep);
    let pick = cands[0];
    const threats = view.riichi[view.seat] ? [] : threatsOf(view);
    if (threats.length && pick.s >= 1) {
      const rated = cands.map(x => Object.assign({ d: danger(view, x.k, vis, threats) }, x));
      // 強い: 1シャンテンなら、通りそうな牌を切って受け入れが残る形があれば、それで進める
      const push = level === "strong" && pick.s === 1
        ? rated.filter(x => x.s === 1 && x.d <= TUNE.pushDanger && x.uke >= TUNE.pushUke).sort((a, b) => b.uke - a.uke || a.d - b.d)[0] : null;
      if (push) pick = push;
      else if (pick.s >= 2 || level === "strong") {
        // 降りる（いちばん安全な牌を切る）
        pick = rated.sort((a, b) => a.d - b.d || a.s - b.s || b.uke - a.uke)[0];
      }
    }
    if (pick.s === 0 && pick.uke > 0 && o.riichi.includes(pick.id)) return { type: "discard", id: pick.id, riichi: true };
    return { type: "discard", id: pick.id };
  }

  function decideCall(view, o, extra, level) {
    if (o.ron) {
      if (extra && extra.noRonFrom && extra.noRonFrom.includes(o.from)) return { type: "pass" };
      return { type: "ron" };
    }
    const hand = view.hand, melds = view.melds[view.seat], nm = melds.length;
    const c = countsOf(hand);
    const s0 = MJ.shanten(c, nm);
    const k = kindOf(o.tile);
    const menzen = melds.every(m => m.type === "ankan");
    const hasYaku = melds.some(m => m.type !== "chi" && isYakuhai(view, kindOf(m.tiles[0]))) ||
      [27, 28, 29, 30, 31, 32, 33].some(h => isYakuhai(view, h) && c[h] >= 3);
    const tanyaoAfter = own => {
      if (!isTanyaoKind(k) || melds.some(m => m.tiles.some(t => !isTanyaoKind(kindOf(t))))) return false;
      const rest = hand.filter(t => !own.includes(t));
      return rest.filter(t => !isTanyaoKind(kindOf(t))).length <= 1;
    };
    const improves = own => {
      for (const t of own) c[kindOf(t)]--;
      const s = MJ.shanten(c, nm + 1);
      for (const t of own) c[kindOf(t)]++;
      return s < s0;
    };
    if (menzen && s0 <= 1 && !isYakuhai(view, k)) return { type: "pass" }; // 門前で近い手は立直を目指す
    if (level === "strong" && s0 >= 2 && threatsOf(view).length) return { type: "pass" }; // 立直されている間は、遠い手から鳴かない
    for (const own of o.pon) {
      if (improves(own) && (isYakuhai(view, k) || hasYaku || tanyaoAfter(own))) return { type: "pon", tiles: own };
    }
    for (const own of o.chi) {
      if (improves(own) && (hasYaku || tanyaoAfter(own))) return { type: "chi", tiles: own };
    }
    return { type: "pass" };
  }

  function decide(view, options, extra) {
    const level = extra && LEVELS.includes(extra.level) ? extra.level : "normal";
    const rng = (extra && extra.rng) || Math.random;
    return options.kind === "turn" ? decideTurn(view, options, level, rng) : decideCall(view, options, extra, level);
  }

  return { decide, visibleCounts, LEVELS, TUNE };
});
