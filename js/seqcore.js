/* =====================================================================
   HEXTRIG · seqcore.js
   The sequencer's brain. Pure and deterministic: it knows nothing about
   audio, MIDI or the DOM, and the same project + seed always produces
   the same events. That is what lets tests/run.js prove it.

   Time is "pos" = 16th notes since play. Every step position is computed
   as origin + n × stepLength (a multiplication, never an accumulation),
   so tracks never drift, however long they run or however odd the ratio.

   advanceTo(horizon) processes every stream whose next key is < horizon,
   always the earliest key first:
     master   one event per 16th: pattern bookkeeping, song mode, beats
     clock    24 PPQN MIDI clock pulses (6 per 16th), when enabled
     track×6  one event per step; the key is pulled earlier by negative
              micro timing so early notes are never late

   Output events (all carry `pos`, the musical time to play at):
     note    { track, step, n, patI, grid, vel, ms, gate, lfoPos }   grid = the step's own position
     lock    { track, step, n, patI, grid, lfoPos }   a lock-only (trigless) step: changes the ringing note
     step    { track, step, patI }            playhead
     master  { step, patLoop, pat, count }    position (count = count-in)
     beat    { accent, count }                metronome
     clock   {}                               MIDI clock pulse
     pattern { pat, song }                    a pattern change happened
     songEnd {}                               song finished (loop off)

   Pattern changes are scheduled ("pending") at a position no track has
   reached yet. Each track switches on its own the moment its next step
   lands on or after that position, so early (negative micro) notes of
   the new pattern use the new pattern's data, and late notes of the old
   pattern still use the old one.
   ===================================================================== */
