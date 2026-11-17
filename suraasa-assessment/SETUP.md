# Set up the Setter Assessment site

This takes about 40 minutes. You need a Google account, a free Groq account and a Vercel account.

| Part | What does it | Cost |
| --- | --- | --- |
| Website and server | Vercel | Free plan |
| Data | Google Sheet with Apps Script | Free |
| Teacher's replies and scoring | Groq | Free plan, within daily limits |
| Listening and speaking | The candidate's Chrome or Edge browser | Free |

Never paste a key or the connection secret into a chat, into this code, or into the Sheet.

## 1. Google Sheet (10 minutes)

1. Create a new Google Sheet called `Setter Assessment`. Use an account that will stay with the team, because this account owns all candidate data.
2. Open **Extensions > Apps Script**. Delete what is there, paste all of `apps-script/Code.gs`, and save.
3. Choose `setupSheet` in the function menu and click **Run**. Allow the permissions.
4. Go to the Sheet tab. A message shows the **connection secret**. Copy it somewhere private for step 3, then click **OK**. Reload the Sheet so the **Setter Assessment** menu appears. You can see the secret again under **Setter Assessment > Show connection secret**.
5. Click **Setter Assessment > Create first Super Admin**. Enter your name and work email. Write down the access code it shows. It is shown once.
6. Click **Setter Assessment > Turn on daily backup and clean-up**.
7. In Apps Script, click **Deploy > New deployment > Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Deploy, then copy the URL ending in `/exec`.

"Anyone" is safe here. The script answers only requests that carry the connection secret, and only your Vercel server knows it. Opening the link in a browser shows no data.

If **Anyone** is not offered, your Google Workspace admin has turned it off and needs to allow it.

Keep the Sheet itself private. Do not share it with the wider team: it holds every candidate's transcript and score.

## 2. Groq key (3 minutes)

1. Sign up at console.groq.com. The free plan needs no card.
2. Open **API Keys**, create a key and copy it.

## 3. Vercel (15 minutes)

1. Put this folder in a new **private** GitHub repository.
2. In Vercel, click **Add New > Project** and import the repository. `vercel.json` already has the build settings.
3. In **Settings > Environment Variables**, add:

| Name | Value |
| --- | --- |
| `APPS_SCRIPT_URL` | The `/exec` URL from step 1 |
| `SHEET_SECRET` | The connection secret from step 1 |
| `GROQ_API_KEY` | The key from step 2 |

4. Click **Redeploy**. Keys only apply to a new deployment.

Vercel's free plan is for personal, non-commercial use. Check that this is acceptable for a company hiring tool, or use a paid plan.

## 4. First sign-in (5 minutes)

1. Open the site and sign in with your email and the access code from step 1.
2. The first sign-in creates the 10 teachers, the 100-mark rubric and 12 draft product facts.
3. Open **Settings > AI, data and permissions** and click **Test the AI connection**. Each model should say Available. If one does not, see "If a model is retired" below.
4. Open **Assessments > Product facts**. Read each draft, correct it if needed, and click **Verify** or **Reject**. Until at least one fact is verified, reports cannot check whether a candidate's claims about Suraasa are accurate, and they say so.
5. Open **Teachers**, open a teacher and use **Test this teacher**. Do this for all 10, in English and in Hindi, before any candidate is assessed.
6. Open **Settings > People and roles** and add your recruiters. Give each their access code privately.

## 5. Test a full call before inviting candidates

1. As a recruiter, add yourself as a candidate with a second email address, and assign a mock call.
2. Sign in as that candidate in **Chrome or Edge on a computer**. Use a headset.
3. Take the call for at least 4 turns, end it, and read the report.
4. Have two people score the same call by hand under **Score it yourself**, then compare with the AI under **Assessments > Calibration**. Do this for 10 to 15 calls before relying on AI scores for hiring decisions.

## Environment variables

