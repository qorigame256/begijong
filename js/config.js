/*
 * config.js — 置き場所ごとに変わる値。
 *   relay: 中継所（relay/ を Cloudflare に置いたもの）の住所。"wss://…" の形。空のときは「部屋を作る」を出さない。
 *          この PC の中で開いたとき（localhost）は、空なら ws://localhost:8787（relay/ で npx wrangler dev）を使う。
 */
window.SETTAI_CONFIG = {
  relay: "",
};
