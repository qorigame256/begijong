/*
 * rig.js — 牌操作（配牌とツモを意図的に選ぶ）。game.js が配牌（deal）とツモ（pick）のたびに呼ぶ。
 * ブラウザでは window.Rig、node では require。
 *
 * 設定（config）:
 *   enabled: false なら全部ふつうの抽選。
 *   showToAll: 牌操作の内容をほかの参加者の画面にも出すか（画面側が使う。ここでは持つだけ）。
 *   seats[4]: 席ごと。
 *     luck   -1〜3（-1 悪い・0 ふつう・1 少し良い・2 良い・3 とても良い）。配牌の良さと、有効牌・和了牌を引く確率。
 *     theme  "none" | "tanyao"（2〜8だけ）| "honitsu"（1色＋字牌）| "chinitsu"（1色だけ）| "toitoi"（同じ牌が重なる）| "yakuhai"（役牌の対子から始まる）
 *     suit   "auto" | "m" | "p" | "s"（honitsu・chinitsu の色。auto は局ごとに抽選）
 *     guard  true なら、他家の当たり牌をツモらない（CPU がこの席からロンしない扱いは cpu.js 側）。
 *     hand   配牌の指定（牌の文字列の並び。'1m'〜'9s'・赤は '5mr'・字牌は E S W N P F C。13枚に足りない分は抽選）。
 *     draws  ツモの予約（同じ書き方。毎局、最初のツモから順にこの牌を引く）。
 *            予約した牌は局の最初に取り置きする（this.reserved。袋には入れたまま、ほかの抽選の対象から外す）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"));
  else root.Rig = factory(root.MJ);
})(typeof self !== "undefined" ? self : this, function (MJ) {
  "use strict";

  const kindOf = id => id >> 2;
  const isRed = id => id === 16 || id === 52 || id === 88;
  function countsOf(ids) {
    const c = new Array(34).fill(0);
    for (const t of ids) c[t >> 2]++;
    return c;
  }

  // 数値は Claude が置いた仮の目安（仕様書「牌操作」）。
  const DEAL_TRIES = { "-1": 3, "0": 1, "1": 2, "2": 4, "3": 10 }; // 配牌を何回引いて、いちばん良い（-1 は悪い）ものを選ぶか
  const DRAW_RATE = { "0": 0, "1": 0.1, "2": 0.22, "3": 0.4 }; // 聴牌前: 有効牌を引かせる確率
  const WIN_RATE = { "0": 0, "1": 0.04, "2": 0.09, "3": 0.2 }; // 聴牌後: 和了牌を引かせる確率
  const TOITOI_RATE = 0.3; // 対々テーマで運がふつうのとき: 手にある牌をもう1枚引かせる確率
  const BAD_RATE = 0.5; // luck -1: 有効牌を避けさせる確率
  const YAKUHAI_FEED_RATE = 0.25; // 役牌テーマ: 残りの役牌を他家に引かせる確率（切られてポンできるように）

  const LUCKS = [-1, 0, 1, 2, 3];
  const THEMES = ["none", "tanyao", "honitsu", "chinitsu", "toitoi", "yakuhai"];
  const SUITS = ["auto", "m", "p", "s"];

  function defaultSeat() { return { luck: 0, theme: "none", suit: "auto", guard: false, hand: [], draws: [] }; }
  function defaultConfig() {
    return { enabled: true, showToAll: false, seats: [defaultSeat(), defaultSeat(), defaultSeat(), defaultSeat()] };
  }
  function validSpec(s) {
    return typeof s === "string" && (/^[1-9][mps]$/.test(s) || /^5[mps]r$/.test(s) || MJ.HONORS.includes(s));
  }
  /** どんな入力でも、決まった形の設定にそろえる。 */
  function normalize(config) {
    const out = defaultConfig();
    if (!config || typeof config !== "object") return out;
    out.enabled = config.enabled !== false;
    out.showToAll = !!config.showToAll;
    for (let s = 0; s < 4; s++) {
      const src = (config.seats && config.seats[s]) || {};
      const dst = out.seats[s];
      if (LUCKS.includes(src.luck)) dst.luck = src.luck;
      if (THEMES.includes(src.theme)) dst.theme = src.theme;
      if (SUITS.includes(src.suit)) dst.suit = src.suit;
      dst.guard = !!src.guard;
      if (Array.isArray(src.hand)) dst.hand = src.hand.filter(validSpec).slice(0, 13);
      if (Array.isArray(src.draws)) dst.draws = src.draws.filter(validSpec).slice(0, 18);
    }
    return out;
  }
  /**
   * 配牌の指定・ツモの予約に spec をもう1枚足せるか。全席の hand と draws を合わせて数える（同じ 136 枚から取るため）。
   * 同じ種類は4枚まで。5 は赤が1枚・赤でない方が3枚まで。
   */
  function canAdd(config, spec) {
    const k = MJ.tileIndex(spec), red = MJ.isRed(spec);
    let n = 0;
    for (const c of config.seats) {
      for (const sp of c.hand.concat(c.draws)) if (MJ.tileIndex(sp) === k && MJ.isRed(sp) === red) n++;
    }
    const five = k < 27 && k % 9 === 4;
    return n < (five ? (red ? 1 : 3) : 4);
  }
  /** その席に何か操作が入っているか。 */
  function seatActive(cfg) {
    return cfg.luck !== 0 || cfg.theme !== "none" || cfg.guard || cfg.hand.length > 0 || cfg.draws.length > 0;
  }

  class Rig {
    constructor(config, rng) {
      this.rng = rng;
      this.config = normalize(config);
      // queue: これから引く予約 [{id（袋に無かった予約は null）, spec}]。done: この局で引き終えた予約の spec（順に）
      this.round = [0, 1, 2, 3].map(() => ({ queue: [], done: [], suit: null, yakuhai: null }));
      this.reserved = new Set(); // ツモの予約で取り置きした牌の id
      this.pool = null;
    }
    /** 対局の途中で設定を替える。運・テーマ・守り・ツモの予約は次のツモから、配牌の指定は次の局から効く。 */
    setConfig(config) {
      this.config = normalize(config);
      // 色を名指ししたら、その局のうちに切り替える（おまかせは配牌のときに決めた色のまま）
      for (let s = 0; s < 4; s++) {
        const suit = this.config.seats[s].suit;
        if (suit !== "auto") this.round[s].suit = "mps".indexOf(suit);
      }
      if (this.pool) this._reserveQueues(this.pool);
    }
    /**
     * ツモの予約の牌を袋の中から決めて取り置きする（袋に無い牌の予約は、順番が来たときに飛ばす）。
     * 対局の途中で呼ばれたときは、この局で引き終えた分（done）を引き直さない: 予約の並びのうち done と先頭から
     * 一致している所までを引き終えた分とみなし、その続きから取り置きする。並びを途中から変えたら、変えた所から引く。
     */
    _reserveQueues(pool) {
      this.reserved.clear();
      for (let s = 0; s < 4; s++) {
        const st = this.round[s], queue = st.queue = [];
        if (!this.config.enabled) continue;
        const specs = this.config.seats[s].draws;
        let same = 0;
        while (same < st.done.length && same < specs.length && specs[same] === st.done[same]) same++;
        st.done.length = same;
        for (const spec of specs.slice(same)) {
          const i = this._findSpec(pool, spec);
          if (i >= 0) this.reserved.add(pool[i]);
          queue.push({ id: i >= 0 ? pool[i] : null, spec });
        }
      }
    }
    /** 取り置きしていない牌の一覧（1枚も無ければ袋の全部）。 */
    _free(pool) {
      if (!this.reserved.size) return pool.slice();
      const f = pool.filter(t => !this.reserved.has(t));
      return f.length ? f : pool.slice();
    }
    /** 牌操作と関係のない抽選（ドラ表示牌など）。取り置きの牌は避ける。 */
    takeRandom(pool) {
      const f = this._free(pool);
      return this._takeId(pool, f[this._rand(f.length)]);
    }
    get active() { return this.config.enabled && this.config.seats.some(seatActive); }

    _rand(n) { return Math.floor(this.rng() * n); }
    _take(pool, index) {
      const id = pool[index];
      pool[index] = pool[pool.length - 1];
      pool.pop();
      return id;
    }
    _takeId(pool, id) { return this._take(pool, pool.indexOf(id)); }
    /** 指定の牌を袋から取る。赤（または赤でない方）が無ければ同じ種類のもう一方。種類ごと無ければ null。 */
    _takeSpec(pool, spec) {
      const i = this._findSpec(pool, spec);
      return i < 0 ? null : this._take(pool, i);
    }
    _findSpec(pool, spec) {
      const k = MJ.tileIndex(spec), red = MJ.isRed(spec);
      const free = t => !this.reserved.has(t);
      let i = pool.findIndex(t => kindOf(t) === k && isRed(t) === red && free(t));
      if (i < 0) i = pool.findIndex(t => kindOf(t) === k && free(t));
      return i;
    }
    /** テーマで引いてよい牌の種類（制限なしは null）。 */
    _allow(seat) {
      const cfg = this.config.seats[seat], st = this.round[seat];
      switch (cfg.theme) {
        case "tanyao": return k => k < 27 && k % 9 >= 1 && k % 9 <= 7;
        case "honitsu": return k => k >= 27 || ((k / 9) | 0) === st.suit;
        case "chinitsu": return k => k < 27 && ((k / 9) | 0) === st.suit;
        default: return null;
      }
    }

    // ---------- 配牌 ----------
    deal(game) {
      const r = game.r, pool = r.pool, cfgs = this.config.seats, on = this.config.enabled;
      this.pool = pool;
      this.reserved.clear();
      for (let s = 0; s < 4; s++) {
        const cfg = cfgs[s], st = this.round[s];
        st.queue = [];
        st.done = [];
        st.suit = cfg.suit === "auto" ? this._rand(3) : "mps".indexOf(cfg.suit);
        st.yakuhai = null;
      }
      if (on) {
        // 1. 指定の配牌
        for (let s = 0; s < 4; s++) {
          for (const spec of cfgs[s].hand) {
            const id = this._takeSpec(pool, spec);
            if (id !== null) r.hands[s].push(id);
          }
        }
        this._reserveQueues(pool);
        // 2. 役牌テーマ: 役牌の対子を先に持たせる
        for (let s = 0; s < 4; s++) {
          if (cfgs[s].theme !== "yakuhai" || r.hands[s].length > 11) continue;
          const free = this._free(pool);
          const kinds = [31, 32, 33, 27 + game.bakaze, game.jikaze(s)].filter(k => free.filter(t => kindOf(t) === k).length >= 3);
          if (!kinds.length) continue;
          const k = kinds[this._rand(kinds.length)];
          this.round[s].yakuhai = k;
          for (let n = 0; n < 2; n++) r.hands[s].push(this._takeId(pool, this._free(pool).find(t => kindOf(t) === k)));
        }
      }
      // 3. 残りを配る。運の良い席から先に選ばせる
      const order = [0, 1, 2, 3].sort((a, b) => (on ? cfgs[b].luck - cfgs[a].luck : 0) || a - b);
      for (const s of order) {
        const need = 13 - r.hands[s].length;
        if (need <= 0) continue;
        const cfg = cfgs[s];
        const luck = on ? cfg.luck : 0;
        const allow = on ? this._allow(s) : null;
        const tries = DEAL_TRIES[luck];
        let best = null, bestScore = 0;
        for (let t = 0; t < tries; t++) {
          const sample = this._sample(pool, need, allow);
          if (tries === 1) { best = sample; break; }
          const c = countsOf(r.hands[s].concat(sample));
          let score;
          if (cfg.theme === "toitoi") {
            score = 0;
            for (let k = 0; k < 34; k++) score -= c[k] >= 3 ? 3 : c[k] === 2 ? 2 : 0;
          } else score = MJ.shanten(c, 0);
          if (luck < 0) score = -score;
          if (best === null || score < bestScore) { best = sample; bestScore = score; }
        }
        for (const id of best) r.hands[s].push(this._takeId(pool, id));
      }
    }
    /** 袋から need 枚を抜き出す候補を作る（袋は変えない）。allow に合う牌で足りなければ、残りはほかの牌から。 */
    _sample(pool, need, allow) {
      const free = this._free(pool);
      const src = allow ? free.filter(t => allow(kindOf(t))) : free;
      const out = [];
      const drawFrom = arr => {
        while (out.length < need && arr.length) {
          const i = this._rand(arr.length);
          out.push(arr[i]);
          arr[i] = arr[arr.length - 1];
          arr.pop();
        }
      };
      drawFrom(src);
      if (out.length < need) drawFrom(this._free(pool).filter(t => !out.includes(t)));
      return out;
    }

    // ---------- ツモ ----------
    /** seat が次に引く牌を選び、袋から取り出して返す。呼ばれる時点で手は 13 − 3×副露 枚。 */
    pick(game, seat) {
      const r = game.r, pool = r.pool, cfg = this.config.seats[seat], st = this.round[seat];
      if (!this.config.enabled) return this._take(pool, this._rand(pool.length));
      // 1. 予約
      while (st.queue.length) {
        const { id, spec } = st.queue.shift();
        st.done.push(spec);
        if (id === null) continue;
        this.reserved.delete(id);
        if (pool.includes(id)) return this._takeId(pool, id);
      }
      // 守り: 他家の当たり牌を引かない（2 と 3 で使う）
      let danger = null;
      if (cfg.guard) {
        danger = new Set();
        for (let o = 0; o < 4; o++) if (o !== seat) for (const w of game.waits(o)) danger.add(w);
      }
      const allow = this._allow(seat);
      // 2. 役牌テーマの席が対子で持っている役牌を、ほかの席に引かせる（引く席の守り・テーマに反する牌は引かせない）
      for (let o = 0; o < 4; o++) {
        const k = this.round[o].yakuhai;
        if (o === seat || k === null || this.config.seats[o].theme !== "yakuhai") continue;
        if (r.hands[o].filter(t => kindOf(t) === k).length !== 2) continue;
        if ((danger && danger.has(k)) || (allow && !allow(k))) continue;
        const id = this._free(pool).find(t => kindOf(t) === k);
        if (id !== undefined && !this.reserved.has(id) && this.rng() < YAKUHAI_FEED_RATE) return this._takeId(pool, id);
      }
      let cand = this._free(pool);
      const narrow = pred => {
        const f = cand.filter(pred);
        if (f.length) cand = f;
        return f.length > 0;
      };
      // 3. 守り
      if (danger && danger.size) narrow(t => !danger.has(kindOf(t)));
      // 4. テーマ
      if (allow) narrow(t => allow(kindOf(t)));
      // 5. 運
      if (cfg.luck !== 0 || cfg.theme === "toitoi") {
        const c = countsOf(r.hands[seat]), nm = r.melds[seat].length;
        const s0 = MJ.shanten(c, nm);
        const eff = new Set();
        for (let k = 0; k < 34; k++) {
          if (c[k] >= 4) continue;
          c[k]++;
          if (MJ.shanten(c, nm) < s0) eff.add(k);
          c[k]--;
        }
        if (cfg.theme === "toitoi" && s0 > 0) {
          // 対子・刻子が育つ牌を有効牌として扱う
          eff.clear();
          for (let k = 0; k < 34; k++) if (c[k] === 1 || c[k] === 2) eff.add(k);
        }
        if (cfg.luck > 0) {
          const rate = s0 === 0 ? WIN_RATE[cfg.luck] : DRAW_RATE[cfg.luck];
          if (this.rng() < rate) narrow(t => eff.has(kindOf(t)));
        } else if (cfg.luck < 0) {
          if (this.rng() < BAD_RATE) narrow(t => !eff.has(kindOf(t)));
        } else if (this.rng() < TOITOI_RATE) narrow(t => eff.has(kindOf(t)));
      }
      return this._takeId(pool, cand[this._rand(cand.length)]);
    }
  }

  Rig.normalize = normalize;
  Rig.defaultConfig = defaultConfig;
  Rig.seatActive = seatActive;
  Rig.canAdd = canAdd;
  Rig.LUCKS = LUCKS;
  Rig.THEMES = THEMES;
  Rig.SUITS = SUITS;
  return Rig;
});
