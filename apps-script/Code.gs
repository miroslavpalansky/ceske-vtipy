/**
 * České vtipy – backend (Google Apps Script bound to the sheet "České vtipy – databáze").
 *
 * Web app API (deploy as: Execute as me, Who has access: Anyone)
 *   GET  ?a=data                              -> all jokes on the site with their votes, category and
 *                                               the last 30 days of votes (for the "Trendy" ranking)
 *   POST {a:'vote',   id, v, prev}            -> v / prev: 1 = thumbs up, -1 = thumbs down, 0 = none
 *   POST {a:'submit', text, name}             -> a visitor's joke, saved hidden until approved
 *
 * Run setup() once from the editor after pasting this file.
 */

var CONFIG = {
  TZ: 'Europe/Prague',
  SHEET: 'Vtipy',
  LOG: 'Hlasy',
  GUIDE: 'Návod',
  TREND_DAYS: 30,
  CACHE_SECONDS: 120,
  MAX_SUBMISSIONS_PER_HOUR: 30,
};

// Columns are found by their header in row 1, so they can be moved around freely in the sheet.
// The Skóre column is a sheet formula and is never written by the script.
var HEAD = { id: 'ID', text: 'Vtip', src: 'Zdroj', web: 'Na webu', up: 'Palce nahoru', down: 'Palce dolů', xLikes: 'Lajky na Twitteru',
  by: 'Poslal(a)', added: 'Přidáno', cat: 'Kategorie' };
var REQUIRED = ['id', 'text', 'web', 'up', 'down'];
var COL = null, NCOL = 0;

/** Reads the header row into COL (0-based positions, -1 when a column is missing). */
function cols_() {
  if (COL) return COL;
  var sh = sheet_(CONFIG.SHEET);
  NCOL = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, NCOL).getValues()[0].map(function (h) { return String(h).trim(); });
  COL = {};
  Object.keys(HEAD).forEach(function (k) { COL[k] = head.indexOf(HEAD[k]); });
  var missing = REQUIRED.filter(function (k) { return COL[k] < 0; }).map(function (k) { return HEAD[k]; });
  if (missing.length) { COL = null; throw new Error('Na listu Vtipy chybí sloupce: ' + missing.join(', ')); }
  return COL;
}

/** Writes {key: value} into one row, cell by cell; keys whose column is missing are skipped. */
function setCells_(sh, row, values) {
  Object.keys(values).forEach(function (k) { if (COL[k] >= 0) sh.getRange(row, COL[k] + 1).setValue(values[k]); });
}
function cell_(r, k) { return COL[k] >= 0 ? r[COL[k]] : ''; }
var LOG_HEADERS = ['Čas', 'ID vtipu', 'Změna 👍', 'Změna 👎'];
var SRC_NEW = 'Nový';
var SRC_READER = 'Od čtenáře';

/* ----------------------------------------------------------------- web app */

function doGet(e) {
  try {
    var a = (e && e.parameter && e.parameter.a) || 'data';
    if (a === 'data') return json_(getData_());
    if (a === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.a === 'vote') return json_(vote_(b.id, b.v, b.prev));
    if (b.a === 'submit') return json_(submit_(b.text, b.name, b.hp));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------- data */

function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function todayKey_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function num_(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }

function readRows_() {
  cols_();
  var sh = sheet_(CONFIG.SHEET);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, NCOL).getValues();
}

function maxId_(rows) {
  var m = 0;
  rows.forEach(function (r) { var n = Number(r[COL.id]); if (n > m) m = n; });
  return m;
}

/** Fill in ID, source, "Na webu", votes and date for jokes typed into the sheet by hand. */
function normalize_() {
  var sh = sheet_(CONFIG.SHEET);
  var rows = readRows_();
  var next = maxId_(rows);
  var changed = false;
  rows.forEach(function (r, i) {
    if (String(r[COL.text]).trim() === '' || String(r[COL.id]).trim() !== '') return;
    next += 1;
    var v = { id: next, src: cell_(r, 'src') || SRC_NEW, web: r[COL.web] === '' ? true : r[COL.web], up: num_(r[COL.up]), down: num_(r[COL.down]) };
    if (!cell_(r, 'added')) v.added = todayKey_();
    setCells_(sh, i + 2, v);
    changed = true;
  });
  return changed;
}

function getData_() {
  var cached = cacheGet_();
  if (cached) return cached;
  var lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try { normalize_(); } finally { lock.releaseLock(); }
  }
  var jokes = [];
  readRows_().forEach(function (r) {
    if (!String(r[COL.text]).trim() || !r[COL.id] || !isTrue_(r[COL.web])) return;
    jokes.push([Number(r[COL.id]), String(r[COL.text]), num_(r[COL.up]), num_(r[COL.down]), num_(cell_(r, 'xLikes')),
      String(cell_(r, 'cat') || '').trim()]);
  });
  var data = { ok: true, jokes: jokes, trend: trend_(), days: CONFIG.TREND_DAYS, generated: new Date().toISOString() };
  cachePut_(data);
  return data;
}

/* ------------------------------------------------------------------ votes */

