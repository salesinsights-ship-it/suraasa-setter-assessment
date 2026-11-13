/**
 * Browser test of the whole product in real Chrome: sign-in for all three roles, a full voice call
 * (with a simulated microphone and speech engine), scoring, the report, recruiter tools and admin pages,
 * at desktop and phone sizes. Needs Playwright and Chrome.   npm run test:e2e
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from '../sim/dev-server.mjs';
import { GOOD_LINES } from '../sim/world.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright')); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** Replaces the browser's speech engine so the test can "speak" and "hear" on cue. */
const FAKE_SPEECH = () => {
  window.__spoken = []; window.__rec = null; window.__recStarts = 0;
  class FakeRec {
    start() { window.__rec = this; window.__recStarts++; }
    abort() { if (window.__rec === this) window.__rec = null; setTimeout(() => this.onend?.(), 0); }
    stop() { this.abort(); }
  }
  window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
  window.__say = (text, confidence = 0.9) => {
    const r = window.__rec; if (!r) return false;
    const res = [{ transcript: text, confidence }]; res.isFinal = true;
    r.onresult?.({ resultIndex: 0, results: [res] });
    return true;
  };
  const synth = { speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend?.(), 120); }, cancel() {}, getVoices: () => [], addEventListener() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function U(text) { this.text = text; };

  // A stand-in for Google's live voice socket. It speaks the same messages as the real one.
  const RealWS = window.WebSocket;
  window.__live = null; window.__liveUrls = []; window.__liveNotes = [];
  class FakeLive {
    constructor(url) { window.__liveAll = (window.__liveAll || []).concat([this]); this.url = url; this.readyState = 0; this.audio = 0; this.toolResponses = []; window.__live = this; window.__liveUrls.push(url); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 20); }
    send(data) {
      const m = JSON.parse(data);
      if (m.setup) { this.setup = m.setup; this.emit({ setupComplete: {} }); }
      else if (m.realtimeInput?.text) {
        window.__liveNotes.push(m.realtimeInput.text);
        if (/call connected/.test(m.realtimeInput.text)) this.teacher('Hello? Yes, Meenakshi speaking.');
        if (/reconnected/.test(m.realtimeInput.text)) this.teacher('Hello? Sorry, the line dropped. Please go on.');
      } else if (m.realtimeInput?.audio) { this.audio++; this.lastMime = m.realtimeInput.audio.mimeType; this.lastSilent = /^A+=*$/.test(m.realtimeInput.audio.data); if (!this.lastSilent) this.heard = (this.heard || 0) + 1; }
      else if (m.toolResponse) this.toolResponses.push(m.toolResponse);
    }
    emit(obj) { this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(obj)).buffer }); }
    teacher(text, end) {
      this.emit({ serverContent: { outputTranscription: { text } } });
      this.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(String.fromCharCode(...new Uint8Array(4800))) } }] } } });
      this.emit({ serverContent: { turnComplete: true } });
      if (end) this.emit({ toolCall: { functionCalls: [{ id: 'f' + Date.now(), name: 'end_call', args: {} }] } });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  }
  window.WebSocket = function WS(url, protocols) { return String(url).startsWith('wss://generativelanguage') ? new FakeLive(url) : new RealWS(url, protocols); };
  window.__liveSay = (text, reply, end) => { const l = window.__live; l.emit({ serverContent: { inputTranscription: { text } } }); l.teacher(reply, end); };
};

const results = [];
let dead = false;
async function step(name, fn) {
  if (dead && process.env.BAIL) { results.push(['FAIL', name, new Error('skipped')]); return; }
  try { await fn(); results.push(['ok', name]); console.log('  ok   ' + name); } catch (e) { dead = true; results.push(['FAIL', name, e]); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 4).join('\n       ')); }
}

const { server, world, url } = await startServer({ port: 4311, quiet: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
const errors = [];

async function open(viewport = { width: 1320, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'], acceptDownloads: true });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|net::ERR/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Microphone failed during the test' : undefined));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
const noOverflow = async (page, label) => { const w = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]); assert.ok(w[0] <= w[1] + 1, `${label}: page is wider than the screen (${w[0]} > ${w[1]})`); };
async function signIn(page, email, code) {
  await page.fill('input[type=email]', email); await page.fill('input[autocomplete=current-password]', code);
  await page.click('button[type=submit]');
}
const state = (page) => page.getAttribute('[data-testid=phone]', 'data-state');
const waitState = (page, s) => page.waitForSelector(`[data-testid=phone][data-state=${s}]`, { timeout: 15000 });
async function say(page, text) {
  await waitState(page, 'listening');
  await page.waitForFunction(() => !!window.__rec);
  assert.equal(await page.evaluate((t) => window.__say(t), text), true);
  // wait until the pause has been detected and the turn has left the browser
  await page.waitForFunction(() => { const p = document.querySelector('[data-testid=phone]'); return !p || p.dataset.state !== 'listening'; });
}
async function readyAndStart(page) {
  await page.click('text=Get ready for the call');
  await page.click('text=Check microphone');
  await page.waitForSelector('text=Microphone is allowed');
  await page.check('[data-testid=consent]');
  await page.click('[data-testid=start-call]');
  await page.waitForSelector('[data-testid=phone]');
}

