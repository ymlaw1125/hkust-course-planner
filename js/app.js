/* UI wiring: search, selection, constraints, generation, results. */
(function (global) {
  'use strict';

  const { DAYS, KIND_LABEL, hhmm, Catalog, sectionsByKind, Generator, Render, Parser } = global.HK;
  const $ = (sel) => document.querySelector(sel);
  const esc = Render.escapeHtml;

  const STORE_KEY = 'hkust-planner-v1';

  const state = {
    selected: [],         // course codes, in the order added
    disabled: {},         // code -> Set of section codes the user unticked
    results: [],
    cursor: 0,
    courseOrder: new Map(),
  };

  /* --------------------------------------------------------- boot */

  function boot() {
    const idx = Catalog.init();
    const status = $('#catalog-status');
    if (idx) {
      status.innerHTML =
        `<strong>${idx.termName || idx.term}</strong> · ${idx.courses.length} courses · ${idx.subjects.length} subjects` +
        `<small>scraped ${new Date(idx.generated).toLocaleDateString()}</small>`;
    } else {
      status.innerHTML =
        `<span class="warn">No catalog data found.</span> Run <code>node scripts/scrape.mjs</code>, or use <em>Import / Paste</em>.`;
      Catalog.index = { term: '?', termName: 'Custom', subjects: [], courses: [] };
    }

    buildTimeSelects();
    buildDayChips();
    wireEvents();
    restore();
  }

  function buildTimeSelects() {
    const early = $('#c-earliest');
    const late = $('#c-latest');
    early.innerHTML = '<option value="">Don\'t care</option>';
    late.innerHTML = '<option value="">Don\'t care</option>';
    for (let t = 8 * 60; t <= 20 * 60; t += 30) {
      early.insertAdjacentHTML('beforeend', `<option value="${t}">${hhmm(t)}</option>`);
      late.insertAdjacentHTML('beforeend', `<option value="${t}">${hhmm(t)}</option>`);
    }
  }

  function buildDayChips() {
    const wrap = $('#c-freedays');
    wrap.innerHTML = '';
    for (let d = 0; d < 5; d++) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.day = d;
      b.textContent = DAYS[d];
      b.addEventListener('click', () => { b.classList.toggle('on'); persist(); });
      wrap.appendChild(b);
    }
  }

  /* --------------------------------------------------------- search */

  let searchTimer = null;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  }

  function runSearch() {
    const q = $('#search').value;
    const box = $('#search-results');
    if (!q.trim()) { box.innerHTML = ''; return; }

    const hits = Catalog.search(q);
    if (!hits.length) {
      box.innerHTML = '<p class="empty">No match. Try a code like <code>COMP 2011</code>.</p>';
      return;
    }
    box.innerHTML = hits
      .map((e) => {
        const on = state.selected.includes(e.c);
        return `<button class="sr-item${on ? ' added' : ''}" data-code="${esc(e.c)}">
            <span class="sr-code">${esc(e.c)}</span>
            <span class="sr-title">${esc(e.t)}</span>
            <span class="sr-meta">${e.n} sec${e.u ? ` · ${e.u}u` : ''}</span>
          </button>`;
      })
      .join('');
  }

  /* --------------------------------------------------------- selection */

  async function addCourse(code) {
    if (state.selected.includes(code)) return;
    const course = await Catalog.getCourse(code);
    if (!course) { flash(`Couldn't load ${code}`); return; }
    state.selected.push(code);
    reorderColors();
    renderSelected();
    runSearch();
    persist();
  }

  function removeCourse(code) {
    state.selected = state.selected.filter((c) => c !== code);
    delete state.disabled[code];
    reorderColors();
    renderSelected();
    runSearch();
    persist();
  }

  function reorderColors() {
    state.courseOrder = new Map(state.selected.map((c, i) => [c, i]));
  }

  function isDisabled(code, sec) {
    return !!(state.disabled[code] && state.disabled[code].includes(sec));
  }

  function toggleSection(code, sec) {
    if (!state.disabled[code]) state.disabled[code] = [];
    const list = state.disabled[code];
    const i = list.indexOf(sec);
    if (i >= 0) list.splice(i, 1);
    else list.push(sec);
    persist();
  }

  function renderSelected() {
    const box = $('#selected-list');
    $('#sel-count').textContent = state.selected.length;

    if (!state.selected.length) {
      box.innerHTML = '<p class="empty">No courses selected yet. Search above and click a course to add it.</p>';
      return;
    }

    box.innerHTML = state.selected
      .map((code) => {
        const course = Catalog.courses.get(code);
        if (!course) return '';
        const color = Render.colorFor(code, state.courseOrder.get(code) ?? 0);

        const kinds = sectionsByKind(course)
          .map(([kind, secs]) => {
            const chips = secs
              .map((s) => {
                const off = isDisabled(code, s.section);
                const times = s.meetings.length
                  ? s.meetings.map((m) => `${DAYS[m.day]} ${hhmm(m.start)}`).join(' · ')
                  : 'TBA';
                const full = s.avail != null && s.avail <= 0;
                return `<label class="sec-chip${off ? ' off' : ''}${full ? ' full' : ''}"
                          title="${esc(s.rooms[0] || '')}${s.instructors ? `\n${esc(s.instructors)}` : ''}${s.avail != null ? `\n${s.avail} seats left` : ''}">
                    <input type="checkbox" data-code="${esc(code)}" data-sec="${esc(s.section)}" ${off ? '' : 'checked'}>
                    <span class="sc-name">${esc(s.section)}</span>
                    <span class="sc-time">${esc(times)}</span>
                  </label>`;
              })
              .join('');
            return `<div class="sec-kind"><span class="sk-label">${esc(KIND_LABEL[kind] || kind)}</span>
                      <div class="sec-chips">${chips}</div></div>`;
          })
          .join('');

        return `<details class="sel-card" style="--accent:${color}">
            <summary>
              <span class="dot"></span>
              <span class="sel-code">${esc(code)}</span>
              <span class="sel-title">${esc(course.title || '')}</span>
              <button class="btn tiny ghost rm" data-remove="${esc(code)}" title="Remove">✕</button>
            </summary>
            <div class="sel-body">${kinds}</div>
          </details>`;
      })
      .join('');
  }

  /* --------------------------------------------------------- constraints */

  function readOptions() {
    const num = (sel) => {
      const v = $(sel).value;
      return v === '' ? null : parseInt(v, 10);
    };
    const lunchRaw = $('#c-lunch').value;
    let lunch = null;
    if (lunchRaw) {
      const [a, b] = lunchRaw.split('-');
      const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
      lunch = [toMin(a), toMin(b)];
    }

    return {
      earliest: num('#c-earliest'),
      latest: num('#c-latest'),
      freeDays: [...document.querySelectorAll('#c-freedays .chip.on')].map((b) => +b.dataset.day),
      lunch,
      maxGap: num('#c-maxgap'),
      maxPerDay: num('#c-maxperday'),
      linked: $('#c-linked').checked,
      skipFull: $('#c-skipfull').checked,
      sort: $('#c-sort').value,
    };
  }

  function resetConstraints() {
    $('#c-earliest').value = '';
    $('#c-latest').value = '';
    $('#c-lunch').value = '';
    $('#c-maxgap').value = '';
    $('#c-maxperday').value = '';
    $('#c-linked').checked = true;
    $('#c-skipfull').checked = false;
    $('#c-sort').value = 'days';
    document.querySelectorAll('#c-freedays .chip.on').forEach((b) => b.classList.remove('on'));
    persist();
  }

  /* --------------------------------------------------------- generate */

  function generate() {
    const statusEl = $('#gen-status');
    if (!state.selected.length) {
      statusEl.innerHTML = '<span class="warn">Pick at least one course first.</span>';
      return;
    }

    const opts = readOptions();
    const courses = state.selected
      .map((code) => Catalog.courses.get(code))
      .filter(Boolean)
      .map((course) => ({
        ...course,
        sections: course.sections.map((s) => ({ ...s, enabled: !isDisabled(course.code, s.section) })),
      }));

    statusEl.innerHTML = '<span class="muted">Working…</span>';

    // Yield once so the "Working…" paint lands before the search blocks the thread.
    setTimeout(() => {
      const t0 = performance.now();
      let res;
      try {
        res = Generator.generate(courses, opts);
      } catch (err) {
        statusEl.innerHTML = `<span class="warn">${esc(err.message)}</span>`;
        return;
      }
      const ms = Math.round(performance.now() - t0);

      state.results = res.timetables;
      state.cursor = 0;

      const bits = [];
      if (res.timetables.length) {
        bits.push(
          `<strong>${res.timetables.length.toLocaleString()}</strong> timetable${res.timetables.length === 1 ? '' : 's'} found <span class="muted">(${ms} ms)</span>`
        );
      } else {
        bits.push(`<span class="warn">${esc(res.error || 'No timetables found.')}</span>`);
      }
      if (res.truncated) {
        bits.push(`<span class="muted">Search capped at ${Generator.MAX_RESULTS.toLocaleString()} results — add constraints to narrow it down.</span>`);
      }
      for (const w of res.warnings) bits.push(`<span class="note">${esc(w)}</span>`);
      statusEl.innerHTML = bits.map((b) => `<div>${b}</div>`).join('');

      showResult();
    }, 20);
  }

  function showResult() {
    const n = state.results.length;
    const tt = n ? state.results[state.cursor] : null;

    $('#btn-prev').disabled = !n || state.cursor === 0;
    $('#btn-next').disabled = !n || state.cursor >= n - 1;
    $('#btn-ics').disabled = !n;
    $('#result-idx').textContent = n ? `${state.cursor + 1} / ${n.toLocaleString()}` : '–';

    const meta = $('#result-meta');
    if (tt) {
      const s = tt.stats;
      const dayNames = s.perDay.map((d) => DAYS[d.day]).join(', ');
      meta.innerHTML =
        `<span class="stat"><b>${s.days}</b> day${s.days === 1 ? '' : 's'} <small>${esc(dayNames)}</small></span>` +
        `<span class="stat"><b>${(s.totalGap / 60).toFixed(1)}h</b> idle between classes</span>` +
        `<span class="stat"><b>${s.earliestStart == null ? '–' : hhmm(s.earliestStart)}</b> earliest start</span>` +
        `<span class="stat"><b>${s.latestEnd == null ? '–' : hhmm(s.latestEnd)}</b> latest finish</span>`;
    } else {
      meta.innerHTML = '';
    }

    Render.renderGrid($('#grid-wrap'), tt, state.courseOrder);
    Render.renderSectionList($('#result-sections'), tt, state.courseOrder);
  }

  /* --------------------------------------------------------- import */

  function doParse() {
    const text = $('#paste-area').value;
    const report = $('#parse-report');
    if (!text.trim()) { report.innerHTML = '<span class="warn">Nothing pasted.</span>'; return; }

    const { courses, notes } = Parser.parsePaste(text);
    if (!courses.length) {
      report.innerHTML = `<span class="warn">${esc(notes[0] || 'Nothing recognised.')}</span>`;
      return;
    }
    Catalog.addCourses(courses, { replace: $('#paste-replace').checked });
    const secCount = courses.reduce((n, c) => n + c.sections.length, 0);
    report.innerHTML =
      `<span class="ok">Imported ${courses.length} course${courses.length === 1 ? '' : 's'}, ${secCount} sections.</span>` +
      `<div class="muted">${courses.map((c) => esc(c.code)).join(', ')}</div>`;
    runSearch();
  }

  function doManual() {
    const { courses, bad } = Parser.parseManual($('#manual-area').value);
    const report = $('#parse-report');
    if (!courses.length) {
      alert('No valid lines. Expected:  COMP 3711 | L1 | Tu, Th 13:30 - 14:50 | Rm 2503');
      return;
    }
    Catalog.addCourses(courses);
    runSearch();
    alert(
      `Added ${courses.length} course(s): ${courses.map((c) => c.code).join(', ')}` +
      (bad.length ? `\n\nSkipped ${bad.length} unparseable line(s).` : '')
    );
    if (report) report.innerHTML = '';
  }

  function doJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const list = Array.isArray(data) ? data : data.courses || [];
        Catalog.addCourses(list);
        runSearch();
        alert(`Imported ${list.length} course(s).`);
      } catch (err) {
        alert(`Could not read that file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  function exportJson() {
    const list = state.selected.map((c) => Catalog.courses.get(c)).filter(Boolean);
    const payload = list.length ? list : [...Catalog.courses.values()];
    Render.download('hkust-courses.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  function exportIcs() {
    const tt = state.results[state.cursor];
    if (!tt) return;
    Render.download(`hkust-timetable-${state.cursor + 1}.ics`, Render.toICS(tt, `Option ${state.cursor + 1}`), 'text/calendar');
  }

  /* --------------------------------------------------------- persistence */

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        selected: state.selected,
        disabled: state.disabled,
        constraints: {
          earliest: $('#c-earliest').value, latest: $('#c-latest').value,
          lunch: $('#c-lunch').value, maxgap: $('#c-maxgap').value,
          maxperday: $('#c-maxperday').value, linked: $('#c-linked').checked,
          skipfull: $('#c-skipfull').checked, sort: $('#c-sort').value,
          freedays: [...document.querySelectorAll('#c-freedays .chip.on')].map((b) => +b.dataset.day),
        },
        theme: document.documentElement.dataset.theme,
      }));
    } catch (_) { /* storage disabled — not fatal */ }
  }

  async function restore() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return; }
    if (!saved) return;

    if (saved.theme) document.documentElement.dataset.theme = saved.theme;

    const c = saved.constraints || {};
    if (c.earliest) $('#c-earliest').value = c.earliest;
    if (c.latest) $('#c-latest').value = c.latest;
    if (c.lunch) $('#c-lunch').value = c.lunch;
    if (c.maxgap) $('#c-maxgap').value = c.maxgap;
    if (c.maxperday) $('#c-maxperday').value = c.maxperday;
    if (c.linked !== undefined) $('#c-linked').checked = c.linked;
    if (c.skipfull !== undefined) $('#c-skipfull').checked = c.skipfull;
    if (c.sort) $('#c-sort').value = c.sort;
    for (const d of c.freedays || []) {
      const chip = document.querySelector(`#c-freedays .chip[data-day="${d}"]`);
      if (chip) chip.classList.add('on');
    }

    state.disabled = saved.disabled || {};
    for (const code of saved.selected || []) {
      try {
        const course = await Catalog.getCourse(code);
        if (course) state.selected.push(code);
      } catch (_) { /* subject file missing — skip */ }
    }
    reorderColors();
    renderSelected();
  }

  /* --------------------------------------------------------- events */

  function wireEvents() {
    $('#search').addEventListener('input', onSearch);

    $('#search-results').addEventListener('click', (e) => {
      const btn = e.target.closest('.sr-item');
      if (btn) addCourse(btn.dataset.code);
    });

    $('#selected-list').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) { e.preventDefault(); removeCourse(rm.dataset.remove); }
    });

    $('#selected-list').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox][data-sec]');
      if (!cb) return;
      toggleSection(cb.dataset.code, cb.dataset.sec);
      cb.closest('.sec-chip').classList.toggle('off', !cb.checked);
    });

    $('#btn-clear-sel').addEventListener('click', () => {
      state.selected = [];
      state.disabled = {};
      state.results = [];
      reorderColors();
      renderSelected();
      runSearch();
      showResult();
      $('#gen-status').innerHTML = '';
      persist();
    });

    $('#btn-generate').addEventListener('click', generate);
    $('#btn-reset-constraints').addEventListener('click', resetConstraints);

    for (const sel of ['#c-earliest', '#c-latest', '#c-lunch', '#c-maxgap', '#c-maxperday', '#c-linked', '#c-skipfull', '#c-sort']) {
      $(sel).addEventListener('change', persist);
    }

    $('#btn-prev').addEventListener('click', () => { if (state.cursor > 0) { state.cursor--; showResult(); } });
    $('#btn-next').addEventListener('click', () => { if (state.cursor < state.results.length - 1) { state.cursor++; showResult(); } });
    $('#btn-ics').addEventListener('click', exportIcs);

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') $('#btn-prev').click();
      if (e.key === 'ArrowRight') $('#btn-next').click();
    });

    // Modals
    $('#btn-import').addEventListener('click', () => $('#modal-import').classList.remove('hidden'));
    $('#btn-help').addEventListener('click', () => $('#modal-help').classList.remove('hidden'));
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-close]') || e.target.classList.contains('modal')) {
        document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.tab-body').forEach((b) =>
          b.classList.toggle('hidden', b.dataset.body !== tab.dataset.tab)
        );
      });
    });

    $('#btn-parse').addEventListener('click', doParse);
    $('#btn-manual').addEventListener('click', doManual);
    $('#btn-export-json').addEventListener('click', exportJson);
    $('#json-file').addEventListener('change', (e) => {
      if (e.target.files[0]) doJsonFile(e.target.files[0]);
    });

    $('#btn-theme').addEventListener('click', () => {
      const el = document.documentElement;
      el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
      persist();
    });
  }

  function flash(msg) {
    const el = $('#gen-status');
    el.innerHTML = `<span class="warn">${esc(msg)}</span>`;
    setTimeout(() => { if (el.textContent === msg) el.innerHTML = ''; }, 4000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
