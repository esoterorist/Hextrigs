/* =====================================================================
   HEXTRIG · ui.js
   DOM for the unit: transport, pattern slots, engine tiles, step lanes.
   Rendering is cheap and idempotent: ui.render() reads state and sets
   classes. Playheads and flashes are driven from main.js (audio clock).
   ===================================================================== */
(function (HX) {
  'use strict';
  const C = HX.CONST, U = HX.util, S = HX.state;
  const $ = s => document.querySelector(s);
  const ui = (HX.ui = {
    page: 0, follow: true,
    selTrack: 0,
    sel: null,            // { track, steps: Set<int> } — steps being p-locked
    cursor: 0,            // step-record cursor (sequencer stopped + REC)
    layer: 'trig',        // what the step keys edit: trig | vel | prob | micro | note
    play: [-1, -1, -1, -1, -1, -1],
  });
  const stepEls = [];     // stepEls[track][0..15]
  const laneEls = [], tileEls = [];

  const GLYPH = {
    kick: '<circle cx="8" cy="8" r="5.2" fill="currentColor"/>',
    snare: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.6 11.4 11.4 4.6" stroke="currentColor" stroke-width="1.6"/>',
    metal: '<path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    perc: '<path d="M8 2.6 13.4 8 8 13.4 2.6 8Z" fill="currentColor"/>',
    tone: '<path d="M1.6 8c1.6-5 3.6-5 5.2 0s3.6 5 5.2 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    chord: '<path d="M3 4.4h10M3 8h10M3 11.6h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  };
  ui.glyph = id => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' + (GLYPH[id] || GLYPH.perc) + '</svg>';

  /* ===================== build ===================== */
  ui.build = function () {
    buildTiles();
    buildLanes();
    buildSlots();
    buildPages();
    bindTransport();
    bindSeqBar();
    bindPatternActions();
    const PF = HX.perform;
    const sweepRow = {
      key: 'sweep', label: 'SWEEP', hint: 'low-pass ◀ · ▶ high-pass', min: -64, max: 63, bipolar: true,
      fmt: v => (v === 0 ? 'OPEN' : v < 0 ? 'LP ' + -v : 'HP ' + v),
      get: () => { const sc = PF.editScene(); return sc && sc.m.sweep !== undefined ? sc.m.sweep : HX.audio._sweep || 0; },
      set: v => { const sc = PF.editScene(); if (sc) { sc.m.sweep = v; PF.refresh(); } else HX.audio.setSweep(v); },
      reset: () => { const sc = PF.editScene(); if (sc) { delete sc.m.sweep; PF.refresh(); } else HX.audio.setSweep(0); },
      locked: () => { const sc = PF.editScene(); return !!(sc && sc.m.sweep !== undefined); },
    };
    ui.sweep = HX.panel.slider(sweepRow, { compact: true });
    $('#sweepHost').appendChild(ui.sweep.el);
    bindPerform();
    ui.render();
  };

  function buildTiles() {
    const wrap = $('#tracks');
    for (let i = 0; i < C.TRACKS; i++) {
      const el = document.createElement('div');
      el.className = 'tile';
      el.dataset.i = i;
      el.innerHTML =
        '<div class="tile-top">' +
          '<button type="button" class="pad" data-act="pad" aria-label="Play track ' + (i + 1) + ' (key ' + (i + 1) + ')"><span class="pad-led"></span></button>' +
          '<div class="tile-ms">' +
            '<button type="button" class="mini" data-act="mute" aria-pressed="false" title="Mute (Shift+' + (i + 1) + ')">M</button>' +
            '<button type="button" class="mini" data-act="solo" aria-pressed="false" title="Solo">S</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="tile-body" data-act="open" aria-label="Edit track ' + (i + 1) + ' sound">' +
          '<span class="tile-name"><span class="tile-num">' + (i + 1) + '</span><span class="tile-glyph"></span><span class="tile-mach"></span></span>' +
          '<span class="tile-snd"></span>' +
          '<span class="bars">' + '<span class="bar"><i></i></span>'.repeat(6) + '</span>' +
          '<span class="bar-keys"><span>P</span><span>D</span><span>C</span><span>S</span><span>W</span><span>T</span></span>' +
        '</button>';
      wrap.appendChild(el);
      tileEls.push(el);
    }
    wrap.addEventListener('pointerdown', e => {
      const pad = e.target.closest('[data-act="pad"]');
      if (!pad) return;
      e.preventDefault();
      const i = +pad.closest('.tile').dataset.i;
      ui.selTrack = i;
      HX.seq.pad(i, 0.9);
    });
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = +b.closest('.tile').dataset.i;
      if (b.dataset.act === 'mute') HX.seq.toggleMute(i);
      if (b.dataset.act === 'solo') HX.seq.toggleSolo(i);
      if (b.dataset.act === 'open') ui.openTrack(i, null, b);
    });
  }

  function buildLanes() {
    const wrap = $('#lanes');
    for (let i = 0; i < C.TRACKS; i++) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.dataset.i = i;
      let groups = '';
      for (let g = 0; g < 4; g++) {
        groups += '<div class="grp">';
        for (let k = 0; k < 4; k++) groups += '<button type="button" class="step" data-k="' + (g * 4 + k) + '" tabindex="-1"><span class="lv"></span><span class="gl"></span><span class="led"></span><span class="sk"></span><span class="tick"></span></button>';
        groups += '</div>';
      }
      lane.innerHTML =
        '<button type="button" class="lane-label" data-act="open"><span class="ll-led"></span><span class="ll-num">' + (i + 1) + '</span><span class="ll-name"></span></button>' +
        '<div class="steps">' + groups + '</div>' +
        '<button type="button" class="lane-info" data-act="trk" title="Length · speed"></button>';
      wrap.appendChild(lane);
      laneEls.push(lane);
      stepEls.push([...lane.querySelectorAll('.step')]);
    }
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.lane-label, .lane-info');
      if (!b) return;
      const i = +b.closest('.lane').dataset.i;
      ui.openTrack(i, b.classList.contains('lane-info') ? 'TRK' : null, b);
    });
    wrap.addEventListener('contextmenu', e => { if (e.target.closest('.step')) e.preventDefault(); });
    wrap.addEventListener('pointerdown', onStepDown);
    wrap.addEventListener('wheel', onStepWheel, { passive: false });
  }

  function buildSlots() {
    const wrap = $('#slots');
    for (let n = 0; n < C.PATTERNS; n++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'slot'; b.dataset.n = n;
      b.innerHTML = '<span class="slot-id">A' + (n + 1) + '</span><span class="slot-dot"></span>';
      wrap.appendChild(b);
    }
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.slot');
      if (b) { HX.seq.queue(+b.dataset.n); if (HX.panel.st && HX.panel.st.mode === 'lock') HX.panel.close(); }
    });
  }

  function buildPages() {
    const wrap = $('#pages');
    for (let p = 0; p < 4; p++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'page'; b.dataset.p = p;
      b.innerHTML = '<span class="page-led"></span>' + (p + 1);
      wrap.appendChild(b);
    }
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.page');
      if (!b || b.disabled) return;
      ui.page = +b.dataset.p;
      ui.follow = false;
      ui.render();
    });
  }

  /* ===================== steps: click, paint, lock, wheel ===================== */
  let drag = null;
  function stepAt(e) {
    const el = e.target.closest ? e.target.closest('.step') : null;
    if (!el) return null;
    return { el, i: +el.closest('.lane').dataset.i, k: ui.page * C.PAGE + +el.dataset.k };
  }

  function onStepDown(e) {
    const hit = stepAt(e);
    if (!hit) return;
    e.preventDefault();
    const { i, k, el } = hit;
    const T = S.track(i);
    ui.selTrack = i;
    if (e.button === 2 || e.altKey || (e.shiftKey && ui.sel && ui.sel.track === i)) {
      selectStep(i, k, e.shiftKey, el);
      return;
    }
    if (e.button !== 0) return;
    if (TOGGLES[ui.layer]) { startToggleDraw(i, k); return; }
    if (ui.layer !== 'trig') { startLayerDraw(e, i, k, el); return; }
    S.commit(true);
    const wasOn = !!T.steps[k];
    drag = { i, k0: k, paint: !wasOn, moved: false, long: false, seen: new Set([k]) };
    if (drag.paint) { T.steps[k] = S.mkStep(); HX.seq.preview(i, k); S.changed(); }
    drag.timer = setTimeout(() => {
      if (drag && !drag.moved) { drag.long = true; selectStep(i, k, false, el); }
    }, 380);
    document.addEventListener('pointermove', onStepMove);
    document.addEventListener('pointerup', onStepUp, { once: true });
    document.addEventListener('pointercancel', onStepUp, { once: true });
  }

  function onStepMove(e) {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const st = el && el.closest('.step');
    if (!st) return;
    const i = +st.closest('.lane').dataset.i;
    const k = ui.page * C.PAGE + +st.dataset.k;
    if (i !== drag.i || drag.seen.has(k)) return;
    clearTimeout(drag.timer);
    const T = S.track(i);
    if (!drag.moved && !drag.paint) T.steps[drag.k0] = null;   // erase gesture includes the first step
    drag.moved = true;
    drag.seen.add(k);
    T.steps[k] = drag.paint ? (T.steps[k] || S.mkStep()) : null;
    S.changed();
  }

  function onStepUp() {
    document.removeEventListener('pointermove', onStepMove);
    if (!drag) return;
    clearTimeout(drag.timer);
    if (!drag.paint && !drag.moved && !drag.long) {
      const T = S.track(drag.i);
      T.steps[drag.k0] = null;
      if (ui.sel && ui.sel.track === drag.i) ui.sel.steps.delete(drag.k0);
      S.changed();
    }
    drag = null;
  }

  /* ---------- edit layers: draw velocity / chance / micro / note by dragging ---------- */
  const LAYERS = {
    vel:   { field: 'vel', label: 'VELOCITY', min: 1, max: 127, fmt: v => v, hint: 'Drag up and down across trigs to draw velocity' },
    prob:  { field: 'prob', label: 'CHANCE', min: 0, max: 100, fmt: v => v + '%', hint: 'Drag to draw the chance each trig plays' },
    micro: { field: 'micro', label: 'MICRO TIMING', min: -23, max: 23, bipolar: true, fmt: v => (v > 0 ? '+' : '') + v + '/384', hint: 'Middle is on the grid · up = late · down = early' },
    note:  { field: 'note', label: 'NOTE', min: -24, max: 24, bipolar: true, fmt: v => (v > 0 ? '+' : '') + v + ' st', hint: 'Middle is the track pitch · drag for melodies' },
  };
  ui.LAYERS = LAYERS;
  let layerDrag = null;
  function layerValue(el, y) {
    const L = LAYERS[ui.layer], r = el.getBoundingClientRect();
    const n = U.clamp(1 - (y - r.top) / r.height, 0, 1);
    let v = Math.round(L.min + n * (L.max - L.min));
    if (L.bipolar && Math.abs(n - 0.5) < 0.06) v = 0;     // snap to the middle
    return v;
  }
  function layerApply(i, k, el, y) {
    const s = S.track(i).steps[k];
    if (!s) return;
    const L = LAYERS[ui.layer], v = layerValue(el, y);
    s[L.field] = v;
    if (HX.oled) HX.oled.show(L.label + ' · STEP ' + (k + 1), L.fmt(v), (v - L.min) / (L.max - L.min), L.bipolar);
  }
  function startLayerDraw(e, i, k, el) {
    S.commit(true);
    layerDrag = { i };
    layerApply(i, k, el, e.clientY);
    S.changed();
    const move = ev => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const st = t && t.closest('.step');
      if (!layerDrag || !st || +st.closest('.lane').dataset.i !== layerDrag.i) return;
      layerApply(layerDrag.i, ui.page * C.PAGE + +st.dataset.k, st, ev.clientY);
      S.changed();
    };
    const up = () => { layerDrag = null; document.removeEventListener('pointermove', move); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    document.addEventListener('pointercancel', up, { once: true });
  }

  /* ---------- toggle layers: LOCKS (lock-only steps) and SLIDE ---------- */
  const TOGGLES = {
    lock: {
      hint: 'Click to add a lock without a trig · right-click it to choose what it changes (filter, level, pan, sends)',
      // 'add': empty or note → lock only · 'del': lock only → removed
      decide: s => (s && s.trigless ? 'del' : 'add'),
      apply(T, k, how) {
        const s = T.steps[k];
        if (how === 'add') { if (!s) T.steps[k] = S.mkStep({ trigless: 1 }); else s.trigless = 1; }
        else if (s && s.trigless) T.steps[k] = null;
      },
    },
    slide: {
      hint: 'Click a trig or lock to glide into it from the step before · set the time in its TRIG tab',
      decide: s => (s && s.slide ? 'off' : 'on'),
      apply(T, k, how) { const s = T.steps[k]; if (s) s.slide = how === 'on' ? (s.slide || 3) : 0; },
    },
  };
  function startToggleDraw(i, k) {
    const L = TOGGLES[ui.layer], T = S.track(i);
    S.commit(true);
    const how = L.decide(T.steps[k]);
    const seen = new Set([k]);
    L.apply(T, k, how);
    S.changed();
    const move = ev => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const st = t && t.closest('.step');
      if (!st || +st.closest('.lane').dataset.i !== i) return;
      const kk = ui.page * C.PAGE + +st.dataset.k;
      if (seen.has(kk)) return;
      seen.add(kk);
      L.apply(T, kk, how);
      S.changed();
    };
    const up = () => document.removeEventListener('pointermove', move);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    document.addEventListener('pointercancel', up, { once: true });
  }

  function selectStep(i, k, add, el) {
    const T = S.track(i);
    if (!T.steps[k]) { S.commit(true); T.steps[k] = S.mkStep({ trigless: ui.layer === 'lock' ? 1 : 0 }); }
    if (add && ui.sel && ui.sel.track === i) {
      if (ui.sel.steps.has(k) && ui.sel.steps.size > 1) ui.sel.steps.delete(k); else ui.sel.steps.add(k);
    } else ui.sel = { track: i, steps: new Set([k]) };
    HX.seq.preview(i, k);
    HX.panel.open({ mode: 'lock', track: i }, el);
    S.changed();
  }

  function onStepWheel(e) {
    const hit = stepAt(e);
    if (!hit) return;
    const T = S.track(hit.i), s = T.steps[hit.k];
    if (!s) return;
    e.preventDefault();
    S.commit();
    s.vel = U.clamp(s.vel + (e.deltaY < 0 ? 4 : -4), 1, 127);
    if (HX.oled) HX.oled.show('VELOCITY · STEP ' + (hit.k + 1), s.vel, s.vel / 127);
    S.changed();
  }

  /* ===================== transport ===================== */
  function bindTransport() {
    $('#btnPlay').addEventListener('click', () => HX.seq.togglePause());
    $('#btnStop').addEventListener('click', () => {
      if (!HX.seq.playing && !HX.seq.paused) { ui.page = 0; ui.cursor = 0; }
      HX.seq.stop();
    });
    [['#btnNudgeUp', 1], ['#btnNudgeDn', -1]].forEach(([id, d]) => {
      const b = $(id);
      b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); HX.seq.setNudge(d); });
      const up = () => { if (HX.seq.nudge === d) HX.seq.setNudge(0); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
    $('#btnCapture').addEventListener('click', () => HX.rec.toggle());
    $('#btnExport').addEventListener('click', e => {
      if (HX.panel.st && HX.panel.st.mode === 'export') HX.panel.close();
      else HX.panel.open({ mode: 'export' }, e.currentTarget);
    });
    $('#btnTime').addEventListener('click', e => {
      if (HX.panel.st && HX.panel.st.mode === 'clock') HX.panel.close();
      else HX.panel.open({ mode: 'clock' }, e.currentTarget);
    });
    $('#btnRec').addEventListener('click', () => { HX.seq.rec = !HX.seq.rec; S.changed(); });

    const fill = $('#btnFill');
    fill.addEventListener('pointerdown', e => {
      if (e.shiftKey) { HX.seq.fillLatch = !HX.seq.fillLatch; HX.seq.setFill(HX.seq.fillLatch); return; }
      HX.seq.fillLatch = false; HX.seq.setFill(true);
      fill.setPointerCapture(e.pointerId);
    });
    const fillUp = () => { if (!HX.seq.fillLatch) HX.seq.setFill(false); };
    fill.addEventListener('pointerup', fillUp);
    fill.addEventListener('pointercancel', fillUp);

    numDrag($('#bpm'), () => S.project.bpm, v => { S.project.bpm = Math.round(U.clamp(v, 20, 400) * 10) / 10; HX.audio.applyFx(S.project.fx); }, 1, 0.1,
      v => v.toFixed(1), 'TEMPO');
    numDrag($('#swing'), () => S.project.swing, v => { S.project.swing = Math.round(U.clamp(v, 50, 80)); }, 1, 1,
      v => v + '%', 'SWING');

    let taps = [];
    $('#btnTap').addEventListener('pointerdown', () => {
      const t = performance.now();
      if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
      taps.push(t);
      if (taps.length > 5) taps.shift();
      if (taps.length >= 2) {
        const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
        S.project.bpm = Math.round(U.clamp(60000 / avg, 20, 400) * 10) / 10;
        HX.audio.applyFx(S.project.fx);
        if (HX.oled) HX.oled.show('TAP TEMPO', S.project.bpm.toFixed(1) + ' BPM', null);
        S.changed();
      }
    });

    $('#btnFx').addEventListener('click', e => {
      if (HX.panel.st && HX.panel.st.mode === 'master') HX.panel.close();
      else HX.panel.open({ mode: 'master' }, e.currentTarget);
    });
    $('#btnUndo').addEventListener('click', () => S.undo());
    $('#btnRedo').addEventListener('click', () => S.redo());
  }

  // Vertical-drag number field (tempo, swing).
  function numDrag(el, get, set, step, fineStep, show, label) {
    let d = null;
    const paint = () => { el.textContent = show(get()); el.setAttribute('aria-valuenow', get()); };
    const apply = v => { set(v); paint(); if (HX.oled) HX.oled.show(label, show(get()), null); S.changed(); };
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.focus({ preventScroll: true });
      S.commit(true);
      el.setPointerCapture(e.pointerId);
      d = { y: e.clientY, v: get() };
    });
    el.addEventListener('pointermove', e => {
      if (!d) return;
      const s = e.shiftKey ? fineStep : step;
      apply(d.v + Math.round((d.y - e.clientY) / 3) * s);
    });
    el.addEventListener('pointerup', () => { d = null; });
    el.addEventListener('pointercancel', () => { d = null; });
    el.addEventListener('wheel', e => { e.preventDefault(); S.commit(); apply(get() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? fineStep : step)); }, { passive: false });
    el.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation(); S.commit();
        apply(get() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? fineStep : step));
      }
    });
    ui['paint_' + el.id] = paint;
  }

  function bindSeqBar() {
    $('#btnDouble').addEventListener('click', () => { S.commit(true); S.doubleLength(); S.changed(); });
    $('#btnHalf').addEventListener('click', () => {
      S.commit(true); S.halveLength();
      ui.page = Math.min(ui.page, Math.ceil(S.pat().len / C.PAGE) - 1); S.changed();
    });
    $('#btnFollow').addEventListener('click', () => { ui.follow = !ui.follow; ui.render(); });
    $('#layers').addEventListener('click', e => {
      const b = e.target.closest('[data-layer]');
      if (!b) return;
      ui.layer = b.dataset.layer;
      ui.render();
    });
  }

  function bindPatternActions() {
    $('#btnDup').addEventListener('click', () => {
      const pr = S.project, from = pr.current;
      let to = -1;
      for (let n = 1; n < C.PATTERNS; n++) { const c = (from + n) % C.PATTERNS; if (S.isEmpty(pr.patterns[c])) { to = c; break; } }
      if (to < 0) to = (from + 1) % C.PATTERNS;
      pr.patterns[to] = JSON.parse(JSON.stringify(pr.patterns[from]));
      if (HX.oled) HX.oled.show('DUPLICATED', 'A' + (from + 1) + ' → A' + (to + 1), null);
      HX.seq.queue(to);
      S.changed();
    });
    $('#btnClearPat').addEventListener('click', () => {
      S.commit(true);
      S.pat().tracks.forEach(T => S.clearTrack(T));
      S.changed();
    });
  }

  /* ===================== open the panel for a track ===================== */
  ui.openTrack = function (i, tab, anchor) {
    ui.selTrack = i;
    if (HX.panel.st && HX.panel.st.mode === 'sound' && HX.panel.st.track === i && !tab) { HX.panel.close(); return; }
    ui.sel = null;
    HX.panel.open({ mode: 'sound', track: i, tab: tab || undefined }, anchor || tileEls[i]);
    S.changed();
  };

  /* ===================== render ===================== */
  ui.render = function () {
    const P = S.pat();
    const pages = Math.ceil(P.len / C.PAGE);
    if (ui.page >= pages) ui.page = pages - 1;
    renderTiles();
    renderLanes();
    // pattern slots
    document.querySelectorAll('.slot').forEach(b => {
      const n = +b.dataset.n;
      b.classList.toggle('current', n === S.project.current);
      b.classList.toggle('queued', n === HX.seq.queued());
      b.classList.toggle('filled', !S.isEmpty(S.project.patterns[n]));
      b.title = S.project.patterns[n].name;
    });
    // pages
    document.querySelectorAll('.page').forEach(b => {
      const p = +b.dataset.p;
      b.disabled = p >= pages;
      b.classList.toggle('current', p === ui.page);
    });
    $('#lenOut').textContent = P.len;
    $('#btnDouble').disabled = P.len >= 64;
    $('#btnHalf').disabled = P.len <= 16;
    $('#btnFollow').setAttribute('aria-pressed', ui.follow);
    // transport
    const play = $('#btnPlay');
    play.classList.toggle('on', HX.seq.playing);
    play.classList.toggle('paused', HX.seq.paused);
    play.classList.toggle('wait', HX.seq.waitExt);
    const cap = $('#btnCapture');
    cap.classList.toggle('armed', HX.rec.state === 'armed');
    cap.classList.toggle('rec', HX.rec.state === 'rec');
    const tc = $('#takeCount');
    tc.hidden = !HX.rec.takes.length;
    tc.textContent = HX.rec.takes.length;
    $('#btnNudgeUp').classList.toggle('on', HX.seq.nudge > 0);
    $('#btnNudgeDn').classList.toggle('on', HX.seq.nudge < 0);
    document.querySelectorAll('#layers [data-layer]').forEach(b => b.setAttribute('aria-checked', b.dataset.layer === ui.layer));
    $('#lanes').classList.toggle('layer', !!LAYERS[ui.layer]);
    $('#seqHint').textContent = ui.layer === 'trig'
      ? 'Click a step to add a trig · drag to paint · right-click or hold to lock · wheel for velocity'
      : (LAYERS[ui.layer] || TOGGLES[ui.layer]).hint;
    renderPerform();
    $('#btnRec').classList.toggle('on', HX.seq.rec);
    $('#btnRec').setAttribute('aria-pressed', HX.seq.rec);
    $('#btnFill').classList.toggle('on', HX.seq.fill);
    if (ui.paint_bpm) ui.paint_bpm();
    if (ui.paint_swing) ui.paint_swing();
    if (ui.sweep) ui.sweep.update();
    document.getElementById('unit').classList.toggle('steprec', HX.seq.rec && !HX.seq.playing);
    HX.panel.refresh();
  };

  function renderTiles() {
    const syn = HX.PARAMS.filter(d => d.page === 'syn');
    tileEls.forEach((el, i) => {
      const T = S.track(i), m = HX.machines.byId[T.machine];
      el.querySelector('.tile-mach').textContent = m.name;
      el.querySelector('.tile-snd').textContent = T.sname ? T.sname + (T.sdirty ? ' *' : '') : '';
      const g = el.querySelector('.tile-glyph');
      if (g.dataset.m !== m.id) { g.innerHTML = ui.glyph(m.id); g.dataset.m = m.id; }
      el.querySelectorAll('.bar i').forEach((bar, j) => {
        const d = syn[j];
        bar.style.setProperty('--h', (T.params[d.id] - d.min) / (d.max - d.min));
      });
      const muted = !!HX.seq.mutes[i], solo = !!HX.seq.solos[i];
      el.querySelector('[data-act="mute"]').setAttribute('aria-pressed', muted);
      el.querySelector('[data-act="solo"]').setAttribute('aria-pressed', solo);
      el.classList.toggle('silent', !HX.seq.audible(i));
      el.classList.toggle('selected', HX.panel.st && HX.panel.st.mode !== 'master' && HX.panel.st.track === i);
    });
  }

  function renderLanes() {
    const P = S.pat();
    laneEls.forEach((lane, i) => {
      const T = P.tracks[i], m = HX.machines.byId[T.machine];
      lane.querySelector('.ll-name').textContent = m.name;
      const tags = [];
      if (T.speed !== HX.SPEED_1X) tags.push(HX.SPEEDS[T.speed].label);
      if (T.dir) tags.push(HX.DIRS[T.dir].short);
      if (T.seedLock) tags.push('SEED');
      lane.querySelector('.lane-info').innerHTML = '<b>' + T.len + '</b>' + (tags.length ? '<i>' + tags.join(' · ') + '</i>' : '');
      lane.classList.toggle('silent', !HX.seq.audible(i));
      lane.classList.toggle('poly', T.len !== P.len || T.speed !== HX.SPEED_1X || T.dir > 0);
      const Ly = LAYERS[ui.layer];
      stepEls[i].forEach((el, k16) => {
        const k = ui.page * C.PAGE + k16;
        const s = T.steps[k];
        const cl = el.classList;
        cl.toggle('on', !!s);
        cl.toggle('out', k >= T.len);
        cl.toggle('lock', !!s && Object.keys(s.locks).length > 0);
        cl.toggle('cond', !!s && (s.cond > 0 || s.prob < 100));
        cl.toggle('rtrg', !!s && s.retrig > 0 && !s.trigless);
        cl.toggle('tl', !!s && !!s.trigless);
        cl.toggle('glide', !!s && s.slide > 0);
        cl.toggle('slk', !!s && !!s.slock);
        cl.toggle('sel', !!(ui.sel && ui.sel.track === i && ui.sel.steps.has(k)));
        cl.toggle('cursor', HX.seq.rec && !HX.seq.playing && k === ui.cursor);
        if (s && Ly) {
          const n = (s[Ly.field] - Ly.min) / (Ly.max - Ly.min);
          const z = Ly.bipolar ? 0.5 : 0;
          el.style.setProperty('--lb', Math.min(n, z).toFixed(3));
          el.style.setProperty('--lh', Math.max(Math.abs(n - z), 0.03).toFixed(3));
        }
        if (s) {
          el.style.setProperty('--v', (0.35 + 0.65 * s.vel / 127).toFixed(3));
          el.style.setProperty('--mx', (s.micro / 23).toFixed(3));
          el.title = 'Step ' + (k + 1) + (s.trigless ? ' · lock only' : ' · vel ' + s.vel) + (s.cond ? ' · ' + HX.CONDS[s.cond].label : '') +
            (s.prob < 100 ? ' · ' + s.prob + '%' : '') + (s.note ? ' · note ' + HX.fmt.semi(s.note) : '') +
            (s.slide ? ' · slide ' + HX.SLIDES[s.slide] + ' step' : '') + (s.slock ? ' · sound: ' + s.slock.name : '') +
            (Object.keys(s.locks).length ? ' · locks: ' + Object.keys(s.locks).join(', ') : '');
        } else { el.style.removeProperty('--mx'); el.title = ''; }
        cl.toggle('ph', k === ui.play[i]);
      });
    });
  }
  ui.renderLanes = renderLanes;

  /* ===================== perform strip ===================== */
  function bindPerform() {
    const PF = HX.perform, xf = $('#xf');
    // Grab the thumb and it moves with your finger from where you grabbed it
    // (no jump); press the track elsewhere and the thumb jumps there.
    const TH = 30;
    let drag = null;
    const valueAt = x => { const r = drag.r; return U.clamp((x - r.left - drag.off - TH / 2) / (r.width - TH), 0, 1) * 127; };
    xf.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); xf.focus({ preventScroll: true });
      xf.setPointerCapture(e.pointerId);
      const r = xf.getBoundingClientRect();
      const thumbX = r.left + TH / 2 + (S.project.perform.xfade / 127) * (r.width - TH);
      const onThumb = Math.abs(e.clientX - thumbX) <= TH / 2 + 4;
      drag = { r, off: onThumb ? e.clientX - thumbX : 0 };
      xf.classList.add('dragging');
      if (!onThumb) PF.setX(valueAt(e.clientX));
    });
    xf.addEventListener('pointermove', e => {
      if (!drag) return;
      // use the newest of the coalesced samples (phones batch them per frame)
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      PF.setX(valueAt((evs.length ? evs[evs.length - 1] : e).clientX));
    });
    const end = () => { drag = null; xf.classList.remove('dragging'); };
    xf.addEventListener('pointerup', end); xf.addEventListener('pointercancel', end);
    xf.addEventListener('dblclick', () => PF.setX(0));
    xf.addEventListener('wheel', e => { e.preventDefault(); PF.setX(S.project.perform.xfade + (e.deltaY < 0 || e.deltaX > 0 ? 4 : -4)); }, { passive: false });
    xf.addEventListener('keydown', e => {
      const x = S.project.perform.xfade, big = e.shiftKey ? 16 : 4;
      const k = { ArrowRight: big, ArrowUp: big, ArrowLeft: -big, ArrowDown: -big, PageUp: 32, PageDown: -32 }[e.key];
      if (k) { e.preventDefault(); e.stopPropagation(); PF.setX(x + k); }
      else if (e.key === 'Home') { e.preventDefault(); PF.setX(0); }
      else if (e.key === 'End') { e.preventDefault(); PF.setX(127); }
    });
    [['#punchA', 'a'], ['#punchB', 'b']].forEach(([id, side]) => {
      const b = $(id);
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); PF.setPunch(side); });
      const up = () => { if (PF.punch === side) PF.setPunch(null); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); PF.setPunch(side); } });
      b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') up(); });
    });
    document.querySelectorAll('.pstep').forEach(b => b.addEventListener('click', () => PF.assign(b.dataset.side, +b.dataset.d)));
    [['#editA', 'a'], ['#editB', 'b']].forEach(([id, side]) => $(id).addEventListener('click', () => {
      PF.setEdit(side);
      if (PF.edit && !(HX.panel.st && (HX.panel.st.mode === 'sound' || HX.panel.st.mode === 'master'))) {
        HX.panel.open({ mode: 'sound', track: ui.selTrack }, tileEls[ui.selTrack]);
      }
    }));
    $('#btnAll').addEventListener('click', () => {
      PF.toggleAll();
      if (PF.all && !(HX.panel.st && HX.panel.st.mode === 'sound')) HX.panel.open({ mode: 'sound', track: ui.selTrack }, tileEls[ui.selTrack]);
    });
    $('#btnKeep').addEventListener('click', () => PF.allKeep());
    $('#btnRevert').addEventListener('click', () => PF.allRevert());
    $('#btnScenes').addEventListener('click', e => {
      if (HX.panel.st && HX.panel.st.mode === 'perform') HX.panel.close();
      else HX.panel.open({ mode: 'perform' }, e.currentTarget);
    });
  }

  function renderPerform() {
    const PF = HX.perform, pf = S.project.perform, v = PF.view();
    $('#sceneA').textContent = PF.sceneLabel(pf.a);
    $('#sceneB').textContent = PF.sceneLabel(pf.b);
    const xf = $('#xf');
    // thumb + fill move on the compositor (transform), no layout, no easing lag
    const w = xf.clientWidth - 30;
    xf.querySelector('.xf-thumb').style.transform = 'translate3d(' + (v.x * w).toFixed(2) + 'px,0,0)';
    xf.querySelector('.xf-fill').style.transform = 'scaleX(' + v.x.toFixed(4) + ')';
    xf.setAttribute('aria-valuenow', Math.round(pf.xfade));
    xf.setAttribute('aria-valuetext', Math.round(pf.xfade / 1.27) + '% toward B');
    xf.classList.toggle('pinned', !!(PF.edit || PF.punch));
    $('#editA').setAttribute('aria-pressed', PF.edit === 'a');
    $('#editB').setAttribute('aria-pressed', PF.edit === 'b');
    $('#punchA').classList.toggle('on', PF.punch === 'a' || PF.edit === 'a');
    $('#punchB').classList.toggle('on', PF.punch === 'b' || PF.edit === 'b');
    $('#btnAll').setAttribute('aria-pressed', !!PF.all);
    $('#btnKeep').hidden = $('#btnRevert').hidden = !PF.all;
  }
  ui.renderPerform = renderPerform;

  /* ===================== clock-driven updates (from main.js) ===================== */
  ui.setPlayhead = function (i, k) {
    const old = ui.play[i];
    ui.play[i] = k;
    const base = ui.page * C.PAGE;
    if (old >= base && old < base + C.PAGE) stepEls[i][old - base].classList.remove('ph');
    if (k >= base && k < base + C.PAGE) stepEls[i][k - base].classList.add('ph');
  };
  ui.clearPlayheads = function () {
    for (let i = 0; i < C.TRACKS; i++) ui.setPlayhead(i, -1);
    document.querySelectorAll('.page').forEach(b => b.classList.remove('playing'));
  };
  ui.masterStep = function (step) {
    if (step < 0) return;                       // counting in
    const p = Math.floor(step / C.PAGE);
    document.querySelectorAll('.page').forEach(b => b.classList.toggle('playing', +b.dataset.p === p));
    if (ui.follow && p !== ui.page) { ui.page = p; ui.render(); }
  };
  ui.flash = function (i, vel) {
    const led = tileEls[i].querySelector('.pad-led');
    led.animate([{ opacity: 0.25 + vel * 0.75, transform: 'scale(1.08)' }, { opacity: 0, transform: 'scale(1)' }],
      { duration: 90 + vel * 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
    laneEls[i].querySelector('.ll-led').animate([{ opacity: 0.3 + vel * 0.7 }, { opacity: 0 }], { duration: 200 + vel * 160, easing: 'ease-out' });
  };
})(window.HX);
