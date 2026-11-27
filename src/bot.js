// Simple bot player. Sees only its own hand and the public table.
(function (B) {
  const GD = typeof module !== 'undefined' && typeof require !== 'undefined' ? require('./engine.js') : globalThis.GD;
  const BOT_PREFIX = '00000000-0000-4000-8000-0000000000b';
  const isBot = uid => typeof uid === 'string' && uid.startsWith(BOT_PREFIX);
  const botUid = i => BOT_PREFIX + i;

  // Every reasonable combination the hand can make, each as a list of card ids.
  function candidates(hand, L) {
    const P = GD.P, out = [];
    const nat = {}, jok = { 16: [], 17: [] }, wild = [];
    hand.forEach(id => {
      const c = P(id);
      if (c.s === 'J') jok[c.r].push(id);
      else if (GD.isWild(c, L)) wild.push(id);
      else (nat[c.r] = nat[c.r] || []).push(id);
    });
    const ranks = Object.keys(nat).map(Number);
    const groups = ranks.map(r => ({ r, ids: nat[r] }));
    [16, 17].forEach(r => { if (jok[r].length) groups.push({ r, ids: jok[r], joker: true }); });
    for (const g of groups) {
      for (let n = 1; n <= Math.min(3, g.ids.length); n++) out.push({ ids: g.ids.slice(0, n), breaks: g.ids.length >= 4 && n < g.ids.length });
      if (!g.joker && g.ids.length >= 4) for (let n = 4; n <= g.ids.length; n++) out.push({ ids: g.ids.slice(0, n), bomb: true });
    }
    if (wild.length) out.push({ ids: [wild[0]], wild: true });
    // full houses
    for (const t of groups) for (const p of groups) {
      if (t === p || t.joker || t.ids.length < 3 || p.ids.length < 2) continue;
      if (p.joker && p.ids.length < 2) continue;
      out.push({ ids: [...t.ids.slice(0, 3), ...p.ids.slice(0, 2)], breaks: t.ids.length >= 4 || p.ids.length >= 4 });
    }
    // runs: straights, tubes (3 pairs), plates (2 triples), using natural cards only
    const has = (r, n) => (nat[r === 1 ? 14 : r] || []).length >= n;
    const take = (r, n) => nat[r === 1 ? 14 : r].slice(0, n);
    const runs = (len, w) => {
      for (let s = 1; s + len - 1 <= 14; s++) {
        const rs = Array.from({ length: len }, (_, k) => s + k);
        if (rs.every(r => has(r, w))) out.push({ ids: rs.flatMap(r => take(r, w)), breaks: rs.some(r => (nat[r === 1 ? 14 : r] || []).length >= 4) });
      }
    };
    runs(5, 1); runs(3, 2); runs(2, 3);
    // joker bomb
    if (jok[16].length + jok[17].length > 0) out.push({ ids: [...jok[16], ...jok[17]], kb: true });
    return out;
  }

  // Choose a play for `seat` (or null to pass). Uses only the bot's own hand, the table and card counts.
  // level 'medium' plays its own hand well; 'hard' also plays for its team (feeds a teammate who is
  // nearly out, avoids handing an opponent the shape they can go out on, and blocks opponents harder).
  function decide(S, seat, level) {
    if (level === 'hard') return decideHard(S, seat);
    return decideMedium(S, seat);
  }
  function decideMedium(S, seat) {
    const hand = S.hands[seat], L = S.L, n = S.n;
    const table = S.last ? S.last.c : null;
    const team = GD.team;
    const cands = candidates(hand, L)
      .map(x => ({ ...x, c: GD.choose(x.ids, L, table, n) }))
      .filter(x => x.c);
    if (!cands.length) return null;
    const cost = x => (x.c.p ? 1000 + x.c.p * 10 + x.c.v : 0) + (x.breaks ? 300 : 0) + (x.wild ? 200 : 0) + x.c.v;
    if (!table) {
      // leading: get rid of the lowest cards first, preferring bigger shapes at the same low rank
      const plain = cands.filter(x => !x.c.p);
      const pool = plain.length ? plain : cands;
      pool.sort((a, b) => (cost(a) - cost(b)) || (b.ids.length - a.ids.length));
      const lowV = pool[0].c.v;
      const same = pool.filter(x => x.c.v <= lowV + 1 && !x.breaks && !x.wild).sort((a, b) => b.ids.length - a.ids.length);
      return (same[0] || pool[0]).ids;
    }
    const partnerOnTable = team(S.last.seat) === team(seat);
    if (partnerOnTable) {
      // don't beat a teammate unless it finishes our hand
      const out = cands.find(x => x.ids.length === hand.length);
      return out ? out.ids : null;
    }
    const plain = cands.filter(x => !x.c.p).sort((a, b) => cost(a) - cost(b));
    if (plain.length && !(plain[0].breaks && plain[0].c.v >= 14 && hand.length > 8)) return plain[0].ids;
    // bomb only when the opponent is close to going out, or we are
    const oppCards = S.hands[S.last.seat].length;
    const bombs = cands.filter(x => x.c.p).sort((a, b) => cost(a) - cost(b));
    if (bombs.length && (oppCards <= 10 || hand.length <= 8 || bombs[0].ids.length === hand.length)) return bombs[0].ids;
    return null;
  }

  function decideHard(S, seat) {
    const hand = S.hands[seat], L = S.L, n = S.n, team = GD.team;
    const table = S.last ? S.last.c : null;
    const live = i => S.hands[i].length > 0;
    const mates = [], opps = [];
    for (let i = 0; i < n; i++) if (i !== seat && live(i)) (team(i) === team(seat) ? mates : opps).push(i);
    const mateMin = mates.length ? Math.min(...mates.map(i => S.hands[i].length)) : 99;
    // tuned in bot-vs-bot games: feed only a teammate on their last card; guard against opponents on 1 card
    // (or 1-2 cards in 4-player games, where only one opponent sits between partners)
    const SAFE_MAX = n === 4 ? 2 : 1, FEED_MAX = 1;
    const oppSizes = new Set(opps.map(i => S.hands[i].length).filter(k => k <= SAFE_MAX));
    const cands = candidates(hand, L).map(x => ({ ...x, c: GD.choose(x.ids, L, table, n) })).filter(x => x.c);
    if (!cands.length) return null;
    const cost = x => (x.c.p ? 1000 + x.c.p * 10 + x.c.v : 0) + (x.breaks ? 300 : 0) + (x.wild ? 200 : 0) + x.c.v;
    const finishing = cands.find(x => x.ids.length === hand.length);
    if (finishing) return finishing.ids;                       // going out always comes first
    const simple = x => !x.c.p && ['1', '2', '3'].includes(x.c.t);
    if (!table) {
      // a teammate is on their last card: lead our lowest single so they can go out
      if (mateMin <= FEED_MAX) {
        const feed = cands.filter(x => simple(x) && x.ids.length === mateMin).sort((a, b) => a.c.v - b.c.v || (a.breaks - b.breaks));
        if (feed.length) return feed[0].ids;
      }
      // don't lead a shape an opponent could go out on
      const plain = cands.filter(x => !x.c.p);
      const safe = plain.filter(x => !(oppSizes.has(x.ids.length) && simple(x)));
      if (safe.length) {
        safe.sort((a, b) => (cost(a) - cost(b)) || (b.ids.length - a.ids.length));
        const lowV = safe[0].c.v;
        const same = safe.filter(x => x.c.v <= lowV + 1 && !x.breaks && !x.wild).sort((a, b) => b.ids.length - a.ids.length);
        return (same[0] || safe[0]).ids;
      }
      // only risky shapes left: lead the highest one so it is hard to beat
      const pool = (plain.length ? plain : cands).sort((a, b) => b.c.v - a.c.v);
      return pool[0].ids;
    }
    const lastSeat = S.last.seat;
    if (team(lastSeat) === team(seat)) return null;            // never take a trick from a teammate
    // the player who just played is close to going out: beat it, even breaking pairs or bombing
    const threat = S.hands[lastSeat].length <= 3 && !mates.some(i => S.hands[i].length < S.hands[lastSeat].length);
    const plain = cands.filter(x => !x.c.p).sort((a, b) => cost(a) - cost(b));
    if (threat) {
      if (plain.length) return plain[0].ids;
      const bombs = cands.filter(x => x.c.p).sort((a, b) => cost(a) - cost(b));
      if (bombs.length) return bombs[0].ids;
      return null;
    }
    // a teammate is nearly out and could win the lead after us: take tricks cheaply so we can feed them
    if (plain.length && !(plain[0].breaks && plain[0].c.v >= 14 && hand.length > 8)) return plain[0].ids;
    const oppCards = S.hands[lastSeat].length;
    const bombs = cands.filter(x => x.c.p).sort((a, b) => cost(a) - cost(b));
    if (bombs.length && (oppCards <= 10 || hand.length <= 8 || mateMin <= 3)) return bombs[0].ids;
    return null;
  }

  // Apply every pending bot action that is due right now. Returns true if anything changed.
  function act(S) {
    let changed = false;
    if (S.phase === 'return') {
      for (const t of S.tribute) {
        if (typeof t !== 'object') continue;
        if (!t.gave && isBot(S.uids[t.from])) { GD.pay(S, t.from, t.opts[0]); changed = true; }
      }
      for (const t of S.tribute) {
        if (typeof t !== 'object') continue;
        if (t.gave && !t.back && isBot(S.uids[t.to])) {
          const r = GD.sortHand(GD.returnable(S, t.to), S.L);
          GD.giveBack(S, t.to, r[r.length - 1]); changed = true;
        }
      }
      return changed;
    }
    if (S.phase === 'play' && isBot(S.uids[S.turn])) {
      const seat = S.turn, ids = decide(S, seat, (S.botLevels || [])[seat] || 'medium');
      let err = ids ? GD.play(S, seat, ids) : (S.last ? GD.pass(S, seat) : 'lead');
      if (err) {   // safety net: lowest single, or pass
        err = S.last ? GD.pass(S, seat) : GD.play(S, seat, [GD.sortHand(S.hands[seat], S.L).pop()]);
      }
      return !err;
    }
    return false;
  }

  Object.assign(B, { isBot, botUid, decide, act, candidates });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.BOT = {}));
