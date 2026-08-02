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

## Professor ratings

Sort timetables by **Best-rated professors**. It's a ranking, not a filter — no
timetable is ever removed, the better-taught ones just come first.

By default every course counts. Click the **★** on a course to weigh *only* the
starred ones — so you can insist on a good lecturer for your two hard majors and
not care who teaches the rest. Lectures count double tutorials and labs, since
tutorials are often run by TAs. Unrated instructors are skipped rather than
scored zero: a new lecturer isn't a bad one.

Grades appear on the section chips and in the lock picker, and each timetable
shows its average. Three states are distinguished, because they mean different
things:

| Section | Shows |
|---|---|
| Instructor rated | their letter, e.g. `A+` |
| Instructor still `TBA` | a muted **TBA** badge |
| Instructor named but unrated | nothing |

The last one is a gap in the ratings data, not a fact about the section — so it
stays blank rather than claiming TBA. Of 3,093 sections: 2,104 rated, 839 TBA,
150 named-but-unrated.

### Where the data comes from

Ratings are a snapshot of [ust-rankings.com](https://ust-rankings.com), fetched
by `node scripts/scrape-ratings.mjs` into `data/ratings.js` (~146 KB).

The letters are **theirs, not ours**. The scraper reproduces their published
scoring formula, eligibility rule and percentile→letter thresholds from
[ust-archive/ust-rankings](https://github.com/ust-archive/ust-rankings), so a
grade here matches the grade on their site rather than being a scheme of our own
invention. Verify with the printed grade distribution: the bands land exactly on
10% / 10% / 5% / 15% … as their thresholds require.

Two caveats worth knowing:

- Ratings are **historical** — they come from past student surveys, so the
  snapshot uses the most recent term with data (currently 2025-26 Summer), not
  the term you're planning. A brand-new instructor has no rating at all;
  **88%** of instructors in the catalog have one.

### Matching names across the two sites

The same person is often spelled differently by each site, in two consistent
ways:

| | catalog | ratings site |
|---|---|---|
| given names reordered | `CHAN, Cecia Ki` | `CHAN, Ki Cecia` |
| one name abbreviated | `MAK, Brian` | `MAK, Brian Kan Wing` |

So a name is compared as a surname plus a *set* of given-name tokens, not as a
string. An exact string match is tried first, then a same-token-set match, then
one where either side's tokens are a subset of the other's. Any of those is
only accepted when it points at exactly one rated person — where a name could
mean two people, no grade is shown rather than a guessed one. That recovers 17
instructors (642 → 659) with no change to any name that already matched.

It doesn't fix genuinely different data: someone absent from their dataset, or
romanized differently, still shows no grade.
- That project carries **no licence**, so this is a convenience copy of someone
  else's work. Credit them, and don't treat the letters as objective fact —
  they're a model over survey responses.

## Locking a section

Expand a selected course and each kind — Lecture, Tutorial, Lab — gets its own
picker, defaulting to **Any**. Choose a specific section to lock it: useful when
you're already pre-enrolled in a slot, or you want a particular lecturer. The
options list the times and instructor so you can pick without cross-checking.

Locking is per kind, so you can pin the lecture and leave the tutorial free (or
the reverse). Locked kinds show what they're locked to instead of the exclusion
checkboxes, which would be redundant. Pinned sections appear as a badge on the
collapsed card, and are saved with [saved groups](#saved-groups) — so a
pre-enrolled set reloads exactly as you left it.

Note that a locked lecture and tutorial from different linked groups (`L1` with
`T2C`) can't be taken together. That produces no timetables, and the planner
says which sections you locked so you know what to loosen.

Each customised course gets a **↺** button that puts it back to defaults — every
kind on *Any*, every section re-ticked — and **Reset all** in the Selected header
does the lot while keeping your courses (unlike *Clear*, which removes them).
Both appear only when there is something to undo.

## Resizable layout

The three columns, and the three sections of the left column (Course data /
Selected / Saved groups), are separated by draggable splitters. **Drag** to
resize, **double-click** to reset that one, or focus a splitter and use the
**arrow keys** (hold Shift for bigger steps). Sizes persist in `localStorage`.

Every pane scrolls independently, so a long selection can't squash the search
results — which it used to, because `overflow-y: auto` makes a flex item's
`min-height` resolve to `0` and the results box got crushed to a sliver.
Splitters clamp so no pane can be dragged below a usable size, and shrinking the
window re-clamps rather than stranding a track off-screen.

Below 1180px the panels stack and the splitters disappear, since there is
nothing left to split.

## Finding courses

The course search matches on code or title, and **ignores spacing in codes** —
`comp2011`, `COMP 2011` and `comp 2011` all find the same course. Terms are
ANDed, so `comp2011 programming` narrows by both, and exact code matches are
ranked above title matches. The search box in [Fill a gap](#fill-a-gap) behaves
the same way.

## Fill a gap

Once you have a timetable you like, **+ Fill a gap** finds courses that drop
into the empty slots. Your current timetable is held fixed — nothing already on
it moves — so a course only qualifies if its lecture *and* its tutorial/lab all
land in free time. The constraints you generated under still apply, so a
suggestion can't quietly eat a protected day off or your lunch window.

Search either the whole catalog or one Common Core group. You pick your **year
of study** and the right Common Core scheme is derived from it:

| Year (in 2026-27) | Admitted | Scheme |
|---|---|---|
| 1 | 2026 | CC26 |
| 2 | 2025 | CC25 |
| 3–5 | 2022–24 | CC22 |
| earlier | before 2022 | 4Y |

The cohort ids encode the first year they apply to, so a future `CC27` is picked
up from the data with no code change.

Each hit shows when it meets, which sections fit, and whether it drags you onto
campus on a **new day** — options that fit your existing days are listed first.

Searching the whole catalog can return hundreds of hits, so there's a **search
box** next to *Look in* that filters by code or title as you type (`sosc1440`
finds `SOSC 1440`; `economy` matches titles). It filters the **full** result
set, not just the 300 cards rendered — so a match sorted past the cutoff is
still findable. Escape clears it without closing the dialog.
**Add** puts the course in your selection, regenerates, and returns you to the
same arrangement you were looking at with the new course slotted in.

Group listings come from `data/common-core.js` (**42 of 52** groups have
offerings this term; the rest are shown as empty rather than looking broken).

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
js/app.js             UI wiring, constraints, saved groups, fill-a-gap, localStorage
data/common-core.js   course -> Common Core group mapping (52 groups)
scripts/scrape.mjs    catalog scraper
scripts/serve.mjs     no-cache static server for development
scripts/scrape-ratings.mjs  instructor ratings from ust-rankings.com
data/ratings.js       instructor -> letter grade snapshot
data/                 generated catalog
```

Your selection, unticked sections, constraints and theme are saved to
`localStorage` under `hkust-planner-v1`; saved groups live separately under
`hkust-planner-groups-v1`, so clearing one doesn't take the other with it.
Nothing is uploaded anywhere.