| Name | Needed | Meaning |
| --- | --- | --- |
| `APPS_SCRIPT_URL` | Yes | The Sheet script's `/exec` link |
| `SHEET_SECRET` | Yes | The connection secret. Also used to sign sign-in sessions and call records, so changing it signs everyone out and invalidates every access code |
| `GROQ_API_KEY` | Yes | The AI key |
| `GROQ_BASE_URL` | No | Another OpenAI-compatible AI service, if you move away from Groq |
| `GEMINI_API_KEY` | No | Switches on live voice calls. See "Live voice" below |
| `GEMINI_LIVE_MODELS` | No | Live model names to try in order, separated by commas, if Google renames them |

Nothing secret is in the code, the browser or the Sheet's cells. The Sheet stores a scrambled form of each access code, never the code itself.

## Live voice (optional, free)

Live voice makes the teacher sound natural and reply instantly, and lets candidates interrupt, like a real phone call. It uses Google's Gemini Live API.

1. Create a key at aistudio.google.com/apikey, in a project that is not a production project and has no billing.
2. In Vercel, add `GEMINI_API_KEY` with that key, then **Redeploy**.
3. In the site, open **Settings > AI, data and permissions** and click **Test the AI connection**. A green note says "Live voice is ready". A red note shows Google's own error message.
4. Take a test call. The pre-call screen no longer asks for a language, and the consent line names Google.

How it behaves:

- **Automatic fallback.** If live voice cannot start, the call carries on with the standard browser voice. If the line drops mid-call it reconnects up to three times with the conversation so far.
- **Switch.** **Settings > Voice on calls** turns live voice off without removing the key.
- **Scoring is unchanged.** Groq still scores the call, so `GROQ_API_KEY` is still needed.
- **Any modern browser.** Live voice does not need Chrome's speech recognition, so Firefox and Safari work too.

What to know before using it for real hiring:

- **Candidate audio goes to Google.** On the free tier Google may use it to improve its products. The consent line says so. A paid Gemini key removes this.
- **Transcript is not verified.** Google sends the transcript to the candidate's browser, which passes it to the site. A technical candidate could alter it. Reports are marked "Transcript not verified".
- **Free limits are not published.** If the limit is hit, calls fall back to the standard voice.
- **Preview feature.** Google marks the token method as Preview. If Google changes it, live voice stops and calls fall back until the code is updated.

## Intern training (practice calls)

The same site also trains Pre-Sales interns. An intern signs in, picks any of 10 training teachers, has a live voice call of up to 20 minutes, and sees full feedback straight away. Nothing extra is paid for: it uses the same free Gemini and Groq keys.

No change to the Google Sheet script is needed.

1. Open any person under **Candidates** (add the intern first if they are new), and click **Assign a mock call**.
2. Click **Intern practice**. The first time, a Super Admin clicks **Add the training pack**. This adds the 10 training teachers and the practice template, which is marked on the Setter Evaluation Rubric. It only needs doing once.
3. Set the call length (15 minutes by default, up to 20), the practice calls allowed each day (3 by default), and optionally a last date. Untick any teacher the intern should not get.
4. Click **Assign**. Give the intern their access code.

What the intern gets:

- A list of the 10 teachers to choose from, and a count of calls left today. The count resets at midnight India time.
- After each call: a score out of 100 on the Setter Evaluation Rubric (13 sections, 30 criteria), a subtotal for each part of the call, quotes from their own call as evidence, what they said about Suraasa that did not match the verified facts, objections they did not handle, and a training recommendation (Ready for live calls, Nearly ready, Needs more practice, Needs coaching).
- A running summary of scored calls, average and best score.

What the trainer gets: every practice call appears on the person's page with the transcript and report, exactly like a hiring call.

The 10 training teachers are Friendly and Interested, Busy, Skeptical, Budget-Conscious, Experienced, Beginner, Uninterested, Analytical, Frustrated, and Highly Interested. Edit them under **Teachers** like any other teacher. Test each one with **Test this teacher** before interns use it.

Things to know:

- **Live voice needs `GEMINI_API_KEY`.** Without it, practice calls use the browser's own voice, which takes turns and sounds robotic.
- **Long calls.** Google renews a live connection about every 10 minutes. The site opens a new line with the conversation so far, and the teacher carries on without mentioning it. There can be a pause of a second or two at that moment.
- **Free limits.** Google does not publish the free limit for live voice. If it is reached, the call falls back to the browser voice. Twenty-minute calls use the free allowance faster than eight-minute ones, so start with a few interns and watch for fallbacks.
- **Audio recording is optional.** See "Call recording" below. It is off until you switch it on.
- **Verify the product facts first** (Assessments > Product facts). Until then, reports cannot say whether what an intern said about Suraasa was correct.

