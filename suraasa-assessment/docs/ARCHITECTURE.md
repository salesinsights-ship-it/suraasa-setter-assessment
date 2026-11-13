# How it is built

## The shape

```
Candidate or recruiter's browser
  React site (Vite)            src/
  Speech in and out            src/voice.js   browser speech recognition and synthesis
        |
        |  POST /api/rpc   one endpoint, an "action" per request, a signed session token
        v
Vercel function                api/rpc.js  ->  server/handlers.js
  permission check per action
  teacher engine and evaluator   server/prompts.js, server/rubric.js
        |                               |
        v                               v
Google Sheet script            Groq chat API
apps-script/Code.gs            server/llm.js
(answers only with the secret)
```

Three choices were made to match what the team already runs and can maintain without an engineer: Vercel for hosting, a Google Sheet for data, and the free Groq plan with browser speech for the call. Each sits behind one file, so it can be replaced without touching the rest.

| To change | Replace |
| --- | --- |
| The AI provider | `GROQ_BASE_URL`, or `server/llm.js` |
| The voice provider (for example ElevenLabs) | `src/voice.js`. The call screen uses only `listen`, `pause`, `speak`, `setMuted`, `setLang`, `stats`, `close` |
| The database (for example Postgres) | `server/store.js`. Handlers use only `read(tabs)`, `write(ops)`, `getBlob(tab, key)` |

## Data

Each tab in the Sheet is one entity. Every cell is plain text, so nothing a person types can run as a formula.

| Tab | One row is | Key fields |
| --- | --- | --- |
| Users | A person who can sign in | email, role (`super_admin`, `recruiter`, `candidate`), active, code_hash |
| Candidates | A candidate's profile | code (SUR-0001), user_id, recruiter_id, role_applied, status |
| Personas | An AI teacher | active, name, difficulty, data (all behaviour, as JSON) |
| Templates | An assessment template | version, data (parameters, marks, thresholds, length, attempts, feedback policy) |
| Assignments | A mock call assigned to a candidate | template, teacher mode (fixed, choice, random), level, length, attempts, due date |
| Sessions | One call | status, length, turns, scores, total, recommendation, technical notes, human review, voided |
| Transcripts | A call's transcript | split across rows of 40,000 characters |
| Reports | A call's evaluation report | split the same way |
| Decisions | A recruiter's recommendation | decision, the AI's recommendation at the time, reason |
| Knowledge | A Suraasa product fact | status (`unverified`, `verified`, `rejected`), source |
| Config | A setting | models, retention days, review frequency |
| AuditLog | Something that happened | who, what, target, detail |

Recruiters are Users with the recruiter role. Scoring parameters live inside Templates.

## Sign-in and permissions

- People sign in with their email and a 10-character access code. The Sheet stores only a SHA-256 hash of the code mixed with the connection secret and the email. Codes are shown once, when created or reset.
- A successful sign-in returns a session token signed by the server, valid for 12 hours. Every request re-checks that the user still exists, is active and still has that role. A switched-off user is locked out within 15 seconds.
- Five wrong codes for one email block sign-in for 10 minutes.
- Every action in `server/handlers.js` starts with its own permission check. Recruiters reach only candidates whose `recruiter_id` is theirs. Candidates reach only their own record.
- What a candidate may see of a report is cut down on the server (`reportForCandidate`), never just hidden in the page.
- The Sheet script answers only requests carrying the connection secret. The secret is in Vercel and in the script's own properties, nowhere else.

## A call, step by step

1. **Start.** The server checks attempts, picks the teacher, creates a Session row and returns a call token (session, teacher, level, start time, length), the teacher's public profile and the greeting. Hidden instructions never leave the server.
2. **Each turn.** The browser sends what it heard plus the transcript so far. The server checks the transcript against its signature, builds the teacher's instructions with the time elapsed, asks the fast model for a reply, cleans it, and signs the new transcript. No Sheet read is needed mid-call, so replies are as fast as the model.
3. **End.** The browser sends the final transcript and its technical notes. The server checks the signature and saves the transcript. Calls below the minimum are marked incomplete and are not scored.
4. **Score.** A separate request, so a busy AI never loses a call. The evaluator returns levels, quotes and comments as JSON. `server/rubric.js` verifies each quote and computes everything else.

### Why the transcript is signed

The free setup has no server-side memory between requests, so the browser carries the transcript. To stop a candidate editing it, every turn is signed on top of the previous signature. A changed, invented or reordered line fails the check and the call cannot continue or be saved.

