/*
 * ui.js — 画面。配られた情報（table.js の packet）だけで自分の席を描き、行動を送り返す。
 *   1人用・部屋主: このブラウザの中に卓の進行役（table.js）を持つ。部屋主は、ほかの人の席の packet を中継所（net.js）へ送る。
 *   参加者: 進行役を持たない。部屋主から届いた packet を描き、行動を中継所へ送る。
 * 盤面（#board）は状態が変わるたびに全部描き直す。発声（#bubbles）は別の層に足して自分で消える。
 */
(function () {
  "use strict";
  const { kindOf, isRed } = Mahjong;
  const WIND = ["東", "南", "西", "北"];
  const NUM_FILES = ["Man", "Pin", "Sou"];
  const HONOR_FILES = ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"];

  const $ = s => document.querySelector(s);
  const PARAMS = new URLSearchParams(location.search);
  const FAST = PARAMS.has("fast"); // 確かめ用: 待ち時間を 1/20 にする
  const speed = ms => (FAST ? ms / 20 : ms);
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const clone = o => JSON.parse(JSON.stringify(o)); // 自分の席にも、通信で届くのと同じ形（JSON を通した値）で渡す

  // ---------- 牌の絵 ----------
  function srcOf(kind, red) {
    if (kind >= 27) return `tiles/${HONOR_FILES[kind - 27]}.svg`;
    return `tiles/${NUM_FILES[(kind / 9) | 0]}${kind % 9 + 1}${red ? "-Dora" : ""}.svg`;
  }
  /** inner: 牌の面の外に重ねる印（手牌の下の「現物」の札など）。 */
  function tileBy(kind, red, cls, attr, inner) {
    return `<div class="tile ${cls || ""}" data-k="${kind}" ${attr || ""}><div class="face"><img src="${srcOf(kind, red)}" alt="" draggable="false"></div>${inner || ""}</div>`;
  }
  const tile = (id, cls, attr, inner) => tileBy(kindOf(id), isRed(id), cls, attr, inner);
  const specTile = (spec, cls, attr) => tileBy(MJ.tileIndex(spec), MJ.isRed(spec), cls, attr);
  const back = cls => `<div class="tile back ${cls || ""}"><div class="face"></div></div>`;

  // ---------- 設定（ブラウザに覚えておく） ----------
  const AS = PARAMS.has("as") ? "-" + PARAMS.get("as") : ""; // 確かめ用: 1つのブラウザで何人分も開くとき、覚える場所を人ごとに分ける
  const STORE = "settai-mahjong-v1" + AS;
  const NAME_MAX = 12;
  const cleanName = (s, fallback) => (typeof s === "string" ? s.trim().slice(0, NAME_MAX) : "") || fallback;

  // アシストの入・切（仕様書 6章 A2）。部屋主（1人用は自分）が席ごとに4つのまとまりを入・切する。参加者は部屋主から届いた値を使い、自分では変えない。
  //   cut 切る牌のヒント（進む牌の印・切る牌に触れたときの帯・期待値）　hand 手の状態（シャンテン数・待ち・役と点数・役なし・狙える役）
  //   guard 守りと鳴き（現物・スジ・壁の印・鳴く前の知らせ・鳴くと進む印）　aux 補助ボタン（自動和了・ツモ切り・鳴かない）
  //   ここに無いもの（同じ牌を光らせる・結果の役の説明・フリテンの札・ドラの光・点差・立直後の自動ツモ切り・鳴く牌の強調）は、いつも全員に働く。
  const ASSIST_GROUPS = [["cut", "切る牌のヒント"], ["hand", "手の状態"], ["guard", "守りと鳴き"], ["aux", "補助ボタン"]];
  /** どんな入力でも {cut, hand, guard, aux} の形にそろえる（false と書いてあるものだけ切。ほかは入）。 */
  function cleanAssist(o) {
    const out = {};
    for (const [k] of ASSIST_GROUPS) out[k] = !(o && typeof o === "object" && o[k] === false);
    return out;
  }
  function loadSettings() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE));
      if (o) {
        const seats = [0, 1, 2, 3].map(s => cleanAssist(Array.isArray(o.assistSeats) ? o.assistSeats[s] : null));
        if (!Array.isArray(o.assistSeats) && o.assist === false) for (const [k] of ASSIST_GROUPS) seats[0][k] = false; // 前の版の「アシストを使う」が切
        return { length: o.length === "east" ? "east" : "south", rig: Rig.normalize(o.rig), name: cleanName(o.name, ""), assistSeats: seats, cpu: Cpu.LEVELS.includes(o.cpu) ? o.cpu : "normal" };
      }
    } catch (e) { /* 読めなければ既定 */ }
    return { length: "south", rig: Rig.defaultConfig(), name: "", assistSeats: [0, 1, 2, 3].map(() => cleanAssist(null)), cpu: "normal" };
  }
  function saveSettings() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* 保存できなくても続ける */ }
  }
  const settings = loadSettings();

  // 戦績とレート（仕様書 6.6章）。部屋主のブラウザに全員分を名前で記録する（計算は stats.js）
  const STATS_STORE = "settai-mahjong-stats" + AS;
  function loadStats() {
    try { return Stats.normalize(JSON.parse(localStorage.getItem(STATS_STORE))); } catch (e) { return Stats.normalize(null); }
  }
  function saveStats() {
    try { localStorage.setItem(STATS_STORE, JSON.stringify(stats)); } catch (e) { /* 保存できなくても続ける */ }
  }
  let stats = loadStats();
  let lastRated = null; // 部屋主: いちばん最後に数えた対局 {gid, rows: [{seat, name, before, after}]}

  // ---------- 牌操作の設定パネル ----------
  const SEAT_LABEL = ["あなた", "下家", "対面", "上家"];
  const LUCK_LABEL = { "-2": "悪い", "-1": "少し悪い", "0": "ふつう", "1": "少し良い", "2": "良い", "3": "とても良い" };
  const SHANTEN_LABEL = { "0": "テンパイ", "1": "1シャンテン", "2": "2シャンテン", "3": "3シャンテン" };
  const THEME_LABEL = { none: "なし", tanyao: "タンヤオ", honitsu: "ホンイツ", chinitsu: "チンイツ", toitoi: "トイトイ", yakuhai: "役牌" };
  const SUIT_LABEL = { auto: "色おまかせ", m: "萬子", p: "筒子", s: "索子" };
  const FIELD_MAX = { hand: 13, draws: 18 };
  const PALETTE = ["m", "p", "s"].map(s => {
    const out = [];
    for (let n = 1; n <= 9; n++) { out.push(`${n}${s}`); if (n === 5) out.push(`5${s}r`); }
    return out;
  }).concat([MJ.HONORS.slice()]);
  // 牌を選ぶ板の「まとめて入れる」ボタン（押すと、その仲間の牌を1枚ずつ、入るだけ入れる）
  const BULK = [
    ["萬子", [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => n + "m")],
    ["筒子", [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => n + "p")],
    ["索子", [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => n + "s")],
    ["字牌", MJ.HONORS.slice()],
    ["19牌", ["1m", "9m", "1p", "9p", "1s", "9s"]],
  ];

  /** root の中に設定パネルを作る。変えるたびに保存して onChange を呼ぶ。 */
  function mountRig(root, onChange) {
    let active = null; // 牌を足す先 {seat, field}
    let rates = false; // 和了率の目安の小窓を開いているか
    // いま足せる牌か（足す先の枚数の上限と、全席を合わせた同じ牌の枚数）
    const addable = sp => !!active && settings.rig.seats[active.seat][active.field].length < FIELD_MAX[active.field] && Rig.canAdd(settings.rig, sp);
    function draw() {
      const cfg = settings.rig;
      const seatHtml = (c, s) => {
        const row = (field, label) => {
          const on = active && active.seat === s && active.field === field;
          const list = c[field];
          return `<div class="row tiles-row ${on ? "on" : ""}" data-field="${field}">
            <span class="lab">${label}</span>
            <div class="chosen">${list.length ? list.map((sp, i) => specTile(sp, "", `data-i="${i}"`)).join("") : '<span class="none">指定なし</span>'}</div>
            ${list.length ? `<button type="button" class="clr" data-clear="${field}">消す</button>` : ""}
            ${field === "hand" ? `<select data-k="shanten"><option value="">近さおまかせ</option>${Rig.SHANTENS.map(n =>
              `<option value="${n}" ${c.shanten === n ? "selected" : ""}>${SHANTEN_LABEL[n]}</option>`).join("")}</select>` : ""}
          </div>`;
        };
        const needSuit = c.theme === "honitsu" || c.theme === "chinitsu";
        const who = s > 0 ? guestNameAt(s) : null; // 部屋にいる人の名前（その席に人がいるとき）
        return `<section class="rig-seat ${active && active.seat === s ? "active" : ""}" data-seat="${s}">
          <h3>${SEAT_LABEL[s]}${who ? `<span class="who">${esc(who)}</span>` : ""}</h3>
          <div class="row"><span class="lab">運</span><div class="seg luck">${Rig.LUCKS.map(l =>
            `<button type="button" data-luck="${l}" class="${c.luck === l ? "on" : ""}">${LUCK_LABEL[l]}</button>`).join("")}</div></div>
          <div class="row"><span class="lab">役</span>
            <select data-k="theme">${Rig.THEMES.map(t => `<option value="${t}" ${c.theme === t ? "selected" : ""}>${THEME_LABEL[t]}</option>`).join("")}</select>
            ${needSuit ? `<select data-k="suit">${Rig.SUITS.map(t => `<option value="${t}" ${c.suit === t ? "selected" : ""}>${SUIT_LABEL[t]}</option>`).join("")}</select>` : ""}
            <label class="chk"><input type="checkbox" data-k="guard" ${c.guard ? "checked" : ""}>放銃しにくく</label>
          </div>
          ${row("hand", "配牌")}
          ${row("draws", "ツモ")}
        </section>`;
      };
      root.innerHTML = `<div class="rig ${cfg.enabled ? "" : "off"}">
        <div class="rig-head">
          <span class="ttl">牌操作</span>
          <label class="chk"><input type="checkbox" data-g="enabled" ${cfg.enabled ? "checked" : ""}>使う</label>
          <label class="chk"><input type="checkbox" data-g="showToAll" ${cfg.showToAll ? "checked" : ""}>ほかの参加者にも見せる</label>
          <button type="button" class="pill rates-btn ${rates ? "on" : ""}" data-rates="toggle">和了率</button>
          ${rates ? `<div class="rates">
            <div class="rates-head"><span>運ごとの和了率</span><button type="button" class="clr" data-rates="close">閉じる</button></div>
            <table>${Rig.LUCKS.map(l => `<tr><th>${LUCK_LABEL[l]}</th><td><i style="width:${Rig.LUCK_RATE[l] * 2}%"></i></td><td>${Rig.LUCK_RATE[l]}%</td></tr>`).join("")}</table>
            <div class="rates-note">1局あたり・CPU が打った場合の目安</div>
          </div>` : ""}
        </div>
        <div class="rig-seats">${cfg.seats.map(seatHtml).join("")}</div>
        ${active ? `<div class="palette">
          <div class="bulk">${BULK.map((b, i) => `<button type="button" class="pill" data-bulk="${i}">${b[0]}</button>`).join("")}</div>
          ${PALETTE.map(g => `<div class="grp">${g.map(sp => specTile(sp, addable(sp) ? "" : "used", `data-spec="${sp}"`)).join("")}</div>`).join("")}</div>` : ""}
      </div>`;
    }
    function changed() { saveSettings(); if (onChange) onChange(); draw(); }
    root.addEventListener("click", e => {
      const cfg = settings.rig;
      const rt = e.target.closest("[data-rates]");
      if (rt) { rates = rt.dataset.rates === "toggle" ? !rates : false; return draw(); }
      const bulk = e.target.closest(".palette [data-bulk]");
      if (bulk && active) {
        // 仲間の牌を1枚ずつ、入るだけ入れる（枚数の上限・同じ牌4枚までを超える分は入れない）
        let added = 0;
        for (const sp of BULK[+bulk.dataset.bulk][1]) if (addable(sp)) { cfg.seats[active.seat][active.field].push(sp); added++; }
        if (added) changed();
        return;
      }
      const pal = e.target.closest(".palette [data-spec]");
      if (pal && active) {
        if (addable(pal.dataset.spec)) { cfg.seats[active.seat][active.field].push(pal.dataset.spec); changed(); }
        return;
      }
      const seatEl = e.target.closest(".rig-seat");
      if (!seatEl) return;
      const s = +seatEl.dataset.seat, c = cfg.seats[s];
      const luck = e.target.closest("[data-luck]");
      if (luck) { c.luck = +luck.dataset.luck; return changed(); }
      const clr = e.target.closest("[data-clear]");
      if (clr) { c[clr.dataset.clear] = []; return changed(); }
      const rowEl = e.target.closest(".tiles-row");
      if (!rowEl || e.target.closest("select")) return; // 行の中の選択欄（配牌の近さ）は、牌を選ぶ板を開け閉めしない
      const field = rowEl.dataset.field;
      const chosen = e.target.closest(".chosen [data-i]");
      if (chosen) { c[field].splice(+chosen.dataset.i, 1); active = { seat: s, field }; return changed(); }
      active = active && active.seat === s && active.field === field ? null : { seat: s, field };
      draw();
    });
    root.addEventListener("change", e => {
      const cfg = settings.rig, el = e.target;
      if (el.dataset.g) { cfg[el.dataset.g] = el.checked; return changed(); }
      const seatEl = el.closest(".rig-seat");
      if (!seatEl || !el.dataset.k) return;
      const c = cfg.seats[+seatEl.dataset.seat];
      if (el.dataset.k === "shanten") c.shanten = el.value === "" ? null : +el.value;
      else c[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
      changed();
    });
    draw();
    return { draw };
  }

  // ---------- 対局の画面（配られた packet を描く） ----------
  let mode = "solo"; // solo（1人用）| host（部屋主）| guest（参加者）
  let table = null; // 卓の進行役（solo・host だけ）
  let port = null; // 自分の行動の送り先。null のときは対局の画面を出していない
  let pkt = null, v = null; // 最後に届いた packet と、その view
  let ME = 0; // 自分の席
  let session = 0; // 対局の画面を出し直すたびに増やす（古い待ちを止める）
  let lastAsk = -1, sentAsk = -1; // 最後に見た問い・答えを送った問い
  let shownRound = -1, confirmedRound = -1, resultRound = -1; // 結果を出した局・「次へ」を押した局・いま結果を出している局
  let finalShown = false;
  let uiMode = "normal"; // normal | riichi（立直で切る牌を選ぶ）| choose（鳴き方・槓する牌を選ぶ）
  let choices = [];
  let selected = null; // タッチで1回目に選んだ牌
  let showDiff = false; // 他家の点数の札に、自分との点差を出しているか（中央の四角を押すたびに切り替える）
  // アシスト（仕様書 6章）。計算は assist.js が、届いた view だけから行う
  let guestAssist = cleanAssist(null); // 参加者: 部屋主から届いた自分の席の入・切
  const myAssist = () => (mode === "guest" ? guestAssist : settings.assistSeats[0]); // 部屋主・1人用の自分は席0
  let asst = null, callAsst = null; // いまの packet の計算結果（手の分・鳴きの問いの分）。使うまとまりが無いときは null（callAsst は guard が切でも null）
  let hoverId = null, hoverKind = null; // マウスが乗っている自分の手牌の id と、乗っている牌の種類（手牌以外も）
  let focusWait = null; // 役と点数を出している待ち牌の種類
  const riichiMemo = new Map(); // 立直して切ったときの待ち（切る牌の id ごと。packet が変わったら捨てる）
  const auto = { win: false, tsumogiri: false, noCall: false }; // 補助ボタン。局が始まるたびに切へ戻す
  const DEF_CLS = ["", "kabe", "suji", "gen"], DEF_LABEL = ["", "壁", "スジ", "現物"]; // 手牌の下の守りの印（Assist.DEF の値ごと）
  // 期待値（仕様書 6章⑬）。自分が切る番ごとに、裏の Worker（ev-worker.js）で計算する
  const EV_MAX_SHANTEN = 3; // これより遠い手は計算しない（計算が終わらないことが多い）
  let ev = null; // いまの問いの期待値 {id, ask, session, done, map: Map<Assist.evKey, {ev, win, choice}> | null, top: Set<Assist.evKey> | null}
  let evWorker = null, evBusy = false, evSeq = 0;

  const board = $("#board"), bubbles = $("#bubbles");
  const posOf = seat => (seat - ME + 4) % 4;
  const canInput = () => !!(v && v.options && sentAsk !== pkt.ask);

  function bubble(seat, text, cls) {
    const el = document.createElement("div");
    el.className = `bubble ${seat < 0 ? "pc" : "p" + posOf(seat)} ${cls || ""}`;
    el.textContent = text;
    bubbles.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
  function ryukyokuName(r) {
    if (r.reason === "exhaustive") return r.nagashi.length ? "流し満貫" : "流局";
    return { kyushu: "九種九牌", suufon: "四風連打", suukan: "四槓散了", suucha: "四家立直" }[r.reason];
  }
  const roundName = o => `${WIND[o.bakaze]}${o.kyoku + 1}局`;

  /** 対局の画面を出して、packet を受け取れるようにする。send: 自分の行動の送り先。 */
  function openGame(send) {
    session++;
    port = send;
    pkt = v = null;
    lastAsk = sentAsk = -1;
    shownRound = confirmedRound = resultRound = -1;
    finalShown = false;
    uiMode = "normal"; choices = []; selected = null; showDiff = false;
    asst = callAsst = null; hoverId = hoverKind = focusWait = null;
    ev = null;
    auto.win = auto.tsumogiri = auto.noCall = false;
    drawAux();
    bubbles.innerHTML = "";
    board.innerHTML = '<div class="felt"></div>';
    hideOverlay();
    $("#rigModal").classList.add("hidden");
    $("#assistModal").classList.add("hidden");
    $("#rigBtn").classList.toggle("hidden", mode === "guest");
    $("#rigBadge").classList.add("hidden");
    $("#home").classList.add("hidden");
    $("#game").classList.remove("hidden");
  }
  function closeGame() {
    session++;
    port = null;
    hideOverlay();
    $("#rigModal").classList.add("hidden");
    $("#assistModal").classList.add("hidden");
    $("#game").classList.add("hidden");
    $("#home").classList.remove("hidden");
  }
  /** packet が1つ届いた。 */
  function receive(p) {
    if (!port) return;
    const CALL = { chi: "チー", pon: "ポン", minkan: "カン", ankan: "カン", kakan: "カン" };
    pkt = p; v = p.view; ME = v.seat;
    if (p.retry) sentAsk = -1;
    if (p.ask !== lastAsk || !v.options) { lastAsk = p.ask; uiMode = "normal"; selected = null; choices = []; }
    refreshAssist();
    let ended = false;
    for (const e of p.events) {
      if (e.t === "start") {
        bubble(-1, roundName(e) + (e.honba ? ` ${e.honba}本場` : ""), "round");
        auto.win = auto.tsumogiri = auto.noCall = false;
        drawAux();
      } else if (e.t === "call") bubble(e.seat, CALL[e.type]);
      else if (e.t === "discard" && e.riichi) bubble(e.seat, "リーチ");
      else if (e.t === "roundEnd" && v.result) {
        ended = true;
        if (v.result.type === "win") for (const w of v.result.wins) bubble(w.seat, w.tsumo ? "ツモ" : "ロン", "win");
        else bubble(-1, ryukyokuName(v.result), "round");
      }
    }
    render();
    const atEnd = v.phase === "roundEnd";
    if (resultRound !== -1 && !(atEnd && p.round === resultRound)) { resultRound = -1; hideOverlay(); }
    if (atEnd && p.needNext) {
      if (confirmedRound === p.round) port({ t: "next" }); // 押したのに届いていなかった（通信が切れていた）
      else if (shownRound !== p.round) {
        shownRound = p.round;
        const my = session, round = p.round;
        setTimeout(() => { if (my === session && pkt.round === round && v.phase === "roundEnd") showResult(round); }, ended ? speed(1100) : 0);
      }
    }
    if (v.phase === "gameEnd" && !finalShown) { finalShown = true; showFinal(); }
    autoAct();
  }

  // ---------- 盤面を描く ----------
  function render() {
    if (!v || !v.hand) { board.innerHTML = '<div class="felt"></div>'; return; }
    // マウスが乗っていた手牌が無くなっていたら（切った・鳴いた）、乗っていない扱いに戻す
    if (hoverId !== null && !v.hand.includes(hoverId) && v.drawn !== hoverId) hoverId = hoverKind = null;
    const dora = v.doraInd.map(t => MJ.doraOf(kindOf(t)));
    let h = '<div class="felt"></div>' + centerHtml();
    for (let pos = 0; pos < 4; pos++) h += seatHtml((ME + pos) % 4, pos, dora);
    h += `<div class="assist">${assistInner()}</div>` + callNoteHtml() + actionsHtml();
    // くり返す動き（ドラの光など）を、作り直しても続きから動かす（style.css の --sync）
    board.style.setProperty("--sync", `${-Math.round(performance.now())}ms`);
    board.innerHTML = h;
    applySame();
    $("#rigBadge").classList.toggle("hidden", !pkt.rigShown);
  }
  function centerHtml() {
    const doraTiles = [];
    for (let i = 0; i < 5; i++) doraTiles.push(i < v.doraInd.length ? tile(v.doraInd[i]) : back());
    return `<div class="center"><div class="core">
      <div class="round">${roundName(v)}</div>
      <div class="sub">${v.honba}本場　供託 ${v.kyotaku}</div>
      <div class="dora">${doraTiles.join("")}</div>
      <div class="sub">残り ${v.liveLeft}</div>
    </div></div>`;
  }
  const isDora = (id, dora) => dora.includes(kindOf(id)) || isRed(id);
  function riverHtml(seat, dora) {
    const rv = v.rivers[seat], cells = [];
    let side = false;
    // 鳴き（ポン・チー・カン・ロン）を聞かれている間、その捨て牌を強調する（仕様書 6章⑭。槍槓の牌は河に無い）
    const o = canInput() && v.options.kind === "call" && !v.options.chankan && v.options.from === seat ? v.options : null;
    rv.forEach((e, i) => {
      if (e.riichi) side = true; // 宣言牌が鳴かれたら、次の牌を横にする
      if (e.called) return;
      const last = v.last && v.last.type === "discard" && v.last.seat === seat && i === rv.length - 1 && v.phase !== "roundEnd";
      const ask = !!o && e.id === o.tile && i === rv.length - 1;
      cells.push(tile(e.id, (side ? "side " : "") + (last ? "last " : "") + (ask ? "ask " : "") + (e.tsumogiri ? "tg " : "") + (isDora(e.id, dora) ? "dora" : ""),
        "", ask ? '<i class="ask-mk"></i>' : ""));
      side = false;
    });
    const rows = [cells.slice(0, 6), cells.slice(6, 12), cells.slice(12)];
    return `<div class="river">${rows.map(r => `<div class="row">${r.join("")}</div>`).join("")}</div>`;
  }
  function meldHtml(m, seat, cls) {
    if (m.type === "ankan") {
      const t = m.tiles.slice().sort((a, b) => (isRed(b) ? 1 : 0) - (isRed(a) ? 1 : 0));
      return `<div class="meld ${cls || ""}">${back()}${tile(t[0])}${tile(t[1])}${back()}</div>`;
    }
    const rel = (m.from - seat + 4) % 4; // 3 = 上家（左）・2 = 対面・1 = 下家（右）
    const own = m.tiles.filter(t => t !== m.called && t !== m.added);
    const calledHtml = m.type === "kakan"
      ? `<div class="stack">${tile(m.added, "side")}${tile(m.called, "side")}</div>` : tile(m.called, "side");
    const parts = own.map(t => tile(t));
    parts.splice(rel === 3 ? 0 : rel === 2 ? 1 : own.length, 0, calledHtml);
    return `<div class="meld ${cls || ""}">${parts.join("")}</div>`;
  }
  function seatHtml(seat, pos, dora) {
    let hand;
    if (pos === 0) {
      const o = canInput() && v.options.kind === "turn" ? v.options : null;
      const can = o ? new Set(uiMode === "riichi" ? o.riichi : uiMode === "choose" ? [] : o.discards) : null;
      const a = myAssist();
      const def = a.guard && asst && asst.defense ? asst.defense : null; // 現物・スジ・壁（立直者がいるときだけ）
      const top = a.cut && can && ev && ev.top ? ev.top : null; // 期待値がいちばん高い牌（同じ値は全部）
      const isTop = id => !!top && can.has(id) && top.has(Assist.evKey(kindOf(id), isRed(id)));
      const cls = id => {
        const d = a.cut && can && can.has(id) && asst && asst.discards ? asst.discards.get(id) : null; // 切れる牌にだけ、進む印を付ける
        return [
          can ? (can.has(id) ? "can" : "dim") : "",
          selected === id ? "sel" : "",
          isDora(id, dora) ? "dora" : "",
          d && d.mark ? "keep" : "", d && d.best ? "best" : "",
          isTop(id) ? "evtop" : "",
        ].join(" ");
      };
      const marks = id => {
        const lv = def ? def[kindOf(id)] : 0;
        return (lv ? `<i class="def ${DEF_CLS[lv]}">${DEF_LABEL[lv]}</i>` : "") + (isTop(id) ? '<i class="ev-mk"></i>' : "");
      };
      hand = v.hand.map(id => tile(id, cls(id), `data-id="${id}"`, marks(id))).join("");
      if (v.drawn !== null) hand += tile(v.drawn, "drawn " + cls(v.drawn), `data-id="${v.drawn}"`, marks(v.drawn));
    } else {
      const n = v.handCounts[seat];
      const hasDraw = v.turn === seat && v.hasDrawn && n % 3 === 2;
      hand = back().repeat(n - (hasDraw ? 1 : 0)) + (hasDraw ? back("drawn") : "");
    }
    const wind = WIND[(seat - v.oya + 4) % 4];
    const turn = v.phase === "turn" && v.turn === seat;
    // 点差の表示中は、他家の札に「その人の点数 − 自分の点数」を出す
    const d = v.scores[seat] - v.scores[ME];
    const score = showDiff && pos !== 0
      ? `<span class="score diff ${d > 0 ? "plus" : d < 0 ? "minus" : ""}">${d > 0 ? "+" + d : d < 0 ? d : "±0"}</span>`
      : `<span class="score">${v.scores[seat]}</span>`;
    return `<div class="seat pos${pos}">
      ${riverHtml(seat, dora)}
      <div class="plate ${seat === v.oya ? "oya" : ""} ${turn ? "turn" : ""}"><span class="wind">${wind}</span>${score}</div>
      ${v.riichi[seat] ? '<div class="stick"></div>' : ""}
      <div class="hand">${hand}</div>
      <div class="melds">${v.melds[seat].map(m => meldHtml(m, seat)).join("")}</div>
      ${pos !== 0 && mode !== "solo" ? `<div class="pname"><span>${esc(v.names[seat])}</span></div>` : ""}
    </div>`;
  }

  // ---------- アシストの表示（手牌の上の帯・鳴きの前の知らせ） ----------
  function refreshAssist() {
    asst = callAsst = null;
    riichiMemo.clear();
    const a = myAssist();
    if (!v || !(a.cut || a.hand || a.guard)) return;
    // アシストの計算でつまずいても、対局は止めない（表示だけを出さない）
    try { asst = Assist.analyze(v); if (a.guard) callAsst = Assist.callInfo(v); } catch (e) { console.error(e); asst = callAsst = null; }
    requestEv();
  }

  // ---------- 期待値（裏の Worker で計算する。仕様書 6章⑬） ----------
  /** いまの問いの期待値を頼む（同じ問いで頼み済みなら何もしない）。切る牌のヒントが切・切る番でない・手が遠いときは出さない。 */
  function requestEv() {
    if (!(myAssist().cut && asst && asst.turn && canInput() && v.options.kind === "turn" && asst.shanten <= EV_MAX_SHANTEN)) { ev = null; return; }
    if (ev && ev.ask === pkt.ask && ev.session === session) return;
    ev = null;
    let inp = null;
    try { inp = Assist.evInput(v); } catch (e) { console.error(e); }
    if (!inp || typeof Worker === "undefined") return;
    // 前の計算が終わっていなければ止める（Worker は計算の途中で別の頼みを受けられないので、作り直す）
    if (evWorker && evBusy) { evWorker.terminate(); evWorker = null; }
    if (!evWorker) {
      try { evWorker = new Worker("js/ev-worker.js"); } catch (e) { return; }
      evWorker.onmessage = e => evDone(e.data);
      evWorker.onerror = () => { evBusy = false; evWorker = null; evDone(null); };
    }
    ev = { id: ++evSeq, ask: pkt.ask, session, done: false, map: null, top: null };
    evBusy = true;
    evWorker.postMessage({ id: ev.id, input: inp.input, exclude: inp.exclude });
  }
  /** Worker から結果が届いた（d が null なら計算に失敗した）。 */
  function evDone(d) {
    if (d) evBusy = false;
    if (!ev || ev.done || (d && d.id !== ev.id)) return;
    ev.done = true;
    if (d && d.ok && !d.tooMany) {
      ev.map = new Map();
      for (const c of d.candidates) if (c.ev !== null) ev.map.set(Assist.evKey(c.index, c.red), c);
      const best = Math.max(0, ...[...ev.map.values()].map(c => c.ev));
      if (best > 0) ev.top = new Set([...ev.map].filter(([, c]) => c.ev >= best - 1e-6).map(([k]) => k));
    }
    if (port && v && v.hand) render();
  }
  /** 帯に出す、触れている切る牌 d の期待値。 */
  function evHtml(d) {
    if (!ev || ev.ask !== pkt.ask) return "";
    if (!ev.done) return '<span class="a-ev wait">期待値 計算中</span>';
    const key = Assist.evKey(d.k, d.red), c = ev.map && ev.map.get(key);
    if (!c) return "";
    const top = ev.top && ev.top.has(key);
    return `<span class="a-ev ${top ? "top" : ""}">${c.choice === "riichi" ? '<span class="a-rc">リーチ</span>' : ""}` +
      `和了率 <b>${(c.win * 100).toFixed(1)}</b>%　期待値 <b>${Math.round(c.ev)}</b>点</span>`;
  }
  /** 自分の席の入・切が変わった（部屋主が切り替えた・参加者に届いた）。 */
  function assistChanged() {
    if (!myAssist().aux) auto.win = auto.tsumogiri = auto.noCall = false; // 見えないボタンで自動に答え続けない
    refreshAssist();
    drawAux();
    if (port && v) render();
  }
  /** いま触れている「切る牌」の計算結果。触れていない・切れない牌、切る牌のヒントが切なら null。 */
  function focusDiscard() {
    if (!myAssist().cut || !asst || !asst.discards || !canInput()) return null;
    const o = v.options;
    if (o.kind !== "turn" || uiMode === "choose") return null;
    const id = hoverId !== null ? hoverId : selected;
    if (id === null || !(uiMode === "riichi" ? o.riichi : o.discards).includes(id)) return null;
    const d = asst.discards.get(id);
    if (!d) return null;
    if (uiMode !== "riichi") return { d, tenpai: d.tenpai };
    if (!riichiMemo.has(id)) riichiMemo.set(id, Assist.tenpaiAfter(v, id, true)); // 立直の役と点数を入れて出す
    return { d, tenpai: riichiMemo.get(id) };
  }
  const kindTile = k => tileBy(k, false);
  function yakuPills(res) {
    return res.yaku.filter(y => y[1] > 0).map(y => {
      const info = Assist.yakuInfo(y[0]);
      const count = y[0] === "ドラ" || y[0] === "赤ドラ" || y[0] === "裏ドラ" ? y[1] : "";
      return `<span class="a-yaku sure" title="${info ? esc(info[1]) : ""}">${esc(info ? info[0] : y[0])}${count}</span>`;
    }).join("");
  }
  /** 待ち牌（残り枚数・ロンの点数）と、選んでいる待ち牌の役・ツモの点数。 */
  function waitsHtml(t) {
    if (!t.waits.some(w => w.k === focusWait)) focusWait = t.waits[0].k;
    const chips = t.waits.map(w => {
      const tag = w.ron ? w.ron.points : w.tsumo ? "ツモのみ" : "役なし";
      const cls = (w.k === focusWait ? "on " : "") + (w.ron ? "" : w.tsumo ? "weak" : "bad");
      return `<span class="a-wait ${cls}" data-wait="${w.k}">${kindTile(w.k)}<i>${w.left}</i><b>${tag}</b></span>`;
    }).join("");
    const w = t.waits.find(x => x.k === focusWait), res = w.ron || w.tsumo;
    const warn = t.noYaku ? '<span class="a-pill bad">役なし</span>' : t.noRon ? '<span class="a-pill bad">ロンは役なし</span>' : "";
    const detail = res ? `<span class="a-detail">${yakuPills(res)}${w.tsumo ? `<span class="a-pt">ツモ <b>${w.tsumo.points}</b></span>` : ""}</span>` : "";
    return `<span class="a-detail"><span class="a-lab">待ち</span>${chips}</span>${warn}${detail}`;
  }
  function assistInner() {
    if (v.phase === "roundEnd" || v.phase === "gameEnd") return "";
    const a = myAssist();
    let h = "";
    if (asst && a.hand) h += `<span class="a-badge ${asst.shanten <= 0 ? "tenpai" : ""}">${asst.shanten <= 0 ? "テンパイ" : asst.shanten + "シャンテン"}</span>`;
    if (v.furiten && v.waits.length) h += '<span class="a-pill bad">フリテン</span>';
    if (!asst) return h;
    const f = focusDiscard(); // 切る牌のヒントが切なら null
    if (f) {
      // 切る牌に触れている間: 切ったあとの待ち、または引けば進む牌
      if (f.d.shanten > asst.shanten) h += '<span class="a-pill bad">シャンテン戻し</span>';
      h += evHtml(f.d);
      if (f.tenpai) return h + (f.tenpai.furiten ? '<span class="a-pill bad">フリテンになる</span>' : "") + waitsHtml(f.tenpai);
      const uke = f.d.uke.filter(u => u.left > 0);
      return h + `<span class="a-lab">進む牌</span>${uke.map(u => `<span class="a-uke">${kindTile(u.k)}<i>${u.left}</i></span>`).join("")}<span class="a-sum">${f.d.total}枚</span>`;
    }
    if (!a.hand) return h;
    if (asst.now) return h + waitsHtml(asst.now);
    if (asst.chances.length) {
      h += `<span class="a-lab">狙える役</span>` + asst.chances.map(c => {
        const info = Assist.yakuInfo(c.yaku);
        return `<span class="a-yaku ${c.sure ? "sure" : ""}" title="${info ? esc(info[1]) : ""}">${esc(c.label)}</span>`;
      }).join("");
    }
    return h;
  }
  /** 帯の中身だけを描き直す（マウスを動かすたびに盤面全体を作り直さない）。 */
  function updateAssist() {
    const el = board.querySelector(".assist");
    if (el && v && v.hand) el.innerHTML = assistInner();
  }
  /** 触れている牌と同じ種類の牌（河・副露・ドラ表示牌・手牌）を光らせる。 */
  function applySame() {
    for (const el of board.querySelectorAll(".tile.same")) el.classList.remove("same");
    const k = hoverKind !== null ? hoverKind : selected !== null ? kindOf(selected) : null;
    if (k === null) return;
    for (const el of board.querySelectorAll(`.seat .tile[data-k="${k}"], .center .tile[data-k="${k}"]`)) el.classList.add("same");
  }
  /** 鳴きの前の知らせ（立直できなくなる・役が無くなる）。 */
  function callNoteHtml() {
    if (!callAsst || !canInput() || v.options.kind !== "call") return "";
    const lines = [];
    if (callAsst.loseRiichi) lines.push(["soft", "鳴くとリーチできなくなります"]);
    const types = [["ポン", callAsst.pon], ["チー", callAsst.chi], ["カン", callAsst.kan ? [callAsst.kan] : []]].filter(x => x[1].length);
    const bad = types.filter(x => x[1].every(c => c.noYaku));
    if (bad.length) {
      const exact = bad.every(x => x[1].every(c => c.exact));
      const who = bad.length === types.length ? "鳴く" : bad.map(x => x[0] + "する").join("・");
      lines.push(["", `${who}と役がなくな${exact ? "ります" : "りそうです"}`]);
    }
    return lines.length ? `<div class="call-note">${lines.map(l => `<span class="${l[0]}">${l[1]}</span>`).join("")}</div>` : "";
  }

  function actionsHtml() {
    if (!canInput()) return "";
    const o = v.options;
    const b = [];
    const btn = (act, label, cls) => b.push(`<button type="button" class="abtn ${cls}" data-act="${act}">${label}</button>`);
    const adv = list => (callAsst && list.some(c => c.advances) ? " adv" : ""); // 鳴くと手が進む印
    if (uiMode === "choose") {
      choices.forEach((c, i) => b.push(`<button type="button" class="abtn choice${c.adv ? " adv" : ""}" data-act="choose" data-i="${i}">${c.tiles.map(t => tile(t)).join("")}</button>`));
      btn("cancel", "戻る", "");
    } else if (uiMode === "riichi") {
      btn("cancel", "戻る", "");
    } else if (o.kind === "turn") {
      if (o.tsumo) btn("tsumo", "ツモ", "win");
      if (o.riichi.length) btn("riichi", "リーチ", "riichi");
      if (o.ankan.length || o.kakan.length) btn("kan", "カン", "call");
      if (o.kyushu) btn("kyushu", "九種九牌", "call");
    } else {
      if (o.ron) btn("ron", "ロン", "win");
      if (o.pon.length) btn("pon", "ポン", "call" + (callAsst ? adv(callAsst.pon) : ""));
      if (o.chi.length) btn("chi", "チー", "call" + (callAsst ? adv(callAsst.chi) : ""));
      if (o.kan) btn("minkan", "カン", "call" + (callAsst && callAsst.kan ? adv([callAsst.kan]) : ""));
      btn("pass", "スキップ", "");
    }
    return b.length ? `<div class="actions">${b.join("")}</div>` : "";
  }

  // ---------- 補助ボタン（自動和了・ツモ切り・鳴かない）と、立直後の自動ツモ切り ----------
  function drawAux() {
    $("#aux").classList.toggle("hidden", !myAssist().aux);
    for (const b of document.querySelectorAll("#aux [data-auto]")) b.classList.toggle("on", auto[b.dataset.auto]);
  }
  /** いまの問いに補助ボタンの設定で自動で答えるなら {action, wait}。答えないなら null。 */
  function autoChoice() {
    if (!canInput()) return null;
    const o = v.options, ax = myAssist().aux; // 補助ボタンが切の席は、立直後のツモ切りだけ
    let action = null, wait = 450;
    if (o.kind === "turn") {
      const plain = v.drawn !== null && !o.tsumo && !o.ankan.length && !o.kakan.length && !o.kyushu && o.discards.includes(v.drawn);
      if (o.tsumo) { if (ax && auto.win) action = { type: "tsumo" }; }
      else if (plain && v.riichi[ME]) action = { type: "discard", id: v.drawn }; // 立直後は、選ぶことが無ければツモ切り
      else if (plain && ax && auto.tsumogiri && !o.riichi.length) action = { type: "discard", id: v.drawn };
    } else if (o.ron) {
      if (ax && auto.win) action = { type: "ron" };
    } else if (ax && auto.noCall) { action = { type: "pass" }; wait = 0; }
    return action && { action, wait };
  }
  /** いまの問いに、補助ボタンの設定で自動で答えられるなら答える。 */
  function autoAct() {
    const first = autoChoice();
    if (!first) return;
    const ask = pkt.ask, my = session;
    // 少し待ってから答える（ツモった牌が見えるように）。待つ間に問いが変わっていたら何もしない。
    // 待つ間に補助ボタンを切り替えたかもしれないので、待ったあとの設定で決め直す
    setTimeout(() => {
      if (my !== session || !pkt || pkt.ask !== ask) return;
      const now = autoChoice();
      if (now) submit(now.action);
    }, speed(first.wait));
  }

  // ---------- 自分の入力 ----------
  function submit(action) {
    if (!canInput()) return;
    const ask = pkt.ask;
    sentAsk = ask; uiMode = "normal"; selected = null; choices = [];
    render();
    port({ t: "act", ask, action });
  }
  function choose(list) {
    if (list.length === 1) return submit(list[0].action);
    choices = list; uiMode = "choose"; render();
  }
  function onAct(act, i) {
    if (!canInput()) return;
    const o = v.options;
    switch (act) {
      case "tsumo": return submit({ type: "tsumo" });
      case "kyushu": return submit({ type: "kyushu" });
      case "ron": return submit({ type: "ron" });
      case "pass": return submit({ type: "pass" });
      case "minkan": return submit({ type: "kan" });
      case "riichi": uiMode = "riichi"; selected = null; return render();
      case "cancel": uiMode = "normal"; choices = []; return render();
      case "choose": return choices[+i] && submit(choices[+i].action);
      case "pon": return choose(o.pon.map((t, n) => ({ tiles: t, adv: !!(callAsst && callAsst.pon[n].advances), action: { type: "pon", tiles: t } })));
      case "chi": return choose(o.chi.map((t, n) => ({ tiles: t.slice().sort((a, b) => a - b), adv: !!(callAsst && callAsst.chi[n].advances), action: { type: "chi", tiles: t } })));
      case "kan": {
        const all = v.hand.concat(v.drawn !== null ? [v.drawn] : []);
        return choose(o.ankan.map(k => ({ tiles: [all.find(t => kindOf(t) === k)], action: { type: "ankan", kind: k } }))
          .concat(o.kakan.map(id => ({ tiles: [id], action: { type: "kakan", id } }))));
      }
    }
  }
  function onTile(id, pointerType) {
    if (!canInput()) return;
    const o = v.options;
    if (o.kind !== "turn" || uiMode === "choose") return;
    const riichi = uiMode === "riichi";
    if (!(riichi ? o.riichi : o.discards).includes(id)) return;
    // マウスは1回で切る。タッチは1回目で選び、同じ牌をもう1回で切る
    if (pointerType !== "mouse" && pointerType !== undefined && pointerType !== "" && selected !== id) { selected = id; return render(); }
    submit(riichi ? { type: "discard", id, riichi: true } : { type: "discard", id });
  }
  function setFocusWait(k) {
    if (k === focusWait) return;
    focusWait = k;
    updateAssist();
  }
  board.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (btn) return onAct(btn.dataset.act, btn.dataset.i);
    const w = e.target.closest(".a-wait[data-wait]");
    if (w) return setFocusWait(+w.dataset.wait);
    const t = e.target.closest(".pos0 .hand .tile[data-id]");
    if (t) return onTile(+t.dataset.id, e.pointerType);
    // 中央の四角（四隅の点数の札も中央の四角の中にある）: 点数 ⇔ 自分との点差
    if (e.target.closest(".center, .plate")) { showDiff = !showDiff; render(); }
  });
  // マウスが乗っている牌: 自分の手牌なら帯に「切ったあと」を出し、どの牌でも同じ種類の牌を光らせる（タッチは1回目のタップで選んだ牌が同じ役目）
  function setHover(id, k) {
    const idChanged = id !== hoverId, kChanged = k !== hoverKind;
    hoverId = id; hoverKind = k;
    if (idChanged) updateAssist();
    if (kChanged) applySame();
  }
  board.addEventListener("pointerover", e => {
    if (e.pointerType !== "mouse") return;
    const w = e.target.closest(".a-wait[data-wait]");
    if (w) setFocusWait(+w.dataset.wait);
    const t = e.target.closest(".tile[data-k]");
    const own = t && t.dataset.id !== undefined && t.closest(".pos0 .hand") ? +t.dataset.id : null;
    setHover(own, t ? +t.dataset.k : null);
  });
  board.addEventListener("pointerleave", () => setHover(null, null));
  $("#aux").addEventListener("click", e => {
    const b = e.target.closest("[data-auto]");
    if (!b) return;
    auto[b.dataset.auto] = !auto[b.dataset.auto];
    drawAux();
    autoAct();
  });

  // ---------- アシストの入・切の表（部屋主・1人用。部屋の枠と、対局中の「アシスト」の板） ----------
  /** cols: [{seat, lab, name}]。行＝4つのまとまり、列＝席。 */
  function assistTableHtml(cols) {
    const head = cols.map(c => `<th><span class="lab">${c.lab}</span>${c.name ? `<span class="nm">${esc(c.name)}</span>` : ""}</th>`).join("");
    const rows = ASSIST_GROUPS.map(([k, label]) => `<tr><th>${label}</th>${cols.map(c => {
      const on = settings.assistSeats[c.seat][k];
      return `<td><button type="button" class="as-tg ${on ? "on" : ""}" data-as-seat="${c.seat}" data-as-key="${k}">${on ? "入" : "切"}</button></td>`;
    }).join("")}</tr>`).join("");
    return `<table class="as-table"><tr><th></th>${head}</tr>${rows}</table>`;
  }
  /** 対局中の板に出す列: 自分と、いまの対局で人が座っている席。 */
  function gameAssistCols() {
    const cols = [{ seat: 0, lab: SEAT_LABEL[0] }];
    if (mode === "host" && table) for (let s = 1; s < 4; s++) if (table.human[s]) cols.push({ seat: s, lab: SEAT_LABEL[s], name: v ? v.names[s] : "" });
    return cols;
  }
  function drawAssistModal() {
    $("#assistTable").innerHTML = mode === "guest" ? "" : assistTableHtml(gameAssistCols()); // 参加者は印の意味の一覧だけ
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-as-seat]");
    if (!b || mode === "guest") return;
    const s = +b.dataset.asSeat, k = b.dataset.asKey, flags = settings.assistSeats[s];
    if (!flags || !(k in flags)) return;
    flags[k] = !flags[k];
    saveSettings();
    if (s === 0) assistChanged();
    if (room) sendLobby(); // 参加者の席の分は、部屋の様子と一緒に送る
    drawAssistModal();
    drawHome();
  });

  // ---------- 結果の表示 ----------
  const overlay = $("#overlay");
  let overlayResolve = null;
  function modal(html) {
    overlay.innerHTML = html;
    overlay.classList.remove("hidden");
    return new Promise(res => { overlayResolve = res; });
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    overlayResolve = null;
  }
  overlay.addEventListener("click", e => {
    // 役の名前を押すと、読みと一言の説明を出す（同じ役をもう一度押すと消す）
    const y = e.target.closest(".yaku li[data-yaku]");
    if (y) {
      const win = y.closest(".res-win"), box = win.querySelector(".yaku-desc"), info = Assist.yakuInfo(y.dataset.yaku);
      const open = !y.classList.contains("on") && !!info;
      for (const li of win.querySelectorAll(".yaku li.on")) li.classList.remove("on");
      y.classList.toggle("on", open);
      box.innerHTML = open ? `<b>${esc(info[0])}</b>${esc(info[1])}` : "";
      return;
    }
    const b = e.target.closest("[data-close]");
    if (!b) return;
    if (b.dataset.close === "next") {
      // 局の結果: 押したことを送り、次の局の情報が届くまで板は出したままにする（ほかの人を待つことがある）
      if (resultRound === -1 || !port) return;
      confirmedRound = resultRound;
      b.disabled = true;
      b.textContent = "待っています";
      return port({ t: "next" });
    }
    if (!overlayResolve) return;
    const res = overlayResolve, val = b.dataset.close;
    hideOverlay();
    res(val);
  });

  function limitName(w) {
    if (w.yakuman) return w.yakuman >= 2 ? `${w.yakuman}倍役満` : "役満";
    if (w.han >= 13) return "数え役満";
    if (w.base >= 6000) return "三倍満";
    if (w.base >= 4000) return "倍満";
    if (w.base >= 3000) return "跳満";
    if (w.base >= 2000) return "満貫";
    return "";
  }
  /** 和了の点数（本場・供託を除く）。ツモも3人から受け取る合計を出す（誰がいくら払ったかは下の点数の表に出る）。 */
  const pointsText = w => [String(MJ.payment(w.base, w.oya, w.tsumo).total), "点"];
  function scoresHtml(res, tags) {
    const cells = [0, 1, 2, 3].map(pos => {
      const s = (ME + pos) % 4, d = res.deltas[s];
      return `<div class="cell">
        <div class="name">${WIND[(s - v.oya + 4) % 4]}　${esc(v.names[s])}</div>
        <div class="val">${res.after[s]}</div>
        <div class="delta ${d > 0 ? "plus" : d < 0 ? "minus" : ""}">${d > 0 ? "+" + d : d < 0 ? d : ""}</div>
        ${tags ? `<div class="tag">${tags[s] || ""}</div>` : ""}
      </div>`;
    });
    return `<div class="scores">${cells.join("")}</div>`;
  }
  function winHtml(w, res) {
    const yaku = w.yaku.filter(y => y[1] > 0).map(y =>
      `<li data-yaku="${esc(y[0])}"><span>${esc(y[0])}</span><b>${w.yakuman ? "役満" : y[1] + "飜"}</b></li>`).join("");
    const name = limitName(w);
    const [pts, unit] = pointsText(w);
    const head = w.yakuman ? name : `${w.fu}符${w.han}飜${name ? "　" + name : ""}`;
    return `<div class="res-win">
      <div class="res-title"><span class="how">${w.tsumo ? "ツモ" : "ロン"}</span><span class="who">${esc(v.names[w.seat])}</span>
        ${w.tsumo ? "" : `<span class="from">← ${esc(v.names[w.from])}</span>`}</div>
      <div class="res-hand">
        <div class="grp">${w.hand.map(t => tile(t)).join("")}</div>
        <div class="grp">${tile(w.tile)}</div>
        ${w.melds.map(m => meldHtml(m, w.seat, "grp")).join("")}
      </div>
      <div class="res-dora"><span>ドラ</span><div class="grp">${res.doraInd.map(t => tile(t)).join("")}</div>
        ${w.riichi ? `<span>裏ドラ</span><div class="grp">${res.uraInd.map(t => tile(t)).join("")}</div>` : ""}</div>
      <ul class="yaku">${yaku}</ul>
      <div class="yaku-desc"></div>
      <div class="res-total">${head}<b>${pts}</b>${unit}</div>
    </div>`;
  }
  function showResult(round) {
    const res = v.result;
    let body;
    if (res.type === "win") {
      body = res.wins.map(w => winHtml(w, res)).join("") + scoresHtml(res);
    } else {
      let tags = null;
      if (res.reason === "exhaustive") {
        tags = [0, 1, 2, 3].map(s => (res.nagashi.includes(s) ? "流し満貫" : res.tenpai[s] ? "聴牌" : "ノーテン"));
      }
      const hands = [0, 1, 2, 3].filter(s => res.hands[s]).map(s =>
        `<div class="res-title"><span class="who">${esc(v.names[s])}</span></div>
         <div class="res-hand"><div class="grp">${res.hands[s].map(t => tile(t)).join("")}</div>${res.melds[s].map(m => meldHtml(m, s, "grp")).join("")}</div>`).join("");
      body = `<div class="res-head">${ryukyokuName(res)}</div>${hands}${scoresHtml(res, tags)}`;
    }
    resultRound = round;
    modal(`<div class="card">${body}<div class="card-foot"><button type="button" class="bigbtn small" data-close="next">次へ</button></div></div>`);
  }
  function showFinal() {
    const f = v.final;
    const lines = f.order.map((s, i) => `<div class="line ${i === 0 ? "first" : ""}" data-seat="${s}">
      <span class="no">${i + 1}位</span><span class="nm">${esc(v.names[s])}<span class="rt"></span></span>
      <span class="sc">${f.scores[s]}</span><span class="pt">${f.points[i] > 0 ? "+" : ""}${f.points[i].toFixed(1)}</span></div>`).join("");
    const my = session;
    modal(`<div class="card"><div class="res-head">終局</div><div class="rank">${lines}</div>
      <div class="card-foot">
        <button type="button" class="bigbtn small ${mode === "guest" ? "" : "ghost"}" data-close="home">${mode === "solo" ? "はじめの画面へ" : "部屋へ戻る"}</button>
        ${mode === "guest" ? "" : '<button type="button" class="bigbtn small" data-close="again">もう一度</button>'}
      </div></div>`).then(val => {
      if (my !== session) return;
      if (val === "again") startGame(); else goHome();
    });
    fillRates();
  }
  /** 終局の板に、戦績に数えた対局ならレートと増減を入れる（部屋主は記録したあと、参加者は部屋主から届いたあと）。 */
  function fillRates() {
    const r = mode === "guest" ? guest && guest.lobby && guest.lobby.rated : lastRated;
    const gid = mode === "guest" ? guest && guest.gid : room && room.gid;
    if (!r || r.gid !== gid || !Array.isArray(r.rows)) return;
    for (const row of r.rows) {
      const el = overlay.querySelector(`.rank .line[data-seat="${Number(row.seat)}"] .rt`);
      const a = Math.round(Number(row.after)), d = a - Math.round(Number(row.before));
      if (!el || !isFinite(a) || !isFinite(d)) continue;
      el.innerHTML = `R ${a}<i class="${d > 0 ? "plus" : d < 0 ? "minus" : ""}">${d > 0 ? "+" + d : d < 0 ? d : "±0"}</i>`;
    }
  }
  /** 終局した（部屋主）。人が2人以上座っていた対局なら、戦績とレートに入れる。 */
  function recordStats(sum, gid) {
    const res = Stats.record(stats, sum);
    if (!res.rows.length) return;
    stats = res.store;
    saveStats();
    lastRated = { gid, rows: res.rows };
    fillRates();
  }

  // ---------- 戦績の表 ----------
  /** 表に出す行。部屋主は記録した全員、参加者は部屋主から届いた分（部屋にいる人と部屋主）。 */
  function statsRows() {
    if (mode === "guest" || JOIN_CODE) return guest && guest.lobby && guest.lobby.stats ? Stats.list(guest.lobby.stats) : [];
    return Stats.list(stats);
  }
  function drawStats() {
    const rows = statsRows(), canDelete = !JOIN_CODE;
    const pct = x => (x === null ? "—" : (x * 100).toFixed(1) + "%");
    const sign = x => (x > 0 ? "plus" : x < 0 ? "minus" : "");
    $("#statsTable").innerHTML = !rows.length ? '<div class="st-none">まだ記録がありません</div>' : `<div class="st-wrap"><table class="st-table">
      <tr><th>名前</th><th>レート</th><th>対局</th><th>平均順位</th><th>1位/2位/3位/4位</th><th>通算</th><th>和了率</th><th>放銃率</th>${canDelete ? "<th></th>" : ""}</tr>
      ${rows.map(r => `<tr><th>${esc(r.name)}</th><td class="rate">${Math.round(r.rate)}</td><td>${r.games}</td>
        <td>${r.avgRank === null ? "—" : r.avgRank.toFixed(2)}</td><td>${r.ranks.join(" / ")}</td>
        <td class="${sign(r.points)}">${r.points > 0 ? "+" : ""}${r.points.toFixed(1)}</td><td>${pct(r.winRate)}</td><td>${pct(r.dealinRate)}</td>
        ${canDelete ? `<td><button type="button" class="clr" data-st-del="${esc(r.name)}">消す</button></td>` : ""}</tr>`).join("")}
    </table></div>`;
  }
  $("#statsTable").addEventListener("click", e => {
    const b = e.target.closest("[data-st-del]");
    if (!b || JOIN_CODE) return;
    const name = b.dataset.stDel;
    if (!confirm(`「${name}」の戦績を消しますか？（元に戻せません）`)) return;
    stats = Stats.remove(stats, name);
    saveStats();
    drawStats();
    drawHome();
    if (room) sendLobby();
  });
  function showError(err) {
    console.error(err);
    modal(`<div class="card"><div class="res-head">エラー</div><p>${esc(err && err.message)}</p>
      <div class="card-foot"><button type="button" class="bigbtn small" data-close="home">はじめの画面へ</button></div></div>`).then(() => quitGame());
  }

  // ---------- 卓の進行役を持つ側（1人用・部屋主） ----------
  function tableTiming() {
    const t = {};
    for (const k of Object.keys(Table.TIMING)) t[k] = speed(Table.TIMING[k]);
    return t;
  }
  function stopTable() {
    if (table) table.stop();
    table = null;
  }
  /** 対局を始める（1人用、または部屋主として）。 */
  function startGame() {
    if (mode === "guest") return;
    stopTable();
    mode = room ? "host" : "solo";
    const game = { length: settings.length, rig: settings.rig };
    if (PARAMS.has("seed")) game.seed = +PARAMS.get("seed");
    const humans = [0];
    lastRated = null; // 前の対局の増減を、この対局の終局の板に出さない
    if (room) {
      // 席1〜3: 部屋にいる人はその人、いない席は CPU
      let cpu = 0;
      room.seatId = [null, null, null, null];
      game.names = [cleanName(settings.name, "部屋主")];
      for (let s = 1; s < 4; s++) {
        const m = room.members.find(x => x.seat === s);
        if (m) { room.seatId[s] = m.id; humans.push(s); game.names.push(m.name); }
        else game.names.push(`CPU ${++cpu}`);
      }
      room.playing = true;
      room.gid++;
    } else game.names = ["あなた", "CPU 下家", "CPU 対面", "CPU 上家"];
    const my = { gid: room ? room.gid : 0 };
    openGame(msg => table && table.submit(0, msg));
    table = new Table({
      game, humans, cpu: settings.cpu, timing: tableTiming(), onError: showError,
      send(seat, p) {
        if (seat === 0) receive(clone(p));
        else if (room && room.seatId[seat]) room.net.send({ t: "state", gid: my.gid, p }, room.seatId[seat]);
      },
      onEnd(sum) { if (room) { recordStats(sum, my.gid); room.playing = false; dropOffline(); sendLobby(); } }, // 1人用は戦績に数えない
    });
    table.start();
    if (room) sendLobby();
  }
  /** 対局をやめて、はじめの画面（部屋があれば部屋）へ戻る。 */
  function quitGame() {
    if (mode === "guest") return leaveRoom();
    stopTable();
    if (room && room.playing) {
      room.playing = false;
      room.net.send({ t: "end" }, "*");
      dropOffline();
      sendLobby();
    }
    goHome();
  }
  function goHome() {
    closeGame();
    drawHome();
  }

  // ---------- 部屋（部屋主の側） ----------
  // room.members: 部屋にいる参加者 {id, name, seat（1〜3。席が無いときは 0）, online}
  // room.seatId[席]: いまの対局でその席に座っている参加者の id（対局の途中で入った人は入らない）
  let room = null;
  const ROOM_STORE = "settai-mahjong-room"; // 部屋主がページを読み込み直しても同じ部屋を開き直すため（タブごと）
  const relayUrl = () => {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (local && PARAMS.has("relay")) return PARAMS.get("relay");
    return (window.SETTAI_CONFIG && window.SETTAI_CONFIG.relay) || (local ? "ws://localhost:8787" : "");
  };
  function randomText(n, chars) {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, x => chars[x % chars.length]).join("");
  }
  const guestNameAt = seat => {
    const m = room && room.members.find(x => x.seat === seat);
    return m ? m.name : null;
  };
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
  const STATUS_TEXT = {
    connecting: "接続中", retry: "つなぎ直しています", open: "",
    noroom: "部屋が見つかりません", taken: "この部屋は使えません", full: "満員です",
    closed: "部屋が閉じられました", replaced: "ほかの画面で開いています", bad: "接続できません",
  };

  function openRoom(saved) {
    if (room || !relayUrl()) return;
    room = {
      code: saved ? saved.code : randomText(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"),
      key: saved ? saved.key : randomText(32, "abcdefghijklmnopqrstuvwxyz0123456789"),
      members: [], seatId: [null, null, null, null], playing: false, gid: 0, status: "connecting", pick: 0, net: null,
    };
    try { sessionStorage.setItem(ROOM_STORE, JSON.stringify({ code: room.code, key: room.key })); } catch (e) { /* 覚えられなくても続ける */ }
    const mine = room;
    room.net = Net.open({
      url: relayUrl(), room: room.code, role: "host", id: room.key.slice(0, 16), key: room.key,
      onStatus(st, code) {
        if (room !== mine) return;
        if (st === "error") return closeRoom(STATUS_TEXT[code] || STATUS_TEXT.bad);
        room.status = st;
        $("#netBadge").classList.toggle("hidden", st === "open");
        drawHome();
      },
      onReady(m) {
        if (room !== mine) return;
        // つなぎ直す間にいなくなった人を外す（残っている人は、あらためて名乗ってくる）
        const here = new Set(m.guests || []);
        for (const x of room.members.slice()) if (!here.has(x.id)) memberLeft(x.id, false);
      },
      onSys(m) { if (room === mine && m.sys === "leave") memberLeft(m.id, false); },
      onData(d, from) { if (room === mine) onGuestData(from, d); },
    });
    drawHome();
  }
  function closeRoom(message) {
    if (!room) return;
    const r = room;
    room = null;
    stopTable();
    r.net.sys({ sys: "close" });
    r.net.close();
    $("#netBadge").classList.add("hidden");
    try { sessionStorage.removeItem(ROOM_STORE); } catch (e) { /* 何もしない */ }
    homeNote = message || "";
    mode = "solo";
    goHome();
  }
  const freeSeat = () => [1, 2, 3].find(s => !room.members.some(m => m.seat === s)) || 0;
  const gameSeatOf = id => (room.playing ? room.seatId.indexOf(id) : -1);
  function onGuestData(id, d) {
    if (typeof id !== "string" || !d || typeof d !== "object") return;
    if (d.t === "hello") {
      let m = room.members.find(x => x.id === id);
      if (!m) { m = { id, name: "", seat: freeSeat(), online: true }; room.members.push(m); }
      m.name = cleanName(d.name, "ゲスト");
      m.online = true;
      const seat = gameSeatOf(id);
      if (seat > 0 && table) { table.setConnected(seat, true); table.resync(seat); } // 戻ってきた人へ、いまの状態を送り直す
      sendLobby();
      return drawHome();
    }
    if (d.t === "bye") return memberLeft(id, true);
    const seat = gameSeatOf(id);
    if (seat > 0 && table) table.submit(seat, d);
  }
  /** 参加者がいなくなった。対局中の席は CPU が代わりに打ち、戻ってきたら返す（自分から抜けた人には返さない）。 */
  function memberLeft(id, forGood) {
    const m = room.members.find(x => x.id === id);
    if (!m) return;
    const seat = gameSeatOf(id);
    if (seat > 0 && table) table.setConnected(seat, false);
    if (seat > 0 && !forGood) m.online = false;
    else {
      room.members.splice(room.members.indexOf(m), 1);
      if (seat > 0) room.seatId[seat] = null;
    }
    sendLobby();
    drawHome();
  }
  function dropOffline() {
    room.members = room.members.filter(m => m.online);
  }
  /** その参加者の席のアシストの入・切（対局中はその対局の席、そうでなければ部屋の席。席が無ければ全部入）。 */
  function assistOf(m) {
    const s = gameSeatOf(m.id) > 0 ? gameSeatOf(m.id) : m.seat;
    return s > 0 ? settings.assistSeats[s] : cleanAssist(null);
  }
  /**
   * 参加者ひとりずつに、部屋のいまの様子を送る:
   *   { t: "lobby", names: 席0〜3の名前（人がいない席は null）, you: 部屋の席（無ければ 0）, playing, inGame: いまの対局に席があるか,
   *     assist: その人の席のアシストの入・切 {cut, hand, guard, aux},
   *     stats: 部屋主と部屋にいる人の戦績（stats.js の記録の形）, rated: いちばん最後に戦績に数えた対局 {gid, rows} | null }
   */
  function sendLobby() {
    if (!room) return;
    const names = [cleanName(settings.name, "部屋主")];
    for (let s = 1; s < 4; s++) names.push(guestNameAt(s));
    const players = {};
    for (const n of [names[0]].concat(room.members.map(m => m.name))) if (stats.players[n]) players[n] = stats.players[n];
    const shared = { stats: { v: 1, players }, rated: lastRated && lastRated.gid === room.gid ? lastRated : null };
    for (const m of room.members) {
      if (m.online) room.net.send(Object.assign({ t: "lobby", names, you: m.seat, playing: room.playing, inGame: gameSeatOf(m.id) > 0, assist: assistOf(m) }, shared), m.id);
    }
  }

  // ---------- 部屋（参加者の側） ----------
  const JOIN_CODE = /^[A-Z2-9]{6}$/.test(PARAMS.get("room") || "") ? PARAMS.get("room") : null;
  let guest = null; // {net, status, lobby, gid}
  const JOIN_STORE = "settai-mahjong-joined"; // 参加したあとでページを読み込み直したら、そのまま入り直すため（タブごと）
  function guestId() {
    // 同じ端末なら、つなぎ直しても同じ席へ戻れるように覚えておく
    const key = "settai-mahjong-id" + AS;
    try {
      let id = localStorage.getItem(key);
      if (!/^[a-z0-9]{16,64}$/.test(id || "")) { id = randomText(24, "abcdefghijklmnopqrstuvwxyz0123456789"); localStorage.setItem(key, id); }
      return id;
    } catch (e) { return randomText(24, "abcdefghijklmnopqrstuvwxyz0123456789"); }
  }
  function joinRoom() {
    if (guest || !JOIN_CODE || !relayUrl()) return;
    mode = "guest";
    guest = { net: null, status: "connecting", lobby: null, gid: -1 };
    try { sessionStorage.setItem(JOIN_STORE, JOIN_CODE); } catch (e) { /* 覚えられなくても続ける */ }
    const mine = guest;
    const hello = () => guest.net.send({ t: "hello", name: cleanName(settings.name, "ゲスト") });
    guest.net = Net.open({
      url: relayUrl(), room: JOIN_CODE, role: "guest", id: guestId(),
      onStatus(st, code) {
        if (guest !== mine) return;
        if (st === "error") return leaveRoom(STATUS_TEXT[code] || STATUS_TEXT.bad);
        guest.status = st;
        $("#netBadge").classList.toggle("hidden", st === "open");
        drawHome();
      },
      onReady() { if (guest === mine) hello(); },
      onSys(m) { if (guest === mine && m.sys === "host" && m.on) hello(); },
      onData(d) {
        if (guest !== mine || !d || typeof d !== "object") return;
        if (d.t === "lobby") {
          d.stats = Stats.normalize(d.stats); // 届いた戦績は決まった形にそろえてから使う
          guest.lobby = d;
          const a = cleanAssist(d.assist); // 部屋主が決めた、自分の席のアシストの入・切
          if (ASSIST_GROUPS.some(([k]) => a[k] !== guestAssist[k])) { guestAssist = a; assistChanged(); }
          if (finalShown) fillRates();
          if (!$("#statsModal").classList.contains("hidden")) drawStats();
          // 部屋主が対局を持っていない（読み込み直したなど）のに対局の画面にいたら、部屋へ戻る
          if (!d.inGame && port && !(v && v.phase === "gameEnd")) goHome();
          drawHome();
        } else if (d.t === "state" && d.p && d.p.view) {
          if (d.gid !== guest.gid || !port) { guest.gid = d.gid; openGame(msg => guest && guest.net.send(msg)); }
          receive(d.p);
        } else if (d.t === "end") goHome();
      },
    });
    drawHome();
  }
  function leaveRoom(message) {
    if (!guest) return;
    const g = guest;
    guest = null;
    g.net.send({ t: "bye" });
    g.net.close();
    try { sessionStorage.removeItem(JOIN_STORE); } catch (e) { /* 何もしない */ }
    $("#netBadge").classList.add("hidden");
    homeNote = message || "";
    goHome();
  }

  // ---------- はじめの画面 ----------
  let homeNote = ""; // 部屋が閉じたときなどの知らせ
  const homeRig = mountRig($("#homeRig"), null);
  const modalRig = mountRig($("#modalRig"), () => { if (table) table.setRig(settings.rig); });
  const chip = (label, name, cls, attr) =>
    `<button type="button" class="chip ${cls || ""}" ${attr || ""}><span class="lab">${label}</span><span class="nm">${name === null ? "CPU" : esc(name)}</span></button>`;
  const nameInput = id => `<input type="text" id="${id}" class="name-input" maxlength="${NAME_MAX}" placeholder="名前" value="${esc(settings.name)}">`;
  /** innerHTML を入れ替える（名前を打っている途中なら、打った文字とカーソルを残す）。 */
  function setHtml(root, html) {
    const a = document.activeElement;
    const keep = a && a.classList.contains("name-input") && root.contains(a) ? { id: a.id, value: a.value, at: a.selectionStart } : null;
    root.innerHTML = html;
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) { el.value = keep.value; el.focus(); el.setSelectionRange(keep.at, keep.at); }
    }
  }
  function drawHome() {
    const asGuest = !!JOIN_CODE;
    for (const el of document.querySelectorAll(".host-only")) el.classList.toggle("hidden", asGuest);
    $("#guestBox").classList.toggle("hidden", !asGuest);
    for (const b of document.querySelectorAll("#lengthSeg button")) b.classList.toggle("on", b.dataset.v === settings.length);
    for (const b of document.querySelectorAll("#cpuSeg button")) b.classList.toggle("on", b.dataset.v === settings.cpu);
    $("#statsBtn").classList.toggle("hidden", !statsRows().length); // 記録が1人分以上あるとき
    const note = homeNote ? `<div class="room-note">${esc(homeNote)}</div>` : "";
    if (asGuest) {
      let h;
      if (!guest) {
        h = `${note}<div class="join">${nameInput("guestName")}<button type="button" class="bigbtn" data-guest="join">参加する</button></div>`;
      } else {
        const l = guest.lobby;
        const st = guest.status !== "open" || !l ? STATUS_TEXT[guest.status] || STATUS_TEXT.connecting
          : !l.you ? "満席です" : l.playing && !l.inGame ? "対局中です" : "部屋主が始めるのを待っています";
        h = `<div class="room">
          ${l ? `<div class="room-seats">${l.names.map((n, s) => chip("", n, s === l.you ? "me" : n === null ? "cpu" : "", "disabled")).join("")}</div>` : ""}
          <div class="room-note">${st}</div>
          <div class="join"><button type="button" class="bigbtn small ghost" data-guest="leave">抜ける</button></div>
        </div>`;
      }
      return setHtml($("#guestBox"), h);
    }
    $("#roomBtn").classList.toggle("hidden", !!room || !relayUrl());
    let h = note;
    if (room) {
      const seats = [1, 2, 3].map(s => {
        const m = room.members.find(x => x.seat === s);
        return chip(SEAT_LABEL[s], m ? m.name : null, (m ? "" : "cpu ") + (room.pick === s ? "sel" : ""), `data-seat="${s}"`);
      }).join("");
      h = `<div class="room">
        <div class="room-head">
          <span class="ttl">部屋</span>
          <span class="st">${STATUS_TEXT[room.status] || ""}</span>
          <button type="button" class="pill" data-room="copy">招待 URL をコピー</button>
          <button type="button" class="pill" data-room="close">部屋を閉じる</button>
        </div>
        <div class="room-url">${esc(inviteUrl())}</div>
        <div class="room-seats"><div class="chip me"><span class="lab">${SEAT_LABEL[0]}</span>${nameInput("hostName")}</div>${seats}</div>
        <div class="room-assist"><div class="sub-ttl">アシスト</div>${assistTableHtml([{ seat: 0, lab: SEAT_LABEL[0] }].concat(
          [1, 2, 3].filter(s => guestNameAt(s) !== null).map(s => ({ seat: s, lab: SEAT_LABEL[s], name: guestNameAt(s) }))))}</div>
      </div>`;
    }
    setHtml($("#roomBox"), h);
    homeRig.draw();
  }
  function onName(el) {
    settings.name = cleanName(el.value, "");
    saveSettings();
    if (room) sendLobby();
  }
  $("#home").addEventListener("change", e => { if (e.target.classList.contains("name-input")) onName(e.target); });
  $("#roomBox").addEventListener("click", e => {
    if (!room) return;
    const act = e.target.closest("[data-room]");
    if (act && act.dataset.room === "close") return closeRoom();
    if (act && act.dataset.room === "copy") {
      const done = () => { act.textContent = "コピーしました"; setTimeout(drawHome, 1200); };
      return navigator.clipboard ? navigator.clipboard.writeText(inviteUrl()).then(done, () => {}) : undefined;
    }
    // 席を2つ続けて押すと、座っている人を入れ替える
    const seatEl = e.target.closest("[data-seat]");
    if (!seatEl) return;
    const s = +seatEl.dataset.seat;
    if (!room.pick) { room.pick = s; return drawHome(); }
    const a = room.pick;
    room.pick = 0;
    if (a !== s) {
      for (const m of room.members) m.seat = m.seat === a ? s : m.seat === s ? a : m.seat;
      sendLobby();
    }
    drawHome();
  });
  $("#guestBox").addEventListener("click", e => {
    const b = e.target.closest("[data-guest]");
    if (!b) return;
    if (b.dataset.guest === "leave") return leaveRoom();
    onName($("#guestName"));
    homeNote = "";
    joinRoom();
  });
  $("#lengthSeg").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    settings.length = b.dataset.v;
    saveSettings(); drawHome();
  });
  $("#cpuSeg").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    settings.cpu = b.dataset.v;
    saveSettings(); drawHome();
  });
  $("#startBtn").addEventListener("click", () => { homeNote = ""; startGame(); });
  $("#roomBtn").addEventListener("click", () => { homeNote = ""; openRoom(null); });
  $("#rigBtn").addEventListener("click", () => { modalRig.draw(); $("#rigModal").classList.remove("hidden"); });
  $("#rigClose").addEventListener("click", () => $("#rigModal").classList.add("hidden"));
  $("#assistBtn").addEventListener("click", () => { drawAssistModal(); $("#assistModal").classList.remove("hidden"); });
  $("#assistClose").addEventListener("click", () => $("#assistModal").classList.add("hidden"));
  $("#quitBtn").addEventListener("click", () => quitGame());
  $("#statsBtn").addEventListener("click", () => { drawStats(); $("#statsModal").classList.remove("hidden"); });
  $("#statsClose").addEventListener("click", () => $("#statsModal").classList.add("hidden"));

  if (JOIN_CODE) {
    mode = "guest";
    let joined = null;
    try { joined = sessionStorage.getItem(JOIN_STORE); } catch (e) { /* 無ければ名前を聞く */ }
    if (joined === JOIN_CODE) joinRoom();
  } else {
    // 部屋主が読み込み直したときは、同じ部屋を開き直す（対局の途中だった分は戻らない）
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(ROOM_STORE)); } catch (e) { /* 無ければ開かない */ }
    if (saved && typeof saved.code === "string" && typeof saved.key === "string") openRoom(saved);
  }
  drawHome();

  // 確かめ用（コンソールから対局の中を見る）
  window.SettaiDebug = { get game() { return table && table.g; }, get table() { return table; }, get room() { return room; }, get guest() { return guest; }, get assist() { return myAssist(); }, settings };
})();
