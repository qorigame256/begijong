/*
 * mortal.js — 麻雀 AI「Mortal」に打たせる・打牌のヒントを聞くための部品。ブラウザでは window.Mortal、node では require。
 * Mortal 本体は部屋主の PC の Docker の箱で動く（tools/mortal/bridge.py。http://127.0.0.1:8792）。
 *
 *   log = new Mortal.Log(seat)       席 seat から見た、いまの局の mjai の記録（Mortal が読む書式）
 *   log.feed(events, view)           前回のあとに起きた game.events と、いまの game.view(seat) を渡して記録を進める
 *                                    （CPU は table.js が、ヒントは ui.js が届いた packet で呼ぶ。他家の手・袋は使わない）
 *   log.ok / log.list                記録が使えるか / mjai のできごとの配列
 *   client = Mortal.client(url)      { health(), react(mjaiSeat, events) }
 *   await Mortal.decide(client, log, view, options, extra)  → game.act に渡す行動。Mortal で決められなければ null（呼び手が今の CPU で打つ）
 *   await Mortal.hint(client, log, view)                    → 自分の番・鳴きの問いでの Mortal のおすすめ（ui.js が描く）。出せなければ null
 *
 * 席の番号: mjai の席は起家を 0 とする（mjai = (seat − chicha + 4) % 4）。
 * 記録が作れないとき（牌操作で同じ牌が5枚以上ある・つなぎ直して途中のできごとが飛んだ など）は ok を false にし、次の局の最初まで使わない。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Mortal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const kindOf = id => (id % 136) >> 2;
  const isRed = id => { const b = id % 136; return b === 16 || b === 52 || b === 88; };
  const HONORS = ["E", "S", "W", "N", "P", "F", "C"]; // 東南西北白發中
  function tileStr(id) {
    const k = kindOf(id);
    if (k >= 27) return HONORS[k - 27];
    return (k % 9 + 1) + "mps"[Math.floor(k / 9)] + (isRed(id) ? "r" : "");
  }
  const toM = (view, seat) => (seat - view.chicha + 4) % 4;

  // libriichi の行動の番号（tools/mortal/bridge.py の先頭）
  const A = { REACH: 37, CHI_LOW: 38, CHI_MID: 39, CHI_HIGH: 40, PON: 41, KAN: 42, HORA: 43, RYUKYOKU: 44, NONE: 45 };
  /** 牌 id を切る行動の番号（赤5は 34〜36）。 */
  const discardIndex = id => (isRed(id) ? 34 + Math.floor(kindOf(id) / 9) : kindOf(id));

  class Log {
    constructor(seat) { this.seat = seat; this.ok = false; this.list = []; this.meldSeen = [0, 0, 0, 0]; this.kakanSeen = [new Set(), new Set(), new Set(), new Set()]; }
    /** 記録を捨てて、次の局の最初まで使わない。 */
    breakOff() { this.ok = false; this.list = []; }

    feed(events, view) {
      if (!events || !events.length) return;
      let from = 0;
      for (let i = events.length - 1; i >= 0; i--) if (events[i].t === "start") { from = i; break; }
      if (events[from].t === "start") this._start(events.slice(from + 1), view);
      else if (!this.ok) return;
      else from = -1;
      const rest = events.slice(from + 1);
      rest.forEach((e, i) => { if (this.ok) this._one(e, view, rest.slice(i + 1)); });
      if (this.ok && tooMany(view)) this.breakOff(); // 牌操作の5枚目が見えた（Mortal は「5枚目を見た」で止まる）
    }

    /** 局の始まり。after は同じ束の中で start より後のできごと（手が変わっていれば、いまの view から配牌を作れない）。 */
    _start(after, view) {
      const me = this.seat;
      this.meldSeen = [0, 0, 0, 0]; this.kakanSeen = [new Set(), new Set(), new Set(), new Set()];
      this.ok = false; this.list = [];
      if (after.some(e => (e.t === "discard" || e.t === "call") && e.seat === me)) return;
      if (after.some(e => e.t === "roundEnd" || e.t === "gameEnd")) return;
      if (!view.hand || view.hand.length !== 13 || !view.doraInd || !view.doraInd.length) return;
      if (tooMany(view)) return;
      // 束の中で立直が通っていれば、局の最初の点数と供託へ戻す
      const accepted = after.filter(e => e.t === "riichi");
      const scores = view.scores.slice(), kyotaku = view.kyotaku - accepted.length;
      for (const e of accepted) scores[e.seat] += 1000;
      const tehais = [0, 1, 2, 3].map(() => new Array(13).fill("?"));
      tehais[toM(view, me)] = view.hand.map(tileStr);
      const mScores = [0, 1, 2, 3].map(m => scores[(m + view.chicha) % 4]);
      this.list = [
        { type: "start_game", names: ["0", "1", "2", "3"] },
        {
          type: "start_kyoku", bakaze: "ESW"[view.bakaze] || "E", dora_marker: tileStr(view.doraInd[0]),
          kyoku: view.kyoku + 1, honba: view.honba, kyotaku, oya: toM(view, view.oya), scores: mScores, tehais,
        },
      ];
      this.ok = true;
    }

    _one(e, view, later) {
      const me = this.seat, L = this.list;
      switch (e.t) {
        case "dora": {
          // 明槓・加槓のカンドラは、game.js では打牌のあとにめくる。Mortal の対局場（libriichi の arena/board.rs）は打牌の前に
          // dora を出すので、直前が打牌（と立直の宣言）なら、その前へ入れる（鳴きの問いの最後のできごとを打牌にするため）
          let at = L.length;
          if (at && L[at - 1].type === "dahai") { at--; if (at && L[at - 1].type === "reach" && L[at - 1].actor === L[at].actor) at--; }
          L.splice(at, 0, { type: "dora", dora_marker: tileStr(e.id) });
          break;
        }
        case "draw": {
          const actor = toM(view, e.seat);
          if (e.seat !== me) { L.push({ type: "tsumo", actor, pai: "?" }); break; }
          // 自分のツモ: いまの view のツモ牌。この後にまた自分の手が動いていたら、どの牌だったか分からない
          if (later.some(x => (x.t === "discard" || x.t === "call" || x.t === "draw") && x.seat === me) || view.drawn === null || view.drawn === undefined) return this.breakOff();
          L.push({ type: "tsumo", actor, pai: tileStr(view.drawn) });
          break;
        }
        case "discard": {
          const actor = toM(view, e.seat);
          if (e.riichi) L.push({ type: "reach", actor });
          L.push({ type: "dahai", actor, pai: tileStr(e.id), tsumogiri: !!e.tsumogiri });
          break;
        }
        case "riichi": L.push({ type: "reach_accepted", actor: toM(view, e.seat) }); break;
        case "call": {
          const ms = view.melds[e.seat], actor = toM(view, e.seat);
          if (e.type === "kakan") {
            const i = ms.findIndex((m, j) => j < this.meldSeen[e.seat] && m.type === "kakan" && !this.kakanSeen[e.seat].has(j));
            if (i < 0) return this.breakOff();
            this.kakanSeen[e.seat].add(i);
            const m = ms[i];
            L.push({ type: "kakan", actor, pai: tileStr(m.added), consumed: m.tiles.filter(t => t !== m.added).map(tileStr) });
            break;
          }
          const m = ms[this.meldSeen[e.seat]++];
          if (!m) return this.breakOff();
          if (e.type === "ankan") { L.push({ type: "ankan", actor, consumed: m.tiles.map(tileStr) }); break; }
          // 後で加槓された明刻も、ポンのときの2枚だけを数える
          const own = m.tiles.filter(t => t !== m.called && t !== m.added).map(tileStr);
          const type = e.type === "minkan" ? "daiminkan" : e.type;
          L.push({ type, actor, target: toM(view, m.from), pai: tileStr(m.called), consumed: own });
          break;
        }
        case "roundEnd": case "gameEnd": this.breakOff(); break;
        default: break;
      }
    }
  }

  /** 見えている牌に、同じ牌が5枚以上（牌操作の写し）あるか。Mortal は1種類4枚までしか扱えない。 */
  function tooMany(view) {
    const c = new Array(34).fill(0);
    const add = id => { c[kindOf(id)]++; };
    (view.hand || []).forEach(add);
    if (view.drawn !== null && view.drawn !== undefined) add(view.drawn);
    for (const ms of view.melds || []) for (const m of ms) m.tiles.forEach(add);
    for (const rv of view.rivers || []) for (const e of rv) if (!e.called) add(e.id);
    (view.doraInd || []).forEach(add);
    return c.some(n => n > 4) || (view.hand || []).concat(view.drawn != null ? [view.drawn] : []).some(id => id >= 136);
  }

  function client(url, opts) {
    const base = (url || "http://127.0.0.1:8792").replace(/\/$/, "");
    const timeout = (opts && opts.timeout) || 8000;
    const call = async (path, body) => {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
      try {
        const res = await fetch(base + path, body ? {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl && ctl.signal,
        } : { signal: ctl && ctl.signal });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
        return j;
      } finally { if (timer) clearTimeout(timer); }
    };
    return {
      url: base,
      async health() { try { return !!(await call("/health")).ok; } catch (e) { return false; } },
      async react(seat, events) { return (await call("/react", { seat, events })).reaction; },
    };
  }

  /** 記録の最後のできごとが、この問いに合っているか（ずれていたら Mortal に聞かない）。 */
  function lastFits(log, view, o) {
    const last = log.list[log.list.length - 1];
    if (!last) return false;
    const me = toM(view, log.seat);
    if (o.kind === "turn") return (last.type === "tsumo" && last.actor === me) || ((last.type === "chi" || last.type === "pon") && last.actor === me);
    if (o.chankan) return last.type === "kakan" || last.type === "ankan";
    return last.type === "dahai" && last.actor === toM(view, o.from);
  }
  const sameTiles = (ids, strs) => ids.length === strs.length && ids.map(tileStr).sort().join() === strs.slice().sort().join();

  /** 切る牌の文字 pai から、選べる牌 ids のうちの1枚（ツモ切りならツモ牌を先に）。 */
  function pickId(ids, pai, tsumogiri, drawn) {
    const hits = ids.filter(id => tileStr(id) === pai);
    if (!hits.length) return null;
    if (tsumogiri && hits.includes(drawn)) return drawn;
    return hits.find(id => id !== drawn) !== undefined ? hits.find(id => id !== drawn) : hits[0];
  }

  /** Mortal の行動を game.act の行動へ直す。直せなければ null（理由は api.lastMiss。確かめ用）。 */
  async function decide(cl, log, view, o, extra) {
    api.lastMiss = null;
    if (!cl || !log || !log.ok || !o || !lastFits(log, view, o)) {
      api.lastMiss = { why: !log || !log.ok ? "記録なし" : "記録の最後が問いと合わない", last: log && log.list[log.list.length - 1] };
      return null;
    }
    const me = toM(view, log.seat);
    const list = log.list.slice(); // 聞いている間に記録が進んでも、聞いた時点の写しで続ける
    const r = await cl.react(me, list);
    if (o.kind !== "turn") return callAction(r, o, extra);
    const out = r ? await turnAction(r, o, view, cl, me, list) : null;
    if (!out) {
      api.lastMiss = {
        why: !r ? "答えなし" : r.type === "ryukyoku" ? "九種九牌" : "答えを行動に直せない",
        r, o: { discards: o.discards, riichi: o.riichi, tsumo: o.tsumo, ankan: o.ankan, kakan: o.kakan },
      };
    }
    return out;
  }
  async function turnAction(r, o, view, cl, me, list) {
    switch (r.type) {
      case "hora": return o.tsumo ? { type: "tsumo" } : null;
      case "dahai": {
        const id = pickId(o.discards, r.pai, r.tsumogiri, view.drawn);
        return id === null ? null : { type: "discard", id };
      }
      case "reach": {
        const r2 = await cl.react(me, list.concat([{ type: "reach", actor: me }]));
        if (!r2 || r2.type !== "dahai") return null;
        const id = pickId(o.riichi, r2.pai, r2.tsumogiri, view.drawn);
        return id === null ? null : { type: "discard", id, riichi: true };
      }
      case "ankan": { const kind = kindFromStr(r.consumed && r.consumed[0]); return o.ankan.includes(kind) ? { type: "ankan", kind } : null; }
      case "kakan": { const id = o.kakan.find(x => tileStr(x) === r.pai); return id === undefined ? null : { type: "kakan", id }; }
      default: return null; // 九種九牌（ryukyoku）は宣言しない（仕様書 4.5章）。今の CPU に任せる
    }
  }
  /** 鳴きの問いへの答え。Mortal の答えが選択肢に無ければ見送る。 */
  function callAction(r, o, extra) {
    const noRon = extra && extra.noRonFrom && extra.noRonFrom.includes(o.from);
    if (!r || r.type === "none") return o.ron && o.chankan && !noRon ? { type: "ron" } : { type: "pass" };
    switch (r.type) {
      case "hora": return o.ron && !noRon ? { type: "ron" } : { type: "pass" };
      case "pon": { const v = o.pon.find(x => sameTiles(x, r.consumed)); return v ? { type: "pon", tiles: v } : { type: "pass" }; }
      case "chi": { const v = o.chi.find(x => sameTiles(x, r.consumed)); return v ? { type: "chi", tiles: v } : { type: "pass" }; }
      case "daiminkan": return o.kan ? { type: "kan" } : { type: "pass" };
      default: return { type: "pass" };
    }
  }
  function kindFromStr(s) {
    if (!s) return -1;
    const h = HONORS.indexOf(s);
    if (h >= 0) return 27 + h;
    return "mps".indexOf(s[1]) * 9 + Number(s[0]) - 1;
  }

  /**
   * 打牌のヒント。自分の番なら {kind: "turn", best: 行動, discards: [{id, q}]（評価の高い順）, riichi: 立直がいちばんなら切る牌の id}、
   * 鳴きの問いなら {kind: "call", best: "ron"|"pon"|"chi"|"kan"|"pass", own: ポン・チーで手から出す牌の id の配列 | null}。q は Mortal の評価値（大きいほど良い）。
   */
  async function hint(cl, log, view) {
    const o = view.options;
    if (!cl || !log || !log.ok || !o || !lastFits(log, view, o)) return null;
    const me = toM(view, log.seat);
    const list = log.list.slice();
    const r = await cl.react(me, list);
    if (!r) return null;
    const q = qMap(r.meta);
    if (o.kind !== "turn") {
      const best = r.type === "hora" ? "ron" : r.type === "daiminkan" ? "kan" : r.type === "pon" || r.type === "chi" ? r.type : "pass";
      // own: ポン・チーで手から出すとした牌の id（選択肢の中から。振り返りで鳴き方の行に印を付ける）
      const own = best === "pon" ? o.pon.find(x => sameTiles(x, r.consumed)) : best === "chi" ? o.chi.find(x => sameTiles(x, r.consumed)) : null;
      return { kind: "call", best, tiles: r.consumed || null, own: own || null };
    }
    const discards = [];
    const seen = new Set();
    for (const id of o.discards) {
      const a = discardIndex(id);
      if (seen.has(a) || !q.has(a)) continue;
      seen.add(a);
      discards.push({ id: pickId(o.discards, tileStr(id), true, view.drawn), q: q.get(a) });
    }
    discards.sort((x, y) => y.q - x.q);
    const out = { kind: "turn", best: r.type, discards, riichi: null };
    if (r.type === "dahai") out.bestId = pickId(o.discards, r.pai, r.tsumogiri, view.drawn);
    if (r.type === "reach") {
      const r2 = await cl.react(me, list.concat([{ type: "reach", actor: me }]));
      if (r2 && r2.type === "dahai") out.riichi = pickId(o.riichi, r2.pai, r2.tsumogiri, view.drawn);
    }
    return out;
  }
  /** meta（q_values は選べる行動だけを番号の小さい順に並べたもの、mask_bits はその印）→ Map(行動の番号 → 評価)。 */
  function qMap(meta) {
    const m = new Map();
    if (!meta || !Array.isArray(meta.q_values)) return m;
    let bits = BigInt(meta.mask_bits || 0), i = 0, j = 0;
    while (bits > 0n) {
      if (bits & 1n) m.set(i, meta.q_values[j++]);
      bits >>= 1n; i++;
    }
    return m;
  }

  const api = { Log, client, decide, hint, tileStr, discardIndex, qMap, tooMany, A, lastMiss: null };
  return api;
});
