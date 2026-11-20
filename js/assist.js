/*
 * assist.js — アシストの計算（仕様書 6章）。画面を持たない。ブラウザでは window.Assist、node では require。
 * 入力は自分の席に届いた view（game.view(seat) と同じ形）だけ。他家の手・袋の中は見ない（見えている牌の枚数から数える）。
 *
 *   Assist.analyze(view) → {
 *     turn: 自分が切る番の形（手が 3n+2 枚）か,
 *     shanten: シャンテン数（切る番なら、切れる牌のうちいちばん良い切り方をしたあとの数。0 以下は聴牌）,
 *     discards: 切る番だけ。Map<牌の id, {k, red, shanten, uke: [{k, left}], total, keep, mark, best, tenpai}>
 *               uke = 引けば進む牌と残り枚数、total = その合計、keep = シャンテン数が戻らない、
 *               mark = 印を付ける牌（keep の中で total の多い順に3種類まで）、best = mark の中で total が最多、
 *               tenpai = 切ると聴牌になるときの待ち（下の now と同じ形）,
 *     now: いまの13枚型の手（切る番ならツモ牌を除いた手）が聴牌のとき {waits: [{k, left, ron, tsumo}], furiten, noRon, noYaku}
 *          ron / tsumo = その牌で和了ったときの {yaku, han, fu, yakuman, points}。役が無ければ null。
 *          裏ドラ・一発・海底などは入れない（確定している分だけ）。
 *     chances: 狙える役 [{yaku: calc.js の役名, label: 画面に出す名前, sure: もう確定しているか}],
 *     defense: 牌の種類ごとの守りの目安 [34]（3 現物・2 スジ・1 壁・0 なし。立直している他家がいなければ null）,
 *   }
 *   Assist.evInput(view) → 期待値の計算（mj_engine.js の evaluateDiscards）に渡す {input, exclude}。切る番でなければ null。
 *   Assist.tenpaiAfter(view, id, riichi) → id を切ったあとの待ち（立直して切るときは riichi = true）。聴牌でなければ null。
 *   Assist.callInfo(view) → 鳴きの問い（view.options.kind === "call"）のとき
 *     {loseRiichi, pon: [{own, advances, noYaku, exact, yaku}], chi: [...], kan: {...} | null}
 *     advances = 鳴くとシャンテン数が進む、noYaku = 鳴くと役の付く和了り方が無い、
 *     exact = 鳴いたあと1シャンテン以内で、和了り方を全部たどって確かめた（false のときは CHANCE の目安で見た推定）、
 *     yaku = 鳴いたあと狙える役 [{yaku, label, sure}]（chances と同じ形）。exact なら、たどった和了り方のどれかに付く役を全部
 *            （sure = どう和了っても付く）。exact でなければ「狙える役」と同じ条件の役。noYaku なら空。
 *   Assist.callYaku(pon や chi の配列) → その種類の鳴きで狙える役（鳴き方をまとめたもの）。
 *   Assist.yakuInfo(役名) → [読み, 一言の説明]。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"));
  else root.Assist = factory(root.MJ);
})(typeof self !== "undefined" ? self : this, function (MJ) {
  "use strict";

  const kindOf = id => id >> 2;
  const isRed = id => id === 16 || id === 52 || id === 88;
  const INF = 99;
  const MARK_MAX = 3; // 打牌の印（進む牌の印）を付ける牌の種類の上限（本人決定 2026-11-20。仕様書 6章①）
  function countsOf(ids) {
    const c = new Array(34).fill(0);
    for (const t of ids) c[t >> 2]++;
    return c;
  }

  // 「狙える役」に出す目安（Claude が置いた仮の値。仕様書 6章）。
  // slack: その役だけを目指したときのシャンテン数が、いまのシャンテン数よりいくつ遠くても出すか。
  // maxOut: その役に使えない牌が手に何枚までなら出すか。minGroups: 対子・刻子（鳴いた分を含む）が何組以上なら出すか。
  const CHANCE = {
    tanyao: { slack: 0, maxOut: 3 },
    honitsu: { slack: 1, maxOut: 4 },
    chinitsu: { slack: 1, maxOut: 3 },
    toitoi: { slack: 1, minGroups: 4 },
    chiitoi: { slack: 0, minPairs: 3 },
  };

  // ---------- 役の読みと一言の説明（画面の結果表示・アシストの札で使う） ----------
  const YAKU = {
    "立直": ["リーチ", "鳴かずにテンパイして「リーチ」と宣言する"],
    "ダブル立直": ["ダブルリーチ", "最初の自分の番でリーチする"],
    "一発": ["イッパツ", "リーチしてから1巡のうちに和了る"],
    "門前清自摸和": ["ツモ", "鳴かずに、自分で引いた牌で和了る"],
    "平和": ["ピンフ", "4組とも数の並びで、頭が役牌でなく、両側で待って和了る（鳴くと付かない）"],
    "断幺九": ["タンヤオ", "2〜8の数牌だけで作る"],
    "一盃口": ["イーペーコー", "同じ数の並びを2組作る（鳴くと付かない）"],
    "二盃口": ["リャンペーコー", "イーペーコーを2つ作る（鳴くと付かない）"],
    "役牌 白": ["役牌 白", "白を3枚そろえる"],
    "役牌 發": ["役牌 發", "發を3枚そろえる"],
    "役牌 中": ["役牌 中", "中を3枚そろえる"],
    "役牌:場風牌": ["役牌 場風", "場の風の牌（東場なら東）を3枚そろえる"],
    "役牌:自風牌": ["役牌 自風", "自分の席の風の牌を3枚そろえる"],
    "三色同順": ["サンショク", "萬子・筒子・索子で同じ数の並びを作る"],
    "一気通貫": ["イッツー", "同じ色で 123・456・789 を作る"],
    "混全帯幺九": ["チャンタ", "4組と頭のすべてに 1・9・字牌を入れる"],
    "純全帯幺九": ["ジュンチャン", "4組と頭のすべてに 1・9 を入れる（字牌は使わない）"],
    "対々和": ["トイトイ", "4組とも同じ牌3枚で作る"],
    "三暗刻": ["サンアンコー", "鳴かずにそろえた同じ牌3枚を3組作る"],
    "三色同刻": ["サンショクドーコー", "萬子・筒子・索子で同じ数の3枚組を作る"],
    "三槓子": ["サンカンツ", "カンを3回する"],
    "混老頭": ["ホンロートー", "1・9・字牌だけで作る"],
    "小三元": ["ショーサンゲン", "白・發・中のうち2つを3枚、残り1つを頭にする"],
    "混一色": ["ホンイツ", "1つの色の数牌と字牌だけで作る"],
    "清一色": ["チンイツ", "1つの色の数牌だけで作る"],
    "七対子": ["チートイツ", "同じ牌2枚の組を7つ作る"],
    "海底摸月": ["ハイテイ", "山の最後の牌を引いて和了る"],
    "河底撈魚": ["ホーテイ", "その局の最後の捨て牌でロンする"],
    "嶺上開花": ["リンシャン", "カンして引いた牌で和了る"],
    "槍槓": ["チャンカン", "ほかの人がポンに足した4枚目の牌でロンする"],
    "ドラ": ["ドラ", "ドラ表示牌の次の牌。1枚につき1飜増える（これだけでは和了れない）"],
    "赤ドラ": ["赤", "赤い5。1枚につき1飜増える（これだけでは和了れない）"],
    "裏ドラ": ["裏ドラ", "リーチして和了るとめくれるドラ"],
    "天和": ["テンホー", "親が、配られた手のまま和了る"],
    "地和": ["チーホー", "子が、最初のツモで和了る"],
    "国士無双": ["コクシムソウ", "1・9・字牌の13種類を1枚ずつと、そのどれかをもう1枚"],
    "国士無双十三面": ["コクシ十三面", "国士無双を、13種類のどれでも和了れる形で待つ"],
    "九蓮宝燈": ["チューレンポートー", "1つの色で 1112345678999 と、その色の牌をもう1枚（鳴かない）"],
    "純正九蓮宝燈": ["純正チューレン", "1112345678999 の形で、その色の9種類のどれでも和了れる"],
    "四暗刻": ["スーアンコー", "鳴かずにそろえた同じ牌3枚を4組作る"],
    "四暗刻単騎": ["スーアンコー単騎", "スーアンコーを、頭の1枚待ちで和了る"],
    "大三元": ["ダイサンゲン", "白・發・中をすべて3枚そろえる"],
    "小四喜": ["ショースーシー", "東南西北のうち3つを3枚、残り1つを頭にする"],
    "大四喜": ["ダイスーシー", "東南西北をすべて3枚そろえる"],
    "四槓子": ["スーカンツ", "カンを4回する"],
    "字一色": ["ツーイーソー", "字牌だけで作る"],
    "緑一色": ["リューイーソー", "緑の牌（索子の 2・3・4・6・8 と發）だけで作る"],
    "清老頭": ["チンロートー", "1と9の数牌だけで作る"],
  };
  const yakuInfo = name => YAKU[name] || null;

  // ---------- view から取り出す ----------
  const has = x => x !== null && x !== undefined;
  function ownIds(view) { return has(view.drawn) ? view.hand.concat([view.drawn]) : view.hand.slice(); }
  /** この席から見えている牌の枚数（自分の手・全員の副露・捨て牌・ドラ表示牌）。 */
  function visibleCounts(view) {
    const c = countsOf(ownIds(view));
    for (const ms of view.melds) for (const m of ms) for (const t of m.tiles) c[kindOf(t)]++;
    for (const rv of view.rivers) for (const e of rv) if (!e.called) c[kindOf(e.id)]++;
    for (const t of view.doraInd) c[kindOf(t)]++;
    return c;
  }
  /** 副露を calc.js の形（{type, tile: いちばん小さい牌の種類}）にする。 */
  function calcMelds(ms) {
    return ms.map(m => ({ type: m.type === "kakan" ? "minkan" : m.type, tile: Math.min(...m.tiles.map(kindOf)) }));
  }
  const meldKinds = m => (m.type === "chi" ? [m.tile, m.tile + 1, m.tile + 2] : [m.tile]);
  function ctxOf(view, riichi) {
    return {
      oya: view.seat === view.oya, bakaze: 27 + view.bakaze, jikaze: 27 + (view.seat - view.oya + 4) % 4,
      riichi: riichi || 0, dora: view.doraInd.map(kindOf), ura: null,
    };
  }
  const akaOf = (ids, ms) => ids.filter(isRed).length + ms.reduce((s, m) => s + m.tiles.filter(isRed).length, 0);
  const myRiichi = view => view.riichi[view.seat] || (view.riichiPending === view.seat ? 1 : 0);

  // ---------- 待ちと、その役・点数 ----------
  /** 13枚型の手 c13 に win を足して和了ったときの点数（役が無ければ null）。c13 は書き換えて戻す。 */
  function score(c13, melds, aka, win, tsumo, ctx) {
    c13[win]++;
    const res = MJ.scoreHand({ c: c13, aka, melds, win }, Object.assign({}, ctx, { tsumo }));
    c13[win]--;
    return res && { yaku: res.yaku, han: res.han, fu: res.fu, yakuman: res.yakuman, points: res.points };
  }
  /** 13枚型の手の待ち。聴牌でなければ null。riverKinds: 自分の捨て牌の種類（フリテンを見る）。 */
  function tenpaiInfo(c13, melds, aka, ctx, vis, riverKinds) {
    const nm = melds.length, waits = [];
    for (let k = 0; k < 34; k++) {
      if (c13[k] >= 4) continue;
      c13[k]++;
      const win = MJ.shanten(c13, nm) === -1;
      c13[k]--;
      if (!win) continue;
      waits.push({
        k, left: Math.max(0, 4 - vis[k]),
        ron: score(c13, melds, aka, k, false, ctx), tsumo: score(c13, melds, aka, k, true, ctx),
      });
    }
    if (!waits.length) return null;
    return {
      waits, furiten: waits.some(w => riverKinds.has(w.k)),
      noRon: waits.every(w => !w.ron), noYaku: waits.every(w => !w.ron && !w.tsumo),
    };
  }
  const riverSet = view => new Set(view.rivers[view.seat].map(e => kindOf(e.id)));

  function tenpaiAfter(view, id, riichi) {
    const ids = ownIds(view).filter(t => t !== id);
    if (ids.length % 3 !== 1) return null;
    const ms = view.melds[view.seat];
    const river = riverSet(view);
    river.add(kindOf(id));
    return tenpaiInfo(countsOf(ids), calcMelds(ms), akaOf(ids, ms), ctxOf(view, riichi ? 1 : myRiichi(view)), visibleCounts(view), river);
  }

  // ---------- 狙える役 ----------
  /** 対々和だけを目指したときのシャンテン数（副露 nm 組は刻子・槓子とする）。 */
  function toitoiShanten(c, nm) {
    const need = 4 - nm;
    let best = INF;
    for (let p = -1; p < 34; p++) { // p: 雀頭にする種類（-1 は手に無い牌を2枚引く）
      if (p >= 0 && !c[p]) continue;
      const rest = [];
      for (let i = 0; i < 34; i++) if (i !== p && c[i]) rest.push(Math.min(c[i], 3));
      rest.sort((a, b) => b - a);
      let n = p < 0 ? 2 : 2 - Math.min(c[p], 2);
      for (let i = 0; i < need; i++) n += 3 - (rest[i] || 0);
      if (n < best) best = n;
    }
    return best - 1;
  }
  /** keep(k) が true の牌だけを残した手のシャンテン数と、外した牌の枚数。 */
  function restricted(c, nm, keep) {
    const c2 = c.slice();
    let out = 0;
    for (let i = 0; i < 34; i++) if (c2[i] && !keep(i)) { out += c2[i]; c2[i] = 0; }
    let s = MJ.regularShanten(c2, nm);
    if (nm === 0) s = Math.min(s, MJ.chiitoiShanten(c2));
    return { s, out };
  }
  /**
   * 狙える役。c: 手の中の枚数（13枚型でも14枚型でもよい）、melds: calc.js の形の副露。
   * loose = true のときは枚数の条件を外し、遠回りを1つまで許す（鳴きの警告で「役が残りそうか」を見るのに使う）。
   */
  function chances(c, melds, ctx, vis, loose) {
    const nm = melds.length, base = MJ.shanten(c, nm), out = [];
    const mk = [];
    for (const m of melds) mk.push(...meldKinds(m));
    const near = (s, rule) => s - base <= (loose ? Math.max(1, rule.slack) : rule.slack);

    const names = { 31: "役牌 白", 32: "役牌 發", 33: "役牌 中", [ctx.jikaze]: "役牌:自風牌", [ctx.bakaze]: "役牌:場風牌" };
    for (const y of [...new Set([ctx.bakaze, ctx.jikaze, 31, 32, 33])]) {
      const melded = melds.some(m => m.type !== "chi" && m.tile === y);
      const item = { yaku: names[y], label: "役牌 " + MJ.HONOR_NAMES[y - 27] };
      if (melded || c[y] >= 3) out.push(Object.assign(item, { sure: true }));
      else if (c[y] === 2 && vis[y] < 4) out.push(Object.assign(item, { sure: false }));
    }
    if (mk.every(k => !MJ.isYaochu(k))) {
      const r = restricted(c, nm, k => !MJ.isYaochu(k));
      if (near(r.s, CHANCE.tanyao) && (loose || r.out <= CHANCE.tanyao.maxOut)) out.push({ yaku: "断幺九", label: "タンヤオ", sure: false });
    }
    let flush = null;
    for (let suit = 0; suit < 3 && !flush; suit++) {
      const inSuit = k => k < 27 && ((k / 9) | 0) === suit;
      if (mk.every(inSuit)) {
        const r = restricted(c, nm, inSuit);
        if (near(r.s, CHANCE.chinitsu) && (loose || r.out <= CHANCE.chinitsu.maxOut)) flush = { yaku: "清一色", label: "チンイツ", sure: false };
      }
      if (!flush && mk.every(k => k >= 27 || inSuit(k))) {
        const r = restricted(c, nm, k => k >= 27 || inSuit(k));
        if (near(r.s, CHANCE.honitsu) && (loose || r.out <= CHANCE.honitsu.maxOut)) flush = { yaku: "混一色", label: "ホンイツ", sure: false };
      }
    }
    if (flush) out.push(flush);
    if (melds.every(m => m.type !== "chi")) {
      let groups = nm;
      for (let i = 0; i < 34; i++) if (c[i] >= 2) groups++;
      if (near(toitoiShanten(c, nm), CHANCE.toitoi) && (loose || groups >= CHANCE.toitoi.minGroups)) out.push({ yaku: "対々和", label: "トイトイ", sure: false });
    }
    if (nm === 0) {
      let pairs = 0;
      for (let i = 0; i < 34; i++) if (c[i] >= 2) pairs++;
      if (near(MJ.chiitoiShanten(c), CHANCE.chiitoi) && (loose || pairs >= CHANCE.chiitoi.minPairs)) out.push({ yaku: "七対子", label: "チートイツ", sure: false });
    }
    return out;
  }

  // ---------- 現物・スジ・壁（立直者に対する守りの目安。仕様書 6章⑨） ----------
  const DEF = { genbutsu: 3, suji: 2, kabe: 1 }; // 強い順。立直者が2人以上なら、牌ごとにいちばん弱いものを出す
  /** 立直している他家（宣言牌を切った直後を含む）の席。 */
  const riichiSeats = view => [0, 1, 2, 3].filter(o => o !== view.seat && (view.riichi[o] || view.riichiPending === o));
  /** 立直している他家全員の捨て牌にある種類。立直者がいなければ null。 */
  function safeKinds(view) {
    const seats = riichiSeats(view);
    if (!seats.length) return null;
    const sets = seats.map(o => new Set(view.rivers[o].map(e => kindOf(e.id))));
    const out = [];
    for (let k = 0; k < 34; k++) if (sets.every(s => s.has(k))) out.push(k);
    return out;
  }
  /** 捨て牌の種類 river から見て、牌 k が筋か。1・7 は 4、2・8 は 5、3・9 は 6。4・5・6 は両側がそろったときだけ。字牌は無い。 */
  function isSuji(k, river) {
    if (k >= 27) return false;
    const r = k % 9, base = k - r;
    if (r <= 2) return river.has(base + r + 3);
    if (r >= 6) return river.has(base + r - 3);
    return river.has(base + r - 3) && river.has(base + r + 3);
  }
  /** 牌 k で待つ両面の形（1 なら 23、4 なら 23 と 56）が、どれも自分から4枚とも見えている牌を使うか（ノーチャンス）。vis は見えている枚数。 */
  function isKabe(k, vis) {
    if (k >= 27) return false;
    const r = k % 9, base = k - r;
    const dead = x => vis[base + x] >= 4;
    const shapes = [];
    if (r <= 5) shapes.push([r + 1, r + 2]); // k と k+3 の両面
    if (r >= 3) shapes.push([r - 2, r - 1]); // k−3 と k の両面
    return shapes.every(([a, b]) => dead(a) || dead(b));
  }
  /** 牌の種類ごとの守りの目安（DEF の値。0 は印なし）。立直者がいなければ null。 */
  function defense(view) {
    const seats = riichiSeats(view);
    if (!seats.length) return null;
    const vis = visibleCounts(view);
    const rivers = seats.map(o => new Set(view.rivers[o].map(e => kindOf(e.id))));
    const out = new Array(34).fill(0);
    for (let k = 0; k < 34; k++) {
      const kabe = isKabe(k, vis) ? DEF.kabe : 0;
      out[k] = Math.min(...rivers.map(rv => (rv.has(k) ? DEF.genbutsu : isSuji(k, rv) ? DEF.suji : kabe)));
    }
    return out;
  }

  // ---------- 期待値（仕様書 6章⑬）の計算に渡す入力 ----------
  /**
   * mj_engine.js の evaluateDiscards に渡す {input, exclude}。自分が切る番で、立直していない・和了形でないときだけ（ほかは null）。
   * 見えている牌（vis）は、全員の副露・捨て牌（鳴かれた牌は副露の側で数える）・ドラ表示牌。自分の手牌は入れない（mj_engine.js の数え方）。
   * exclude は喰い替えで切れない牌の種類（選択肢の discards に1枚も無い種類）。
   */
  function evInput(view) {
    const o = view && view.options;
    if (!o || o.kind !== "turn" || view.riichi[view.seat]) return null;
    const seat = view.seat, ids = ownIds(view), ms = view.melds[seat];
    if (ids.length % 3 !== 2 || MJ.shanten(countsOf(ids), ms.length) < 0) return null;
    const spec = id => MJ.tileString(kindOf(id), isRed(id));
    const vis = new Array(34).fill(0), visAka = [0, 0, 0];
    const add = id => { vis[kindOf(id)]++; if (isRed(id)) visAka[(kindOf(id) / 9) | 0]++; };
    for (const msx of view.melds) for (const m of msx) m.tiles.forEach(add);
    for (const rv of view.rivers) for (const e of rv) if (!e.called) add(e.id);
    view.doraInd.forEach(add);
    const can = new Set(o.discards.map(kindOf));
    return {
      input: {
        hand: ids.map(spec),
        melds: ms.map(m => ({
          type: m.type === "kakan" ? "minkan" : m.type, tile: Math.min(...m.tiles.map(kindOf)),
          aka: m.tiles.filter(isRed).length, tiles: m.tiles.map(spec),
        })),
        vis, visAka, dora: view.doraInd.map(kindOf),
        bakaze: 27 + view.bakaze, jikaze: 27 + (seat - view.oya + 4) % 4, oya: seat === view.oya,
        draws: Math.floor(view.liveLeft / 4), haiteiLast: view.liveLeft > 0 && view.liveLeft % 4 === 0,
      },
      exclude: [...new Set(ids.map(kindOf))].filter(k => !can.has(k)),
    };
  }
  /** 打牌の候補の鍵（種類と赤かどうか）。期待値の結果（index・red）と手牌の id を突き合わせるのに使う。 */
  const evKey = (k, red) => k * 2 + (red ? 1 : 0);

  // ---------- まとめ ----------
  function analyze(view) {
    if (!view || !view.hand || view.phase === "roundEnd" || view.phase === "gameEnd") return null;
    const seat = view.seat, ids = ownIds(view), ms = view.melds[seat];
    const melds = calcMelds(ms), nm = melds.length;
    const c = countsOf(ids), vis = visibleCounts(view), river = riverSet(view);
    const ctx = ctxOf(view, myRiichi(view));
    const turn = ids.length % 3 === 2;
    const out = { turn, shanten: MJ.shanten(c, nm), discards: null, now: null, chances: chances(c, melds, ctx, vis, false), defense: defense(view) };

    if (turn) {
      const allowed = view.options && view.options.kind === "turn" ? view.options.discards : ids;
      const memo = new Map(); // 同じ種類・同じ赤かどうかの牌は1回だけ調べる
      const list = [];
      out.discards = new Map();
      for (const id of allowed) {
        const k = kindOf(id), key = k * 2 + (isRed(id) ? 1 : 0);
        if (!memo.has(key)) {
          c[k]--;
          const s = MJ.shanten(c, nm);
          const uke = [];
          let total = 0;
          for (let j = 0; j < 34; j++) {
            if (c[j] >= 4) continue;
            c[j]++;
            const better = MJ.shanten(c, nm) < s;
            c[j]--;
            if (!better) continue;
            const left = Math.max(0, 4 - vis[j]);
            uke.push({ k: j, left });
            total += left;
          }
          let tenpai = null;
          if (s === 0) {
            const rv = new Set(river);
            rv.add(k);
            tenpai = tenpaiInfo(c, melds, akaOf(ids, ms) - (isRed(id) ? 1 : 0), ctx, vis, rv);
          }
          c[k]++;
          const info = { k, red: isRed(id), shanten: s, uke, total, keep: false, mark: false, best: false, tenpai };
          memo.set(key, info);
          list.push(info);
        }
        out.discards.set(id, memo.get(key));
      }
      if (list.length) {
        const min = Math.min(...list.map(x => x.shanten));
        const keep = list.filter(x => x.shanten === min);
        const top = Math.max(...keep.map(x => x.total));
        for (const x of keep) x.keep = true;
        // 印を付けるのは MARK_MAX 種類まで: 進む牌の枚数が多い順。同じ枚数なら、手に残す値打ちの低い牌（字牌・端・ドラでない）を先に
        const doraKinds = ctx.dora.map(MJ.doraOf);
        const worth = x => {
          let w = x.k >= 27 ? (x.k >= 31 || x.k === ctx.bakaze || x.k === ctx.jikaze ? 0.4 : 0) : [0.3, 0.6, 1, 1, 1, 1, 1, 0.6, 0.3][x.k % 9];
          if (doraKinds.includes(x.k)) w += 3;
          if (x.red) w += 3;
          return w;
        };
        const ranked = keep.slice().sort((a, b) => b.total - a.total || worth(a) - worth(b) || a.k - b.k);
        const marked = [], kinds = new Set();
        for (const x of ranked) {
          if (!kinds.has(x.k) && kinds.size >= MARK_MAX) continue;
          kinds.add(x.k);
          marked.push(x);
        }
        for (const x of marked) { x.mark = true; x.best = x.total === top && top > 0; }
        out.shanten = min;
      }
    }
    // いまの13枚型の手の待ち（切る番でツモ牌があるときは、ツモ牌を除いた手）
    const base = !turn ? ids : has(view.drawn) ? view.hand : null;
    if (base) {
      const info = tenpaiInfo(countsOf(base), melds, akaOf(base, ms), ctx, vis, river);
      if (info) { info.furiten = !!view.furiten; out.now = info; }
    }
    return out;
  }

  // ---------- 鳴きの前に見ること ----------
  /**
   * 鳴いたあとの手（c: 手の中、melds: 鳴いた分を含む副露）に、役の付く和了り方が残るか。
   * type14: ポン・チーのあと（3n+2 枚で、1枚切る）か。大明槓のあとは 3n+1 枚。
   * 1シャンテン以内なら、進む牌を引く → 切る → 待つ、を全部たどって確かめる（exact）。それより遠いときは chances の目安で見る。
   */
  function yakuAfter(c, melds, ctx, vis, type14) {
    const nm = melds.length;
    // 和了り方 = 最後の聴牌の形 × 和了牌 × ロン・ツモ。ways はその数、seen は役ごとの「その役が付く和了り方」の数
    const seen = new Map(), done = new Set();
    let ways = 0, ok = false;
    const sc = (c13, k, tsumo) => {
      c13[k]++;
      const r = MJ.scoreHand({ c: c13, aka: 0, melds, win: k }, Object.assign({}, ctx, { tsumo }));
      c13[k]--;
      return r;
    };
    const tenpai13 = c13 => {
      const key = c13.join("");
      if (done.has(key)) return; // 同じ聴牌の形は1回だけ数える（切る・引くの順が違っても同じ形に着く）
      done.add(key);
      for (let k = 0; k < 34; k++) {
        if (c13[k] >= 4) continue;
        c13[k]++;
        const win = MJ.shanten(c13, nm) === -1;
        c13[k]--;
        if (!win) continue;
        for (const tsumo of [false, true]) {
          ways++;
          const r = sc(c13, k, tsumo);
          if (!r) continue;
          ok = true;
          for (const y of r.yaku) if (y[1] > 0 && !NOT_YAKU.has(y[0])) seen.set(y[0], (seen.get(y[0]) || 0) + 1);
        }
      }
    };
    const from13 = c13 => { // 1シャンテンの13枚型
      for (let u = 0; u < 34; u++) {
        if (c13[u] >= 4 || vis[u] >= 4) continue;
        c13[u]++;
        if (MJ.shanten(c13, nm) === 0) from14(c13, 0);
        c13[u]--;
      }
    };
    function from14(c14, s) { // 切ったあとのいちばん良いシャンテン数が s（0 か 1）の14枚型
      for (let d = 0; d < 34; d++) {
        if (!c14[d]) continue;
        c14[d]--;
        if (MJ.shanten(c14, nm) === s) (s === 0 ? tenpai13 : from13)(c14);
        c14[d]++;
      }
    }
    const s = Math.max(0, MJ.shanten(c, nm));
    if (s <= 1) {
      if (type14) from14(c, s); else if (s === 0) tenpai13(c); else from13(c);
      const order = Object.keys(YAKU);
      const yaku = [...seen].map(([name, n]) => ({ yaku: name, label: yakuLabel(name, ctx), sure: n === ways }))
        .sort((a, b) => (b.sure ? 1 : 0) - (a.sure ? 1 : 0) || order.indexOf(a.yaku) - order.indexOf(b.yaku));
      return { exact: true, ok, yaku: yaku.filter((y, i) => yaku.findIndex(z => z.label === y.label) === i) };
    }
    // 遠い手: 警告（役が残りそうか）は条件をゆるめた目安、出す役の名前は「狙える役」と同じ条件（ゆるめた目安の名前は外れやすいので出さない）
    return { exact: false, ok: chances(c, melds, ctx, vis, true).length > 0, yaku: chances(c, melds, ctx, vis, false) };
  }
  const NOT_YAKU = new Set(["ドラ", "赤ドラ", "裏ドラ"]); // 飜は増えるが、役ではないもの
  /** 役の名前（calc.js）→ 画面に出す名前。風の役牌は牌の名前で出す（「狙える役」の札と同じ）。 */
  function yakuLabel(name, ctx) {
    if (name === "役牌:場風牌") return "役牌 " + MJ.HONOR_NAMES[ctx.bakaze - 27];
    if (name === "役牌:自風牌") return "役牌 " + MJ.HONOR_NAMES[ctx.jikaze - 27];
    return YAKU[name] ? YAKU[name][0] : name;
  }
  /**
   * 鳴き方の候補（callInfo の pon・chi の配列、kan は1つだけの配列）をまとめて、その種類の鳴きで狙える役にする。
   * どれかの鳴き方で残る役を全部出し、sure は「どの鳴き方でも、どう和了っても付く」ときだけ。
   */
  function callYaku(list) {
    const out = [];
    for (const c of list) for (const y of c.yaku) if (!out.some(z => z.label === y.label)) out.push({ yaku: y.yaku, label: y.label, sure: false });
    for (const y of out) y.sure = list.every(c => c.yaku.some(z => z.label === y.label && z.sure));
    return out.sort((a, b) => (b.sure ? 1 : 0) - (a.sure ? 1 : 0));
  }

  function callInfo(view) {
    const o = view && view.options;
    if (!o || o.kind !== "call" || !(o.pon.length || o.chi.length || o.kan)) return null;
    const seat = view.seat, hand = view.hand, ms = view.melds[seat];
    const melds = calcMelds(ms), nm = melds.length;
    const c = countsOf(hand), s0 = MJ.shanten(c, nm), k = kindOf(o.tile);
    const vis = visibleCounts(view), ctx = ctxOf(view, 0);
    const one = (type, own) => {
      const c2 = c.slice();
      for (const t of own) c2[kindOf(t)]--;
      const m2 = melds.concat([{ type, tile: Math.min(k, ...own.map(kindOf)) }]);
      const y = yakuAfter(c2, m2, ctx, vis, type !== "minkan");
      return { own, advances: MJ.shanten(c2, nm + 1) < s0, noYaku: !y.ok, exact: y.exact, yaku: y.yaku };
    };
    return {
      loseRiichi: ms.every(m => m.type === "ankan"),
      pon: o.pon.map(own => one("pon", own)),
      chi: o.chi.map(own => one("chi", own)),
      kan: o.kan ? one("minkan", hand.filter(t => kindOf(t) === k)) : null,
    };
  }

  return { analyze, tenpaiAfter, callInfo, callYaku, chances, toitoiShanten, visibleCounts, safeKinds, defense, isSuji, isKabe, DEF, evInput, evKey, yakuInfo, YAKU, CHANCE };
});
