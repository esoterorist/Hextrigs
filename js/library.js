/* =====================================================================
   HEXTRIG · library.js
   Sounds and kits.

   sound = { name, machine, params }       kit = { name, sounds: [6 × sound] }

   Factory sounds are written below (values over the machine's defaults).
   Factory kits are the demo patterns' kits. Your own sounds and kits live
   in the project (project.library), so Save · Load carries them too.

   Sound locks: a step can hold a copy of a sound (step.slock). It plays
   that sound, any machine, with the track's own mix. See sound.js.

   HOW TO ADD A FACTORY SOUND: add { name, p: { …param values } } to the
   machine's list. Anything you leave out uses the machine's default.
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const S = () => HX.state;
  const LIB = (HX.library = {});
  const sel = (n, size) => Math.round(((n + 0.5) / size) * 127);
  const clone = o => JSON.parse(JSON.stringify(o));

  LIB.FACTORY = {
    kick: [
      { name: '909 PUNCH', p: { pitch: 2, decay: 40, color: 14, shape: 22, sweep: 90, contour: 24, drive: 30 } },
      { name: '808 BOOM', p: { pitch: -1, decay: 92, color: 4, shape: 20, sweep: 60, contour: 50, drive: 10 } },
      { name: 'RUMBLE', p: { decay: 72, color: 40, shape: 30, sweep: 84, contour: 36, drive: 70, reverb: 54, cutoff: 92 } },
      { name: 'TIGHT CLICK', p: { pitch: 7, decay: 18, color: 30, shape: 60, sweep: 110, contour: 8, drive: 20 } },
      { name: 'HARDCORE', p: { pitch: 3, decay: 56, color: 60, shape: 40, sweep: 100, contour: 20, drive: 127, cutoff: 110 } },
      { name: 'TOM KICK', p: { pitch: 14, decay: 46, color: 10, shape: 30, sweep: 50, contour: 40 } },
    ],
    snare: [
      { name: 'TIGHT SNARE', p: { decay: 26, color: 70, shape: 70, sweep: 24, contour: 30 } },
      { name: 'NOISE CLAP', p: { pitch: 5, decay: 34, color: 116, shape: 84, sweep: 10, contour: 70, reverb: 40 } },
      { name: 'RIM', p: { pitch: 14, decay: 8, color: 26, shape: 90, sweep: 30, contour: 4, level: 80 } },
      { name: '808 SNARE', p: { pitch: 2, decay: 30, color: 56, shape: 40, sweep: 40, contour: 44 } },
      { name: 'BRUSH', p: { decay: 50, color: 122, shape: 30, sweep: 0, contour: 90, level: 112, reverb: 30 } },
      { name: 'SNAP', p: { pitch: 9, decay: 16, color: 96, shape: 110, sweep: 60, contour: 12 } },
    ],
    metal: [
      { name: 'CLOSED HAT', p: { decay: 10, color: 80, shape: 18, sweep: 6, contour: 0, level: 72 } },
      { name: 'OPEN HAT', p: { decay: 46, color: 76, shape: 20, sweep: 10, contour: 10, level: 64 } },
      { name: 'RIDE', p: { decay: 80, color: 60, shape: 70, sweep: 20, contour: 20, level: 70 } },
      { name: 'CRASH', p: { decay: 110, color: 90, shape: 100, sweep: 60, contour: 30, level: 100, reverb: 40 } },
      { name: 'TICK', p: { decay: 3, color: 120, shape: 50, sweep: 0, contour: 0, level: 80 } },
      { name: 'SIZZLE', p: { decay: 64, color: 110, shape: 64, sweep: 90, contour: 50, level: 104, delay: 40 } },
    ],
    perc: [
      { name: 'LOW TOM', p: { pitch: -5, decay: 50, color: 10, shape: sel(1, 10), sweep: 40, contour: 20 } },
      { name: 'CONGA', p: { pitch: 7, decay: 30, color: 24, shape: sel(1, 10), sweep: 20, contour: 10 } },
      { name: 'WOODBLOCK', p: { pitch: 24, decay: 10, color: 40, shape: sel(5, 10), sweep: 10, contour: 6 } },
      { name: 'CLAVE', p: { pitch: 24, decay: 6, color: 20, shape: sel(3, 10), sweep: 0, contour: 4 } },
      { name: 'FM BELL', p: { pitch: 19, decay: 70, color: 60, shape: sel(7, 10), sweep: 0, contour: 60, delay: 50, reverb: 40 } },
      { name: 'ZAP', p: { pitch: 12, decay: 24, color: 80, shape: sel(4, 10), sweep: 127, contour: 30 } },
    ],
    tone: [
      { name: 'SUB BASS', p: { pitch: -12, color: sel(2, 10), shape: 10, sweep: 0, contour: 20, decay: 50 } },
      { name: 'ACID', p: { pitch: -12, color: sel(2, 10), shape: 70, sweep: 30, contour: 18, decay: 28, cutoff: 90, reso: 70, drive: 40 } },
      { name: 'FM PLUCK', p: { color: sel(4, 10), shape: 60, sweep: 10, contour: 14, decay: 26, delay: 40 } },
      { name: 'BELL LEAD', p: { pitch: 12, color: sel(6, 10), shape: 50, sweep: 0, contour: 50, decay: 60, reverb: 40 } },
      { name: 'GROWL', p: { pitch: -12, color: sel(1, 10), shape: 90, sweep: 70, contour: 110, decay: 40, drive: 60 } },
      { name: 'ORGAN', p: { color: sel(4, 10), shape: 30, sweep: 0, contour: 127, decay: 70 } },
    ],
    chord: [
      { name: 'DUB STAB', p: { shape: sel(5, 14), color: 110, sweep: 30, contour: 40, decay: 20, delay: 90, reverb: 50 } },
      { name: 'DEEP PAD', p: { shape: sel(8, 14), color: 100, sweep: 70, contour: 20, decay: 110, attack: 50, reverb: 80, level: 124 } },
      { name: 'HOUSE KEYS', p: { shape: sel(5, 14), color: 30, sweep: 20, contour: 70, decay: 40 } },
      { name: 'RAVE STAB', p: { shape: sel(10, 14), color: 120, sweep: 50, contour: 90, decay: 30, drive: 40 } },
      { name: 'GLASS', p: { pitch: 12, shape: sel(9, 14), color: 50, sweep: 10, contour: 60, decay: 70, delay: 60, reverb: 60 } },
      { name: 'POWER', p: { shape: sel(0, 14), color: 127, sweep: 60, contour: 80, decay: 40, drive: 70 } },
    ],
  };

  LIB.factory = machine => (LIB.FACTORY[machine] || []).map(x => ({
    name: x.name, machine, factory: true, params: Object.assign(S().defaultParams(machine), x.p),
  }));

  let kitCache = null;
  LIB.factoryKits = function () {
    if (!kitCache) {
      kitCache = S().defaultProject().patterns.slice(0, 5).map(P => ({
        name: P.name, factory: true,
        sounds: P.tracks.map(T => ({ name: P.name + ' ' + HX.machines.byId[T.machine].name, machine: T.machine, params: clone(T.params) })),
      }));
    }
    return kitCache;
  };

  const lib = () => S().project.library;

  /* ---------- loading ---------- */
  LIB.load = function (T, snd) {
    T.machine = snd.machine;
    T.params = Object.assign(S().defaultParams(snd.machine), clone(snd.params));
    T.sname = snd.name;
    T.sdirty = 0;
  };
  LIB.loadKit = function (P, kit) { P.tracks.forEach((T, i) => { if (kit.sounds[i]) LIB.load(T, kit.sounds[i]); }); };

  /* ---------- saving (replaces a sound or kit with the same name) ---------- */
  const cleanName = (n, fallback) => String(n || '').toUpperCase().replace(/[^A-Z0-9 #+\-./]/g, '').trim().slice(0, 16) || fallback;
  LIB.cleanName = cleanName;
  LIB.saveSound = function (T, name) {
    name = cleanName(name, HX.machines.byId[T.machine].name);
    const list = lib().sounds;
    const snd = { name, machine: T.machine, params: clone(T.params) };
    const k = list.findIndex(x => x.name === name && x.machine === T.machine);
    if (k >= 0) list[k] = snd; else list.push(snd);
    T.sname = name; T.sdirty = 0;
    return snd;
  };
  LIB.saveKit = function (P, name) {
    name = cleanName(name, P.name + ' KIT');
    const kit = { name, sounds: P.tracks.map(T => ({ name: T.sname || HX.machines.byId[T.machine].name, machine: T.machine, params: clone(T.params) })) };
    const list = lib().kits;
    const k = list.findIndex(x => x.name === name);
    if (k >= 0) list[k] = kit; else list.push(kit);
    return kit;
  };
  LIB.removeSound = k => { lib().sounds.splice(k, 1); };
  LIB.removeKit = k => { lib().kits.splice(k, 1); };

  /* ---------- random + mutate (synth macros, a little filter and drive) ---------- */
  const SYN = ['decay', 'color', 'shape', 'sweep', 'contour'];
  const MELODIC = { tone: 1, chord: 1 };
  LIB.random = function (T, rnd) {
    rnd = rnd || Math.random;
    const p = T.params, ri = (a, b) => Math.round(a + rnd() * (b - a));
    p.pitch = MELODIC[T.machine] ? ri(-12, 12) : ri(-7, 9);
    p.decay = ri(8, 100);
    ['color', 'shape', 'sweep', 'contour'].forEach(id => { p[id] = ri(0, 127); });
    p.drive = rnd() < 0.35 ? ri(10, 80) : 0;
    p.cutoff = MELODIC[T.machine] ? ri(60, 127) : ri(96, 127);
    p.reso = rnd() < 0.3 ? ri(10, 70) : 0;
    T.sname = 'RANDOM'; T.sdirty = 1;
  };
  LIB.mutate = function (T, amount, rnd) {
    rnd = rnd || Math.random;
    amount = amount || 14;
    const p = T.params;
    SYN.concat(['cutoff', 'drive']).forEach(id => {
      const d = HX.PARAM[id];
      p[id] = U.clamp(Math.round(p[id] + (rnd() * 2 - 1) * amount), d.min, d.max);
    });
    T.sdirty = 1;
  };

  /* ---------- sound locks ---------- */
  LIB.lockSteps = (steps, snd) => steps.forEach(s => { s.slock = { name: snd.name, machine: snd.machine, params: clone(snd.params) }; });
  LIB.unlockSteps = steps => steps.forEach(s => { delete s.slock; });

  /* ---------- validation (used by state.normalize) ---------- */
  LIB.cleanSound = function (x) {
    if (!x || !HX.machines.byId[x.machine]) return null;
    const params = S().defaultParams(x.machine);
    Object.keys(x.params || {}).forEach(id => {
      const d = HX.PARAM[id], v = +x.params[id];
      if (d && Number.isFinite(v)) params[id] = U.clamp(v, d.min, d.max);
    });
    return { name: cleanName(x.name, HX.machines.byId[x.machine].name), machine: x.machine, params };
  };
  LIB.normalize = function (l) {
    l = l && typeof l === 'object' ? l : {};
    return {
      sounds: (Array.isArray(l.sounds) ? l.sounds : []).map(LIB.cleanSound).filter(Boolean).slice(0, 256),
      kits: (Array.isArray(l.kits) ? l.kits : []).map(k => {
        const sounds = (k && Array.isArray(k.sounds) ? k.sounds : []).slice(0, 6).map(LIB.cleanSound);
        return sounds.length === 6 && sounds.every(Boolean) ? { name: cleanName(k.name, 'KIT'), sounds } : null;
      }).filter(Boolean).slice(0, 64),
    };
  };
})(window.HX);
