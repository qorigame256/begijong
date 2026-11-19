/*
 * cpu.js — CPU の打ち手。game.view(seat) で見える情報だけで決める（他家の手・山の中は見ない）。
 * ブラウザでは window.Cpu、node では require。
 *   Cpu.decide(view, options, extra) → game.act に渡す行動。extra.noRonFrom: この席たちからはロンしない（接待）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"));
  else root.Cpu = factory(root.MJ);
})(typeof self !== "undefined" ? self : this, function (MJ) {
  "use strict";

  const kindOf = id => id >> 2;
  const isRed = id => id === 16 || id === 52 || id === 88;
  function countsOf(ids) {
    const c = new Array(34).fill(0);
    for (const t of ids) c[t >> 2]++;
    return c;
  }
  const isTanyaoKind = k => k < 27 && k % 9 >= 1 && k % 9 <= 7;

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
  /** 立直している相手に対する牌 k の危なさ（0 が現物）。 */
  function danger(view, k, vis) {
    let total = 0;
    for (let o = 0; o < 4; o++) {
      if (o === view.seat || !view.riichi[o]) continue;
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

  function decideTurn(view, o) {
    if (o.tsumo) return { type: "tsumo" };
    if (o.kyushu) return { type: "kyushu" };
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
        if (MJ.shanten(c, nm) < s) uke += 4 - vis[j];
        c[j]--;
      }
      c[k]++;
      cands.push({ id, k, s, uke, keep: keepValue(view, id, dora) });
    }
    cands.sort((a, b) => a.s - b.s || b.uke - a.uke || a.keep - b.keep);
    let pick = cands[0];
    const threatened = view.riichi.some((x, s) => x && s !== view.seat);
    if (threatened && !view.riichi[view.seat] && pick.s >= 2) {
      // 手が遠いときは降りる（いちばん安全な牌を切る）
      const safe = cands.map(x => Object.assign({ d: danger(view, x.k, vis) }, x)).sort((a, b) => a.d - b.d || a.s - b.s || b.uke - a.uke);
      pick = safe[0];
    }
    if (pick.s === 0 && pick.uke > 0 && o.riichi.includes(pick.id)) return { type: "discard", id: pick.id, riichi: true };
    return { type: "discard", id: pick.id };
  }

  function decideCall(view, o, extra) {
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
    for (const own of o.pon) {
      if (improves(own) && (isYakuhai(view, k) || hasYaku || tanyaoAfter(own))) return { type: "pon", tiles: own };
    }
    for (const own of o.chi) {
      if (improves(own) && (hasYaku || tanyaoAfter(own))) return { type: "chi", tiles: own };
    }
    return { type: "pass" };
  }

  function decide(view, options, extra) {
    return options.kind === "turn" ? decideTurn(view, options) : decideCall(view, options, extra);
  }

  return { decide, visibleCounts };
});
