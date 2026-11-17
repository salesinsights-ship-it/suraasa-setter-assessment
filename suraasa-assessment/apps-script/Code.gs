/**
 * Suraasa Setter Assessment: Google Sheet storage.
 *
 * This script is a locked data store. It answers only requests that carry the
 * connection secret, and the secret is known only to the website's server.
 * All sign-in and permission checks happen on that server (server/handlers.js).
 * Nobody can read or change data by opening the script link in a browser.
 */

var API_VERSION = 2; // 2 adds call recordings kept as files in Google Drive

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
    if (body.action === 'ping') return json_({ ok: true, api: API_VERSION, fast: fastReads_() });
    if (body.action === 'read') {
      var tabs = body.tabs || [];
      for (var i = 0; i < tabs.length; i++) if (!TABS[tabs[i]] || BLOB_TABS[tabs[i]]) throw new Error('Cannot read tab ' + tabs[i]);
      return json_({ ok: true, data: readTabs_(tabs) });
    }
    if (body.action === 'readBlob') {
      if (!BLOB_TABS[body.tab]) throw new Error('Not a blob tab');
      return json_({ ok: true, data: readBlob_(body.tab, String(body.key)) });
    }
    if (body.action === 'write') {
      applyOps_(body.ops || []);
      return json_({ ok: true });
    }
    if (body.action === 'files') return json_({ ok: true, files: true });
    if (body.action === 'putFile') { putFile_(String(body.name), String(body.data || ''), String(body.mime || 'application/octet-stream')); return json_({ ok: true }); }
    if (body.action === 'getFile') return json_({ ok: true, data: getFile_(String(body.name)) });
    if (body.action === 'removeFiles') return json_({ ok: true, removed: removeFiles_(String(body.prefix)) });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* --------------------------------------------------------------- storage */

/*
 * Speed notes. Every request this script makes to the Sheet takes a noticeable fraction of a second, so the number
 * of requests is what decides how fast the website feels. Three things keep that number low:
 *   1. Reading several tabs is one request for all of them when the "Google Sheets API" service is added to this
 *      project (Editor > Services > + > Google Sheets API > Add). Without it, it is one request per tab.
 *   2. A change looks up each tab's header, last row and ids once, however many rows it touches.
 *   3. Rows that sit together are deleted together.
 */

var BOOK_ = null;

function book_() {
  if (!BOOK_) BOOK_ = SpreadsheetApp.getActiveSpreadsheet(); // opened once per request, not once per tab
  return BOOK_;
}

