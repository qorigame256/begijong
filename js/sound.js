"use strict";
/*
 * 音（効果音・ふだんの BGM・リーチの BGM）。音のファイルは使わず、ブラウザの音の機能（Web Audio）でその場で作って鳴らす。
 * 曲は 8 小節のくり返し。旋律は決まった種（seed）の乱数で作るので、毎回同じ曲になる。
 *
 * 雰囲気（STYLES）は chime（オルゴール＝エレピと鈴）の1つ。3回の聞き比べで本人が選んだ（仕様書 6.9章）。ほかの雰囲気を足すときは STYLE に並べる。
 *
 * 使い方（ui.js）:
 *   Sound.unlock()               押したとき（ブラウザは人が押すまで音を出させない）に呼ぶ。音の機能を起こす。
 *   Sound.setStyle("chime")      雰囲気を変える（鳴っている BGM も入れ替える）。
 *   Sound.setLevel("all"|"se"|"off")  すべて／効果音だけ／鳴らさない。
 *   Sound.bgm("normal"|"riichi"|null) BGM を切り替える（同じなら何もしない。0.8 秒で入れ替わる）。
 *   Sound.se(name)               効果音。name は SE の名前（discard call riichi win ryukyoku start end）。
 * 書き出し（tools/sound-render.js）は Sound.engine(ctx, style) を OfflineAudioContext に対して直接使う。
 */
