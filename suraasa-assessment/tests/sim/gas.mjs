/**
 * Runs the real apps-script/Code.gs against an in-memory spreadsheet, so tests exercise the
 * actual script that will be pasted into Google Sheets. Only Google's services are simulated.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CODE = fileURLToPath(new URL('../../apps-script/Code.gs', import.meta.url));

class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxCols = 26; this.maxRows = 1000; this.frozen = 0; }
  getLastRow() { for (let r = this.cells.length - 1; r >= 0; r--) if ((this.cells[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1; return 0; }
  getLastColumn() { let m = 0; for (const row of this.cells) for (let c = (row || []).length - 1; c >= 0; c--) if (row[c] !== '' && row[c] !== undefined) { m = Math.max(m, c + 1); break; } return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(_at, n) { this.maxCols += n; }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(r) { this.cells.splice(r - 1, 1); }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(sheet.cells[r - 1 + i]?.[c - 1 + j] ?? ''); out.push(row); }
        return out;
      },
      setValues(v) {
        if (v.length !== nr || v.some((row) => row.length !== nc)) throw new Error('setValues: size does not match the range');
        if (c - 1 + nc > sheet.maxCols) throw new Error('setValues: range is outside the sheet');
        for (let i = 0; i < nr; i++) {
          while (sheet.cells.length <= r - 1 + i) sheet.cells.push([]);
          for (let j = 0; j < nc; j++) {
            let val = v[i][j];
            if (typeof val !== 'string') throw new Error('Non-text value written to ' + sheet.name);
            if (val.length > 50000) throw new Error('Cell over 50,000 characters in ' + sheet.name);
            if (/^[=+]/.test(val)) throw new Error('Formula written to ' + sheet.name + ': ' + val.slice(0, 30));
            if (val.startsWith("'")) val = val.slice(1); // Sheets hides a leading apostrophe and keeps the rest as text
            sheet.cells[r - 1 + i][c - 1 + j] = val;
          }
        }
        return this;
      },
      setNumberFormat() { return this; },
    };
  }
}

export function makeGas() {
  const sheets = new Map();
  const props = new Map();
  const ui = { prompts: [], alerts: [], menus: [] };
  const triggers = [];
  const folders = new Map();

  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
    getId: () => 'sheet-id', getName: () => 'Setter Assessment',
  };
  const uiApi = {
    ButtonSet: { OK: 'OK' },
    alert: (...a) => { ui.alerts.push(a.filter((x) => typeof x === 'string').join('\n')); },
    prompt: () => ({ getResponseText: () => ui.prompts.shift() ?? '' }),
    createMenu: () => { const m = { addItem: (label, fn) => { ui.menus.push({ label, fn }); return m; }, addSeparator: () => m, addToUi: () => {} }; return m; },
  };
  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => uiApi },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_a, text) => [...crypto.createHash('sha256').update(String(text), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' ').replace(':', ''),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => { const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, create: () => { triggers.push({ getHandlerFunction: () => fn }); } }; return b; },
    },
    DriveApp: {
      createFolder: (name) => { const files = []; const f = { getId: () => 'folder-' + name, getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; }, files }; folders.set(f.getId(), f); return f; },
      getFolderById: (id) => { if (!folders.has(id)) throw new Error('no folder'); return folders.get(id); },
      getFileById: () => ({ makeCopy: (name, folder) => { const t = Date.now() + folder.files.length; folder.files.push({ name, trashed: false, getDateCreated: () => new Date(t), setTrashed(v) { this.trashed = v; } }); } }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE, 'utf8'), sandbox, { filename: 'Code.gs' });

  const run = (fn, ...args) => vm.runInContext(fn, sandbox)(...args);
  const post = (body) => JSON.parse(run('doPost', { postData: { contents: JSON.stringify(body) } }).text);
  /** A stand-in for fetch() that the server's store uses to reach the script. */
  const fetchImpl = async (_url, opts) => ({ ok: true, status: 200, text: async () => run('doPost', { postData: { contents: opts.body } }).text });

  return { run, post, fetchImpl, sheets, props, ui, triggers, folders, secret: () => props.get('SHEET_SECRET') };
}
