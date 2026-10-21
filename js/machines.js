/* =====================================================================
   HEXTRIG · machines.js
   The six sound engines. Every engine is pure Web Audio, built per hit.

   HOW TO ADD A MACHINE
   Call register({...}) with:
     id, name            unique id + display name
     hint                one-line description per macro (COLOR/SHAPE/SWEEP/CONTOUR)
     show                optional: custom readout for a macro, (raw 0..127) → text
     defaults            starting values for the SYN page (raw param units)
     gm | notes(p)       MIDI export: a General MIDI drum note, or the notes it plays
     play(v, p) → secs   build the sound. Return how long it rings.

   v  (the voice, from audio.js)
     v.ac  AudioContext      v.t   start time       v.out  connect your output here
     v.osc(type)      oscillator, already started at v.t
     v.noise()        looping white noise source, already started
     v.gain(value)    GainNode       v.filter(type, freq, q)   BiquadFilterNode
   p  (resolved params, LFO + p-locks already applied)
     p.semi           pitch offset in semitones (PITCH + trig NOTE)
     p.decay p.color p.shape p.sweep p.contour   all 0..1
     p.slideFrom p.slideSec   set when the step slides: glide pitch from there (optional)
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const M = (HX.machines = { list: [], byId: {} });
  const register = def => { M.list.push(def); M.byId[def.id] = def; };
  M.register = register;

  /* ---------- envelope helpers ---------- */
  // Exponential decay from `peak` to silence over `dur` seconds.
  function decayEnv(param, t, peak, dur) {
    param.setValueAtTime(Math.max(peak, 0.0001), t);
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(0.005, dur));
  }
  // Exponential glide from `from` toward `to` (time constant tc).
  function glide(param, t, from, to, tc) {
    param.setValueAtTime(from, t);
    param.setTargetAtTime(to, t, Math.max(0.001, tc));
  }
  const pick = (arr, x) => arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];

  /* ===================== KICK =====================
     Sine carrier with a pitch drop, phase-modulated by a second sine. */
  register({
    id: 'kick', name: 'KICK', glyph: 'kick', gm: 36,
    hint: { color: 'FM grit', shape: 'mod ratio', sweep: 'pitch drop', contour: 'drop time' },
    defaults: { pitch: 0, decay: 44, color: 18, shape: 22, sweep: 84, contour: 30 },
    play(v, p) {
      const t = v.t;
      const f0 = U.mtof(29 + p.semi);
      const start = f0 * Math.pow(2, p.sweep * 4.5);
      const tc = 0.004 + p.contour * p.contour * 0.11;
      const dec = 0.08 + p.decay * p.decay * 2.2;

      const car = v.osc('sine');
      glide(car.frequency, t, start, f0, tc);
      const ratio = 0.5 + p.shape * 3;
      const mod = v.osc('sine');
      glide(mod.frequency, t, start * ratio, f0 * ratio, tc);
      const idx = v.gain(0);
      const dev = p.color * p.color * f0 * 16 + 0.001;
      idx.gain.setValueAtTime(dev, t);
      idx.gain.setTargetAtTime(dev * 0.1, t, 0.01 + p.contour * 0.12);
      mod.connect(idx).connect(car.frequency);

      const amp = v.gain(0);
      decayEnv(amp.gain, t, 0.95, dec);
      car.connect(amp).connect(v.out);

      // transient click
      const clk = v.noise();
      const hp = v.filter('highpass', 2200, 0.7);
      const cg = v.gain(0);
      decayEnv(cg.gain, t, 0.28 * (1 - p.contour * 0.6), 0.008);
      clk.connect(hp).connect(cg).connect(v.out);
      return dec + 0.02;
    },
  });

  /* ===================== SNARE =====================
     Two tuned sine partials (with a little FM fizz) plus filtered noise. */
  register({
    id: 'snare', name: 'SNARE', glyph: 'snare', gm: 38,
    hint: { color: 'tone ↔ noise', shape: 'noise color', sweep: 'body drop', contour: 'snap ↔ tail' },
    defaults: { pitch: 0, decay: 32, color: 70, shape: 56, sweep: 24, contour: 36 },
    play(v, p) {
      const t = v.t;
      const f0 = U.mtof(53 + p.semi);
      const bodyDec = 0.04 + p.decay * p.decay * 0.6;
      const noiseDec = bodyDec * (0.5 + p.contour * 2.4) + 0.02;
      const toneLvl = Math.cos(p.color * Math.PI / 2);
      const noiseLvl = Math.sin(p.color * Math.PI / 2);
      const drop = 1 + p.sweep * 2.5;

      const a = v.osc('sine');
      glide(a.frequency, t, f0 * drop, f0, 0.012 + p.sweep * 0.02);
      const b = v.osc('sine');
      glide(b.frequency, t, f0 * 1.62 * drop, f0 * 1.62, 0.012);
      const mod = v.osc('sine');
      mod.frequency.setValueAtTime(f0 * 2.31, t);
      const mi = v.gain(0);
      mi.gain.setValueAtTime(f0 * (0.3 + p.contour * 1.4), t);
      mi.gain.setTargetAtTime(0, t, 0.02);
      mod.connect(mi).connect(a.frequency);

      const ga = v.gain(0); decayEnv(ga.gain, t, toneLvl * 0.85, bodyDec);
      const gb = v.gain(0); decayEnv(gb.gain, t, toneLvl * 0.35, bodyDec * 0.7);
      a.connect(ga).connect(v.out);
      b.connect(gb).connect(v.out);

      const n = v.noise();
      const hp = v.filter('highpass', 300 + p.shape * 2400, 0.7);
      const lp = v.filter('lowpass', 3500 + p.shape * 11000, 0.6);
      const gn = v.gain(0); decayEnv(gn.gain, t, noiseLvl * 0.9, noiseDec);
      n.connect(hp).connect(lp).connect(gn).connect(v.out);
      return Math.max(bodyDec, noiseDec) + 0.02;
    },
  });

  /* ===================== METAL =====================
     Six square oscillators at inharmonic ratios (808 lineage) → band-pass.
     Low DECAY = closed hats, high DECAY = rides and crashes. */
  const R808 = [1, 1.4826, 1.8, 2.5463, 2.6304, 3.8956];
  const RALT = [1, 1.342, 1.6531, 2.1181, 2.7362, 3.4607];
  register({
    id: 'metal', name: 'METAL', glyph: 'metal', gm: 42,
    hint: { color: 'brightness', shape: 'alloy (ratios)', sweep: 'filter shimmer', contour: 'hold ↔ choke' },
    defaults: { pitch: 0, decay: 16, color: 72, shape: 18, sweep: 12, contour: 0 },
    play(v, p) {
      const t = v.t;
      const base = 205 * Math.pow(2, p.semi / 12);
      const mix = v.gain(0.7);
      for (let i = 0; i < 6; i++) {
        const o = v.osc('square');
        const r = U.lerp(R808[i], RALT[i], p.shape) * (1 + p.shape * 0.12 * i / 5);
        o.frequency.setValueAtTime(base * r, t);
        o.connect(mix);
      }
      const center = 5200 + p.color * 7500;
      const bp = v.filter('bandpass', center, 0.9);
      if (p.sweep > 0.01) glide(bp.frequency, t, Math.min(18000, center * (1 + p.sweep * 1.6)), center, 0.01 + p.sweep * 0.3);
      const hp = v.filter('highpass', 2400 + p.color * 4800, 0.7);
      const dec = 0.025 + Math.pow(p.decay, 2.2) * 2.6;
      const hold = p.contour * dec * 0.6;
      const amp = v.gain(0);
      amp.gain.setValueAtTime(1, t);
      amp.gain.setValueAtTime(1, t + hold);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + hold + dec);
      mix.connect(bp).connect(hp).connect(amp).connect(v.out);
      return hold + dec + 0.02;
    },
  });

  /* ===================== PERC =====================
     2-operator FM percussion: toms, congas, woodblocks, cowbells, claves. */
  const PERC_RATIOS = [0.5, 1, 1.41, 1.5, 2, 2.76, 3.5, 4.2, 5.4, 7.1];
  register({
    id: 'perc', name: 'PERC', glyph: 'perc', gm: 47,
    hint: { color: 'FM amount', shape: 'mod ratio', sweep: 'pitch drop', contour: 'mod decay' },
    show: { shape: v => '×' + pick(PERC_RATIOS, v / 127.001) },
    defaults: { pitch: 0, decay: 38, color: 40, shape: 40, sweep: 34, contour: 30 },
    play(v, p) {
      const t = v.t;
      const f0 = U.mtof(45 + p.semi);
      const r = pick(PERC_RATIOS, p.shape * 0.9999);
      const sw = 1 + p.sweep * 3;
      const tc = 0.008 + p.sweep * 0.04;
      const car = v.osc('sine'); glide(car.frequency, t, f0 * sw, f0, tc);
      const mod = v.osc('sine'); glide(mod.frequency, t, f0 * r * sw, f0 * r, tc);
      const idx = v.gain(0);
      idx.gain.setValueAtTime(Math.pow(p.color, 1.5) * f0 * r * 4 + 0.001, t);
      idx.gain.setTargetAtTime(0, t, 0.008 + p.contour * p.contour * 0.4);
      mod.connect(idx).connect(car.frequency);
      const dec = 0.03 + p.decay * p.decay * 1.6;
      const amp = v.gain(0); decayEnv(amp.gain, t, 0.9, dec);
      car.connect(amp).connect(v.out);
      return dec + 0.02;
    },
  });

  /* ===================== TONE =====================
     FM synth voice (carrier + modulator + feedback-style second modulator)
     for basses, plucks and leads. */
  const TONE_RATIOS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7, 9];
  register({
    id: 'tone', name: 'TONE', glyph: 'tone',
    hint: { color: 'mod ratio', shape: 'FM index', sweep: 'feedback', contour: 'mod envelope' },
    show: { color: v => '×' + pick(TONE_RATIOS, v / 127.001) },
    notes: p => [48 + Math.round(p.semi)],                    // MIDI export
    defaults: { pitch: -12, decay: 46, color: 30, shape: 44, sweep: 12, contour: 26 },
    play(v, p) {
      const t = v.t;
      const f0 = U.mtof(48 + p.semi);
      const r = pick(TONE_RATIOS, p.color * 0.9999);
      const car = v.osc('sine'), m1 = v.osc('sine'), m2 = v.osc('sine');
      if (p.slideSec > 0 && p.slideFrom != null && p.slideFrom !== p.semi) {   // SLIDE: glide from the last note
        const fs = U.mtof(48 + p.slideFrom), tc = p.slideSec / 4;
        glide(car.frequency, t, fs, f0, tc); glide(m1.frequency, t, fs * r, f0 * r, tc); glide(m2.frequency, t, fs * r, f0 * r, tc);
      } else {
        car.frequency.setValueAtTime(f0, t); m1.frequency.setValueAtTime(f0 * r, t); m2.frequency.setValueAtTime(f0 * r, t);
      }
      const envTc = 0.012 + p.contour * p.contour * 1.6;
      const sustain = p.contour > 0.85 ? (p.contour - 0.85) / 0.15 : 0;
      const i1 = v.gain(0); const d1 = p.shape * p.shape * f0 * r * 5 + 0.001;
      i1.gain.setValueAtTime(d1, t); i1.gain.setTargetAtTime(d1 * sustain, t, envTc);
      const i2 = v.gain(0); const d2 = p.sweep * p.sweep * f0 * r * 3 + 0.001;
      i2.gain.setValueAtTime(d2, t); i2.gain.setTargetAtTime(d2 * sustain, t, envTc);
      m2.connect(i2).connect(m1.frequency);
      m1.connect(i1).connect(car.frequency);
      const dec = 0.06 + p.decay * p.decay * 3.4;
      const amp = v.gain(0); decayEnv(amp.gain, t, 0.8, dec);
      car.connect(amp).connect(v.out);
      return dec + 0.02;
    },
  });

  /* ===================== CHORD =====================
     Detuned oscillator pairs voiced as a chord, through a plucked low-pass. */
  const CHORDS = [
    { n: '5', i: [0, 7, 12] }, { n: 'MIN', i: [0, 3, 7] }, { n: 'MAJ', i: [0, 4, 7] },
    { n: 'SUS2', i: [0, 2, 7] }, { n: 'SUS4', i: [0, 5, 7] }, { n: 'MIN7', i: [0, 3, 7, 10] },
    { n: 'MAJ7', i: [0, 4, 7, 11] }, { n: 'DOM7', i: [0, 4, 7, 10] }, { n: 'MIN9', i: [0, 3, 7, 10, 14] },
    { n: 'MAJ9', i: [0, 4, 7, 11, 14] }, { n: 'MIN11', i: [0, 3, 7, 10, 14, 17] }, { n: '6/9', i: [0, 4, 9, 14] },
    { n: 'DIM', i: [0, 3, 6] }, { n: 'AUG', i: [0, 4, 8] },
  ];
  register({
    id: 'chord', name: 'CHORD', glyph: 'chord',
    hint: { color: 'wave sine → saw', shape: 'chord type', sweep: 'detune spread', contour: 'filter pluck' },
    show: {
      shape: v => pick(CHORDS, v / 127.001).n,
      color: v => (v < 43 ? 'SINE' : v < 85 ? 'TRI' : 'SAW'),
    },
    defaults: { pitch: 0, decay: 52, color: 96, shape: 46, sweep: 40, contour: 54 },
    notes: p => pick(CHORDS, p.shape * 0.9999).i.map(iv => 48 + Math.round(p.semi) + iv),   // MIDI export
    play(v, p) {
      const t = v.t;
      const ch = pick(CHORDS, p.shape * 0.9999);
      const root = 48 + p.semi;
      const type = p.color < 0.34 ? 'sine' : p.color < 0.67 ? 'triangle' : 'sawtooth';
      const sum = v.gain(0.45 / Math.sqrt(ch.i.length * 2));
      const det = p.sweep * 28;
      ch.i.forEach(iv => {
        const f = U.mtof(root + iv);
        [-det, det].forEach(d => {
          const o = v.osc(type);
          o.frequency.setValueAtTime(f, t);
          o.detune.setValueAtTime(d, t);
          o.connect(sum);
        });
      });
      const f0 = U.mtof(root);
      const lp = v.filter('lowpass', 1000, 1.4);
      glide(lp.frequency, t, Math.min(18000, f0 * (1.6 + p.contour * 26)), f0 * 1.8 + 180, 0.02 + p.decay * 0.35);
      const dec = 0.1 + p.decay * p.decay * 4;
      const amp = v.gain(0); decayEnv(amp.gain, t, 1, dec);
      sum.connect(lp).connect(amp).connect(v.out);
      return dec + 0.02;
    },
  });
})(window.HX);
