/* =====================================================================
   HEXTRIG · panel.js
   The pop-up parameter panel and the slider component.

   Modes
     sound   edit a track's sound          tabs: SOUND · SYN · AMP · MOD · TRK · TOOL
     lock    p-lock the selected step(s)   tabs: TRIG · SOUND · SYN · AMP · MOD
     perform scenes                        tabs: SCENES

   Where a sound slider writes (sound mode), first match wins:
     scene edit → the scene     control all → all six tracks
     live REC   → a lock on the playing step     otherwise → the track
     master  master FX                     tabs: FX · MASTER
     clock   transport + arrangement       tabs: CLOCK · SONG · MIDI
     export  record + export               tabs: CAPTURE · BOUNCE · TAKES

   A "row" is a plain object the slider binds to:
     { key, label, hint, min, max, bipolar, fmt(v), get(), set(v), locked(), reset() }
   min / max may be functions (read live). Add a control = add a row.
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util, S = HX.state;
  const P = (HX.panel = { st: null, clip: null });
  let el, titleEl, chipEl, tabsEl, bodyEl;
  let rows = [], structKey = '';
  const lastTab = { sound: 'SYN', lock: 'TRIG', master: 'FX', clock: 'CLOCK', export: 'CAPTURE', perform: 'SCENES' };
  const PF = HX.perform, LIB = HX.library;
  const TABS = {
    sound: ['SOUND', 'SYN', 'AMP', 'MOD', 'TRK', 'TOOL'], lock: ['TRIG', 'SOUND', 'SYN', 'AMP', 'MOD'], perform: ['SCENES'],
    master: ['FX', 'MASTER'], clock: ['CLOCK', 'SONG', 'MIDI'], export: ['CAPTURE', 'BOUNCE', 'TAKES'],
  };
  const val = x => (typeof x === 'function' ? x() : x);

  /* ===================== slider component ===================== */
  P.slider = function (row, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'sl' + (opts.compact ? ' sl-compact' : '');
    wrap.innerHTML =
      '<div class="sl-label"><span class="sl-name"></span><small class="sl-hint"></small></div>' +
      '<div class="sl-track" role="slider" tabindex="0"><div class="sl-fill"></div><div class="sl-zero"></div><div class="sl-thumb"></div></div>' +
      '<output class="sl-val"></output>';
    const track = wrap.querySelector('.sl-track');
    const out = wrap.querySelector('.sl-val');
    wrap.querySelector('.sl-name').textContent = row.label;
    wrap.querySelector('.sl-hint').textContent = row.hint || '';
    track.setAttribute('aria-label', row.label);
    track.classList.toggle('bipolar', !!row.bipolar);

    const range = () => ({ min: val(row.min), max: val(row.max) });
    function update() {
      const { min, max } = range();
      const v = row.get();
      const n = (v - min) / (max - min || 1);
      let a = 0, b = n;
      if (row.bipolar) { const z = (0 - min) / (max - min); a = Math.min(z, n); b = Math.max(z, n); track.style.setProperty('--z', z); }
      track.style.setProperty('--a', a);
      track.style.setProperty('--b', b);
      track.style.setProperty('--n', n);
      out.textContent = row.fmt(v);
      track.setAttribute('aria-valuemin', min); track.setAttribute('aria-valuemax', max);
      track.setAttribute('aria-valuenow', v); track.setAttribute('aria-valuetext', row.fmt(v));
      wrap.classList.toggle('locked', !!(row.locked && row.locked()));
    }
    function setV(v) {
      const { min, max } = range();
      v = Math.round(U.clamp(v, min, max));
      if (v !== row.get()) {
        row.set(v);
        P.edited(row, v, (v - min) / (max - min || 1));
      }
      update();
    }
    const posToVal = e => {
      const r = track.getBoundingClientRect(), { min, max } = range();
      return min + U.clamp((e.clientX - r.left) / r.width, 0, 1) * (max - min);
    };

    let drag = null;
    track.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      track.focus({ preventScroll: true });
      S.commit();
      track.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, v: row.get(), fine: e.shiftKey };
      if (!drag.fine) setV(posToVal(e));
      wrap.classList.add('active');
    });
    track.addEventListener('pointermove', e => {
      if (!drag) return;
      if (e.shiftKey || drag.fine) {
        const { min, max } = range(), w = track.getBoundingClientRect().width;
        setV(drag.v + ((e.clientX - drag.x) / w) * (max - min) * 0.2);
      } else setV(posToVal(e));
    });
    const end = () => { drag = null; wrap.classList.remove('active'); };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('dblclick', () => { S.commit(true); row.reset(); P.edited(row, row.get(), 0); update(); });
    track.addEventListener('wheel', e => {
      e.preventDefault();
      S.commit();
      setV(row.get() + (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1));
    }, { passive: false });
    track.addEventListener('keydown', e => {
      const { min, max } = range(), big = Math.max(1, Math.round((max - min) / 10));
      const map = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: big, PageDown: -big };
      if (e.key in map) { e.preventDefault(); e.stopPropagation(); S.commit(); setV(row.get() + map[e.key] * (e.shiftKey ? big : 1)); }
      else if (e.key === 'Home') { e.preventDefault(); setV(min); }
      else if (e.key === 'End') { e.preventDefault(); setV(max); }
    });
    update();
    return { el: wrap, update, row };
  };

  // Called by every slider after a change.
  P.edited = function (row, v, norm) {
    if (HX.oled) HX.oled.show(row.label, row.fmt(v), norm, row.bipolar);
    S.changed();
  };

  /* ===================== row factories ===================== */
  function selSteps(T) {
    const s = HX.ui.sel;
    if (!s) return [];
    return [...s.steps].map(k => T.steps[k]).filter(Boolean);
  }

  function soundRow(d, i, mode) {
    const T = () => S.track(i);
    const first = () => selSteps(T())[0];
    // under a sound lock the step plays another machine: show its names and values
    const machineId = () => { const s = mode === 'lock' && first(); return s && s.slock ? s.slock.machine : T().machine; };
    const m = () => HX.machines.byId[machineId()];
    const lockBase = s => (s ? HX.sound.base(T(), s).params[d.id] : T().params[d.id]);
    const scene = () => (mode === 'sound' ? PF.editScene() : null);
    const show = m().show && m().show[d.id];
    let shadow;                                    // the value last written during live REC
    return {
      key: d.id, label: d.label, hint: m().hint ? m().hint[d.id] : '',
      min: d.min, max: d.max, bipolar: d.bipolar,
      fmt: show || d.fmt,
      get() {
        if (mode === 'lock') { const s = first(); return s && s.locks[d.id] !== undefined ? s.locks[d.id] : lockBase(s); }
        const sc = scene();
        if (sc && sc.t[i][d.id] !== undefined) return sc.t[i][d.id];
        if (shadow !== undefined && HX.seq.rec && HX.seq.playing && !sc && !PF.all) return shadow;
        return T().params[d.id];
      },
      set(v) {
        if (mode === 'lock') { selSteps(T()).forEach(s => { s.locks[d.id] = v; }); return; }
        const sc = scene();
        if (sc) { sc.t[i][d.id] = v; PF.refresh(); return; }
        if (PF.all) { PF.allSet(i, d.id, v); return; }
        const k = HX.seq.recLock(i, d.id, v);
        if (k != null) { shadow = v; P.recNote = 'REC LOCK · STEP ' + String(k + 1).padStart(2, '0'); return; }
        T().params[d.id] = v; T().sdirty = 1;
      },
      locked: () => (mode === 'lock' ? selSteps(T()).some(s => s.locks[d.id] !== undefined) : !!(scene() && scene().t[i][d.id] !== undefined)),
      reset() {
        if (mode === 'lock') { selSteps(T()).forEach(s => { delete s.locks[d.id]; }); return; }
        const sc = scene();
        if (sc) { delete sc.t[i][d.id]; PF.refresh(); return; }
        const def = m().defaults[d.id] !== undefined ? m().defaults[d.id] : d.def;
        if (PF.all) { PF.allSet(i, d.id, def); return; }
        T().params[d.id] = def;
      },
    };
  }

  function trigRow(d, i) {
    const T = () => S.track(i);
    return {
      key: d.id, label: d.label, hint: d.hint || '', min: d.min, max: d.max, bipolar: d.bipolar, fmt: d.fmt,
      get() { const s = selSteps(T())[0]; return s ? s[d.id] : d.def; },
      set(v) { selSteps(T()).forEach(s => { s[d.id] = v; }); },
      reset() { selSteps(T()).forEach(s => { s[d.id] = d.def; }); },
    };
  }

  // A row bound to a field of some object (track settings, clock, pattern …).
  function fieldRow(key, label, min, max, fmt, obj, def, hint, onSet) {
    return {
      key, label, hint: hint || '', min, max, fmt,
      get: () => obj()[key],
      set: v => { obj()[key] = v; if (onSet) onSet(v); },
      reset: () => { obj()[key] = def; if (onSet) onSet(def); },
    };
  }
  const enumFmt = list => v => (list[v] && (list[v].label || list[v])) || '—';

  function trackRows(i) {
    const T = () => S.track(i);
    return [
      fieldRow('len', 'LENGTH', 1, 64, v => v + ' steps', T, 16, 'per-track length (polymeter)'),
      fieldRow('speed', 'SPEED', 0, HX.SPEEDS.length - 1, enumFmt(HX.SPEEDS), T, HX.SPEED_1X, 'step rate · tuplets 2/3 4/3 5/4'),
      fieldRow('dir', 'DIRECTION', 0, HX.DIRS.length - 1, enumFmt(HX.DIRS), T, 0, 'play order'),
      {
        key: 'swing', label: 'SWING', hint: 'this track only', min: 49, max: 80,
        fmt: v => (v < 50 ? 'GLOBAL' : v + '%'),
        get: () => (T().swing >= 50 ? T().swing : 49), set: v => { T().swing = v < 50 ? 0 : v; }, reset: () => { T().swing = 0; },
      },
      fieldRow('humT', 'HUMAN TIME', 0, 100, v => (v ? '±' + Math.round(v * 0.3) + ' ms' : 'OFF'), T, 0, 'loose timing'),
      fieldRow('humV', 'HUMAN VEL', 0, 100, v => (v ? '±' + Math.round(v * 0.4) : 'OFF'), T, 0, 'loose velocity'),
      fieldRow('chance', 'CHANCE', 0, 100, HX.fmt.pct, T, 100, 'whole track'),
      fieldRow('seedLock', 'RANDOM', 0, 1, v => (v ? 'LOCKED' : 'FREE'), T, 0, 'locked = same dice every loop'),
    ];
  }

  function toolRows(i) {
    const T = () => S.track(i);
    const E = () => T().euclid;
    const regen = () => S.euclid(T());
    return [
      fieldRow('pulses', 'EUCLID', 0, () => T().len, v => v + ' hits', E, 4, 'spread hits evenly', regen),
      fieldRow('rotate', 'ROTATE', 0, () => Math.max(0, T().len - 1), v => '+' + v, E, 0, 'shift the euclid', regen),
      fieldRow('lfoMode', 'LFO MODE', 0, 1, v => (v ? 'TRIG' : 'FREE'), T, 0, 'restart LFO on each trig'),
      fieldRow('midiCh', 'MIDI CH', 0, 16, v => (v ? 'CH ' + v : 'OFF'), T, 0, 'also send notes to MIDI out'),
      fieldRow('midiNote', 'MIDI NOTE', 0, 127, v => HX.util.noteName(v) + ' · ' + v, T, 60, 'note for step NOTE 0'),
    ];
  }

  function fxRow(d) {
    const fx = () => S.project.fx;
    const inScenes = PF.MASTER_IDS.includes(d.id);
    const scene = () => (inScenes ? PF.editScene() : null);
    return {
      key: d.id, label: d.label, min: d.min, max: d.max, fmt: d.fmt,
      hint: !inScenes && PF.edit ? 'not part of scenes' : '',
      get: () => { const sc = scene(); return sc && sc.m[d.id] !== undefined ? sc.m[d.id] : fx()[d.id]; },
      set(v) { const sc = scene(); if (sc) { sc.m[d.id] = v; PF.refresh(); } else { fx()[d.id] = v; HX.audio.applyFx(fx()); } },
      reset() { const sc = scene(); if (sc) { delete sc.m[d.id]; PF.refresh(); } else { fx()[d.id] = d.def; HX.audio.applyFx(fx()); } },
      locked: () => { const sc = scene(); return !!(sc && sc.m[d.id] !== undefined); },
    };
  }

  function clockRow(d) {
    const ck = () => S.project.clock;
    const onSet = v => {
      if (d.id === 'clockOut') HX.seq.setClockOut(v === 1);
      if ((d.id === 'clockOut' || d.id === 'sync') && v === 1 && HX.midi) HX.midi.init();
    };
    return fieldRow(d.id, d.label, d.min, d.max, d.fmt, ck, d.def, d.hint, onSet);
  }

  function midiRows() {
    const ck = () => S.project.clock;
    const M = HX.midi;
    return [
      {
        key: 'midiOut', label: 'MIDI OUT', hint: 'clock + notes go here', min: 0, max: () => M.outs.length,
        fmt: v => (v ? M.outs[v - 1].name : 'NONE'),
        get: () => { const k = M.outs.findIndex(o => o.name === ck().midiOut); return k + 1; },
        set: v => { ck().midiOut = v ? M.outs[v - 1].name : ''; }, reset: () => { ck().midiOut = ''; },
      },
      {
        key: 'midiIn', label: 'MIDI IN', hint: 'notes, clock, start / stop', min: 0, max: () => M.ins.length,
        fmt: v => (v ? M.ins[v - 1].name : 'ALL INPUTS'),
        get: () => { const k = M.ins.findIndex(o => o.name === ck().midiIn); return k + 1; },
        set: v => { ck().midiIn = v ? M.ins[v - 1].name : ''; }, reset: () => { ck().midiIn = ''; },
      },
      clockRow(HX.CLOCK_PARAMS.find(p => p.id === 'sync')),
      clockRow(HX.CLOCK_PARAMS.find(p => p.id === 'clockOut')),
    ];
  }

  /* ===================== panel ===================== */
  P.init = function () {
    el = document.getElementById('pop');
    el.innerHTML =
      '<div class="pop-head"><div class="pop-title"></div><div class="pop-chip" hidden></div>' +
      '<button class="pop-x" type="button" aria-label="Close panel">' +
      '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>' +
      '<div class="pop-tabs" role="tablist"></div><div class="pop-body"></div>' +
      '<div class="pop-foot"></div>';
    titleEl = el.querySelector('.pop-title');
    chipEl = el.querySelector('.pop-chip');
    tabsEl = el.querySelector('.pop-tabs');
    bodyEl = el.querySelector('.pop-body');
    el.querySelector('.pop-x').addEventListener('click', P.close);
    tabsEl.addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b || !P.st) return;
      P.st.tab = lastTab[P.st.mode] = b.dataset.tab;
      P.refresh(true);
    });
    el.querySelector('.pop-foot').addEventListener('click', onFoot);
    bodyEl.addEventListener('click', onBodyClick);
    // text fields: scene names (live), sound / kit names (Enter saves)
    bodyEl.addEventListener('input', e => {
      const inp = e.target.closest('.scn-name');
      if (inp) { S.project.perform.scenes[+inp.dataset.k].name = LIB.cleanName(inp.value, 'SCENE'); S.changed(); }
    });
    bodyEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'libName') { e.preventDefault(); const b = document.getElementById('libSaveBtn'); if (b) libAction(b); }
      if (e.key === 'Enter' && e.target.classList.contains('scn-name')) e.target.blur();
      if (e.key === 'Escape') e.target.blur();
    });

    // click outside closes (elements marked data-keep-pop keep it open)
    document.addEventListener('pointerdown', e => {
      if (!P.st) return;
      if (el.contains(e.target) || e.target.closest('[data-keep-pop]')) return;
      P.close();
    }, true);
  };

  P.isOpen = () => !!P.st;

  P.open = function (st, anchor) {
    const same = P.st && P.st.mode === st.mode && P.st.track === st.track;
    P.st = Object.assign({ tab: (same && !st.tab ? P.st.tab : null) || st.tab || lastTab[st.mode] }, st);
    if (!TABS[P.st.mode].includes(P.st.tab)) P.st.tab = TABS[P.st.mode][0];
    el.hidden = false;
    P.refresh(true);
    P.place(anchor);
  };

  P.close = function () {
    if (!P.st) return;
    const wasLock = P.st.mode === 'lock';
    P.st = null;
    el.hidden = true;
    if (wasLock) { HX.ui.sel = null; }
    S.changed();
  };

  P.place = function (anchor) {
    if (!anchor) return;
    const narrow = window.innerWidth < 720;
    el.classList.toggle('sheet', narrow);
    if (narrow) { el.style.left = el.style.top = ''; return; }
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = U.clamp(r.left + r.width / 2 - w / 2, 12, window.innerWidth - w - 12);
    let top = r.bottom + 10;
    if (top + h > window.innerHeight - 12) top = r.top - h - 10;
    if (top < 12) top = U.clamp(window.innerHeight - h - 12, 12, 9999);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };

  /* Re-render values; rebuild only if the structure changed. */
  P.refresh = function (force) {
    if (!P.st) return;
    const st = P.st;
    if (st.mode === 'lock' && (!HX.ui.sel || !selSteps(S.track(st.track)).length)) { P.close(); return; }
    const T = st.track != null ? S.track(st.track) : null;
    const extra = st.tab === 'MIDI' ? [HX.midi.status, HX.midi.outs.length, HX.midi.ins.length].join(',') : '';
    const lockM = st.mode === 'lock' && selSteps(T)[0] && selSteps(T)[0].slock ? selSteps(T)[0].slock.machine : '';
    const key = [st.mode, st.track, st.tab, T ? T.machine : '', lockM, S.project.current, extra, PF.edit, !!PF.all].join('|');
    if (force || key !== structKey) { structKey = key; build(); }
    else rows.forEach(r => r.update());
    if (st.tab === 'SONG') renderSong();
    if (st.tab === 'CLOCK') renderHealth();
    if (st.tab === 'MIDI') renderMidiStatus();
    if (st.mode === 'export') renderExport();
    if (st.mode === 'perform') renderScenes();
    if (st.tab === 'SOUND') renderLib();
    // header
    const chip = (text, kind) => { chipEl.hidden = !text; chipEl.textContent = text || ''; chipEl.dataset.kind = kind || ''; };
    const sceneChip = () => (PF.edit ? chip('EDIT SCENE ' + PF.edit.toUpperCase() + ' · ' + PF.sceneLabel(S.project.perform[PF.edit]), 'scene') : false);
    if (st.mode === 'master') { titleEl.textContent = 'MASTER'; if (sceneChip() === false) chip(''); }
    else if (st.mode === 'perform') { titleEl.textContent = 'SCENES'; chip(''); }
    else if (st.mode === 'clock') { titleEl.textContent = 'TIME'; chipEl.hidden = true; }
    else if (st.mode === 'export') { titleEl.textContent = 'RECORD · EXPORT'; chipEl.hidden = true; }
    else {
      const m = HX.machines.byId[T.machine];
      titleEl.innerHTML = '<span class="pt-num">' + (st.track + 1) + '</span>' + m.name;
      if (st.mode === 'lock') {
        const ks = [...HX.ui.sel.steps].sort((a, b) => a - b), s = selSteps(T)[0];
        chip((ks.length === 1 ? 'LOCK · STEP ' + String(ks[0] + 1).padStart(2, '0') : 'LOCK · ' + ks.length + ' STEPS') +
          (s && s.trigless ? ' · LOCK ONLY' : '') + (s && s.slock ? ' · ' + s.slock.name : ''), 'lock');
      } else if (sceneChip() === false) {
        if (PF.all) chip('CONTROL ALL · KEEP OR REVERT', 'all');
        else if (HX.seq.rec && HX.seq.playing) chip(P.recNote || 'REC · SLIDERS WRITE LOCKS', 'rec');
        else chip('');
      }
    }
  };

  function addRows(list) { list.forEach(r => { const s = P.slider(r); rows.push(s); bodyEl.appendChild(s.el); }); }
  function addHTML(html) { const d = document.createElement('div'); d.innerHTML = html; while (d.firstChild) bodyEl.appendChild(d.firstChild); }

  function build() {
    const st = P.st;
    tabsEl.innerHTML = TABS[st.mode].map(t =>
      '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + (t === st.tab) + '">' + t + '</button>').join('');
    bodyEl.innerHTML = '';
    rows = [];
    const foot = el.querySelector('.pop-foot');
    foot.innerHTML = '';

    if (st.mode === 'perform') {
      addHTML('<div class="scn" id="scn"></div>');
      foot.innerHTML = '<span class="foot-hint">Pick a scene, then fill it from a template or press EDIT on the strip and move any slider. Values a scene does not hold stay as they are.</span>';
      return;
    }
    if (st.mode === 'master') {
      addRows(HX.FX_PARAMS.filter(d => d.tab === st.tab).map(fxRow));
      foot.innerHTML = '<span class="foot-hint">Delay and reverb are send effects. Set how much each track sends on its AMP tab.</span>';
      return;
    }
    if (st.mode === 'export') {
      const ex = () => S.project.exportCfg;
      const row = d => fieldRow(d.id, d.label, d.min, d.max, d.fmt, ex, d.def, d.hint);
      if (st.tab === 'TAKES') {
        addHTML('<div class="takes" id="takes"></div>');
        foot.innerHTML = '<span class="foot-hint">Takes are kept until you reload the page. Each one saves as a .zip with the WAV and a MIDI file of what you played.</span>';
      } else {
        addRows(HX.EXPORT_PARAMS.filter(d => d.tab === st.tab || d.tab === 'BOTH').map(row));
        addHTML('<div class="xbox" id="xbox"></div>');
        foot.innerHTML = st.tab === 'CAPTURE'
          ? '<span class="foot-hint">Records exactly on the bar lines, with every sweep, mute, fill and knob move. A loop that was already playing comes out seamless, tails included.</span>'
          : '<span class="foot-hint">Renders offline, sample-exact and faster than real time. One .zip with WAVs, MIDI and a read-me: set your DAW to the same tempo and drop the files at bar 1.</span>';
      }
      return;
    }
    if (st.mode === 'clock') {
      if (st.tab === 'CLOCK') {
        addRows([
          fieldRow('len', 'PAT LENGTH', 1, 64, v => v + ' steps', () => S.pat(), 16, 'master length · odd meters welcome'),
          ...HX.CLOCK_PARAMS.filter(d => d.id !== 'sync' && d.id !== 'clockOut').map(clockRow),
        ]);
        addHTML('<div class="tacts"><button type="button" data-act="reseed">New seed</button><button type="button" data-act="reseed-all">New seeds, all</button></div><div class="health" id="health"></div>');
        foot.innerHTML = '<span class="foot-hint">The seed decides every chance, random direction and humanize. Same seed, same performance.</span>';
      } else if (st.tab === 'SONG') {
        addHTML('<div class="song" id="song"></div>');
        foot.innerHTML = '<span class="foot-hint">With song mode on, play starts from the first row and steps through the list.</span>';
      } else {
        addHTML('<div class="midi-status" id="midiStatus"></div>');
        if (HX.midi.status === 'ready') addRows(midiRows());
        foot.innerHTML = '<span class="foot-hint">Notes in: C1–F1 play pads 1–6, a track\'s MIDI CH plays that track, other notes play the selected track.</span>';
      }
      return;
    }

    if (st.tab === 'SOUND') { addHTML(libHTML(st.mode)); renderLib(); }
    else if (st.tab === 'TRIG') addRows(HX.TRIG_PARAMS.map(d => trigRow(d, st.track)));
    else if (st.tab === 'TRK') { bodyEl.appendChild(machinePicker(st.track)); addRows(trackRows(st.track)); }
    else if (st.tab === 'TOOL') { addRows(toolRows(st.track)); bodyEl.appendChild(trackActions()); }
    else addRows(HX.PARAMS.filter(d => d.page === st.tab.toLowerCase()).map(d => soundRow(d, st.track, st.mode)));

    if (st.mode === 'lock') foot.innerHTML = '<button type="button" class="txt" data-foot="clearlocks">Clear locks</button><button type="button" class="txt" data-foot="deltrig">Delete trig</button><span class="foot-hint">Double-click a slider to reset it</span>';
    else if (st.tab === 'SOUND') foot.innerHTML = '<span class="foot-hint">Click a sound to load it (undo brings the old one back). To play a different sound on one step, right-click the step and use its SOUND tab.</span>';
    else foot.innerHTML = '<span class="foot-hint">Right-click or hold a step to lock values to it. Double-click resets. In REC, moving a slider records it into the steps.</span>';
  }

  function machinePicker(i) {
    const box = document.createElement('div');
    box.className = 'mpick';
    const cur = S.track(i).machine;
    box.innerHTML = '<div class="mpick-label">MACHINE</div><div class="mpick-row">' +
      HX.machines.list.map(m => '<button type="button" data-machine="' + m.id + '" aria-pressed="' + (m.id === cur) + '">' + m.name + '</button>').join('') + '</div>';
    return box;
  }

  function trackActions() {
    const box = document.createElement('div');
    box.className = 'tacts';
    box.innerHTML = [
      ['dice', 'Dice'], ['rotl', '◀ Shift'], ['rotr', 'Shift ▶'], ['copy', 'Copy'], ['paste', 'Paste'], ['clear', 'Clear'],
    ].map(([a, l]) => '<button type="button" data-act="' + a + '"' + (a === 'paste' && !P.clip ? ' disabled' : '') + '>' + l + '</button>').join('');
    return box;
  }

  /* ---------- SOUND tab: library + sound locks ---------- */
  const CATS = ['kick', 'snare', 'metal', 'perc', 'tone', 'chord', 'yours', 'kits'];
  const CAT_LABEL = { yours: 'YOURS', kits: 'KITS' };
  P.libCat = {};                                  // remembered category per track and mode
  const catKey = () => P.st.mode + P.st.track;
  function libCat() {
    const st = P.st, T = S.track(st.track);
    if (!P.libCat[catKey()]) {
      const s = st.mode === 'lock' && selSteps(T)[0];
      P.libCat[catKey()] = s && s.slock ? s.slock.machine : T.machine;
    }
    if (st.mode === 'lock' && P.libCat[catKey()] === 'kits') P.libCat[catKey()] = T.machine;
    return P.libCat[catKey()];
  }
  function libHTML(mode) {
    const cats = mode === 'lock' ? CATS.filter(c => c !== 'kits') : CATS;
    return '<div class="lib">' +
      '<div class="lib-cats" role="tablist">' + cats.map(c => '<button type="button" data-cat="' + c + '">' + (CAT_LABEL[c] || HX.machines.byId[c].name) + '</button>').join('') + '</div>' +
      '<div class="lib-list" id="libList"></div>' +
      (mode === 'lock'
        ? '<div class="lib-acts"><button type="button" class="txt" data-lib="unlock">Clear sound lock</button></div>'
        : '<div class="lib-acts"><button type="button" class="txt" data-lib="random">Random</button><button type="button" class="txt" data-lib="mutate">Mutate</button></div>' +
          '<div class="lib-save"><input type="text" id="libName" maxlength="16" spellcheck="false" autocomplete="off" aria-label="Name"><button type="button" class="txt" data-lib="save" id="libSaveBtn">Save sound</button></div>') +
      '</div>';
  }
  function renderLib() {
    const box = document.getElementById('libList');
    if (!box) return;
    const st = P.st, T = S.track(st.track), cat = libCat();
    const s = st.mode === 'lock' ? selSteps(T)[0] : null;
    bodyEl.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === cat));
    const isCur = x => (st.mode === 'lock' ? !!(s && s.slock && s.slock.name === x.name && s.slock.machine === x.machine)
      : T.sname === x.name && T.machine === x.machine);
    let items;
    if (cat === 'kits') items = LIB.factoryKits().map((k, n) => ({ k, src: 'fk', n })).concat(S.project.library.kits.map((k, n) => ({ k, src: 'uk', n })));
    else if (cat === 'yours') items = S.project.library.sounds.map((x, n) => ({ x, src: 'us', n }));
    else items = LIB.factory(cat).map((x, n) => ({ x, src: 'fs', n })).concat(
      S.project.library.sounds.map((x, n) => ({ x, src: 'us', n })).filter(o => o.x.machine === cat));
    const html = items.map(o => {
      const name = o.k ? o.k.name : o.x.name;
      const sub = o.k ? (o.src === 'fk' ? 'DEMO KIT' : 'YOUR KIT') : HX.machines.byId[o.x.machine].name + (o.src === 'us' ? ' · YOURS' : '');
      const cur = o.x && isCur(o.x);
      return '<div class="lib-row' + (cur ? ' cur' : '') + '">' +
        '<button type="button" class="lib-item" data-lib="pick" data-src="' + o.src + '" data-n="' + o.n + '"><b>' + esc(name) + '</b><small>' + sub + '</small></button>' +
        (o.src === 'us' || o.src === 'uk' ? '<button type="button" class="lib-del" data-lib="del" data-src="' + o.src + '" data-n="' + o.n + '" aria-label="Delete ' + esc(name) + '">×</button>' : '') +
        '</div>';
    }).join('');
    const empty = cat === 'yours' ? '<p class="song-empty">Nothing saved yet. Shape a sound, name it below and press SAVE SOUND.</p>' : '';
    if (box.dataset.html !== html) { box.innerHTML = html || empty; box.dataset.html = html; }
    const input = document.getElementById('libName'), btn = document.getElementById('libSaveBtn');
    if (input && btn) {
      const kits = cat === 'kits';
      btn.textContent = kits ? 'Save kit' : 'Save sound';
      btn.dataset.lib = kits ? 'savekit' : 'save';
      if (document.activeElement !== input && input.dataset.for !== cat + T.sname) {
        input.value = kits ? S.pat().name + ' KIT' : (T.sname && T.sname !== 'RANDOM' ? T.sname : HX.machines.byId[T.machine].name + ' ' + (S.project.library.sounds.filter(x => x.machine === T.machine).length + 1));
        input.dataset.for = cat + T.sname;
      }
    }
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function libAction(b) {
    const st = P.st, T = S.track(st.track), a = b.dataset.lib;
    const src = b.dataset.src, n = +b.dataset.n, cat = libCat();
    const sound = () => (src === 'fs' ? LIB.factory(cat)[n] : S.project.library.sounds[n]);
    const kit = () => (src === 'fk' ? LIB.factoryKits()[n] : S.project.library.kits[n]);
    const audition = () => { if (!HX.seq.playing) HX.seq.pad(st.track, 0.9); };
    if (a === 'pick') {
      S.commit(true);
      if (src === 'fk' || src === 'uk') { LIB.loadKit(S.pat(), kit()); HX.oled.show('KIT LOADED', kit().name, null); }
      else if (st.mode === 'lock') {
        const steps = selSteps(T);
        LIB.lockSteps(steps, sound());
        HX.oled.show('SOUND LOCK', sound().name, null);
        if (!HX.seq.playing) HX.seq.preview(st.track, [...HX.ui.sel.steps][0]);
      } else { LIB.load(T, sound()); HX.oled.show('SOUND ' + (st.track + 1), sound().name, null); audition(); }
    } else if (a === 'del') {
      if (src === 'us') LIB.removeSound(n); else LIB.removeKit(n);
    } else if (a === 'unlock') { S.commit(true); LIB.unlockSteps(selSteps(T)); }
    else if (a === 'random' || a === 'mutate') {
      S.commit(true);
      if (a === 'random') LIB.random(T); else LIB.mutate(T);
      HX.oled.show(a === 'random' ? 'RANDOM SOUND' : 'MUTATED', HX.machines.byId[T.machine].name, null);
      audition();
    } else if (a === 'save' || a === 'savekit') {
      const input = document.getElementById('libName');
      if (a === 'save') { const x = LIB.saveSound(T, input.value); P.libCat[catKey()] = 'yours'; HX.oled.show('SAVED', x.name, null); }
      else { const k = LIB.saveKit(S.pat(), input.value); HX.oled.show('KIT SAVED', k.name, null); }
      input.dataset.for = '';
      input.blur();
    }
    S.changed();
  }

  /* ---------- SCENES panel ---------- */
  function renderScenes() {
    const box = document.getElementById('scn');
    if (!box) return;
    const pf = S.project.perform;
    if (!box.children.length) {
      box.innerHTML = '<div class="scn-list">' + pf.scenes.map((sc, k) =>
        '<div class="scn-row" data-k="' + k + '">' +
          '<button type="button" class="scn-n" data-scn="sel" aria-label="Select scene ' + (k + 1) + '">' + (k + 1) + '</button>' +
          '<input type="text" class="scn-name" data-k="' + k + '" maxlength="12" spellcheck="false" autocomplete="off" aria-label="Scene ' + (k + 1) + ' name">' +
          '<span class="scn-cnt"></span>' +
          '<button type="button" class="scn-ab" data-scn="a">A</button><button type="button" class="scn-ab" data-scn="b">B</button>' +
        '</div>').join('') + '</div>' +
        '<div class="mpick-label">FILL THE SELECTED SCENE</div>' +
        '<div class="tacts tpl">' + PF.TEMPLATES.map((t, n) => '<button type="button" data-tpl="' + n + '">' + t.name + '</button>').join('') + '</div>' +
        '<div class="tacts"><button type="button" data-scn="copyA">Copy A here</button><button type="button" data-scn="copyB">Copy B here</button><button type="button" data-scn="clear">Clear</button></div>';
    }
    box.querySelectorAll('.scn-row').forEach(row => {
      const k = +row.dataset.k, sc = pf.scenes[k];
      row.classList.toggle('sel', PF.sel === k);
      row.querySelector('[data-scn="a"]').setAttribute('aria-pressed', pf.a === k);
      row.querySelector('[data-scn="b"]').setAttribute('aria-pressed', pf.b === k);
      const c = PF.count(sc);
      row.querySelector('.scn-cnt').textContent = c ? c + (c === 1 ? ' value' : ' values') : 'empty';
      const inp = row.querySelector('.scn-name');
      if (document.activeElement !== inp) inp.value = sc.name;
    });
  }
  function sceneAction(b) {
    const row = b.closest('.scn-row');
    const a = b.dataset.scn;
    if (row) {
      const k = +row.dataset.k;
      PF.sel = k;
      if (a === 'a' || a === 'b') PF.setAssign(a, k);
      else S.changed();
      return;
    }
    const pf = S.project.perform;
    if (a === 'clear') PF.clear(PF.sel);
    if (a === 'copyA' && pf.a !== PF.sel) PF.copy(pf.a, PF.sel);
    if (a === 'copyB' && pf.b !== PF.sel) PF.copy(pf.b, PF.sel);
  }

  /* ---------- TIME panel pieces ---------- */
  function renderHealth() {
    const h = document.getElementById('health');
    if (!h) return;
    const s = HX.seq.stats;
    const ac = HX.audio.ctx();
    const lat = ac ? Math.round(((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000) : 0;
    h.innerHTML =
      '<span><b>' + s.late + '</b> late notes</span><span><b>' + s.stalls + '</b> stalls recovered</span>' +
      '<span>look-ahead <b>' + Math.round(HX.CONST.LOOKAHEAD * 1000) + '</b> ms</span>' +
      (ac ? '<span>output latency <b>' + lat + '</b> ms</span>' : '');
  }

  function renderSong() {
    const box = document.getElementById('song');
    if (!box) return;
    const song = S.project.song;
    const info = HX.seq.playing && song.on ? HX.seq.info() : null;
    const name = p => 'A' + (p + 1) + ' ' + S.project.patterns[p].name;
    box.innerHTML =
      '<div class="song-top">' +
        '<button type="button" class="txt" data-song="toggle" aria-pressed="' + !!song.on + '">Song mode ' + (song.on ? 'on' : 'off') + '</button>' +
        '<button type="button" class="txt" data-song="loop" aria-pressed="' + !!song.loop + '">Loop ' + (song.loop ? 'on' : 'off') + '</button>' +
      '</div>' +
      '<ol class="song-list">' + song.entries.map((e, k) =>
        '<li class="song-row' + (info && info.songIdx === k ? ' playing' : '') + '" data-k="' + k + '">' +
          '<span class="sr-n">' + String(k + 1).padStart(2, '0') + '</span>' +
          '<span class="stepper"><button type="button" data-song="pat-" aria-label="Previous pattern">‹</button><output>' + name(e.p) + '</output><button type="button" data-song="pat+" aria-label="Next pattern">›</button></span>' +
          '<span class="stepper sm"><button type="button" data-song="rep-" aria-label="Fewer repeats">−</button><output>×' + e.r + '</output><button type="button" data-song="rep+" aria-label="More repeats">+</button></span>' +
          '<button type="button" class="sr-del" data-song="del" aria-label="Remove row">×</button>' +
        '</li>').join('') + '</ol>' +
      (song.entries.length ? '' : '<p class="song-empty">No rows yet. Add the pattern you are on, then step through the list with the arrows.</p>') +
      '<div class="tacts"><button type="button" data-song="add">+ Add A' + (S.project.current + 1) + '</button><button type="button" data-song="clear"' + (song.entries.length ? '' : ' disabled') + '>Clear list</button></div>';
  }

  function renderExport() {
    const st = P.st, X = HX.exporter, R = HX.rec;
    const noSave = X.canSave === false ? '<p class="xwarn">Saving files is not available in this view. Open the page in Claude on the web or the desktop app, or host it on its own page.</p>' : '';
    if (st.tab === 'CAPTURE') {
      const box = document.getElementById('xbox'); if (!box) return;
      const bars = HX.CAPTURE_BARS[S.project.exportCfg.capBars];
      const label = R.state === 'armed' ? 'Cancel'
        : R.state === 'rec' ? (R.endPos == null ? 'Stop at the next bar' : 'Cancel')
        : 'Capture ' + (bars ? bars + (bars > 1 ? ' bars' : ' bar') : 'until stopped');
      let status = R.msg || '';
      if (R.state === 'rec') {
        const pos = HX.seq.posNow(), done = Math.max(0, Math.floor((pos - R.startPos) / 16));
        status = 'Recording bar ' + (done + 1) + (R.endPos != null ? ' of ' + (R.endPos - R.startPos) / 16 : '') + '.';
      }
      box.innerHTML = '<button type="button" class="xgo' + (R.state !== 'idle' ? ' live' : '') + '" data-act="capture"><span class="cap-led"></span>' + label + '</button>' +
        '<p class="xstatus" role="status">' + status + '</p>' + noSave;
    } else if (st.tab === 'BOUNCE') {
      const box = document.getElementById('xbox'); if (!box) return;
      const c = S.project.exportCfg;
      const song = c.source === 1 && S.project.song.entries.length;
      const len = song ? HX.exporter.songLength(S.project) / 16 : c.bars;
      const secs = len * 16 * 15 / S.project.bpm;
      const what = [c.mix && 'mix', c.stems && 'stems', c.midi && 'MIDI'].filter(Boolean).join(' + ') || 'nothing';
      box.innerHTML = '<button type="button" class="xgo" data-act="bounce"' + (X.busy ? ' disabled' : '') + '>' + (X.busy ? 'Bouncing…' : 'Bounce ' + what + ' · save .zip') + '</button>' +
        '<p class="xstatus" role="status">' + (X.status || (Math.round(len * 100) / 100) + ' bars · ' + secs.toFixed(1) + ' s at ' + S.project.bpm + ' BPM' + (c.source === 1 && !S.project.song.entries.length ? ' · the song list is empty, so this pattern is used' : '')) + '</p>' + noSave;
    } else {
      const box = document.getElementById('takes'); if (!box) return;
      const pid = R.playingId();
      box.innerHTML = R.takes.length ? R.takes.map(t =>
        '<div class="take">' +
          '<canvas class="take-wave" data-id="' + t.id + '" width="240" height="40" aria-hidden="true"></canvas>' +
          '<div class="take-meta"><b>Take ' + t.id + '</b><span>' + t.pat + ' · ' + t.bars + (t.bars > 1 ? ' bars' : ' bar') + ' · ' + Math.round(t.bpm) + ' BPM · ' + t.notes.length + ' notes</span></div>' +
          '<div class="take-acts">' +
            '<button type="button" class="txt" data-take="play" data-id="' + t.id + '">' + (pid === t.id ? 'Stop' : 'Play') + '</button>' +
            '<button type="button" class="txt" data-take="save" data-id="' + t.id + '">Save .zip</button>' +
            '<button type="button" class="txt" data-take="del" data-id="' + t.id + '" aria-label="Delete take ' + t.id + '">×</button>' +
          '</div></div>').join('') + noSave
        : '<p class="song-empty">No takes yet. Press CAPTURE (or Enter) while a pattern plays: it records the next bars exactly on the bar lines.</p>' + (R.msg ? '<p class="xstatus">' + R.msg + '</p>' : '');
      box.querySelectorAll('canvas.take-wave').forEach(cv => drawWave(cv, R.takes.find(x => x.id === +cv.dataset.id)));
    }
  }

  function drawWave(cv, t) {
    if (!t || cv.dataset.drawn) return;
    cv.dataset.drawn = 1;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const cs = getComputedStyle(document.documentElement);
    g.fillStyle = cs.getPropertyValue('--ink-2').trim() || '#555';
    const n = t.L.length, step = Math.max(1, Math.floor(n / W));
    for (let x = 0; x < W; x++) {
      let pk = 0;
      for (let i = x * step, e = Math.min(n, i + step); i < e; i += 4) pk = Math.max(pk, Math.abs(t.L[i]), Math.abs(t.R[i]));
      const h = Math.max(1, pk * (H - 2));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
    g.fillStyle = cs.getPropertyValue('--led').trim() || '#f40';
    for (let b = 0; b <= t.bars; b++) g.fillRect(Math.min(W - 1, Math.round((b / t.bars) * W)), 0, 1, 4);
  }

  function renderMidiStatus() {
    const box = document.getElementById('midiStatus');
    if (!box) return;
    const M = HX.midi;
    const msg = {
      off: 'MIDI is not connected yet.',
      asking: 'Waiting for the browser to allow MIDI…',
      ready: M.outs.length + ' output' + (M.outs.length === 1 ? '' : 's') + ' · ' + M.ins.length + ' input' + (M.ins.length === 1 ? '' : 's') + (M.lastIn ? ' · last in: ' + M.lastIn : ''),
      unsupported: 'This browser has no Web MIDI. Chrome, Edge and Opera on a computer support it.',
      blocked: 'MIDI was blocked here. Hosting HEXTRIG on its own page (for example your own site) lets the browser ask for access.',
    }[M.status];
    box.innerHTML = '<p>' + msg + '</p>' + (M.status === 'off' || M.status === 'blocked' ? '<button type="button" class="txt" data-act="midi">Connect MIDI</button>' : '') +
      (HX.seq.waitExt ? '<p class="wait">Waiting for MIDI start…</p>' : '');
  }

  function onBodyClick(e) {
    const st = P.st; if (!st) return;
    const cb = e.target.closest('[data-cat]');
    if (cb) { P.libCat[catKey()] = cb.dataset.cat; renderLib(); return; }
    const lb = e.target.closest('[data-lib]');
    if (lb) { libAction(lb); return; }
    const tp = e.target.closest('[data-tpl]');
    if (tp) { PF.fill(PF.sel, +tp.dataset.tpl); return; }
    const scb = e.target.closest('[data-scn]');
    if (scb) { sceneAction(scb); return; }
    const sb = e.target.closest('[data-song]');
    if (sb) { songAction(sb.dataset.song, sb.closest('.song-row')); return; }
    const tb = e.target.closest('[data-take]');
    if (tb) { const id = +tb.dataset.id; ({ play: HX.rec.play, save: HX.rec.save, del: HX.rec.remove })[tb.dataset.take](id); return; }
    const ab = e.target.closest('button[data-act]');
    if (ab && ab.dataset.act === 'midi') { HX.midi.init(); return; }
    if (ab && ab.dataset.act === 'capture') { HX.rec.toggle(); return; }
    if (ab && ab.dataset.act === 'bounce') { HX.exporter.bounce(); return; }
    if (ab && ab.dataset.act === 'reseed') { S.commit(true); S.pat().seed = S.newSeed(); S.changed(); HX.oled.show('NEW SEED', 'A' + (S.project.current + 1), null); return; }
    if (ab && ab.dataset.act === 'reseed-all') { S.commit(true); S.project.patterns.forEach(p => { p.seed = S.newSeed(); }); S.changed(); return; }
    if (st.track == null) return;
    const T = S.track(st.track);
    const mb = e.target.closest('button[data-machine]');
    if (mb) {
      S.commit(true);
      const m = HX.machines.byId[mb.dataset.machine];
      T.machine = m.id;
      HX.PARAMS.filter(d => d.page === 'syn').forEach(d => { T.params[d.id] = m.defaults[d.id] !== undefined ? m.defaults[d.id] : d.def; });
      S.changed();
      HX.seq.pad(st.track);
      return;
    }
    if (!ab) return;
    const a = ab.dataset.act;
    if (a === 'copy') { P.clip = JSON.parse(JSON.stringify(T)); if (HX.oled) HX.oled.show('COPIED', 'TRACK ' + (st.track + 1), 1); P.refresh(true); return; }
    S.commit(true);
    if (a === 'dice') S.dice(T);
    if (a === 'rotl') S.rotate(T, -1);
    if (a === 'rotr') S.rotate(T, 1);
    if (a === 'clear') S.clearTrack(T);
    if (a === 'paste' && P.clip) S.pat().tracks[st.track] = JSON.parse(JSON.stringify(P.clip));
    S.changed();
  }

  function songAction(a, row) {
    const song = S.project.song;
    const k = row ? +row.dataset.k : -1;
    const e = song.entries[k];
    S.commit(true);
    switch (a) {
      case 'toggle': song.on = song.on ? 0 : 1; break;
      case 'loop': song.loop = song.loop ? 0 : 1; break;
      case 'add': song.entries.push({ p: S.project.current, r: 2 }); break;
      case 'clear': song.entries = []; break;
      case 'del': song.entries.splice(k, 1); break;
      case 'pat-': e.p = (e.p + 7) % 8; break;
      case 'pat+': e.p = (e.p + 1) % 8; break;
      case 'rep-': e.r = Math.max(1, e.r - 1); break;
      case 'rep+': e.r = Math.min(64, e.r + 1); break;
    }
    S.changed();
  }

  function onFoot(e) {
    const b = e.target.closest('button[data-foot]');
    if (!b || !P.st) return;
    const T = S.track(P.st.track);
    S.commit(true);
    if (b.dataset.foot === 'clearlocks') selSteps(T).forEach(s => { s.locks = {}; });
    if (b.dataset.foot === 'deltrig') { HX.ui.sel.steps.forEach(k => { T.steps[k] = null; }); P.close(); }
    S.changed();
  }
})(window.HX);
