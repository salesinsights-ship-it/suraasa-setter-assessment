/**
 * Suraasa Setter Assessment: Google Sheet storage.
 *
 * This script is a locked data store. It answers only requests that carry the
 * connection secret, and the secret is known only to the website's server.
 * All sign-in and permission checks happen on that server (server/handlers.js).
 * Nobody can read or change data by opening the script link in a browser.
 */

var API_VERSION = 1;

var TABS = {
  Users: ['id', 'email', 'name', 'role', 'active', 'code_hash', 'created_at', 'created_by', 'last_login'],
  Candidates: ['id', 'user_id', 'code', 'name', 'email', 'phone', 'role_applied', 'recruiter_id', 'status', 'source', 'notes', 'created_at', 'created_by'],
  Personas: ['id', 'active', 'name', 'difficulty', 'data', 'updated_at', 'updated_by'],
  Templates: ['id', 'active', 'name', 'version', 'data', 'updated_at', 'updated_by'],
  Assignments: ['id', 'candidate_id', 'template_id', 'persona_mode', 'persona_ids', 'level', 'duration_min', 'attempts', 'allow_typed', 'due', 'status', 'created_at', 'created_by'],
  Sessions: ['id', 'assignment_id', 'candidate_id', 'persona_id', 'template_id', 'template_version', 'level', 'mode', 'lang',
    'started_at', 'ended_at', 'duration_sec', 'status', 'end_reason', 'candidate_turns', 'candidate_words', 'tech',
    'total', 'percent', 'category', 'recommendation', 'scores', 'coverage', 'flags', 'scored_at', 'engine',
    'voided', 'void_reason', 'human', 'purged'],
  Transcripts: ['key', 'part', 'data'],
  Reports: ['key', 'part', 'data'],
  Decisions: ['id', 'candidate_id', 'session_id', 'recruiter_id', 'decision', 'ai_recommendation', 'reason', 'at'],
  Knowledge: ['id', 'topic', 'fact', 'source', 'status', 'updated_at', 'updated_by'],
  Config: ['id', 'value', 'updated_at', 'updated_by'],
  AuditLog: ['id', 'at', 'actor_id', 'actor_role', 'action', 'target', 'detail']
};
var BLOB_TABS = { Transcripts: true, Reports: true };
var CELL_LIMIT = 45000;

/* ------------------------------------------------------------------ menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Setter Assessment')
    .addItem('1. Set up this Sheet', 'setupSheet')
    .addItem('2. Create first Super Admin', 'createFirstAdmin')
    .addItem('3. Turn on daily backup and clean-up', 'installDailyJobs')
    .addSeparator()
    .addItem('Show connection secret', 'showSecret')
    .addItem('Reset someone\'s access code', 'resetAccessCode')
    .addItem('Back up now', 'backupNow')
    .addToUi();
}

function setupSheet() {
  ensureTabs_();
  var secret = ensureSecret_();
  try {
    SpreadsheetApp.getUi().alert(
      'Sheet is ready',
      'All tabs are in place.\n\nConnection secret (add it in Vercel as SHEET_SECRET):\n\n' + secret +
      '\n\nKeep it private. Anyone with this secret and the script link can read candidate data.\n\n' +
      'Next: Setter Assessment > Create first Super Admin.',
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* run from the editor without a UI */ }
  return 'ok';
}

function ensureTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var name in TABS) {
    var want = TABS[name];
    var s = ss.getSheetByName(name) || ss.insertSheet(name);
    var have = header_(s);
    var add = [];
    for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) < 0) add.push(want[i]);
    if (add.length) {
      var need = have.length + add.length;
      if (need > s.getMaxColumns()) s.insertColumnsAfter(s.getMaxColumns(), need - s.getMaxColumns());
      s.getRange(1, have.length + 1, 1, add.length).setValues([add]);
    }
    // Plain text everywhere, so nothing a person types can run as a formula.
    s.getRange(1, 1, s.getMaxRows(), s.getMaxColumns()).setNumberFormat('@');
    s.setFrozenRows(1);
  }
}

