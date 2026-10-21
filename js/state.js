/* =====================================================================
   HEXTRIG · state.js
   The project data model, demo patterns, undo history and storage.

   project
     bpm, swing, current (pattern index), fx {…FX_PARAMS}
     patterns[8]
       name, len (master length: 16 | 32 | 64)
       tracks[6]
         machine     machine id
         params      { …PARAMS } — the track's sound
         len         1..64 (per-track length → polymeter)
         speed       index into SPEEDS (tuplets included)
         dir         index into DIRS (forward, reverse, ping-pong, …)
         swing       0 = follow global, else 50..80 (%)
         humT humV   humanize: timing (0..100 → ±30 ms), velocity
         seedLock    1 = the same random choices every loop
         chance      0..100 (whole-track probability)
         lfoMode     0 = free running, 1 = restart on each trig
         midiCh      0 = off, 1..16     midiNote   base note for MIDI out
         euclid      { pulses, rotate } — last generator settings
         steps[64]   null | step
           step = { trigless, slide, vel, note, micro, prob, cond, gate, retrig, rlen, rfade, rcurve,
                    locks{ paramId: value }, slock?{ name, machine, params } }
         sname, sdirty   name of the loaded sound, and whether it was edited since
     perform  { scenes[8], a, b, xfade }   (perform.js)
     library  { sounds[], kits[] }        (library.js)
     clock { change, swingGrid, metro, metroLevel, countIn, recQuant, sync, clockOut, midiOut, midiIn }
     song  { on, loop, entries: [{ p: patternIndex, r: repeats }] }
   ===================================================================== */
