/* Fallback importers: text pasted from the HKUST schedule page, and a simple
   pipe-delimited manual format. The shipped catalog covers the normal case;
   these exist for new/changed offerings and hand-made sections. */
(function (global) {
  'use strict';

  const DAY_CODES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  function parseClock(s) {
    let m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(s.trim());
    if (m) {
      let h = parseInt(m[1], 10);
      if (h === 12) h = 0;
      return (h + (m[3].toUpperCase() === 'P' ? 12 : 0)) * 60 + parseInt(m[2], 10);
    }
    m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); // 24-hour
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return null;
  }

  /** Handles "TuTh 01:30PM - 02:50PM" and "Tu, Th 13:30 - 14:50". */
  function parseMeetings(text) {
    const out = [];
    const re = /((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*,\s*|)(?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*,\s*|))*)\s+(\d{1,2}:\d{2}\s*(?:[AP]M)?)\s*-\s*(\d{1,2}:\d{2}\s*(?:[AP]M)?)/gi;
    let m;
    while ((m = re.exec(text))) {
      let start = parseClock(m[2]);
      let end = parseClock(m[3]);
      // "10:30 - 11:50AM" — the meridiem may only appear on the end time.
      if (start != null && end != null && !/[AP]M/i.test(m[2]) && /PM/i.test(m[3]) && start + 720 < end) {
        start += 720;
      }
      if (start == null || end == null) continue;
      for (const d of m[1].match(/Mo|Tu|We|Th|Fr|Sa|Su/g) || []) {
        const day = DAY_CODES.indexOf(d);
        if (day >= 0) out.push({ day, start, end });
      }
    }
    return out;
  }

  function classify(code) {
    const m = /^([A-Za-z]+)\s*(\d*)/.exec(code.trim());
    const prefix = (m ? m[1] : code).toUpperCase();
    const group = m && m[2] ? String(parseInt(m[2], 10)) : '';
    const KINDS = { L: 'LEC', LE: 'LEC', C: 'LEC', T: 'TUT', TU: 'TUT', LA: 'LAB', LB: 'LAB', R: 'REC', S: 'STU', P: 'PRA' };
    return { kind: KINDS[prefix] || prefix, group };
  }

  /** Parse a copy-paste of the HKUST Class Schedule page. */
  function parsePaste(text) {
    const lines = text.split(/\r?\n/);
    const courses = [];
    let course = null;
    let section = null;
    const notes = [];

    const COURSE_RE = /^([A-Z]{2,5})\s*(\d{4}[A-Z]*)\s*-\s*(.+?)\s*\((\d+(?:\.\d+)?)\s*units?\)/i;
    const SECTION_RE = /^([A-Z]{1,3}\d{1,2}[A-Z]?)\s*(?:\((\d{3,6})\))?\s*(.*)$/;

    for (const raw of lines) {
      const line = raw.replace(/\t/g, '  ').trim();
      if (!line) continue;

      const cm = COURSE_RE.exec(line);
      if (cm) {
        course = {
          subject: cm[1].toUpperCase(),
          code: `${cm[1].toUpperCase()} ${cm[2].toUpperCase()}`,
          title: cm[3].trim(),
          credits: parseFloat(cm[4]),
          sections: [],
        };
        courses.push(course);
        section = null;
        continue;
      }
      if (!course) continue;
      if (/^Section\b/i.test(line)) continue; // table header

      const sm = SECTION_RE.exec(line);
      const meetings = parseMeetings(line);

      if (sm && /^[A-Z]/.test(sm[1]) && (meetings.length || /TBA/i.test(line))) {
        const { kind, group } = classify(sm[1]);
        section = {
          section: sm[1], crn: sm[2] || null, kind, group,
          meetings, rooms: [], instructors: '', quota: null,
          enrol: null, avail: null, wait: null, remarks: '',
          tba: !meetings.length,
        };
        const room = /(Rm\s[^,]+(?:,\s*Lift[^,(]*)?|Lecture Theat[^,(]*|LT[A-Z]\b|[A-Z]{1,2}\d{3,4},\s*[^,(]+)/i.exec(sm[3]);
        if (room) section.rooms.push(room[0].trim());
        course.sections.push(section);
        continue;
      }

      // Continuation line: extra meeting time for the section above.
      if (section && meetings.length) section.meetings.push(...meetings);
    }

    const kept = courses.filter((c) => c.sections.length);
    if (!kept.length) {
      notes.push('No courses recognised. Make sure you copied the section table, including the course title line.');
    }
    return { courses: kept, notes };
  }

  /** "COMP 3711 | L1 | Tu, Th 13:30 - 14:50 | Rm 2503" */
  function parseManual(text) {
    const byCode = new Map();
    const bad = [];

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length < 3) { bad.push(line); continue; }

      const [codeRaw, secCode, timeStr, room] = parts;
      const cm = /^([A-Z]{2,5})\s*(\d{4}[A-Z]*)$/i.exec(codeRaw.replace(/\s+/g, ' ').trim());
      if (!cm) { bad.push(line); continue; }

      const code = `${cm[1].toUpperCase()} ${cm[2].toUpperCase()}`;
      const meetings = parseMeetings(timeStr);
      if (!meetings.length && !/TBA/i.test(timeStr)) { bad.push(line); continue; }

      if (!byCode.has(code)) {
        byCode.set(code, {
          subject: cm[1].toUpperCase(), code, title: '(manually added)', credits: null, sections: [],
        });
      }
      const { kind, group } = classify(secCode);
      byCode.get(code).sections.push({
        section: secCode, crn: null, kind, group, meetings,
        rooms: room ? [room] : [], instructors: '', quota: null,
        enrol: null, avail: null, wait: null, remarks: '', tba: !meetings.length,
      });
    }

    return { courses: [...byCode.values()], bad };
  }

  global.HK.Parser = { parsePaste, parseManual, parseMeetings };
})(window);
