/* Weekly grid rendering + calendar export. */
(function (global) {
  'use strict';

  const { DAYS, KIND_LABEL, hhmm } = global.HK;

  const VISIBLE_DAYS = 5;      // Mon–Fri; extended automatically if a class falls on Sat/Sun
  const DEFAULT_START = 9 * 60;
  const DEFAULT_END = 18 * 60;
  const PX_PER_MIN = 1.05;

  // Term start used for .ics export (first day of 2026-27 Fall teaching).
  const TERM_START = '2026-09-01';
  const TERM_WEEKS = 14;

  const PALETTE = [
    '--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--c9', '--c10',
  ];

  function colorFor(code, order) {
    return `var(${PALETTE[order % PALETTE.length]})`;
  }

  /** Lay out overlapping meetings side by side (shouldn't happen, but be safe). */
  function assignColumns(list) {
    const sorted = list.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const cols = [];
    for (const m of sorted) {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] <= m.start) { m._col = i; cols[i] = m.end; placed = true; break; }
      }
      if (!placed) { m._col = cols.length; cols.push(m.end); }
    }
    const total = Math.max(1, cols.length);
    for (const m of sorted) m._cols = total;
    return sorted;
  }

  function renderGrid(container, timetable, courseOrder) {
    container.innerHTML = '';
    if (!timetable) {
      container.innerHTML = '<p class="empty big">Your generated timetables will appear here.</p>';
      return;
    }

    const meetings = timetable.meetings;
    let startMin = DEFAULT_START;
    let endMin = DEFAULT_END;
    let dayCount = VISIBLE_DAYS;
    for (const m of meetings) {
      startMin = Math.min(startMin, Math.floor(m.start / 60) * 60);
      endMin = Math.max(endMin, Math.ceil(m.end / 60) * 60);
      dayCount = Math.max(dayCount, m.day + 1);
    }

    const height = (endMin - startMin) * PX_PER_MIN;

    const grid = document.createElement('div');
    grid.className = 'tt';
    grid.style.setProperty('--daycount', dayCount);

    // Header row
    const corner = document.createElement('div');
    corner.className = 'tt-corner';
    grid.appendChild(corner);
    for (let d = 0; d < dayCount; d++) {
      const h = document.createElement('div');
      h.className = 'tt-dayhead';
      h.textContent = DAYS[d];
      grid.appendChild(h);
    }

    // Time gutter
    const gutter = document.createElement('div');
    gutter.className = 'tt-gutter';
    gutter.style.height = `${height}px`;
    for (let t = startMin; t < endMin; t += 60) {
      const lbl = document.createElement('div');
      lbl.className = 'tt-hour';
      lbl.style.top = `${(t - startMin) * PX_PER_MIN}px`;
      lbl.textContent = hhmm(t);
      gutter.appendChild(lbl);
    }
    grid.appendChild(gutter);

    // Day columns
    const byDay = new Map();
    for (const m of meetings) {
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day).push(m);
    }

    for (let d = 0; d < dayCount; d++) {
      const col = document.createElement('div');
      col.className = 'tt-col';
      col.style.height = `${height}px`;

      for (let t = startMin; t < endMin; t += 60) {
        const line = document.createElement('div');
        line.className = 'tt-line';
        line.style.top = `${(t - startMin) * PX_PER_MIN}px`;
        col.appendChild(line);
      }

      for (const m of assignColumns(byDay.get(d) || [])) {
        const el = document.createElement('div');
        el.className = 'tt-block';
        const order = courseOrder.get(m.course.code) ?? 0;
        el.style.background = colorFor(m.course.code, order);
        el.style.top = `${(m.start - startMin) * PX_PER_MIN}px`;
        el.style.height = `${Math.max(22, (m.end - m.start) * PX_PER_MIN - 3)}px`;
        el.style.left = `calc(${(m._col / m._cols) * 100}% + 2px)`;
        el.style.width = `calc(${100 / m._cols}% - 5px)`;

        const room = m.section.rooms[0] || '';
        el.innerHTML =
          `<span class="b-code">${escapeHtml(m.course.code)}</span>` +
          `<span class="b-sec">${escapeHtml(m.section.section)}</span>` +
          `<span class="b-time">${hhmm(m.start)}–${hhmm(m.end)}</span>` +
          (room ? `<span class="b-room">${escapeHtml(room)}</span>` : '');
        el.title =
          `${m.course.code} ${m.course.title}\n${m.section.section} · ${KIND_LABEL[m.section.kind] || m.section.kind}\n` +
          `${DAYS[m.day]} ${hhmm(m.start)}–${hhmm(m.end)}\n${room}` +
          (m.section.instructors ? `\n${m.section.instructors}` : '');
        col.appendChild(el);
      }
      grid.appendChild(col);
    }

    container.appendChild(grid);
  }

  function renderSectionList(container, timetable, courseOrder) {
    container.innerHTML = '';
    if (!timetable) return;

    const byCourse = new Map();
    for (const e of timetable.entries) {
      if (!byCourse.has(e.course.code)) byCourse.set(e.course.code, { course: e.course, secs: [] });
      byCourse.get(e.course.code).secs.push(e.section);
    }

    for (const [code, { course, secs }] of byCourse) {
      const card = document.createElement('div');
      card.className = 'rs-card';
      card.style.setProperty('--accent', colorFor(code, courseOrder.get(code) ?? 0));

      const secHtml = secs
        .map((s) => {
          const times = s.meetings.length
            ? s.meetings.map((m) => `${DAYS[m.day]} ${hhmm(m.start)}–${hhmm(m.end)}`).join(', ')
            : 'TBA';
          const crn = s.crn ? `<span class="crn" title="Class number for SIS">#${escapeHtml(s.crn)}</span>` : '';
          return `<div class="rs-sec">
              <span class="rs-tag">${escapeHtml(s.section)}</span>
              <span class="rs-kind">${escapeHtml(KIND_LABEL[s.kind] || s.kind)}</span>
              <span class="rs-time">${escapeHtml(times)}</span>
              <span class="rs-room">${escapeHtml(s.rooms[0] || '')}</span>
              ${crn}
            </div>`;
        })
        .join('');

      card.innerHTML =
        `<div class="rs-head"><strong>${escapeHtml(code)}</strong>
           <span class="rs-title">${escapeHtml(course.title || '')}</span>
           ${course.credits ? `<span class="pill">${course.credits}u</span>` : ''}</div>${secHtml}`;
      container.appendChild(card);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /* ------------------------------------------------------------- export */

  function pad(n) { return String(n).padStart(2, '0'); }

  function icsDate(d, mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h)}${pad(m)}00`;
  }

  /** First occurrence of `day` (0=Mon) on/after the term start. */
  function firstDateFor(day) {
    const base = new Date(`${TERM_START}T00:00:00`);
    const baseDay = (base.getDay() + 6) % 7; // JS Sunday=0 -> Monday=0
    const delta = (day - baseDay + 7) % 7;
    const d = new Date(base);
    d.setDate(base.getDate() + delta);
    return d;
  }

  function toICS(timetable, label) {
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HKUST Timetable Planner//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:HKUST ${label}`,
    ];

    let uid = 0;
    for (const m of timetable.meetings) {
      const d = firstDateFor(m.day);
      const room = m.section.rooms[0] || '';
      lines.push(
        'BEGIN:VEVENT',
        `UID:hkust-${Date.now()}-${uid++}@planner`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
        `DTSTART:${icsDate(d, m.start)}`,
        `DTEND:${icsDate(d, m.end)}`,
        `RRULE:FREQ=WEEKLY;COUNT=${TERM_WEEKS}`,
        `SUMMARY:${icsEscape(`${m.course.code} ${m.section.section}`)}`,
        `DESCRIPTION:${icsEscape(`${m.course.title || ''}${m.section.instructors ? ` — ${m.section.instructors}` : ''}`)}`,
        room ? `LOCATION:${icsEscape(room)}` : 'LOCATION:',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function icsEscape(s) {
    return String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  }

  function download(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.HK.Render = { renderGrid, renderSectionList, colorFor, toICS, download, escapeHtml, TERM_START };
})(window);
