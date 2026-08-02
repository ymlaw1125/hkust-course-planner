/* UI wiring: search, selection, constraints, generation, results. */
(function (global) {
  'use strict';

  const {
    DAYS, KIND_LABEL, KIND_ORDER, hhmm, Catalog, CommonCore, Ratings, sectionsByKind,
    Generator, Render, Parser,
  } = global.HK;
  const $ = (sel) => document.querySelector(sel);
  const esc = Render.escapeHtml;

  const STORE_KEY = 'hkust-planner-v1';
  const GROUPS_KEY = 'hkust-planner-groups-v1';

  const state = {
    selected: [],         // course codes, in the order added
    disabled: {},         // code -> Set of section codes the user unticked
    pinned: {},           // code -> { KIND: section } forced choices, e.g. pre-enrolled
    preferRated: {},      // code -> true, "weight this course's instructor rating"
    results: [],
    cursor: 0,
    courseOrder: new Map(),
    activeGroup: null,    // id of the group currently loaded, for highlighting
    fill: null,           // full result set of the last "fill a gap" search
  };

  /* --------------------------------------------------------- boot */

  function boot() {
    const idx = Catalog.init();
    CommonCore.init();
    Ratings.init();
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
    initSplitters();
    renderGroups();
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
    unlinkGroup();
    reorderColors();
    renderSelected();
    runSearch();
    persist();
  }

  function removeCourse(code) {
    state.selected = state.selected.filter((c) => c !== code);
    delete state.disabled[code];
    delete state.pinned[code];
    unlinkGroup();
    reorderColors();
    renderSelected();
    runSearch();
    persist();
  }

  /* The selection no longer matches the loaded group, so drop the highlight
     rather than letting it claim otherwise. Section un-ticks don't count —
     they don't change which courses are selected. */
  function unlinkGroup() {
    if (state.activeGroup === null) return;
    state.activeGroup = null;
    renderGroups();
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

  function pinnedOf(code, kind) {
    return (state.pinned[code] && state.pinned[code][kind]) || '';
  }

  /** Is this section usable, given a pin on its kind? */
  function allowedByPin(code, sec) {
    const pin = pinnedOf(code, sec.kind);
    return !pin || pin === sec.section;
  }

  function setPin(code, kind, section) {
    if (!state.pinned[code]) state.pinned[code] = {};
    if (section) {
      state.pinned[code][kind] = section;
      // A pinned section must not also be sitting in the unticked list.
      if (state.disabled[code]) {
        state.disabled[code] = state.disabled[code].filter((s) => s !== section);
      }
    } else {
      delete state.pinned[code][kind];
      if (!Object.keys(state.pinned[code]).length) delete state.pinned[code];
    }
    renderSelected();
    persist();
  }

  /* ------------------------------------------------------ instructor rating */

  /* The lecturer is who students actually mean by "a good prof", so a lecture
     counts double a tutorial or lab (those are often run by TAs). */
  const KIND_WEIGHT = (kind) => (kind === 'LEC' ? 1 : 0.5);

  /** True when a section has nobody assigned yet, as opposed to an unrated one. */
  function isUnassigned(sec) {
    return !Ratings.names(sec.instructors).length;
  }

  /**
   * Badge for a section: its letter grade, or "TBA" when the instructor hasn't
   * been announced. A known instructor who simply has no rating gets nothing —
   * that is a gap in the ratings data, not a fact about the section.
   */
  function gradeBadge(sec) {
    const g = Ratings.gradeOf(sec);
    if (g) {
      const cls = g.replace('+', 'p').replace('-', 'm');
      return `<span class="grade g${esc(cls)}">${esc(g)}</span>`;
    }
    if (isUnassigned(sec)) {
      return '<span class="grade tba" title="Instructor not announced yet">TBA</span>';
    }
    return '';
  }

  /** Courses whose ratings count: the opted-in ones, or all if none opted in. */
  function ratedScope() {
    const chosen = state.selected.filter((c) => state.preferRated[c]);
    return chosen.length ? new Set(chosen) : null; // null = every course
  }

  /**
   * Weighted mean instructor percentile for a timetable, or null when nothing
   * in scope has a rating. Unrated sections are skipped rather than counted as
   * zero — a new lecturer shouldn't be treated as a bad one.
   */
  function timetableRating(tt, scope) {
    let sum = 0;
    let weight = 0;
    for (const e of tt.entries) {
      if (scope && !scope.has(e.course.code)) continue;
      const p = Ratings.percentileOf(e.section);
      if (p == null) continue;
      const w = KIND_WEIGHT(e.section.kind);
      sum += p * w;
      weight += w;
    }
    return weight ? sum / weight : null;
  }

  function updateRatingNote() {
    const note = $('#rating-note');
    if (!Ratings.ready) {
      note.hidden = $('#c-sort').value !== 'rating';
      if (!note.hidden) {
        note.innerHTML = '<span class="warn">No ratings data — run <code>node scripts/scrape-ratings.mjs</code>.</span>';
      }
      return;
    }
    const chosen = state.selected.filter((c) => state.preferRated[c]);
    note.hidden = $('#c-sort').value !== 'rating';
    if (note.hidden) return;
    note.innerHTML = chosen.length
      ? `Ranking on <strong>${esc(chosen.join(', '))}</strong> only. Star other courses to include them.`
      : 'Ranking on <strong>every course</strong>. Star specific courses to weigh only those.';
  }

  /** Has this course been customised away from its defaults? */
  function isCustomised(code) {
    return pinsFor(code).length > 0 || !!(state.disabled[code] && state.disabled[code].length);
  }

  /** Back to defaults: every section on, every kind set to "Any". */
  function resetCourse(code) {
    delete state.pinned[code];
    delete state.disabled[code];
    renderSelected();
    persist();
  }

  function resetAllCourses() {
    const n = state.selected.filter(isCustomised).length;
    if (!n) return;
    if (n > 1 && !confirm(`Reset ${n} courses back to Any, unlocking sections and re-ticking everything?`)) return;
    for (const code of state.selected) {
      delete state.pinned[code];
      delete state.disabled[code];
    }
    renderSelected();
    persist();
  }

  /** Pinned sections for a course, in the usual lecture-then-tutorial order. */
  function pinsFor(code) {
    const rank = (k) => {
      const i = KIND_ORDER.indexOf(k);
      return i < 0 ? KIND_ORDER.length : i;
    };
    return Object.entries(state.pinned[code] || {})
      .filter(([, v]) => v)
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([, v]) => v);
  }

  function renderSelected() {
    const box = $('#selected-list');
    $('#sel-count').textContent = state.selected.length;

    // Pinning re-renders this list; don't collapse the card being edited.
    const wasOpen = new Set(
      [...box.querySelectorAll('.sel-card[open] .sel-code')].map((e) => e.textContent)
    );
    const scrollTop = box.closest('.vpane') ? box.closest('.vpane').scrollTop : 0;

    if (!state.selected.length) {
      box.innerHTML = '<p class="empty">No courses selected yet. Search above and click a course to add it.</p>';
      $('#btn-reset-sel').hidden = true;
      return;
    }

    box.innerHTML = state.selected
      .map((code) => {
        const course = Catalog.courses.get(code);
        if (!course) return '';
        const color = Render.colorFor(code, state.courseOrder.get(code) ?? 0);

        const kinds = sectionsByKind(course)
          .map(([kind, secs]) => {
            const label = KIND_LABEL[kind] || kind;
            const pin = pinnedOf(code, kind);
            const timesOf = (s) => (s.meetings.length
              ? s.meetings.map((m) => `${DAYS[m.day]} ${hhmm(m.start)}`).join(' · ')
              : 'TBA');

            // Names are "SURNAME, Given" and co-taught sections are joined by
            // ";", so only the semicolon separates people.
            const whoOf = (s) => {
              const people = Ratings.names(s.instructors);
              if (!people.length) return ' — TBA';
              const g = Ratings.gradeOf(s);
              return ` — ${people.join(', ')}${g ? ` (${g})` : ''}`;
            };

            const picker = `<select class="sk-pick" data-code="${esc(code)}" data-kind="${esc(kind)}"
                              title="Pin a specific ${esc(label.toLowerCase())}, e.g. one you're already enrolled in">
                <option value="">Any (${secs.length})</option>
                ${secs.map((s) =>
                  `<option value="${esc(s.section)}"${pin === s.section ? ' selected' : ''}>${esc(s.section)} · ${esc(timesOf(s))}${esc(whoOf(s))}</option>`
                ).join('')}
              </select>`;

            // With a kind pinned, its exclusion chips would be redundant, so
            // show what was pinned instead of a row of dead checkboxes.
            let body;
            if (pin) {
              const s = secs.find((x) => x.section === pin);
              body = `<div class="sk-pinned">
                  Locked to <strong>${esc(pin)}</strong>
                  ${s ? `<span class="sk-when">${esc(timesOf(s))}${s.rooms && s.rooms[0] ? ` · ${esc(s.rooms[0])}` : ''}</span>` : `<span class="warn">— not offered this term</span>`}
                </div>`;
            } else {
              body = `<div class="sec-chips">${secs.map((s) => {
                const off = isDisabled(code, s.section);
                const full = s.avail != null && s.avail <= 0;
                const g = Ratings.gradeOf(s);
                const who = isUnassigned(s) ? 'Instructor TBA' : s.instructors;
                return `<label class="sec-chip${off ? ' off' : ''}${full ? ' full' : ''}"
                          title="${esc(s.rooms[0] || '')}${who ? `\n${esc(who)}` : ''}${g ? `\nRated ${esc(g)}` : ''}${s.avail != null ? `\n${s.avail} seats left` : ''}">
                    <input type="checkbox" data-code="${esc(code)}" data-sec="${esc(s.section)}" ${off ? '' : 'checked'}>
                    <span class="sc-name">${esc(s.section)}</span>
                    <span class="sc-time">${esc(timesOf(s))}</span>
                    ${gradeBadge(s)}
                  </label>`;
              }).join('')}</div>`;
            }

            return `<div class="sec-kind">
                <div class="sk-head"><span class="sk-label">${esc(label)}</span>${picker}</div>
                ${body}
              </div>`;
          })
          .join('');

        const pins = pinsFor(code);
        const badge = pins.length
          ? `<span class="pin-badge" title="Locked sections">${pins.map(esc).join(' ')}</span>`
          : '';

        const starred = !!state.preferRated[code];
        const star = Ratings.ready
          ? `<button class="btn tiny ghost star${starred ? ' on' : ''}" data-star="${esc(code)}"
               title="${starred ? 'Included in' : 'Weigh only this course for'} the best-rated-professors sort">★</button>`
          : '';

        // Only offer a reset where there is something to undo.
        const reset = isCustomised(code)
          ? `<button class="btn tiny ghost rst" data-reset="${esc(code)}"
               title="Reset ${esc(code)} — unlock every section and re-tick them all">↺</button>`
          : '';

        return `<details class="sel-card" style="--accent:${color}"${wasOpen.has(code) ? ' open' : ''}>
            <summary>
              <span class="dot"></span>
              <span class="sel-code">${esc(code)}</span>
              <span class="sel-title">${esc(course.title || '')}</span>
              ${badge}
              ${star}
              ${reset}
              <button class="btn tiny ghost rm" data-remove="${esc(code)}" title="Remove">✕</button>
            </summary>
            <div class="sel-body">${kinds}</div>
          </details>`;
      })
      .join('');

    $('#btn-reset-sel').hidden = !state.selected.some(isCustomised);

    const pane = box.closest('.vpane');
    if (pane) pane.scrollTop = scrollTop;
  }

  /* --------------------------------------------------------- saved groups */

  function loadGroups() {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); } catch (_) { return []; }
  }

  function storeGroups(groups) {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); } catch (_) { /* storage disabled */ }
  }

  function groupMsg(html, cls = 'muted') {
    $('#group-msg').innerHTML = html ? `<span class="${cls}">${html}</span>` : '';
  }

  function renderGroups() {
    const groups = loadGroups();
    const box = $('#group-list');

    if (!groups.length) {
      box.innerHTML = '<p class="empty">Nothing saved yet. Pick your courses, type a name above and hit Save.</p>';
      return;
    }

    box.innerHTML = groups
      .map((g) => {
        const preview = g.codes.slice(0, 3).join(', ') + (g.codes.length > 3 ? ` +${g.codes.length - 3}` : '');
        const tweaked = Object.values(g.disabled || {}).reduce((n, l) => n + l.length, 0);
        return `<div class="grp${g.id === state.activeGroup ? ' active' : ''}">
            <button class="grp-load" data-load="${esc(g.id)}" title="Load these ${g.codes.length} courses">
              <span class="grp-name">${esc(g.name)}</span>
              <span class="grp-meta">${g.codes.length} course${g.codes.length === 1 ? '' : 's'} · ${esc(preview)}${tweaked ? ` · ${tweaked} section${tweaked === 1 ? '' : 's'} off` : ''}</span>
            </button>
            <button class="btn tiny ghost grp-del" data-del="${esc(g.id)}" title="Delete">✕</button>
          </div>`;
      })
      .join('');
  }

  function saveCurrentAsGroup() {
    const input = $('#group-name');
    const name = input.value.trim();

    if (!state.selected.length) {
      groupMsg('Select some courses first — there is nothing to save.', 'warn');
      return;
    }
    if (!name) {
      groupMsg('Give the group a name.', 'warn');
      input.focus();
      return;
    }

    const groups = loadGroups();
    const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`"${existing.name}" already exists. Overwrite it?`)) return;

    // Keep only the un-ticks and pins that belong to the courses being saved.
    const disabled = {};
    const pinned = {};
    for (const code of state.selected) {
      if (state.disabled[code] && state.disabled[code].length) {
        disabled[code] = state.disabled[code].slice();
      }
      if (state.pinned[code] && Object.keys(state.pinned[code]).length) {
        pinned[code] = { ...state.pinned[code] };
      }
    }

    const group = {
      id: existing ? existing.id : `g${Date.now().toString(36)}`,
      name,
      codes: state.selected.slice(),
      disabled,
      pinned,
      saved: new Date().toISOString(),
    };

    if (existing) groups[groups.indexOf(existing)] = group;
    else groups.unshift(group);

    storeGroups(groups);
    state.activeGroup = group.id;
    input.value = '';
    renderGroups();
    groupMsg(`Saved "${esc(group.name)}" — ${group.codes.length} course${group.codes.length === 1 ? '' : 's'}.`, 'ok');
  }

  async function applyGroup(id) {
    const group = loadGroups().find((g) => g.id === id);
    if (!group) return;

    if (state.selected.length && !confirm(`Replace your current ${state.selected.length} selected course(s) with "${group.name}"?`)) {
      return;
    }

    groupMsg(`Loading "${esc(group.name)}"…`);

    // A saved group can outlive a catalog refresh, so tolerate missing courses.
    const found = [];
    const missing = [];
    for (const code of group.codes) {
      let course = null;
      try { course = await Catalog.getCourse(code); } catch (_) { course = null; }
      if (course) found.push(code);
      else missing.push(code);
    }

    state.selected = found;
    state.disabled = {};
    state.pinned = {};
    for (const code of found) {
      if (group.disabled && group.disabled[code]) state.disabled[code] = group.disabled[code].slice();
      if (group.pinned && group.pinned[code]) state.pinned[code] = { ...group.pinned[code] };
    }
    state.activeGroup = group.id;
    state.results = [];
    state.cursor = 0;

    reorderColors();
    renderSelected();
    renderGroups();
    runSearch();
    showResult();
    $('#gen-status').innerHTML = '';
    persist();

    if (missing.length) {
      groupMsg(
        `Loaded ${found.length} of ${group.codes.length}. Not offered this term: ${esc(missing.join(', '))}.`,
        'warn'
      );
    } else {
      groupMsg(`Loaded "${esc(group.name)}". Hit Generate.`, 'ok');
    }
  }

  function deleteGroup(id) {
    const groups = loadGroups();
    const g = groups.find((x) => x.id === id);
    if (!g || !confirm(`Delete the group "${g.name}"?`)) return;
    storeGroups(groups.filter((x) => x.id !== id));
    if (state.activeGroup === id) state.activeGroup = null;
    renderGroups();
    groupMsg(`Deleted "${esc(g.name)}".`);
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
      minFreeDays: num('#c-minfree'),
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
    $('#c-minfree').value = '';
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
        sections: course.sections.map((s) => ({
          ...s,
          enabled: !isDisabled(course.code, s.section) && allowedByPin(course.code, s),
        })),
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

      // The generator knows nothing about ratings, so rank here. Unrated
      // timetables sort last rather than being dropped.
      if (opts.sort === 'rating' && Ratings.ready) {
        const scope = ratedScope();
        for (const tt of res.timetables) tt.rating = timetableRating(tt, scope);
        res.timetables.sort((a, b) => (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating));
      }

      state.results = res.timetables;
      state.cursor = 0;

      const bits = [];
      if (res.timetables.length) {
        bits.push(
          `<strong>${res.timetables.length.toLocaleString()}</strong> timetable${res.timetables.length === 1 ? '' : 's'} found <span class="muted">(${ms} ms)</span>`
        );
      } else {
        bits.push(`<span class="warn">${esc(res.error || 'No timetables found.')}</span>`);
        // A locked section is the likeliest culprit, and the generator can't
        // know about it — it only sees the sections we handed it.
        const locked = state.selected
          .filter((c) => pinsFor(c).length)
          .map((c) => `${c} ${pinsFor(c).join('+')}`);
        if (locked.length) {
          bits.push(
            `<span class="note">You've locked ${esc(locked.join(', '))}. ` +
            `If a locked lecture and tutorial belong to different groups they can't be taken together — set one back to “Any”.</span>`
          );
        }
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
    $('#btn-fill').disabled = !n;
    $('#result-idx').textContent = n ? `${state.cursor + 1} / ${n.toLocaleString()}` : '–';

    const meta = $('#result-meta');
    if (tt) {
      const s = tt.stats;
      const dayNames = s.perDay.map((d) => DAYS[d.day]).join(', ');
      const used = new Set(s.perDay.map((d) => d.day));
      const offNames = [0, 1, 2, 3, 4].filter((d) => !used.has(d)).map((d) => DAYS[d]);
      meta.innerHTML =
        `<span class="stat"><b>${s.days}</b> day${s.days === 1 ? '' : 's'} <small>${esc(dayNames)}</small></span>` +
        `<span class="stat"><b>${s.freeWeekdays}</b> day${s.freeWeekdays === 1 ? '' : 's'} off <small>${esc(offNames.join(', ') || '—')}</small></span>` +
        `<span class="stat"><b>${(s.totalGap / 60).toFixed(1)}h</b> idle between classes</span>` +
        `<span class="stat"><b>${s.earliestStart == null ? '–' : hhmm(s.earliestStart)}</b> earliest start</span>` +
        `<span class="stat"><b>${s.latestEnd == null ? '–' : hhmm(s.latestEnd)}</b> latest finish</span>` +
        (() => {
          if (!Ratings.ready) return '';
          const p = timetableRating(tt, ratedScope());
          if (p == null) return '';
          const scoped = state.selected.filter((c) => state.preferRated[c]).length;
          return `<span class="stat"><b>${esc(Ratings.letter(p))}</b> avg instructor ` +
                 `<small>${scoped ? `${scoped} starred course${scoped === 1 ? '' : 's'}` : 'all courses'}</small></span>`;
        })();
    } else {
      meta.innerHTML = '';
    }

    Render.renderGrid($('#grid-wrap'), tt, state.courseOrder);
    Render.renderSectionList($('#result-sections'), tt, state.courseOrder);
  }

  /* --------------------------------------------------------- resizable panes */

  const LAYOUT_DEFAULT = { '--col-1': 340, '--col-2': 260, '--row-1': 300, '--row-2': 260 };
  const LAYOUT_MIN = { '--col-1': 230, '--col-2': 200, '--row-1': 100, '--row-2': 100 };
  const SPLITTER_PX = 14;   // column gutter track
  const ROW_SPLIT_PX = 12;  // row gutter track
  const LAST_COL_MIN = 300; // the results panel must stay usable
  const LAST_ROW_MIN = 100;

  const layoutHost = (v) => (v.startsWith('--col') ? $('.layout') : $('.panel-left'));

  function trackPx(v) {
    const raw = getComputedStyle(layoutHost(v)).getPropertyValue(v);
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : LAYOUT_DEFAULT[v];
  }

  /** Keep a track within its own minimum and whatever the last track needs. */
  function clampTrack(v, px) {
    const isCol = v.startsWith('--col');
    const host = layoutHost(v);
    const other = isCol
      ? trackPx(v === '--col-1' ? '--col-2' : '--col-1')
      : trackPx(v === '--row-1' ? '--row-2' : '--row-1');

    let avail;
    if (isCol) {
      const cs = getComputedStyle(host);
      avail = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - SPLITTER_PX * 2;
    } else {
      avail = host.clientHeight - ROW_SPLIT_PX * 2;
    }

    const min = LAYOUT_MIN[v];
    const max = Math.max(min, avail - other - (isCol ? LAST_COL_MIN : LAST_ROW_MIN));
    return Math.round(Math.min(Math.max(px, min), max));
  }

  function setTrack(v, px) {
    layoutHost(v).style.setProperty(v, `${clampTrack(v, px)}px`);
  }

  function readLayout() {
    const out = {};
    for (const v of Object.keys(LAYOUT_DEFAULT)) out[v] = Math.round(trackPx(v));
    return out;
  }

  function applyLayout(saved) {
    if (!saved) return;
    for (const [v, px] of Object.entries(saved)) {
      if (LAYOUT_DEFAULT[v] == null || !Number.isFinite(px)) continue;
      layoutHost(v).style.setProperty(v, `${px}px`);
    }
    // A window narrower than last session could leave a track oversized.
    for (const v of Object.keys(LAYOUT_DEFAULT)) setTrack(v, trackPx(v));
  }

  function initSplitters() {
    for (const el of document.querySelectorAll('.splitter')) {
      const v = el.dataset.var;
      const axis = el.dataset.axis;

      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        document.body.classList.add('resizing', axis);

        const startPos = axis === 'x' ? e.clientX : e.clientY;
        const startPx = trackPx(v);

        const move = (ev) => {
          const now = axis === 'x' ? ev.clientX : ev.clientY;
          setTrack(v, startPx + (now - startPos));
        };
        const done = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', done);
          el.removeEventListener('pointercancel', done);
          el.classList.remove('dragging');
          document.body.classList.remove('resizing', 'x', 'y');
          persist();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', done);
        el.addEventListener('pointercancel', done);
      });

      el.addEventListener('dblclick', () => {
        layoutHost(v).style.setProperty(v, `${LAYOUT_DEFAULT[v]}px`);
        setTrack(v, LAYOUT_DEFAULT[v]);
        persist();
      });

      el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 12;
        const map = axis === 'x'
          ? { ArrowLeft: -step, ArrowRight: step }
          : { ArrowUp: -step, ArrowDown: step };
        const d = map[e.key];
        if (d == null) return;
        e.preventDefault();
        setTrack(v, trackPx(v) + d);
        persist();
      });
    }

    // Shrinking the window must not strand a track wider than the viewport.
    let raf = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const v of Object.keys(LAYOUT_DEFAULT)) setTrack(v, trackPx(v));
      });
    });
  }

  /* --------------------------------------------------------- fill a gap */

  function currentYear() {
    return parseInt($('#fill-year').value, 10) || 1;
  }

  function refreshFillGroups() {
    const sel = $('#fill-group');
    const keep = sel.value;
    const cohortNote = $('#fill-cohort');

    if (!CommonCore.ready) {
      sel.innerHTML = '<option value="*">Any course in the catalog</option>';
      cohortNote.innerHTML =
        '<span class="warn">No Common Core data found — run <code>node scripts/scrape.mjs</code> to add it.</span>';
      return;
    }

    const cohort = CommonCore.cohortFor(currentYear());
    const groups = CommonCore.groupsFor(cohort);
    const withCourses = groups.filter((g) => g.courses.length);

    cohortNote.innerHTML =
      `Year ${currentYear()} → admitted ${CommonCore.admissionYear(currentYear())} → ` +
      `<strong>${esc(CommonCore.cohortLabel(cohort))}</strong>` +
      `<small>${withCourses.length} of ${groups.length} groups have courses this term</small>`;

    sel.innerHTML =
      '<option value="*">Any course in the catalog</option>' +
      withCourses
        .map((g) => `<option value="${esc(g.id)}">Common Core (${esc(g.area)}) — ${g.courses.length}</option>`)
        .join('') +
      groups
        .filter((g) => !g.courses.length)
        .map((g) => `<option value="${esc(g.id)}" disabled>Common Core (${esc(g.area)}) — none this term</option>`)
        .join('');

    if ([...sel.options].some((o) => o.value === keep && !o.disabled)) sel.value = keep;
  }

  function openFill() {
    const tt = state.results[state.cursor];
    if (!tt) return;
    refreshFillGroups();
    state.fill = null;
    $('#fill-results').innerHTML = '';
    $('#fill-status').innerHTML =
      `<span class="muted">Searching against timetable ${state.cursor + 1} of ${state.results.length.toLocaleString()}.</span>`;
    $('#modal-fill').classList.remove('hidden');
  }

  async function runFill() {
    try {
      await runFillInner();
    } catch (err) {
      $('#fill-status').innerHTML =
        `<span class="warn">Search failed: ${esc(err.message)}</span>`;
      console.error('[fill]', err);
    }
  }

  async function runFillInner() {
    const tt = state.results[state.cursor];
    if (!tt) return;

    const groupId = $('#fill-group').value;
    const status = $('#fill-status');
    const box = $('#fill-results');
    state.fill = null;
    box.innerHTML = '';

    let candidateCodes;
    if (groupId === '*') {
      status.innerHTML = '<span class="muted">Loading the full catalog…</span>';
      await new Promise((r) => setTimeout(r, 20));
      await Catalog.loadAll((done, total) => {
        if (done % 12 === 0 || done === total) {
          status.innerHTML = `<span class="muted">Loading the full catalog… ${done}/${total}</span>`;
        }
      });
      candidateCodes = Catalog.index.courses.map((e) => e.c);
    } else {
      const group = CommonCore.group(groupId);
      if (!group) return;
      candidateCodes = group.courses;
    }

    // Never suggest something already on the timetable.
    const already = new Set(state.selected);
    candidateCodes = candidateCodes.filter((c) => !already.has(c));

    status.innerHTML = '<span class="muted">Loading course data…</span>';
    await new Promise((r) => setTimeout(r, 20));
    const courses = await Catalog.getCourses(candidateCodes);

    status.innerHTML = '<span class="muted">Checking which ones fit…</span>';
    await new Promise((r) => setTimeout(r, 20));
    const opts = readOptions();
    const t0 = performance.now();
    const { matches, total } = Generator.findAdditions(courses, tt, opts);
    const ms = Math.round(performance.now() - t0);

    const scope = groupId === '*'
      ? 'the whole catalog'
      : `Common Core (${CommonCore.group(groupId).area})`;

    if (!matches.length) {
      state.fill = null;
      status.innerHTML =
        `<span class="warn">Nothing in ${esc(scope)} fits this timetable without a clash.</span>` +
        `<div class="muted">Checked ${courses.length} course${courses.length === 1 ? '' : 's'}. Try another group, a different timetable variant, or loosen a constraint.</div>`;
      return;
    }

    // Hold the full set so the search box can reach every match, not just the
    // ones that happened to be rendered.
    state.fill = { matches, total, scope, checked: courses.length, ms };
    renderFillList();
  }

  const FILL_RENDER_CAP = 300;

  function fillQuery() {
    return $('#fill-search').value.trim().toLowerCase();
  }

  function renderFillList() {
    const f = state.fill;
    if (!f) return;
    const status = $('#fill-status');
    const box = $('#fill-results');
    const q = fillQuery();

    let shown = f.matches;
    if (q) {
      // "comp2011" should find "COMP 2011", so compare codes without spaces.
      const bare = q.replace(/\s+/g, '');
      shown = f.matches.filter(
        (m) =>
          m.course.code.toLowerCase().replace(/\s+/g, '').includes(bare) ||
          (m.course.title || '').toLowerCase().includes(q)
      );
    }

    const head =
      `<span class="ok">${f.total} of ${f.checked} course${f.checked === 1 ? '' : 's'} in ${esc(f.scope)} fit.</span>` +
      `<span class="muted"> (${f.ms} ms)</span>`;

    if (q && !shown.length) {
      status.innerHTML = `${head}<div class="warn">None of them match “${esc(q)}”.</div>`;
      box.innerHTML = '';
      return;
    }

    const capped = shown.slice(0, FILL_RENDER_CAP);
    const note = q
      ? `<div class="muted">${shown.length} match${shown.length === 1 ? '' : 'es'} “${esc(q)}”${shown.length > capped.length ? `, showing ${capped.length}` : ''}.</div>`
      : shown.length > capped.length
        ? `<div class="muted">Showing the first ${capped.length} — use the search box to narrow it down.</div>`
        : '';

    status.innerHTML = head + note;
    box.innerHTML = capped.map(renderFillCard).join('');
  }

  function renderFillCard(m) {
    const { course, best, fits } = m;
    const when = best.tba
      ? 'No fixed meeting time (TBA)'
      : best.meetings
          .slice()
          .sort((a, b) => a.day - b.day || a.start - b.start)
          .map((x) => `${DAYS[x.day]} ${hhmm(x.start)}–${hhmm(x.end)}`)
          .join(' · ');

    const secs = best.sections
      .map((s) => `<span class="fc-sec">${esc(s.section)}<small>${esc(KIND_LABEL[s.kind] || s.kind)}</small></span>`)
      .join('');

    const badge = best.tba
      ? '<span class="fc-badge tba">TBA</span>'
      : best.newDays > 0
        ? `<span class="fc-badge new">+${best.newDays} new day${best.newDays === 1 ? '' : 's'}</span>`
        : '<span class="fc-badge ok">fits your existing days</span>';

    const n = m.fitCount != null ? m.fitCount : fits.length;
    const alts = n > 1 ? `<span class="fc-alts">${n} section combos fit</span>` : '';

    return `<div class="fc">
        <div class="fc-main">
          <div class="fc-top">
            <strong>${esc(course.code)}</strong>
            <span class="fc-title">${esc(course.title || '')}</span>
            ${course.credits ? `<span class="pill">${course.credits}u</span>` : ''}
            ${badge}
          </div>
          <div class="fc-when">${esc(when)}</div>
          <div class="fc-secs">${secs}${alts}</div>
        </div>
        <button class="btn small primary fc-add" data-add="${esc(course.code)}">Add</button>
      </div>`;
  }

  async function addFromFill(code) {
    const before = state.results[state.cursor];
    // Remember exactly what was on screen so we can return to it afterwards.
    const priorSections = before
      ? before.entries.map((e) => `${e.course.code}|${e.section.section}`).sort().join(',')
      : null;

    await addCourse(code);
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));

    generate();

    // generate() defers its work, so wait for the results before re-anchoring.
    setTimeout(() => {
      if (!priorSections || !state.results.length) return;
      const idx = state.results.findIndex((tt) => {
        const set = new Set(tt.entries.map((e) => `${e.course.code}|${e.section.section}`));
        return priorSections.split(',').every((k) => set.has(k));
      });
      if (idx >= 0) {
        state.cursor = idx;
        showResult();
        $('#gen-status').insertAdjacentHTML(
          'beforeend',
          `<div><span class="ok">Added ${esc(code)} — showing your previous timetable with it slotted in.</span></div>`
        );
      } else {
        $('#gen-status').insertAdjacentHTML(
          'beforeend',
          `<div><span class="note">Added ${esc(code)}, but your previous arrangement isn't in the first ${state.results.length.toLocaleString()} results — showing the best match instead.</span></div>`
        );
      }
    }, 240);
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
        pinned: state.pinned,
        preferRated: state.preferRated,
        constraints: {
          earliest: $('#c-earliest').value, latest: $('#c-latest').value,
          minfree: $('#c-minfree').value,
          lunch: $('#c-lunch').value, maxgap: $('#c-maxgap').value,
          maxperday: $('#c-maxperday').value, linked: $('#c-linked').checked,
          skipfull: $('#c-skipfull').checked, sort: $('#c-sort').value,
          freedays: [...document.querySelectorAll('#c-freedays .chip.on')].map((b) => +b.dataset.day),
        },
        theme: document.documentElement.dataset.theme,
        year: $('#fill-year').value,
        layout: readLayout(),
      }));
    } catch (_) { /* storage disabled — not fatal */ }
  }

  async function restore() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return; }
    if (!saved) return;

    if (saved.theme) document.documentElement.dataset.theme = saved.theme;
    if (saved.year) $('#fill-year').value = saved.year;
    applyLayout(saved.layout);

    const c = saved.constraints || {};
    if (c.earliest) $('#c-earliest').value = c.earliest;
    if (c.latest) $('#c-latest').value = c.latest;
    if (c.minfree) $('#c-minfree').value = c.minfree;
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
    state.pinned = saved.pinned || {};
    state.preferRated = saved.preferRated || {};
    for (const code of saved.selected || []) {
      try {
        const course = await Catalog.getCourse(code);
        if (course) state.selected.push(code);
      } catch (_) { /* subject file missing — skip */ }
    }
    reorderColors();
    renderSelected();
    // Needs both the restored sort and the restored selection to be in place.
    updateRatingNote();
  }

  /* --------------------------------------------------------- events */

  function wireEvents() {
    $('#search').addEventListener('input', onSearch);

    $('#search-results').addEventListener('click', (e) => {
      const btn = e.target.closest('.sr-item');
      if (btn) addCourse(btn.dataset.code);
    });

    $('#selected-list').addEventListener('click', (e) => {
      // These live inside <summary>, so stop the click toggling the card.
      const st = e.target.closest('[data-star]');
      if (st) {
        e.preventDefault();
        const code = st.dataset.star;
        if (state.preferRated[code]) delete state.preferRated[code];
        else state.preferRated[code] = true;
        renderSelected();
        updateRatingNote();
        persist();
        return;
      }
      const rs = e.target.closest('[data-reset]');
      if (rs) { e.preventDefault(); resetCourse(rs.dataset.reset); return; }
      const rm = e.target.closest('[data-remove]');
      if (rm) { e.preventDefault(); removeCourse(rm.dataset.remove); }
    });

    $('#btn-reset-sel').addEventListener('click', resetAllCourses);

    $('#selected-list').addEventListener('change', (e) => {
      const pick = e.target.closest('.sk-pick');
      if (pick) { setPin(pick.dataset.code, pick.dataset.kind, pick.value); return; }

      const cb = e.target.closest('input[type=checkbox][data-sec]');
      if (!cb) return;
      toggleSection(cb.dataset.code, cb.dataset.sec);
      cb.closest('.sec-chip').classList.toggle('off', !cb.checked);
    });

    $('#btn-clear-sel').addEventListener('click', () => {
      state.selected = [];
      state.disabled = {};
      state.pinned = {};
      state.results = [];
      unlinkGroup();
      groupMsg('');
      reorderColors();
      renderSelected();
      runSearch();
      showResult();
      $('#gen-status').innerHTML = '';
      persist();
    });

    $('#btn-save-group').addEventListener('click', saveCurrentAsGroup);
    $('#group-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveCurrentAsGroup(); }
    });
    $('#group-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteGroup(del.dataset.del); return; }
      const load = e.target.closest('[data-load]');
      if (load) applyGroup(load.dataset.load);
    });

    $('#btn-generate').addEventListener('click', generate);
    $('#btn-reset-constraints').addEventListener('click', resetConstraints);

    for (const sel of ['#c-earliest', '#c-latest', '#c-minfree', '#c-lunch', '#c-maxgap', '#c-maxperday', '#c-linked', '#c-skipfull', '#c-sort']) {
      $(sel).addEventListener('change', persist);
    }
    $('#c-sort').addEventListener('change', updateRatingNote);

    $('#btn-prev').addEventListener('click', () => { if (state.cursor > 0) { state.cursor--; showResult(); } });
    $('#btn-next').addEventListener('click', () => { if (state.cursor < state.results.length - 1) { state.cursor++; showResult(); } });
    $('#btn-ics').addEventListener('click', exportIcs);
    $('#btn-fill').addEventListener('click', openFill);
    $('#btn-find-fill').addEventListener('click', runFill);
    $('#fill-search').addEventListener('input', renderFillList);
    $('#fill-search').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fillQuery()) {
        e.stopPropagation();           // don't let it close the modal too
        $('#fill-search').value = '';
        renderFillList();
      }
    });
    $('#fill-year').addEventListener('change', () => { refreshFillGroups(); persist(); });
    $('#fill-results').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) addFromFill(add.dataset.add);
    });

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
