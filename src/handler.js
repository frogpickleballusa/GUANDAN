// ---- Supabase Edge Function entry point ----
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    // New projects expose secret keys as JSON in SUPABASE_SECRET_KEYS; older ones have SUPABASE_SERVICE_ROLE_KEY.
    let key = null;
    try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); key = k.default || Object.values(k)[0] || null; } catch (e) {}
    if (!key) key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!key) return reply({ error: 'Server setup problem: the function has no secret key (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY).' }, 500);
    const admin = createClient(Deno.env.get('SUPABASE_URL'), key, { auth: { persistSession: false } });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: ud } = await admin.auth.getUser(token);
    const uid = ud?.user?.id;
    if (!uid) return reply({ error: 'Not signed in.' }, 401);
    const body = await req.json();

    if (body.action === 'create') {
      if (Math.random() < 0.1) await admin.rpc('cleanup_old_rooms');
      for (let k = 0; k < 8; k++) {
        const room = CORE.newRoom(newCode(), uid, body.name);
        const { error } = await admin.from('rooms').insert({ code: room.code, cfg: room.cfg, seats: room.seats, pub: null, ver: 0 });
        if (!error) return reply({ code: room.code });
        if (error.code !== '23505') return reply({ error: 'Could not create a table: ' + error.message + (error.code ? ' (' + error.code + ')' : '') });
      }
      return reply({ error: 'Could not create a table. Try again.' });
    }

    const code = String(body.code || '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return reply({ error: 'Bad table code.' });

    for (let attempt = 0; attempt < 6; attempt++) {
      const [{ data: room, error: e1 }, { data: priv, error: e2 }] = await Promise.all([
        admin.from('rooms').select('code,cfg,seats,pub,ver').eq('code', code).maybeSingle(),
        admin.from('room_private').select('full_state').eq('code', code).maybeSingle(),
      ]);
      if (e1 || e2) return reply({ error: 'Server could not read the table: ' + (e1 || e2).message });
      if (!room) return reply({ error: 'Table not found. Check the code.' });
      const full0 = priv?.full_state || null;
      const r = CORE.handle(body, uid, room, full0, Date.now());
      if (r.err) return reply({ error: r.err });

      const before = CORE.privateHands(full0), after = CORE.privateHands(r.full);
      const clear = !r.full || (full0 && r.full.n !== full0.n) || (!full0 && !!r.full);
      const changed = clear ? after : after.filter((h, i) => JSON.stringify(h) !== JSON.stringify(before[i]));
      const { data: v, error } = await admin.rpc('save_room', {
        p_code: code, p_ver: room.ver, p_cfg: r.room.cfg, p_seats: r.room.seats, p_pub: CORE.publicView(r.full),
        p_full: r.full, p_hands: changed, p_clear_hands: !!clear,
      });
      if (error) return reply({ error: 'Save failed: ' + error.message });
      if (v >= 0) return reply({ ok: true, ver: v });
      await new Promise(f => setTimeout(f, 40 + Math.random() * 120));
    }
    return reply({ error: 'The table is busy. Try again.' });
  } catch (e) {
    return reply({ error: 'Server error: ' + (e?.message || e) }, 500);
  }
});
