/*
 * mj_engine.js — 麻雀の計算: 牌の表記・シャンテン数・和了の点数・牌譜（mjai 形式）の再生・一人麻雀モデルの期待値。
 * 何切るシミュレーター.html に埋め込んでブラウザで使う（window.MJ）。node ではテスト（tools/test_engine.js）から require する。
 * 牌の番号: 萬子 0〜8・筒子 9〜17・索子 18〜26・字牌 27〜33（東南西北白發中）。赤5は番号では普通の5と同じに数え、別に枚数を持つ。
 * 牌の文字列は mjai 形式（'1m'〜'9s'、赤5は '5mr'、字牌は E S W N P F C）。
 * 点数のルールは雀魂の段位戦（CLAUDE.md「雀魂の点数ルール」）。
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
        // '1東23m' を '東123m' と読まない（数字は、次の m・p・s までに字牌をはさめない）
        if (digits.length) throw new Error("数字の後ろに m・p・s のどれかが必要です");
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
   *        firstTurn（鳴きの無い最初のツモ。天和・地和）,
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

    // 天和（親）・地和（子）: 鳴きの無い最初のツモでの和了。ほかの役満とは複合する
    const first = ctx.tsumo && ctx.firstTurn ? [[ctx.oya ? "天和" : "地和", 13]] : null;
    let best = null;
    for (const r of readings) {
      let res;
      if (r.yakuman || first) {
        res = { yakuman: (r.yakuman || 0) + (first ? 1 : 0), han: 0, fu: 0, yaku: (r.yakuman ? r.yaku : []).concat(first || []) };
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

  // ---------- 牌譜の再生（mjai 形式の1局） ----------
  function removeTile(hand, pai) {
    const i = hand.indexOf(pai);
    if (i < 0) throw new Error(`手牌に ${pai} がありません: ${hand.join(" ")}`);
    hand.splice(i, 1);
  }

  /** 副露（mjai 形式で保持しているもの）を点数計算の形 {type, tile, aka, tiles} にする。 */
  function engineMeld(m) {
    const tiles = m.type === "ankan" ? m.consumed.slice()
      : m.type === "kakan" ? m.consumed.concat([m.pai, m.added]) : m.consumed.concat([m.pai]);
    const idx = tiles.map(tileIndex);
    const type = m.type === "chi" ? "chi" : m.type === "pon" ? "pon" : m.type === "ankan" ? "ankan" : "minkan";
    return { type, tile: Math.min(...idx), aka: tiles.filter(isRed).length, tiles };
  }

  /**
   * チー出しの読みで通る牌の番号（無ければ -1）。meldTiles はチーした面子の3枚（鳴いた牌を含む）、discard はチーの直後に切った牌。
   * 切った牌が面子の隣（面子が a,a+1,a+2 なら a−1 か a+3）のとき、切った牌の筋（a−1 なら a+2、a+3 なら a）が通る。
   * 理屈: 通る牌 x で和了る手 H（チー後に切ったあとの手）なら、チーの前の手 H + 切った牌 + 面子の2枚 に鳴いた牌を足すと
   * H + x と順子（a−1 のときは a−1,a,a+1、a+3 のときは a+1,a+2,a+3）に分かれて和了形になる＝チーの前に鳴いた牌でロンできた。
   */
  function chiReadSafe(meldTiles, discard) {
    const a = Math.min(...meldTiles.map(tileIndex)), d = tileIndex(discard), r = a % 9;
    if (a >= 27) return -1;
    if (d === a - 1 && r >= 1) return a + 2;
    if (d === a + 3 && r <= 5) return a;
    return -1;
  }

  /** 1局の途中経過。start は start_kyoku の出来事。apply(e) で1つずつ進める。全員の手牌を持つ（牌譜には全員の手が入っている）。 */
  class Kyoku {
    constructor(start) {
      this.bakaze = 27 + HONORS.indexOf(start.bakaze);
      this.kyoku = start.kyoku;
      this.honba = start.honba;
      this.kyotaku = start.kyotaku;
      this.oya = start.oya;
      this.scores = start.scores.slice();
      this.hands = start.tehais.map(h => h.slice());
      this.melds = [[], [], [], []];
      this.rivers = [[], [], [], []];
      this.doraMarkers = [start.dora_marker];
      this.tilesLeft = 70; // 四麻で配牌後に山から引ける枚数（嶺上牌を引くと海底がずれるので、ツモ1回ごとに1枚減らす）
      this.riichi = [0, 0, 0, 0]; // 0: なし、1: 立直、2: ダブル立直
      this.riichiAccepted = [false, false, false, false];
      this.ippatsu = [false, false, false, false];
      this.pendingRiichi = -1;
      this.discardCount = [0, 0, 0, 0];
      this.anyCall = false;
      this.afterKan = -1; // カンをして嶺上牌を引いた席（その席が打牌するまで）
      this.lastTsumo = null;
      this.lastDiscard = null;
      this.lastKakan = null;
      this.results = [];
      // チー出しの読み（CLAUDE.md「チー出しの読み」）。席ごとに、いま効いている読み {safe, called, consumed, discard} か null
      this.chiReads = [null, null, null, null];
      this.pendingChi = [null, null, null, null]; // チーした直後で、まだ打牌していない席の {called, consumed, furiten}
      this.passedSince = [[], [], [], []]; // 席ごとに、自分の最後の打牌のあとに他家が出した牌（同巡内のフリテンを見るため）
    }
    seatWind(p) { return 27 + ((p - this.oya + 4) % 4); }
    apply(e) {
      const a = e.actor;
      switch (e.type) {
        case "tsumo":
          this.hands[a].push(e.pai);
          this.tilesLeft--;
          this.lastTsumo = { actor: a, pai: e.pai };
          this.lastKakan = null;
          break;
        case "dahai":
          removeTile(this.hands[a], e.pai);
          this.rivers[a].push({ pai: e.pai, tsumogiri: !!e.tsumogiri, riichi: this.pendingRiichi === a, called: false });
          if (this.pendingRiichi === a) this.pendingRiichi = -1;
          this.ippatsu[a] = false;
          this.discardCount[a]++;
          this.afterKan = -1;
          this.lastDiscard = { actor: a, pai: e.pai };
          this.lastKakan = null;
          if (this.pendingChi[a]) {
            const pc = this.pendingChi[a];
            const safe = pc.furiten ? -1 : chiReadSafe(pc.consumed.concat([pc.called]), e.pai);
            this.chiReads[a] = safe < 0 ? null : { safe, called: pc.called, consumed: pc.consumed.slice(), discard: e.pai };
            this.pendingChi[a] = null;
          } else if (!e.tsumogiri) this.chiReads[a] = null; // 手出しで手が変わったら読みは切れる
          this.passedSince[a] = [];
          for (let s = 0; s < 4; s++) if (s !== a) this.passedSince[s].push(tileIndex(e.pai));
          break;
        case "chi": case "pon": case "daiminkan":
          this.chiReads[a] = null;
          this.pendingChi[a] = null;
          if (e.type === "chi") {
            // 鳴いた牌で、チーの前にロンできなかった（フリテン）なら読みは成り立たない: 自分の河にある、または
            // 自分の最後の打牌のあとに他家が出していた（同巡内のフリテン。いま鳴いた牌そのものは除く）
            const c = tileIndex(e.pai);
            const furiten = this.rivers[a].some(x => tileIndex(x.pai) === c) || this.passedSince[a].slice(0, -1).includes(c);
            this.pendingChi[a] = { called: e.pai, consumed: e.consumed.slice(), furiten };
          }
          for (const x of e.consumed) removeTile(this.hands[a], x);
          this.melds[a].push({ type: e.type, pai: e.pai, consumed: e.consumed.slice(), target: e.target });
          this.rivers[e.target][this.rivers[e.target].length - 1].called = true;
          this.ippatsu.fill(false);
          this.anyCall = true;
          if (e.type === "daiminkan") this.afterKan = a;
          break;
        case "ankan":
          for (const x of e.consumed) removeTile(this.hands[a], x);
          this.melds[a].push({ type: "ankan", consumed: e.consumed.slice() });
          this.chiReads[a] = null;
          this.ippatsu.fill(false);
          this.anyCall = true;
          this.afterKan = a;
          break;
        case "kakan": {
          removeTile(this.hands[a], e.pai);
          const k = tileIndex(e.pai);
          const pon = this.melds[a].find(m => m.type === "pon" && tileIndex(m.pai) === k);
          if (!pon) throw new Error(`加槓するポンが見つかりません: ${e.pai}`);
          pon.type = "kakan";
          pon.added = e.pai;
          this.chiReads[a] = null;
          for (let s = 0; s < 4; s++) if (s !== a) this.passedSince[s].push(k); // 槍槓で和了れた牌も同巡内のフリテンになる
          this.ippatsu.fill(false);
          this.anyCall = true;
          this.afterKan = a;
          this.lastKakan = { actor: a, pai: e.pai };
          break;
        }
        case "dora":
          this.doraMarkers.push(e.dora_marker);
          break;
        case "reach":
          this.pendingRiichi = a;
          this.riichi[a] = this.discardCount[a] === 0 && !this.anyCall ? 2 : 1;
          break;
        case "reach_accepted":
          this.scores[a] -= 1000;
          this.kyotaku++;
          this.riichiAccepted[a] = true;
          this.ippatsu[a] = true;
          break;
        case "hora":
          this.results.push({ type: "hora", actor: a, target: e.target, deltas: e.deltas, ura: e.ura_markers || [], context: this.winContext(e) });
          for (let s = 0; s < 4; s++) this.scores[s] += e.deltas[s];
          this.kyotaku = 0;
          break;
        case "ryukyoku":
          this.results.push({ type: "ryukyoku", deltas: e.deltas });
          if (e.deltas) for (let s = 0; s < 4; s++) this.scores[s] += e.deltas[s];
          break;
        default:
          break;
      }
    }
    /** 和了した瞬間の手と状況（点数計算の入力）。apply の hora の中で、点数を動かす前に呼ぶ。 */
    winContext(e) {
      const a = e.actor, tsumo = e.target === a;
      const hand = this.hands[a].slice();
      let winPai;
      if (tsumo) winPai = hand[hand.length - 1];
      else {
        winPai = this.lastKakan ? this.lastKakan.pai : this.lastDiscard.pai;
        hand.push(winPai);
      }
      const melds = this.melds[a].map(engineMeld);
      return {
        hand: { c: counts34(hand), aka: hand.filter(isRed).length + melds.reduce((s, m) => s + m.aka, 0), melds, win: tileIndex(winPai) },
        ctx: {
          tsumo, oya: a === this.oya, bakaze: this.bakaze, jikaze: this.seatWind(a),
          riichi: this.riichiAccepted[a] ? this.riichi[a] : 0, ippatsu: this.ippatsu[a],
          haitei: tsumo && this.tilesLeft === 0 && this.afterKan !== a, houtei: !tsumo && this.tilesLeft === 0,
          rinshan: tsumo && this.afterKan === a, chankan: !tsumo && !!this.lastKakan,
          firstTurn: tsumo && this.discardCount[a] === 0 && !this.anyCall, // 天和・地和（カンも anyCall に入る）
          dora: this.doraMarkers.map(tileIndex), ura: (e.ura_markers || []).map(tileIndex),
        },
      };
    }
    /** 席 p から見えている牌の枚数（全員の河・全員の副露・ドラ表示牌。手牌は含めない）と、そのうちの赤5。 */
    visibleFrom() {
      const vis = new Array(34).fill(0), aka = [0, 0, 0];
      const add = t => { vis[tileIndex(t)]++; if (isRed(t)) aka[redSuit(t)]++; };
      for (const river of this.rivers) for (const x of river) add(x.pai);
      for (const ms of this.melds) {
        for (const m of ms) {
          for (const x of m.consumed) add(x);
          if (m.type === "kakan") add(m.added); // 鳴いた牌（m.pai）は河で数えている
        }
      }
      for (const d of this.doraMarkers) add(d);
      return { vis, aka };
    }
  }

  /** 対局全体の記録（mjai_log）を局ごとの出来事のリストに分ける（start_kyoku から end_kyoku まで）。 */
  function splitKyokus(events) {
    const out = [];
    let cur = null;
    for (const e of events) {
      if (e.type === "start_kyoku") { cur = [e]; out.push(cur); } else if (cur) {
        cur.push(e);
        if (e.type === "end_kyoku") cur = null;
      }
    }
    return out;
  }

  // ---------- 一人麻雀モデルの期待値 ----------
  // 前提は CLAUDE.md「何切るシミュレーター」。計算のしかた:
  //  - 自分だけが残り draws 回ツモる。他家は何もしない。和了はツモのみ。途中で鳴かない（はじめからある副露はそのまま）。
  //  - j 回目（0 始まり）のツモで牌 k を引く確率 = 山の残り(k) ÷ (S − j)。S は計算を始めたときに見えていない牌の総数。
  //    山の残り(k) = 4 − 見えている枚数 − max(いまの手の枚数, 計算を始めたときの14枚の中の枚数)（切った牌は山に戻さない）。
  //    手が変わらないツモ（ツモ切り）の確率は、1 − 手が変わるツモの確率の合計（ツモ切りした牌は欲しくなかった牌とみなす）。
  //    読み（options.weightSets）があるときは、山の残り(k) に牌ごとの重み m[k] を掛ける（evaluateWithExtra の transitionWeights）。
  //  - 探す範囲: 計算を始めた14枚から増えた牌の数 + シャンテン数 < 14枚のシャンテン数 + extra のあいだは、手変わりと
  //    向聴戻しも探す。それ以外は、シャンテン数を進めるツモと、進めたシャンテン数を保つ打牌だけを探す（mahjong-cpp の extra と同じ考え方）。
  //  - 打ち方は点数期待値が最大になるもの（同じなら和了確率、次に聴牌確率の高いもの）。聴牌確率・和了確率はその打ち方での値。
  //  - 門前で聴牌したら立直できる（riichi: 'max' は立直とダマの高いほう、'always' は必ず立直）。立直したら手を変えない。
  //  - 点数: ツモ和了で受け取る合計（本場・供託・立直棒は入れない）。立直の和了は裏ドラが乗る枚数の確率で平均する。
  class TooManyStates extends Error {}
  const popcount3 = x => (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1);
  const fiveSuit = k => (k === 4 ? 0 : k === 13 ? 1 : k === 22 ? 2 : -1);
  const SUIT_OF = Array.from({ length: 34 }, (_, i) => (i < 27 ? (i / 9) | 0 : 3));
  const RANK_OF = Array.from({ length: 34 }, (_, i) => (i < 27 ? i % 9 : i - 27));
  const IS_YAOCHU = Array.from({ length: 34 }, (_, i) => isYaochu(i));
  const M9 = 1953125, M7 = 78125; // 5^9（数牌1色の並びの数の上限）、5^7（字牌）

  /** 2つの整数（2^53 未満）を鍵にして整数を引く表（Map に文字列の鍵を入れるより速く、メモリも小さい）。 */
  class PairMap {
    constructor() { this.alloc(1 << 14); this.size = 0; }
    alloc(cap) { this.cap = cap; this.k1 = new Float64Array(cap); this.k2 = new Float64Array(cap); this.v = new Int32Array(cap).fill(-1); }
    slot(a, b) {
      let h = Math.imul((a % 4294967296) | 0, 0x9e3779b1) ^ Math.imul((a / 4294967296) | 0, 0x85ebca6b)
        ^ Math.imul((b % 4294967296) | 0, 0xc2b2ae35) ^ Math.imul((b / 4294967296) | 0, 0x27d4eb2f);
      h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
      const mask = this.cap - 1;
      let i = h & mask;
      while (this.v[i] !== -1 && (this.k1[i] !== a || this.k2[i] !== b)) i = (i + 1) & mask;
      return i;
    }
    get(a, b) { return this.v[this.slot(a, b)]; }
    set(a, b, val) {
      if ((this.size + 1) * 2 > this.cap) this.grow();
      const i = this.slot(a, b);
      if (this.v[i] === -1) this.size++;
      this.k1[i] = a; this.k2[i] = b; this.v[i] = val;
    }
    grow() {
      const { k1, k2, v, cap } = this;
      this.alloc(cap * 2);
      for (let i = 0; i < cap; i++) {
        if (v[i] === -1) continue;
        const s = this.slot(k1[i], k2[i]);
        this.k1[s] = k1[i]; this.k2[s] = k2[i]; this.v[s] = v[i];
      }
    }
  }
  function growTo(arr, n) {
    if (n <= arr.length) return arr;
    const out = new arr.constructor(Math.max(n, arr.length * 2));
    out.set(arr);
    return out;
  }

  /**
   * 鳴いた直後に切れない牌の番号（雀魂は喰い替えなし）。e は mjai の chi / pon の出来事。
   * ポンは鳴いた牌と同じ牌。チーは鳴いた牌と、両面の形で鳴いたときの反対側の筋の牌（例: 34 で 5 をチー → 5 と 2）。
   */
  function kuikaeForbidden(e) {
    const p = tileIndex(e.pai);
    if (e.type !== "chi") return [p];
    const [a, b] = e.consumed.map(tileIndex).sort((x, y) => x - y);
    const out = [p], r = p % 9;
    if (p < a && r + 3 <= 8) out.push(p + 3);
    if (p > b && r - 3 >= 0) out.push(p - 3);
    return out;
  }

  /**
   * 牌譜の再生中の局 kyoku で、席 p が打牌する場面の入力を作る（ツモった直後・鳴いた直後に呼ぶ）。
   * 見えている牌は、全員の河・全員の副露・ドラ表示牌（他家の手牌は使わない）。
   */
  function evInputFromKyoku(kyoku, p) {
    const { vis, aka } = kyoku.visibleFrom();
    return {
      hand: kyoku.hands[p].slice(),
      melds: kyoku.melds[p].map(engineMeld),
      vis, visAka: aka,
      dora: kyoku.doraMarkers.map(tileIndex),
      bakaze: kyoku.bakaze, jikaze: kyoku.seatWind(p), oya: p === kyoku.oya,
      draws: Math.max(0, Math.floor(kyoku.tilesLeft / 4)),
      haiteiLast: kyoku.tilesLeft > 0 && kyoku.tilesLeft % 4 === 0,
    };
  }

  /**
   * 手で打ち込んだ場面（何切る計算機.html）から、evaluateDiscards の入力と切れない牌を作る。
   * spec: {
   *   hand: 牌の文字列（打牌の前。14 − 3 × 副露の数 枚）,
   *   melds: [{type: 'chi'|'pon'|'minkan'|'ankan', tiles: 牌の文字列（鳴いた牌を含む）, called: 鳴いた牌（チー・ポンだけ。無ければ null）}],
   *   justCalled: 最後の副露を鳴いた直後なら true（喰い替えで切れない牌を外す。最後の副露がチー・ポンで called があるときだけ効く）,
   *   visible: 河と他家の副露の牌（任意。鳴かれて河から無くなった牌は入れない）, dora: ドラ表示牌,
   *   bakaze, jikaze: 'E'|'S'|'W'|'N', tilesLeft: 自分のツモ後の山の残り枚数（雀魂の卓の真ん中の数）,
   * }
   * 返り値: {input, exclude, complete（和了形か）, errors（読めない・ありえない点の説明。1つでもあれば input は null）}。
   * 見えている牌 = 自分の副露のすべての牌 + visible + ドラ表示牌（evInputFromKyoku と同じ数え方になる）。親は自風が東のとき。
   */
  function manualInput(spec) {
    const errors = [];
    const hand = (spec.hand || []).slice(), visible = (spec.visible || []).slice(), dora = (spec.dora || []).slice();
    const melds = [];
    (spec.melds || []).forEach((m, n) => {
      const idx = m.tiles.map(tileIndex).sort((a, b) => a - b);
      const name = `${n + 1}つ目の副露`;
      if (m.type === "chi") {
        if (idx.length !== 3 || idx[0] >= 27 || SUIT_OF[idx[0]] !== SUIT_OF[idx[2]] || idx[1] !== idx[0] + 1 || idx[2] !== idx[0] + 2) errors.push(`${name}（チー）は同じ色の3枚の順子にしてください`);
      } else if (m.type === "pon") {
        if (idx.length !== 3 || idx[0] !== idx[2]) errors.push(`${name}（ポン）は同じ牌3枚にしてください`);
      } else if (m.type === "minkan" || m.type === "ankan") {
        if (idx.length !== 4 || idx[0] !== idx[3]) errors.push(`${name}（カン）は同じ牌4枚にしてください`);
      } else errors.push(`${name}の種類が読めません: ${m.type}`);
      if (m.called && !m.tiles.includes(m.called)) errors.push(`${name}の鳴いた牌が副露の中にありません`);
      melds.push({ type: m.type, tile: idx[0], aka: m.tiles.filter(isRed).length, tiles: m.tiles.slice() });
    });
    const need = 14 - 3 * melds.length;
    if (hand.length !== need) errors.push(`手牌は ${need} 枚にしてください（いま ${hand.length} 枚。ツモった牌を含めた打牌の前の枚数）`);
    if (!dora.length) errors.push("ドラ表示牌を1枚以上入れてください");
    if (dora.length > 5) errors.push("ドラ表示牌は5枚までです");
    const tl = spec.tilesLeft === "" || spec.tilesLeft == null ? NaN : Number(spec.tilesLeft); // 空欄は 0 枚ではなく未入力
    if (!Number.isInteger(tl) || tl < 0 || tl > 69) errors.push("山の残り枚数は 0〜69 の整数にしてください");
    const winds = ["E", "S", "W", "N"];
    if (!winds.includes(spec.bakaze) || !winds.includes(spec.jikaze)) errors.push("場風と自風を選んでください");

    const vis = new Array(34).fill(0), visAka = [0, 0, 0];
    const add = t => { vis[tileIndex(t)]++; if (isRed(t)) visAka[redSuit(t)]++; };
    for (const m of melds) m.tiles.forEach(add);
    visible.forEach(add);
    dora.forEach(add);
    const all = counts34(hand), allAka = akaCounts(hand);
    for (let k = 0; k < 34; k++) if (all[k] + vis[k] > 4) errors.push(`${indexLabel(k)} が ${all[k] + vis[k]} 枚あります（4枚まで）`);
    for (let s = 0; s < 3; s++) if (allAka[s] + visAka[s] > 1) errors.push(`赤5${"mps"[s]} が ${allAka[s] + visAka[s]} 枚あります（1枚まで）`);
    // 山の牌はすべて自分から見えていない牌なので、見えていない牌は山の残り枚数以上あるはず（打ち間違いを知らせる。分母0も防ぐ）
    const unseen = 136 - hand.length - vis.reduce((a, b) => a + b, 0);
    if (Number.isInteger(tl) && tl >= 0 && unseen < tl) errors.push(`見えていない牌が ${unseen} 枚しかなく、山の残り ${tl} 枚より少なくなっています（見えている牌か山の残り枚数の打ち間違い）`);

    let exclude = [];
    const last = (spec.melds || [])[(spec.melds || []).length - 1];
    if (spec.justCalled && last && (last.type === "chi" || last.type === "pon") && last.called && last.tiles.includes(last.called)) {
      const consumed = last.tiles.slice();
      consumed.splice(consumed.indexOf(last.called), 1);
      exclude = kuikaeForbidden({ type: last.type, pai: last.called, consumed });
    }
    if (errors.length) return { input: null, exclude, complete: false, errors };
    const input = {
      hand, melds, vis, visAka, dora: dora.map(tileIndex),
      bakaze: tileIndex(spec.bakaze), jikaze: tileIndex(spec.jikaze), oya: spec.jikaze === "E",
      draws: Math.floor(tl / 4), haiteiLast: tl > 0 && tl % 4 === 0,
    };
    return { input, exclude, complete: shanten(all, melds.length) < 0, errors };
  }

  /**
   * 打牌候補ごとの、聴牌確率・和了確率・点数期待値。
   * input: {hand, melds, vis, visAka, dora, bakaze, jikaze, oya, draws, haiteiLast}（evInputFromKyoku の形）。
   * options: {riichi: 'max'|'always', extra, maxStates, ura, ippatsu, haitei, exclude（切れない牌の番号）, onProgress,
   *   weightSets（読みの重みの組の配列。組は牌34種ごとの1枚あたりのツモりやすさの比、null は読みなし。
   *   渡すと結果の bySet[i] に組 i での打牌候補が入り、candidates は組 0 のもの）}。
   * extra は前提4のとおり 1。調べる手（13枚）が maxStates 通りを超えたら期待値は出さず、打牌のあとのシャンテン数と
   * 受け入れだけを返す（tooMany: true、ev などは null）。extra を 0 に落として計算し直すことはしない
   * （手変わりを探さないと好形への組み替えが評価されず、README の手では4シャンテンに戻す打牌が上位に来るほど順位が崩れたため。
   * Claude の判断、2026-11-09）。
   */
  function evaluateDiscards(input, options) {
    const opt = Object.assign({ riichi: "max", extra: 1, maxStates: 600000, ura: true, ippatsu: true, haitei: true }, options || {});
    const started = Date.now();
    try {
      const res = evaluateWithExtra(input, opt, opt.extra, opt.maxStates);
      res.extra = opt.extra;
      return res;
    } catch (e) {
      if (!(e instanceof TooManyStates)) throw e;
      return {
        candidates: discardBasics(input, opt.exclude).map(b => Object.assign(b, { dama: null, riichi: null, choice: null, ev: null, win: null, tenpai: null, avg: null })),
        shanten14: shanten(counts34(input.hand), (input.melds || []).length), S: null, T: input.draws,
        states: opt.maxStates, tooMany: true, extra: opt.extra, ms: Date.now() - started,
      };
    }
  }

  /** 打牌候補ごとの、打牌のあとのシャンテン数と受け入れ（シャンテン数が進むツモの種類と、見えていない枚数の合計）。exclude の牌は候補にしない。 */
  function discardBasics(input, exclude) {
    const nMelds = (input.melds || []).length;
    const H = counts34(input.hand), Haka = akaCounts(input.hand);
    const out = [];
    for (let d = 0; d < 34; d++) {
      if (!H[d] || (exclude && exclude.includes(d))) continue;
      H[d]--;
      const s = shanten(H, nMelds);
      const kinds = [];
      let count = 0;
      for (let k = 0; k < 34; k++) {
        const left = 4 - input.vis[k] - H[k] - (k === d ? 1 : 0); // 切った牌も山には無い
        if (left <= 0) continue;
        H[k]++;
        if (shanten(H, nMelds) < s) { kinds.push(k); count += left; }
        H[k]--;
      }
      H[d]++;
      const sd = fiveSuit(d);
      const choices = sd >= 0 && Haka[sd] ? (H[d] > Haka[sd] ? [0, 1] : [1]) : [0]; // 5は普通の5と赤5を別の候補にする
      for (const red of choices) out.push({ tile: tileString(d, red === 1), index: d, red: red === 1, shanten: s, ukeire: { kinds, count } });
    }
    return out;
  }

  function evaluateWithExtra(input, opt, extra, maxStates) {
    const started = Date.now();
    const melds = input.melds || [];
    const nMelds = melds.length;
    const need = 4 - nMelds;
    const menzen = melds.every(m => m.type === "ankan");
    const closedShapes = nMelds === 0; // 七対子・国士無双も考える
    const maxMode = opt.riichi !== "always";
    const meldAka = melds.reduce((s, m) => s + (m.aka || 0), 0);
    if (input.hand.length !== 14 - 3 * nMelds) throw new Error(`打牌の前の手牌は ${14 - 3 * nMelds} 枚のはずです（${input.hand.length} 枚）`);
    const H = counts34(input.hand);
    const Haka = akaCounts(input.hand);
    const W0 = new Int8Array(34);
    let S = 0;
    for (let k = 0; k < 34; k++) {
      W0[k] = 4 - input.vis[k] - H[k];
      if (W0[k] < 0) throw new Error(`${indexLabel(k)} が5枚以上あります（見えている牌の数え方の誤り）`);
      S += W0[k];
    }
    const W0aka = [0, 1, 2].map(s => Math.max(0, 1 - ((input.visAka || [])[s] || 0) - Haka[s]));
    const T = input.draws;
    // ツモの確率の分母 S − j（j < T）が0以下になる入力は計算できない（見えている牌か山の残りの数え方の誤り）
    if (S < T) throw new Error(`見えていない牌（${S}枚）が残りのツモ回数（${T}回）より少なくなっています（見えている牌か山の残り枚数の誤り）`);
    const haiteiLast = !!input.haiteiLast && opt.haitei;
    const meldTiles = new Array(34).fill(0);
    for (const m of melds) {
      if (m.type === "chi") { meldTiles[m.tile]++; meldTiles[m.tile + 1]++; meldTiles[m.tile + 2]++; } else meldTiles[m.tile] += m.type === "pon" ? 3 : 4;
    }
    const s14 = shanten(H, nMelds);
    const budget = s14 + extra;

    // ----- 状態（13枚の手）。手は色ごとの並びの数（5進数）2つにまとめて持つ -----
    let nK1 = new Float64Array(1024), nK2 = new Float64Array(1024);
    let nSh = new Int8Array(1024), nDist = new Int8Array(1024), nDepth = new Int8Array(1024);
    let nTrStart = new Int32Array(1024), nTrEnd = new Int32Array(1024);
    let N = 0;
    const nodeMap = new PairMap();
    function nodeId(cm, cp, cs, cz, aka, sh, dist, depth) {
      const k1 = cm * M9 + cp, k2 = (cs * M7 + cz) * 8 + aka;
      const found = nodeMap.get(k1, k2);
      if (found !== -1) return found;
      if (N >= maxStates) throw new TooManyStates();
      if (N === nK1.length) {
        const n = N * 2;
        nK1 = growTo(nK1, n); nK2 = growTo(nK2, n); nSh = growTo(nSh, n); nDist = growTo(nDist, n);
        nDepth = growTo(nDepth, n); nTrStart = growTo(nTrStart, n); nTrEnd = growTo(nTrEnd, n);
      }
      nK1[N] = k1; nK2[N] = k2; nSh[N] = sh; nDist[N] = dist; nDepth[N] = depth;
      nodeMap.set(k1, k2, N);
      return N++;
    }
    function decodeNode(id, c) {
      const k1 = nK1[id], k2 = nK2[id];
      const aka = k2 % 8, r = (k2 - aka) / 8;
      const codes = [Math.floor(k1 / M9), 0, Math.floor(r / M7), 0];
      codes[1] = k1 - codes[0] * M9;
      codes[3] = r - codes[2] * M7;
      for (let X = 0; X < 4; X++) {
        let code = codes[X];
        const n = X === 3 ? 7 : 9, base = X * 9;
        for (let i = 0; i < n; i++) { const d = code % 5; c[base + i] = d; code = (code - d) / 5; }
      }
      return { codes, aka };
    }

    // ----- ツモごとの行き先（型付き配列に詰める） -----
    // tW: その牌の残り枚数、tK: その牌の番号（読みの重みを掛けるため）、tWin: 和了の点数の索引（-1 は和了形でない）、
    // tH: ツモったあとの14枚の番号（-1 は手を変えない）。
    // 14枚の手からの打牌の行き先は、いくつもの13枚の手から同じ14枚にたどり着くので、14枚ごとに1回だけ調べて
    // succ[hS0[h] .. hS1[h]) に入れておく
    let tW = new Uint8Array(4096), tK = new Uint8Array(4096), tWin = new Int32Array(4096), tH = new Int32Array(4096);
    let nT = 0;
    let succ = new Int32Array(16384);
    let nS = 0;
    const h14Map = new PairMap();
    let hS0 = new Int32Array(4096), hS1 = new Int32Array(4096), hDepth = new Int8Array(4096); // hDepth: その14枚を初めて調べたときのツモの回数
    let nH = 0;

    // ----- 和了したときの点数（同じ和了形は1回だけ数える） -----
    const winMap = new PairMap();
    const winInfos = [];
    function uraDistribution(c14) {
      const n = input.dora.length; // 裏ドラ表示牌の数 = ドラ表示牌の数
      if (!opt.ura || n === 0) return [1];
      let W = 0;
      const w = new Array(34);
      for (let x = 0; x < 34; x++) { w[x] = Math.max(0, W0[x] - Math.max(0, c14[x] - H[x])); W += w[x]; }
      const one = [0, 0, 0, 0, 0];
      for (let x = 0; x < 34; x++) if (w[x] > 0) { const d = doraOf(x); one[c14[d] + meldTiles[d]] += w[x] / W; }
      let dist = [1];
      for (let i = 0; i < n; i++) {
        const nd = new Array(dist.length + 4).fill(0);
        for (let a = 0; a < dist.length; a++) for (let b = 0; b < 5; b++) nd[a + b] += dist[a] * one[b];
        dist = nd;
      }
      return dist;
    }
    /** 14枚 c14（赤5は aka14）が牌 k で和了った形の点数の索引。和了れない（役が無い）ときは -1。 */
    function winIndex(c14, codes14, aka14, k) {
      const k1 = codes14[0] * M9 + codes14[1], k2 = ((codes14[2] * M7 + codes14[3]) * 8 + aka14) * 34 + k;
      const found = winMap.get(k1, k2);
      if (found !== -1) return found;
      const readings = shapeReadings(Array.from(c14), melds, k, true, input.bakaze, input.jikaze);
      let idx = -2;
      if (readings.length) {
        let dk = popcount3(aka14) + meldAka;
        for (const ind of input.dora) { const d = doraOf(ind); dk += c14[d] + meldTiles[d]; }
        const pts = (extraYaku, extraDora) => {
          let best = 0;
          for (const r of readings) {
            let p;
            if (r.yakuman) p = payment(8000 * r.yakuman, input.oya, true).total;
            else if (r.han + extraYaku <= 0) continue; // 役なし
            else p = payment(basePoints(r.han + extraYaku + dk + extraDora, r.fu, 0), input.oya, true).total;
            if (p > best) best = p;
          }
          return best;
        };
        const info = { dama: pts(0, 0), damaHaitei: pts(1, 0), riichi: null };
        if (menzen) {
          const ura = uraDistribution(c14);
          const ev = (ipp, hai) => {
            let e = 0;
            for (let u = 0; u < ura.length; u++) if (ura[u]) e += ura[u] * pts(1 + ipp + hai, u);
            return e;
          };
          info.riichi = [[ev(0, 0), ev(0, 1)], [ev(1, 0), ev(1, 1)]]; // [一発][海底]
        }
        if (info.dama || info.damaHaitei || info.riichi) { idx = winInfos.length; winInfos.push(info); }
      }
      winMap.set(k1, k2, idx);
      return idx;
    }

    // ----- 状態から、ツモごとの行き先を作る -----
    // 1枚引いて1枚切っても変わるのは1〜2色だけなので、変わらない色を組み合わせた表を使い回してシャンテン数を出す
    const c = new Int8Array(34);
    const P = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => new Uint8Array(10))); // P[X][Y]: 2色を合わせた表
    const rest = Array.from({ length: 4 }, () => new Uint8Array(10)); // rest[X]: X 以外の3色を合わせた表
    const restY = Array.from({ length: 4 }, () => new Uint8Array(10)); // ツモで X が変わったときの、Y 以外の3色
    const others = (X, Y) => { const o = [0, 1, 2, 3].filter(Z => Z !== X && Z !== Y); return P[o[0]][o[1]]; };
    const OTHERS = [0, 1, 2, 3].map(X => [0, 1, 2, 3].map(Y => (X === Y ? null : others(X, Y))));
    const codes14 = [0, 0, 0, 0];
    function expand(id) {
      const { codes, aka } = decodeNode(id, c);
      const sh = nSh[id], dist = nDist[id], depth = nDepth[id], ext = dist + sh < budget;
      const tabs = codes.map((code, X) => tableOf(X, code));
      for (let X = 0; X < 4; X++) for (let Y = X + 1; Y < 4; Y++) combine(tabs[X], tabs[Y], P[X][Y]);
      combine(tabs[1], P[2][3], rest[0]); combine(tabs[0], P[2][3], rest[1]);
      combine(tabs[3], P[0][1], rest[2]); combine(tabs[2], P[0][1], rest[3]);
      let pairs = 0, kinds = 0, yk = 0, yp = 0;
      if (closedShapes) {
        for (let i = 0; i < 34; i++) {
          if (c[i]) { kinds++; if (IS_YAOCHU[i]) yk++; }
          if (c[i] >= 2) { pairs++; if (IS_YAOCHU[i]) yp++; }
        }
      }
      const trStart = nT;
      for (let k = 0; k < 34; k++) {
        const w = W0[k] - Math.max(0, c[k] - H[k]);
        if (w <= 0) continue;
        const X = SUIT_OF[k];
        const codeX1 = codes[X] + POW5[RANK_OF[k]];
        const TX1 = tableOf(X, codeX1);
        let sh14 = finalShanten(TX1, rest[X], need);
        let pairs1 = pairs, kinds1 = kinds, yk1 = yk, yp1 = yp;
        if (closedShapes) {
          const ck = c[k], y = IS_YAOCHU[k];
          if (ck === 0) { kinds1++; if (y) yk1++; } else if (ck === 1) { pairs1++; if (y) yp1++; }
          sh14 = Math.min(sh14, 6 - pairs1 + Math.max(0, 7 - kinds1), 13 - yk1 - (yp1 > 0 ? 1 : 0));
        }
        const useful = sh14 < sh;
        const s5 = fiveSuit(k);
        const wRed = s5 >= 0 ? Math.max(0, W0aka[s5] - Math.max(0, ((aka >> s5) & 1) - Haka[s5])) : 0;
        c[k]++;
        codes14[0] = codes[0]; codes14[1] = codes[1]; codes14[2] = codes[2]; codes14[3] = codes[3];
        codes14[X] = codeX1;
        let restReady = false;
        const dist14 = dist + (c[k] > H[k] ? 1 : 0);
        for (let red = 0; red <= 1; red++) {
          const wv = red ? wRed : w - wRed;
          if (wv <= 0) continue;
          const aka14 = red ? aka | (1 << s5) : aka;
          let wi = -1, hi = -1;
          if (sh14 === -1) wi = winIndex(c, codes14, aka14, k); // 和了形になるツモは「和了るかツモ切りか」だけを比べる
          else if (useful || ext) {
            const h1 = codes14[0] * M9 + codes14[1], h2 = (codes14[2] * M7 + codes14[3]) * 8 + aka14;
            hi = h14Map.get(h1, h2);
            if (hi === -1) {
              if (!restReady) {
                for (let Y = 0; Y < 4; Y++) if (Y !== X) combine(TX1, OTHERS[X][Y], restY[Y]);
                restReady = true;
              }
              if (nH === hS0.length) { hS0 = growTo(hS0, nH + 1); hS1 = growTo(hS1, nH + 1); hDepth = growTo(hDepth, nH + 1); }
              hi = nH++;
              hS0[hi] = nS;
              hDepth[hi] = depth;
              addDiscards(codes, X, codeX1, aka14, sh14, dist14, depth, pairs1, kinds1, yk1, yp1);
              hS1[hi] = nS;
              h14Map.set(h1, h2, hi);
            }
            if (hS1[hi] === hS0[hi]) hi = -1;
          }
          if (wi >= 0 || hi >= 0) {
            if (nT === tW.length) { tW = growTo(tW, nT + 1); tK = growTo(tK, nT + 1); tWin = growTo(tWin, nT + 1); tH = growTo(tH, nT + 1); }
            tW[nT] = wv; tK[nT] = k; tWin[nT] = wi; tH[nT] = hi;
            nT++;
          }
        }
        c[k]--;
      }
      nTrStart[id] = trStart;
      nTrEnd[id] = nT;
    }

    /** いまの14枚（c、牌 k を引いて色 X の並びが codeX1 になったもの）から、探す範囲に入る打牌の行き先を succ に足す。 */
    function addDiscards(codes, X, codeX1, aka14, sh14, dist14, depth, pairs1, kinds1, yk1, yp1) {
      const freeDiscard = dist14 + sh14 < budget;
      const target = Math.max(sh14, 0);
      for (let d = 0; d < 34; d++) {
        const cd = c[d];
        if (!cd) continue;
        let akaAfter = aka14;
        const sd = fiveSuit(d);
        if (sd >= 0 && cd === ((aka14 >> sd) & 1)) akaAfter = aka14 & ~(1 << sd); // 5は普通の5から切り、赤5だけなら赤5を切る
        const Y = SUIT_OF[d];
        const codeY = (Y === X ? codeX1 : codes[Y]) - POW5[RANK_OF[d]];
        let s2 = finalShanten(tableOf(Y, codeY), Y === X ? rest[X] : restY[Y], need);
        if (closedShapes) {
          let p2 = pairs1, k2 = kinds1, y2 = yk1, yp2 = yp1;
          const yd = IS_YAOCHU[d];
          if (cd === 2) { p2--; if (yd) yp2--; } else if (cd === 1) { k2--; if (yd) y2--; }
          s2 = Math.min(s2, 6 - p2 + Math.max(0, 7 - k2), 13 - y2 - (yp2 > 0 ? 1 : 0));
        }
        if (!freeDiscard && s2 !== target) continue;
        // 残りのツモでは聴牌まで届かない手（値はすべて0）は探さない。14枚を初めて調べたときの深さで決める
        // （幅優先なので、それが一番浅い。もっと深い所から来たときに値0の行き先が混ざっても結果は変わらない）
        if (s2 > T - depth - 1) continue;
        // 引いた牌をそのまま切る行き先（もとの13枚）も入れる。値はツモ切りと同じなので結果は変わらない
        const n0 = Y === 0 ? codeY : X === 0 ? codeX1 : codes[0];
        const n1 = Y === 1 ? codeY : X === 1 ? codeX1 : codes[1];
        const n2 = Y === 2 ? codeY : X === 2 ? codeX1 : codes[2];
        const n3 = Y === 3 ? codeY : X === 3 ? codeX1 : codes[3];
        const sid = nodeId(n0, n1, n2, n3, akaAfter, s2, dist14 - (cd > H[d] ? 1 : 0), depth + 1);
        if (nS === succ.length) succ = growTo(succ, nS + 1);
        succ[nS++] = sid;
      }
    }

    // ----- 打牌候補（根）。opt.exclude の牌（鳴いた直後の喰い替えで切れない牌）は候補にしない -----
    const roots = [];
    const handAka = (Haka[0] ? 1 : 0) | (Haka[1] ? 2 : 0) | (Haka[2] ? 4 : 0);
    for (let d = 0; d < 34; d++) {
      if (!H[d] || (opt.exclude && opt.exclude.includes(d))) continue;
      const sd = fiveSuit(d);
      const choices = sd >= 0 && Haka[sd] ? (H[d] > Haka[sd] ? [0, 1] : [1]) : [0];
      for (const red of choices) {
        const h = H.slice();
        h[d]--;
        const aka = red ? handAka & ~(1 << sd) : handAka;
        const id = nodeId(suitCode(h, 0, 9), suitCode(h, 9, 9), suitCode(h, 18, 9), suitCode(h, 27, 7), aka, shanten(h, nMelds), 0, 0);
        roots.push({ tile: tileString(d, red === 1), index: d, red: red === 1, id });
      }
    }
    // 幅優先で広げる。初めて見つかったときのツモの回数が、残りのツモ回数以上の状態は、その先を探さない
    for (let q = 0; q < N; q++) {
      if (nDepth[q] < T) expand(q);
      if (opt.onProgress && q % 5000 === 4999) opt.onProgress({ phase: "search", done: q + 1, states: N });
    }
    const searchMs = Date.now() - started;

    // ----- 読みの重み（opt.weightSets）。探索で作った手のつながりは重みに関係しないので、値の計算だけを重みの組ごとにやり直す -----
    // 組の中身は牌34種ごとの「1枚あたりのツモりやすさ」の比（null は読みなし = すべて1）。
    // 牌 k を引く確率 = m[k] × 残り(k) ÷ (S − j)。m[k] = 比[k] × S ÷ Σ(比 × 計算を始めたときの残り) で、
    // 計算を始めたときの確率の合計が1のままになるようにそろえる（CLAUDE.md「何切る計算機」の読み）。
    const sets = opt.weightSets && opt.weightSets.length ? opt.weightSets : [null];
    function transitionWeights(raw) {
      if (!raw) return tW;
      if (raw.length !== 34 || raw.some(x => !(x > 0) || !Number.isFinite(x))) throw new Error("読みの重みは34個の正の数にしてください");
      let Z = 0;
      for (let k = 0; k < 34; k++) Z += raw[k] * W0[k];
      const m = raw.map(x => (Z > 0 ? (x * S) / Z : 1));
      const out = new Float64Array(nT);
      for (let t = 0; t < nT; t++) out[t] = tW[t] * m[tK[t]];
      return out;
    }
    const basics = discardBasics(input, opt.exclude);
    const results = sets.map((raw, si) => valuesFor(transitionWeights(raw), si));
    return {
      candidates: results[0].candidates, bySet: opt.weightSets ? results.map(r => r.candidates) : undefined,
      shanten14: s14, S, T, states: N, transitions: nT, overflow: results[0].overflow, searchMs, ms: Date.now() - started,
    };

    /** 手のつながりの上で、ツモの重み tw（遷移ごと）を使って打牌候補ごとの値を出す。si は重みの組の番号（進み具合の表示用）。 */
    function valuesFor(tw, si) {
      // ----- 立直したときの値（手が変わらないので式で出せる）。rStore[off + j] = 期待値、rStore[off + L + j] = 和了確率 -----
      const L = T + 1;
      const rOff = new Int32Array(N).fill(-1);
      let rStore = new Float64Array(1024);
      let rN = 0;
      const eTmp = new Float64Array(T + 2), wTmp = new Float64Array(T + 2);
      function riichiOffset(id) {
        if (rOff[id] >= 0) return rOff[id];
        const off = rN;
        rN += 2 * L;
        rStore = growTo(rStore, rN);
        rStore.fill(0, off, off + 2 * L);
        if (nDepth[id] < T) { // これより深い状態は、残りのツモが無いときにしか使わない（値は0）
          let Q = 0;
          const wins = [];
          for (let t = nTrStart[id]; t < nTrEnd[id]; t++) {
            if (tWin[t] < 0) continue;
            const info = winInfos[tWin[t]];
            if (!info.riichi) continue;
            Q += tw[t];
            wins.push(tw[t], info);
          }
          eTmp.fill(0); wTmp.fill(0);
          // 和了牌を引く確率の合計 Q ÷ (S − j) が1を超えるときは、立直していない手と同じく合計が1になるように割り戻す
          // （前提3。各和了牌の確率は 重み ÷ max(Q, S − j)）
          for (let j = T - 1; j >= 0; j--) { // 一発の無いツモが j 回目から続くときの値
            const dn = Math.max(Q, S - j), q = Q / dn, hai = j === T - 1 && haiteiLast ? 1 : 0;
            let sum = 0;
            for (let i = 0; i < wins.length; i += 2) sum += (wins[i] / dn) * wins[i + 1].riichi[0][hai];
            eTmp[j] = sum + (1 - q) * eTmp[j + 1];
            wTmp[j] = q + (1 - q) * wTmp[j + 1];
          }
          for (let j = 0; j < T; j++) { // 立直の直後のツモ（j 回目）は一発
            const dn = Math.max(Q, S - j), q = Q / dn, hai = j === T - 1 && haiteiLast ? 1 : 0;
            let sum = 0;
            for (let i = 0; i < wins.length; i += 2) sum += (wins[i] / dn) * wins[i + 1].riichi[opt.ippatsu ? 1 : 0][hai];
            rStore[off + j] = sum + (1 - q) * eTmp[j + 1];
            rStore[off + L + j] = wTmp[j];
          }
        }
        rOff[id] = off;
        return off;
      }

      // ----- 局の終わりから逆向きに値を積み上げる -----
      const EPS = 1e-9;
      const better = (v1, w1, p1, v2, w2, p2) => {
        if (Math.abs(v1 - v2) > EPS * Math.max(1, Math.abs(v2))) return v1 > v2;
        if (Math.abs(w1 - w2) > EPS) return w1 > w2;
        return p1 > p2 + EPS;
      };
      let nV = new Float64Array(N), nW = new Float64Array(N), nP = new Float64Array(N);
      let cV = new Float64Array(N), cW = new Float64Array(N), cP = new Float64Array(N);
      const hV = new Float64Array(nH), hW = new Float64Array(nH), hP = new Float64Array(nH);
      for (let i = 0; i < N; i++) nP[i] = nSh[i] === 0 ? 1 : 0; // 最後まで引いたとき聴牌なら聴牌
      let overflow = 0;
      for (let j = T - 1; j >= 0; j--) {
        const denom = S - j, lastDraw = j === T - 1 && haiteiLast, j1 = j + 1;
        // 14枚の手ごとに、一番よい打牌（聴牌に取って立直するかどうかも含む）のあとの値を先に出しておく。
        // 同じ14枚には多くの13枚の手からたどり着くので、ツモごとに比べ直すより速い
        for (let h = 0; h < nH; h++) {
          if (hDepth[h] > j) continue; // j 回目にはまだ来られない14枚
          let V = -1, W = 0, Pp = 0;
          for (let s = hS0[h], se = hS1[h]; s < se; s++) {
            const sid = succ[s];
            let v = nV[sid], w = nW[sid], pp = nP[sid];
            if (menzen && nSh[sid] === 0) { // 聴牌に取って立直する（always では必ず）
              const off = riichiOffset(sid), rv = rStore[off + j1], rw = rStore[off + L + j1];
              if (!maxMode || better(rv, rw, 1, v, w, pp)) { v = rv; w = rw; pp = 1; }
            }
            if (V < 0 || better(v, w, pp, V, W, Pp)) { V = v; W = w; Pp = pp; }
          }
          hV[h] = V; hW[h] = W; hP[h] = Pp;
        }
        for (let id = 0; id < N; id++) {
          if (nDepth[id] > j) { cV[id] = nV[id]; cW[id] = nW[id]; cP[id] = nP[id]; continue; } // j 回目にはまだ来られない状態
          let sV = nV[id], sW = nW[id], sP = nP[id]; // 手が変わらないツモ（ツモ切り）のときの値
          if (maxMode && menzen && nSh[id] === 0) { // ツモ切りして立直する
            const off = riichiOffset(id), rv = rStore[off + j1], rw = rStore[off + L + j1];
            if (better(rv, rw, 1, sV, sW, sP)) { sV = rv; sW = rw; sP = 1; }
          }
          let dV = 0, dW = 0, dP = 0, mass = 0;
          for (let t = nTrStart[id], te = nTrEnd[id]; t < te; t++) {
            let V = sV, W = sW, Pp = sP;
            const hi = tH[t];
            if (hi >= 0 && better(hV[hi], hW[hi], hP[hi], V, W, Pp)) { V = hV[hi]; W = hW[hi]; Pp = hP[hi]; }
            const wi = tWin[t];
            if (wi >= 0) {
              const info = winInfos[wi], v = lastDraw ? info.damaHaitei : info.dama;
              if (v > 0 && better(v, 1, 1, V, W, Pp)) { V = v; W = 1; Pp = 1; }
            }
            if (V !== sV || W !== sW || Pp !== sP) {
              const p = tw[t] / denom;
              mass += p;
              dV += p * (V - sV); dW += p * (W - sW); dP += p * (Pp - sP);
            }
          }
          // 手が変わるツモの確率の合計が1を超えるとき（ほとんどどの牌でも手が良くなる状態で j が大きいとき）は、
          // 合計が1になるように割り戻す（「ツモ切りした牌は欲しくなかった牌」という見方が成り立たないため）
          const scale = mass > 1 ? 1 / mass : 1;
          if (mass > 1 + 1e-9) overflow++;
          cV[id] = sV + dV * scale; cW[id] = sW + dW * scale; cP[id] = sP + dP * scale;
        }
        [nV, cV] = [cV, nV]; [nW, cW] = [cW, nW]; [nP, cP] = [cP, nP];
        if (opt.onProgress) opt.onProgress({ phase: "values", done: si * T + T - j, total: T * sets.length, states: N });
      }

      // ----- 結果 -----
      const candidates = roots.map(rt => {
        const id = rt.id;
        const dama = { ev: nV[id], win: nW[id], tenpai: nP[id] };
        let riichi = null;
        if (menzen && nSh[id] === 0 && T > 0) { const off = riichiOffset(id); riichi = { ev: rStore[off], win: rStore[off + L], tenpai: 1 }; }
        let choice = "dama", best = dama;
        if (riichi && (!maxMode || better(riichi.ev, riichi.win, 1, dama.ev, dama.win, dama.tenpai))) { choice = "riichi"; best = riichi; }
        const b = basics.find(x => x.index === rt.index && x.red === rt.red);
        return Object.assign({}, b, {
          dama: !maxMode && riichi ? null : dama, riichi, choice,
          ev: best.ev, win: best.win, tenpai: best.tenpai, avg: best.win > 1e-12 ? best.ev / best.win : 0,
        });
      });
      return { candidates, overflow };
    }
  }


  return {
    HONORS, HONOR_NAMES, FIVES,
    tileIndex, isRed, redSuit, tileString, tileLabel, indexLabel, doraOf, isYaochu, counts34, akaCounts, parseHand,
    shanten, regularShanten, chiitoiShanten, kokushiShanten,
    decompositions, shapeReadings, scoreHand, basePoints, payment, pointsText,
    engineMeld, Kyoku, splitKyokus,
    evInputFromKyoku, manualInput, evaluateDiscards, discardBasics, kuikaeForbidden, chiReadSafe,
  };
});