function ensureSecret_() {
  var p = PropertiesService.getScriptProperties();
  var secret = p.getProperty('SHEET_SECRET');
  if (!secret) {
    secret = hex_(digest_(Utilities.getUuid() + Utilities.getUuid() + new Date().getTime())).substring(0, 48);
    p.setProperty('SHEET_SECRET', secret);
  }
  return secret;
}

function showSecret() {
  SpreadsheetApp.getUi().alert('Connection secret', ensureSecret_() +
    '\n\nThis goes in Vercel as SHEET_SECRET. Never paste it into a chat or the Sheet.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function createFirstAdmin() {
  var ui = SpreadsheetApp.getUi();
  ensureTabs_();
  var users = readTab_('Users');
  for (var i = 0; i < users.length; i++) {
    if (users[i].role === 'super_admin' && users[i].active === 'true') {
      ui.alert('A Super Admin already exists (' + users[i].email + '). Add more people in the website under Settings, or use "Reset someone\'s access code".');
      return;
    }
  }
  var name = ui.prompt('Your full name').getResponseText().trim();
  var email = ui.prompt('Your work email').getResponseText().trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.alert('Name and a valid email are needed. Nothing was created.'); return; }
  var code = newCode_();
  var now = new Date().toISOString();
  applyOps_([
    { op: 'append', tab: 'Users', row: { id: 'u_' + rand_(10), email: email, name: name, role: 'super_admin', active: 'true', code_hash: hashCode_(email, code), created_at: now, created_by: 'sheet' } },
    { op: 'append', tab: 'AuditLog', row: { id: 'a_' + rand_(10), at: now, actor_id: 'sheet', actor_role: 'owner', action: 'user.create_first_admin', target: email, detail: '' } }
  ]);
  ui.alert('Super Admin created', 'Sign in on the website with:\n\nEmail: ' + email + '\nAccess code: ' + code +
    '\n\nThis code is shown once and is not stored. Write it down now.', ui.ButtonSet.OK);
}

function resetAccessCode() {
  var ui = SpreadsheetApp.getUi();
  var email = ui.prompt('Email of the person').getResponseText().trim().toLowerCase();
  var users = readTab_('Users');
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].email).toLowerCase() === email) {
      var code = newCode_();
      var now = new Date().toISOString();
      applyOps_([
        { op: 'update', tab: 'Users', id: users[i].id, patch: { code_hash: hashCode_(email, code), active: 'true' } },
        { op: 'append', tab: 'AuditLog', row: { id: 'a_' + rand_(10), at: now, actor_id: 'sheet', actor_role: 'owner', action: 'user.reset_code', target: email, detail: '' } }
      ]);
      ui.alert('New access code', 'Email: ' + email + '\nAccess code: ' + code + '\n\nShown once. Share it privately.', ui.ButtonSet.OK);
      return;
    }
  }
  ui.alert('No user has that email.');
}

/* ------------------------------------------------------------ web entry */

