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
    downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ------------------------------------------------------------ comparison */

  const CMP_PX_PER_MIN = 0.44;

  /** Which course+kind slots differ between the shortlisted options. */
  function compareSections(options) {
    const slots = new Map();
    options.forEach((o, i) => {
      for (const e of o.tt.entries) {
        const key = `${e.course.code}|${e.section.kind}`;
        if (!slots.has(key)) {
          slots.set(key, { course: e.course, kind: e.section.kind, picks: new Array(options.length).fill(null) });
        }
        slots.get(key).picks[i] = e.section;
      }
    });

    const differing = [];
    let sameCount = 0;
    // Sections identical across every option get muted in the grid, so the
    // handful that actually differ are the only coloured things on screen.
    const common = new Set();
    for (const slot of slots.values()) {
      const names = slot.picks.map((s) => (s ? s.section : '—'));
      if (new Set(names).size > 1) {
        differing.push({ ...slot, names });
      } else {
        sameCount++;
        common.add(`${slot.course.code}|${names[0]}`);
      }
    }
    return { differing, sameCount, common, total: slots.size };
  }

  /** Stat rows, with the best value in each row flagged where "best" is unambiguous. */
  function compareStats(options) {
    const rows = [
      { label: 'Days on campus', get: (o) => o.tt.stats.days, fmt: (v) => `${v}`, best: 'min' },
      { label: 'Days off', get: (o) => o.tt.stats.freeWeekdays, fmt: (v) => `${v}`, best: 'max' },
      { label: 'Idle between classes', get: (o) => o.tt.stats.totalGap, fmt: (v) => `${(v / 60).toFixed(1)}h`, best: 'min' },
      { label: 'Earliest start', get: (o) => o.tt.stats.earliestStart, fmt: (v) => (v == null ? '–' : hhmm(v)), best: null },
      { label: 'Latest finish', get: (o) => o.tt.stats.latestEnd, fmt: (v) => (v == null ? '–' : hhmm(v)), best: null },
    ];
    if (options.some((o) => o.ratingPercentile != null)) {
      rows.push({
        label: 'Avg instructor',
        get: (o) => o.ratingPercentile,
        fmt: (v, o) => (v == null ? '–' : o.ratingLetter),
        best: 'max',
      });
    }

    for (const row of rows) {
      row.values = options.map(row.get);
      row.bestIdx = -1;
      if (!row.best) continue;
      const nums = row.values.filter((v) => v != null);
      if (!nums.length) continue;
      const target = row.best === 'min' ? Math.min(...nums) : Math.max(...nums);
      // Only flag a winner when it is actually a winner, not a tie.
      if (row.values.filter((v) => v === target).length === 1) row.bestIdx = row.values.indexOf(target);
    }
    return rows;
  }

  function renderCompare(container, options, courseOrder) {
    if (!options.length) {
      container.innerHTML = '<p class="empty big">Shortlist a timetable with <strong>+ Compare</strong> to see it here.</p>';
      return;
    }

    // One shared time axis, or the same class would sit at different heights
    // in each column and the comparison would mislead.
    const all = options.flatMap((o) => o.tt.meetings);
    const { startMin, endMin, dayCount } = gridBounds(all);
    const bodyH = (endMin - startMin) * CMP_PX_PER_MIN;
    const { differing, sameCount, common, total } = compareSections(options);
    const stats = compareStats(options);

    const heads = options.map((o, i) => `
      <div class="cmp-head">
        <div class="cmp-name">
          <span class="cmp-tag">${String.fromCharCode(65 + i)}</span>
          <span class="cmp-idx">#${o.index + 1}</span>
          <button class="btn tiny ghost" data-uncompare="${i}" title="Remove from comparison">✕</button>
        </div>
        <table class="cmp-stats">
          ${stats.map((r) => `<tr${r.bestIdx === i ? ' class="best"' : ''}>
              <th>${escapeHtml(r.label)}</th>
              <td>${escapeHtml(r.fmt(r.values[i], o))}${r.bestIdx === i ? ' <span class="cmp-win">★</span>' : ''}</td>
            </tr>`).join('')}
        </table>
      </div>`).join('');

    const dayRow = (n) => `<div class="cmp-daystrip" style="--dc:${n}">${
      Array.from({ length: n }, (_, d) => `<span>${DAYS[d][0]}</span>`).join('')
    }</div>`;

    const weeks = options.map((o) => {
      const byDay = new Map();
      for (const m of o.tt.meetings) {
        if (!byDay.has(m.day)) byDay.set(m.day, []);
        byDay.get(m.day).push(m);
      }
      const cols = Array.from({ length: dayCount }, (_, d) => {
        const blocks = assignColumns(byDay.get(d) || []).map((m) => {
          const shared = common.has(`${m.course.code}|${m.section.section}`);
          const order = courseOrder.get(m.course.code) ?? 0;
          const top = (m.start - startMin) * CMP_PX_PER_MIN;
          const h = Math.max(14, (m.end - m.start) * CMP_PX_PER_MIN - 2);
          const style = shared
            ? `top:${top}px;height:${h}px;left:${(m._col / m._cols) * 100}%;width:${100 / m._cols}%`
            : `top:${top}px;height:${h}px;left:${(m._col / m._cols) * 100}%;width:${100 / m._cols}%;background:${colorFor(m.course.code, order)}`;
          return `<div class="cmp-block${shared ? ' shared' : ' diff'}" style="${style}"
                       title="${escapeHtml(`${m.course.code} ${m.section.section}\n${DAYS[m.day]} ${hhmm(m.start)}–${hhmm(m.end)}\n${m.section.rooms[0] || ''}`)}">
              <span>${escapeHtml(m.course.code.replace(/\s+/g, ''))}</span>
              <em>${escapeHtml(m.section.section)}</em>
            </div>`;
        }).join('');
        return `<div class="cmp-day">${blocks}</div>`;
      }).join('');
      return `<div class="cmp-week" style="--dc:${dayCount};height:${bodyH}px">${cols}</div>`;
    }).join('');

    const hours = [];
    for (let t = startMin; t < endMin; t += 60) {
      hours.push(`<span style="top:${(t - startMin) * CMP_PX_PER_MIN}px">${hhmm(t)}</span>`);
    }

    const diffList = differing.length
      ? differing.map((d) => `<tr>
            <th>${escapeHtml(d.course.code)} <small>${escapeHtml((KIND_LABEL[d.kind] || d.kind).toLowerCase())}</small></th>
            ${d.names.map((n, i) => `<td${d.names.filter((x) => x === n).length === 1 ? ' class="uniq"' : ''}>${escapeHtml(n)}</td>`).join('')}
          </tr>`).join('')
      : `<tr><td colspan="${options.length + 1}" class="muted">These options are identical.</td></tr>`;

    container.innerHTML = `
      <div class="cmp" style="--n:${options.length}">
        <div class="cmp-corner"></div>
        ${heads}
        <div class="cmp-corner"></div>
        ${options.map(() => dayRow(dayCount)).join('')}
        <div class="cmp-gutter" style="height:${bodyH}px">${hours.join('')}</div>
        ${weeks}
      </div>

      <div class="cmp-legend">
        <span><i class="sw shared"></i>same in all ${options.length}</span>
        <span><i class="sw diff"></i>differs</span>
        <span class="muted">${sameCount} of ${total} section slots identical</span>
      </div>

      <table class="cmp-diff">
        <thead><tr><th>Differs in</th>${options.map((_, i) =>
          `<th>${String.fromCharCode(65 + i)}</th>`).join('')}</tr></thead>
        <tbody>${diffList}</tbody>
      </table>`;
  }

  /* ------------------------------------------------------------ PNG export */

  /** The bounds the grid is drawn to — shared so exports match the screen. */
  function gridBounds(meetings) {
    let startMin = DEFAULT_START;
    let endMin = DEFAULT_END;
    let dayCount = VISIBLE_DAYS;
    for (const m of meetings) {
      startMin = Math.min(startMin, Math.floor(m.start / 60) * 60);
      endMin = Math.max(endMin, Math.ceil(m.end / 60) * 60);
      dayCount = Math.max(dayCount, m.day + 1);
    }
    return { startMin, endMin, dayCount };
  }

  /** Resolve the CSS custom properties so the PNG uses the on-screen colours. */
  function resolvedPalette() {
    const cs = getComputedStyle(document.documentElement);
    return PALETTE.map((v) => (cs.getPropertyValue(v) || '#3b82f6').trim());
  }

  /**
   * Paint the timetable onto a canvas. Drawn by hand rather than screenshotting
   * the DOM so it works offline with no library, and so the output is a clean
   * fixed-size image instead of whatever happens to be scrolled into view.
   */
  function toPNG(timetable, courseOrder, opts = {}) {
    const { title = '', subtitle = '' } = opts;
    const scale = opts.scale || 2;                 // retina-ish
    const { startMin, endMin, dayCount } = gridBounds(timetable.meetings);

    const GUTTER = 58;
    const COL_W = 170;
    const HEAD_H = 34;
    const ROW_H = 56;                              // per hour
    const PAD = 18;
    const titleH = title ? 46 : 0;

    const hours = (endMin - startMin) / 60;
    const bodyH = hours * ROW_H;
    const W = PAD * 2 + GUTTER + dayCount * COL_W;
    const H = PAD * 2 + titleH + HEAD_H + bodyH;

    const cv = document.createElement('canvas');
    cv.width = W * scale;
    cv.height = H * scale;
    const g = cv.getContext('2d');
    g.scale(scale, scale);
    const font = (s, w = '400') => `${w} ${s}px -apple-system, "Segoe UI", Roboto, sans-serif`;

    // Always export light-on-white: it prints and shares better than the dark theme.
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);

    if (title) {
      g.fillStyle = '#111827';
      g.font = font(17, '600');
      g.textBaseline = 'top';
      g.fillText(title, PAD, PAD);
      if (subtitle) {
        g.fillStyle = '#6b7280';
        g.font = font(11.5);
        g.fillText(subtitle, PAD, PAD + 22);
      }
    }

    const top = PAD + titleH;
    const bodyTop = top + HEAD_H;
    const yOf = (min) => bodyTop + ((min - startMin) / 60) * ROW_H;

    // Day headers
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 0; d < dayCount; d++) {
      const x = PAD + GUTTER + d * COL_W;
      g.fillStyle = '#f3f4f6';
      g.fillRect(x, top, COL_W - 1, HEAD_H - 1);
      g.fillStyle = '#374151';
      g.font = font(12, '600');
      g.fillText(DAYS[d], x + COL_W / 2, top + HEAD_H / 2);
    }

    // Hour lines and labels
    g.textAlign = 'right';
    for (let t = startMin; t <= endMin; t += 60) {
      const y = yOf(t);
      g.strokeStyle = '#e5e7eb';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(PAD + GUTTER, Math.round(y) + 0.5);
      g.lineTo(PAD + GUTTER + dayCount * COL_W, Math.round(y) + 0.5);
      g.stroke();
      if (t < endMin) {
        g.fillStyle = '#9ca3af';
        g.font = font(10.5);
        g.fillText(hhmm(t), PAD + GUTTER - 8, y + 8);
      }
    }
    // Column separators
    for (let d = 0; d <= dayCount; d++) {
      const x = PAD + GUTTER + d * COL_W;
      g.strokeStyle = '#e5e7eb';
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, top);
      g.lineTo(Math.round(x) + 0.5, bodyTop + bodyH);
      g.stroke();
    }

    // Blocks
    const palette = resolvedPalette();
    const byDay = new Map();
    for (const m of timetable.meetings) {
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day).push(m);
    }

    g.textAlign = 'left';
    g.textBaseline = 'top';
    for (let d = 0; d < dayCount; d++) {
      for (const m of assignColumns(byDay.get(d) || [])) {
        const order = courseOrder.get(m.course.code) ?? 0;
        const colX = PAD + GUTTER + d * COL_W;
        const w = (COL_W - 4) / m._cols;
        const x = colX + 2 + m._col * w;
        const y = yOf(m.start);
        const h = Math.max(20, yOf(m.end) - y - 2);

        g.fillStyle = palette[order % palette.length];
        roundRect(g, x, y, w - 2, h, 4);
        g.fill();

        g.save();
        g.beginPath();
        g.rect(x, y, w - 2, h);
        g.clip();
        g.fillStyle = '#ffffff';
        g.font = font(11, '700');
        g.fillText(m.course.code, x + 5, y + 4);
        g.font = font(10);
        g.fillText(m.section.section, x + 5, y + 17);
        if (h > 44) g.fillText(`${hhmm(m.start)}–${hhmm(m.end)}`, x + 5, y + 29);
        const room = m.section.rooms[0] || '';
        if (h > 58 && room) {
          g.globalAlpha = 0.8;
          g.fillText(room, x + 5, y + 41);
          g.globalAlpha = 1;
        }
        g.restore();
      }
    }

    return cv;
  }

  function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function downloadPNG(filename, timetable, courseOrder, opts) {
    const cv = toPNG(timetable, courseOrder, opts);
    return new Promise((resolve) => {
      cv.toBlob((blob) => {
        if (blob) downloadBlob(filename, blob);
        resolve(!!blob);
      }, 'image/png');
    });
  }

  /* ------------------------------------------------------------ CSV export */

  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

  /**
   * Two blocks in one file: a week grid you can read at a glance, then a table
   * of every section with the details the grid has no room for.
   */
  function toCSV(timetable, opts = {}) {
    const { startMin, endMin, dayCount } = gridBounds(timetable.meetings);
    const rows = [];
    if (opts.title) rows.push([opts.title], []);

    rows.push(['Time', ...DAYS.slice(0, dayCount)]);
    for (let t = startMin; t < endMin; t += 30) {
      const row = [`${hhmm(t)}–${hhmm(t + 30)}`];
      for (let d = 0; d < dayCount; d++) {
        const here = timetable.meetings.filter((m) => m.day === d && m.start < t + 30 && t < m.end);
        row.push(here.map((m) => `${m.course.code} ${m.section.section}`).join(' / '));
      }
      rows.push(row);
    }

    rows.push([], ['Course', 'Title', 'Section', 'Kind', 'Day', 'Start', 'End', 'Room', 'Instructor']);
    const sorted = timetable.meetings
      .slice()
      .sort((a, b) => a.day - b.day || a.start - b.start);
    for (const m of sorted) {
      rows.push([
        m.course.code, m.course.title || '', m.section.section,
        KIND_LABEL[m.section.kind] || m.section.kind,
        DAYS[m.day], hhmm(m.start), hhmm(m.end),
        m.section.rooms[0] || '', m.section.instructors || '',
      ]);
    }
    // BOM so Excel reads the UTF-8 correctly on a double-click.
    return '﻿' + csvRows(rows);
  }

  global.HK.Render = {
    renderGrid, renderSectionList, renderCompare, colorFor,
    toICS, toCSV, toPNG, downloadPNG,
    download, downloadBlob, escapeHtml, TERM_START,
  };
})(window);