let recruiterCode; let candCode; let cand2Code; let sessionId;
const admin = await open();

await step('Login page shows, a wrong code is refused in plain words', async () => {
  await admin.waitForSelector('text=A real conversation, assessed fairly.');
  await shot(admin, '01-login');
  await signIn(admin, world.admin.email, 'WRONG-CODE1');
  await admin.waitForSelector('text=do not match');
});

await step('Super Admin signs in; first run creates 10 teachers and the rubric', async () => {
  await signIn(admin, world.admin.email, world.admin.code);
  await admin.waitForSelector('[data-testid=stats]');
  await admin.waitForSelector('text=No Suraasa product facts are verified yet');
  await admin.click('a.nav:has-text("Teachers")');
  await admin.waitForSelector('[data-testid=teacher-card]');
  assert.equal(await admin.locator('[data-testid=teacher-card]').count(), 10);
  await shot(admin, '02-teachers');
});

await step('Admin tests a teacher in the preview without saving anything', async () => {
  await admin.click('[data-testid=teacher-card]:has-text("Farhan Qureshi")');
  await admin.click('text=Start a test call');
  await admin.waitForSelector('[data-testid=preview-chat] p.t');
  await admin.fill('input[aria-label="Your line"]', 'Hello sir, I am calling from Suraasa.');
  await admin.click('.modal button:has-text("Send")');
  await admin.waitForFunction(() => document.querySelectorAll('[data-testid=preview-chat] p').length === 3);
  await shot(admin, '03-teacher-editor');
  await admin.click('.modal button:has-text("Close")');
});

await step('Admin adds a new teacher and it appears as the 11th', async () => {
  await admin.click('[data-testid=new-teacher]');
  const m = admin.locator('.modal');
  await m.locator('label:has-text("Name") input').first().fill('Kavita Rao');
  await m.locator('label:has-text("Profile shown to the candidate") textarea').fill('Teaches Art to Grades 1 to 5 in Mysuru.');
  await m.locator('label:has-text("Personality") textarea').fill('Cheerful and talkative.');
  await m.locator('label:has-text("Objections") textarea').fill('I am not sure I need this.\nIs it expensive?');
  await m.locator('button:has-text("Save teacher")').click();
  await admin.waitForFunction(() => document.querySelectorAll('[data-testid=teacher-card]').length === 11);
});

await step('Admin verifies a product fact and opens the template editor', async () => {
  await admin.click('a.nav:has-text("Assessments")');
  await admin.click('[data-testid=template-card]');
  await admin.waitForSelector('text=100 of 100 marks');
  await shot(admin, '04-template');
  await admin.click('.modal button:has-text("Close")');
  await admin.click('button.tab:has-text("Product facts")');
  await admin.locator('[data-testid=facts] tr:has-text("Duration") button:has-text("Verify")').click();
  await admin.waitForSelector('[data-testid=facts] tr:has-text("Duration") .badge.good');
  await admin.click('button.tab:has-text("Calibration")');
  await admin.waitForSelector('text=No human reviews yet');
});