function vote_(id, v, prev) {
  v = norm_(v); prev = norm_(prev);
  if (v === prev) return { ok: true };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    cols_();
    var sh = sheet_(CONFIG.SHEET);
    var row = findRowById_(sh, id);
    if (row < 0) return { ok: false, error: 'not found' };
    var upCell = sh.getRange(row, COL.up + 1), downCell = sh.getRange(row, COL.down + 1);
    var up0 = num_(upCell.getValue()), down0 = num_(downCell.getValue()), up = up0, down = down0;
    if (prev === 1) up = Math.max(0, up - 1);
    if (prev === -1) down = Math.max(0, down - 1);
    if (v === 1) up += 1;
    if (v === -1) down += 1;
    if (up !== up0) upCell.setValue(up);
    if (down !== down0) downCell.setValue(down);
    logVote_(Number(id), up - up0, down - down0);
    return { ok: true, id: Number(id), up: up, down: down };
  } finally {
    lock.releaseLock();
  }
}

function norm_(x) { x = Number(x); return x === 1 ? 1 : x === -1 ? -1 : 0; }

function findRowById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, cols_().id + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (Number(ids[i][0]) === Number(id)) return i + 2;
  return -1;
}

/* ---------------------------------------------------- vote log and trending */

function logSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.LOG);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.LOG);
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
  }
  return sh;
}

/** One row per vote change, newest at the bottom. Caller holds the script lock. */
function logVote_(id, dUp, dDown) {
  if (!dUp && !dDown) return;
  var sh = logSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[new Date(), id, dUp, dDown]]);
}

/** Votes per joke over the last TREND_DAYS days: [[id, up, down], ...]. Also drops older log rows. */
function trend_() {
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 4).getValues();
  var cutoff = Date.now() - CONFIG.TREND_DAYS * 864e5;
  var old = 0;
  while (old < rows.length && new Date(rows[old][0]).getTime() < cutoff) old++;
  if (old > 0) {
    var lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try { sh.deleteRows(2, old); } finally { lock.releaseLock(); }
    }
  }
  var sum = {};
  for (var i = old; i < rows.length; i++) {
    var id = Number(rows[i][1]);
    if (!sum[id]) sum[id] = [id, 0, 0];
    sum[id][1] += Number(rows[i][2]) || 0;
    sum[id][2] += Number(rows[i][3]) || 0;
  }
  return Object.keys(sum).map(function (k) { return sum[k]; })
    .filter(function (x) { return x[1] > 0 || x[2] > 0; })
    .map(function (x) { return [x[0], Math.max(0, x[1]), Math.max(0, x[2])]; });
}

/* ------------------------------------------------------------ submissions */

function submit_(text, name, honeypot) {
  if (honeypot) return { ok: true }; // a bot filled the hidden field: pretend it worked
  text = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (text.length < 5) return { ok: false, error: 'short' };
  if (text.length > 1000) return { ok: false, error: 'long' };

  var cache = CacheService.getScriptCache();
  var hourKey = 'sub_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMddHH');
  var count = Number(cache.get(hourKey) || 0);
  if (count >= CONFIG.MAX_SUBMISSIONS_PER_HOUR) return { ok: false, error: 'busy' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rows = readRows_();
    var key = simplify_(text);
    for (var i = 0; i < rows.length; i++) {
      if (simplify_(String(rows[i][COL.text])) === key) return { ok: true, duplicate: true };
    }
    var sh = sheet_(CONFIG.SHEET);
    var row = sh.getLastRow() + 1;
    sh.getRange(row, COL.text + 1).setNumberFormat('@');
    setCells_(sh, row, { id: maxId_(rows) + 1, text: text, src: SRC_READER, web: false, up: 0, down: 0, by: name, added: todayKey_() });
    cache.put(hourKey, String(count + 1), 3600);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function simplify_(s) { return String(s).toLowerCase().replace(/[^0-9a-záčďéěíňóřšťúůýž]+/g, ''); }

/* ------------------------------------------------------------------ cache */

function cacheGet_() {
  var c = CacheService.getScriptCache();
  var n = Number(c.get('data_n') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push('data_' + i);
  var parts = c.getAll(keys), s = '';
  for (i = 0; i < n; i++) { if (parts['data_' + i] == null) return null; s += parts['data_' + i]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function cachePut_(data) {
  var s = JSON.stringify(data), size = 90000, obj = {}, n = 0;
  for (var i = 0; i < s.length; i += size) obj['data_' + (n++)] = s.substring(i, i + size);
  obj.data_n = String(n);
  try { CacheService.getScriptCache().putAll(obj, CONFIG.CACHE_SECONDS); } catch (e) { /* cache is optional */ }
}

function clearCache_() { CacheService.getScriptCache().remove('data_n'); }

/* ------------------------------------------------------- setup and triggers */

/** Run once from the Apps Script editor (Run > setup). Safe to run again. */
function setup() {
  var sh = sheet_(CONFIG.SHEET);
  if (!sh) throw new Error('List "' + CONFIG.SHEET + '" nenalezen');
  COL = null; cols_(); // throws if a required column is missing
  normalize_();
  logSheet_();
  clearCache_();
  var data = getData_();
  Logger.log('OK: ' + data.jokes.length + ' vtipů na webu.');
}

/** Simple trigger: stamp ID/source/date when a joke is typed into the sheet, and refresh the web cache. */
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== CONFIG.SHEET) return;
    COL = null; cols_(); // the header may have just been rearranged
    if (e.range.getRow() > 1 && e.range.getColumn() <= COL.text + 1 && e.range.getLastColumn() >= COL.text + 1) normalize_();
    clearCache_();
  } catch (err) { /* never block editing */ }
}
