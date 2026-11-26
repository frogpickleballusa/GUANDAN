// Server-side table logic. Pure: takes the stored room + full game state and one request,
// returns the new room, full state and per-seat private hands. Runs in Node (tests) and Deno (edge function).
(function (C) {
  const GD = typeof module !== 'undefined' && typeof require !== 'undefined' ? require('./engine.js') : globalThis.GD;
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const TIMERS = [0, 10, 15, 20, 30, 45, 60];
  const clone = x => JSON.parse(JSON.stringify(x));
  const cleanName = v => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  const strip = x => { const c = clone(x); delete c.prev; delete c.undoReq; return c; };

  // The person who creates a table is its host and sits in seat 1 straight away.
  function newRoom(code, uid, name) {
    const seats = Array(8).fill(null);
    seats[0] = { uid, name: cleanName(name) };
    return { code, cfg: { n: 6, levels: [2, 2], decl: 0, host: uid, timer: 20 }, seats, pub: null };
  }

  // Public view of the game: everything except hands, the undo snapshot and tribute options.
  function publicView(full) {
    if (!full) return null;
    const p = clone(full);
    p.counts = Object.keys(full.hands).sort((a, b) => a - b).map(k => full.hands[k].length);
    delete p.hands; delete p.prev;
    p.hasPrev = !!full.prev;
    p.tribute = (full.tribute || []).map(t => {
      if (typeof t !== 'object') return t;
      const { opts, ...rest } = t; return { ...rest, choosing: !!opts };
    });
    return p;
  }
  function privateHands(full) {
    if (!full) return [];
    const out = [];
    for (let i = 0; i < full.n; i++) {
      const t = (full.tribute || []).find(x => typeof x === 'object' && x.from === i && !x.gave && x.opts);
      out.push({ seat: i, uid: full.uids[i], cards: full.hands[i], opts: t ? t.opts : null });
    }
    return out;
  }

  // req: {action, ...}; returns {room, full, err}
  function handle(req, uid, room0, full0, now) {
    if (!uid) return { err: 'Not signed in.' };
    const room = room0 ? clone(room0) : null, full = full0 ? clone(full0) : null;
    const a = req.action;
    if (!room) return { err: 'Table not found. Check the code.' };
    const n = room.cfg.n;
    const mine = room.seats.map((s, i) => (s && s.uid === uid ? i : -1)).filter(i => i >= 0);
    const gameOn = !!full && full.phase !== 'over';
    const res = (r, f) => ({ room: r, full: f });
    const ownsSeat = seat => !!full && Number.isInteger(seat) && full.uids[seat] === uid;

    switch (a) {
      case 'sit': {
        const i = req.seat;
        if (full) return { err: 'A game is already running at this table.' };
        if (!Number.isInteger(i) || i < 0 || i >= n) return { err: 'No such seat.' };
        if (room.seats[i] && room.seats[i].uid !== uid) return { err: 'That seat is taken.' };
        mine.forEach(j => { room.seats[j] = null; });
        room.seats[i] = { uid, name: cleanName(req.name) };
        return res(room, full);
      }
      case 'stand':
        if (full) return { err: 'You cannot stand up during a game.' };
        mine.forEach(j => { room.seats[j] = null; });
        return res(room, full);
      case 'fill':
        if (full) return { err: 'A game is already running.' };
        for (let i = 0; i < n; i++) if (!room.seats[i]) room.seats[i] = { uid, name: 'Me ' + (i + 1) };
        return res(room, full);
      case 'rename':
        mine.forEach(j => { room.seats[j].name = cleanName(req.name); });
        return res(room, full);
      case 'cfg': {
        if (full) return { err: 'Setup is locked while a game is running.' };
        if (!mine.length && room.cfg.host !== uid) return { err: 'Take a seat to change the setup.' };
        const c = req.cfg || {};
        const nn = [4, 6, 8].includes(c.n) ? c.n : room.cfg.n;
        room.cfg = {
          n: nn,
          levels: [RANKS.includes(c.levels?.[0]) ? c.levels[0] : 2, RANKS.includes(c.levels?.[1]) ? c.levels[1] : 2],
          decl: c.decl === 1 ? 1 : 0,
          host: room.cfg.host || uid,
          timer: TIMERS.includes(c.timer) ? c.timer : room.cfg.timer,
        };
        for (let i = nn; i < 8; i++) room.seats[i] = null;
        return res(room, full);
      }
      case 'start': {
        if (gameOn) return { err: 'A game is already running.' };
        if (!mine.length) return { err: 'Take a seat first.' };
        const sv = room.seats.slice(0, n);
        if (sv.some(s => !s)) return { err: 'Every seat needs a player.' };
        const g = GD.newGame(sv.map((s, i) => s.name || 'Player ' + (i + 1)), sv.map(s => s.uid), room.cfg.levels, room.cfg.decl, room.cfg.timer);
        g.host = sv.some(s => s.uid === room.cfg.host) ? room.cfg.host : sv[0].uid;
        g.turnAt = now;
        return res(room, g);
      }
      case 'toLobby':
        if (!full || full.phase !== 'over') return { err: 'The game is not over yet.' };
        if (!mine.length) return { err: 'Take a seat first.' };
        return res(room, null);
    }

    if (!full) return { err: 'No game is running.' };
    const seat = req.seat;
    const commit = () => { full.turnAt = now; return res(room, full); };

    switch (a) {
      case 'play':
      case 'pass': {
        if (!ownsSeat(seat)) return { err: 'That is not your seat.' };
        if (full.undoReq) return { err: 'Paused while the host decides on a take-back.' };
        const before = strip(full);
        const err = a === 'play' ? GD.play(full, seat, Array.isArray(req.ids) ? req.ids.map(String) : []) : GD.pass(full, seat);
        if (err) return { err };
        full.prev = before; full.prevSeat = seat; full.timedOut = null;
        return commit();
      }
      case 'timeout': {
        if (!full.uids.includes(uid)) return { err: 'Only players can do that.' };
        if (full.phase !== 'play' || full.turn !== seat || full.undoReq) return { err: 'stale' };
        const secs = typeof full.timer === 'number' ? full.timer : 20;
        if (!secs) return { err: 'The timer is off.' };
        if (full.hand === 1 && !full.log?.length && !full.last) return { err: 'No timer on the first turn.' };
        if (now - (full.turnAt || 0) < secs * 1000 - 1500) return { err: 'stale' };
        const before = strip(full);
        const err = GD.timeout(full, seat);
        if (err) return { err };
        full.prev = before; full.prevSeat = seat; full.timedOut = seat;
        return commit();
      }
      case 'pay':
      case 'giveBack': {
        if (!ownsSeat(seat)) return { err: 'That is not your seat.' };
        const err = a === 'pay' ? GD.pay(full, seat, String(req.id)) : GD.giveBack(full, seat, String(req.id));
        if (err) return { err };
        delete full.prev; delete full.undoReq;
        return commit();
      }
      case 'askUndo': {
        if (!full.prev || full.undoReq || !ownsSeat(full.prevSeat)) return { err: 'Nothing to take back.' };
        if (full.host === uid) { const g = { ...full.prev, host: full.host }; g.turnAt = now; return res(room, g); }
        full.undoReq = { seat: full.prevSeat };
        return res(room, full);
      }
      case 'approveUndo': {
        if (full.host !== uid) return { err: 'Only the host can approve.' };
        if (!full.undoReq || !full.prev) return { err: 'Nothing to approve.' };
        const g = { ...full.prev, host: full.host }; g.turnAt = now;
        return res(room, g);
      }
      case 'denyUndo':
        if (full.host !== uid) return { err: 'Only the host can deny.' };
        delete full.undoReq;
        return commit();
      case 'nextHand':
        if (full.phase !== 'done' || full.undoReq) return { err: 'Not ready for the next hand.' };
        if (!full.uids.includes(uid)) return { err: 'Only players can deal.' };
        GD.nextHand(full); delete full.prev;
        return commit();
    }
    return { err: 'Unknown action.' };
  }

  Object.assign(C, { handle, newRoom, publicView, privateHands });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.CORE = {}));