### The Training page

**Training** in the menu shows every intern with practice access: scored calls, average, best and latest score, whether they are improving (the last three calls against the three before), their weakest skill, and their latest training recommendation. It also shows the skills the whole team is weakest on, and lists interns who have not practised this week, are not improving, or have a call waiting to be scored. "Ready" needs the top band on an intern's last two scored calls. Practice calls are kept out of the hiring Dashboard and Leaderboard.

## Call recording (optional, free)

Live voice calls can be recorded. Both voices are recorded in the caller's browser, sent to the site after the call, and kept in a private folder in your Google Drive called `Setter Assessment recordings`. A 15-minute call is about 2 MB.

To switch it on:

1. Open the Google Sheet, then **Extensions > Apps Script**. Replace everything with the new `apps-script/Code.gs` and save.
2. Click **Deploy > Manage deployments**, the pencil, **Version: New version**, **Deploy**. Do not use **New deployment**, because that changes the link.
3. In the site, open **Settings > AI, data and permissions**, tick **Record live voice calls**, and save. If the script was not updated, the site says so and leaves recording off.

How it behaves:

- **Callers are told.** The consent line before the call says the audio is recorded.
- **Who can listen.** Recruiters and admins, from the call's report, for the candidates they can already see. An intern can listen to their own practice calls. A hiring candidate cannot listen to theirs.
- **Only live voice calls.** Calls on the standard browser voice are not recorded, because the browser does not expose that voice.
- **The call always comes first.** The transcript is saved before the recording is sent. If the recording fails, the call is still scored.
- **Deletion.** Deleting a candidate, or the data retention setting, moves their recordings to the Drive bin. Drive empties its bin after 30 days.
- **Storage.** Recordings count against the Drive storage of the account that owns the Sheet. At 2 MB a call, 1,000 calls is about 2 GB.
- **A reload loses the first part.** If the caller reloads the page mid-call, the recording covers only what came after.

## Limits of the free setup

- **Turn-taking.** Without a headset the candidate waits for "Your turn", because the microphone is paused while the teacher speaks. With a headset they can talk over the teacher.
- **Voices sound robotic.** They come from the candidate's computer. Windows has Indian English and Hindi voices. Other computers may differ.
- **Chrome or Edge on a computer works best.** Firefox is not supported. Phones are unreliable.
- **Hindi.** The candidate chooses "Mostly English" or "Mostly Hindi" and can switch during the call. The browser hears one language at a time, so mixed Hinglish sentences are transcribed less accurately.
- **Mishearings.** The transcript is what the browser heard. The evaluator is told not to mark down garbled words, and recruiters can set a call aside and allow another attempt.
- **Daily capacity.** One Groq free key should cover roughly 20 to 30 calls a day. That is an estimate. Check your real limits at console.groq.com/settings/limits. When the limit is hit mid-call the teacher pauses and retries, and a finished call waits as "Awaiting score" until someone presses **Score this call**.
- **Speed of pages.** Each page load reads the Sheet, which takes one to three seconds. Replies during a call do not wait on the Sheet.
- **Scale.** A Google Sheet is comfortable up to a few thousand calls. Beyond that, set a retention period or move the store to a database (see `docs/ARCHITECTURE.md`).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "This site is not connected to its Google Sheet yet" | Add `APPS_SCRIPT_URL` and `SHEET_SECRET` in Vercel, then redeploy |
| "The Google Sheet rejected the connection secret" | Compare `SHEET_SECRET` with **Setter Assessment > Show connection secret** |
| "The Google Sheet script did not answer correctly" | Set the deployment to **Anyone**. After changing the script, use **Manage deployments**, pencil, **New version** |
| "Nobody has been set up yet" | In the Sheet, click **Setter Assessment > Create first Super Admin** |
| "That email and access code do not match" | Reset the code. A recruiter can do it on the candidate's page, a Super Admin under Settings, or the Sheet owner from the Sheet menu |
| "Too many wrong codes" | Wait 10 minutes |
| "The AI is not set up yet" | Add `GROQ_API_KEY` in Vercel, then redeploy |
| "Groq rejected the API key" | Create a new key, update it in Vercel, redeploy |
| "Live voice is not working yet" in the AI test | Read the Google message shown. A wrong key, the Live API not enabled for the project, or a renamed model are the usual causes |
| "The free AI limit was reached" | Wait, then press **Score this call**. For more capacity, move to a paid Groq plan |
| "Voice calls need Chrome or Edge" | Open the site in one of those on a computer |
| Microphone shows Blocked | Click the lock icon in the address bar and allow the microphone |
| The teacher does not hear the candidate | Check the computer is using the right microphone, then resume the call |
| Many skills say "No evidence" | The model is not quoting the call exactly. Put a stronger model first under Settings |

