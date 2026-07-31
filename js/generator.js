/* Timetable enumeration: build per-course section bundles, then search for
   conflict-free combinations across all selected courses. */
(function (global) {
  'use strict';

  const { meetingsOverlap, sectionsByKind } = global.HK;

  const MAX_RESULTS = 2000;   // hard cap on timetables kept
  const MAX_NODES = 4_000_000; // safety valve on search effort

  /* ------------------------------------------------------------ bundles */

  /** Does this section survive the per-section constraints? */
  function sectionAllowed(sec, opts) {
    if (sec.enabled === false) return false;
    if (opts.skipFull && sec.avail != null && sec.avail <= 0) return false;

    for (const m of sec.meetings) {
      if (opts.freeDays && opts.freeDays.includes(m.day)) return false;
      if (opts.earliest != null && m.start < opts.earliest) return false;
      if (opts.latest != null && m.end > opts.latest) return false;
    }
    return true;
  }

  function internallyConsistent(sections) {
    const meets = sections.flatMap((s) => s.meetings);
    for (let i = 0; i < meets.length; i++) {
      for (let j = i + 1; j < meets.length; j++) {
        if (meetingsOverlap(meets[i], meets[j])) return false;
      }
    }
    return true;
  }

  /* HKUST uses two different section-numbering conventions, and they mean
     opposite things:

       MATH 1014  L1,L2,L3  +  T1A,T1B,T1C,T2A,...,T3C
         -> the trailing letter marks a family: T3C belongs to L3. Linked.

       PHYS 1112  L1..L7    +  T01,T02,...,T21
         -> flat numbering, 21 tutorials for 7 lectures. Any tutorial goes
            with any lecture. NOT linked — pairing L1 with T01 here would
            silently discard most of the legal timetables.

     So a kind is treated as linked only when every one of its sections uses
     the letter-suffix form. */
  const LETTER_SUFFIX = /^[A-Za-z]+\d+[A-Za-z]$/;

  function detectLinkedKinds(kinds) {
    const linked = new Set();
    for (const [kind, secs] of kinds) {
      if (kind === 'LEC') continue;
      if (secs.length && secs.every((s) => LETTER_SUFFIX.test(s.section))) linked.add(kind);
    }
    return linked;
  }

  /** Linked kinds must share the chosen lecture's number. */
  function groupsAgree(sections, linkedKinds) {
    const lec = sections.find((s) => s.kind === 'LEC');
    if (!lec || !lec.group) return true;
    for (const s of sections) {
      if (linkedKinds.has(s.kind) && s.group && s.group !== lec.group) return false;
    }
    return true;
  }

  /**
   * Enumerate every legal way to take one section of each required kind.
   * Returns { bundles, relaxedLinking, blockedKinds }.
   */
  function buildBundles(course, opts) {
    const kinds = sectionsByKind(course);
    const usable = [];
    const blockedKinds = [];

    for (const [kind, secs] of kinds) {
      const ok = secs.filter((s) => sectionAllowed(s, opts));
      if (!ok.length) blockedKinds.push(kind);
      else usable.push([kind, ok]);
    }

    // A kind with every option filtered out makes the course unschedulable.
    if (blockedKinds.length) return { bundles: [], relaxedLinking: false, blockedKinds, linkedKinds: [] };
    if (!usable.length) return { bundles: [], relaxedLinking: false, blockedKinds: [], linkedKinds: [] };

    const linked = detectLinkedKinds(kinds);

    const build = (enforceLinking) => {
      const out = [];
      const cur = [];
      const rec = (i) => {
        if (out.length >= 20000) return;
        if (i === usable.length) {
          if (enforceLinking && !groupsAgree(cur, linked)) return;
          if (!internallyConsistent(cur)) return;
          out.push(cur.slice());
          return;
        }
        for (const s of usable[i][1]) {
          cur.push(s);
          rec(i + 1);
          cur.pop();
        }
      };
      rec(0);
      return out;
    };

    const enforce = !!opts.linked && linked.size > 0;
    let bundles = build(enforce);
    let relaxedLinking = false;

    // Safety net: if linking still wipes out every option (odd numbering, or
    // the user disabled the one matching tutorial), fall back for this course.
    if (enforce && !bundles.length) {
      bundles = build(false);
      relaxedLinking = bundles.length > 0;
    }

    return {
      bundles,
      relaxedLinking,
      blockedKinds: [],
      linkedKinds: enforce && !relaxedLinking ? [...linked] : [],
    };
  }

  /* ------------------------------------------------------------ search */

  function bundleMeetings(bundle) {
    return bundle.flatMap((s) => s.meetings);
  }

  function clashes(meetsA, meetsB) {
    for (const a of meetsA) {
      for (const b of meetsB) {
        if (meetingsOverlap(a, b)) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ scoring */

  function analyse(meetings) {
    const byDay = new Map();
    for (const m of meetings) {
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day).push(m);
    }

    let totalGap = 0;
    let maxGap = 0;
    let span = 0;
    let teaching = 0;
    let earliestStart = Infinity;
    let latestEnd = -Infinity;
    const perDay = [];

    for (const [day, list] of byDay) {
      list.sort((a, b) => a.start - b.start);
      const first = list[0].start;
      const last = list[list.length - 1].end;
      let busy = 0;
      let dayGap = 0;
      for (let i = 0; i < list.length; i++) {
        busy += list[i].end - list[i].start;
        if (i > 0) {
          const g = Math.max(0, list[i].start - list[i - 1].end);
          dayGap += g;
          if (g > maxGap) maxGap = g;
        }
      }
      totalGap += dayGap;
      span += last - first;
      teaching += busy;
      earliestStart = Math.min(earliestStart, first);
      latestEnd = Math.max(latestEnd, last);
      perDay.push({ day, count: list.length, first, last, gap: dayGap });
    }

    return {
      days: byDay.size,
      perDay: perDay.sort((a, b) => a.day - b.day),
      totalGap, maxGap, span, teaching,
      earliestStart: earliestStart === Infinity ? null : earliestStart,
      latestEnd: latestEnd === -Infinity ? null : latestEnd,
    };
  }

  /** Whole-timetable constraints that can't be checked per section. */
  function passesGlobal(stats, opts) {
    if (opts.maxGap != null && stats.maxGap > opts.maxGap) return false;
    if (opts.maxPerDay != null && stats.perDay.some((d) => d.count > opts.maxPerDay)) return false;
    if (opts.lunch) {
      const [ls, le] = opts.lunch;
      for (const d of stats.perDay) {
        // Needs a free window inside the lunch band on every day with class.
        const dayMeets = opts._meetIndex.get(d.day) || [];
        const blocked = dayMeets.some((m) => m.start < le && ls < m.end);
        if (blocked) return false;
      }
    }
    return true;
  }

  const SORTERS = {
    days: (a, b) => a.stats.days - b.stats.days || a.stats.totalGap - b.stats.totalGap,
    gaps: (a, b) => a.stats.totalGap - b.stats.totalGap || a.stats.days - b.stats.days,
    late: (a, b) => b.stats.earliestStart - a.stats.earliestStart || a.stats.days - b.stats.days,
    early: (a, b) => a.stats.latestEnd - b.stats.latestEnd || a.stats.days - b.stats.days,
    compact: (a, b) =>
      (a.stats.days * 240 + a.stats.totalGap) - (b.stats.days * 240 + b.stats.totalGap),
  };

  /* ------------------------------------------------------------ entry */

  /**
   * @param courses  array of course objects (already filtered to the user's picks)
   * @param opts     { earliest, latest, freeDays[], lunch[start,end], maxGap,
   *                   maxPerDay, linked, skipFull, sort }
   */
  function generate(courses, opts) {
    const warnings = [];
    const prepared = [];

    const linkedNotes = [];

    for (const course of courses) {
      const { bundles, relaxedLinking, blockedKinds, linkedKinds } = buildBundles(course, opts);
      if (relaxedLinking) {
        warnings.push(
          `${course.code}: strict section linking left no options, so it was relaxed for this course.`
        );
      }
      if (linkedKinds && linkedKinds.length) linkedNotes.push(course.code);
      if (!bundles.length) {
        const why = blockedKinds.length
          ? `every ${blockedKinds.join('/')} option is ruled out by your constraints`
          : 'its own sections clash with each other';
        return {
          ok: false,
          timetables: [],
          warnings,
          error: `No timetable is possible: for ${course.code}, ${why}.`,
        };
      }
      prepared.push({ course, bundles: bundles.map((b) => ({ sections: b, meetings: bundleMeetings(b) })) });
    }

    // Most-constrained course first — prunes the search tree much faster.
    prepared.sort((a, b) => a.bundles.length - b.bundles.length);

    const results = [];
    let nodes = 0;
    let truncated = false;
    const chosen = new Array(prepared.length);

    const rec = (i, meetsSoFar) => {
      if (truncated) return;
      if (i === prepared.length) {
        results.push(chosen.slice());
        if (results.length >= MAX_RESULTS) truncated = true;
        return;
      }
      for (const bundle of prepared[i].bundles) {
        if (++nodes > MAX_NODES) { truncated = true; return; }
        if (clashes(meetsSoFar, bundle.meetings)) continue;
        chosen[i] = bundle;
        rec(i + 1, meetsSoFar.concat(bundle.meetings));
        if (truncated) return;
      }
    };
    rec(0, []);

    // Wrap, score, apply whole-timetable filters.
    const timetables = [];
    for (const combo of results) {
      const entries = [];
      const meetings = [];
      for (let i = 0; i < combo.length; i++) {
        const course = prepared[i].course;
        for (const sec of combo[i].sections) {
          entries.push({ course, section: sec });
          for (const m of sec.meetings) meetings.push({ ...m, course, section: sec });
        }
      }
      const stats = analyse(meetings);

      const meetIndex = new Map();
      for (const m of meetings) {
        if (!meetIndex.has(m.day)) meetIndex.set(m.day, []);
        meetIndex.get(m.day).push(m);
      }
      if (!passesGlobal(stats, { ...opts, _meetIndex: meetIndex })) continue;

      timetables.push({ entries, meetings, stats });
    }

    timetables.sort(SORTERS[opts.sort] || SORTERS.days);

    if (linkedNotes.length) {
      warnings.push(
        `Tutorials/labs kept matched to their lecture for: ${linkedNotes.join(', ')} (letter-suffixed sections like T1A). Other courses were treated as free choice.`
      );
    }

    return {
      ok: true,
      timetables,
      warnings,
      truncated,
      rawCount: results.length,
      error: timetables.length ? null : 'Every clash-free combination was filtered out by your constraints. Try loosening the gap, lunch or per-day limits.',
    };
  }

  global.HK.Generator = { generate, buildBundles, analyse, MAX_RESULTS };
})(window);
