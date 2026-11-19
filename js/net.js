/*
 * net.js — 中継所（relay/）とつなぐ。切れたら自動でつなぎ直す。ブラウザでは window.Net。
 *
 *   n = Net.open({ url, room, role: "host" | "guest", id, key（部屋主だけ）, onStatus, onReady, onSys, onData });
 *   n.send(d, to)   部屋主: to の参加者（"*" は全員）へ d を送る。参加者: 部屋主へ d を送る（to は使わない）。
 *                   つながっていない間に送ったものは捨てる（つなぎ直したあと、部屋主がいまの状態を送り直す）。
 *   n.sys(msg)      中継所への指示（部屋主の { sys: "close" } = 部屋を閉じる）
 *   n.close()
 *
 *   onStatus("connecting" | "open" | "retry")、または onStatus("error", code)。error のあとはつなぎ直さない。
 *     code: noroom（部屋が無い）・taken（その名前の部屋は別の部屋主のもの）・full・closed（部屋主が閉じた）・replaced（同じ id で別の画面がつないだ）・bad
 *   onReady(msg)    中継所に入れた（つなぎ直すたびに呼ぶ）。部屋主には msg.guests（いまいる参加者の id）、参加者には msg.host（部屋主がいるか）
 *   onSys(msg)      部屋主へ { sys: "join" | "leave", id }、参加者へ { sys: "host", on }
 *   onData(d, from) 相手が send した d（部屋主には from = 参加者の id）
 */
(function (root) {
  "use strict";
  const PING_MS = 25000;

  function open(o) {
    let ws = null, ready = false, closed = false, fatal = null, tries = 0, timer = null, ping = null;

    function connect() {
      const sock = new WebSocket(`${o.url}/room/${o.room}?role=${o.role}`);
      ws = sock;
      o.onStatus(tries ? "retry" : "connecting");
      sock.onopen = () => sock.send(JSON.stringify({ sys: "hello", id: o.id, key: o.key }));
      sock.onmessage = ev => {
        if (sock !== ws || closed || ev.data === "pong") return;
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || typeof m !== "object") return;
        if (m.sys === "ready") { ready = true; tries = 0; o.onStatus("open"); o.onReady(m); }
        else if (m.sys === "error") fatal = String(m.code);
        else if (m.sys) o.onSys(m);
        else o.onData(m.d, m.from);
      };
      sock.onclose = () => {
        if (sock !== ws) return;
        ready = false;
        clearInterval(ping);
        if (closed) return;
        if (fatal) { closed = true; return o.onStatus("error", fatal); }
        tries++;
        o.onStatus("retry");
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(tries, 4)));
      };
      clearInterval(ping);
      ping = setInterval(() => { if (sock.readyState === 1) sock.send("ping"); }, PING_MS);
    }
    function raw(obj) {
      if (!ready || !ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    }
    connect();
    return {
      send: (d, to) => raw(o.role === "host" ? { to, d } : { d }),
      sys: msg => raw(msg),
      close() {
        closed = true;
        clearTimeout(timer);
        clearInterval(ping);
        if (ws) ws.close();
      },
    };
  }

  root.Net = { open };
})(typeof self !== "undefined" ? self : this);
