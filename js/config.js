/* =====================================================================
   HEXTRIG · config.js
   Static tables only: constants, parameter specs, trig conditions,
   timing and LFO tables, plus small math helpers.
   Nothing in this file touches audio or the DOM.
   ===================================================================== */
window.HX = window.HX || {};

(function (HX) {
  'use strict';

  /* ---------- constants ---------- */
  HX.CONST = {
    TRACKS: 6,
    PATTERNS: 8,
    PAGE: 16,            // steps shown per page
    MAX_STEPS: 64,       // 16 → 32 → 64
    LOOKAHEAD: 0.12,     // seconds of audio scheduled ahead of the clock
    TICK_MS: 15,         // scheduler wake-up interval
    MICRO: 23,           // micro timing range: ±23/384 (24 ticks per 16th, Elektron style)
    STORAGE_KEY: 'hextrig.project.v1',
  };

  /* ---------- helpers ---------- */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  HX.util = {
    clamp,
    lerp: (a, b, t) => a + (b - a) * t,
    mtof: m => 440 * Math.pow(2, (m - 69) / 12),
    noteName: m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1),
    cutoffHz: v => 30 * Math.pow(18000 / 30, v / 127),
    hz: f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + 'k' : Math.round(f) + ''),
  };
  const U = HX.util;

  /* ---------- value formatters (used by sliders + OLED) ---------- */
  const fmt = {
    int: v => String(Math.round(v)),
    bi: v => (v > 0 ? '+' : '') + Math.round(v),
    pct: v => Math.round(v) + '%',
    pan: v => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v),
    semi: v => (v > 0 ? '+' : '') + v + ' st',
  };
  HX.fmt = fmt;

  /* ---------- timing tables ---------- */
  /* Positions in the sequencer are measured in 16th notes ("pos").
     Per-track speed is a ratio n/d = steps per 16th, so a step lasts d/n.
     Tuplet speeds (2/3, 4/3, 5/4, 3×) give triplet and quintuplet grids. */
  HX.SPEEDS = [
    { label: '1/8×', n: 1, d: 8 }, { label: '1/4×', n: 1, d: 4 }, { label: '1/3×', n: 1, d: 3 },
    { label: '1/2×', n: 1, d: 2 }, { label: '2/3×', n: 2, d: 3 }, { label: '3/4×', n: 3, d: 4 },
    { label: '1×', n: 1, d: 1 }, { label: '5/4×', n: 5, d: 4 }, { label: '4/3×', n: 4, d: 3 },
    { label: '3/2×', n: 3, d: 2 }, { label: '2×', n: 2, d: 1 }, { label: '3×', n: 3, d: 1 }, { label: '4×', n: 4, d: 1 },
  ];
  HX.SPEEDS.forEach(s => { s.mult = s.n / s.d; s.len = s.d / s.n; });
  HX.SPEED_1X = 6;
  HX.speedIndex = label => Math.max(0, HX.SPEEDS.findIndex(s => s.label === label));

  // Play direction per track.
  HX.DIRS = [
    { id: 'fwd', label: 'FORWARD', short: '' },
    { id: 'rev', label: 'REVERSE', short: 'REV' },
    { id: 'ping', label: 'PING-PONG', short: 'PING' },
    { id: 'pend', label: 'PENDULUM', short: 'PEND' },
    { id: 'rand', label: 'RANDOM', short: 'RND' },
    { id: 'drunk', label: 'DRUNK', short: 'DRNK' },
  ];

  // When a queued pattern takes over.
  HX.CHANGE_MODES = [
    { id: 'end', label: 'PATTERN END' },
    { id: 'bar', label: 'NEXT BAR' },
    { id: 'beat', label: 'NEXT BEAT' },
    { id: 'jump', label: 'JUMP (KEEP POS)' },
    { id: 'start', label: 'RESTART NOW' },
  ];

  // Parameter slide time, in steps. 0 = off (jump).
  HX.SLIDES = [0, 0.25, 0.5, 1, 2, 4, 8];

  // Trig length (gate), in steps. 0 = let the sound ring.
  HX.GATES = [0, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16];
  // LFO cycle length, in track steps.
  HX.LFO_RATES = [
    { label: '4 BAR', steps: 64 }, { label: '2 BAR', steps: 32 }, { label: '1 BAR', steps: 16 },
    { label: '1/2', steps: 8 }, { label: '3/8', steps: 6 }, { label: '1/4', steps: 4 }, { label: '3/16', steps: 3 },
    { label: '1/8', steps: 2 }, { label: '1/16', steps: 1 }, { label: '1/32', steps: 0.5 }, { label: '1/64', steps: 0.25 },
  ];
  HX.LFO_WAVES = ['SINE', 'TRI', 'SQUARE', 'SAW', 'RAMP', 'RANDOM', 'EXP'];
  // LFO destinations are parameter ids (see PARAMS below).
  HX.LFO_DESTS = ['pitch', 'decay', 'color', 'shape', 'sweep', 'contour', 'drive', 'cutoff', 'reso', 'pan', 'level', 'delay', 'reverb'];
  // Delay time divisions, in 16th notes.
  HX.DELAY_DIVS = [
    { label: '1/32', s: 0.5 }, { label: '1/16', s: 1 }, { label: '1/8T', s: 4 / 3 }, { label: '1/8', s: 2 },
    { label: '3/16', s: 3 }, { label: '1/4', s: 4 }, { label: '3/8', s: 6 }, { label: '1/2', s: 8 },
  ];
  // Retrig rates: hits per step (0 = off, 1 = repeat every step for RTRG LEN steps).
  HX.RETRIGS = [0, 1, 2, 3, 4, 5, 6, 8, 12, 16];
  HX.MAX_HITS = 64;   // hard cap on retrig hits per trig

  /* ---------- trig conditions ---------- */
  // kind: none | fill | pre | nei | first | ab      not: inverted
  const CONDS = [{ label: '—', kind: 'none' }];
  [['FILL', 'fill'], ['PRE', 'pre'], ['NEI', 'nei'], ['1ST', 'first']].forEach(([l, k]) => {
    CONDS.push({ label: l, kind: k, not: false });
    CONDS.push({ label: '!' + l, kind: k, not: true });
  });
  for (let b = 2; b <= 8; b++) for (let a = 1; a <= b; a++) CONDS.push({ label: a + ':' + b, kind: 'ab', a, b });
  HX.CONDS = CONDS;
  HX.condIndex = label => Math.max(0, CONDS.findIndex(c => c.label === label));

  /* ---------- sound parameters ----------
     Every track has all of these; any of them can be p-locked per step.
     page: popover tab.   lfo: 'trig' = sampled when the trig fires,
                               'cont' = follows the LFO for the whole note. */
  const enumP = (o, opts) => Object.assign(o, { type: 'enum', options: opts, min: 0, max: opts.length - 1, fmt: v => opts[v] });
  HX.PARAMS = [
    { id: 'pitch',   page: 'syn', label: 'PITCH',   min: -24, max: 24, def: 0, fmt: fmt.semi, bipolar: true, lfo: 'trig' },
    { id: 'decay',   page: 'syn', label: 'DECAY',   min: 0, max: 127, def: 48, lfo: 'trig' },
    { id: 'color',   page: 'syn', label: 'COLOR',   min: 0, max: 127, def: 64, lfo: 'trig' },
    { id: 'shape',   page: 'syn', label: 'SHAPE',   min: 0, max: 127, def: 64, lfo: 'trig' },
    { id: 'sweep',   page: 'syn', label: 'SWEEP',   min: 0, max: 127, def: 32, lfo: 'trig' },
    { id: 'contour', page: 'syn', label: 'CONTOUR', min: 0, max: 127, def: 32, lfo: 'trig' },

    { id: 'level',   page: 'amp', label: 'LEVEL',   min: 0, max: 127, def: 96, lfo: 'cont' },
    { id: 'attack',  page: 'amp', label: 'ATTACK',  min: 0, max: 127, def: 0, lfo: 'trig' },
    { id: 'drive',   page: 'amp', label: 'DRIVE',   min: 0, max: 127, def: 0, lfo: 'trig' },
    { id: 'pan',     page: 'amp', label: 'PAN',     min: -64, max: 63, def: 0, fmt: fmt.pan, bipolar: true, lfo: 'cont' },
    { id: 'delay',   page: 'amp', label: 'DELAY',   min: 0, max: 127, def: 0, lfo: 'cont' },
    { id: 'reverb',  page: 'amp', label: 'REVERB',  min: 0, max: 127, def: 0, lfo: 'cont' },

    { id: 'cutoff',  page: 'mod', label: 'CUTOFF',  min: 0, max: 127, def: 127, fmt: v => U.hz(U.cutoffHz(v)), lfo: 'cont' },
    { id: 'reso',    page: 'mod', label: 'RESO',    min: 0, max: 127, def: 0, lfo: 'cont' },
    enumP({ id: 'lfoRate', page: 'mod', label: 'LFO RATE', def: 2 }, HX.LFO_RATES.map(r => r.label)),
    enumP({ id: 'lfoWave', page: 'mod', label: 'LFO WAVE', def: 0 }, HX.LFO_WAVES),
    enumP({ id: 'lfoDest', page: 'mod', label: 'LFO DEST', def: 7 }, HX.LFO_DESTS.map(d => d.toUpperCase())),
    { id: 'lfoDepth', page: 'mod', label: 'LFO DEPTH', min: -63, max: 63, def: 0, fmt: fmt.bi, bipolar: true },
  ];
  HX.PARAM = Object.fromEntries(HX.PARAMS.map(p => [p.id, p]));
  HX.PARAMS.forEach(p => { p.fmt = p.fmt || fmt.int; });

  /* ---------- per-step trig parameters (TRIG tab) ---------- */
  HX.TRIG_PARAMS = [
    enumP({ id: 'trigless', label: 'TYPE', def: 0, hint: 'lock only = change the ringing note' }, ['NOTE', 'LOCK ONLY']),
    enumP({ id: 'slide', label: 'SLIDE', def: 0, hint: 'glide filter, level, pan, sends · TONE pitch' },
      HX.SLIDES.map(s => (s === 0 ? 'OFF' : (s < 1 ? '1/' + (1 / s) : s) + (s === 1 ? ' step' : s < 1 ? ' step' : ' steps')))),
    { id: 'note',   label: 'NOTE',      min: -24, max: 24, def: 0, fmt: fmt.semi, bipolar: true },
    { id: 'vel',    label: 'VELOCITY',  min: 1, max: 127, def: 100, fmt: fmt.int },
    { id: 'micro',  label: 'MICRO',     min: -23, max: 23, def: 0, bipolar: true, fmt: v => (v === 0 ? 'ON GRID' : (v > 0 ? '+' : '') + v + '/384') },
    enumP({ id: 'cond', label: 'CONDITION', def: 0, hint: 'FILL · PRE · NEI · 1ST · A:B' }, CONDS.map(c => c.label)),
    { id: 'prob',   label: 'CHANCE',    min: 0, max: 100, def: 100, fmt: fmt.pct },
    enumP({ id: 'gate', label: 'LENGTH', def: 0, hint: 'note length (choke + MIDI)' },
      HX.GATES.map(g => (g === 0 ? 'NATURAL' : g + (g === 1 ? ' step' : ' steps')))),
    enumP({ id: 'retrig', label: 'RETRIG', def: 0, hint: 'hits per step' }, HX.RETRIGS.map(r => (r ? r + '×' : 'OFF'))),
    { id: 'rlen',   label: 'RTRG LEN',  min: 1, max: 8, def: 1, fmt: v => v + (v > 1 ? ' steps' : ' step') },
    { id: 'rfade',  label: 'RTRG FADE', min: -64, max: 63, def: 0, fmt: fmt.bi, bipolar: true },
    { id: 'rcurve', label: 'RTRG CURVE', min: -63, max: 63, def: 0, bipolar: true, hint: 'decelerate ◀ · ▶ accelerate',
      fmt: v => (v === 0 ? 'EVEN' : v > 0 ? 'ACCEL ' + v : 'DECEL ' + -v) },
  ];

  /* ---------- transport / clock settings (TIME panel) ---------- */
  HX.CLOCK_PARAMS = [
    enumP({ id: 'change', label: 'PAT CHANGE', def: 0, hint: 'when a queued pattern starts' }, HX.CHANGE_MODES.map(m => m.label)),
    enumP({ id: 'swingGrid', label: 'SWING GRID', def: 0, hint: 'which notes swing' }, ['1/16', '1/8']),
    enumP({ id: 'metro', label: 'METRONOME', def: 0 }, ['OFF', 'ON', 'REC ONLY']),
    { id: 'metroLevel', label: 'CLICK LEVEL', min: 0, max: 127, def: 70, fmt: fmt.int },
    enumP({ id: 'countIn', label: 'COUNT-IN', def: 1, hint: 'before recording from stop' }, ['OFF', '1 BAR', '2 BARS']),
    { id: 'recQuant', label: 'REC QUANT', min: 0, max: 100, def: 100, fmt: fmt.pct, hint: 'below 100% keeps your feel as micro timing' },
    enumP({ id: 'sync', label: 'CLOCK', def: 0, hint: 'external = follow MIDI clock' }, ['INTERNAL', 'MIDI IN']),
    enumP({ id: 'clockOut', label: 'CLOCK OUT', def: 0, hint: 'send MIDI clock + start/stop' }, ['OFF', 'ON']),
  ];
  /* ---------- record + export (EXPORT panel) ---------- */
  HX.CAPTURE_BARS = [1, 2, 4, 8, 16, 32, 64, 0];          // 0 = until you stop
  HX.EXPORT_PARAMS = [
    enumP({ id: 'capBars', tab: 'CAPTURE', label: 'LENGTH', def: 2, hint: 'starts on the next bar line' },
      HX.CAPTURE_BARS.map(b => (b ? b + (b > 1 ? ' BARS' : ' BAR') : 'UNTIL STOPPED'))),
    enumP({ id: 'source', tab: 'BOUNCE', label: 'SOURCE', def: 0, hint: 'song = the whole song list once' }, ['THIS PATTERN', 'SONG']),
    { id: 'bars', tab: 'BOUNCE', label: 'BARS', min: 1, max: 64, def: 4, fmt: v => v + (v > 1 ? ' bars' : ' bar'), hint: 'from the top of the pattern' },
    enumP({ id: 'tail', tab: 'BOUNCE', label: 'TAIL', def: 2, hint: 'wrap = seamless loop' }, ['CUT', 'KEEP', 'WRAP TO START']),
    enumP({ id: 'mix', tab: 'BOUNCE', label: 'MIX', def: 1, hint: 'stereo master' }, ['OFF', 'ON']),
    enumP({ id: 'stems', tab: 'BOUNCE', label: 'STEMS', def: 1, hint: 'one WAV per track, with its FX' }, ['OFF', '6 STEMS']),
    enumP({ id: 'midi', tab: 'BOUNCE', label: 'MIDI', def: 1, hint: 'one MIDI track per track' }, ['OFF', 'ON']),
    enumP({ id: 'rate', tab: 'BOUNCE', label: 'SAMPLE RATE', def: 1 }, ['44.1 kHz', '48 kHz']),
    enumP({ id: 'bits', tab: 'BOTH', label: 'BIT DEPTH', def: 1 }, ['16-BIT', '24-BIT', '32-BIT FLOAT']),
  ];
  HX.defaultExport = () => Object.fromEntries(HX.EXPORT_PARAMS.map(p => [p.id, p.def]));

  HX.defaultClock = () => Object.assign(Object.fromEntries(HX.CLOCK_PARAMS.map(p => [p.id, p.def])), { midiOut: '', midiIn: '' });

  /* ---------- master FX (FX popover) ---------- */
  HX.FX_PARAMS = [
    enumP({ id: 'dlyTime', tab: 'FX', label: 'DLY TIME', def: 4 }, HX.DELAY_DIVS.map(d => d.label)),
    { id: 'dlyFb',   tab: 'FX', label: 'DLY FDBK',  min: 0, max: 127, def: 64, fmt: fmt.int },
    { id: 'dlyTone', tab: 'FX', label: 'DLY TONE',  min: 0, max: 127, def: 70, fmt: fmt.int },
    { id: 'revSize', tab: 'FX', label: 'REV SIZE',  min: 0, max: 127, def: 76, fmt: fmt.int },
    { id: 'revTone', tab: 'FX', label: 'REV TONE',  min: 0, max: 127, def: 60, fmt: fmt.int },
    { id: 'revPre',  tab: 'FX', label: 'REV PRE',   min: 0, max: 127, def: 10, fmt: v => Math.round(v / 127 * 250) + ' ms' },
    { id: 'mDrive',  tab: 'MASTER', label: 'DRIVE',  min: 0, max: 127, def: 18, fmt: fmt.int },
    { id: 'comp',    tab: 'MASTER', label: 'COMP',   min: 0, max: 127, def: 44, fmt: fmt.int },
    { id: 'volume',  tab: 'MASTER', label: 'VOLUME', min: 0, max: 127, def: 100, fmt: fmt.int },
  ];

  /* ---------- LFO waveforms ----------
     wave(w, phase, seed) → -1..1. Phase is unwrapped (cycles), so the
     RANDOM wave can hold one value per cycle. */
  const hash = (n, s) => { const x = Math.sin(n * 12.9898 + s * 78.233) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  HX.lfo = {
    wave(w, ph, seed = 0) {
      const f = ph - Math.floor(ph);
      switch (w) {
        case 0: return Math.sin(2 * Math.PI * f);
        case 1: return f < 0.5 ? -1 + 4 * f : 3 - 4 * f;
        case 2: return f < 0.5 ? 1 : -1;
        case 3: return 1 - 2 * f;
        case 4: return -1 + 2 * f;
        case 5: return hash(Math.floor(ph), seed + 1);
        case 6: return Math.exp(-f * 5) * 2 - 1;
        default: return 0;
      }
    },
  };
})(window.HX);
