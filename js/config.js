/*
 * config.js — 置き場所ごとに変わる値。
 *   relay: 中継所（relay/ を Cloudflare に置いたもの）の住所。"wss://…" の形。空のときは「部屋を作る」を出さない。
 *          この PC の中で開いたとき（localhost）は、空なら ws://localhost:8787（relay/ で npx wrangler dev）を使う。
 *          localhost では URL の ?relay=<住所> がこの値より優先する（例 ?relay=ws://localhost:8787 でこの PC の中継所につなぐ）。
 *   mortal: 麻雀 AI「Mortal」の箱（tools/mortal/bridge.py）の住所。部屋主の PC の中で動かす。
 *          localhost で開いたときと、URL に ?mortal を付けて開いたあと（覚えておく。?mortal=0 で忘れる）だけ、つながるかを確かめる
 *          （公開サイトの全員がこの PC の中の住所を見に行かないように）。
 */
window.SETTAI_CONFIG = {
  relay: "wss://begijong-relay.begijong-relay.workers.dev",
  mortal: "http://127.0.0.1:8792",
};