await step('Admin adds a recruiter and receives a one-time access code', async () => {
  await admin.click('a.nav:has-text("Settings")');
  await admin.click('text=Add a recruiter or admin');
  await admin.locator('.modal label:has-text("Full name") input').fill('Ravi Recruiter');
  await admin.locator('.modal input[type=email]').fill('ravi@suraasa.com');
  await admin.click('text=Add and create access code');
  recruiterCode = (await admin.textContent('[data-testid=access-code]')).trim();
  assert.match(recruiterCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await admin.click('.modal button:has-text("Done")');
  await admin.click('button.tab:has-text("AI, data and permissions")');
  await admin.click('text=Test the AI connection');
  await admin.waitForSelector('text=Your key can use 2 models');
});

const rec = await open();
await step('Recruiter signs in, adds two candidates and assigns mock calls', async () => {
  await signIn(rec, 'ravi@suraasa.com', recruiterCode);
  await rec.waitForSelector('[data-testid=stats]');
  await rec.click('a.nav:has-text("Settings")');
  await rec.waitForSelector('text=Settings are managed by a Super Admin');
  for (const [name, email] of [['Rohan Verma', 'rohan@example.com'], ['Simran Kaur', 'simran@example.com']]) {
    await rec.click('a.nav:has-text("Candidates")');
    await rec.click('[data-testid=add-candidate]');
    await rec.locator('.modal label:has-text("Full name") input').fill(name);
    await rec.locator('.modal input[type=email]').fill(email);
    await rec.click('.modal button:has-text("Add candidate")');
    const code = (await rec.textContent('[data-testid=access-code]')).trim();
    if (name.startsWith('Rohan')) candCode = code; else cand2Code = code;
    await rec.click('.modal button:has-text("Done")');
    await rec.click(`tr:has-text("${name}")`);
    await rec.click('[data-testid=assign]');
    await rec.selectOption('[data-testid=persona-mode]', 'fixed');
    await rec.locator('.modal label.card:has-text("Busy Teacher") input').check();
    await rec.locator('.modal label:has-text("Attempts allowed") input').fill('2');
    if (name.startsWith('Rohan')) await shot(rec, '05-assign');
    await rec.click('.modal button:has-text("Assign")');
    await rec.waitForSelector('td:has-text("Meenakshi Iyer")');
  }
});

const cand = await open();
await step('Candidate signs in and sees only their own assessment, with no hidden teacher details', async () => {
  await signIn(cand, 'rohan@example.com', candCode);
  await cand.waitForSelector('[data-testid=assignment]');
  const text = await cand.textContent('body');
  assert.ok(text.includes('Meenakshi Iyer') && text.includes('2 of 2 attempts left'));
  for (const hidden of ['Can you call me later', 'Opening, attention retention', 'Simran']) assert.ok(!text.includes(hidden), hidden);
  await shot(cand, '06-candidate-home');
});

await step('Pre-call check: microphone, language, consent', async () => {
  await cand.click('text=Get ready for the call');
  await cand.waitForSelector('text=Before you call');
  assert.ok(await cand.isDisabled('[data-testid=start-call]'));
  await cand.click('text=Check microphone');
  await cand.waitForSelector('text=Microphone is allowed');
  await cand.check('[data-testid=consent]');
  await shot(cand, '07-precall');
  await cand.click('[data-testid=start-call]');
});

await step('Call connects: rings, teacher speaks first out loud, then listens', async () => {
  await cand.waitForSelector('[data-testid=phone]');
  await waitState(cand, 'listening');
  const spoken = await cand.evaluate(() => window.__spoken);
  assert.ok(spoken.length >= 1 && /Meenakshi|class/i.test(spoken.join(' ')));
  const body = await cand.textContent('[data-testid=phone]');
  assert.ok(body.includes('Meenakshi Iyer') && body.includes('Connected') && body.includes('min left'));
  for (const hidden of ['objection', 'rubric', 'Opening and Introduction']) assert.ok(!body.toLowerCase().includes(hidden.toLowerCase()));
  await shot(cand, '08-call');
});

await step('Mute stops the microphone; unmute brings it back', async () => {
  await cand.click('button:has-text("Mute")');
  await waitState(cand, 'muted');
  assert.equal(await cand.evaluate(() => window.__say('this should not be heard')), false);
  await cand.click('button:has-text("Unmute")');
  await waitState(cand, 'listening');
});

await step('A dropped connection mid-call shows Reconnecting and recovers without losing the turn', async () => {
  world.failTurns = 2;
  await say(cand, GOOD_LINES[0]);
  await waitState(cand, 'reconnecting');
  await waitState(cand, 'listening');
  assert.equal(await cand.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('sa.call.'))[1]).items.length), 3);
  assert.ok((await cand.evaluate(() => window.__spoken.join(' '))).includes('what is this about'));
});

await step('Reloading the page mid-call offers to resume, and the call carries on', async () => {
  await say(cand, GOOD_LINES[1]);
  await waitState(cand, 'listening');
  await cand.reload();
  await cand.waitForSelector('text=You have a call in progress');
  await cand.click('text=Resume the call');
  await waitState(cand, 'listening');
  const saved = await cand.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('sa.call.'))[1]).items.length);
  assert.equal(saved, 5);
});

