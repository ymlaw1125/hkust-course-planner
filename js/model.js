/* Catalog access: a small index is loaded up-front, per-subject data on demand. */
(function (global) {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const KIND_LABEL = {
    LEC: 'Lecture', TUT: 'Tutorial', LAB: 'Lab', REC: 'Recitation',
    STU: 'Studio', PRA: 'Practicum', FLD: 'Field', EXP: 'Experiment',
  };
  // Order matters only for display.
  const KIND_ORDER = ['LEC', 'TUT', 'LAB', 'REC', 'STU', 'PRA', 'FLD', 'EXP'];

  function hhmm(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function meetingsOverlap(a, b) {
    return a.day === b.day && a.start < b.end && b.start < a.end;
  }

  const Catalog = {
    index: null,
    courses: new Map(),      // "COMP 2011" -> course object
    loadedSubjects: new Set(),
    pending: new Map(),

    init() {
      this.index = global.CATALOG_INDEX || null;
      return this.index;
    },

    get ready() {
      return !!this.index;
    },

    /** Inject data/subjects/XXX.js once; works over file:// as well as http. */
    loadSubject(subject) {
      if (this.loadedSubjects.has(subject)) return Promise.resolve();
      if (this.pending.has(subject)) return this.pending.get(subject);

      const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `data/subjects/${subject}.js`;
        s.onload = () => {
          const arr = global[`CATALOG_SUBJECT_${subject}`] || [];
          for (const c of arr) {
            c.sections.forEach(normalizeSection);
            this.courses.set(c.code, c);
          }
          this.loadedSubjects.add(subject);
          resolve();
        };
        s.onerror = () => reject(new Error(`Could not load subject ${subject}`));
        document.head.appendChild(s);
      });
      this.pending.set(subject, p);
      return p;
    },

    /** Pull in every subject file. Needed only for "any course" searches. */
    async loadAll(onProgress) {
      const subjects = (this.index && this.index.subjects) || [];
      let done = 0;
      for (const s of subjects) {
        try { await this.loadSubject(s); } catch (_) { /* skip a missing file */ }
        done++;
        if (onProgress) onProgress(done, subjects.length);
      }
    },

    /** Resolve many codes at once, loading only the subjects involved. */
    async getCourses(codes) {
      const subjects = new Set();
      for (const code of codes) {
        const entry = this.index && this.index.courses.find((e) => e.c === code);
        subjects.add(entry ? entry.s : String(code).split(' ')[0]);
      }
      for (const s of subjects) {
        try { await this.loadSubject(s); } catch (_) { /* skip */ }
      }
      return codes.map((c) => this.courses.get(c)).filter(Boolean);
    },

    async getCourse(code) {
      if (this.courses.has(code)) return this.courses.get(code);
      const entry = this.index && this.index.courses.find((e) => e.c === code);
      const subject = entry ? entry.s : String(code).split(' ')[0];
      await this.loadSubject(subject);
      return this.courses.get(code) || null;
    },

    /** Free-text search over the index. Returns at most `limit` entries. */
    search(q, limit = 60) {
      if (!this.index) return [];
      const query = q.trim().toUpperCase();
      if (!query) return [];
      const terms = query.split(/\s+/);
      const bareQuery = query.replace(/\s+/g, '');
      const out = [];
      for (const e of this.index.courses) {
        const code = e.c.toUpperCase();
        const hay = `${code} ${(e.t || '').toUpperCase()}`;
        // Nobody types the space in "COMP 2011", so match the squashed code too.
        const bareCode = code.replace(/\s+/g, '');
        let ok = true;
        for (const t of terms) {
          if (hay.includes(t) || bareCode.includes(t)) continue;
          ok = false;
          break;
        }
        if (!ok) continue;
        // Exact-prefix matches on the code rank first, spacing aside.
        const rank = bareCode.startsWith(bareQuery) ? 0 : 1;
        out.push({ e, rank });
        if (out.length > 400) break;
      }
      out.sort((a, b) => a.rank - b.rank || a.e.c.localeCompare(b.e.c));
      return out.slice(0, limit).map((o) => o.e);
    },

    /** Merge user-supplied courses (pasted / manual / JSON) into the catalog. */
    addCourses(list, { replace = false } = {}) {
      if (replace) this.courses.clear();
      let added = 0;
      for (const c of list) {
        c.sections.forEach(normalizeSection);
        const existing = this.courses.get(c.code);
        if (existing && !replace) {
          for (const s of c.sections) {
            if (!existing.sections.some((x) => x.section === s.section)) {
              existing.sections.push(s);
            }
          }
        } else {
          this.courses.set(c.code, c);
        }
        added++;
        // Make it findable via search even though it isn't in the shipped index.
        if (this.index && !this.index.courses.some((e) => e.c === c.code)) {
          this.index.courses.push({
            s: c.subject || c.code.split(' ')[0],
            c: c.code, t: c.title || '', u: c.credits || null, n: c.sections.length,
          });
        }
      }
      return added;
    },
  };

  const CommonCore = {
    data: null,

    init() {
      this.data = global.CATALOG_COMMON_CORE || null;
      return this.data;
    },

    get ready() {
      return !!(this.data && this.data.groups && this.data.groups.length);
    },

    /** Academic year the current term belongs to, e.g. "2610" -> 2026. */
    termStartYear() {
      const t = (Catalog.index && Catalog.index.term) || '';
      const yy = parseInt(String(t).slice(0, 2), 10);
      return Number.isFinite(yy) ? 2000 + yy : new Date().getFullYear();
    },

    /** Year 1 in 2026-27 means admitted 2026; year 3 means admitted 2024. */
    admissionYear(yearOfStudy) {
      return this.termStartYear() - (Math.max(1, yearOfStudy) - 1);
    },

    /**
     * Pick the cohort scheme for an admission year. Cohort ids encode the first
     * year they apply to (CC22, CC25, CC26...), so the newest scheme at or
     * below the admission year wins; anything older falls back to 4Y. Written
     * generically so a future CC27 works without a code change.
     */
    cohortFor(yearOfStudy) {
      if (!this.ready) return null;
      const adm = this.admissionYear(yearOfStudy);
      const dated = this.data.cohorts
        .map((c) => {
          const m = /^CC(\d{2})$/.exec(c.id);
          return m ? { ...c, from: 2000 + parseInt(m[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.from - a.from);

      const hit = dated.find((c) => adm >= c.from);
      if (hit) return hit.id;
      const legacy = this.data.cohorts.find((c) => !/^CC\d{2}$/.test(c.id));
      return legacy ? legacy.id : (dated.length ? dated[dated.length - 1].id : null);
    },

    cohortLabel(id) {
      const c = this.data && this.data.cohorts.find((x) => x.id === id);
      return c ? c.label : id;
    },

    groupsFor(cohortId) {
      if (!this.ready) return [];
      return this.data.groups.filter((g) => g.cohort === cohortId);
    },

    group(id) {
      return this.ready ? this.data.groups.find((g) => g.id === id) : null;
    },
  };

  function normalizeSection(s) {
    if (!s.meetings) s.meetings = [];
    if (!s.rooms) s.rooms = [];
    if (s.kind == null) s.kind = 'LEC';
    if (s.group == null) s.group = '';
    if (s.enabled === undefined) s.enabled = true;
    return s;
  }

  /** Group a course's sections by kind, preserving a sensible display order. */
  function sectionsByKind(course) {
    const map = new Map();
    for (const s of course.sections) {
      if (!map.has(s.kind)) map.set(s.kind, []);
      map.get(s.kind).push(s);
    }
    return [...map.entries()].sort(
      (a, b) => (KIND_ORDER.indexOf(a[0]) + 1 || 99) - (KIND_ORDER.indexOf(b[0]) + 1 || 99)
    );
  }

  global.HK = {
    DAYS, KIND_LABEL, KIND_ORDER, hhmm, meetingsOverlap, Catalog, CommonCore, sectionsByKind,
  };
})(window);