window.HX = window.HX || {};
(function (HX) {
  'use strict';
  const EPS = 1e-9;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- seeded randomness (mulberry32, state is one uint32) ---------- */
  function hash(a, b) {
    let h = (a ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = (h + Math.imul((b | 0) + 1, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  function rand(tr) {
    tr.rs = (tr.rs + 0x6d2b79f5) >>> 0;
    let t = tr.rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ---------- direction helpers ---------- */
  // How many steps make one "loop" (used by A:B conditions and seed lock).
  function period(dir, L) {
    if (dir === 2) return L > 1 ? 2 * L - 2 : 1;   // ping-pong: ends play once
    if (dir === 3) return 2 * L;                   // pendulum: ends play twice
    return L;
  }

  function create(getProject) {
    const E = { fill: false };
    let st = null;
    let clockOut = false;
    let snaps = [];
    const proj = () => getProject();

    /* ---------- tracks ---------- */
    const trackData = (tr, i) => proj().patterns[tr.patI].tracks[i];
    const speedLen = T => HX.SPEEDS[T.speed] ? HX.SPEEDS[T.speed].len : 1;
    const lenOf = T => clamp(T.len | 0, 1, HX.CONST.MAX_STEPS);

    function newTrack(i, origin, patI, base) {
      const P = proj().patterns[patI];
      return {
        patI, base,                   // pattern being read, and where it started
        origin, n: 0,                 // step n sits at origin + n × slen
        slen: speedLen(P.tracks[i]),
        pre: true,                    // last condition result (PRE / NEI)
        drunk: 0,
        rs: hash(P.seed | 0, i),      // rng state
        pid: 0,                       // id of the pending change this track already took
      };
    }

    // Speed changed while playing: keep the next step where it is, rescale from there.
    function syncSpeed(tr, i) {
      const L = speedLen(trackData(tr, i));
      if (Math.abs(L - tr.slen) > EPS) {
        const next = tr.origin + tr.n * tr.slen;
        tr.origin = next - tr.n * L;
        tr.slen = L;
      }
    }
    const gridPos = tr => tr.origin + tr.n * tr.slen;

    // Step index for step-count n. Random directions draw from the rng only when `consume`.
    function indexFor(tr, T, n, consume) {
      const L = lenOf(T), dir = T.dir | 0;
      const m = n % period(dir, L);
      switch (dir) {
        case 1: return L - 1 - m;
        case 2: return m < L ? m : 2 * L - 2 - m;
        case 3: return m < L ? m : 2 * L - 1 - m;
        case 4: return consume ? Math.floor(rand(tr) * L) : -1;
        case 5: {
          if (!consume) return -1;
          if (n === 0) { tr.drunk = 0; return 0; }
          const r = rand(tr);
          tr.drunk = (((tr.drunk + (r < 0.45 ? -1 : r < 0.9 ? 1 : 0)) % L) + L) % L;
          return tr.drunk;
        }
        default: return m;
      }
    }

    // A track takes the pending pattern change once its next step reaches it.
    function maybeTransition(tr, i) {
      const pd = st.pending;
      if (!pd || pd.stop || tr.pid === pd.id) return tr;
      if (gridPos(tr) < pd.pos - EPS) return tr;
      pd.locked = true;
      let nt;
      if (pd.mode === 'jump') { nt = tr; nt.patI = pd.pat; }
      else nt = newTrack(i, pd.pos, pd.pat, pd.pos);
      nt.pid = pd.id;
      st.tracks[i] = nt;
      syncSpeed(nt, i);
      return nt;
    }

    // Processing key: grid position, pulled earlier for negative micro timing.
    function trackKey(i) {
      let tr = st.tracks[i];
      syncSpeed(tr, i);
      tr = maybeTransition(tr, i);
      const T = trackData(tr, i), g = gridPos(tr);
      if ((T.dir | 0) >= 4) return g - tr.slen;          // random: next index unknown, look one step ahead
      const s = T.steps[indexFor(tr, T, tr.n, false)];
      return s && s.micro < 0 ? g + (s.micro / 24) * tr.slen : g;
    }

    /* ---------- track step ---------- */
    function stepTrack(i, out) {
      const tr = st.tracks[i];
      const T = trackData(tr, i), L = lenOf(T);
      const g = gridPos(tr);
      const per = period(T.dir | 0, L);
      const loop = Math.floor(tr.n / per);
      if (tr.n % per === 0 && T.seedLock) { tr.rs = hash(proj().patterns[tr.patI].seed | 0, i); tr.drunk = 0; }
      const idx = indexFor(tr, T, tr.n, true);
      out.push({ kind: 'step', track: i, step: idx, patI: tr.patI, pos: g });
      if (g > st.maxStep) st.maxStep = g;
      const key = i + ':' + tr.n;
      const s = T.steps[idx];
      if (s && !st.skip[key]) trig(i, tr, T, s, idx, g, loop, out);
      delete st.skip[key];
      tr.n++;
    }

    // noPre: lock-only steps are evaluated but never become the PRE / NEI reference
    function passes(i, tr, T, s, g, loop, noPre) {
      const c = HX.CONDS[s.cond] || HX.CONDS[0];
      let ok = true, counts = false;
      switch (c.kind) {
        case 'fill': ok = c.not ? !E.fill : E.fill; counts = true; break;
        case 'pre': ok = c.not ? !tr.pre : tr.pre; break;
        case 'nei': { const nb = i > 0 ? st.tracks[i - 1].pre : false; ok = c.not ? !nb : nb; break; }
        case 'first': {
          const len = Math.max(1, proj().patterns[tr.patI].len);
          const first = Math.floor((g - tr.base + EPS) / len) === 0;
          ok = c.not ? !first : first; counts = true; break;
        }
        case 'ab': ok = loop % c.b === c.a - 1; counts = true; break;
      }
      if (s.prob < 100) { const r = rand(tr); ok = ok && r * 100 < s.prob; counts = true; }
      if (counts && !noPre) tr.pre = ok;
      if (ok && T.chance < 100 && !noPre) ok = rand(tr) * 100 < T.chance;
      return ok;
    }

    function trig(i, tr, T, s, idx, g, loop, out) {
      if (!passes(i, tr, T, s, g, loop, !!s.trigless)) return;
      const L = tr.slen, P = proj();
      // swing (per-track amount, or the global one)
      const sw = T.swing >= 50 ? T.swing : P.swing;
      const amt = 2 * sw / 100 - 1;
      let off = 0;
      if (P.clock.swingGrid === 1) { if (tr.n % 4 === 2) off = amt * 2 * L; }
      else if (tr.n % 2 === 1) off = amt * L;
      off += (clamp(s.micro | 0, -23, 23) / 24) * L;
      const base = g + off;
      if (s.trigless) {
        out.push({ kind: 'lock', track: i, step: idx, n: tr.n, patI: tr.patI, pos: base, grid: g, lfoPos: tr.n + off / L });
        return;
      }
      // humanize (seeded, so it repeats when the seed is locked)
      let vel = s.vel / 127;
      if (T.humV) vel = clamp(vel + (rand(tr) + rand(tr) - 1) * (T.humV / 100) * 0.32, 0.02, 1);
      const ms = T.humT ? (rand(tr) + rand(tr) - 1) * (T.humT / 100) * 30 : 0;
      const gate = (HX.GATES[s.gate | 0] || 0) * L;
      const R = HX.RETRIGS[s.retrig | 0] || 0;
      const note = (pos, v) => ({ kind: 'note', track: i, step: idx, n: tr.n, patI: tr.patI, pos, grid: g, vel: v, ms, gate, lfoPos: tr.n + (pos - g) / L });
      if (!R) { out.push(note(base, vel)); return; }
      const rl = clamp(s.rlen | 0, 1, 8);
      const hits = Math.min(HX.MAX_HITS, R * rl);
      const span = rl * L;
      const e = Math.pow(2, -(s.rcurve || 0) / 32);   // >0 accelerates, <0 decelerates
      for (let h = 0; h < hits; h++) {
        const f = hits > 1 ? h / (hits - 1) : 0;
        out.push(note(base + span * Math.pow(h / hits, e), clamp(vel * (1 + (s.rfade / 64) * f), 0.02, 1)));
      }
    }

    /* ---------- master stream ---------- */
    function finalizePending(pd, out) {
      st.pending = null;
      if (pd.stop) { st.halted = true; out.push({ kind: 'songEnd', pos: pd.pos }); return; }
      for (let i = 0; i < st.tracks.length; i++) {        // tracks that did not take it yet
        const tr = st.tracks[i];
        if (tr.pid !== pd.id) {
          if (pd.mode === 'jump') tr.patI = pd.pat;
          else st.tracks[i] = newTrack(i, pd.pos, pd.pat, pd.pos);
        }
        st.tracks[i].pid = 0;
      }
      st.pat = pd.pat;
      if (pd.mode !== 'jump') st.patStart = pd.pos;
      if (pd.songIdx != null) { st.song.idx = pd.songIdx; st.song.active = true; }
      out.push({ kind: 'pattern', pos: pd.pos, pat: st.pat, song: st.song.idx });
      if (st.after != null) { const a = st.after; st.after = null; E.queue(a); }
    }

    function stepMaster(out) {
      const p = st.master;
      snaps.push({ pos: p, s: JSON.stringify(st) });
      if (snaps.length > 160) snaps.shift();
      if (st.pending && p >= st.pending.pos - EPS) finalizePending(st.pending, out);
      if (st.halted) return;
      const P = proj().patterns[st.pat], len = Math.max(1, P.len);
      if (p >= 0) {
        const rel = p - st.patStart;
        const step = ((rel % len) + len) % len;
        out.push({ kind: 'master', pos: p, step, patLoop: Math.floor(rel / len), pat: st.pat });
        songPlan(p);
      } else out.push({ kind: 'master', pos: p, step: -1, patLoop: -1, pat: st.pat, count: true });
      if (((p % 4) + 4) % 4 === 0) out.push({ kind: 'beat', pos: p, accent: ((p % 16) + 16) % 16 === 0, count: p < 0 });
      st.master = p + 1;
    }

    // Song mode: make sure the change at the end of this entry is scheduled.
    function songPlan(p) {
      const song = proj().song;
      const on = song && song.on && song.entries.length;
      if (!on) {                                                    // song switched off: drop its plan
        st.song.active = false;
        if (st.pending && st.pending.song && !st.pending.locked) st.pending = null;
        return;
      }
      if (st.pending && (!st.pending.song || st.pending.locked)) return;
      const len = Math.max(1, proj().patterns[st.pat].len);
      const k = Math.floor((p - st.patStart) / len);               // completed loops of this entry
      const nextB = st.patStart + (k + 1) * len;
      const entries = song.entries;
      if (!st.song.active) {                                        // switched on mid-play: join at row 1
        const pd = st.pending;
        if (!pd || pd.pos !== nextB || pd.pat !== entries[0].p || pd.songIdx !== 0)
          st.pending = { id: ++st.pidSeq, pos: nextB, pat: entries[0].p, mode: 'start', song: true, songIdx: 0 };
        return;
      }
      const entry = entries[st.song.idx] || entries[0];
      if (k + 1 >= Math.max(1, entry.r | 0)) {
        let ni = st.song.idx + 1;
        if (ni >= entries.length) {
          if (!song.loop) { st.pending = { id: ++st.pidSeq, pos: nextB, stop: true, song: true }; return; }
          ni = 0;
        }
        const pd = st.pending;
        if (!pd || pd.pos !== nextB || pd.pat !== entries[ni].p || pd.songIdx !== ni) {
          st.pending = { id: ++st.pidSeq, pos: nextB, pat: entries[ni].p, mode: 'start', song: true, songIdx: ni };
        }
      } else if (st.pending && st.pending.song) st.pending = null;   // plan changed (more repeats)
    }

    /* ---------- public API ---------- */
    E.reset = function (startPos, patI, songIdx) {
      const P = proj();
      patI = patI == null ? P.current : patI;
      st = {
        pat: patI, patStart: 0, master: Math.ceil(startPos - EPS), pulse: Math.round(startPos * 6),
        frontier: startPos, maxStep: -Infinity, pending: null, pidSeq: 0, after: null,
        song: { idx: songIdx || 0, active: !!(P.song && P.song.on && P.song.entries.length) }, skip: {}, halted: false, tracks: [],
      };
      for (let i = 0; i < HX.CONST.TRACKS; i++) st.tracks.push(newTrack(i, 0, patI, 0));
      snaps = [];
    };

    E.setClockOut = on => { clockOut = !!on; if (st) st.pulse = Math.ceil(st.frontier * 6 - EPS); };

    E.advanceTo = function (horizon) {
      const out = [];
      if (!st) return out;
      // generous bound: ~6 tracks × 4× speed × 64 retrig hits per 16th, plus master + clock
      const limit = 20000 + Math.max(0, horizon - st.frontier) * 2000;
      for (let guard = 0; guard < limit && !st.halted; guard++) {
        let which = -2, kmin = st.master;
        if (clockOut && st.pulse / 6 < kmin - EPS) { kmin = st.pulse / 6; which = -1; }
        for (let i = 0; i < st.tracks.length; i++) {
          const k = trackKey(i);
          if (k < kmin - EPS) { kmin = k; which = i; }
        }
        if (kmin >= horizon) break;
        if (which === -2) stepMaster(out);
        else if (which === -1) { out.push({ kind: 'clock', pos: st.pulse / 6 }); st.pulse++; }
        else stepTrack(which, out);
      }
      if (horizon > st.frontier) st.frontier = horizon;
      return out;
    };

    // Queue a pattern change according to the project's PAT CHANGE mode.
    E.queue = function (p) {
      if (!st) return;
      if (st.pending && st.pending.locked) { st.after = p; return; }   // a change is already under way
      if (p == null) { if (st.pending && !st.pending.song) st.pending = null; st.after = null; return; }
      const mode = (HX.CHANGE_MODES[proj().clock.change] || HX.CHANGE_MODES[0]).id;
      const x = Math.max(st.master, Math.ceil(st.maxStep + 1e-6), Math.ceil(st.frontier - EPS));
      let pos;
      if (mode === 'end') {
        const len = Math.max(1, proj().patterns[st.pat].len);
        pos = st.patStart + Math.ceil((x - st.patStart - EPS) / len) * len;
        if (pos < x) pos += len;
      } else if (mode === 'bar') pos = Math.ceil((x - EPS) / 16) * 16;
      else if (mode === 'beat') pos = Math.ceil((x - EPS) / 4) * 4;
      else pos = x;
      st.pending = { id: ++st.pidSeq, pos, pat: p, mode: mode === 'jump' ? 'jump' : 'start' };
    };

    // A live hit at `pos`: which step does it land on, and with what micro timing?
    // Marks that step so this pass does not play it a second time.
    // mode 'current': the step playing at `pos` (motion recording), without blocking it.
    E.recordHit = function (i, pos, quant, mode) {
      const tr = st.tracks[i], T = trackData(tr, i), L = tr.slen;
      const cur = mode === 'current';
      const n = Math.max(0, cur ? Math.floor((pos - tr.origin) / L + 1e-6) : Math.round((pos - tr.origin) / L));
      const g = tr.origin + n * L;
      const micro = clamp(Math.round(((pos - g) / L) * 24 * (1 - quant / 100)), -23, 23);
      const idx = (T.dir | 0) >= 4 ? n % lenOf(T) : indexFor(tr, T, n, false);
      if (n >= tr.n && !cur) st.skip[i + ':' + n] = true;
      return { track: i, step: idx, micro, patI: tr.patI };
    };

    // Snapshots: state as it was right before the master event at `pos`.
    E.snapBefore = function (pos) {
      for (let k = snaps.length - 1; k >= 0; k--) if (snaps[k].pos <= pos + EPS) return snaps[k];
      return snaps[0] || null;
    };
    E.restore = function (snap) {
      st = JSON.parse(snap.s);
      st.frontier = snap.pos;
      st.maxStep = Math.min(st.maxStep, snap.pos);
      snaps = snaps.filter(x => x.pos < snap.pos);
    };

    E.frontier = () => (st ? st.frontier : 0);
    E.info = () => (st ? {
      pat: st.pat, patStart: st.patStart, master: st.master, halted: st.halted,
      pending: st.pending && !st.pending.stop ? { pos: st.pending.pos, pat: st.pending.pat, song: !!st.pending.song } : (st.after != null ? { pat: st.after } : null),
      songIdx: st.song.idx,
    } : null);
    return E;
  }

  HX.core = { create, hash };
})(window.HX);
