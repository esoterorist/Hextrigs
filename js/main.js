/* =====================================================================
   HEXTRIG · main.js
   Boot, the animation-frame loop (audio clock → UI), keyboard
   shortcuts, and the two dialogs (help, save / load).
   ===================================================================== */
(function (HX) {
  'use strict';
  const S = HX.state, seq = () => HX.seq, ui = () => HX.ui;
  const $ = s => document.querySelector(s);

  // Keep the last few errors for the Sound check screen.
  HX.errors = [];
  window.addEventListener('error', e => { HX.errors.push(String(e.message || e.error || 'error').slice(0, 160)); });
  window.addEventListener('unhandledrejection', e => { HX.errors.push('promise: ' + String(e.reason && (e.reason.message || e.reason)).slice(0, 160)); });

  function boot() {
    S.load();
    HX.panel.init();
    HX.exporter.init();
    HX.ui.build();
    HX.oled.init($('#oled'));
    S.onChange(() => HX.ui.render());
    if (document.fonts && document.fonts.load) document.fonts.load('8px Silkscreen').catch(() => {});
    bindKeys();
    bindDialogs();
    // audio needs a user gesture; any first interaction wakes it
    // Sound may only start inside a gesture, and on phones only when a finger lifts.
    // Keep trying on every such gesture until the audio is really running.
    const wake = () => { if (!HX.audio.running()) HX.audio.unlock(); };
    ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(t => window.addEventListener(t, wake, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && HX.audio.ctx() && !HX.audio.running()) HX.audio.ctx().resume().catch(() => {});
    });
    requestAnimationFrame(frame);
  }

  /* ---------- audio clock → screen ---------- */
  let playSince = 0, offerShown = false;
  function frame() {
    requestAnimationFrame(frame);
    HX.seq.pump();                       // backup clock (see sequencer.js startTimer)
    const ac = HX.audio.ctx();
    // Playing for 2 s and still no sound running? Offer the Sound check once.
    if (HX.seq.playing) {
      if (!playSince) playSince = performance.now();
      const stuck = !ac || ac.state !== 'running' || !(HX.seq.stats.ticks > 0);
      if (stuck && !offerShown && performance.now() - playSince > 2000) { offerShown = true; $('#soundBar').hidden = false; }
    } else playSince = 0;
    if (ac) {
      const now = ac.currentTime - (ac.outputLatency || 0);
      for (const e of HX.seq.drain(now)) {
        switch (e.type) {
          case 'step': HX.ui.setPlayhead(e.track, e.step); break;
          case 'trig': HX.ui.flash(e.track, e.vel); HX.oled.flash(e.track, e.vel); break;
          case 'master':
            HX.seq.uiMaster = e.step; HX.seq.uiPos = e.pos; HX.seq.uiCount = e.count ? Math.ceil(-e.pos / 4) : 0;
            HX.ui.masterStep(e.step);
            if (HX.panel.st && HX.panel.st.mode === 'export' && HX.rec.state !== 'idle') HX.panel.refresh();
            break;
          case 'pattern':
            S.project.current = e.pat;       // the screen follows what you hear
            HX.ui.page = 0;
            S.changed();
            break;
          case 'songEnd': HX.seq.stop(); break;
          case 'stop': HX.ui.clearPlayheads(); break;
        }
      }
    }
    HX.oled.draw();
  }

  /* ---------- keyboard ---------- */
  const NOTE_KEYS = { KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14 };
  const TRACK_KEYS = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, KeyT: 4, KeyY: 5 };
  let octave = 0;

  function bindKeys() {
    window.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return;
      if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? S.redo() : S.undo(); return; }
      if (mod) return;
      const code = e.code;

      if (code === 'Space') { e.preventDefault(); if (!e.repeat) (e.shiftKey ? HX.seq.togglePause() : HX.seq.toggle()); return; }
      if ((code === 'ArrowUp' || code === 'ArrowDown') && !e.repeat) { e.preventDefault(); HX.seq.setNudge(code === 'ArrowUp' ? 1 : -1); return; }
      if (code === 'Escape') { if (HX.perform.edit) HX.perform.setEdit(HX.perform.edit); HX.panel.close(); return; }
      if ((code === 'Enter' || code === 'NumpadEnter') && !e.repeat && !(e.target.closest && e.target.closest('button, [role="slider"], [role="spinbutton"]'))) { e.preventDefault(); HX.rec.toggle(); return; }
      if (e.key === '?') { openHelp(); return; }

      const digit = /^Digit([1-6])$/.exec(code);
      if (digit) {
        e.preventDefault();
        if (e.repeat) return;
        const i = +digit[1] - 1;
        if (e.shiftKey) HX.seq.toggleMute(i); else { HX.ui.selTrack = i; HX.seq.pad(i, 0.9); }
        return;
      }
      if (code in TRACK_KEYS && !e.repeat) {
        const i = TRACK_KEYS[code];
        HX.ui.openTrack(i, null, document.querySelectorAll('.tile')[i]);
        return;
      }
      if (code === 'KeyF' && !e.repeat) { HX.seq.fillLatch = false; HX.seq.setFill(true); return; }
      if (code in NOTE_KEYS && !e.repeat) {
        const i = HX.ui.selTrack;
        HX.seq.pad(i, 0.85, NOTE_KEYS[code] + octave * 12);
        if (HX.seq.rec && !HX.seq.playing) { HX.ui.cursor = (HX.ui.cursor + 1) % S.track(i).len; HX.ui.render(); }
        return;
      }
      if (code === 'Minus') { octave = Math.max(-2, octave - 1); HX.oled.show('OCTAVE', (octave > 0 ? '+' : '') + octave, null); return; }
      if (code === 'Equal') { octave = Math.min(2, octave + 1); HX.oled.show('OCTAVE', (octave > 0 ? '+' : '') + octave, null); return; }

      const stepRec = HX.seq.rec && !HX.seq.playing;
      if (code === 'ArrowRight' || code === 'ArrowLeft') {
        e.preventDefault();
        const dir = code === 'ArrowRight' ? 1 : -1;
        if (stepRec) {
          const n = S.pat().len;
          HX.ui.cursor = (HX.ui.cursor + dir + n) % n;
          HX.ui.page = Math.floor(HX.ui.cursor / 16);
        } else {
          const pages = S.pat().len / 16;
          HX.ui.page = (HX.ui.page + dir + pages) % pages;
          HX.ui.follow = false;
        }
        HX.ui.render();
        return;
      }
      if (code === 'BracketLeft' || code === 'BracketRight') {
        const n = (S.project.current + (code === 'BracketRight' ? 1 : -1) + 8) % 8;
        HX.seq.queue(n);
        return;
      }
      if (code === 'Backspace' && stepRec) {
        S.commit(true);
        S.track(HX.ui.selTrack).steps[HX.ui.cursor] = null;
        S.changed();
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'KeyF' && !HX.seq.fillLatch) HX.seq.setFill(false);
      if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && HX.seq.nudge) HX.seq.setNudge(0);
    });
    window.addEventListener('blur', () => {
      if (!HX.seq.fillLatch && HX.seq.fill) HX.seq.setFill(false);
      if (HX.seq.nudge) HX.seq.setNudge(0);
    });
  }

  /* ---------- dialogs ---------- */
  function openModal(html) {
    const m = $('#modal');
    m.querySelector('.modal-body').innerHTML = html;
    m.hidden = false;
    HX.panel.close();
    const f = m.querySelector('button, textarea'); if (f) f.focus();
  }
  function closeModal() { $('#modal').hidden = true; }

  function openHelp() {
    openModal(
      '<h2>Playing HEXTRIG</h2>' +
      '<div class="help-cols">' +
      '<section><h3>Steps</h3><dl>' +
        '<dt>Click</dt><dd>add or remove a trig</dd>' +
        '<dt>Drag</dt><dd>paint or erase across a lane</dd>' +
        '<dt>Right-click · hold</dt><dd>select a step to p-lock it. Every slider you move now writes to that step only.</dd>' +
        '<dt>Shift + right-click</dt><dd>lock several steps at once</dd>' +
        '<dt>Wheel</dt><dd>velocity of a trig</dd>' +
      '</dl></section>' +
      '<section><h3>Perform</h3><dl>' +
        '<dt>Crossfader</dt><dd>blends scene A into scene B: any sound value of any track, plus master FX and sweep</dd>' +
        '<dt>A · B (hold)</dt><dd>jump to that scene while held</dd>' +
        '<dt>Edit</dt><dd>every slider you move now writes into that scene, and you hear it</dd>' +
        '<dt>Control all</dt><dd>one slider moves all six tracks; KEEP or REVERT after</dd>' +
      '</dl></section>' +
      '<section><h3>Locks and slides</h3><dl>' +
        '<dt>EDIT · Locks</dt><dd>place locks without a trig: they change filter, level, pan and sends of the note that is ringing</dd>' +
        '<dt>EDIT · Slide</dt><dd>glide into a step from the one before (TONE also glides pitch)</dd>' +
        '<dt>REC + sliders</dt><dd>while playing, slider moves are recorded as locks on the steps</dd>' +
        '<dt>SOUND tab</dt><dd>load, save, randomize or mutate sounds and kits; on a step, it sets a sound lock</dd>' +
      '</dl></section>' +
      '<section><h3>Trig marks</h3><dl>' +
        '<dt>Dot in LED</dt><dd>step has parameter locks</dd>' +
        '<dt>Hollow LED</dt><dd>lock only, no trig</dd>' +
        '<dt>Ramp left of LED</dt><dd>slide</dd>' +
        '<dt>Square, bottom left</dt><dd>sound lock</dd>' +
        '<dt>Corner notch</dt><dd>condition or chance</dd>' +
        '<dt>Ticks below</dt><dd>retrig</dd>' +
        '<dt>LED off-centre</dt><dd>micro timing early or late</dd>' +
      '</dl></section>' +
      '<section><h3>Timing</h3><dl>' +
        '<dt>Speed</dt><dd>per track, including triplet (2/3, 4/3), quintuplet (5/4) and 3× grids</dd>' +
        '<dt>Direction</dt><dd>forward, reverse, ping-pong, pendulum, random, drunk</dd>' +
        '<dt>Edit · Micro</dt><dd>drag steps up (late) or down (early)</dd>' +
        '<dt>Retrig curve</dt><dd>bouncing-ball rolls that speed up or slow down</dd>' +
        '<dt>Seed</dt><dd>every random choice is seeded: lock it to repeat a lucky loop</dd>' +
      '</dl></section>' +
      '<section><h3>Conditions</h3><dl>' +
        '<dt>A:B</dt><dd>play on pass A of every B loops</dd>' +
        '<dt>FILL</dt><dd>only while FILL is held (F key)</dd>' +
        '<dt>PRE</dt><dd>if this track\'s last condition passed</dd>' +
        '<dt>NEI</dt><dd>if the track above passed</dd>' +
        '<dt>1ST</dt><dd>first pass of the pattern only</dd>' +
      '</dl></section>' +
      '<section><h3>Keys</h3><dl>' +
        '<dt>Space</dt><dd>play from the top / stop</dd>' +
        '<dt>Shift + Space</dt><dd>pause / continue</dd>' +
        '<dt>↑ ↓ (hold)</dt><dd>nudge tempo ±4% to line up with another player</dd>' +
        '<dt>1 – 6</dt><dd>play pads (records when REC is on)</dd>' +
        '<dt>Shift + 1 – 6</dt><dd>mute</dd>' +
        '<dt>Q W E R T Y</dt><dd>open a track\'s sound</dd>' +
        '<dt>Z S X D C …</dt><dd>play notes on the selected track · − / = octave</dd>' +
        '<dt>F (hold)</dt><dd>fill</dd>' +
        '<dt>[ ]</dt><dd>queue previous / next pattern</dd>' +
        '<dt>← →</dt><dd>page, or step cursor in step record</dd>' +
        '<dt>Enter</dt><dd>capture the next bars (again: stop or cancel)</dd>' +
        '<dt>⌘/Ctrl + Z</dt><dd>undo · with Shift: redo</dd>' +
      '</dl></section>' +
      '</div>' +
      '<p class="help-note"><b>Step record:</b> stop the sequencer and press REC. Pads and note keys write at the blinking step; note keys move the cursor on. <b>Live record:</b> press REC while playing and play the pads.</p>' +
      '<p class="help-note"><b>No sound on a phone?</b> Tap the screen once more: phones only start audio from a tap. If it still stays silent, run the <button type="button" class="linkbtn" data-help="sound">Sound check</button>.</p>' +
      '<p class="help-note"><b>Getting it into a DAW:</b> CAPTURE records the next bars of what you hear, exactly on the bar lines, sweeps and mutes included. EXPORT → BOUNCE renders the pattern or song offline as a mix, six stems and a MIDI file. Both save one .zip.</p>' +
      '<p class="help-note"><b>Polymeter:</b> each track has its own length, speed and direction (TRK tab, or the number at the end of a lane). <b>TIME</b> sets when queued patterns change, the metronome and count-in, song mode, and MIDI clock in or out.</p>' +
      '<div class="modal-acts"><button type="button" class="key k-text" data-close>Close</button></div>'
    );
  }

  /* ---------- Sound check ---------- */
  function soundReport() {
    const ac = HX.audio.ctx(), st = HX.seq.stats;
    return [
      'Audio: ' + (ac ? ac.state + ' · ' + ac.sampleRate + ' Hz · latency ' + Math.round(((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000) + ' ms' : 'not started yet'),
      'Clock: ' + HX.seq.timer() + ' · ' + (st.ticks || 0) + ' ticks · ' + (st.notes || 0) + ' notes sent · ' + st.late + ' late',
      'Playing: ' + (HX.seq.playing ? 'yes' : 'no') + ' · muted tracks: ' + HX.seq.mutes.reduce((a, m) => a + m, 0),
      'Phone audio mode: ' + (navigator.audioSession ? navigator.audioSession.type : 'not available'),
      'Browser: ' + navigator.userAgent.slice(0, 140),
      'Errors: ' + (HX.errors.length ? HX.errors.slice(-3).join(' | ') : 'none'),
    ].join('\n');
  }
  function openSoundCheck() {
    openModal(
      '<h2>Sound check</h2>' +
      '<p class="help-note">Press <b>Play test tone</b>. You should hear a short beep.</p>' +
      '<div class="modal-acts" style="justify-content:flex-start"><button type="button" class="key k-text" data-sc="tone">Play test tone</button></div>' +
      '<p class="io-msg" id="scMsg" role="status"></p>' +
      '<pre class="sc-report" id="scReport"></pre>' +
      '<p class="help-note">If the beep plays but the patterns do not, or nothing plays at all, copy this report and paste it in the chat.</p>' +
      '<div class="modal-acts"><button type="button" class="key k-text" data-sc="copy">Copy report</button><button type="button" class="key k-text" data-close>Close</button></div>'
    );
    $('#scReport').textContent = soundReport();
  }
  // A beep straight to the speakers, measured on the way out.
  function testTone() {
    const msg = $('#scMsg');
    const ac = HX.audio.unlock();
    const go = () => {
      try {
        const o = ac.createOscillator(), g = ac.createGain(), an = ac.createAnalyser();
        o.frequency.value = 660; g.gain.value = 0.25;
        o.connect(g).connect(an); an.connect(ac.destination);
        const t = ac.currentTime + 0.02;
        o.start(t); o.stop(t + 0.5);
        setTimeout(() => {
          const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d);
          let pk = 0; d.forEach(x => { pk = Math.max(pk, Math.abs(x)); });
          msg.textContent = ac.state !== 'running'
            ? 'The phone did not let the sound start (audio is ' + ac.state + '). Tap the button again.'
            : pk > 0.01
              ? 'The beep left HEXTRIG. If you heard nothing, the phone is silencing it: turn the volume up, check the silent switch, and disconnect Bluetooth headphones.'
              : 'Audio is running but no signal came out. Please copy the report below into the chat.';
          $('#scReport').textContent = soundReport();
        }, 250);
      } catch (err) { msg.textContent = 'Test tone failed: ' + err.message; }
    };
    if (ac.state === 'running') go();
    else ac.resume().then(go, go);
    setTimeout(() => { if (!msg.textContent) go(); }, 600);
  }

  function openIO() {
    const json = S.exportJSON();
    openModal(
      '<h2>Save · load</h2>' +
      '<p class="help-note">Your project autosaves in this browser. To keep it elsewhere or move it to another device, copy this text and paste it back here later.</p>' +
      '<textarea id="ioText" spellcheck="false" aria-label="Project data">' + json.replace(/</g, '&lt;') + '</textarea>' +
      '<p class="io-msg" id="ioMsg" role="status"></p>' +
      '<div class="modal-acts">' +
        '<button type="button" class="key k-text" data-io="copy">Copy</button>' +
        '<button type="button" class="key k-text" data-io="load">Load pasted text</button>' +
        '<button type="button" class="key k-text" data-io="reset">Restore demo patterns</button>' +
        '<button type="button" class="key k-text" data-close>Close</button>' +
      '</div>'
    );
  }

  function bindDialogs() {
    $('#btnHelp').addEventListener('click', openHelp);
    $('#soundBar').addEventListener('click', e => {
      if (e.target.closest('[data-sc="open"]')) openSoundCheck();
      if (e.target.closest('[data-sc="hide"]')) $('#soundBar').hidden = true;
    });
    $('#btnIO').addEventListener('click', openIO);
    const m = $('#modal');
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) { closeModal(); return; }
      const sc = e.target.closest('[data-sc]');
      if (sc && sc.dataset.sc === 'tone') { testTone(); return; }
      if (sc && sc.dataset.sc === 'copy') {
        const txt = soundReport(), msg = $('#scMsg');
        const fallback = () => { const r = document.createRange(); r.selectNodeContents($('#scReport')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); msg.textContent = 'Selected. Copy it from the menu.'; };
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => { msg.textContent = 'Report copied. Paste it in the chat.'; }, fallback); else fallback();
        return;
      }
      if (e.target.closest('[data-help="sound"]')) { openSoundCheck(); return; }
      const b = e.target.closest('[data-io]');
      if (!b) return;
      const ta = $('#ioText'), msg = $('#ioMsg');
      if (b.dataset.io === 'copy') {
        const fallback = () => { ta.focus(); ta.select(); msg.textContent = 'Selected. Press ⌘/Ctrl + C to copy.'; };
        if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(() => { msg.textContent = 'Copied to the clipboard.'; }, fallback);
        else fallback();
      }
      if (b.dataset.io === 'load') {
        try { S.importJSON(ta.value); msg.textContent = 'Project loaded.'; }
        catch (err) { msg.textContent = 'That text is not a HEXTRIG project. Paste the full text you copied from here.'; }
      }
      if (b.dataset.io === 'reset') {
        S.commit(true); S.reset(); HX.audio.applyFx(S.project.fx);
        ta.value = S.exportJSON();
        msg.textContent = 'Demo patterns restored. Undo brings back the pattern you were on.';
      }
    });
  }

  boot();
})(window.HX);
