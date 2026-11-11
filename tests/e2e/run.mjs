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

await step('No JavaScript errors on any page', async () => { assert.deepEqual(errors, []); });

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length} of ${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
