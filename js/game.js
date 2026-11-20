/*
 * game.js — 対局の進行（四人麻雀・雀魂の段位戦ルール）。画面を持たない。ブラウザでは window.Mahjong、node では require。
 *
 * 牌は 0〜135 の通し番号（id）。種類（kind）= id >> 2（calc.js と同じ 0〜33）。赤5は id 16（5m）・52（5p）・88（5s）。
 * 山は並びを先に決めない。残りの牌の袋（r.pool）から、引くたびに rig.js が1枚選ぶ（牌操作なしなら等確率＝普通の山と同じ）。
 * ドラ表示牌・嶺上牌も同じ袋から取り、r.liveLeft（残りツモ数。最初 70）で山の終わりを数える。
 *
 * 使い方: g = new Game(opts); g.startRound(); → g.pending[seat] に選べる行動が入る → g.act(seat, action)。
 *   g.phase が "roundEnd" になったら g.result を見せて g.nextRound()。"gameEnd" なら g.final。
 *   席ごとの見える情報は g.view(seat)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"), require("./rig.js"));
  else root.Mahjong = factory(root.MJ, root.Rig);
})(typeof self !== "undefined" ? self : this, function (MJ, Rig) {
  "use strict";

  const kindOf = id => id >> 2;
  const isRed = id => id === 16 || id === 52 || id === 88;
  function countsOf(ids) {
    const c = new Array(34).fill(0);
    for (const t of ids) c[t >> 2]++;
    return c;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 13枚（副露 nm 組）の手の待ち牌の種類。 */
  function waitsOf(c, nm) {
    const out = [];
    for (let k = 0; k < 34; k++) {
      if (c[k] >= 4) continue;
      c[k]++;
      if (MJ.shanten(c, nm) === -1) out.push(k);
      c[k]--;
    }
    return out;
  }
  /** 同じ種類の牌から2枚（または n 枚）を選ぶ組み合わせ。赤の入り方が違うものだけを別の候補にする。 */
  function pickVariants(ids, n) {
    const reds = ids.filter(isRed), plain = ids.filter(t => !isRed(t));
    const out = [];
    for (let nr = 0; nr <= Math.min(reds.length, n); nr++) {
      if (n - nr > plain.length) continue;
      out.push(reds.slice(0, nr).concat(plain.slice(0, n - nr)));
    }
    return out;
  }
  /** 鳴いた直後に切れない牌の種類（喰い替え）。called: 鳴いた牌の種類、own: 手から出した牌の種類。 */
  function kuikaeKinds(type, called, own) {
    if (type !== "chi") return [called];
    const lo = Math.min(...own), hi = Math.max(...own);
    if (called < lo) return called % 9 <= 5 ? [called, called + 3] : [called];
    if (called > hi) return called % 9 >= 3 ? [called, called - 3] : [called];
    return [called];
  }
  /** 副露の写し（結果と view に渡す）。added は加槓で足した牌（画面が重ねて描くのに使う）。 */
  const copyMeld = m => ({ type: m.type, tiles: m.tiles.slice(), called: m.called, from: m.from, added: m.added });

  const START_SCORE = 25000;
  const GOAL_SCORE = 30000;
  const UMA = [15, 5, -5, -15];

  class Game {
    /** opts: {length: "east"|"south", seed, names: [4], rig: 牌操作の設定（rig.js）, chicha: 起家の席} */
    constructor(opts = {}) {
      this.length = opts.length === "east" ? "east" : "south";
      this.seed = opts.seed !== undefined ? opts.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
      this.rng = mulberry32(this.seed);
      this.names = opts.names || ["あなた", "CPU 1", "CPU 2", "CPU 3"];
      this.rig = new Rig(opts.rig, this.rng);
      this.scores = [START_SCORE, START_SCORE, START_SCORE, START_SCORE];
      this.chicha = opts.chicha !== undefined ? opts.chicha : Math.floor(this.rng() * 4);
      this.bakaze = 0; // 0=東 1=南 2=西
      this.kyoku = 0; // 0〜3
      this.honba = 0;
      this.kyotaku = 0;
      this.events = [];
      this.phase = "idle";
      this.pending = {};
      this.responses = {};
      this.result = null;
      this.final = null;
      this.next = null;
      this.r = null;
    }

    get oya() { return (this.chicha + this.kyoku) % 4; }
    jikaze(seat) { return 27 + (seat - this.oya + 4) % 4; }
    _emit(e) { this.events.push(e); }

    // ---------- 局の開始 ----------
    startRound() {
      const pool = [];
      for (let i = 0; i < 136; i++) pool.push(i);
      this.r = {
        pool, liveLeft: 70,
        hands: [[], [], [], []], melds: [[], [], [], []], river: [[], [], [], []],
        doraInd: [], uraInd: [],
        riichi: [0, 0, 0, 0], ippatsu: [false, false, false, false],
        furitenTemp: [false, false, false, false], furitenRiichi: [false, false, false, false],
        noCalls: true, kanCount: 0, kanSeats: new Set(), pendingKanDora: 0, suukan: false,
        turn: this.oya, drawn: null, rinshan: false, afterCall: false, kuikae: [],
        riichiPending: -1, riichiDouble: false, pao: [{}, {}, {}, {}], last: null,
      };
      this.rig.deal(this);
      for (const h of this.r.hands) h.sort((a, b) => a - b);
      this._flipDora();
      this.result = null;
      this.next = null;
      this._emit({ t: "start", bakaze: this.bakaze, kyoku: this.kyoku, honba: this.honba });
      this._draw(this.oya, false);
    }

    _takeRandom() { return this.rig.takeRandom(this.r.pool); }
    _flipDora() {
      const r = this.r;
      r.doraInd.push(this._takeRandom());
      r.uraInd.push(this._takeRandom());
      this._emit({ t: "dora", id: r.doraInd[r.doraInd.length - 1] });
    }
    _flipPendingKanDora() {
      const r = this.r;
      while (r.pendingKanDora > 0) { r.pendingKanDora--; this._flipDora(); }
    }

    // ---------- ツモと手番 ----------
    _draw(seat, rinshan) {
      const r = this.r;
      if (!rinshan && r.liveLeft === 0) return this._exhaustive();
      const id = this.rig.pick(this, seat);
      r.liveLeft--;
      r.hands[seat].push(id);
      r.turn = seat; r.drawn = id; r.rinshan = rinshan; r.afterCall = false; r.kuikae = [];
      this._emit({ t: "draw", seat, rinshan });
      this._setTurn();
    }
    _setTurn() {
      const seat = this.r.turn;
      this.phase = "turn";
      this.pending = { [seat]: this._turnOptions(seat) };
      this.responses = {};
    }
    _turnOptions(seat) {
      const r = this.r, hand = r.hands[seat], melds = r.melds[seat], nm = melds.length;
      const c = countsOf(hand);
      const o = { kind: "turn", discards: [], riichi: [], tsumo: false, ankan: [], kakan: [], kyushu: false };
      const inRiichi = r.riichi[seat] > 0;
      if (!r.afterCall) {
        if (MJ.shanten(c, nm) === -1 && this._score(seat, r.drawn, { tsumo: true })) o.tsumo = true;
        if (r.liveLeft > 0 && r.kanCount < 4) {
          for (let k = 0; k < 34; k++) {
            if (c[k] === 4 && (!inRiichi || this._riichiAnkanOk(seat, k))) o.ankan.push(k);
          }
          if (!inRiichi) {
            for (const id of hand) {
              if (melds.some(m => m.type === "pon" && kindOf(m.tiles[0]) === kindOf(id))) o.kakan.push(id);
            }
          }
        }
        if (r.noCalls && r.river[seat].length === 0) {
          let kinds = 0;
          for (let k = 0; k < 34; k++) if (c[k] && MJ.isYaochu(k)) kinds++;
          if (kinds >= 9) o.kyushu = true;
        }
      }
      if (inRiichi) o.discards = [r.drawn];
      else o.discards = hand.filter(id => !r.kuikae.includes(kindOf(id)));
      const menzen = melds.every(m => m.type === "ankan");
      if (!inRiichi && !r.afterCall && menzen && this.scores[seat] >= 1000 && r.liveLeft >= 4) {
        const ok = new Set();
        for (let k = 0; k < 34; k++) {
          if (!c[k]) continue;
          c[k]--;
          if (MJ.shanten(c, nm) === 0) ok.add(k);
          c[k]++;
        }
        o.riichi = hand.filter(id => ok.has(kindOf(id)));
      }
      return o;
    }
    /** 立直後の暗槓: ツモった牌で、待ちが変わらないときだけ（面子の読み方は変わってもよい。雀魂の段位戦。仕様書 3章）。 */
    _riichiAnkanOk(seat, k) {
      const r = this.r;
      if (r.drawn === null || k !== kindOf(r.drawn)) return false; // 送り槓は不可
      const hand = r.hands[seat], nm = r.melds[seat].length;
      const c13 = countsOf(hand); c13[k]--;
      const before = waitsOf(c13, nm);
      // ツモった牌が当たり牌なら、槓するとその待ちが無くなる（槓のあとの手の数え方では、4枚とも晒した牌も待ちに出てしまうので先に外す）
      if (!before.length || before.includes(k)) return false;
      const cAfter = countsOf(hand); cAfter[k] -= 4;
      return before.join() === waitsOf(cAfter, nm + 1).join();
    }

    /** 席 seat の待ち牌の種類（手番でないとき＝手が 13 − 3×副露 枚のとき）。 */
    waits(seat) {
      const r = this.r;
      return waitsOf(countsOf(r.hands[seat]), r.melds[seat].length);
    }
    isFuriten(seat) {
      const r = this.r;
      if (r.furitenTemp[seat] || r.furitenRiichi[seat]) return true;
      const w = this.waits(seat);
      return r.river[seat].some(e => w.includes(kindOf(e.id)));
    }

    /** 和了の点数（役が無い・和了形でないなら null）。winId: 和了牌。ロンのときは手に足して数える。 */
    _score(seat, winId, { tsumo, chankan }) {
      const r = this.r;
      const ids = r.hands[seat].slice();
      if (!tsumo) ids.push(winId);
      let aka = ids.filter(isRed).length;
      for (const m of r.melds[seat]) aka += m.tiles.filter(isRed).length;
      const melds = r.melds[seat].map(m => ({
        type: m.type === "kakan" ? "minkan" : m.type,
        tile: Math.min(...m.tiles.map(kindOf)),
      }));
      const first = r.noCalls && r.river[seat].length === 0;
      const ctx = {
        tsumo: !!tsumo, oya: seat === this.oya, bakaze: 27 + this.bakaze, jikaze: this.jikaze(seat),
        riichi: r.riichi[seat], ippatsu: r.ippatsu[seat],
        haitei: !!tsumo && r.liveLeft === 0 && !r.rinshan,
        houtei: !tsumo && !chankan && r.liveLeft === 0,
        rinshan: !!tsumo && r.rinshan, chankan: !!chankan,
        dora: r.doraInd.map(kindOf), ura: r.riichi[seat] ? r.uraInd.map(kindOf) : null,
        tenhou: !!tsumo && first && seat === this.oya,
        chiihou: !!tsumo && first && seat !== this.oya,
      };
      return MJ.scoreHand({ c: countsOf(ids), aka, melds, win: kindOf(winId) }, ctx);
    }
    _canRon(seat, id, { chankan, kokushiOnly }) {
      const r = this.r, k = kindOf(id);
      if (!this.waits(seat).includes(k)) return false;
      if (this.isFuriten(seat)) return false;
      if (kokushiOnly) {
        const c = countsOf(r.hands[seat]); c[k]++;
        if (r.melds[seat].length || MJ.kokushiShanten(c) !== -1) return false;
      }
      return !!this._score(seat, id, { tsumo: false, chankan });
    }

    // ---------- 行動の受付 ----------
    act(seat, action) {
      if (!(seat in this.pending)) throw new Error(`席 ${seat} はいま行動できません`);
      if (seat in this.responses) throw new Error(`席 ${seat} は行動済みです`);
      const o = this.pending[seat];
      if (this.phase === "turn") return this._actTurn(seat, o, action);
      if (this.phase !== "call") throw new Error("いまは行動を受け付けていません");
      this._checkCallAction(o, action);
      this.responses[seat] = action;
      if (Object.keys(this.responses).length === Object.keys(this.pending).length) this._resolveCalls();
    }
    _actTurn(seat, o, a) {
      const r = this.r;
      switch (a.type) {
        case "tsumo":
          if (!o.tsumo) throw new Error("ツモ和了できません");
          return this._win([seat], { tsumo: true, tile: r.drawn });
        case "kyushu":
          if (!o.kyushu) throw new Error("九種九牌にできません");
          return this._abort("kyushu", seat);
        case "ankan":
          if (!o.ankan.includes(a.kind)) throw new Error("暗槓できません");
          return this._ankan(seat, a.kind);
        case "kakan":
          if (!o.kakan.includes(a.id)) throw new Error("加槓できません");
          return this._kakan(seat, a.id);
        case "discard":
          if (a.riichi ? !o.riichi.includes(a.id) : !o.discards.includes(a.id)) throw new Error("その牌は切れません");
          return this._discard(seat, a.id, !!a.riichi);
        default:
          throw new Error(`知らない行動: ${a.type}`);
      }
    }
    _checkCallAction(o, a) {
      const sameSet = (x, y) => x.length === y.length && x.slice().sort().join() === y.slice().sort().join();
      if (a.type === "pass") return;
      if (a.type === "ron" && o.ron) return;
      if (a.type === "kan" && o.kan) return;
      if (a.type === "pon" && o.pon.some(v => sameSet(v, a.tiles))) return;
      if (a.type === "chi" && o.chi.some(v => sameSet(v, a.tiles))) return;
      throw new Error(`その鳴きはできません: ${a.type}`);
    }

    // ---------- 打牌 ----------
    _discard(seat, id, declare) {
      const r = this.r, hand = r.hands[seat];
      const tsumogiri = id === r.drawn;
      r.riichiDouble = r.noCalls && r.river[seat].length === 0;
      hand.splice(hand.indexOf(id), 1);
      hand.sort((a, b) => a - b);
      r.river[seat].push({ id, tsumogiri, riichi: declare, called: false });
      r.drawn = null; r.rinshan = false; r.afterCall = false; r.kuikae = [];
      r.furitenTemp[seat] = false;
      if (r.riichi[seat]) r.ippatsu[seat] = false;
      if (declare) r.riichiPending = seat;
      this._emit({ t: "discard", seat, id, tsumogiri, riichi: declare });
      this._flipPendingKanDora();
      r.last = { type: "discard", seat, id };

      const k = kindOf(id), pend = {};
      for (let d = 1; d <= 3; d++) {
        const s = (seat + d) % 4;
        const opt = { kind: "call", tile: id, from: seat, ron: false, pon: [], chi: [], kan: false };
        if (this._canRon(s, id, {})) opt.ron = true;
        if (r.liveLeft > 0 && !r.riichi[s]) {
          const same = r.hands[s].filter(t => kindOf(t) === k);
          if (same.length >= 2 && r.hands[s].length - 2 > same.length - 2) opt.pon = pickVariants(same, 2);
          if (same.length === 3 && r.kanCount < 4) opt.kan = true;
          if (d === 1 && k < 27) opt.chi = this._chiVariants(s, k);
        }
        if (opt.ron || opt.pon.length || opt.chi.length || opt.kan) pend[s] = opt;
      }
      if (Object.keys(pend).length) {
        this.pending = pend; this.responses = {}; this.phase = "call";
      } else if (this._discardPassed()) {
        this._draw((seat + 1) % 4, false);
      }
    }
    _chiVariants(seat, k) {
      const hand = this.r.hands[seat], n = k % 9, out = [];
      const shapes = [];
      if (n >= 2) shapes.push([k - 2, k - 1]);
      if (n >= 1 && n <= 7) shapes.push([k - 1, k + 1]);
      if (n <= 6) shapes.push([k + 1, k + 2]);
      for (const [a, b] of shapes) {
        const as = hand.filter(t => kindOf(t) === a), bs = hand.filter(t => kindOf(t) === b);
        if (!as.length || !bs.length) continue;
        const forbidden = kuikaeKinds("chi", k, [a, b]);
        for (const va of pickVariants(as, 1)) {
          for (const vb of pickVariants(bs, 1)) {
            const pair = [va[0], vb[0]];
            // 鳴いたあとに切れる牌が残ること
            if (hand.some(t => !pair.includes(t) && !forbidden.includes(kindOf(t)))) out.push(pair);
          }
        }
      }
      return out;
    }
    /** その牌で和了れたのに和了らなかった人をフリテンにする（役が無い・フリテン中で選べなかった人も含む）。 */
    _markMissed(from, k) {
      const r = this.r;
      for (let s = 0; s < 4; s++) {
        if (s === from) continue;
        if (this.waits(s).includes(k)) {
          if (r.riichi[s]) r.furitenRiichi[s] = true; else r.furitenTemp[s] = true;
        }
      }
    }
    /** 打牌がロンされずに通ったあとの処理。局が続くなら true。 */
    _discardPassed() {
      const r = this.r, { seat, id } = r.last;
      this._markMissed(seat, kindOf(id));
      if (r.riichiPending === seat) {
        r.riichiPending = -1;
        r.riichi[seat] = r.riichiDouble ? 2 : 1;
        r.ippatsu[seat] = true;
        this.scores[seat] -= 1000;
        this.kyotaku++;
        this._emit({ t: "riichi", seat });
        if (r.riichi.every(x => x > 0)) { this._abort("suucha"); return false; }
      }
      if (r.noCalls && r.river.every(v => v.length === 1)) {
        const k0 = kindOf(r.river[0][0].id);
        if (k0 >= 27 && k0 <= 30 && r.river.every(v => kindOf(v[0].id) === k0)) { this._abort("suufon"); return false; }
      }
      if (r.suukan) { this._abort("suukan"); return false; }
      return true;
    }
    _resolveCalls() {
      const r = this.r, last = r.last, from = last.seat;
      const order = [1, 2, 3].map(d => (from + d) % 4).filter(s => s in this.pending);
      const resp = this.responses;
      this.pending = {};
      const rons = order.filter(s => resp[s].type === "ron");
      if (rons.length) {
        return this._win(rons, { tsumo: false, tile: last.id, from, chankan: last.type === "kan" });
      }
      if (last.type === "kan") return this._afterKanDeclared();
      if (!this._discardPassed()) return;
      const big = order.find(s => resp[s].type === "pon" || resp[s].type === "kan");
      if (big !== undefined) {
        if (resp[big].type === "pon") return this._meldCall(big, "pon", resp[big].tiles);
        return this._meldCall(big, "minkan", r.hands[big].filter(t => kindOf(t) === kindOf(last.id)));
      }
      const chi = order.find(s => resp[s].type === "chi");
      if (chi !== undefined) return this._meldCall(chi, "chi", resp[chi].tiles);
      this._draw((from + 1) % 4, false);
    }

    // ---------- 鳴き ----------
    _meldCall(seat, type, own) {
      const r = this.r, { seat: from, id } = r.last, hand = r.hands[seat];
      for (const t of own) hand.splice(hand.indexOf(t), 1);
      const riverTile = r.river[from][r.river[from].length - 1];
      riverTile.called = true;
      r.melds[seat].push({ type, tiles: own.concat([id]).sort((a, b) => a - b), called: id, from });
      r.noCalls = false;
      r.ippatsu = [false, false, false, false];
      r.turn = seat; r.drawn = null;
      this._emit({ t: "call", seat, type, from });
      if (type !== "chi") this._checkPao(seat, from, kindOf(id));
      if (type === "minkan") {
        r.kanCount++; r.kanSeats.add(seat); r.pendingKanDora++;
        if (r.kanCount === 4 && r.kanSeats.size >= 2) r.suukan = true;
        return this._draw(seat, true);
      }
      r.afterCall = true;
      r.kuikae = kuikaeKinds(type, kindOf(id), own.map(kindOf));
      this._setTurn();
    }
    /** 大三元・大四喜を確定させる牌を鳴かせた人を覚える（包）。 */
    _checkPao(seat, from, k) {
      const r = this.r;
      const ks = r.melds[seat].filter(m => m.type !== "chi").map(m => kindOf(m.tiles[0]));
      if (k >= 31 && [31, 32, 33].every(d => ks.includes(d))) r.pao[seat].daisangen = from;
      if (k >= 27 && k <= 30 && [27, 28, 29, 30].every(d => ks.includes(d))) r.pao[seat].daisuushi = from;
    }
    _ankan(seat, k) {
      const r = this.r, hand = r.hands[seat];
      this._flipPendingKanDora();
      const ids = hand.filter(t => kindOf(t) === k);
      r.hands[seat] = hand.filter(t => kindOf(t) !== k);
      r.melds[seat].push({ type: "ankan", tiles: ids, called: null, from: null });
      r.noCalls = false; r.drawn = null;
      this._emit({ t: "call", seat, type: "ankan", from: seat });
      r.last = { type: "kan", seat, id: ids[0], ankan: true };
      this._offerChankan(seat, ids[0], true);
    }
    _kakan(seat, id) {
      const r = this.r, hand = r.hands[seat];
      this._flipPendingKanDora();
      const meld = r.melds[seat].find(m => m.type === "pon" && kindOf(m.tiles[0]) === kindOf(id));
      hand.splice(hand.indexOf(id), 1);
      meld.type = "kakan"; meld.tiles.push(id); meld.added = id;
      r.noCalls = false; r.drawn = null;
      this._emit({ t: "call", seat, type: "kakan", from: seat });
      r.last = { type: "kan", seat, id, ankan: false };
      this._offerChankan(seat, id, false);
    }
    _offerChankan(seat, id, kokushiOnly) {
      const pend = {};
      for (let d = 1; d <= 3; d++) {
        const s = (seat + d) % 4;
        if (this._canRon(s, id, { chankan: true, kokushiOnly })) {
          pend[s] = { kind: "call", tile: id, from: seat, ron: true, pon: [], chi: [], kan: false, chankan: true };
        }
      }
      if (Object.keys(pend).length) {
        this.pending = pend; this.responses = {}; this.phase = "call";
      } else this._afterKanDeclared();
    }
    _afterKanDeclared() {
      const r = this.r, { seat, id, ankan } = r.last;
      if (!ankan) this._markMissed(seat, kindOf(id));
      r.ippatsu = [false, false, false, false];
      r.kanCount++; r.kanSeats.add(seat);
      if (ankan) this._flipDora(); else r.pendingKanDora++;
      if (r.kanCount === 4 && r.kanSeats.size >= 2) r.suukan = true;
      this._draw(seat, true);
    }

    // ---------- 和了 ----------
    _win(winners, info) {
      const r = this.r, honba = this.honba, oya = this.oya;
      const deltas = [0, 0, 0, 0], wins = [];
      const before = this.scores.slice();
      winners.forEach((seat, i) => {
        const res = this._score(seat, info.tile, { tsumo: info.tsumo, chankan: info.chankan });
        const isOya = seat === oya, d = [0, 0, 0, 0];
        const hb = i === 0 ? honba : 0; // 本場と供託は、放銃者から数えて最初の和了者が取る
        const paoParts = [];
        if (res.yakuman) {
          const names = res.yaku.map(y => y[0]);
          if (names.includes("大三元") && r.pao[seat].daisangen !== undefined) paoParts.push([r.pao[seat].daisangen, 1]);
          if (names.includes("大四喜") && r.pao[seat].daisuushi !== undefined) paoParts.push([r.pao[seat].daisuushi, 2]);
        }
        const paoN = paoParts.reduce((s, p) => s + p[1], 0);
        const restBase = res.yakuman ? 8000 * (res.yakuman - paoN) : res.base;
        const move = (from, to, amt) => { d[from] -= amt; d[to] += amt; };
        if (info.tsumo) {
          if (restBase > 0) {
            const pay = MJ.payment(restBase, isOya, true);
            for (let o = 0; o < 4; o++) if (o !== seat) move(o, seat, isOya ? pay.each : o === oya ? pay.oya : pay.ko);
          }
          for (const [p, n] of paoParts) move(p, seat, MJ.payment(8000 * n, isOya, false).total);
          if (paoParts.length) move(paoParts[0][0], seat, 300 * hb);
          else for (let o = 0; o < 4; o++) if (o !== seat) move(o, seat, 100 * hb);
        } else {
          if (restBase > 0) move(info.from, seat, MJ.payment(restBase, isOya, false).total);
          for (const [p, n] of paoParts) {
            const amt = MJ.payment(8000 * n, isOya, false).total;
            move(p, seat, amt / 2); move(info.from, seat, amt / 2);
          }
          move(paoParts.length ? paoParts[0][0] : info.from, seat, 300 * hb);
        }
        if (i === 0) d[seat] += this.kyotaku * 1000;
        for (let o = 0; o < 4; o++) deltas[o] += d[o];
        wins.push({
          seat, from: info.tsumo ? null : info.from, tsumo: !!info.tsumo, tile: info.tile,
          hand: r.hands[seat].filter(t => !(info.tsumo && t === info.tile)),
          melds: r.melds[seat].map(copyMeld),
          riichi: r.riichi[seat] > 0, oya: isOya,
          yaku: res.yaku, han: res.han, fu: res.fu, yakuman: res.yakuman, base: res.base,
          gain: d[seat],
        });
      });
      r.riichiPending = -1;
      this.kyotaku = 0;
      for (let s = 0; s < 4; s++) this.scores[s] += deltas[s];
      const renchan = winners.includes(oya);
      this.result = {
        type: "win", wins, deltas, before, after: this.scores.slice(),
        doraInd: r.doraInd.slice(), uraInd: wins.some(w => w.riichi) ? r.uraInd.slice() : [],
      };
      this._endRound(renchan, renchan ? honba + 1 : 0, renchan);
    }

    // ---------- 流局 ----------
    _exhaustive() {
      const r = this.r, oya = this.oya;
      const tenpai = [0, 1, 2, 3].map(s => MJ.shanten(countsOf(r.hands[s]), r.melds[s].length) === 0);
      const nagashi = [0, 1, 2, 3].filter(s => r.river[s].length > 0 &&
        r.river[s].every(e => MJ.isYaochu(kindOf(e.id)) && !e.called));
      const deltas = [0, 0, 0, 0], before = this.scores.slice();
      if (nagashi.length) {
        for (const s of nagashi) {
          const pay = MJ.payment(2000, s === oya, true);
          for (let o = 0; o < 4; o++) {
            if (o === s) continue;
            const amt = s === oya ? pay.each : o === oya ? pay.oya : pay.ko;
            deltas[o] -= amt; deltas[s] += amt;
          }
        }
      } else {
        const n = tenpai.filter(Boolean).length;
        if (n > 0 && n < 4) {
          for (let s = 0; s < 4; s++) deltas[s] += tenpai[s] ? 3000 / n : -3000 / (4 - n);
        }
      }
      for (let s = 0; s < 4; s++) this.scores[s] += deltas[s];
      this.result = {
        type: "ryukyoku", reason: "exhaustive", tenpai, nagashi, deltas, before, after: this.scores.slice(),
        hands: [0, 1, 2, 3].map(s => (tenpai[s] ? r.hands[s].slice() : null)),
        melds: r.melds.map(ms => ms.map(copyMeld)),
      };
      this._endRound(tenpai[oya], this.honba + 1, tenpai[oya]);
    }
    /** 途中流局。reason: kyushu（九種九牌）・suufon（四風連打）・suukan（四槓散了）・suucha（四家立直） */
    _abort(reason, seat) {
      const r = this.r;
      this.result = {
        type: "ryukyoku", reason, seat: seat === undefined ? null : seat, deltas: [0, 0, 0, 0],
        before: this.scores.slice(), after: this.scores.slice(),
        tenpai: [false, false, false, false], nagashi: [],
        hands: [0, 1, 2, 3].map(s => (s === seat ? r.hands[s].slice() : null)),
        melds: r.melds.map(ms => ms.map(copyMeld)),
      };
      this._endRound(true, this.honba + 1, false);
    }
    /** renchan: 親が続くか。honba: 次の局の本場。stopOk: オーラスの和了止め・聴牌止めの対象になる終わり方か。 */
    _endRound(renchan, honba, stopOk) {
      this.next = { renchan, honba, stopOk };
      this.pending = {}; this.responses = {};
      this.phase = "roundEnd";
      this._emit({ t: "roundEnd" });
    }

    // ---------- 局の移り変わりと終局 ----------
    rankOrder() {
      return [0, 1, 2, 3].sort((a, b) =>
        this.scores[b] - this.scores[a] || ((a - this.chicha + 4) % 4) - ((b - this.chicha + 4) % 4));
    }
    nextRound() {
      if (this.phase !== "roundEnd") throw new Error("局が終わっていません");
      const { renchan, honba, stopOk } = this.next;
      const finalWind = this.length === "east" ? 0 : 1;
      const top = Math.max(...this.scores);
      const allLast = this.bakaze === finalWind && this.kyoku === 3;
      const extension = this.bakaze > finalWind;
      let end = this.scores.some(s => s < 0);
      if (!end) {
        if (extension && top >= GOAL_SCORE) end = true;
        else if (renchan) {
          if (allLast && stopOk && this.rankOrder()[0] === this.oya && this.scores[this.oya] >= GOAL_SCORE) end = true;
        } else if (allLast && top >= GOAL_SCORE) end = true;
        else if (extension && this.kyoku === 3) end = true;
      }
      if (end) return this._finish();
      this.honba = honba;
      if (!renchan) {
        this.kyoku++;
        if (this.kyoku === 4) { this.kyoku = 0; this.bakaze++; }
      }
      this.startRound();
    }
    _finish() {
      const order = this.rankOrder();
      this.scores[order[0]] += this.kyotaku * 1000;
      this.kyotaku = 0;
      this.final = {
        order, scores: this.scores.slice(),
        points: order.map((s, i) => Math.round(((this.scores[s] - START_SCORE) / 1000 + UMA[i]) * 10) / 10),
      };
      this.phase = "gameEnd";
      this.pending = {};
      this._emit({ t: "gameEnd" });
    }

    // ---------- 席ごとの見える情報 ----------
    /** seat の人に見える情報だけを取り出す（オンラインではこれを各自へ送る）。 */
    view(seat) {
      const r = this.r;
      const v = {
        seat, names: this.names, scores: this.scores.slice(), chicha: this.chicha, oya: this.oya,
        bakaze: this.bakaze, kyoku: this.kyoku, honba: this.honba, kyotaku: this.kyotaku,
        phase: this.phase, length: this.length,
        options: this.pending[seat] && !(seat in this.responses) ? this.pending[seat] : null,
        result: this.result, final: this.final,
      };
      if (!r) return v;
      // 待ちとフリテン: 自分の番でツモった直後は、ツモ牌を除いた13枚で見る（鳴いた直後は出さない）
      const handTurn = r.hands[seat].length % 3 === 2;
      const base = !handTurn ? r.hands[seat] : r.turn === seat && r.drawn !== null ? r.hands[seat].filter(t => t !== r.drawn) : null;
      const waits = base ? waitsOf(countsOf(base), r.melds[seat].length) : [];
      const furiten = !!base && (r.furitenTemp[seat] || r.furitenRiichi[seat] || r.river[seat].some(e => waits.includes(kindOf(e.id))));
      Object.assign(v, {
        liveLeft: r.liveLeft, doraInd: r.doraInd.slice(), turn: r.turn,
        hand: r.hands[seat].filter(t => t !== r.drawn || r.turn !== seat),
        drawn: r.turn === seat ? r.drawn : null,
        handCounts: r.hands.map(h => h.length),
        hasDrawn: r.drawn !== null,
        melds: r.melds.map(ms => ms.map(copyMeld)),
        rivers: r.river.map(v2 => v2.map(e => ({ id: e.id, tsumogiri: e.tsumogiri, riichi: e.riichi, called: e.called }))),
        riichi: r.riichi.slice(),
        riichiPending: r.riichiPending,
        last: r.last ? { type: r.last.type, seat: r.last.seat, id: r.last.id } : null,
        waits, furiten,
      });
      return v;
    }
  }

  return { Game, kindOf, isRed, countsOf, waitsOf, mulberry32, kuikaeKinds, START_SCORE, GOAL_SCORE };
});