function doGet() {
  // Deliberately says nothing useful. Data is only served to the server, by POST, with the secret.
  return json_({ ok: true, service: 'setter-assessment', api: API_VERSION, auth: true });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('SHEET_SECRET');
    if (!secret || !same_(String(body.secret || ''), secret)) return json_({ ok: false, error: 'unauthorized' });
    if (body.action === 'ping') return json_({ ok: true, api: API_VERSION });
    if (body.action === 'read') {
      var out = {};
      var tabs = body.tabs || [];
      for (var i = 0; i < tabs.length; i++) {
        if (!TABS[tabs[i]] || BLOB_TABS[tabs[i]]) throw new Error('Cannot read tab ' + tabs[i]);
        out[tabs[i]] = readTab_(tabs[i]);
      }
      return json_({ ok: true, data: out });
    }
    if (body.action === 'readBlob') {
      if (!BLOB_TABS[body.tab]) throw new Error('Not a blob tab');
      return json_({ ok: true, data: readBlob_(body.tab, String(body.key)) });
    }
    if (body.action === 'write') {
      applyOps_(body.ops || []);
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* --------------------------------------------------------------- storage */

function sheet_(name) {
  if (!TABS[name]) throw new Error('Unknown tab ' + name);
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error('Tab ' + name + ' is missing. Run "Set up this Sheet".');
  return s;
}

function header_(s) {
  var n = s.getLastColumn();
  if (!n) return [];
  var row = s.getRange(1, 1, 1, n).getValues()[0];
  var out = [];
  for (var i = 0; i < row.length; i++) if (String(row[i]) !== '') out.push(String(row[i]));
  return out;
}

function readTab_(name) {
  var s = sheet_(name);
  var h = header_(s);
  var last = s.getLastRow();
  if (last < 2 || !h.length) return [];
  var v = s.getRange(2, 1, last - 1, h.length).getValues();
  var out = [];
  for (var r = 0; r < v.length; r++) {
    if (String(v[r][0]) === '') continue;
    var o = {};
    for (var c = 0; c < h.length; c++) o[h[c]] = fromCell_(v[r][c]);
    out.push(o);
  }
  return out;
}

function readBlob_(tab, key) {
  var rows = readTab_(tab);
  var parts = [];
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) parts.push(rows[i]);
  if (!parts.length) return null;
  parts.sort(function (a, b) { return Number(a.part) - Number(b.part); });
  var text = '';
  for (var j = 0; j < parts.length; j++) text += parts[j].data;
  return text;
}

function applyOps_(ops) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    for (var i = 0; i < ops.length; i++) applyOp_(ops[i]);
  } finally {
    lock.releaseLock();
  }
}

function applyOp_(o) {
  var s = sheet_(o.tab);
  var h = header_(s);
  if (o.op === 'append') {
    if (BLOB_TABS[o.tab]) throw new Error('Use putBlob');
    if (!o.row || !o.row.id) throw new Error('append needs an id');
    if (findRow_(s, String(o.row.id)) > 0) throw new Error('Duplicate id ' + o.row.id + ' in ' + o.tab);
    s.getRange(s.getLastRow() + 1, 1, 1, h.length).setValues([toRow_(h, o.row)]);
  } else if (o.op === 'update') {
    var at = findRow_(s, String(o.id));
    if (at < 0) throw new Error('No row ' + o.id + ' in ' + o.tab);
    var cur = s.getRange(at, 1, 1, h.length).getValues()[0];
    for (var c = 0; c < h.length; c++) {
      if (h[c] !== 'id' && o.patch && o.patch.hasOwnProperty(h[c])) cur[c] = toCell_(o.patch[h[c]]);
      else cur[c] = toCell_(fromCell_(cur[c]));
    }
    s.getRange(at, 1, 1, h.length).setValues([cur]);
  } else if (o.op === 'remove') {
    var row = findRow_(s, String(o.id));
    if (row > 0) s.deleteRow(row);
  } else if (o.op === 'removeWhere') {
    var col = h.indexOf(o.field);
    if (col < 0) throw new Error('No column ' + o.field);
    var last = s.getLastRow();
    if (last >= 2) {
      var vals = s.getRange(2, col + 1, last - 1, 1).getValues();
      for (var r = vals.length - 1; r >= 0; r--) if (fromCell_(vals[r][0]) === String(o.value)) s.deleteRow(r + 2);
    }
  } else if (o.op === 'putBlob') {
    if (!BLOB_TABS[o.tab]) throw new Error('Not a blob tab');
    removeKey_(s, String(o.key));
    var parts = o.parts || [];
    if (parts.length) {
      var rows = [];
      for (var p = 0; p < parts.length; p++) rows.push([toCell_(o.key), String(p), toCell_(parts[p])]);
      s.getRange(s.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    }
  } else if (o.op === 'removeBlob') {
    if (!BLOB_TABS[o.tab]) throw new Error('Not a blob tab');
    removeKey_(s, String(o.key));
  } else {
    throw new Error('Unknown op ' + o.op);
  }
}

function removeKey_(s, key) {
  var last = s.getLastRow();
  if (last < 2) return;
  var vals = s.getRange(2, 1, last - 1, 1).getValues();
  for (var r = vals.length - 1; r >= 0; r--) if (fromCell_(vals[r][0]) === key) s.deleteRow(r + 2);
}

function findRow_(s, id) {
  var last = s.getLastRow();
  if (last < 2) return -1;
  var vals = s.getRange(2, 1, last - 1, 1).getValues();
  for (var r = 0; r < vals.length; r++) if (fromCell_(vals[r][0]) === id) return r + 2;
  return -1;
}

function toRow_(h, obj) {
  var row = [];
  for (var c = 0; c < h.length; c++) row.push(obj.hasOwnProperty(h[c]) ? toCell_(obj[h[c]]) : '');
  return row;
}

/** Everything is stored as text. A leading = + - @ gets an apostrophe so Sheets never treats it as a formula. */
function toCell_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.length > CELL_LIMIT) s = s.substring(0, CELL_LIMIT);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function fromCell_(v) {
  var s = (v instanceof Date) ? v.toISOString() : String(v === null || v === undefined ? '' : v);
  if (/^'[=+\-@]/.test(s)) s = s.substring(1);
  return s;
}

/* ----------------------------------------------------------- small tools */

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
}

