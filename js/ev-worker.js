/*
 * ev-worker.js — 期待値の計算をブラウザの裏で行う（仕様書 6章⑬）。ui.js が new Worker で起こす。
 * 計算は mj_engine.js（../麻雀分析/tools/mj_engine.js の写し）の evaluateDiscards。重い計算（数秒かかることがある）で画面を止めないため、ここで行う。
 *   受け取る: {id, input, exclude}（input と exclude は assist.js の evInput の形）
 *   返す: {id, ok: true, candidates: [{index, red, ev, win, choice}], tooMany} または {id, ok: false}
 */
importScripts("mj_engine.js");

self.onmessage = e => {
  const { id, input, exclude } = e.data || {};
  try {
    const res = self.MJ.evaluateDiscards(input, { exclude });
    self.postMessage({
      id, ok: true, tooMany: !!res.tooMany,
      candidates: res.candidates.map(c => ({ index: c.index, red: c.red, ev: c.ev, win: c.win, choice: c.choice })),
    });
  } catch (err) {
    self.postMessage({ id, ok: false });
  }
};