## If a model is retired

Groq retires models from time to time. The site tries each model in its list in order, so one retirement does not stop calls. To change the list, open **Settings > AI, data and permissions** and enter model names, one per line. Current names are at console.groq.com/docs/models.

## Later changes

- **Teachers, rubric, pass marks, product facts, people:** change them in the site. No code or redeploy is needed.
- **Code changes:** run `npm test`, then `npm run test:e2e`, then commit. Vercel redeploys by itself.
- **If `apps-script/Code.gs` changed:** paste the new file into Apps Script, run `setupSheet` again (it keeps all data and adds any new columns), then **Deploy > Manage deployments**, pencil, **Version: New version**, **Deploy**. Do not use **New deployment**, because that changes the link.
- **Recovery:** daily copies of the Sheet are in the Drive folder `Setter Assessment backups` (newest 14). The Sheet's own **File > Version history** also works.

## The Setter Evaluation Rubric (Master 2.0)

Hiring calls and intern practice calls are both marked on Suraasa's Setter Evaluation Rubric.

| Part | Sections | Marks |
|---|---|---|
| Connecting | C1 Opening & Credibility (8), C2 Profiling Depth (7), C3 Goal Clarity & Transition (5) | 20 |
| Augmenting | A1 Emotional Permission & Visioning (8), A2 Desire Building & Salary Positioning (10), A3 Anchoring the Why (7) | 25 |
| Revealing | R1 Process Positioning (8), R2 Personalization & Gap Clarity (10), R3 Investment Framing & Readiness Check (12) | 30 |
| Ending | E1 Handoff Strength (6), E2 Scarcity & Confirmation (5), E3 Closing Warmth & Homework (4) | 15 |
| Professionalism & Emotional Intelligence | Listening, Tone, Empathy, Authority | 10 |

- Each of the 30 criteria is marked in whole points against its own description from the rubric. 0 means that step never happened on the call.
- Score bands: 85 and above Elite Setter, 70 to 84 Strong Performer, 55 to 69 Developing – Needs Coaching, below 55 Poor Performer – Needs Retraining.
- A section still scores 0 if the AI cannot back it with words the candidate really said.
- The site applies the rubric to the two built-in templates by itself the first time a Super Admin signs in after the update. Templates you created yourself are not touched, and calls already scored keep their old scores.
- You can change any description, mark or band under **Assessments > Templates and marks**.

Three things in the source sheet did not add up, and were settled like this. Change them in the template if you meant otherwise.

1. "Self + Suraasa Credibility" says Max 4 but is described up to 5, and C1 totals 8. It is marked out of 5.
2. "EBANT Extraction" says Max 5 but is described up to 4, and C2 totals 7. It is marked out of 4.
3. A3 gives one 1 to 7 scale for both of its criteria. It is split into Emotional Depth (4) and Transition to Revealing (3).

The AI reads the words of the call, not the sound. It judges tone and energy from wording and from how the teacher responds, so use the recording to check those two marks.

The rubric expects setters to mention a salary range, the 5-step journey and an investment range. Add those under **Assessments > Product facts** and verify them, or the report will list them as "Not in verified facts".
