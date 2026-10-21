/* =====================================================================
   HEXTRIG · sequencer.js
   The transport: connects the pure timing core (seqcore.js) to the real
   world. It owns the clock and decides *when*, the core decides *what*.

     timer      a Worker wakes us every TICK_MS (keeps going in background tabs)
     tempo map  pos ↔ audio seconds (clock.js); tempo changes, nudge and
                MIDI clock sync all go through it, so nothing jumps
     dispatch   core events → audio voices (via sound.js Player), MIDI out,
                metronome, UI queue
     motion rec while REC is on and playing, moving a slider writes a lock
                on the step that is playing (a lock-only step if it is empty)

   Robustness
     · stalls (sleeping laptop, busy tab): the grid is shifted to "now"
       instead of firing a burst of late notes; counted in seq.stats
     · late notes beyond 30 ms are dropped, smaller lateness is clamped
     · AudioContext interruptions (iOS, device change): re-anchored on resume
     · stop / pause cancel every note already scheduled past that moment
     · pause → continue resumes from an exact core snapshot
   ===================================================================== */
(function (HX) {
  'use strict';
  const C = HX.CONST, U = HX.util, S = HX.state, A = HX.audio;

  const seq = (HX.seq = {
    playing: false,
    paused: false,
    rec: false,
    fill: false,
    fillLatch: false,
    nudge: 0,                     // -1, 0, +1 while a nudge key is held
    mutes: [0, 0, 0, 0, 0, 0],
    solos: [0, 0, 0, 0, 0, 0],
    events: [],                   // { t, type, … } for the UI, drained by main.js
    stats: { late: 0, stalls: 0, lastStall: -1 },
    waitExt: false,               // armed, waiting for an external MIDI start
    uiMaster: 0, uiPos: 0, uiCount: 0,
  });

  const core = HX.core.create(() => S.project);
  const map = new HX.TempoMap(124);
  seq.core = core;
  seq.map = map;

  const clockCfg = () => S.project.clock;
  const extSync = () => clockCfg().sync === 1;
  const bpmNow = () => (extSync() && ext.bpm ? ext.bpm : U.clamp(S.project.bpm * (1 + seq.nudge * 0.04), 20, 400));
  const stepSec = (T, spp) => (spp || map.spp) * HX.SPEEDS[T.speed].len;
  seq.stepDur = stepSec;
  const player = HX.sound.Player(A);      // live: the audio module is the engine
  const resolve = (i, T, st, lfoPos, spp, view) => HX.sound.resolve(i, T, st, lfoPos, spp || map.spp, view);
  seq.resolve = resolve;

  /* ---------- timer ---------- */
  let worker = null, interval = null;
  // Three clocks, any one is enough: the Worker (keeps time in background tabs),
  // a plain interval if the Worker never answers (some in-app browsers block
  // workers without an error), and the screen's animation frame (main.js → pump).
  let workerAlive = false;
  seq.timer = () => (workerAlive ? 'worker' : interval ? 'interval' : 'frames');
  function startTimer() {
    stopTimer();
    try {
      if (!worker) {
        const src = 'let id=null;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = () => { workerAlive = true; tick(); };
        worker.onerror = () => { worker = null; workerAlive = false; if (seq.playing && !interval) interval = setInterval(tick, C.TICK_MS); };
      }
      worker.postMessage(C.TICK_MS);
    } catch (e) {
      worker = null;
    }
    setTimeout(() => { if (seq.playing && !workerAlive && !interval) interval = setInterval(tick, C.TICK_MS); }, 250);
    if (!worker) interval = setInterval(tick, C.TICK_MS);
  }
  seq.pump = () => { if (seq.playing) tick(); };
  function stopTimer() {
    if (worker) { try { worker.postMessage(0); } catch (e) {} }
    if (interval) clearInterval(interval);
    interval = null;
  }

  /* ---------- the loop ---------- */
  function tick() {
    if (!seq.playing) return;
    const ac = A.ctx();
    if (!ac || ac.state !== 'running') return;
    const now = ac.currentTime;
    const f = core.frontier();
    if (!extSync()) map.retempo(f, bpmNow());
    // stalled? move the grid instead of bursting late notes
    if (map.timeAt(f) < now + 0.004) {
      map.shift(f, now + 0.03);
      seq.stats.stalls++;
      seq.stats.lastStall = now;
    }
    seq.stats.ticks = (seq.stats.ticks || 0) + 1;
    const horizon = map.posAt(now + C.LOOKAHEAD);
    const evs = core.advanceTo(horizon);
    for (let k = 0; k < evs.length; k++) dispatch(evs[k], now);
    if (HX.rec) HX.rec.tick(now);
  }

  function dispatch(e, now) {
    let t = map.timeAt(e.pos);
    switch (e.kind) {
      case 'note': {
        t += (e.ms || 0) / 1000;
        if (t < now) {
          if (now - t > 0.03) { seq.stats.late++; return; }
          t = now + 0.001;
        }
        const T = S.project.patterns[e.patI].tracks[e.track];
        const st = T.steps[e.step];
        if (!st) return;
        const gateSec = e.gate ? e.gate * map.spp : 0;
        const { snd } = player.note(e.track, t, T, st, e.lfoPos, e.vel, gateSec, map.spp);
        if (HX.rec) HX.rec.note(e.pos + (e.ms || 0) / 1000 / map.spp, e.track, T, st, snd, e.vel, e.gate || HX.SPEEDS[T.speed].len);
        if (T.midiCh && HX.midi) {
          const note = U.clamp(T.midiNote + st.note + (T.machine === 'tone' || T.machine === 'chord' ? T.params.pitch : 0), 0, 127);
          HX.midi.note(T.midiCh, note, e.vel, t, gateSec || stepSec(T) * 0.9);
        }
        seq.stats.notes = (seq.stats.notes || 0) + 1;
        seq.events.push({ t, type: 'trig', track: e.track, vel: e.vel });
        return;
      }
      case 'lock': {
        if (t < now) { if (now - t > 0.03) return; t = now + 0.001; }
        const T = S.project.patterns[e.patI].tracks[e.track];
        const st = T.steps[e.step];
        if (st) player.lock(e.track, t, T, st, map.spp);
        return;
      }
      case 'step':
        seq.events.push({ t, type: 'step', track: e.track, step: e.step, patI: e.patI });
        return;
      case 'master':
        seq.events.push({ t, type: 'master', step: e.step, pos: e.pos, patLoop: e.patLoop, count: !!e.count });
        return;
      case 'beat': {
        const m = clockCfg().metro;
        if (e.count || m === 1 || (m === 2 && seq.rec)) A.click(Math.max(t, now), e.accent, clockCfg().metroLevel / 127);
        return;
      }
      case 'clock':
        if (HX.midi) HX.midi.clock(Math.max(t, now));
        if (e.pos === 0 && HX.midi && seq._sendStart) { seq._sendStart = false; HX.midi.start(Math.max(t - 0.001, now)); }
        return;
      case 'pattern':
        seq.events.push({ t, type: 'pattern', pat: e.pat, song: e.song });
        return;
      case 'songEnd':
        seq.events.push({ t, type: 'songEnd' });
        return;
    }
  }

  function fireNow(i, snd, vel) {
    const t = A.now() + 0.004;
    A.voice(i, t, snd, vel, 0);
    seq.events.push({ t, type: 'trig', track: i, vel });
    return t;
  }

  /* ---------- transport ---------- */
  function startEngine(startPos, t0) {
    core.reset(startPos, seq._startPat, seq._startSong);
    core.setClockOut(clockCfg().clockOut === 1);
    core.fill = seq.fill;
    map.set(startPos, t0, bpmNow());
    seq.playing = true; seq.paused = false; seq.waitExt = false;
    seq.events.length = 0;
    seq.stats.late = 0; seq.stats.stalls = 0;
    player.reset();
    startTimer();
    tick();
    S.changed();
  }

  seq.start = function (opts = {}) {
    const ac = A.unlock();
    A.triedSound = true;
    if (seq.playing) return;
    if (seq.paused && !opts.fromTop) { seq.cont(); return; }
    if (extSync() && !opts.external) { seq.waitExt = !seq.waitExt; S.changed(); return; }
    const song = S.project.song;
    const songOn = song.on && song.entries.length;
    seq._startPat = songOn ? song.entries[0].p : S.project.current;
    seq._startSong = 0;
    if (songOn) S.project.current = seq._startPat;
    const count = seq.rec && !opts.external ? [0, 16, 32][clockCfg().countIn] || 0 : 0;
    const t0 = opts.at != null ? opts.at : ac.currentTime + 0.08;
    const midiOn = clockCfg().clockOut === 1 && HX.midi;
    if (midiOn) {
      if (count) seq._sendStart = true;           // Start goes out right before pos 0
      else HX.midi.start(t0 - 0.001);
    }
    startEngine(-count, t0);                        // pos -count happens at t0
  };

  function silenceAfter(t) {
    A.cancelAfter(t);
    if (HX.midi) HX.midi.panic();
  }

  seq.stop = function () {
    if (HX.rec) HX.rec.transportStopped();
    const was = seq.playing || seq.paused || seq.waitExt;
    seq.playing = false; seq.paused = false; seq.waitExt = false;
    stopTimer();
    silenceAfter(A.now());
    if (was && HX.midi && clockCfg().clockOut === 1) HX.midi.stop(A.now());
    seq.events.length = 0;
    seq.events.push({ t: 0, type: 'stop' });
    S.changed();
  };

  // Pause: rewind the core to the last 16th that was actually heard.
  seq.pause = function () {
    if (!seq.playing) return;
    if (HX.rec) HX.rec.transportStopped();
    const now = A.now();
    const heard = map.posAt(now - (A.ctx().outputLatency || 0));
    const snap = core.snapBefore(heard);
    seq.playing = false; seq.paused = true;
    stopTimer();
    silenceAfter(now);
    if (snap) core.restore(snap);
    if (HX.midi && clockCfg().clockOut === 1) HX.midi.stop(now);
    seq.events.length = 0;
    S.changed();
  };

  seq.cont = function (atTime) {
    if (!seq.paused) return;
    const ac = A.ensure();
    const t0 = atTime != null ? atTime : ac.currentTime + 0.06;
    map.set(core.frontier(), t0, bpmNow());
    seq.playing = true; seq.paused = false;
    if (HX.midi && clockCfg().clockOut === 1) HX.midi.cont(t0 - 0.001);
    startTimer();
    tick();
    S.changed();
  };

  seq.toggle = () => (seq.playing ? seq.stop() : seq.start({ fromTop: true }));
  seq.togglePause = () => (seq.playing ? seq.pause() : seq.paused ? seq.cont() : seq.start());

  // Interrupted audio (iOS call, Bluetooth switch): re-anchor when it comes back.
  seq.onAudioState = function (state) {
    if (state === 'running' && seq.playing) map.shift(core.frontier(), A.now() + 0.05);
  };

  /* ---------- patterns ---------- */
  seq.queue = function (n) {
    if (!seq.playing) {
      S.project.current = n;
      if (seq.paused) { seq.paused = false; seq.events.push({ t: 0, type: 'stop' }); }
      S.changed();
      return;
    }
    const info = core.info();
    // clicking the playing pattern, or the queued one again, cancels the queue
    if (n === info.pat || (info.pending && info.pending.pat === n)) core.queue(null);
    else core.queue(n);
    S.changed();
  };
  seq.queued = function () {
    if (!seq.playing) return null;
    const p = core.info().pending;
    return p ? p.pat : null;
  };
  seq.info = () => core.info();

  seq.setFill = on => { seq.fill = !!on; core.fill = seq.fill; S.changed(); };
  seq.setNudge = d => { seq.nudge = d; S.changed(); };
  seq.setClockOut = on => { core.setClockOut(on); };

  /* ---------- mutes ---------- */
  function applyGates() {
    const anySolo = seq.solos.some(Boolean);
    for (let i = 0; i < C.TRACKS; i++) A.setGate(i, anySolo ? (seq.solos[i] ? 1 : 0) : (seq.mutes[i] ? 0 : 1));
  }
  seq.toggleMute = i => { seq.mutes[i] = seq.mutes[i] ? 0 : 1; applyGates(); S.changed(); };
  seq.toggleSolo = i => { seq.solos[i] = seq.solos[i] ? 0 : 1; applyGates(); S.changed(); };
  seq.audible = i => (seq.solos.some(Boolean) ? !!seq.solos[i] : !seq.mutes[i]);

  /* ---------- live play, preview, recording ---------- */
  seq.pad = function (i, vel = 0.85, note = 0) {
    A.ensure();
    A.triedSound = true;
    const T = S.track(i);
    const st = note ? S.mkStep({ note }) : null;
    const snd = resolve(i, T, st, 0);
    const t = fireNow(i, snd, vel);
    if (HX.rec && seq.playing) HX.rec.note(map.posAt(t), i, T, st || S.mkStep(), snd, vel, HX.SPEEDS[T.speed].len);
    if (T.midiCh && HX.midi) HX.midi.note(T.midiCh, U.clamp(T.midiNote + note, 0, 127), vel, t, stepSec(T) * 0.9);
    if (seq.rec) record(i, Math.round(vel * 127), note, t);
  };

  seq.preview = function (i, k) {
    if (seq.playing) return;
    const T = S.track(i), st = T.steps[k];
    if (!st || st.trigless) return;
    A.ensure();
    fireNow(i, resolve(i, T, st, k), st.vel / 127);
  };

  // Motion recording. Returns the step it wrote to, or null when not recording.
  seq.recLock = function (i, id, v) {
    if (!seq.rec || !seq.playing) return null;
    const pos = seq.posNow();
    if (pos < 0) return null;
    const hit = core.recordHit(i, pos, 100, 'current');
    const T = S.project.patterns[hit.patI].tracks[i];
    let s = T.steps[hit.step];
    if (!s) { s = S.mkStep({ trigless: 1 }); T.steps[hit.step] = s; }
    s.locks[id] = v;
    A.lockNow(i, id, v);
    return hit.step;
  };

  function record(i, vel, note, t) {
    let patI = S.project.current, k, micro = 0;
    if (seq.playing) {
      const pos = map.posAt(t - (A.ctx().outputLatency || 0));
      if (pos < 0) return;                             // still counting in
      const hit = core.recordHit(i, pos, clockCfg().recQuant);
      patI = hit.patI; k = hit.step; micro = hit.micro;
    } else {
      k = HX.ui.cursor % S.track(i).len;               // step record: write at the cursor
    }
    S.commit();
    const T = S.project.patterns[patI].tracks[i];
    const s = T.steps[k] || S.mkStep();
    s.vel = vel; s.note = note; s.micro = micro; s.trigless = 0;    // a hit turns a lock-only step into a trig
    T.steps[k] = s;
    S.changed();
  }

  /* ---------- external MIDI clock ---------- */
  const ext = (seq.ext = { last: 0, per: 0, bpm: 0, pulses: 0, armed: null });
  seq.extClock = function (t) {
    if (ext.last) {
      const d = t - ext.last;
      if (d > 0.002 && d < 0.25) { ext.per = ext.per ? ext.per * 0.88 + d * 0.12 : d; ext.bpm = U.clamp(60 / (ext.per * 24), 20, 400); }
    }
    ext.last = t;
    if (!extSync()) return;
    if (ext.armed) {
      const how = ext.armed; ext.armed = null; ext.pulses = 0;
      if (how === 'start') { seq.stop(); seq.start({ external: true, at: Math.max(t, A.now() + 0.005) }); }
      else if (how === 'cont') { ext.pulses = Math.round(core.frontier() * 6); seq.cont(Math.max(t, A.now() + 0.005)); }
      return;
    }
    if (!seq.playing) return;
    ext.pulses++;
    // phase-locked loop: steer the tempo map toward the incoming pulses
    const pos = ext.pulses / 6, pred = map.timeAt(pos), err = t - pred;
    if (Math.abs(err) > 0.2) map.shift(pos, t, ext.bpm || map.bpm);
    else map.shift(pos, pred + err * 0.12, ext.bpm || map.bpm);
  };
  seq.extStart = () => { if (extSync()) { ext.armed = 'start'; seq.waitExt = true; S.changed(); } };
  seq.extCont = () => { if (extSync()) { ext.armed = seq.paused ? 'cont' : 'start'; S.changed(); } };
  seq.extStop = () => { if (extSync()) { ext.armed = null; if (seq.playing) seq.pause(); else seq.stop(); } };

  /* ---------- for the UI ---------- */
  seq.drain = function (now) {
    const due = [], keep = [];
    for (const e of seq.events) (e.t <= now ? due : keep).push(e);
    seq.events = keep;
    return due;
  };
  seq.posNow = () => (seq.playing ? map.posAt(A.now() - (A.ctx() ? A.ctx().outputLatency || 0 : 0)) : core.frontier());
})(window.HX);