(function (HX) {
  'use strict';
  const C = HX.CONST;
  const S = (HX.state = { project: null });
  const listeners = [];
  S.onChange = fn => listeners.push(fn);

  /* ---------- factories ---------- */
  S.mkStep = (o = {}) => Object.assign({ trigless: 0, slide: 0, vel: 100, note: 0, micro: 0, prob: 100, cond: 0, gate: 0, retrig: 0, rlen: 1, rfade: 0, rcurve: 0, locks: {} }, o);
  const STEP_NUMS = ['trigless', 'slide', 'vel', 'note', 'micro', 'prob', 'cond', 'gate', 'retrig', 'rlen', 'rfade', 'rcurve'];
  const TRACK_FIELDS = { len: 16, speed: 6, dir: 0, swing: 0, humT: 0, humV: 0, seedLock: 0, chance: 100, lfoMode: 0, midiCh: 0, midiNote: 60 };
  const newSeed = () => (Math.random() * 4294967296) >>> 0;
  S.newSeed = newSeed;

  S.defaultParams = machineId => {
    const p = {};
    HX.PARAMS.forEach(d => { p[d.id] = d.def; });
    return Object.assign(p, HX.machines.byId[machineId].defaults);
  };

  S.mkTrack = (machine, params = {}, extra = {}) => Object.assign({
    machine,
    params: Object.assign(S.defaultParams(machine), params),
    ...TRACK_FIELDS,
    euclid: { pulses: 4, rotate: 0 },
    steps: new Array(C.MAX_STEPS).fill(null),
  }, extra);

  const KIT = ['kick', 'snare', 'metal', 'perc', 'tone', 'chord'];
  const KIT_SOUND = {
    kick: { level: 104, drive: 20 },
    snare: { level: 84, reverb: 24 },
    metal: { level: 70, pan: -12 },
    perc: { level: 80, pan: 16, delay: 30 },
    tone: { level: 92, cutoff: 104 },
    chord: { level: 66, delay: 44, reverb: 40, cutoff: 112 },
  };
  S.mkPattern = (name = 'INIT') => ({ name, len: 16, seed: newSeed(), tracks: KIT.map(m => S.mkTrack(m, KIT_SOUND[m])) });

  /* ---------- tiny pattern language for the demos ----------
     'x' = trig (vel 104)   'X' = accent (127)   'o' = ghost (64)   '.' = rest */
  function line(str) {
    const steps = new Array(C.MAX_STEPS).fill(null);
    str.replace(/[\s|]/g, '').split('').forEach((c, i) => {
      const vel = { x: 104, X: 127, o: 64 }[c];
      if (vel) steps[i] = S.mkStep({ vel });
    });
    return steps;
  }
  function notes(steps, arr) {
    let j = 0;
    steps.forEach(s => { if (s) { s.note = arr[j % arr.length]; j++; } });
    return steps;
  }
  function at(steps, i, o) {
    const s = steps[i] || S.mkStep();
    const locks = Object.assign({}, s.locks, o.locks || {});
    if (typeof o.cond === 'string') o = Object.assign({}, o, { cond: HX.condIndex(o.cond) });
    steps[i] = Object.assign(s, o, { locks });
    return steps;
  }
  const trk = (machine, params, steps, extra) =>
    S.mkTrack(machine, Object.assign({}, KIT_SOUND[machine], params), Object.assign({ steps }, extra || {}));
  // shape value that selects entry n of a table with `size` entries
  const sel = (n, size) => Math.round(((n + 0.5) / size) * 127);

  function demoPulse() {
    const kick = line('x...x...x...x...'); at(kick, 14, { vel: 70, cond: '3:4' });
    const clap = line('....x.......x...'); at(clap, 15, { vel: 60, cond: 'FILL' });
    const hats = line('.o.X.o.X.o.X.o.X'.replace(/X/g, '.'));
    [2, 6, 10, 14].forEach(i => at(hats, i, { vel: 118, locks: { decay: 40 } }));
    [1, 5, 9, 13].forEach(i => at(hats, i, { vel: 56, prob: 55 }));
    const perc = line('...x.....x....x.');
    at(perc, 3, { cond: '1:2' }); at(perc, 9, { note: 5 }); at(perc, 14, { cond: 'PRE', note: 12 });
    const bass = notes(line('..x..xx...x..x.x'), [0, 0, 12, 0, 3, -2]);
    const chord = line('...x..........x.'); at(chord, 14, { cond: '1:2', locks: { contour: 90 } });
    return {
      name: 'PULSE', len: 16, tracks: [
        trk('kick', { decay: 44, color: 20, sweep: 86, contour: 30, drive: 34 }, kick),
        trk('snare', { color: 112, shape: 84, decay: 30, contour: 62, reverb: 40, level: 78 }, clap),
        trk('metal', { decay: 12, color: 84, shape: 20, level: 66 }, hats),
        trk('perc', { pitch: 7, shape: sel(5, 10), color: 44, decay: 28, delay: 56 }, perc),
        trk('tone', { pitch: -12, color: sel(2, 10), shape: 52, sweep: 22, contour: 20, decay: 30, cutoff: 96, drive: 24,
          lfoRate: 1, lfoDest: 7, lfoDepth: 22 }, bass),
        trk('chord', { shape: sel(8, 14), color: 104, sweep: 40, contour: 50, decay: 30, delay: 70, reverb: 50, level: 64 }, chord),
      ],
    };
  }

  function demoElectro() {
    const kick = line('x.....x...x..x..');
    const snare = line('....x.......x...'); at(snare, 15, { vel: 70, cond: 'FILL' }); at(snare, 7, { vel: 50, cond: '4:4' });
    const hats = line('xoxoxoxoxoxoxoxo');
    const bell = line('..x....x..x..x..'); at(bell, 13, { cond: '!1ST', note: 7 });
    const bass = notes(line('x.xx..x.x.x..x.x'), [0, 12, 0, 3, 0, 7, 10, 5]);
    const stab = line('............x...'); at(stab, 12, { cond: '1:4' });
    return {
      name: 'ELECTRO', len: 16, tracks: [
        trk('kick', { decay: 52, color: 8, sweep: 70, contour: 42 }, kick),
        trk('snare', { color: 60, shape: 40, decay: 38, sweep: 44, reverb: 22 }, snare),
        trk('metal', { decay: 7, color: 92, level: 64, lfoRate: 5, lfoDest: 1, lfoDepth: 14 }, hats),
        trk('perc', { pitch: 12, shape: sel(3, 10), color: 60, decay: 26, contour: 40, level: 62 }, bell),
        trk('tone', { pitch: -12, color: sel(2, 10), shape: 72, sweep: 34, contour: 14, decay: 26, cutoff: 110 }, bass),
        trk('chord', { shape: sel(7, 14), color: 110, decay: 22, contour: 70, delay: 80, reverb: 30 }, stab),
      ],
    };
  }

  function demoDub() {
    const kick = line('x.......x.......'); at(kick, 11, { vel: 66, cond: '1:2' });
    const rim = line('....x.......x...');
    const hats = line('x.x.x.x.x.x.x.x.'); [6, 14].forEach(i => at(hats, i, { prob: 60, vel: 70 }));
    const perc = line('......x........x'); at(perc, 15, { cond: '1:3' });
    const sub = notes(line('x.......x.....x.'), [0, 0, -2]);
    const chord = line('..x.......x.....'); at(chord, 10, { micro: 6, locks: { cutoff: 84 } });
    return {
      name: 'DUB', len: 16, tracks: [
        trk('kick', { decay: 58, sweep: 70, color: 8, drive: 10 }, kick),
        trk('snare', { pitch: 12, color: 30, shape: 70, decay: 14, contour: 10, level: 58, delay: 44, reverb: 54 }, rim),
        trk('metal', { decay: 10, color: 60, level: 60, pan: 20 }, hats, { swing: 60, humT: 30, humV: 30 }),
        trk('perc', { pitch: -5, shape: sel(1, 10), color: 30, decay: 60, delay: 80, reverb: 60 }, perc),
        trk('tone', { pitch: -12, color: sel(2, 10), shape: 12, sweep: 0, decay: 52, level: 100 }, sub),
        trk('chord', { shape: sel(5, 14), color: 110, sweep: 30, contour: 40, decay: 22, cutoff: 98, delay: 104, reverb: 70, level: 70 }, chord),
      ],
    };
  }

  function demoPoly() {
    const kick = line('x..x..x...x.x...'); at(kick, 10, { retrig: 2, rlen: 1, rfade: -30 });
    const snare = line('....x.......x'); at(snare, 12, { retrig: 3, rlen: 1, rfade: -40 });
    const hats = line('x.oxx.ox.xo.'); at(hats, 3, { micro: 8 }); at(hats, 9, { micro: -6, prob: 70 });
    const perc = notes(line('x..x.x.'), [0, 7, 12]);
    const tone = notes(line('x..x.x..x.'), [0, 7, 3, 10]);
    const pad = line('x.............o.........');
    return {
      name: 'POLY', len: 16, tracks: [
        trk('kick', { decay: 40, color: 30, shape: 60, sweep: 92, contour: 20 }, kick),
        trk('snare', { color: 80, shape: 90, decay: 24 }, snare, { len: 13 }),
        trk('metal', { decay: 6, color: 100, shape: 60, level: 58 }, hats, { len: 12, speed: HX.speedIndex('2×'), dir: 3 }),
        trk('perc', { pitch: 12, shape: sel(8, 10), color: 70, decay: 20, delay: 40 }, perc, { len: 7, speed: HX.speedIndex('3/4×') }),
        trk('tone', { pitch: 0, color: sel(4, 10), shape: 60, sweep: 40, contour: 30, decay: 24, delay: 30,
          lfoRate: 3, lfoDest: 9, lfoDepth: 50 }, tone, { len: 10, dir: 2 }),
        trk('chord', { shape: sel(3, 14), color: 40, decay: 74, reverb: 84, level: 58, attack: 30 }, pad, { len: 24 }),
      ],
    };
  }

  // Tuplet grids, quintuplets, ratchet curves, random direction with a locked seed.
  function demoTuplet() {
    const kick = line('x.......x..x....'); at(kick, 6, { vel: 60, cond: '2:2' });
    const snare = line('....x.......x..o'); at(snare, 15, { retrig: HX.RETRIGS.indexOf(8), rlen: 1, rcurve: 44, rfade: -48, cond: '1:2' });
    const hats = line('x.ox.ox.ox.ox.ox.ox.ox.o');            // 16th triplets: 24 steps = 1 bar
    at(hats, 23, { retrig: HX.RETRIGS.indexOf(3), rfade: -20 });
    const perc = notes(line('x.x..x.xx..x.x...x.x'), [0, 5, 7, 12, -5, 3]);   // quintuplets, random order
    const tone = notes(line('x.xx.x.x'), [0, 12, 3, 10, 7, 5]);
    const chord = line('x..x..x.x..x');                            // dotted-16th grid
    [3, 8].forEach(i => at(chord, i, { vel: 70, locks: { cutoff: 80 } }));
    return {
      name: 'TUPLET', len: 16, seed: 0x5eed, tracks: [
        trk('kick', { decay: 50, color: 24, sweep: 80, contour: 36, drive: 28 }, kick),
        trk('snare', { color: 92, shape: 70, decay: 26, contour: 50, reverb: 30 }, snare),
        trk('metal', { decay: 9, color: 96, shape: 40, level: 58 }, hats, { len: 24, speed: HX.speedIndex('3/2×'), humV: 40 }),
        trk('perc', { pitch: 5, shape: sel(6, 10), color: 56, decay: 22, delay: 44, pan: -20 }, perc,
          { len: 20, speed: HX.speedIndex('5/4×'), dir: 4, seedLock: 1 }),
        trk('tone', { pitch: -12, color: sel(2, 10), shape: 60, sweep: 26, contour: 22, decay: 24, cutoff: 100 }, tone, { len: 8, dir: 2 }),
        trk('chord', { shape: sel(8, 14), color: 100, decay: 20, contour: 60, delay: 60, reverb: 40, level: 58 }, chord,
          { len: 12, speed: HX.speedIndex('2/3×') }),
      ],
    };
  }

  S.defaultFx = () => Object.fromEntries(HX.FX_PARAMS.map(p => [p.id, p.def]));
  S.defaultSong = () => ({ on: 0, loop: 1, entries: [{ p: 0, r: 2 }, { p: 1, r: 2 }, { p: 4, r: 2 }, { p: 2, r: 2 }] });
  S.defaultProject = () => {
    const patterns = [demoPulse(), demoElectro(), demoDub(), demoPoly(), demoTuplet()];
    patterns.forEach((p, i) => { if (p.seed == null) p.seed = 1000 + i; });
    while (patterns.length < C.PATTERNS) patterns.push(S.mkPattern());
    return {
      version: 2, bpm: 124, swing: 50, current: 0, fx: S.defaultFx(), clock: HX.defaultClock(), exportCfg: HX.defaultExport(),
      song: S.defaultSong(), perform: HX.perform.defaults(), library: { sounds: [], kits: [] }, patterns,
    };
  };

  /* ---------- accessors ---------- */
  S.pat = () => S.project.patterns[S.project.current];
  S.track = i => S.pat().tracks[i];
  S.isEmpty = p => p.tracks.every(t => t.steps.every(s => !s));

  /* ---------- normalise anything loaded from storage / import ---------- */
  function normalize(p) {
    const d = S.defaultProject();
    if (!p || typeof p !== 'object' || !Array.isArray(p.patterns)) return d;
    const v1 = !(p.version >= 2);
    const OLD_SPEED = [0, 1, 3, 5, 6, 9, 10];           // v1 speed index → v2
    const OLD_RETRIG = [0, 2, 3, 4, 6, 8];              // v1 retrig index → hits
    p.bpm = Math.min(400, Math.max(20, +p.bpm || 124));
    p.swing = Math.min(80, Math.max(50, +p.swing || 50));
    p.current = Math.abs(+p.current || 0) % C.PATTERNS;
    p.fx = Object.assign(S.defaultFx(), p.fx || {});
    p.clock = Object.assign(HX.defaultClock(), p.clock || {});
    p.exportCfg = Object.assign(HX.defaultExport(), p.exportCfg || {});
    p.perform = HX.perform.normalize(p.perform);
    p.library = HX.library.normalize(p.library);
    const song = p.song || S.defaultSong();
    p.song = {
      on: song.on ? 1 : 0, loop: song.loop === 0 ? 0 : 1,
      entries: (Array.isArray(song.entries) ? song.entries : []).slice(0, 64)
        .map(e => ({ p: Math.abs(+e.p || 0) % C.PATTERNS, r: Math.min(64, Math.max(1, +e.r || 1)) })),
    };
    p.version = 2;
    for (let i = 0; i < C.PATTERNS; i++) {
      const pat = p.patterns[i] || S.mkPattern();
      pat.name = String(pat.name || 'INIT').slice(0, 10);
      pat.len = Math.min(64, Math.max(1, Math.round(+pat.len) || 16));
      pat.seed = pat.seed == null ? newSeed() : pat.seed >>> 0;
      pat.tracks = (pat.tracks || []).slice(0, C.TRACKS);
      for (let t = 0; t < C.TRACKS; t++) {
        const tr = pat.tracks[t] || S.mkTrack(KIT[t]);
        if (!HX.machines.byId[tr.machine]) tr.machine = KIT[t];
        tr.params = Object.assign(S.defaultParams(tr.machine), tr.params || {});
        if (v1) tr.speed = OLD_SPEED[tr.speed] != null ? OLD_SPEED[tr.speed] : HX.SPEED_1X;
        Object.keys(TRACK_FIELDS).forEach(k => { const x = +tr[k]; tr[k] = Number.isFinite(x) ? x : TRACK_FIELDS[k]; });
        tr.len = Math.min(64, Math.max(1, Math.round(tr.len)));
        if (!HX.SPEEDS[tr.speed]) tr.speed = HX.SPEED_1X;
        if (!HX.DIRS[tr.dir]) tr.dir = 0;
        tr.euclid = tr.euclid || { pulses: 4, rotate: 0 };
        tr.sname = typeof tr.sname === 'string' ? tr.sname.slice(0, 16) : '';
        tr.sdirty = tr.sdirty ? 1 : 0;
        const st = new Array(C.MAX_STEPS).fill(null);
        (tr.steps || []).slice(0, C.MAX_STEPS).forEach((s, k) => {
          if (!s) return;
          const n = S.mkStep(Object.assign({}, s, { locks: Object.assign({}, s.locks) }));
          if (v1) n.retrig = Math.max(0, HX.RETRIGS.indexOf(OLD_RETRIG[s.retrig] || 0));
          STEP_NUMS.forEach(f => { if (!Number.isFinite(+n[f])) n[f] = S.mkStep()[f]; else n[f] = +n[f]; });
          n.trigless = n.trigless ? 1 : 0;
          if (HX.SLIDES[n.slide] == null) n.slide = 0;
          if (n.slock) { const c = HX.library.cleanSound(n.slock); if (c) n.slock = c; else delete n.slock; }
          n.vel = Math.min(127, Math.max(1, n.vel)); n.micro = Math.min(23, Math.max(-23, n.micro));
          if (!HX.CONDS[n.cond]) n.cond = 0;
          if (!HX.RETRIGS[n.retrig] && n.retrig !== 0) n.retrig = 0;
          if (HX.GATES[n.gate] == null) n.gate = 0;
          st[k] = n;
        });
        tr.steps = st;
        pat.tracks[t] = tr;
      }
      p.patterns[i] = pat;
    }
    return p;
  }

  /* ---------- undo / redo (snapshots of the current pattern + globals) ---------- */
  const undoStack = [], redoStack = [];
  const snap = () => JSON.stringify({ i: S.project.current, pat: S.pat(), bpm: S.project.bpm, swing: S.project.swing, scenes: S.project.perform.scenes });
  function restore(json) {
    const s = JSON.parse(json);
    // version 2: the snapshot is already current, so no v1 migration may touch it
    S.project.patterns[s.i] = normalize({ version: 2, patterns: [s.pat] }).patterns[0];
    S.project.bpm = s.bpm; S.project.swing = s.swing;
    if (s.scenes) S.project.perform.scenes = HX.perform.normalize({ scenes: s.scenes }).scenes;
  }
  // Call BEFORE a mutation. Repeated calls within 250 ms (one gesture) collapse.
  let lastCommit = 0;
  S.commit = function (force) {
    if (!S.project) return;
    const now = performance.now();
    if (!force && now - lastCommit < 250) { lastCommit = now; return; }
    lastCommit = now;
    undoStack.push(snap());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  S.undo = () => { if (!undoStack.length) return false; redoStack.push(snap()); restore(undoStack.pop()); S.changed(); return true; };
  S.redo = () => { if (!redoStack.length) return false; undoStack.push(snap()); restore(redoStack.pop()); S.changed(); return true; };

  /* ---------- storage (per-browser autosave) ---------- */
  let saveTimer = null;
  S.changed = function () {
    listeners.forEach(fn => fn());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(S.save, 500);
  };
  S.save = function () {
    try { localStorage.setItem(C.STORAGE_KEY, JSON.stringify(S.project)); } catch (e) { /* storage unavailable */ }
  };
  S.load = function () {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(C.STORAGE_KEY) || 'null'); } catch (e) { p = null; }
    S.project = normalize(p);
  };
  S.exportJSON = () => JSON.stringify(S.project);
  S.importJSON = text => { const p = JSON.parse(text); S.commit(true); S.project = normalize(p); S.changed(); };
  S.reset = () => { S.project = S.defaultProject(); S.changed(); };

  /* ---------- pattern + track operations ---------- */
  S.copyStepsForward = function (T, from, to) {
    for (let k = from; k < to; k++) {
      const src = T.steps[k % from];
      T.steps[k] = src ? JSON.parse(JSON.stringify(src)) : null;
    }
  };
  // ×2: double master length, extending tracks that ran the full length
  S.doubleLength = function () {
    const P = S.pat(); if (P.len >= 64) return;
    const old = P.len; P.len = Math.min(64, old * 2);
    P.tracks.forEach(T => { if (T.len === old) { S.copyStepsForward(T, old, P.len); T.len = P.len; } });
  };
  S.halveLength = function () {
    const P = S.pat(); if (P.len <= 16) return;
    const old = P.len; P.len = Math.ceil(old / 2);
    P.tracks.forEach(T => { if (T.len === old) T.len = P.len; });
  };
  S.euclid = function (T) {
    const n = T.len, k = Math.min(T.euclid.pulses, n), r = T.euclid.rotate % n;
    for (let i = 0; i < n; i++) {
      const j = (i - r + n) % n;
      const on = k > 0 && ((j * k) % n) < k;
      T.steps[i] = on ? (T.steps[i] || S.mkStep()) : null;
    }
  };
  S.rotate = function (T, dir) {
    const n = T.len, part = T.steps.slice(0, n);
    for (let i = 0; i < n; i++) T.steps[(i + dir + n) % n] = part[i];
  };
  S.clearTrack = T => { T.steps = new Array(C.MAX_STEPS).fill(null); };

  /* Dice: a musically weighted random pattern for the track's machine. */
  const DICE = {
    kick:  [.95, 0, .08, .12, .8, 0, .18, .1, .9, 0, .22, .18, .75, .05, .3, .12],
    snare: [0, 0, 0, .06, .95, 0, .08, .2, 0, .1, 0, .1, .95, 0, .14, .3],
    metal: [.45, .3, .9, .35, .45, .3, .9, .35, .45, .3, .9, .35, .45, .3, .9, .5],
    perc:  [.1, .2, .35, .45, .05, .3, .4, .2, .1, .35, .2, .45, .05, .25, .4, .3],
    tone:  [.7, .25, .55, .4, .3, .4, .6, .3, .65, .25, .5, .45, .3, .4, .55, .35],
    chord: [.4, 0, 0, .35, 0, 0, .3, 0, .15, 0, .35, 0, 0, .2, 0, 0],
  };
  const SCALE = [0, 3, 5, 7, 10, 12, -2, -5, 7, 0];
  S.dice = function (T) {
    const w = DICE[T.machine] || DICE.perc;
    const melodic = T.machine === 'tone' || T.machine === 'chord' || T.machine === 'perc';
    for (let k = 0; k < T.len; k++) {
      const p = w[k % 16];
      if (Math.random() < p) {
        const s = S.mkStep({ vel: Math.round(70 + Math.random() * 57) });
        if (melodic && Math.random() < 0.6) s.note = SCALE[Math.floor(Math.random() * SCALE.length)];
        const r = Math.random();
        if (r < 0.1) s.cond = HX.condIndex(['1:2', '2:2', '3:4', 'PRE', '!PRE'][Math.floor(Math.random() * 5)]);
        else if (r < 0.18) s.prob = 50;
        else if (r < 0.22 && T.machine !== 'chord') { s.retrig = 1 + Math.floor(Math.random() * 3); s.rfade = -32; }
        if (Math.random() < 0.15) s.locks.decay = Math.round(Math.random() * 100);
        T.steps[k] = s;
      } else T.steps[k] = null;
    }
  };
})(window.HX);
