# Suraasa Setter Assessment

Mock sales call assessment for hiring Pre-Sales (Setter) interns. A candidate signs in, has a 5 to 10 minute voice call with an AI teacher, and the call is scored out of 100 on a ten-part rubric. Recruiters read the transcript and report, compare candidates and record their own recommendation.

To put it online, follow [SETUP.md](SETUP.md). How it is built and why is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Try it on your computer

```bash
npm install
npm run build
npm run dev        # http://localhost:4173, sign-in details are printed
```

The local preview runs the real site, the real server code and the real Sheet script. Google Sheets and the AI are replaced by stand-ins, so the teacher gives stock replies and scores follow a fixed pattern. Use it to see the screens and flows, not to judge the AI.

## Tests

```bash
npm test           # 35 server tests: permissions, privacy, scoring rules, call record checks, the Sheet script
npm run test:e2e   # 27 browser checks in Chrome: all three roles, a full voice call, reports, phone size
```

The browser test needs Playwright and Chrome. Set `CHROME` and `PLAYWRIGHT_PATH` if they are not in the default places. Set `SHOTS=some/folder` to save screenshots.

Both suites use a simulated microphone, speech engine and AI. They prove the product's logic. They do not prove how well a real model plays a teacher or scores a call. That needs the checks in SETUP.md, steps 4 and 5.

## What is where

| Path | What it holds |
| --- | --- |
| `api/rpc.js` | The one server entry point on Vercel. Holds the keys |
| `server/handlers.js` | Every action, with the permission check for each |
| `server/auth.js` | Access codes, sign-in sessions, and the signed call record |
| `server/store.js` | The only link to the Google Sheet. Swap this to use a database |
| `server/llm.js` | The only link to the AI provider. Swap this, or set `GROQ_BASE_URL` |
| `server/prompts.js` | The teacher's hidden instructions and the evaluator's instructions |
| `server/rubric.js` | Scoring rules: marks, evidence checks, categories, recommendation |
| `server/seed.js` | The 10 starter teachers, the default rubric and the draft product facts |
| `apps-script/Code.gs` | Google Sheet storage, backups and retention |
| `src/voice.js` | Standard voice: browser listening and speaking |
| `src/live.js`, `server/live.js`, `public/pcm-worklet.js` | Live voice through the Gemini Live API. Swap these to use another live voice provider |
| `src/pages/Call.jsx` | The phone call screen |
| `src/pages/` | Login, candidate dashboard, result, recruiter dashboard, candidates, leaderboard, report, teachers, assessments, settings |
| `tests/sim/` | The simulated Sheet, AI and local preview server |

## Rules worth knowing

- **The app does the arithmetic.** The AI proposes a level from 0 to 4 for each skill, with quotes. Marks, totals, categories and the recommendation are calculated by the app, the same way for everyone.
- **No quote, no marks.** A skill earns marks only if the AI's quote is found in what the candidate actually said. Otherwise it scores 0 and is marked "No evidence".
- **Conduct caps the recommendation.** A misleading claim, pressure, or carrying on after a "do not call me again", backed by a real quote, caps the recommendation at Borderline whatever the score.
- **Short calls are not scored.** Fewer than the minimum turns (4 by default) or under 40 words means no score, and no attempt is used.
- **The recommendation is advice.** Recruiters record their own. Changing the AI's needs a written reason, and everything is in the audit log.
- **Candidates see only what the template allows.** Never the hiring recommendation, conduct notes, the teacher's hidden instructions or anyone else's results. This is enforced on the server.
- **Reports keep their rubric version.** Changing the rubric makes a new version for future calls. Old reports do not change.
- **Product facts must be verified by a person** before the evaluator may use them.