(function (root) {
  const hz = m => 440 * Math.pow(2, (m - 69) / 12); // MIDI の音の番号 → 周波数

  function mkRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 楽器と、曲を予約する仕組み。ctx は AudioContext でも OfflineAudioContext でもよい。 */
  function engine(ctx, styleName) {
    const sr = ctx.sampleRate;
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -14; master.knee.value = 12; master.ratio.value = 4;
    master.attack.value = 0.005; master.release.value = 0.2;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    master.connect(out);
    // 残響（雑音を減衰させた響きの型）
    const verb = ctx.createConvolver();
    {
      const len = Math.floor(sr * 2.2), b = ctx.createBuffer(2, len, sr);
      const r = mkRng(7);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      verb.buffer = b;
    }
    const verbGain = ctx.createGain();
    verbGain.gain.value = 0.32;
    verb.connect(verbGain).connect(master);
    const bgmBus = ctx.createGain(), seBus = ctx.createGain();
    bgmBus.gain.value = 0.3; seBus.gain.value = 0.9;
    bgmBus.connect(master); seBus.connect(master);

    const noiseBuf = (() => {
      const b = ctx.createBuffer(1, sr * 2, sr), d = b.getChannelData(0), r = mkRng(11);
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
      return b;
    })();

    // ---------- 部品 ----------
    function env(g, t, a, peak, d, sustain, rel, end) {
      // a: 立ち上がり / d: 減衰 / sustain: 減衰後の大きさ（peak に対する割合）/ end: 離す時刻 / rel: 離してから消えるまで
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.setTargetAtTime(Math.max(0.0001, peak * sustain), t + a, d / 3);
      if (end !== undefined) {
        g.gain.setTargetAtTime(0.0001, Math.max(end, t + a), rel / 4);
      }
    }
    function voice(dest, wet) {
      const g = ctx.createGain();
      g.connect(dest);
      if (wet) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s).connect(verb); }
      return g;
    }
    function osc(type, f, t, stop, dest) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.setValueAtTime(f, t);
      o.connect(dest); o.start(t); o.stop(stop);
      return o;
    }
    function noise(t, dur, dest) {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      s.connect(dest); s.start(t, Math.random() * 1.5); s.stop(t + dur);
      return s;
    }
    function filt(type, f, q, dest) {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q;
      b.connect(dest);
      return b;
    }

    // 鐘・鈴（FM）
    function bell(dest, m, t, vel, o) {
      o = o || {};
      const f = hz(m), dur = o.dur || 2.6, g = voice(dest, o.wet === undefined ? 0.6 : o.wet);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const car = osc("sine", f, t, t + dur, g);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * (o.index || 2.2), t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.7);
      const mod = osc("sine", f * (o.ratio || 3.51), t, t + dur, mg);
      mg.connect(car.frequency);
      return mod;
    }
    // エレピ（FM。比 1 の変調で Rhodes に近づける）
    function epiano(dest, m, t, dur, vel, wet) {
      const f = hz(m), g = voice(dest, wet === undefined ? 0.3 : wet), end = t + dur;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel, t + 0.006);
      g.gain.setTargetAtTime(vel * 0.35, t + 0.006, 0.35);
      g.gain.setTargetAtTime(0.0001, end, 0.12);
      const car = osc("sine", f, t, end + 0.8, g);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 1.6, t); mg.gain.setTargetAtTime(f * 0.25, t, 0.25);
      osc("sine", f, t, end + 0.8, mg);
      mg.connect(car.frequency);
      const tg = ctx.createGain(); tg.gain.setValueAtTime(vel * 0.25, t); tg.gain.setTargetAtTime(0.0001, t, 0.05); tg.connect(g);
      osc("sine", f * 7.1, t, t + 0.2, tg); // 打った瞬間の金属の響き
    }
    function cymbal(dest, t, vel, dur, hp) {
      const g = voice(dest, 0.2);
      g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      noise(t, dur + 0.05, filt("highpass", hp || 6500, 0.6, g));
    }
    function kick(dest, t, vel) {
      const g = voice(dest, 0);
      g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      const o = osc("sine", 150, t, t + 0.4, g);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    }
    function snare(dest, t, vel) {
      const g = voice(dest, 0.2);
      g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      noise(t, 0.2, filt("bandpass", 1900, 0.8, g));
      const tg = ctx.createGain(); tg.gain.setValueAtTime(vel * 0.7, t); tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09); tg.connect(dest);
      osc("triangle", 190, t, t + 0.1, tg);
    }
    function synth(dest, type, m, t, dur, vel, o) {
      o = o || {};
      const g = voice(dest, o.wet === undefined ? 0.25 : o.wet), end = t + dur;
      env(g, t, o.attack || 0.005, vel, o.decay || 0.25, o.sustain === undefined ? 0.6 : o.sustain, o.rel || 0.08, end);
      const lp = filt("lowpass", o.lp || 3200, o.q || 0.8, g);
      for (const det of o.detune || [0]) { const x = osc(type, hz(m), t, end + 0.6, lp); x.detune.value = det; }
    }

    // 弦の伴奏: ずらした2つのノコギリ波をやわらかく削り、ゆっくり出し入れ（short は刻み）。揺れは1つの発振器を使い回す
    let vibLfo = null;
    function strings(dest, notes, t, dur, vel, short) {
      if (!vibLfo) {
        const o = ctx.createOscillator(); vibLfo = ctx.createGain();
        o.frequency.value = 5; vibLfo.gain.value = 4; o.connect(vibLfo); o.start(0);
      }
      for (const m of notes) {
        const g = voice(dest, 0.5), end = t + dur, v = vel / Math.sqrt(notes.length);
        if (short) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.setTargetAtTime(0.0001, t + 0.05, dur / 3); }
        else env(g, t, Math.min(0.7, dur * 0.3), v, 1, 1, 0.6, end);
        const lp = filt("lowpass", short ? 2600 : 1900, 0.5, g);
        for (const det of [-8, 8]) { const x = osc("sawtooth", hz(m), t, end + (short ? 0.15 : 1), lp); x.detune.value = det; vibLfo.connect(x.detune); }
      }
    }


    // ---------- 曲 ----------
    /** 音階の中を、前の音から近い音へ進む旋律を作る。 */
    function melody(seed, scale, chordsTones, rhythm, lo, hi) {
      const r = mkRng(seed), pool = [];
      for (let m = lo; m <= hi; m++) if (scale.includes(((m % 12) + 12) % 12)) pool.push(m);
      let i = Math.floor(pool.length / 2);
      return chordsTones.map((tones, bar) => (rhythm[bar] || []).map(([beat, len], k) => {
        if (k === 0 || r() < 0.35) { // 小節の頭は和音の音へ
          const cand = pool.map((m, j) => [m, j]).filter(([m]) => tones.includes(m % 12));
          cand.sort((a, b) => Math.abs(a[1] - i) - Math.abs(b[1] - i));
          if (cand.length) i = cand[Math.min(cand.length - 1, r() < 0.7 ? 0 : 1)][1];
        } else {
          const step = [-2, -1, -1, 1, 1, 2][Math.floor(r() * 6)];
          i = Math.max(0, Math.min(pool.length - 1, i + step));
        }
        return { beat, len, m: pool[i] };
      }));
    }
    const pc = ms => ms.map(m => m % 12);

    // BGM（本人決定 2026-11-22。3回の聞き比べで選んだオルゴールの案。外れた案は仕様書 6.9章）
    const STYLE = (() => {
      // ふだんは G メジャー、リーチは E マイナー
      const nBass = [43, 40, 36, 38, 43, 40, 36, 38];
      const nCh = [[59, 62, 66, 67], [59, 62, 64, 67], [59, 64, 67, 72], [57, 62, 66, 69], [59, 62, 66, 67], [59, 62, 64, 67], [60, 64, 67, 71], [57, 60, 62, 66]];
      const gmaj = [7, 9, 11, 0, 2, 4, 6];
      const nMel = melody(13, gmaj, nCh.map(pc),
        [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 1], [3, 1]], [[0, 4]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 1], [1, 1], [2, 1], [3, 1]], [[0, 4]]], 79, 91);
      const rBass = [40, 36, 38, 35, 40, 36, 38, 35];
      const rCh = [[64, 67, 71], [60, 64, 67], [62, 66, 69], [59, 63, 66], [64, 67, 71], [60, 64, 67], [62, 66, 69], [59, 63, 66, 69]];
      const sineBass = (d, m, t, len, vel) => synth(d, "sine", m, t, len, vel, { attack: 0.02, decay: 1.5, sustain: 0.5, rel: 0.3, lp: 900, wet: 0.1 });
      return {
        // エレピの和音・鈴の旋律・シェイカーとごく弱いキック。リーチは速い鈴の分散和音と弦
        chime: {
          normal: {
            bpm: 96, bars: 8,
            bar(k, t, B, d) {
              for (let i = 0; i < 8; i++) cymbal(d, t + i * 0.5 * B, i % 2 ? 0.012 : 0.02, 0.06, 7000);
              kick(d, t, 0.12);
              sineBass(d, nBass[k], t, B * 3.5, 0.22);
              for (const m of nCh[k]) epiano(d, m, t, B * 3.6, 0.05);
              for (const n of nMel[k]) bell(d, n.m, t + n.beat * B, 0.07, { ratio: 5, index: 0.6, dur: 1.4 });
            },
          },
          riichi: {
            bpm: 132, bars: 8,
            bar(k, t, B, d) {
              kick(d, t, 0.3); kick(d, t + 2 * B, 0.3); kick(d, t + 2.75 * B, 0.15);
              snare(d, t + B, 0.08); snare(d, t + 3 * B, 0.08);
              for (let i = 0; i < 16; i++) cymbal(d, t + i * 0.25 * B, i % 2 ? 0.012 : 0.022, 0.05, 7000);
              sineBass(d, rBass[k], t, B * 1.8, 0.28); sineBass(d, rBass[k], t + 2 * B, B * 1.8, 0.24);
              const ch = rCh[k];
              for (let i = 0; i < 16; i++) bell(d, ch[i % ch.length] + 12, t + i * 0.25 * B, 0.05, { ratio: 3, index: 0.4, dur: 0.5 });
              strings(d, ch.map(m => m - 12), t, B * 4, 0.07);
            },
          },
        },
      };
    })();

    // ---------- 効果音 ----------
    // 短く（本人の注文 2026-11-22「鳴る時間が長い。もっと短く」）。残響も BGM より少なくする。長さは tools/sound-render.js が測る
    function seDiscard(t) { // 牌を河に置く「タン」
      const g = voice(seBus, 0.15);
      g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      noise(t, 0.08, filt("bandpass", 2300, 1.6, g));
      const tg = ctx.createGain(); tg.gain.setValueAtTime(0.45, t); tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.06); tg.connect(seBus);
      const o = osc("sine", 1450, t, t + 0.07, tg); o.frequency.exponentialRampToValueAtTime(900, t + 0.05);
    }
    const B5 = { ratio: 5, index: 0.6, wet: 0.12 }; // 効果音の鈴
    const SE = { // オルゴールの系統の鈴
      call(t) { bell(seBus, 84, t, 0.22, { ...B5, dur: 0.3 }); bell(seBus, 91, t + 0.07, 0.2, { ...B5, dur: 0.3 }); },
      riichi(t) { [76, 79, 83, 88].forEach((m, i) => bell(seBus, m, t + i * 0.06, 0.2, { ...B5, dur: 0.4 })); },
      win(t) { [79, 83, 86, 91, 95].forEach((m, i) => bell(seBus, m, t + i * 0.06, 0.15, { ...B5, dur: 0.55 })); for (const m of [55, 67, 71, 74]) epiano(seBus, m, t + 0.3, 0.3, 0.12, 0.1); },
      ryukyoku(t) { [79, 76, 71].forEach((m, i) => bell(seBus, m, t + i * 0.14, 0.18, { ...B5, dur: 0.35 })); },
      start(t) { bell(seBus, 91, t, 0.16, { ...B5, dur: 0.35 }); },
      end(t) { for (const m of [55, 67, 71, 74, 78]) epiano(seBus, m, t, 0.6, 0.12, 0.1); bell(seBus, 91, t, 0.16, { ...B5, dur: 0.7 }); },
    };

    let style = STYLE[styleName] ? styleName : "chime";
    /** BGM の1回の流れ。start から mode の曲を、until まで予約する（何度呼んでもよい。予約済みの小節は飛ばす）。 */
    function track(mode, start, level) {
      const song = STYLE[style][mode], B = 60 / song.bpm, barLen = B * 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start); g.gain.linearRampToValueAtTime(level === undefined ? 1 : level, start + 0.6);
      g.connect(bgmBus);
      let next = 0; // 次に予約する小節の番号
      return {
        mode, g,
        schedule(until) {
          while (start + next * barLen < until) {
            song.bar(next % song.bars, start + next * barLen, B, g);
            next++;
          }
        },
        fade(t, dur) {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
          g.gain.linearRampToValueAtTime(0.0001, t + (dur || 0.8));
          setTimeout(() => { try { g.disconnect(); } catch (e) { /* もう外れている */ } }, ((dur || 0.8) + 0.5) * 1000 + Math.max(0, (t - ctx.currentTime) * 1000));
        },
      };
    }
    return {
      out, bgmBus, seBus,
      get style() { return style; },
      setStyle(s) { if (STYLE[s]) style = s; },
      track,
      se(name, t) {
        if (name === "discard") return seDiscard(t);
        const f = SE[name];
        if (f) f(t);
      },
    };
  }

  // ---------- ページで鳴らす側 ----------
  const STYLES = ["chime"];
  const LEVELS = ["all", "se", "off"];
  let ctx = null, eng = null, styleName = "chime", level = "all", want = null, cur = null, timer = 0;
  const lastSe = new Map(); // 同じ効果音を短い間に重ねない

  function unlock() {
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    if (!ctx) {
      try { ctx = new AC(); } catch (e) { return; }
      eng = engine(ctx, styleName);
      eng.out.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().then(sync, () => {});
    sync();
  }
  function sync() {
    if (!ctx || ctx.state !== "running") return;
    const mode = level === "all" ? want : null;
    if ((cur && cur.mode) === mode && (!cur || cur.style === styleName)) return;
    const t = ctx.currentTime + 0.05;
    if (cur) { cur.tr.fade(t, 0.8); cur = null; }
    if (mode) {
      eng.setStyle(styleName);
      cur = { mode, style: styleName, tr: eng.track(mode, t) };
      cur.tr.schedule(t + 0.5);
    }
    if (cur && !timer) timer = setInterval(tick, 100);
    if (!cur && timer) { clearInterval(timer); timer = 0; }
  }
  function tick() {
    if (!cur || !ctx) return;
    cur.tr.schedule(ctx.currentTime + 0.6);
  }
  const Sound = {
    STYLES, LEVELS, engine,
    unlock,
    get style() { return styleName; },
    get level() { return level; },
    /** いま鳴っている BGM（"normal" / "riichi" / null）と音の機能の状態。確かめる用 */
    get playing() { return cur ? cur.mode : null; },
    get state() { return ctx ? ctx.state : "none"; },
    setStyle(s) { if (STYLES.includes(s)) { styleName = s; sync(); } },
    setLevel(l) { if (LEVELS.includes(l)) { level = l; sync(); } },
    bgm(mode) { want = mode || null; sync(); },
    se(name) {
      if (!ctx || ctx.state !== "running" || level === "off") return;
      const now = ctx.currentTime;
      if (now - (lastSe.get(name) || -1) < 0.06) return;
      lastSe.set(name, now);
      eng.setStyle(styleName);
      eng.se(name, now + 0.01);
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Sound;
  else root.Sound = Sound;
})(typeof window !== "undefined" ? window : globalThis);