function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** Must match server/auth.js hashCode(). */
function hashCode_(email, code) {
  return hex_(digest_(ensureSecret_() + '|' + String(email).toLowerCase() + '|' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')));
}

function rand_(n) {
  return hex_(digest_(Utilities.getUuid())).substring(0, n);
}

function newCode_() {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var bytes = digest_(Utilities.getUuid() + Utilities.getUuid());
  var out = '';
  for (var i = 0; i < 10; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += alphabet.charAt(b % alphabet.length);
    if (i === 4) out += '-';
  }
  return out;
}

/* ------------------------------------------------- backup and retention */

function installDailyJobs() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) if (triggers[i].getHandlerFunction() === 'dailyJobs') ScriptApp.deleteTrigger(triggers[i]);
  ScriptApp.newTrigger('dailyJobs').timeBased().everyDays(1).atHour(2).create();
  try { SpreadsheetApp.getUi().alert('Daily backup and clean-up are on. They run around 2 am.'); } catch (e) { }
}

function dailyJobs() {
  backupNow();
  applyRetention_();
}

function backupNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = PropertiesService.getScriptProperties();
  var folder = null;
  var id = p.getProperty('BACKUP_FOLDER_ID');
  if (id) { try { folder = DriveApp.getFolderById(id); } catch (e) { folder = null; } }
  if (!folder) { folder = DriveApp.createFolder('Setter Assessment backups'); p.setProperty('BACKUP_FOLDER_ID', folder.getId()); }
  var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' backup ' + stamp, folder);
  // Keep the newest 14 copies.
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) { var f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
  files.sort(function (a, b) { return b.t - a.t; });
  for (var i = 14; i < files.length; i++) files[i].f.setTrashed(true);
}

/** Deletes transcripts and reports older than Config.retention_days. 0 or blank keeps everything. */
function applyRetention_() {
  var days = 0;
  var cfg = readTab_('Config');
  for (var i = 0; i < cfg.length; i++) if (cfg[i].id === 'retention_days') days = Number(cfg[i].value) || 0;
  if (days <= 0) return 0;
  var cutoff = new Date().getTime() - days * 86400000;
  var sessions = readTab_('Sessions');
  var ops = [];
  for (var j = 0; j < sessions.length; j++) {
    var s = sessions[j];
    var t = Date.parse(s.ended_at || s.started_at);
    if (s.purged !== 'true' && t && t < cutoff) {
      ops.push({ op: 'removeBlob', tab: 'Transcripts', key: s.id });
      ops.push({ op: 'removeBlob', tab: 'Reports', key: s.id });
      ops.push({ op: 'update', tab: 'Sessions', id: s.id, patch: { purged: 'true' } });
    }
  }
  var purged = ops.length / 3;
  if (purged) {
    ops.push({ op: 'append', tab: 'AuditLog', row: { id: 'a_' + rand_(10), at: new Date().toISOString(), actor_id: 'sheet', actor_role: 'system', action: 'retention.purge', target: String(purged) + ' sessions', detail: 'older than ' + days + ' days' } });
    applyOps_(ops);
  }
  return purged;
}