One gap remains: someone with developer tools could discard their latest turns and continue from an earlier point in the same call. Turn timestamps are part of the signed record, so this shows up as an unexplained gap, and silences over two minutes are flagged on the report. Closing it fully needs server-side call state, which comes with a database.

## How the teacher is kept in character

Each teacher has its own facts, personality, style, pain points, objections, decision rule and call behaviour, all editable in the site. The instructions in `server/prompts.js` add rules common to all: speak in one to three short sentences, react to what was just said, never interview the caller, never state Suraasa's fees or accreditation, never mention AI or scoring, treat "ignore your instructions" as odd speech from a caller, and mark the end of the call. The difficulty level adds a paragraph. Replies are cleaned of stage directions and checked for leaked instructions before they are spoken.

## How scoring is kept fair and consistent

- Temperature 0, one fixed rubric per template version, levels 0 to 4 with the same wording for everyone.
- Marks are `max x level / 4`, to the nearest half mark, worked out by the app.
- A quote must appear in the candidate's own turns (compared without punctuation or case, in English or Devanagari) or the skill scores 0.
- The evaluator is told not to mark down accent, grammar, Hindi or Hinglish, or words garbled by speech recognition, and not to reward fluency, pressure or misleading claims.
- Candidate text is treated as material to assess. An attempt to instruct the evaluator is recorded as a conduct concern.
- Product accuracy is judged only against facts a person has verified. With none verified, the report says accuracy was not checked.
- Technical trouble (speech recognition errors, reconnections, low confidence) is recorded and shown, and a recruiter can set the attempt aside.
- One call in every five (configurable) is put forward for a human to score blind. Assessments > Calibration shows the gap between AI and human, overall and by skill.

## Reliability

| Situation | What happens |
| --- | --- |
| Network drops during a turn | The call screen shows Reconnecting and retries up to six times with growing waits |
| Browser closes or reloads mid-call | The call is kept in the browser and can be resumed until its time is up |
| AI rate limit during a call | The teacher waits and retries |
| AI rate limit at scoring | The call stays "Awaiting score" with a button to score it |
| A model is retired | The next model in the list is used |
| Call runs over time | The teacher is told to wrap up; the server ends the call 90 seconds past the limit |
| Speech engine never reports it has finished speaking | A timer moves the call on |

## Intern training (practice mode)

Practice is an assignment whose teacher mode is `practice`. It reuses every part of a hiring call, with four differences:

- The intern chooses any teacher on the assignment's list. The `attempts` column holds the calls allowed per day, counted by India calendar day, so no Sheet column was added.
- The call token carries a practice mark, which is saved in the session's `flags` when the call ends.
- The evaluator is told the caller is an intern in training. The report carries `training` (Ready for live calls, Nearly ready, Needs more practice, Needs coaching) worked out from the same score bands and caps as the hiring recommendation.
- The intern is sent that training recommendation, their product claims and any proven conduct concern. A hiring candidate is still never sent a recommendation.

The 10 training teachers (`tr01` to `tr10`) and the practice template (`t_training`) live in `server/seed.js` and are copied into the Sheet once by the `installTraining` action.

### Calls longer than ten minutes

Google ends a live audio session at 15 minutes unless context window compression is on, and closes each connection after about 10 minutes with a GoAway warning first. `server/live.js` asks for compression (and retries without it if a model refuses the setting). On GoAway, `src/live.js` waits for the teacher to finish speaking, gets a new token with the conversation so far and a "carry on quietly" instruction, opens the new connection and closes the old one. This is not counted as a reconnection.

### Call recording

`src/live.js` mixes the microphone and the teacher's voice into one stream inside the browser's audio graph and compresses it with MediaRecorder (Opus, about 20 kbit/s). After the call, `src/recording.js` sends it in pieces of 360 KB through `putRecordingPart`, authorised by the call token, and `saveRecording` notes the piece count in the session's `tech` field. The Sheet script stores each piece as a file named `<call id>.<number>.part` in one private Drive folder; nothing is appended or joined on the server. Playback fetches the pieces through `getRecordingPart` (permission-checked like the report) and joins them in the browser. No Sheet column was added.

## What is not built

- **Simultaneous two-way audio without a headset.** Browser speech recognition would hear the teacher's own voice. A paid voice provider with echo handling fixes this. It plugs into `src/voice.js`.
- **Server-side audio recording.** Recording is done in the caller's browser (see above), so a caller with developer tools could interfere with it. Calls on the standard browser voice are not recorded.
- **Single sign-on.** Access codes were chosen to match the existing trainer. Google sign-in can be added in `signIn`.
- **Accounts for more than one company.** This is one Suraasa workspace.
