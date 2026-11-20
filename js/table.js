/*
 * table.js — 卓の進行役。対局（game.js）を1つ持ち、CPU の席を打たせ、人の席にはその席から見える情報を配って行動を受け取る。
 * 画面も通信も持たない（1人用と部屋主のブラウザ、node のテストで動く）。ブラウザでは window.Table、node では require。
 *
 * 使い方:
 *   t = new Table({ game: Game の opts, humans: [人が座る席], cpu: CPU の強さ（"weak" | "normal" | "strong"）, send(seat, packet), timing, onEnd, onError });
 *   t.start();
 *   t.submit(seat, { t: "act", ask, action })  人の行動（ask は packet.ask をそのまま返す。古い問いへの答えは捨てる）
 *   t.submit(seat, { t: "next" })              局の結果を見終えた
 *   t.setConnected(seat, bool)                 切断中の人の席は CPU が代わりに打つ。戻ったらいまの状態を送り直す
 *   t.resync(seat)                             その席へいまの状態を送り直す
 *   t.setRig(config) / t.stop()
 *
 * 人の席へ送る packet（JSON にできる値だけ。ほかの席の手・袋の中身は入れない）:
 *   view      game.view(seat)。その席が何もしなくても進むとき（立直後のツモ切り）は options を null にする
 *   events    前回この席へ送ったあとに起きたできごと（game.events。全員に見えるものだけ）
 *   ask       いまの問い（view.options）の番号
 *   round     何局目か（対局の最初から数える。結果を1回だけ見せるのに使う）
 *   needNext  局の結果を見終えた合図をまだ受け取っていない
 *   retry     入力をやり直させる（直前の行動を受け付けなかった・つなぎ直した）
 *   rigShown  「牌操作あり」の札を出すか
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./game.js"), require("./cpu.js"));
  else root.Table = factory(root.Mahjong, root.Cpu);
})(typeof self !== "undefined" ? self : this, function (Mahjong, Cpu) {
  "use strict";
  const { Game, mulberry32 } = Mahjong;

  // 待ち時間（ミリ秒）
  const TIMING = {
    announce: 1000, // 局の始まりを見せる
    cpuThink: 400, // CPU がツモってから切るまで
    afterDiscard: 200, // 打牌のあと、次の人が動くまで
    afterCall: 100, // CPU だけで鳴き・見送りが決まったあと
    autoDiscard: 600, // 立直後のツモ切り
  };

  /** 人から届いた行動を、選択肢 o にあるものだけで作り直す（届いた値をそのまま対局に入れない）。合わなければ null。 */
  function cleanAction(o, a) {
    if (!o || !a || typeof a !== "object") return null;
    const variant = list => Array.isArray(a.tiles) && list.find(v => v.length === a.tiles.length && v.every(t => a.tiles.includes(t)));
    if (o.kind === "turn") {
      switch (a.type) {
        case "tsumo": case "kyushu": return { type: a.type };
        case "ankan": return { type: "ankan", kind: a.kind };
        case "kakan": return { type: "kakan", id: a.id };
        case "discard": return a.riichi ? { type: "discard", id: a.id, riichi: true } : { type: "discard", id: a.id };
        default: return null;
      }
    }
    switch (a.type) {
      case "pass": case "ron": case "kan": return { type: a.type };
      case "pon": case "chi": {
        const v = variant(o[a.type]);
        return v ? { type: a.type, tiles: v } : null;
      }
      default: return null;
    }
  }

  class Table {
    constructor(opts) {
      this.g = new Game(opts.game);
      this.cpuLevel = Cpu.LEVELS.includes(opts.cpu) ? opts.cpu : "normal"; // CPU の強さ（全席まとめて）
      this.cpuRng = mulberry32((this.g.seed ^ 0x5bd1e995) >>> 0); // CPU が使う乱数（対局の乱数とは分ける。同じ seed なら同じ打ち方）
      this.send = opts.send;
      this.onEnd = opts.onEnd || null;
      this.onError = opts.onError || null;
      this.timing = Object.assign({}, TIMING, opts.timing);
      this.human = [false, false, false, false];
      for (const s of opts.humans || []) this.human[s] = true;
      this.connected = this.human.slice();
      this.evSent = [0, 0, 0, 0];
      this.ask = [0, 0, 0, 0];
      this.askObj = [null, null, null, null];
      this.round = 0;
      this.confirmed = new Set(); // 局の結果を見終えた席
      this.alive = false;
      this.token = 0;
      this.dirty = false; // 前に配ったあとで状態が変わった
      this.pause = false; // 打牌の直後
      this.thought = null; // 待ち時間を済ませた問い
      this.waker = null;
    }

    start() {
      this.alive = true;
      const my = ++this.token;
      this._loop(my).catch(err => {
        if (my !== this.token) return;
        this.alive = false;
        if (this.onError) this.onError(err); else throw err;
      });
    }
    stop() { this.alive = false; this.token++; this._wake(); }

    _isHuman(seat) { return this.human[seat] && this.connected[seat]; }
    /** 立直していて、ツモ和了も暗槓もできない番（何も選べないので、少し待ってツモ切りする）。 */
    _auto(seat, o) { return o.kind === "turn" && this.g.r.riichi[seat] > 0 && !o.tsumo && !o.ankan.length; }
    _cpuExtra() {
      const cfg = this.g.rig.config;
      return { noRonFrom: cfg.enabled ? [0, 1, 2, 3].filter(s => cfg.seats[s].guard) : [], level: this.cpuLevel, rng: this.cpuRng };
    }
    _pendingSeats() {
      const g = this.g;
      return Object.keys(g.pending).map(Number).filter(s => !(s in g.responses));
    }
    _sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
    _wait() { return new Promise(res => { this.waker = res; }); }
    _wake() {
      const w = this.waker;
      this.waker = null;
      if (w) w();
    }

    // ---------- 配る ----------
    _packet(seat, retry) {
      const g = this.g, view = g.view(seat), o = view.options;
      if (o) {
        if (o !== this.askObj[seat]) { this.askObj[seat] = o; this.ask[seat]++; }
        if (this._auto(seat, o)) view.options = null;
      }
      const events = g.events.slice(this.evSent[seat]);
      this.evSent[seat] = g.events.length;
      return {
        view, events, ask: this.ask[seat], round: this.round,
        needNext: g.phase === "roundEnd" && !this.confirmed.has(seat),
        retry: !!retry,
        rigShown: !!(g.rig.config.showToAll && g.rig.active),
      };
    }
    _sendTo(seat, retry) {
      if (this._isHuman(seat)) this.send(seat, this._packet(seat, retry));
    }
    _push() {
      if (!this.dirty) return;
      this.dirty = false;
      for (let s = 0; s < 4; s++) this._sendTo(s);
    }

    // ---------- 人の席からの入力 ----------
    submit(seat, msg) {
      if (!this.alive || !this._isHuman(seat) || !msg || typeof msg !== "object") return;
      const g = this.g;
      if (msg.t === "next") {
        if (g.phase === "roundEnd") { this.confirmed.add(seat); this._wake(); }
        return;
      }
      if (msg.t !== "act") return;
      const o = g.pending[seat];
      if (!o || seat in g.responses || o !== this.askObj[seat] || msg.ask !== this.ask[seat] || this._auto(seat, o)) return; // 古い問いへの答え
      const action = cleanAction(o, msg.action);
      try {
        if (!action) throw new Error("行動の形が合いません");
        g.act(seat, action);
      } catch (e) {
        return this._sendTo(seat, true);
      }
      if (action.type === "discard") this.pause = true;
      this.dirty = true;
      this._wake();
    }
    setConnected(seat, on) {
      if (!this.human[seat] || this.connected[seat] === !!on) return;
      this.connected[seat] = !!on;
      if (on) this.resync(seat);
      this._wake();
    }
    /** その席へ、いまの状態を送り直す（つなぎ直した人向け。いない間のできごとは飛ばし、入力はやり直させる）。 */
    resync(seat) {
      if (!this._isHuman(seat) || !this.g.r) return;
      this.evSent[seat] = this.g.events.length;
      this._sendTo(seat, true);
    }
    setRig(config) {
      this.g.rig.setConfig(config);
      this.dirty = true;
      if (this.alive) this._push();
    }

    // ---------- 進行 ----------
    _startRound(first) {
      const g = this.g;
      if (first) g.startRound(); else g.nextRound();
      this.confirmed.clear();
      this.dirty = true;
      if (g.phase !== "gameEnd") this.round++;
    }
    async _loop(my) {
      const g = this.g, T = this.timing;
      this._startRound(true);
      this._push();
      await this._sleep(T.announce);
      // 待ったあとは必ず最初から状態を見直す（待つ間に、人の行動・切断・復帰で状態が変わる）
      while (my === this.token) {
        this._push();
        if (g.phase === "gameEnd") {
          this.alive = false;
          if (this.onEnd) this.onEnd();
          return;
        }
        if (g.phase === "roundEnd") {
          if (![0, 1, 2, 3].every(s => !this._isHuman(s) || this.confirmed.has(s))) { await this._wait(); continue; }
          this._startRound(false);
          if (g.phase !== "gameEnd") { this._push(); await this._sleep(T.announce); }
          continue;
        }
        const seats = this._pendingSeats();
        if (this.pause) {
          this.pause = false;
          if (!(g.phase === "call" && seats.some(s => this._isHuman(s)))) { await this._sleep(T.afterDiscard); continue; }
        }
        if (g.phase === "call") {
          const pend = g.pending, extra = this._cpuExtra();
          const cpus = seats.filter(s => !this._isHuman(s));
          for (const s of cpus) g.act(s, Cpu.decide(g.view(s), pend[s], extra));
          if (cpus.length === seats.length) { this.dirty = true; await this._sleep(T.afterCall); }
          else await this._wait();
          continue;
        }
        const s = seats[0], o = g.pending[s];
        const human = this._isHuman(s);
        if (human && !this._auto(s, o)) { await this._wait(); continue; }
        if (this.thought !== o) {
          this.thought = o;
          await this._sleep(human ? T.autoDiscard : T.cpuThink);
          continue;
        }
        const a = human ? { type: "discard", id: o.discards[0] } : Cpu.decide(g.view(s), o, this._cpuExtra());
        g.act(s, a);
        this.dirty = true;
        if (a.type === "discard") this.pause = true;
      }
    }
  }

  Table.TIMING = TIMING;
  Table.cleanAction = cleanAction;
  return Table;
});