await step('Call completes when the teacher hangs up; it is scored and the candidate sees permitted feedback only', async () => {
  for (const line of GOOD_LINES.slice(2)) await say(cand, line);
  await cand.waitForSelector('text=Your call result', { timeout: 20000 });
  await cand.waitForSelector('.ringscore');
  const text = await cand.textContent('body');
  assert.ok(text.includes('65.5') && text.includes('Strengths'));
  for (const hidden of ['hiring recommendation', 'Detailed evaluation', 'Conduct', 'Borderline']) assert.ok(!text.includes(hidden), hidden);
  assert.ok(!/Recommended(?! next practice)/.test(text), 'the AI recommendation must not be shown to a candidate');
  assert.equal(await cand.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sa.call.')).length), 0);
  sessionId = (await cand.evaluate(() => location.hash)).split('/').pop();
  await shot(cand, '09-candidate-result');
  await cand.click('text=Back to your dashboard');
  await cand.waitForSelector('text=1 of 2 attempts left');
});

await step('A call ended too early is not scored and does not use an attempt', async () => {
  await readyAndStart(cand);
  await say(cand, 'Hello, this is Rohan.');
  await waitState(cand, 'listening');
  await cand.click('[data-testid=end-call]');
  await cand.waitForSelector('text=too short to be assessed');
  await cand.click('text=Back to your dashboard');
  await cand.waitForSelector('text=1 of 2 attempts left');
});

await step('A candidate cannot open another candidate\'s result or any recruiter page', async () => {
  const other = await open();
  await signIn(other, 'simran@example.com', cand2Code);
  await other.waitForSelector('[data-testid=assignment]');
  await other.goto(url + '/#/result/' + sessionId);
  await other.waitForSelector('text=You do not have access to that call');
  await other.goto(url + '/#/leaderboard');
  await other.waitForSelector('[data-testid=assignment]');
  // second candidate takes a call with a misleading claim, for the comparison
  await readyAndStart(other);
  const lines = [...GOOD_LINES]; lines[2] = 'We guarantee you a job in Dubai within three months, one hundred percent.';
  for (const line of lines) await say(other, line);
  await other.waitForSelector('text=Your call result', { timeout: 20000 });
  await other.context().close();
});

await step('Phone-sized screen: the call screen and dashboard fit without sideways scrolling', async () => {
  const m = await open({ width: 390, height: 844 });
  await signIn(m, 'rohan@example.com', candCode);
  await m.waitForSelector('[data-testid=assignment]');
  await noOverflow(m, 'candidate home');
  await readyAndStart(m);
  await waitState(m, 'listening');
  await noOverflow(m, 'call screen');
  await shot(m, '10-mobile-call');
  for (const line of GOOD_LINES) await say(m, line);
  await m.waitForSelector('text=Your call result', { timeout: 20000 });
  await noOverflow(m, 'result');
  await m.context().close();
  const r = await open({ width: 390, height: 844 });
  await signIn(r, 'ravi@suraasa.com', recruiterCode);
  await r.waitForSelector('[data-testid=stats]');
  await noOverflow(r, 'recruiter dashboard');
  await shot(r, '11-mobile-dashboard');
  for (const p of ['candidates', 'leaderboard', 'teachers', 'assessments']) { await r.goto(url + '/#/' + p); await r.waitForSelector('h1'); await noOverflow(r, p); }
  await r.context().close();
});

await step('Recruiter dashboard counts are right', async () => {
  await rec.goto(url + '/#/');
  await rec.reload();
  await rec.waitForSelector('[data-testid=stats]');
  const stats = await rec.locator('[data-testid=stats] .stat').allTextContents();
  const get = (label) => stats.find((s) => s.includes(label));
  assert.ok(get('Total candidates').startsWith('2'));
  assert.ok(get('Mock calls completed').startsWith('3'), get('Mock calls completed'));
  assert.ok(get('Highest score').startsWith('65.5'));
  await shot(rec, '12-dashboard');
});

await step('Leaderboard sorts, filters by date, and compares two candidates', async () => {
  await rec.click('a.nav:has-text("Leaderboard")');
  await rec.waitForSelector('[data-testid=leaderboard]');
  assert.equal(await rec.locator('[data-testid=leaderboard] tbody tr').count(), 2);
  await rec.click('th:has-text("Candidate")');
  assert.ok((await rec.locator('[data-testid=leaderboard] tbody tr').first().textContent()).includes('Rohan'));
  await rec.locator('label:has-text("Assessed from") input').fill('2099-01-01');
  await rec.waitForSelector('text=No scored calls match');
  await rec.click('text=Clear filters');
  await rec.waitForSelector('[data-testid=leaderboard]');
  await shot(rec, '13-leaderboard');
  const dl = rec.waitForEvent('download');
  await rec.click('text=Download CSV');
  const csv = fs.readFileSync(await (await dl).path(), 'utf8');
  assert.ok(csv.includes('Rohan Verma') && csv.includes('Simran Kaur') && csv.includes('Borderline'));
  for (const box of await rec.locator('[data-testid=leaderboard] input[type=checkbox]').all()) await box.check();
  await rec.click('[data-testid=compare]');
  await rec.waitForSelector('text=Compare candidates');
  const text = await rec.textContent('table');
  assert.ok(text.includes('Objection Handling') && text.includes('Conduct concern'));
  await shot(rec, '14-compare');
});

await step('Report shows all 10 parameters with evidence, the transcript, and a downloadable transcript', async () => {
  await rec.goto(url + '/#/session/' + sessionId);
  await rec.waitForSelector('text=AI hiring recommendation');
  assert.equal(await rec.locator('[data-testid=param]').count(), 10);
  const text = await rec.textContent('main');
  for (const need of ['65.5', 'Recommended', 'Rohan Verma', 'SUR-0001', 'Meenakshi Iyer', 'Best response', 'Strengths', 'Practice exercises', 'A better response', 'Recommended next practice', 'Candidate, turn']) assert.ok(text.includes(need), need);
  await shot(rec, '15-report');
  await rec.click('button.tab:has-text("Transcript")');
  await rec.waitForSelector('.tline.c');
  assert.equal(await rec.locator('.tline.c').count(), 5);
  const dl = rec.waitForEvent('download');
  await rec.click('text=Download transcript');
  assert.ok(fs.readFileSync(await (await dl).path(), 'utf8').includes('Candidate (C1): Hello ma\'am, this is Rohan'));
});

await step('Recruiter must give a reason to override the AI; the decision is recorded', async () => {
  await rec.click('button.tab:has-text("Your decision")');
  await rec.selectOption('[data-testid=decision]', 'Not Recommended');
  await rec.click('[data-testid=save-decision]');
  await rec.waitForSelector('.toast.bad:has-text("Give a reason")');
  await rec.fill('[data-testid=reason]', 'Did not explore the teacher\'s goals before pitching.');
  await rec.click('[data-testid=save-decision]');
  await rec.waitForSelector('text=Changed from the AI\'s: Recommended');
});

await step('Human review is saved and appears under Calibration; setting a call aside returns the attempt', async () => {
  await rec.click('text=Score it yourself');
  for (const input of await rec.locator('.modal input[type=number]').all()) await input.fill('5');
  await rec.click('.modal button:has-text("Save review")');
  await rec.waitForSelector('text=Edit your review');
  await rec.goto(url + '/#/assessments');
  await rec.click('button.tab:has-text("Calibration")');
  await rec.waitForSelector('text=Calls reviewed by a person');
  await shot(rec, '16-calibration');
  await rec.goto(url + '/#/session/' + sessionId);
  await rec.click('button:has-text("Set aside")');
  await rec.waitForSelector('text=This attempt was set aside');
  await rec.click('button:has-text("Count this attempt")');
  await rec.waitForSelector('button:has-text("Set aside")');
});

await step('Admin sees every action in the audit log', async () => {
  await admin.click('a.nav:has-text("Settings")');
  await admin.click('button.tab:has-text("Audit log")');
  await admin.waitForSelector('[data-testid=audit]');
  const text = await admin.textContent('[data-testid=audit]');
  for (const a of ['signin', 'candidate.create', 'assignment.create', 'call.start', 'call.end', 'call.score', 'decision.override', 'review.human', 'call.void', 'knowledge.verified', 'persona.create', 'report.view']) assert.ok(text.includes(a), a);
  await shot(admin, '17-audit');
});

await step('Signing out returns to the login page and the session is gone', async () => {
  await rec.click('.side button:has-text("Sign out")');
  await rec.waitForSelector('text=Sign in');
  assert.equal(await rec.evaluate(() => sessionStorage.getItem('sa.session')), null);
});

await step('Live voice call: token from the server, audio streams, early hang-up refused, line drop recovers, call is scored and marked not verified', async () => {
  world.enableLive();
  const adminToken = await world.signIn(world.admin.email, world.admin.code);
  const made = await world.rpc('saveCandidate', { name: 'Live Tester', email: 'live@example.com' }, adminToken);
  await world.rpc('saveAssignment', { candidate_id: made.id, template_id: 't_default', persona_mode: 'fixed', persona_ids: ['p01'] }, adminToken);
  const lp = await open();
  await signIn(lp, 'live@example.com', made.access_code);
  await lp.waitForSelector('[data-testid=assignment]');
  await lp.click('text=Get ready for the call');
  await lp.click('text=Check microphone');
  await lp.waitForSelector('text=Microphone is allowed');
  assert.ok((await lp.textContent('body')).includes('sent to Google'), 'consent must name Google for live voice');
  await lp.check('[data-testid=consent]');
  await lp.click('[data-testid=start-call]');
  await waitState(lp, 'listening');
  const first = await lp.evaluate(() => ({ url: window.__liveUrls[0], setup: Object.keys(window.__live.setup), notes: window.__liveNotes }));
  assert.match(first.url, /BidiGenerateContentConstrained\?access_token=auth_tokens/);
  assert.deepEqual(first.setup, ['model'], 'the browser must not send or hold the teacher instructions');
  assert.deepEqual(first.notes, ['[call connected]']);
  await lp.waitForFunction(() => window.__live.audio >= 3, null, { timeout: 15000 });
  assert.equal(await lp.evaluate(() => window.__live.lastMime), 'audio/pcm;rate=16000');
  await shot(lp, '18-live-call');
  // the teacher tries to hang up after one line: refused
  await lp.evaluate((l) => window.__liveSay(l, 'I am busy, bye.', true), GOOD_LINES[0]);
  await lp.waitForFunction(() => window.__live.toolResponses.length === 1);
  assert.ok(await lp.evaluate(() => !!window.__live.toolResponses[0].functionResponses[0].response.error));
  await lp.waitForSelector('[data-testid=phone]');
  // the line drops and comes back with the conversation so far
  await lp.evaluate(() => window.__live.close());
  await lp.waitForFunction(() => window.__liveUrls.length === 2 && window.__liveNotes.includes('[call reconnected]'), null, { timeout: 15000 });
  const tokenCall = world.gemini.state.calls.at(-1).body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert.ok(tokenCall.includes('Caller: ' + GOOD_LINES[0]));
  await waitState(lp, 'listening');
  for (const line of GOOD_LINES.slice(1, 4)) await lp.evaluate((l) => window.__liveSay(l, 'Hmm, I see. Go on.'), line);
  await lp.evaluate((l) => window.__liveSay(l, 'Okay, tomorrow at five. Bye.', true), GOOD_LINES[4]);
  await lp.waitForSelector('text=Your call result', { timeout: 25000 });
  await lp.waitForSelector('.ringscore');
  const home = await world.rpc('adminHome', {}, adminToken);
  const sess = home.sessions.find((x) => x.candidate_id === made.id);
  assert.equal(sess.mode, 'live'); assert.equal(sess.status, 'scored'); assert.equal(sess.flags.unverified, true);
  assert.equal(sess.candidate_turns, 5);
  const view = await world.rpc('getSession', { session_id: sess.id }, adminToken);
  assert.equal(view.transcript[0].x, 'Hello? Yes, Meenakshi speaking.');
  assert.ok(view.transcript.some((it) => it.r === 'c' && it.x === GOOD_LINES[2]));
  await lp.context().close();
});

await step('Live voice unavailable: the call falls back to the standard voice by itself', async () => {
  const adminToken = await world.signIn(world.admin.email, world.admin.code);
  const made = await world.rpc('saveCandidate', { name: 'Fallback Tester', email: 'fallback@example.com' }, adminToken);
  await world.rpc('saveAssignment', { candidate_id: made.id, template_id: 't_default', persona_mode: 'fixed', persona_ids: ['p01'] }, adminToken);
  world.gemini.state.mode = 'down';
  const fp = await open();
  await signIn(fp, 'fallback@example.com', made.access_code);
  await fp.waitForSelector('[data-testid=assignment]');
  await readyAndStart(fp);
  await waitState(fp, 'listening');
  assert.ok(/Meenakshi|class/.test(await fp.evaluate(() => window.__spoken.join(' '))), 'the standard voice spoke the greeting');
  for (const line of GOOD_LINES) await say(fp, line);
  await fp.waitForSelector('text=Your call result', { timeout: 25000 });
  const home = await world.rpc('adminHome', {}, adminToken);
  const sess = home.sessions.find((x) => x.candidate_id === made.id);
  assert.equal(sess.flags.unverified, false, 'a fallback call is fully signed by the server');
  world.gemini.state.mode = 'ok';
  await fp.context().close();
});

await step('Intern practice: admin adds the training pack and gives practice access; the intern picks a teacher, the long call renews its line silently, and feedback shows a training recommendation', async () => {
  const adminToken = await world.signIn(world.admin.email, world.admin.code);
  const made = await world.rpc('saveCandidate', { name: 'Isha Intern', email: 'isha@example.com' }, adminToken);
  const ap = await open();
  await signIn(ap, world.admin.email, world.admin.code);
  await ap.waitForSelector('[data-testid=stats]');
  await ap.evaluate((id) => { window.location.hash = '#/candidates/' + id; }, made.id);
  await ap.click('[data-testid=assign]');
  await ap.click('[data-testid=kind-practice]');
  await ap.click('[data-testid=install-training]');
  await ap.waitForFunction(() => document.querySelectorAll('.modal label.card input:checked').length === 10, null, { timeout: 15000 });
  assert.equal(await ap.locator('[data-testid=install-training]').count(), 0, 'the pack notice goes once it is added');
  assert.equal(await ap.inputValue('.modal label:has-text("Call length") input'), '15');
  await shot(ap, '20-assign-practice');
  await ap.click('.modal button:has-text("Assign")');
  await ap.waitForSelector('td:has-text("Practice, 10 teachers")');
  await ap.context().close();

  assert.ok((await world.rpc('saveConfig', { config: { record_audio: true } }, adminToken)).ok);
  const ip = await open();
  await signIn(ip, 'isha@example.com', made.access_code);
  await ip.waitForSelector('[data-testid=assignment]');
  const text = await ip.textContent('body');
  assert.ok(text.includes('Practice with an AI teacher') && text.includes('3 of 3 calls left today') && text.includes('Ayesha Khan') && text.includes('Harpreet Sandhu'));
  assert.ok(!text.includes('Salary has barely moved'), 'hidden teacher details stay on the server');
  assert.ok(await ip.isDisabled('button:has-text("Get ready for the call")'), 'a teacher must be picked first');
  await ip.click('button.card:has-text("Rekha Nair")');
  await shot(ip, '21-intern-home');
  await ip.click('text=Get ready for the call');
  await ip.click('text=Check microphone');
  await ip.waitForSelector('text=Microphone is allowed');
  assert.ok((await ip.textContent('body')).includes('practice calls left today') && (await ip.textContent('body')).includes('training team'));
  assert.ok((await ip.textContent('body')).includes('audio of this call is recorded'), 'the caller is told about recording before the call');
  await ip.check('[data-testid=consent]');
  await ip.click('[data-testid=start-call]');
  await waitState(ip, 'listening');
  assert.ok((await ip.textContent('[data-testid=phone]')).includes('Rekha Nair'));
  await ip.evaluate((l) => window.__liveSay(l, 'Hmm. Go on.'), GOOD_LINES[0]);
  // Google warns that the connection is about to be renewed: a new line opens with the talk so far, and nobody says "the line dropped"
  const before = await ip.evaluate(() => window.__liveUrls.length);
  await ip.evaluate(() => window.__live.emit({ goAway: { timeLeft: '50s' } }));
  await ip.waitForFunction((n) => window.__liveUrls.length === n + 1 && window.__live.audio >= 2, before, { timeout: 15000 });
  assert.ok(!(await ip.evaluate(() => window.__liveNotes.slice(-1)[0] || '')).includes('reconnected'), 'a planned renewal is silent');
  const renewed = world.gemini.state.calls.at(-1).body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert.ok(renewed.includes('Do not greet again') && renewed.includes('Caller: ' + GOOD_LINES[0]));
  assert.equal(await state(ip), 'listening');
  for (const line of [...GOOD_LINES.slice(1, 4), 'Before we fix that, may I confirm the number I should share with the counsellor?']) await ip.evaluate((l) => window.__liveSay(l, 'Hmm, I see. Go on.'), line);
  await ip.evaluate((l) => window.__liveSay(l, 'Fine, I will speak to the counsellor. Bye.', true), GOOD_LINES[4]);
  await ip.waitForSelector('text=Your call result', { timeout: 25000 });
  await ip.waitForSelector('[data-testid=recommendation]');
  const result = await ip.textContent('body');
  assert.ok(result.includes('Training recommendation') && !result.includes('hiring recommendation'));
  assert.equal(await ip.locator('[data-testid=param]').count(), 8);
  await shot(ip, '22-intern-result');
  // the recording made in the browser reached Drive in pieces and plays back from the result page
  const folder = [...world.gas.folders.values()].find((f) => f.getId().includes('recordings'));
  assert.ok(folder && folder.files.length >= 1, 'recording pieces were stored');
  assert.ok(folder.files[0].blob.bytes.length > 500, 'the recording holds real audio data');
  await ip.click('[data-testid=load-recording]');
  await ip.waitForSelector('[data-testid=recording-audio]');
  const audio = await ip.evaluate(async () => { const a = document.querySelector('[data-testid=recording-audio]'); const b = await (await fetch(a.src)).blob(); return { size: b.size, type: b.type }; });
  assert.ok(audio.size > 500 && audio.type.startsWith('audio/'), JSON.stringify(audio));
  const home = await world.rpc('adminHome', {}, adminToken);
  const sess = home.sessions.find((x) => x.candidate_id === made.id);
  assert.equal(sess.tech.reconnects, 0, 'a planned renewal is not counted as a connection problem');
  await ip.click('text=Back to your dashboard');
  await ip.waitForSelector('[data-testid=progress]');
  assert.ok((await ip.textContent('body')).includes('2 of 3 calls left today'));
  await shot(ip, '23-intern-progress');
  await ip.context().close();
});

await step('Training page: trainers see each intern\'s practice, the team\'s weakest skills and the recording; hiring pages leave practice out', async () => {
  const tp = await open();
  await signIn(tp, world.admin.email, world.admin.code);
  await tp.waitForSelector('[data-testid=stats]');
  const before = await tp.textContent('[data-testid=stats]');
  await tp.click('a.nav:has-text("Training")');
  await tp.waitForSelector('[data-testid=training-table]');
  const row = await tp.textContent('[data-testid=training-table] tbody tr:has-text("Isha Intern")');
  assert.ok(row.includes('63') && row.includes('Needs more practice') && row.includes('Discovery and questioning'), row);
  assert.ok((await tp.textContent('[data-testid=training-stats]')).includes('Interns with practice access'));
  assert.equal(await tp.locator('[data-testid=team-skills] .bar').count(), 8);
  await shot(tp, '24-training');
  await tp.click('a.nav:has-text("Leaderboard")');
  await tp.waitForSelector('h1:has-text("Leaderboard")');
  assert.ok(!(await tp.textContent('main')).includes('Isha Intern'), 'practice calls stay off the hiring leaderboard');
  await tp.click('a.nav:has-text("Training")');
  await tp.click('[data-testid=training-table] tbody tr:has-text("Isha Intern")');
  await tp.waitForSelector('[data-testid=recording]');
  await tp.click('[data-testid=load-recording]');
  await tp.waitForSelector('[data-testid=recording-audio]');
  await shot(tp, '25-session-recording');
  await tp.click('a.nav:has-text("Settings")');
  await tp.click('text=AI, data and permissions');
  assert.equal(await tp.isChecked('[data-testid=record-audio]'), true);
  assert.ok(before.length > 0);
  await tp.context().close();
});

await step('One voice only: pressing Start twice opens one line, a renewed line closes the old one, and without a headset the teacher never hears itself', async () => {
  const adminToken = await world.signIn(world.admin.email, world.admin.code);
  const made = await world.rpc('saveCandidate', { name: 'Echo Tester', email: 'echo@example.com' }, adminToken);
  await world.rpc('saveAssignment', { candidate_id: made.id, template_id: 't_default', persona_mode: 'fixed', persona_ids: ['p01'] }, adminToken);
  const ep = await open();
  await signIn(ep, 'echo@example.com', made.access_code);
  await ep.waitForSelector('[data-testid=assignment]');
  await ep.click('text=Get ready for the call');
  await ep.click('text=Check microphone');
  await ep.waitForSelector('text=Microphone is allowed');
  await ep.check('[data-testid=consent]');
  // an impatient double press
  await ep.evaluate(() => { const b = document.querySelector('[data-testid=start-call]'); b.click(); b.click(); });
  await waitState(ep, 'listening');
  await ep.waitForTimeout(600);
  assert.equal(await ep.evaluate(() => window.__liveUrls.length), 1, 'two presses must open one line');
  // no headset: while the teacher is speaking, the microphone sends silence, so the teacher cannot hear its own voice
  await ep.waitForFunction(() => window.__live.heard >= 2, null, { timeout: 15000 });
  await ep.evaluate(() => { const l = window.__live; l.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'A'.repeat(192000) } }] } } }); });
  await ep.waitForTimeout(700);
  const during = await ep.evaluate(() => { const l = window.__live; const h = l.heard; return new Promise((res) => setTimeout(() => res({ silent: l.lastSilent, more: l.heard - h }), 800)); });
  assert.deepEqual(during, { silent: true, more: 0 }, 'the microphone must be silent while the teacher speaks');
  await ep.waitForFunction(() => window.__live.lastSilent === false, null, { timeout: 15000 });
  // the line is renewed: exactly one connection is left open afterwards
  await ep.evaluate((l) => window.__liveSay(l, 'Hmm. Go on.'), GOOD_LINES[0]);
  await ep.evaluate(() => window.__live.emit({ goAway: { timeLeft: '50s' } }));
  await ep.waitForFunction(() => window.__liveUrls.length === 2, null, { timeout: 15000 });
  await ep.waitForTimeout(500);
  assert.equal(await ep.evaluate(() => window.__liveAll.filter((x) => x.readyState !== 3).length), 1, 'the old line must be closed');
  await ep.click('[data-testid=end-call]');
  await ep.waitForFunction(() => window.__liveAll.every((x) => x.readyState === 3), null, { timeout: 15000 });
  await ep.context().close();
});

await step('No JavaScript errors on any page', async () => { assert.deepEqual(errors, []); });

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length} of ${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
