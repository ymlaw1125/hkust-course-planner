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

If you're **editing** the source, run it over HTTP instead — browsers cache
`file://` scripts aggressively and ignore `?v=` cache-busting on them, so edits
can silently fail to load:

```bash
node scripts/serve.mjs
```

## Saved groups

Pick your courses, type a name under **Saved groups**, hit Save. One click
restores the whole set later, so you never retype it. Groups also remember the
individual sections you un-ticked.

Saving under an existing name overwrites it (case-insensitive, with a confirm).
Loading a group asks before replacing a non-empty selection. A group made
against an older catalog still loads what it can — *"Loaded 1 of 2. Not offered
this term: ZZZZ 9999."* — rather than failing outright.

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

Earliest start · latest finish · **days off per week** · specific free days ·
protected lunch window · max gap between classes · max classes per day · skip
full sections. Results sort by fewest days on campus, least idle time, latest
start, earliest finish, or most compact.

**Days off per week** asks for *any* N free weekdays rather than naming them —
"give me a 3-day week, I don't care which days". It combines with the specific
free-day chips if you want both.

This one is enforced *during* the search, not by filtering afterwards. Adding a
course can only ever occupy more days, so a partial timetable that already uses
too many is dead and its whole branch is skipped. That matters because the
search stops at 2,000 results: for `PHYS 1112 + MATH 1014 + COMP 2711`, asking
for 2 days off returns the complete set of **416** timetables, where filtering a
truncated search would have shown only **271** and silently hidden 145 valid
options. Max-classes-per-day is pruned the same way. Max gap can't be — a later
class can fill an earlier gap — so it's judged on the finished timetable.

If a combination is impossible the planner says *why*, naming the constraints
actually in play — *"for COMP 2011, every LAB option is ruled out by your
constraints"*, or *"Clash-free timetables exist, but none satisfies 2 days off
per week and the max-gap limit."*

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
js/app.js             UI wiring, constraints, saved groups, localStorage
scripts/scrape.mjs    catalog scraper
scripts/serve.mjs     no-cache static server for development
data/                 generated catalog
```

Your selection, unticked sections, constraints and theme are saved to
`localStorage` under `hkust-planner-v1`; saved groups live separately under
`hkust-planner-groups-v1`, so clearing one doesn't take the other with it.
Nothing is uploaded anywhere.
