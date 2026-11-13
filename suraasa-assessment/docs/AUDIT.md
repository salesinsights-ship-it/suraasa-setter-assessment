# Site audit, 13 November 2026

What was inspected, what was found, and what was done about it. Measurements are from a test copy of the site with a stand-in for Google Sheets; the live site was not signed in to.

## Issues, by priority

| # | Priority | Issue | Status |
| --- | --- | --- | --- |
| 1 | Critical | Each page action made 2 to 6 requests to the Google Sheet, one after another. Each takes about a second, so this was the main cause of waiting | Fixed: one request per action |
| 2 | Critical | Call recordings could not play on the live site: the security policy blocked audio made in the page | Fixed |
| 3 | Critical | Two or three teacher voices could talk at once on a live call (speaker echo, a second Start press, an old line left open) | Fixed |
| 4 | High | Opening a report read the whole Transcripts tab to find one call, so it got slower with every call ever taken | Fixed in `apps-script/Code.gs`. Takes effect when the script is redeployed |
| 5 | High | Every live call of three turns or more was flagged "technical problems" | Fixed |
| 6 | High | After signing in, the first page asked the Sheet again for data the sign-in had just read | Fixed: sign-in brings the first page with it |
| 7 | High | After each add, edit or delete the whole list was fetched again | Fixed: the reply to the change carries the updated lists |
| 8 | High | The whole site (289 KB) was downloaded by everyone, including the call screen and recruiter pages a visitor might never open | Fixed: pages load on demand, 168 KB first load |
| 9 | High | Google Fonts blocked the first paint by about 0.9 s on a phone | Fixed: the font is served from the site |
| 10 | Medium | Accessibility: low-contrast badges, tables that could not be scrolled by keyboard on phones, missing page landmarks, unnamed table columns | Fixed: 0 issues on 14 pages, desktop and phone size |
| 11 | Medium | Built files were not cached by the browser between visits | Fixed: cached for a year |
| 12 | Medium | Long tables drew every row (candidates, leaderboard, interns, 400 audit entries) | Fixed: paged |
| 13 | Medium | Destructive actions used the browser's plain pop-ups | Fixed: styled confirmations, with a written reason where one is needed |
| 14 | Medium | No request ever timed out, so a stuck request spun for ever | Fixed: 25 s to the Sheet, 75 s from the browser |
| 15 | Medium | Each live call start tried up to four request shapes with Google before finding the one that works | Fixed: the working shape is remembered |
| 16 | Low | A played recording stayed in memory after leaving the page | Fixed |
| 17 | Low | Practice calls were mixed into hiring figures | Fixed |
| 18 | Low | No chart anywhere; trends were lists of numbers | Added: team trend chart and per-intern sparklines on Training |

## Not changed, and why

- **Search engines.** The site asks not to be indexed, because it holds candidate data. This keeps the Lighthouse SEO score at 60.
- **Signing in still takes two requests to the Sheet** (check the code, then record the sign-in). Recording it is a security log, so it is not skipped or delayed.
- **Google Sheet as the database.** It has no indexes. Every read loads whole tabs. This is fine for a few thousand calls; beyond that, move `server/store.js` to a real database.
- **Live voice latency inside a call** depends on Google's Gemini Live service and the caller's connection. The site adds no delay of its own to replies.

## Measurements

Lighthouse, sign-in page, phone settings:

| | Before | After |
| --- | --- | --- |
| Performance | 100 | 100 |
| Accessibility | 88 | 100 |
| Best practices | 100 | 100 |
| SEO | 50 | 60 |
| Largest content shown | 1.5 s | 0.9 s |
| Layout shift | 0 | 0 |
| Download | 326 KB | 230 KB |

Time in a real browser with every Sheet request slowed to 0.9 s (run `SHEET_DELAY_MS=900`):

| Journey | Before | After |
| --- | --- | --- |
| First ever sign-in to dashboard (sets up teachers) | 5.9 s | 3.9 s |
| Reload to dashboard | 1.4 s | 1.4 s |
| Move between pages | 0.1 s | 0.1 s |
| Add a candidate, until they show in the list | 3.6 s | 2.5 s |
| Open a call report | 3.8 s | 1.3 s |

Requests to the Sheet per action: `node tests/roundtrips.mjs`.

## How to re-run

- `npm test`: 49 server tests.
- `npm run test:e2e`: 30 browser tests, including every page, a full call, recording and the confirmations.
