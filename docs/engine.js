// Guandan rules engine for 4, 6 or 8 players: two teams sitting alternately,
// one deck per two players, 27 cards each. Pure functions over plain JSON state.
(function (G) {
  const SUITS = ['S', 'H', 'C', 'D'];
  const P = id => ({ id, d: id[0], s: id[1], r: +id.slice(2) });
  const team = i => i % 2;
  const ov = (r, L) => (r === L ? 15 : r);
  const isWild = (c, L) => c.s === 'H' && c.r === L;
  const seq0 = n => Array.from({ length: n }, (_, i) => i);

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function deck(decks) {
    const out = [];
    for (let d = 0; d < decks; d++) {
      for (const s of SUITS) for (let r = 2; r <= 14; r++) out.push(`${d}${s}${r}`);
      out.push(`${d}J16`, `${d}J17`);
    }
    return out;
  }
  function sortHand(ids, L) {
    return ids.slice().sort((a, b) => {
      const A = P(a), B = P(b);
      const wa = isWild(A, L) ? 1 : 0, wb = isWild(B, L) ? 1 : 0;
      return ov(B.r, L) - ov(A.r, L) || wb - wa || SUITS.indexOf(A.s) - SUITS.indexOf(B.s) || (a < b ? -1 : 1);
    });
  }

  // Every legal reading of a set of cards. nj = jokers in play (= players).
  function analyze(ids, L, nj) {
    const cs = ids.map(P), n = cs.length, out = [];
    if (!n) return out;
    const J = cs.filter(c => c.s === 'J');
    const nat = cs.filter(c => c.s !== 'J' && !isWild(c, L));
    const cnt = {};
    nat.forEach(c => { cnt[c.r] = (cnt[c.r] || 0) + 1; });
    const ranks = Object.keys(cnt).map(Number);
    if (n === 1) return [{ t: '1', n, v: ov(cs[0].r, L), p: 0 }];
    if (J.length) {
      if (J.length === n) {
        const sm = J.filter(c => c.r === 16).length;
        if (n === nj) out.push({ t: 'kb', n, v: 99, p: 1000 });
        else if ((n === 2 || n === 3) && (sm === 0 || sm === n)) out.push({ t: String(n), n, v: J[0].r, p: 0 });
      }
      if (n === 5 && J.length === 2 && J[0].r === J[1].r && ranks.length <= 1) {
        out.push({ t: 'fh', n, v: ov(ranks.length ? ranks[0] : L, L), p: 0 });
      }
      return out;
    }
    if (ranks.length <= 1) {
      const v = ov(ranks.length ? ranks[0] : L, L);
      if (n === 2 || n === 3) out.push({ t: String(n), n, v, p: 0 });
      else if (n >= 4) out.push({ t: 'bomb', n, v, p: n * 10 });
    }
    if (n === 5) {
      const cand = [...new Set([...ranks, L])];
      let best = 0;
      for (const t of cand) for (const q of cand) {
        if (t === q || ranks.some(r => r !== t && r !== q)) continue;
        if ((cnt[t] || 0) > 3 || (cnt[q] || 0) > 2) continue;
        best = Math.max(best, ov(t, L));
      }
      if (best) out.push({ t: 'fh', n, v: best, p: 0 });
    }
    const seq = (k, w, type) => {
      for (let s = 1; s + k - 1 <= 14; s++) {
        const top = s + k - 1;
        const pos = r => (r >= s && r <= top) ? r : (r === 14 && s === 1 ? 1 : 0);
        if (ranks.some(r => !pos(r))) continue;
        const per = {};
        ranks.forEach(r => { per[pos(r)] = (per[pos(r)] || 0) + cnt[r]; });
        if (Object.values(per).some(c => c > w)) continue;
        out.push({ t: type, n, v: s, p: 0 });
        if (type === 'st' && new Set(nat.map(c => c.s)).size <= 1) out.push({ t: 'sf', n, v: s, p: 55 });
      }
    };
    if (n === 5) seq(5, 1, 'st');
    if (n === 6) { seq(3, 2, 'tube'); seq(2, 3, 'plate'); }
    return out;
  }

  function beats(a, b) {
    if (!b) return true;
    if (a.p || b.p) return a.p !== b.p ? a.p > b.p : a.v > b.v;
    return a.t === b.t && a.n === b.n && a.v > b.v;
  }
  function choose(ids, L, table, nj) {
    const ok = analyze(ids, L, nj).filter(c => beats(c, table));
    ok.sort((x, y) => y.p - x.p || y.v - x.v);
    return ok[0] || null;
  }

  const active = S => seq0(S.n).filter(i => S.hands[i].length > 0);
  function nextActive(S, i) {
    for (let k = 1; k <= S.n; k++) { const j = (i + k) % S.n; if (S.hands[j].length) return j; }
    return -1;
  }

  // How a finished hand scores: lower total of finishing places wins (tie: team of 1st).
  function score(out) {
    const n = out.length, k = n / 2;
    const sum = t => out.reduce((a, i, x) => a + (team(i) === t ? x + 1 : 0), 0);
    const s0 = sum(0), s1 = sum(1);
    const T = s0 < s1 ? 0 : s1 < s0 ? 1 : team(out[0]);
    const ss = sum(T), min = k * (k + 1) / 2, maxd = Math.floor(n * (n + 1) / 4) - min;
    const d = ss - min;
    const up = d === 0 ? 3 : d <= maxd / 2 ? 2 : 1;
    const payers = up === 3 ? k : Math.max(1, Math.min(up, k - 1));
    return { T, sum: ss, up, payers };
  }

  function deal(S, prev) {
    const cards = shuffle(deck(S.n / 2));
    const hands = {};
    for (let i = 0; i < S.n; i++) hands[i] = cards.slice(i * 27, i * 27 + 27);
    S.hands = hands;
    S.last = null; S.passed = []; S.out = []; S.result = null;
    S.tribute = []; S.log = [];
    let lead = 0;
    if (prev) {
      const L = S.L, out = prev.out, T = prev.T;
      const winners = out.filter(i => team(i) === T).slice(0, prev.payers);
      const give = out.filter(i => team(i) !== T).slice(-prev.payers).reverse();
      const bigJ = give.reduce((n, g) => n + hands[g].filter(id => id.endsWith('J17')).length, 0);
      lead = out[0];
      if (bigJ >= S.n / 2) {
        S.tribute.push('No tribute: the paying side holds all ' + bigJ + ' big jokers.');
      } else {
        // Each payer's highest non-wild value; if it comes in several suits the payer picks which one.
        const top = g => {
          const cand = hands[g].filter(id => !isWild(P(id), L));
          const v = Math.max(...cand.map(id => ov(P(id).r, L)));
          const seen = new Set(), opts = [];
          cand.filter(id => ov(P(id).r, L) === v).forEach(id => { const c = P(id), k = c.s + c.r; if (!seen.has(k)) { seen.add(k); opts.push(id); } });
          return { v, opts };
        };
        const gifts = give.map(g => ({ g, ...top(g) })).sort((x, y) => y.v - x.v);
        gifts.forEach((x, k) => {
          const to = winners[k];
          if (x.opts.length === 1) {
            hands[x.g] = hands[x.g].filter(id => id !== x.opts[0]);
            hands[to].push(x.opts[0]);
            S.tribute.push({ from: x.g, to, gave: x.opts[0], back: null });
          } else {
            S.tribute.push({ from: x.g, to, gave: null, back: null, opts: x.opts });
          }
        });
        lead = gifts[0].g;
      }
    }
    for (let i = 0; i < S.n; i++) S.hands[i] = sortHand(hands[i], S.L);
    S.turn = lead;
    S.phase = S.tribute.some(x => typeof x === 'object' && (!x.gave || !x.back)) ? 'return' : 'play';
    return S;
  }

  function newGame(names, uids, levels, decl, timer) {
    const lv = [levels?.[0] || 2, levels?.[1] || 2], dc = decl === 1 ? 1 : 0;
    return deal({ n: names.length, names, uids, levels: lv, L: lv[dc], decl: dc, hand: 1, log: [], winner: null, timer: timer ?? 20 }, null);
  }

  function finish(S) {
    let i = S.out.length ? S.out[S.out.length - 1] : 0;
    while (active(S).length) { i = nextActive(S, i); S.out.push(i); S.hands[i] = []; }
    const sc = score(S.out), T = sc.T;
    const before = S.levels[T];
    let won = false;
    if (S.decl === T && S.L === 14) { won = true; S.winner = T; }
    else S.levels[T] = Math.min(14, before + sc.up);
    S.result = { out: S.out.slice(), ...sc, before, after: S.levels[T], won };
    S.phase = won ? 'over' : 'done';
    S.last = null; S.passed = [];
  }

  function play(S, seat, ids) {
    if (S.phase !== 'play' || S.turn !== seat) return 'Not your turn.';
    const hand = S.hands[seat];
    if (!ids.length || ids.some(id => !hand.includes(id))) return 'Pick cards from your hand.';
    const table = S.last ? S.last.c : null;
    const c = choose(ids, S.L, table, S.n);
    if (!c) return table ? "That doesn't beat the table." : "That isn't a legal combination.";
    S.hands[seat] = hand.filter(id => !ids.includes(id));
    S.last = { seat, ids: sortHand(ids, S.L), c };
    S.passed = [];
    S.log = [...S.log.slice(-6), { seat, c, ids: S.last.ids }];
    S.autoPassed = [];
    if (!S.hands[seat].length) S.out.push(seat);
    if (new Set(active(S).map(team)).size <= 1) { finish(S); return null; }
    S.turn = nextActive(S, seat);
    advance(S);
    return null;
  }

  // Could this seat beat the table at all? Only checked for small hands (under 4 cards).
  function canBeat(S, seat) {
    const h = S.hands[seat], n = h.length;
    for (let m = 1; m < (1 << n); m++) {
      const ids = h.filter((_, k) => m & (1 << k));
      if (choose(ids, S.L, S.last.c, S.n)) return true;
    }
    return false;
  }
  // Auto-pass anyone whose turn comes with fewer than 4 cards when the table play needs more cards than they hold.
  // Card values are never looked at, so an auto-pass reveals nothing about the hand.
  function advance(S) {
    for (let guard = 0; guard < 16; guard++) {
      if (S.phase !== 'play' || !S.last) return;
      const t = S.turn, h = S.hands[t];
      if (!h.length || h.length >= 4 || S.last.ids.length <= h.length) return;
      S.autoPassed = [...(S.autoPassed || []), t];
      doPass(S, t);
    }
  }
  function pass(S, seat) {
    if (S.phase !== 'play' || S.turn !== seat) return 'Not your turn.';
    if (!S.last) return 'You lead this trick, so you must play.';
    S.autoPassed = [];
    doPass(S, seat);
    advance(S);
    return null;
  }
  function doPass(S, seat) {
    S.passed = [...S.passed, seat];
    const w = S.last.seat;
    if (active(S).filter(i => i !== w).every(i => S.passed.includes(i))) {
      let lead = S.hands[w].length ? w : -1;
      if (lead < 0) {
        lead = nextActive(S, w);
        for (let k = 1; k < S.n; k++) { const j = (w + k) % S.n; if (team(j) === team(w) && S.hands[j].length) { lead = j; break; } }
      }
      S.last = null; S.passed = []; S.turn = lead;
    } else {
      S.turn = nextActive(S, seat);
    }
  }

  // A tribute receiver must hand back a card of 10 or lower (any card if they hold none).
  function returnable(S, seat) {
    const h = S.hands[seat];
    const low = h.filter(id => { const c = P(id); return c.s !== 'J' && !isWild(c, S.L) && c.r <= 10; });
    return low.length ? low : h;
  }
  function giveBack(S, seat, id) {
    if (S.phase !== 'return') return 'Nothing to give back right now.';
    const x = S.tribute.find(t => typeof t === 'object' && t.to === seat && !t.back);
    if (!x) return 'You have already given your card back.';
    if (!x.gave) return 'Wait until your tribute card arrives.';
    if (!returnable(S, seat).includes(id)) return 'Give back a card of 10 or lower (not a joker or wild).';
    S.hands[seat] = S.hands[seat].filter(c => c !== id);
    S.hands[x.from] = sortHand([...S.hands[x.from], id], S.L);
    x.back = id;
    if (!S.tribute.some(t => typeof t === 'object' && (!t.gave || !t.back))) S.phase = 'play';
    return null;
  }
  // A payer whose highest card comes in several suits chooses which one to pay.
  function pay(S, seat, id) {
    if (S.phase !== 'return') return 'Nothing to pay right now.';
    const x = S.tribute.find(t => typeof t === 'object' && t.from === seat && !t.gave);
    if (!x) return 'You have already paid your tribute.';
    const c = P(id);
    if (!S.hands[seat].includes(id) || !x.opts.some(o => { const q = P(o); return q.s === c.s && q.r === c.r; })) return 'Pick one of your highest cards (outlined).';
    S.hands[seat] = S.hands[seat].filter(k => k !== id);
    S.hands[x.to] = sortHand([...S.hands[x.to], id], S.L);
    x.gave = id; delete x.opts;
    return null;
  }
  // Timer ran out: pass if there is something to beat; if this seat was leading, hand the lead to the next player.
  function timeout(S, seat) {
    if (S.phase !== 'play' || S.turn !== seat) return 'Not your turn.';
    if (S.last) return pass(S, seat);
    S.turn = nextActive(S, seat);
    return null;
  }
  function nextHand(S) {
    const T = S.result.T;
    S.decl = T; S.L = S.levels[T]; S.hand += 1;
    return deal(S, S.result);
  }

  Object.assign(G, { pay, timeout, giveBack, returnable, canBeat, P, team, ov, isWild, analyze, beats, choose, sortHand, newGame, play, pass, nextHand, nextActive, deck, score });
})(typeof window !== 'undefined' ? (window.GD = {}) : typeof module !== 'undefined' ? module.exports : (globalThis.GD = {}));
