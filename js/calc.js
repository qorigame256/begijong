/*
 * calc.js — 麻雀の計算: 牌の番号・シャンテン数・和了の形・役・符・点数（雀魂の段位戦ルール）。
 * 出どころ: ../麻雀分析/tools/mj_engine.js（このプロジェクトの隣のフォルダ）の先頭〜pointsText を写したもの（2026-11-17）。
 * 写したあとに足したもの: scoreHand の ctx.tenhou / ctx.chiihou（天和・地和）。
 * 牌の番号（kind）: 萬子 0〜8・筒子 9〜17・索子 18〜26・字牌 27〜33（東南西北白發中）。
 * ブラウザでは window.MJ、node では require で使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MJ = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 牌 ----------
  const HONORS = ["E", "S", "W", "N", "P", "F", "C"];
  const HONOR_NAMES = ["東", "南", "西", "北", "白", "發", "中"];
  const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  const FIVES = [4, 13, 22]; // 5m・5p・5s の番号（赤5の色 s に対して FIVES[s]）

  function tileIndex(p) {
    const h = HONORS.indexOf(p);
    if (h >= 0) return 27 + h;
    return "mps".indexOf(p[1]) * 9 + Number(p[0]) - 1;
  }
  function isRed(p) { return p.length === 3 && p[2] === "r"; }
  function redSuit(p) { return "mps".indexOf(p[1]); }
  function tileString(i, red) { return i >= 27 ? HONORS[i - 27] : `${i % 9 + 1}${"mps"[(i / 9) | 0]}${red ? "r" : ""}`; }
  function tileLabel(p) {
    const h = HONORS.indexOf(p);
    if (h >= 0) return HONOR_NAMES[h];
    return (isRed(p) ? "赤" : "") + p.slice(0, 2);
  }
  function indexLabel(i) { return i >= 27 ? HONOR_NAMES[i - 27] : `${i % 9 + 1}${"mps"[(i / 9) | 0]}`; }
  /** ドラ表示牌の番号から、ドラの番号を出す（数牌は 9 の次が 1、風牌は 東南西北、三元牌は 白發中 の順に回る）。 */
  function doraOf(i) {
    if (i < 27) return i - i % 9 + (i % 9 + 1) % 9;
    if (i < 31) return 27 + (i - 27 + 1) % 4;
    return 31 + (i - 31 + 1) % 3;
  }
  function isYaochu(i) { return i >= 27 || i % 9 === 0 || i % 9 === 8; }
  function counts34(tiles) {
    const c = new Array(34).fill(0);
    for (const t of tiles) c[tileIndex(t)]++;
    return c;
  }
  function akaCounts(tiles) {
    const a = [0, 0, 0];
    for (const t of tiles) if (isRed(t)) a[redSuit(t)]++;
    return a;
  }
  /** '123m456p789s東東' の形を牌の文字列のリストにする（0 は赤5）。テストと確かめ用。 */
  function parseHand(text) {
    const out = [];
    let digits = [];
    for (const ch of text.replace(/\s/g, "")) {
      if (/[0-9]/.test(ch)) digits.push(ch);
      else if ("mps".includes(ch)) {
        for (const d of digits) out.push(d === "0" ? `5${ch}r` : `${d}${ch}`);
        digits = [];
      } else {
        const h = HONOR_NAMES.indexOf(ch);
        if (h < 0) throw new Error(`読めない文字があります: ${ch}`);
        out.push(HONORS[h]);
      }
    }
    if (digits.length) throw new Error("数字の後ろに m・p・s のどれかが必要です");
    return out;
  }

  // ---------- シャンテン数 ----------
  // 「和了の形まであと何枚引けばよいか（不要な牌は捨ててよい）」を数え、そこから 1 を引いたものをシャンテン数とする。
  // 色ごとに「m 面子と h 雀頭（0か1）を作るのに足りない枚数」の表を作り（同じ牌は4枚まで）、4つの表を組み合わせる。
  // 表は色ごとの枚数の並びをキーにして覚えておく（同じ並びは2回計算しない）。
  const INF = 99;
  const POW5 = [1, 5, 25, 125, 625, 3125, 15625, 78125, 390625, 1953125];
  const numberMemo = new Array(1953125).fill(null); // 数牌1色の表（萬子・筒子・索子で共通。添字は並びを5進数にした数、5^9 通り）
  const honorMemo = new Array(78125).fill(null); // 字牌の表（5^7 通り）

  /** c[base]〜c[base+n-1] の並びを5進数の数にする（1の位が一番小さい牌）。 */
  function suitCode(c, base, n) {
    let k = 0;
    for (let r = n - 1; r >= 0; r--) k = k * 5 + c[base + r];
    return k;
  }
  function decode(code, n) {
    const c = new Array(n);
    for (let r = 0; r < n; r++) { c[r] = code % 5; code = (code - c[r]) / 5; }
    return c;
  }

  function computeSuitTable(c) {
    // 状態 = (作った面子の数 m, 雀頭 h, 1つ前から始めた順子の数 a, 2つ前から始めた順子の数 b)
    let dp = new Uint8Array(250).fill(INF);
    let nd = new Uint8Array(250);
    dp[0] = 0;
    for (let r = 0; r < 9; r++) {
      nd.fill(INF);
      const have = c[r];
      for (let st = 0; st < 250; st++) {
        const cost = dp[st];
        if (cost >= INF) continue;
        const b = st % 5, a = ((st / 5) | 0) % 5, mh = (st / 25) | 0, h = mh & 1, m = mh >> 1;
        const used = a + b;
        const maxX = r <= 6 ? Math.min(4 - m, 4 - used) : 0;
        for (let x = 0; x <= maxX; x++) {
          for (let y = 0; y <= 1 && m + x + y <= 4; y++) {
            for (let z = 0; z <= 1 - h; z++) {
              const need = used + x + 3 * y + 2 * z;
              if (need > 4) break;
              const nc = cost + (need > have ? need - have : 0);
              const ns = ((((m + x + y) << 1) | (h + z)) * 5 + x) * 5 + a;
              if (nc < nd[ns]) nd[ns] = nc;
            }
          }
        }
      }
      const t = dp; dp = nd; nd = t;
    }
    const D = new Uint8Array(10);
    for (let m = 0; m <= 4; m++) for (let h = 0; h <= 1; h++) D[m + 5 * h] = dp[((m << 1) | h) * 25];
    return D;
  }

  function computeHonorTable(c) {
    let dp = new Uint8Array(10).fill(INF);
    dp[0] = 0;
    for (let r = 0; r < 7; r++) {
      const have = c[r];
      const nd = new Uint8Array(10).fill(INF);
      for (let m = 0; m <= 4; m++) {
        for (let h = 0; h <= 1; h++) {
          const cost = dp[m + 5 * h];
          if (cost >= INF) continue;
          if (cost < nd[m + 5 * h]) nd[m + 5 * h] = cost;
          if (!h) { const v = cost + Math.max(0, 2 - have); if (v < nd[m + 5]) nd[m + 5] = v; }
          if (m < 4) { const v = cost + Math.max(0, 3 - have), k = m + 1 + 5 * h; if (v < nd[k]) nd[k] = v; }
        }
      }
      dp = nd;
    }
    return dp;
  }

  /** 色 X（0〜2 は数牌、3 は字牌）の並び code について、「m 面子と h 雀頭を作るのに足りない枚数」の表（添字 m + 5h）。 */
  // 期待値の計算では1回に数千万回引くので、Map ではなく並びの数を添字にした配列に置く（数牌は約195万要素・16MB ほど。読み込んだときに作る）
  function tableOf(X, code) {
    const memo = X === 3 ? honorMemo : numberMemo;
    let D = memo[code];
    if (D === null) {
      D = X === 3 ? computeHonorTable(decode(code, 7)) : computeSuitTable(decode(code, 9));
      memo[code] = D;
    }
    return D;
  }

  const tmpAB = new Uint8Array(10), tmpCD = new Uint8Array(10);
  function combine(A, B, out) {
    out.fill(INF);
    for (let m1 = 0; m1 <= 4; m1++) {
      for (let h1 = 0; h1 <= 1; h1++) {
        const a = A[m1 + 5 * h1];
        if (a >= INF) continue;
        for (let m2 = 0; m1 + m2 <= 4; m2++) {
          for (let h2 = 0; h1 + h2 <= 1; h2++) {
            const v = a + B[m2 + 5 * h2], k = m1 + m2 + 5 * (h1 + h2);
            if (v < out[k]) out[k] = v;
          }
        }
      }
    }
    return out;
  }
  /** 2つの表（合わせて4色ぶん）から、need 面子 + 1 雀頭までのシャンテン数を出す。 */
  function finalShanten(A, B, need) {
    let best = INF;
    for (let m = 0; m <= need; m++) {
      for (let h = 0; h <= 1; h++) {
        const v = A[m + 5 * h] + B[need - m + 5 * (1 - h)];
        if (v < best) best = v;
      }
    }
    return best - 1;
  }

  /** 4面子1雀頭の形のシャンテン数。c は手の中（副露を除く）の枚数、melds は副露（暗槓を含む）の数。 */
  function regularShanten(c, melds) {
    const AB = combine(tableOf(0, suitCode(c, 0, 9)), tableOf(1, suitCode(c, 9, 9)), tmpAB);
    const CD = combine(tableOf(2, suitCode(c, 18, 9)), tableOf(3, suitCode(c, 27, 7)), tmpCD);
    return finalShanten(AB, CD, 4 - melds);
  }

  function chiitoiShanten(c) {
    let pairs = 0, kinds = 0;
    for (let i = 0; i < 34; i++) { if (c[i] >= 1) kinds++; if (c[i] >= 2) pairs++; }
    return 6 - pairs + Math.max(0, 7 - kinds);
  }
  function kokushiShanten(c) {
    let kinds = 0, pair = 0;
    for (const i of YAOCHU) { if (c[i]) kinds++; if (c[i] >= 2) pair = 1; }
    return 13 - kinds - pair;
  }
  /** シャンテン数（-1 は和了形、0 は聴牌）。七対子・国士無双は副露が無いときだけ考える。13枚でも14枚でも使える。 */
  function shanten(c, melds) {
    let s = regularShanten(c, melds);
    if (melds === 0) s = Math.min(s, chiitoiShanten(c), kokushiShanten(c));
    return s;
  }

  // ---------- 和了の形と点数 ----------
  /** 手の中の牌を (雀頭, 面子) に分ける方法をすべて返す。面子は {type: 'seq'|'tri', tile}（順子の tile は一番小さい牌）。 */
  function decompositions(c, needSets) {
    const out = [];
    const sets = [];
    function walk(i, pair) {
      while (i < 34 && c[i] === 0) i++;
      if (i === 34) { if (sets.length === needSets) out.push({ pair, sets: sets.slice() }); return; }
      if (sets.length >= needSets) return;
      if (c[i] >= 3) {
        c[i] -= 3; sets.push({ type: "tri", tile: i });
        walk(i, pair);
        sets.pop(); c[i] += 3;
      }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--; sets.push({ type: "seq", tile: i });
        walk(i, pair);
        sets.pop(); c[i]++; c[i + 1]++; c[i + 2]++;
      }
    }
    for (let p = 0; p < 34; p++) {
      if (c[p] < 2) continue;
      c[p] -= 2;
      walk(0, p);
      c[p] += 2;
    }
    return out;
  }

  /** 和了牌が、分け方 dec のどの面子（または雀頭）を完成させたと読めるか。待ちの形も返す。 */
  function waitReadings(dec, win) {
    const out = [];
    if (dec.pair === win) out.push({ kind: "pair", index: -1, wait: "tanki" });
    dec.sets.forEach((s, i) => {
      if (s.type === "tri") {
        if (s.tile === win) out.push({ kind: "set", index: i, wait: "shanpon" });
      } else if (win >= s.tile && win <= s.tile + 2) {
        let wait;
        if (win === s.tile + 1) wait = "kanchan";
        else if (win === s.tile) wait = s.tile % 9 === 6 ? "penchan" : "ryanmen";
        else wait = s.tile % 9 === 0 ? "penchan" : "ryanmen";
        out.push({ kind: "set", index: i, wait });
      }
    });
    return out;
  }

  const isWind = t => t >= 27 && t <= 30;
  const isDragon = t => t >= 31;
  function allOf(allC, pred) { for (let i = 0; i < 34; i++) if (allC[i] && !pred(i)) return false; return true; }
  const GREEN = new Set([19, 20, 21, 23, 25, 32]); // 2s 3s 4s 6s 8s 發

  /** 一色かどうか: 'chinitsu'（数牌1色のみ）・'honitsu'（数牌1色＋字牌）・null */
  function flushKind(allC) {
    const suits = new Set();
    let honors = false;
    for (let i = 0; i < 34; i++) {
      if (!allC[i]) continue;
      if (i >= 27) honors = true; else suits.add((i / 9) | 0);
    }
    if (suits.size !== 1) return null;
    return honors ? "honitsu" : "chinitsu";
  }

  function shapeYakuman(allC) {
    const y = [];
    if (allOf(allC, i => i >= 27)) y.push(["字一色", 1]);
    if (allOf(allC, i => GREEN.has(i))) y.push(["緑一色", 1]);
    if (allOf(allC, i => i < 27 && (i % 9 === 0 || i % 9 === 8))) y.push(["清老頭", 1]);
    return y;
  }

  /**
   * 和了形の読み方（面子の分け方 × 和了牌の使い方）ごとに、形で決まる役（門前ツモ・平和などを含む）と符を返す。
   * ドラ・赤ドラ・裏ドラと、立直・一発・海底などの状況役は含めない（finishScore で足す）。和了形でなければ空のリスト。
   * c: 手の中の牌（和了牌を含む）の枚数、melds: [{type: 'chi'|'pon'|'minkan'|'ankan', tile}]、win: 和了牌の番号。
   */
  function shapeReadings(c, melds, win, tsumo, bakaze, jikaze) {
    const out = [];
    const menzen = melds.every(m => m.type === "ankan");
    const allC = c.slice();
    for (const m of melds) {
      if (m.type === "chi") { allC[m.tile]++; allC[m.tile + 1]++; allC[m.tile + 2]++; } else allC[m.tile] += m.type === "pon" ? 3 : 4;
    }
    const yakuhaiTile = t => isDragon(t) || t === bakaze || t === jikaze;

    if (melds.length === 0 && kokushiShanten(c) === -1) {
      const thirteen = c[win] === 2;
      out.push({ yakuman: thirteen ? 2 : 1, yaku: [[thirteen ? "国士無双十三面" : "国士無双", thirteen ? 26 : 13]], han: 0, fu: 0 });
      return out;
    }
    if (melds.length === 0) {
      // 九蓮宝燈（1112345678999 ＋1枚、同じ色だけ）。純正は和了前の13枚が 1112345678999 の形
      const fk = flushKind(allC);
      if (fk === "chinitsu") {
        const base = ((c.findIndex(n => n > 0)) / 9 | 0) * 9;
        const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
        if (need.every((n, r) => c[base + r] >= n)) {
          const before = c.slice(); before[win]--;
          const pure = need.every((n, r) => before[base + r] === n);
          out.push({ yakuman: pure ? 2 : 1, yaku: [[pure ? "純正九蓮宝燈" : "九蓮宝燈", pure ? 26 : 13]], han: 0, fu: 0 });
        }
      }
    }
    if (melds.length === 0 && chiitoiShanten(c) === -1) {
      const ym = shapeYakuman(allC);
      if (ym.length) out.push({ yakuman: ym.reduce((s, y) => s + y[1], 0), yaku: ym.map(y => [y[0], 13 * y[1]]), han: 0, fu: 0 });
      else {
        const yaku = [["七対子", 2]];
        if (tsumo) yaku.push(["門前清自摸和", 1]);
        if (allOf(allC, i => !isYaochu(i))) yaku.push(["断幺九", 1]);
        if (allOf(allC, isYaochu)) yaku.push(["混老頭", 2]);
        const fk = flushKind(allC);
        if (fk === "honitsu") yaku.push(["混一色", 3]);
        if (fk === "chinitsu") yaku.push(["清一色", 6]);
        out.push({ yakuman: 0, yaku, han: yaku.reduce((s, y) => s + y[1], 0), fu: 25 });
      }
    }

    const cc = c.slice();
    for (const dec of decompositions(cc, 4 - melds.length)) {
      for (const w of waitReadings(dec, win)) {
        const sets = dec.sets.map((s, i) => ({
          type: s.type, tile: s.tile,
          concealed: !(s.type === "tri" && !tsumo && w.kind === "set" && w.index === i),
        }));
        for (const m of melds) {
          if (m.type === "chi") sets.push({ type: "seq", tile: m.tile, concealed: false });
          else if (m.type === "pon") sets.push({ type: "tri", tile: m.tile, concealed: false });
          else sets.push({ type: "kan", tile: m.tile, concealed: m.type === "ankan" });
        }
        const pair = dec.pair;
        const trips = sets.filter(s => s.type !== "seq");
        const seqs = sets.filter(s => s.type === "seq");
        const kans = sets.filter(s => s.type === "kan").length;
        const ankou = trips.filter(s => s.concealed).length;
        const dragons = trips.filter(s => isDragon(s.tile)).length;
        const winds = trips.filter(s => isWind(s.tile)).length;

        const ym = [];
        if (ankou === 4) ym.push(w.kind === "pair" ? ["四暗刻単騎", 2] : ["四暗刻", 1]);
        if (dragons === 3) ym.push(["大三元", 1]);
        if (winds === 4) ym.push(["大四喜", 2]);
        else if (winds === 3 && isWind(pair)) ym.push(["小四喜", 1]);
        if (kans === 4) ym.push(["四槓子", 1]);
        ym.push(...shapeYakuman(allC));
        if (ym.length) {
          out.push({ yakuman: ym.reduce((s, y) => s + y[1], 0), yaku: ym.map(y => [y[0], 13 * y[1]]), han: 0, fu: 0 });
          continue;
        }

        const yaku = [];
        if (menzen && tsumo) yaku.push(["門前清自摸和", 1]);
        const pinfu = menzen && seqs.length === 4 && !yakuhaiTile(pair) && w.wait === "ryanmen";
        if (pinfu) yaku.push(["平和", 1]);
        if (allOf(allC, i => !isYaochu(i))) yaku.push(["断幺九", 1]);
        if (menzen) {
          const seen = new Map();
          for (const s of seqs) seen.set(s.tile, (seen.get(s.tile) || 0) + 1);
          let peiko = 0;
          for (const n of seen.values()) peiko += n >> 1;
          if (peiko >= 2) yaku.push(["二盃口", 3]);
          else if (peiko === 1) yaku.push(["一盃口", 1]);
        }
        for (const s of trips) {
          if (s.tile === 31) yaku.push(["役牌 白", 1]);
          if (s.tile === 32) yaku.push(["役牌 發", 1]);
          if (s.tile === 33) yaku.push(["役牌 中", 1]);
          if (s.tile === bakaze) yaku.push(["役牌:場風牌", 1]);
          if (s.tile === jikaze) yaku.push(["役牌:自風牌", 1]);
        }
        const hasSeq = t => seqs.some(s => s.tile === t);
        for (let r = 0; r < 7; r++) {
          if (hasSeq(r) && hasSeq(r + 9) && hasSeq(r + 18)) { yaku.push(["三色同順", menzen ? 2 : 1]); break; }
        }
        for (let b = 0; b < 27; b += 9) {
          if (hasSeq(b) && hasSeq(b + 3) && hasSeq(b + 6)) { yaku.push(["一気通貫", menzen ? 2 : 1]); break; }
        }
        const setHasYaochu = s => (s.type === "seq" ? s.tile % 9 === 0 || s.tile % 9 === 6 : isYaochu(s.tile));
        if (seqs.length && sets.every(setHasYaochu) && isYaochu(pair)) {
          const honor = pair >= 27 || trips.some(s => s.tile >= 27);
          yaku.push(honor ? ["混全帯幺九", menzen ? 2 : 1] : ["純全帯幺九", menzen ? 3 : 2]);
        }
        if (trips.length === 4) yaku.push(["対々和", 2]);
        if (ankou === 3) yaku.push(["三暗刻", 2]);
        for (let r = 0; r < 9; r++) {
          if ([0, 9, 18].every(b => trips.some(s => s.tile === b + r))) { yaku.push(["三色同刻", 2]); break; }
        }
        if (kans === 3) yaku.push(["三槓子", 2]);
        if (allOf(allC, isYaochu)) yaku.push(["混老頭", 2]);
        if (dragons === 2 && isDragon(pair)) yaku.push(["小三元", 2]);
        const fk = flushKind(allC);
        if (fk === "honitsu") yaku.push(["混一色", menzen ? 3 : 2]);
        if (fk === "chinitsu") yaku.push(["清一色", menzen ? 6 : 5]);

        let fu;
        if (pinfu) fu = tsumo ? 20 : 30;
        else {
          let f = 20;
          if (menzen && !tsumo) f += 10;
          if (tsumo) f += 2;
          for (const s of trips) {
            let v = isYaochu(s.tile) ? 4 : 2;
            if (s.concealed) v *= 2;
            if (s.type === "kan") v *= 4;
            f += v;
          }
          if (isDragon(pair)) f += 2;
          if (pair === bakaze) f += 2;
          if (pair === jikaze) f += 2; // 連風牌の雀頭は 2 + 2 = 4符（雀魂）
          if (w.wait === "kanchan" || w.wait === "penchan" || w.wait === "tanki") f += 2;
          fu = Math.max(30, Math.ceil(f / 10) * 10); // 副露した平和の形（20符・22符）は 30符
        }
        out.push({ yakuman: 0, yaku, han: yaku.reduce((s, y) => s + y[1], 0), fu });
      }
    }
    return out;
  }

  /** 基本点（符 × 2^(翻+2)、満貫以上は決まった値）。 */
  function basePoints(han, fu, yakuman) {
    if (yakuman) return 8000 * yakuman;
    if (han >= 13) return 8000; // 数え役満
    if (han >= 11) return 6000;
    if (han >= 8) return 4000;
    if (han >= 6) return 3000;
    if (han >= 5) return 2000;
    return Math.min(2000, fu * Math.pow(2, han + 2)); // 切り上げ満貫なし
  }
  const up100 = x => Math.ceil(x / 100) * 100;
  /** 支払い（本場・供託は含めない）。total は和了者が受け取る合計。 */
  function payment(base, oya, tsumo) {
    if (tsumo) {
      if (oya) { const each = up100(base * 2); return { total: each * 3, each }; }
      const ko = up100(base), fromOya = up100(base * 2);
      return { total: ko * 2 + fromOya, ko, oya: fromOya };
    }
    return { total: up100(base * (oya ? 6 : 4)) };
  }

  /**
   * 和了の点数。hand = {c: 手の中の枚数（和了牌を含む）, aka: 赤5の枚数（副露を含む）, melds, win}、
   * ctx = {tsumo, oya, bakaze, jikaze, riichi: 0|1|2（2はダブル立直）, ippatsu, haitei, houtei, rinshan, chankan,
   *        dora: [ドラ表示牌の番号], ura: [裏ドラ表示牌の番号] または null}。
   * 和了形でない・役が無いときは null。いちばん点数が高い読み方を返す。
   */
  function scoreHand(hand, ctx) {
    const readings = shapeReadings(hand.c, hand.melds, hand.win, ctx.tsumo, ctx.bakaze, ctx.jikaze);
    if (!readings.length) return null;
    const allC = hand.c.slice();
    for (const m of hand.melds) {
      if (m.type === "chi") { allC[m.tile]++; allC[m.tile + 1]++; allC[m.tile + 2]++; } else allC[m.tile] += m.type === "pon" ? 3 : 4;
    }
    const situational = [];
    if (ctx.riichi === 2) situational.push(["ダブル立直", 2]);
    else if (ctx.riichi) situational.push(["立直", 1]);
    if (ctx.riichi && ctx.ippatsu) situational.push(["一発", 1]);
    if (ctx.tsumo && ctx.haitei && !ctx.rinshan) situational.push(["海底摸月", 1]);
    if (!ctx.tsumo && ctx.houtei) situational.push(["河底撈魚", 1]);
    if (ctx.rinshan) situational.push(["嶺上開花", 1]);
    if (ctx.chankan) situational.push(["槍槓", 1]);
    const countDora = inds => (inds || []).reduce((s, ind) => s + allC[doraOf(ind)], 0);
    const dora = countDora(ctx.dora), aka = hand.aka || 0;
    // 裏ドラは表示牌（ctx.ura）から数える。期待値の計算では乗った枚数（ctx.uraCount）を直接渡す
    const uraKnown = ctx.riichi && (ctx.ura || ctx.uraCount !== undefined);
    const ura = !ctx.riichi ? 0 : ctx.uraCount !== undefined ? ctx.uraCount : ctx.ura ? countDora(ctx.ura) : 0;

    let best = null;
    for (const r of readings) {
      let res;
      const first = ctx.tenhou ? "天和" : ctx.chiihou ? "地和" : null;
      if (r.yakuman || first) {
        const yaku = (first ? [[first, 13]] : []).concat(r.yakuman ? r.yaku : []);
        res = { yakuman: r.yakuman + (first ? 1 : 0), han: 0, fu: 0, yaku };
      } else {
        const yaku = r.yaku.concat(situational);
        const yakuHan = yaku.reduce((s, y) => s + y[1], 0);
        if (yakuHan === 0) continue; // 役なし（ドラだけでは和了れない）
        if (dora) yaku.push(["ドラ", dora]);
        if (aka) yaku.push(["赤ドラ", aka]);
        if (uraKnown) yaku.push(["裏ドラ", ura]);
        res = { yakuman: 0, han: yakuHan + dora + aka + ura, fu: r.fu, yaku };
      }
      res.base = basePoints(res.han, res.fu, res.yakuman);
      res.pay = payment(res.base, ctx.oya, ctx.tsumo);
      res.points = res.pay.total;
      if (!best || res.points > best.points || (res.points === best.points && res.han > best.han)) best = res;
    }
    return best;
  }

  /** 天鳳の牌譜と同じ書き方の点数（例: '30符3飜1000-2000点'・'満貫8000点'・'30符2飜1000点∀'）。照合のテスト用。 */
  function pointsText(res, oya, tsumo) {
    let head;
    if (res.yakuman || res.han >= 13) head = "役満";
    else if (res.base >= 6000) head = "三倍満";
    else if (res.base >= 4000) head = "倍満";
    else if (res.base >= 3000) head = "跳満";
    else if (res.base >= 2000) head = "満貫";
    else head = `${res.fu}符${res.han}飜`;
    if (!tsumo) return `${head}${res.pay.total}点`;
    if (oya) return `${head}${res.pay.each}点∀`;
    return `${head}${res.pay.ko}-${res.pay.oya}点`;
  }

  return {
    HONORS, HONOR_NAMES, FIVES,
    tileIndex, isRed, redSuit, tileString, tileLabel, indexLabel, doraOf, isYaochu, counts34, akaCounts, parseHand,
    shanten, regularShanten, chiitoiShanten, kokushiShanten,
    decompositions, shapeReadings, scoreHand, basePoints, payment, pointsText,
  };
});
