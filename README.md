# HKUST Timetable Planner

Enter the courses you want, get **every conflict-free timetable** the section
combinations allow — then browse them, sort them, and export to your calendar.

Built against the live **2026-27 Fall** catalog scraped from
[Class Schedule & Quota](https://w5.ab.ust.hk/wcq/cgi-bin/2610/):
**1,403 courses / 3,093 sections / 96 subjects**.

## Run it

Open `index.html` in a browser. That's it — no server, no install, no build.
The catalog is bundled as plain `.js` files so it works straight off the
filesystem.

## How it works

For each course the planner enumerates every legal *bundle* — one lecture, one
tutorial, one lab — discards bundles that clash with themselves, then searches
across courses for combinations with zero overlapping meetings. The search
orders the most-constrained course first, so five courses resolve in a few
milliseconds.

### Linked sections

HKUST uses two numbering conventions that mean opposite things, and getting
this wrong silently throws away valid timetables:

| Course | Sections | Meaning |
|---|---|---|
| MATH 1014 | `L1 L2 L3` + `T1A T1B T1C T2A … T3C` | the trailing letter marks a family — `T3C` belongs to `L3`. **Linked.** |
| PHYS 1112 | `L1 … L7` + `T01 T02 … T21` | flat numbering, 21 tutorials for 7 lectures. Any tutorial fits any lecture. **Not linked.** |

So a section kind is treated as linked only when *every* section in it uses the
letter-suffix form. Courses like `COMP 2011` (`L1–L4` + `LA1–LA4`) are treated
as free choice. The status line tells you which courses linking was applied to,
and the checkbox turns it off entirely.

### Constraints

Earliest start · latest finish · free days · protected lunch window · max gap
between classes · max classes per day · skip full sections. Results sort by
fewest days on campus, least idle time, latest start, earliest finish, or most
compact.

If a combination is impossible the planner says *why* — e.g. *"for COMP 2011,
every LAB option is ruled out by your constraints"* — rather than just
returning nothing.

## Notes on the real data

- Nothing starts before **09:00**.
- **355 of 2,430** meetings end after 18:00 — mostly evening labs running
  18:00–19:50. The grid defaults to 09:00–18:00 and **auto-expands** when a
  selected section falls outside it, so these aren't hidden.
- **84** meetings land on Sat/Sun; the Sat/Sun columns appear only when needed.
- **87** sections are TBA (no meeting time). They're kept and never conflict.

## Refreshing the catalog

```bash
node scripts/scrape.mjs
```

Pass a term code for a different term (`2610` = 2026-27 Fall, `2530` =
2025-26 Spring):

```bash
node scripts/scrape.mjs 2530
```

Writes `data/index.js` (search index) and `data/subjects/*.js` (loaded on
demand). If a course is missing or changed, **Import / Paste** also accepts a
copy-paste of the schedule page, a `courses.json`, or hand-typed sections.

## Calendar export

**Export** downloads a `.ics` of the timetable you're viewing, as weekly
recurring events. Term start is `TERM_START` in `js/render.js` (currently
`2026-09-01`, 14 weeks) — change it if the semester dates differ.

## Layout

```
index.html            markup
css/styles.css        dark/light theme
js/model.js           catalog + lazy subject loading
js/generator.js       bundle building, conflict search, scoring
js/render.js          weekly grid, section cards, .ics export
js/parser.js          paste / manual import
js/app.js             UI wiring, constraints, localStorage
scripts/scrape.mjs    catalog scraper
data/                 generated catalog
```

Your selection, unticked sections, constraints and theme are saved to
`localStorage`. Nothing is uploaded anywhere.
