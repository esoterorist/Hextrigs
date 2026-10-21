/* =====================================================================
   HEXTRIG · audio.js
   Everything that is not a machine, built as an Engine that can run on
   any BaseAudioContext: the live AudioContext, or an OfflineAudioContext
   when bouncing to WAV (export.js). Same code, same sound.

     · master chain   bus → DJ filter → drive → comp → limiter → out
     · send FX        ping-pong delay, generated-impulse reverb
     · track buses    6 × (dry, delay send, reverb send) with mute gates
     · voices         per-hit chain: machine → filter → drive → VCA → pan

   HX.audio.* is the live engine (the one you hear).
   HX.audio.Engine(ctx, opts) makes another one.
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const A = (HX.audio = {});

  /* ---------- value maps (param units → audio units) ---------- */
  const MAP = {
    cutoff: x => U.cutoffHz(x),
    reso: x => 0.5 + Math.pow(x / 127, 2) * 16,
    pan: x => U.clamp(x / 64, -1, 1),
    level: x => Math.pow(x / 100, 2),
    delay: x => Math.pow(x / 127, 2),
    reverb: x => Math.pow(x / 127, 2),
  };
  A.MAP = MAP;

  const curves = new Map(); // drive curves cached by amount (shared, context-free)
  function driveCurve(amount) {
    const key = Math.round(amount * 32);
    if (curves.has(key)) return curves.get(key);
    const k = 1 + (key / 32) * 14, n = 1024, c = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    curves.set(key, c);
    return c;
  }

  function lfoCurve(lfo, base, dur, id) {
    const d = HX.PARAM[id];
    const n = Math.max(8, Math.min(800, Math.ceil(dur * 100)));
    const out = new Float32Array(n);
    const span = (d.max - d.min) / 2;
    for (let k = 0; k < n; k++) {
      const tk = (k / (n - 1)) * dur;
      const w = HX.lfo.wave(lfo.wave, lfo.phase0 + tk / lfo.cycleSec, lfo.seed);
      out[k] = MAP[id](U.clamp(base + w * lfo.depth * span, d.min, d.max));
    }
    return out;
  }

  /* =====================================================================
     Engine
       ac     any BaseAudioContext
       opts   { fx, bpm, sweep, gates[6], clean }
              clean = skip the master drive / comp / limiter / DJ filter (stems)
     ===================================================================== */
  function Engine(ac, opts = {}) {
    const E = {};
    const M = {};
    const tracks = [];
    const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
    let bpm = opts.bpm || 120;

    const g = v => { const n = ac.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };

    M.bus = g(1);
    M.hp = bq('highpass', 10, 0.7);
    M.lp = bq('lowpass', 22000, 0.7);
    M.drive = ac.createWaveShaper(); M.drive.oversample = '2x';
    M.driveIn = g(1); M.driveOut = g(1);
    M.comp = ac.createDynamicsCompressor();
    M.comp.knee.value = 8; M.comp.attack.value = 0.004; M.comp.release.value = 0.18;
    M.makeup = g(1);
    M.limiter = ac.createDynamicsCompressor();
    M.limiter.threshold.value = -2.5; M.limiter.knee.value = 0; M.limiter.ratio.value = 20;
    M.limiter.attack.value = 0.001; M.limiter.release.value = 0.08;
    M.out = g(1);                       // program output (what Capture records)
    M.clickBus = g(1);                  // metronome: straight to the speakers, never recorded

    if (opts.clean) M.bus.connect(M.out);
    else M.bus.connect(M.hp).connect(M.lp).connect(M.driveIn).connect(M.drive).connect(M.driveOut)
      .connect(M.comp).connect(M.makeup).connect(M.limiter).connect(M.out);
    M.out.connect(ac.destination);
    M.clickBus.connect(ac.destination);
    if (!offline) { M.analyser = ac.createAnalyser(); M.analyser.fftSize = 1024; M.out.connect(M.analyser); }

    // ping-pong delay: in → hp → L → R → feedback(tone) → L
    M.dIn = g(1);
    M.dHP = bq('highpass', 160, 0.7);
    M.dL = ac.createDelay(4); M.dR = ac.createDelay(4);
    M.dTone = bq('lowpass', 4000, 0.5);
    M.dFb = g(0.5);
    M.dMerge = ac.createChannelMerger(2);
    M.dOut = g(0.9);
    M.dIn.connect(M.dHP).connect(M.dL);
    M.dL.connect(M.dMerge, 0, 0); M.dL.connect(M.dR);
    M.dR.connect(M.dMerge, 0, 1); M.dR.connect(M.dTone).connect(M.dFb).connect(M.dL);
    M.dMerge.connect(M.dOut).connect(M.bus);

    // reverb: in → predelay → convolver → tone → out
    M.rIn = g(1);
    M.rPre = ac.createDelay(1);
    M.rConv = ac.createConvolver();
    M.rTone = bq('lowpass', 6000, 0.5);
    M.rOut = g(0.85);
    M.rIn.connect(M.rPre).connect(M.rConv).connect(M.rTone).connect(M.rOut).connect(M.bus);

    // track buses
    for (let i = 0; i < HX.CONST.TRACKS; i++) {
      const tr = { dry: g(1), dly: g(1), rev: g(1), voices: [] };
      tr.dry.connect(M.bus); tr.dly.connect(M.dIn); tr.rev.connect(M.rIn);
      tracks.push(tr);
    }

    // shared noise buffer (2 s)
    const noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }

    /* ---------- reverb impulse ---------- */
    let lastImpulseKey = '', impulseTimer = null, pendingImpulse = '', lastCurve = -1;
    function makeImpulse(size, tone) {
      const key = size + ':' + tone;
      if (key === lastImpulseKey) return;
      lastImpulseKey = key;
      const s = size / 127, damp = 1 - tone / 127;
      const dur = 0.5 + s * 5.5;
      const len = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const tt = i / len;
          const c = 1 - Math.min(0.94, damp * (0.25 + tt * 1.1));   // darker as it decays
          lp += c * ((Math.random() * 2 - 1) - lp);
          d[i] = lp * Math.exp(-tt * (5 + (1 - s) * 3)) * (i < 64 ? i / 64 : 1);
        }
      }
      M.rConv.buffer = buf;
    }
    E.reverbSeconds = fx => 0.5 + (fx.revSize / 127) * 5.5;

    /* ---------- master FX / settings ---------- */
    E.applyFx = function (fx, immediate, newBpm) {
      if (newBpm) bpm = newBpm;
      const now = ac.currentTime;
      const set = immediate
        ? (param, v) => { param.cancelScheduledValues(0); param.value = v; }
        : (param, v, tc = 0.03) => param.setTargetAtTime(v, now, tc);
      const dt = Math.min(3.9, HX.DELAY_DIVS[fx.dlyTime].s * (15 / bpm));
      set(M.dL.delayTime, dt, 0.06); set(M.dR.delayTime, dt, 0.06);
      set(M.dFb.gain, (fx.dlyFb / 127) * 0.9);
      set(M.dTone.frequency, U.cutoffHz(50 + fx.dlyTone * 0.6));
      set(M.rPre.delayTime, (fx.revPre / 127) * 0.25);
      set(M.rTone.frequency, U.cutoffHz(60 + fx.revTone * 0.53));
      // rebuild the reverb only when its size or tone really changed (it is slow)
      const ik = fx.revSize + ':' + fx.revTone;
      if (immediate) { clearTimeout(impulseTimer); makeImpulse(fx.revSize, fx.revTone); }
      else if (ik !== lastImpulseKey && ik !== pendingImpulse) {
        clearTimeout(impulseTimer);
        pendingImpulse = ik;
        impulseTimer = setTimeout(() => { pendingImpulse = ''; makeImpulse(fx.revSize, fx.revTone); }, 160);
      }

      const dr = fx.mDrive / 127;
      // swapping a WaveShaper curve can click: only when the drive amount really changed
      const ck = Math.round(dr * 0.5 * 32);
      if (ck !== lastCurve) { M.drive.curve = driveCurve(dr * 0.5); lastCurve = ck; }
      set(M.driveIn.gain, 1 + dr * 1.5);
      set(M.driveOut.gain, 1 / (1 + dr * 0.9));
      const c = fx.comp / 127;
      set(M.comp.threshold, -4 - c * 26);
      set(M.comp.ratio, 1.5 + c * 6);
      set(M.makeup.gain, 1 + c * 0.9);
      set(M.out.gain, Math.pow(fx.volume / 100, 2) * 0.88);   // headroom below 0 dBFS
    };

    /* Master performance filter. v: -64 (low-pass sweep) … 0 (open) … +63 (high-pass sweep) */
    E.setSweep = function (v, immediate) {
      const now = ac.currentTime, x = Math.abs(v) / 64;
      const lpF = v < 0 ? 22000 * Math.pow(90 / 22000, Math.pow(x, 0.8)) : 22000;
      const hpF = v > 0 ? 10 * Math.pow(7000 / 10, Math.pow(x, 0.9)) : 10;
      const q = v === 0 ? 0.7 : 0.7 + x * 3.2;
      const set = (p, val, tc) => (immediate ? (p.value = val) : p.setTargetAtTime(val, now, tc));
      set(M.lp.frequency, lpF, 0.025); set(M.lp.Q, v < 0 ? q : 0.7, 0.05);
      set(M.hp.frequency, hpF, 0.025); set(M.hp.Q, v > 0 ? q : 0.7, 0.05);
    };

    /* Mute / solo gate for a track bus (0 or 1). */
    E.setGate = function (i, on, immediate) {
      const tr = tracks[i];
      [tr.dry, tr.dly, tr.rev].forEach(n => (immediate ? (n.gain.value = on ? 1 : 0) : n.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, 0.008)));
    };

    /* ---------- voices ----------
       snd: resolved sound (see seq.resolve)   vel: 0..1   gateSec: 0 = natural */
    E.voice = function (i, t, snd, vel, gateSec) {
      const tr = tracks[i];
      const nodes = [], srcs = [];
      const keep = n => (nodes.push(n), n);

      const input = keep(ac.createGain());
      const filt = keep(ac.createBiquadFilter()); filt.type = 'lowpass';
      filt.frequency.value = MAP.cutoff(snd.cutoff); filt.Q.value = MAP.reso(snd.reso);
      let tail = input.connect(filt);
      if (snd.drive > 1) {
        const sh = keep(ac.createWaveShaper());
        sh.curve = driveCurve(snd.drive / 127);
        sh.oversample = '2x';
        const pre = keep(ac.createGain()); pre.gain.value = 1 + (snd.drive / 127) * 1.2;
        tail = tail.connect(pre).connect(sh);
      }
      const vca = keep(ac.createGain());
      const att = Math.pow(snd.attack / 127, 2) * 1.5;
      vca.gain.value = 0;
      vca.gain.setValueAtTime(0, t);
      if (att > 0.002) vca.gain.linearRampToValueAtTime(vel, t + att);
      else vca.gain.setValueAtTime(vel, t);
      const lvl = keep(ac.createGain()); lvl.gain.value = MAP.level(snd.level);
      const pan = keep(ac.createStereoPanner()); pan.pan.value = MAP.pan(snd.pan);
      const sd = keep(ac.createGain()); sd.gain.value = MAP.delay(snd.delay);
      const sr = keep(ac.createGain()); sr.gain.value = MAP.reverb(snd.reverb);
      tail.connect(vca).connect(lvl).connect(pan);
      pan.connect(tr.dry); pan.connect(sd).connect(tr.dly); pan.connect(sr).connect(tr.rev);

      // monophonic per track. Voices can be created out of time order (a live pad
      // between scheduled notes), so: choke whatever is ringing at t, and end this
      // voice where the next already-scheduled one begins.
      let nextStart = Infinity;
      tr.voices.forEach(r => {
        if (r.t < t && r.end > t) r.choke(t);
        else if (r.t > t && r.t < nextStart) nextStart = r.t;
      });

      const v = {
        ac, t, out: input,
        osc(type) { const o = ac.createOscillator(); o.type = type; o.start(t); srcs.push(o); return o; },
        noise() { const n = ac.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(t, Math.random() * 1.5); srcs.push(n); return n; },
        gain(val = 0) { const n = keep(ac.createGain()); n.gain.value = val; return n; },
        filter(type, f, q = 0.7) { const b = keep(ac.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; },
      };

      let dur = att + snd.machine.play(v, snd.p);
      dur = Math.min(dur, 12);

      const params = { cutoff: filt.frequency, reso: filt.Q, level: lvl.gain, pan: pan.pan, delay: sd.gain, reverb: sr.gain };
      const lfoDest = snd.lfo ? snd.lfo.dest : null;
      const cur = {};
      Object.keys(params).forEach(id => { cur[id] = snd[id]; });

      // SLIDE: start from the previous step's values and glide to this one's
      if (snd.from && snd.from.sec > 0) {
        const tc = snd.from.sec / 4;
        Object.keys(params).forEach(id => {
          const from = snd.from.cont[id];
          if (from === undefined || id === lfoDest || from === snd[id]) return;
          params[id].setValueAtTime(MAP[id](from), t);
          params[id].setTargetAtTime(MAP[id](snd[id]), t, tc);
        });
      }

      // continuous LFO destinations get an automation curve for the note's life
      if (snd.lfo) {
        const id = snd.lfo.dest;
        const target = { cutoff: filt.frequency, reso: filt.Q, pan: pan.pan, level: lvl.gain, delay: sd.gain, reverb: sr.gain }[id];
        if (target) {
          try { target.setValueCurveAtTime(lfoCurve(snd.lfo, snd[id], dur, id), t, dur); } catch (e) { /* overlapping automation: ignore */ }
        }
      }

      const end = t + dur;
      srcs.forEach(s => s.stop(end + 0.05));
      if (!offline) {
        let done = false;
        const cleanup = () => { if (done) return; done = true; nodes.forEach(n => { try { n.disconnect(); } catch (e) {} }); };
        if (srcs.length) srcs[0].onended = cleanup;
      }

      const rec = {
        t, end, params, lfoDest, cur, pre: Object.assign({}, snd.pre || cur),
        kill() {   // silence a note that has not started yet (stop / pause)
          vca.gain.cancelScheduledValues(0); vca.gain.value = 0;
          srcs.forEach(s => { try { s.stop(t); } catch (e) {} });
        },
        choke(tc) {
          if (tc >= end) return;
          const gp = vca.gain;
          if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(tc); else gp.cancelScheduledValues(tc);
          gp.setTargetAtTime(0, tc, 0.004);
          srcs.forEach(s => { try { s.stop(tc + 0.04); } catch (e) {} });
        },
      };
      if (gateSec > 0 || nextStart < Infinity) rec.choke(Math.min(nextStart, gateSec > 0 ? t + gateSec : Infinity));
      const now = offline ? -1 : ac.currentTime;
      tr.voices = tr.voices.filter(r => r.end > now);
      if (offline && tr.voices.length > 8) tr.voices = tr.voices.slice(-8);
      tr.voices.push(rec);
      return rec;
    };

    // The voice that is sounding on track i at time t (the latest one started).
    function ringing(i, t) {
      let best = null;
      tracks[i].voices.forEach(r => { if (r.t <= t + 1e-6 && r.end > t && (!best || r.t > best.t)) best = r; });
      return best;
    }

    /* Lock-only step: move the ringing note's mix params (cutoff, level, …) at time t.
       vals = values to reach, pre = the same before the scene blend, slideSec 0 = jump. */
    E.lockVoice = function (i, t, vals, pre, slideSec) {
      const r = ringing(i, t);
      if (!r) return false;
      const tc = slideSec > 0 ? slideSec / 4 : 0.003;
      Object.keys(vals).forEach(id => {
        if (id === r.lfoDest || !r.params[id]) return;
        r.params[id].setTargetAtTime(MAP[id](vals[id]), t, tc);
        r.cur[id] = vals[id];
        if (pre && pre[id] !== undefined) r.pre[id] = pre[id];
      });
      return true;
    };

    /* Crossfader moved: re-blend the mix params of every note still sounding. */
    E.retouch = function (blend) {
      const now = ac.currentTime;
      tracks.forEach((tr, i) => tr.voices.forEach(r => {
        if (r.end <= now || !r.params) return;
        Object.keys(r.params).forEach(id => {
          if (id === r.lfoDest) return;
          const v = blend(i, id, r.pre[id]);
          if (Math.abs(v - r.cur[id]) < 1e-4) return;
          r.params[id].setTargetAtTime(MAP[id](v), Math.max(now, r.t), 0.025);   // ≈ the master FX glide
          r.cur[id] = v;
        });
      }));
    };

    /* Cancel every voice scheduled to start after `time` (tails already sounding keep ringing). */
    E.cancelAfter = function (time) {
      tracks.forEach(tr => {
        tr.voices.forEach(r => { if (r.t > time + 0.0005) r.kill(); });
        tr.voices = tr.voices.filter(r => r.t <= time + 0.0005);
      });
    };

    /* Metronome click: to the speakers only, never into recordings. */
    E.click = function (t, accent, level) {
      if (level <= 0) return;
      const o = ac.createOscillator(), gn = ac.createGain();
      o.type = 'sine';
      o.frequency.value = accent ? 2000 : 1300;
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.002);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(gn).connect(M.clickBus);
      o.start(t); o.stop(t + 0.06);
      o.onended = () => { o.disconnect(); gn.disconnect(); };
    };

    E.output = () => M.out;
    E.analyser = () => M.analyser || null;

    if (opts.fx) E.applyFx(opts.fx, true, opts.bpm);
    E.setSweep(opts.sweep || 0, true);
    if (opts.gates) opts.gates.forEach((on, i) => E.setGate(i, on, true));
    return E;
  }
  A.Engine = Engine;

  /* =====================================================================
     The live engine
     ===================================================================== */
  let ac = null, live = null;
  A._sweep = 0;
  A._gates = [1, 1, 1, 1, 1, 1];

  A.ctx = () => ac;
  A.now = () => (ac ? ac.currentTime : 0);
  A.analyser = () => (live ? live.analyser() : null);
  A.output = () => (live ? live.output() : null);

  /* Create (or resume) the context. Browsers only let audio start inside a user
     gesture; on phones that is the moment a finger LIFTS (touchend / pointerup /
     click), not when it touches down. See A.unlock and main.js. */
  A.ensure = function () {
    if (ac) { if (ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => {}); return ac; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ac = new Ctx({ latencyHint: 'interactive' });
    live = Engine(ac, { fx: PFfx(HX.state.project.fx), bpm: HX.state.project.bpm, sweep: PFsweep(A._sweep), gates: A._gates });
    ac.addEventListener('statechange', () => {
      if (HX.seq && HX.seq.onAudioState) HX.seq.onAudioState(ac.state);
      if (HX.state.changed) HX.state.changed();
    });
    return ac;
  };
  A.running = () => !!ac && ac.state === 'running';

  /* ---------- phones: unlocking sound ----------
     · iOS mutes web audio when the ring / silent switch is on silent, unless the
       page asks for "playback" audio. Newer iOS has navigator.audioSession for
       that; older iOS gets the same effect from a silent <audio> element.
     · iOS can also leave the context "interrupted" (another app, a call, the
       screen locking). Every gesture tries again until it is running. */
  let keepAlive = null;
  function silentWavURI() {
    const n = 4410, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);   // 0.1 s of 16-bit silence
    const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 88200, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  }
  A.unlock = function () {
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && !navigator.audioSession && !keepAlive) {
      try {
        keepAlive = document.createElement('audio');
        keepAlive.setAttribute('x-webkit-airplay', 'deny');
        keepAlive.preload = 'auto'; keepAlive.loop = true; keepAlive.playsInline = true;
        keepAlive.src = silentWavURI();
        const p = keepAlive.play();
        if (p && p.catch) p.catch(() => { keepAlive = null; });
      } catch (e) { keepAlive = null; }
    } else if (keepAlive && keepAlive.paused) { try { keepAlive.play().catch(() => {}); } catch (e) {} }
    const ctx = A.ensure();
    if (ctx.state !== 'running') {
      try {   // a one-sample buffer played inside the gesture: the classic iOS unlock
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination); src.start(0);
      } catch (e) {}
    }
    return ctx;
  };

  // Master FX and sweep go through the scene blend (perform.js).
  const PFfx = fx => (HX.perform && HX.state.project ? HX.perform.fx(fx) : fx);
  const PFsweep = v => (HX.perform && HX.state.project ? HX.perform.sweep(v) : v);
  A.applyFx = (fx, immediate) => { if (live) live.applyFx(PFfx(fx), immediate, HX.state.project.bpm); };
  A.setSweep = v => { A._sweep = v; if (live) live.setSweep(PFsweep(v)); };
  A.lockVoice = (i, t, vals, pre, sec) => (live ? live.lockVoice(i, t, vals, pre, sec) : false);
  A.retouch = () => {
    if (!live || !HX.perform) return;
    const view = HX.perform.view();
    live.retouch((i, id, base) => HX.perform.blend(view, 't', i, id, base));
  };
  // A slider moved during live REC: let the ringing note follow right away.
  A.lockNow = (i, id, v) => {
    if (!live || HX.sound.CONT.indexOf(id) < 0) return;
    const view = HX.perform ? HX.perform.view() : null;
    live.lockVoice(i, ac.currentTime + 0.005, { [id]: view ? HX.perform.blend(view, 't', i, id, v) : v }, { [id]: v }, 0);
  };
  A.setGate = (i, on) => { A._gates[i] = on; if (live) live.setGate(i, on); };
  A.voice = (i, t, snd, vel, gateSec) => (live ? live.voice(i, t, snd, vel, gateSec) : null);
  A.cancelAfter = time => { if (live) live.cancelAfter(time); };
  A.click = (t, accent, level) => { if (live) live.click(t, accent, level); };
})(window.HX);