function sheet_(name) {
  if (!TABS[name]) throw new Error('Unknown tab ' + name);
  var s = book_().getSheetByName(name);
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

/** True when the Google Sheets API service has been added to this project, which makes reading much quicker. */
function fastReads_() {
  try { return typeof Sheets !== 'undefined' && !!Sheets.Spreadsheets && !!Sheets.Spreadsheets.Values; } catch (e) { return false; }
}

/**
 * Turns a block of cells (header row first) into rows. With textOnly, returns null if any cell is not plain text,
 * so the caller can read that tab the careful way instead of guessing how a date or number should look.
 */
function rows_(v, textOnly) {
  if (!v || v.length < 2) {
    if (textOnly && v && v.length === 1) for (var x = 0; x < v[0].length; x++) if (typeof v[0][x] !== 'string') return null;
    return [];
  }
  var h = [];
  for (var i = 0; i < v[0].length; i++) {
    if (textOnly && typeof v[0][i] !== 'string') return null;
    h.push(String(v[0][i]));
  }
  var out = [];
  for (var r = 1; r < v.length; r++) {
    var row = v[r] || [];
    if (textOnly) for (var k = 0; k < row.length; k++) if (typeof row[k] !== 'string') return null;
    if (row.length === 0 || String(row[0]) === '') continue;
    var o = {};
    for (var c = 0; c < h.length; c++) if (h[c] !== '') o[h[c]] = fromCell_(c < row.length ? row[c] : '');
    out.push(o);
  }
  return out;
}

/** Reads a whole tab with a single request to the Sheet (header and rows together). */
function readTab_(name) {
  return rows_(sheet_(name).getDataRange().getValues(), false);
}

/**
 * Reads several tabs. With the Google Sheets API service added, all of them arrive in one request. Any tab that
 * cannot be read that way, and every tab when the service is not added, is read on its own.
 */
function readTabs_(tabs) {
  var out = {};
  var left = tabs;
  if (tabs.length > 1 && fastReads_()) {
    try {
      var ranges = [];
      for (var i = 0; i < tabs.length; i++) ranges.push("'" + tabs[i] + "'");
      var res = Sheets.Spreadsheets.Values.batchGet(book_().getId(), { ranges: ranges, valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' });
      var got = (res && res.valueRanges) || [];
      if (got.length === tabs.length) {
        left = [];
        for (var j = 0; j < tabs.length; j++) {
          var rows = rows_(got[j].values || [], true);
          if (rows === null) left.push(tabs[j]); else out[tabs[j]] = rows;
        }
      }
    } catch (e) {
      left = tabs; // the quick way is unavailable right now: read each tab on its own
      out = {};
    }
  }
  for (var k = 0; k < left.length; k++) out[left[k]] = readTab_(left[k]);
  return out;
}

/**
 * Reads one transcript or report. Only the narrow key column is scanned to find its rows, and only those rows are
 * loaded, so opening a report stays quick however many calls are stored. (Reading the whole tab, as this used to,
 * gets slower with every call ever taken.)
 */
function readBlob_(tab, key) {
  var s = sheet_(tab);
  var last = s.getLastRow();
  if (last < 2) return null;
  var keys = s.getRange(2, 1, last - 1, 1).getValues();
  var first = -1, end = -1, scattered = false;
  for (var i = 0; i < keys.length; i++) {
    if (fromCell_(keys[i][0]) !== key) continue;
    if (first < 0) first = i;
    else if (i !== end + 1) scattered = true;
    end = i;
  }
  if (first < 0) return null;
  // The parts of one item are written together, so they sit in one block of rows. Read just that block.
  var block = s.getRange(first + 2, 1, end - first + 1, 3).getValues();
  var parts = [];
  for (var j = 0; j < block.length; j++) {
    if (scattered && fromCell_(block[j][0]) !== key) continue;
    parts.push({ part: Number(fromCell_(block[j][1])), data: fromCell_(block[j][2]) });
  }
  parts.sort(function (a, b) { return a.part - b.part; });
  var text = '';
  for (var k = 0; k < parts.length; k++) text += parts[k].data;
  return text;
}

/* What is known about each tab while one set of changes is applied: looked up once, then kept in step by hand. */
var WORK_ = {};

function applyOps_(ops) {
  if (!ops.length) return;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    throw new Error('The Sheet is busy saving other changes. Try again in a moment.');
  }
  WORK_ = {};
  try {
    for (var i = 0; i < ops.length; i++) applyOp_(ops[i]);
  } finally {
    WORK_ = {};
    lock.releaseLock();
  }
}

function work_(name) {
  var t = WORK_[name];
  if (t) return t;
  var s = sheet_(name);
  t = WORK_[name] = { s: s, h: header_(s), last: s.getLastRow(), ids: null };
  return t;
}

/** The first column of every data row (the id, or the key on transcript and report tabs), read once. */
function ids_(t) {
  if (t.ids) return t.ids;
  t.ids = [];
  if (t.last >= 2) {
    var vals = t.s.getRange(2, 1, t.last - 1, 1).getValues();
    for (var r = 0; r < vals.length; r++) t.ids.push(fromCell_(vals[r][0]));
  }
  return t.ids;
}

function rowOf_(t, id) {
  var at = ids_(t).indexOf(id);
  return at < 0 ? -1 : at + 2;
}

/** Deletes the data rows at these positions (0 is the first row under the header). Neighbours go in one request. */
function deleteAt_(t, positions) {
  positions.sort(function (a, b) { return a - b; });
  var i = positions.length - 1;
  while (i >= 0) {
    var end = positions[i];
    var start = end;
    while (i > 0 && positions[i - 1] === start - 1) { i--; start = positions[i]; }
    var n = end - start + 1;
    if (n === 1) t.s.deleteRow(start + 2); else t.s.deleteRows(start + 2, n);
    if (t.ids) t.ids.splice(start, n);
    t.last -= n;
    i--;
  }
}

function removeKey_(t, key) {
  var ids = ids_(t);
  var hit = [];
  for (var r = 0; r < ids.length; r++) if (ids[r] === key) hit.push(r);
  if (hit.length) deleteAt_(t, hit);
}

function applyOp_(o) {
  var t = work_(o.tab);
  var s = t.s;
  var h = t.h;
  if (o.op === 'append') {
    if (BLOB_TABS[o.tab]) throw new Error('Use putBlob');
    if (!o.row || !o.row.id) throw new Error('append needs an id');
    // The log only ever grows and its ids are random, so it is not searched for a duplicate before each new line.
    if (o.tab !== 'AuditLog' && rowOf_(t, String(o.row.id)) > 0) throw new Error('Duplicate id ' + o.row.id + ' in ' + o.tab);
    s.getRange(t.last + 1, 1, 1, h.length).setValues([toRow_(h, o.row)]);
    t.last++;
    if (t.ids) t.ids.push(String(o.row.id));
  } else if (o.op === 'update') {
    var at = rowOf_(t, String(o.id));
    if (at < 0) throw new Error('No row ' + o.id + ' in ' + o.tab);
    var cur = s.getRange(at, 1, 1, h.length).getValues()[0];
    for (var c = 0; c < h.length; c++) {
      if (h[c] !== 'id' && o.patch && o.patch.hasOwnProperty(h[c])) cur[c] = toCell_(o.patch[h[c]]);
      else cur[c] = toCell_(fromCell_(cur[c]));
    }
    s.getRange(at, 1, 1, h.length).setValues([cur]);
  } else if (o.op === 'remove') {
    var row = rowOf_(t, String(o.id));
    if (row > 0) deleteAt_(t, [row - 2]);
  } else if (o.op === 'removeWhere') {
    var col = h.indexOf(o.field);
    if (col < 0) throw new Error('No column ' + o.field);
    if (t.last >= 2) {
      var vals = s.getRange(2, col + 1, t.last - 1, 1).getValues();
      var hit = [];
      for (var r = 0; r < vals.length; r++) if (fromCell_(vals[r][0]) === String(o.value)) hit.push(r);
      if (hit.length) deleteAt_(t, hit);
    }
  } else if (o.op === 'putBlob') {
    if (!BLOB_TABS[o.tab]) throw new Error('Not a blob tab');
    removeKey_(t, String(o.key));
    var parts = o.parts || [];
    if (parts.length) {
      var rows = [];
      for (var p = 0; p < parts.length; p++) rows.push([toCell_(o.key), String(p), toCell_(parts[p])]);
      s.getRange(t.last + 1, 1, rows.length, 3).setValues(rows);
      t.last += rows.length;
      if (t.ids) for (var q = 0; q < rows.length; q++) t.ids.push(String(o.key));
    }
  } else if (o.op === 'removeBlob') {
    if (!BLOB_TABS[o.tab]) throw new Error('Not a blob tab');
    removeKey_(t, String(o.key));
  } else {
    throw new Error('Unknown op ' + o.op);
  }
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

/* ------------------------------------------------------- call recordings */

/**
 * Call audio is kept as small files in one private Drive folder, named <call id>.<part number>.part.
 * A 20-minute call is about a dozen parts. Only the website's server can read or write them, through this script.
 */
function recordingsFolder_(create) {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('RECORDINGS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder was deleted: make a new one below */ } }
  if (!create) return null;
  var folder = DriveApp.createFolder('Setter Assessment recordings');
  p.setProperty('RECORDINGS_FOLDER_ID', folder.getId());
  return folder;
}

function fileName_(name) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,79}$/.test(name)) throw new Error('Bad file name');
  return name;
}

function putFile_(name, data, mime) {
  fileName_(name);
  if (!data || data.length > 700000) throw new Error('File part is empty or too large');
  var folder = recordingsFolder_(true);
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  folder.createFile(Utilities.newBlob(Utilities.base64Decode(data), mime, name));
}

function getFile_(name) {
  fileName_(name);
  var folder = recordingsFolder_(false);
  if (!folder) return null;
  var it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  return Utilities.base64Encode(it.next().getBlob().getBytes());
}

/** Moves every part of one call's recording to the bin. Returns how many parts were removed. */
function removeFiles_(prefix) {
  fileName_(prefix);
  var folder = recordingsFolder_(false);
  if (!folder) return 0;
  var it = folder.getFiles();
  var n = 0;
  while (it.hasNext()) { var f = it.next(); if (String(f.getName()).indexOf(prefix + '.') === 0) { f.setTrashed(true); n++; } }
  return n;
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
      try { removeFiles_(s.id); } catch (e) { /* the recording stays if Drive is unavailable; the next run tries again only for calls not yet purged */ }
    }
  }
  var purged = ops.length / 3;
  if (purged) {
    ops.push({ op: 'append', tab: 'AuditLog', row: { id: 'a_' + rand_(10), at: new Date().toISOString(), actor_id: 'sheet', actor_role: 'system', action: 'retention.purge', target: String(purged) + ' sessions', detail: 'older than ' + days + ' days' } });
    applyOps_(ops);
  }
  return purged;
}
