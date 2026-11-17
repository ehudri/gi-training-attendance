/**
 * מעקב נוכחות בהדרכות צוות – המכון לגסטרואנטרולוגיה
 * Backend: Google Apps Script web app bound to the attendance spreadsheet.
 *
 * All requests are POST with a JSON body (sent as text/plain to avoid a CORS
 * preflight). Every response is JSON: {ok:true, ...} or {ok:false, code, message}.
 * Identity comes only from a verified Google ID token – never from client fields.
 */

const TZ = 'Asia/Jerusalem';
const SHEET = {
  ATT: 'נוכחות',
  LOG: 'יומן',
  PEOPLE: 'עובדים',
  SETTINGS: 'הגדרות',
  TRAININGS: 'הדרכות',
};
const HEADER_ROWS = 2;   // נוכחות: row 1 = names, row 2 = employee numbers
const FIXED_COLS = 6;    // נוכחות: A..F
const ATT_HEADERS = ['מזהה הדרכה', 'שם ההדרכה', 'תאריך', 'קטגוריה', 'מדריך', 'סה"כ משתתפים'];
const LOG_HEADERS = ['חותמת זמן', 'מזהה הדרכה', 'מספר עובד', 'שם', 'תפקיד', 'מייל', 'שיטה', 'פעולה', 'בוצע ע"י'];
const PEOPLE_HEADERS = ['מספר עובד', 'שם מלא', 'תפקיד', 'מייל', 'Google sub', 'נראה לראשונה'];
const TRAINING_HEADERS = ['מזהה הדרכה', 'שם ההדרכה', 'תאריך', 'קטגוריה', 'מדריך', 'מצב רישום', 'נוצר', 'נוצר ע"י'];
const SETTINGS_HEADERS = ['קטגוריות', 'מיילים של מנהלים', 'OAuth Client ID', 'תפקידים (רשימת בחירה)'];

const STATE = { AUTO: 'אוטומטי', OPEN: 'פתוח', CLOSED: 'סגור' };
const METHOD = { GOOGLE: 'Google', MANUAL: 'ידני', ADMIN: 'מנהל' };
const ACTION = { ADD: 'רישום', REMOVE: 'ביטול' };
const MARK = 'V';
const ACCENT_LIGHT = '#e3f1f2';
const ACCENT = '#0b6e79';

// ---------------------------------------------------------------- HTTP

function doGet() {
  return json_({ ok: true, service: 'gi-training-attendance' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', message: 'בקשה לא תקינה' });
  }
  try {
    const handler = ACTIONS[req.action];
    if (!handler) fail_('bad_request', 'פעולה לא מוכרת');
    ensureSetup_();
    return json_(Object.assign({ ok: true }, handler(req)));
  } catch (err) {
    if (err && err.code) {
      return json_(Object.assign({ ok: false, code: err.code, message: err.message }, err.extra || {}));
    }
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'server_error', message: 'שגיאת שרת. נסו שוב בעוד רגע.' });
  }
}

const ACTIONS = {
  // public
  training: apiTraining_,
  checkinGoogle: apiCheckinGoogle_,
  checkinManual: apiCheckinManual_,
  // admin
  adminInit: apiAdminInit_,
  listTrainings: apiListTrainings_,
  createTraining: apiCreateTraining_,
  setState: apiSetState_,
  attendees: apiAttendees_,
  addAttendee: apiAddAttendee_,
  removeAttendee: apiRemoveAttendee_,
  rebuild: apiRebuild_,
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  err.extra = extra;
  throw err;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('busy', 'המערכת עמוסה כרגע. נסו שוב בעוד כמה שניות.');
  try {
    const out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- public API

function apiTraining_(req) {
  const t = getTraining_(req.t);
  return { training: publicTraining_(t), roles: getSettings_().roles };
}

/**
 * Google check-in. Identity = verified ID token. If this Google account is not
 * yet in the registry, the client must send `profile` {name, role, empNo} once.
 */
function apiCheckinGoogle_(req) {
  const user = verifyIdToken_(req.idToken);
  const t0 = getTraining_(req.t);
  if (!isOpen_(t0)) fail_('closed', 'הרישום להדרכה זו סגור', { training: publicTraining_(t0) });

  return withLock_(function () {
    const t = getTraining_(req.t); // re-read under lock
    if (!isOpen_(t)) fail_('closed', 'הרישום להדרכה זו סגור', { training: publicTraining_(t) });
    const people = readPeople_();
    let person = people.find(function (p) { return p.sub && p.sub === user.sub; });
    if (!person) {
      if (!req.profile) {
        fail_('need_profile', 'נדרשים פרטים להשלמת הרישום הראשון', { email: user.email, googleName: user.name });
      }
      const prof = validateProfile_(req.profile);
      person = people.find(function (p) { return p.empNo === prof.empNo; });
      if (person) {
        if (!person.sub) linkGoogle_(person, user);
      } else {
        person = addPerson_(prof, user);
      }
    }
    const res = mark_(t, person, true);
    if (res.changed) log_(t.id, person, METHOD.GOOGLE, ACTION.ADD, user.email, '');
    return { status: res.changed ? 'checked_in' : 'already', person: publicPerson_(person), training: publicTraining_(t) };
  });
}

function apiCheckinManual_(req) {
  const prof = validateProfile_(req);
  const t0 = getTraining_(req.t);
  if (!isOpen_(t0)) fail_('closed', 'הרישום להדרכה זו סגור', { training: publicTraining_(t0) });

  return withLock_(function () {
    const t = getTraining_(req.t);
    if (!isOpen_(t)) fail_('closed', 'הרישום להדרכה זו סגור', { training: publicTraining_(t) });
    let person = readPeople_().find(function (p) { return p.empNo === prof.empNo; });
    if (!person) person = addPerson_(prof, null);
    const res = mark_(t, person, true);
    if (res.changed) log_(t.id, person, METHOD.MANUAL, ACTION.ADD, '', '');
    return { status: res.changed ? 'checked_in' : 'already', person: publicPerson_(person), training: publicTraining_(t) };
  });
}

// ---------------------------------------------------------------- admin API

function apiAdminInit_(req) {
  const admin = requireAdmin_(req);
  const s = getSettings_();
  return {
    email: admin.email,
    categories: s.categories,
    roles: s.roles,
    today: today_(),
    sheetUrl: ss_().getUrl(),
    trainings: listTrainings_(),
    people: readPeople_().map(publicPerson_),
  };
}

function apiListTrainings_(req) {
  requireAdmin_(req);
  return { today: today_(), trainings: listTrainings_() };
}

function apiCreateTraining_(req) {
  const admin = requireAdmin_(req);
  const name = cleanText_(req.name, 120);
  if (name.length < 2) fail_('invalid', 'יש להזין שם הדרכה');
  const date = String(req.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parseDate_(date).getTime())) fail_('invalid', 'תאריך לא תקין');
  const category = cleanText_(req.category, 60);
  if (getSettings_().categories.indexOf(category) === -1) fail_('invalid', 'יש לבחור קטגוריה מהרשימה');
  const instructor = cleanText_(req.instructor, 80);

  return withLock_(function () {
    const existing = readTrainings_().map(function (t) { return t.id; });
    let id;
    do { id = newId_(); } while (existing.indexOf(id) !== -1);
    const t = { id: id, name: name, date: date, category: category, instructor: instructor, state: STATE.AUTO };
    sheet_(SHEET.TRAININGS).appendRow([id, name, date, category, instructor, STATE.AUTO, nowStr_(), admin.email]);
    const att = sheet_(SHEET.ATT);
    ensureTrainingRow_(att, attIndex_(att), t);
    return { training: adminTraining_(t, 0) };
  });
}

function apiSetState_(req) {
  requireAdmin_(req);
  const state = req.state === 'open' ? STATE.OPEN : req.state === 'closed' ? STATE.CLOSED : req.state === 'auto' ? STATE.AUTO : null;
  if (!state) fail_('invalid', 'מצב לא תקין');
  return withLock_(function () {
    const t = getTraining_(req.t);
    sheet_(SHEET.TRAININGS).getRange(t.row, 6).setValue(state);
    t.state = state;
    return { training: adminTraining_(t, countFor_(t.id)) };
  });
}

function apiAttendees_(req) {
  requireAdmin_(req);
  const t = getTraining_(req.t);
  return { training: adminTraining_(t, null), attendees: attendeesOf_(t) };
}

/** Admin adds a person to a training (ignores open/closed). */
function apiAddAttendee_(req) {
  const admin = requireAdmin_(req);
  const empNo = normEmp_(req.empNo);
  if (!empNo) fail_('invalid', 'מספר עובד לא תקין');
  return withLock_(function () {
    const t = getTraining_(req.t);
    let person = readPeople_().find(function (p) { return p.empNo === empNo; });
    if (!person) {
      if (!req.name) fail_('need_details', 'מספר העובד אינו במאגר – יש להזין שם ותפקיד');
      person = addPerson_(validateProfile_({ name: req.name, role: req.role, empNo: empNo }), null);
    }
    const res = mark_(t, person, true);
    if (res.changed) log_(t.id, person, METHOD.ADMIN, ACTION.ADD, '', admin.email);
    return { status: res.changed ? 'checked_in' : 'already', person: publicPerson_(person), attendees: attendeesOf_(t) };
  });
}

function apiRemoveAttendee_(req) {
  const admin = requireAdmin_(req);
  const empNo = normEmp_(req.empNo);
  return withLock_(function () {
    const t = getTraining_(req.t);
    const person = readPeople_().find(function (p) { return p.empNo === empNo; }) ||
      { empNo: empNo, name: '', role: '', email: '' };
    const res = mark_(t, person, false);
    if (res.changed) log_(t.id, person, METHOD.ADMIN, ACTION.REMOVE, '', admin.email);
    return { removed: res.changed, attendees: attendeesOf_(t) };
  });
}

function apiRebuild_(req) {
  requireAdmin_(req);
  return withLock_(rebuild_);
}

// ---------------------------------------------------------------- auth

/** Verifies a Google ID token with Google's tokeninfo endpoint. */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) fail_('auth', 'נדרשת התחברות עם Google');
  const clientId = getSettings_().clientId;
  if (!clientId) fail_('config', 'OAuth Client ID לא הוגדר בלשונית "הגדרות"');

  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail_('auth', 'ההתחברות לא אומתה. נסו להתחבר שוב.');
  const info = JSON.parse(res.getContentText());
  const exp = Number(info.exp) * 1000;
  if (info.aud !== clientId) fail_('auth', 'אסימון ההתחברות אינו מיועד לאפליקציה זו');
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') fail_('auth', 'מנפיק לא מוכר');
  if (!exp || exp < Date.now()) fail_('auth', 'פג תוקף ההתחברות. התחברו שוב.');
  if (!info.sub) fail_('auth', 'אסימון לא תקין');

  const user = {
    sub: String(info.sub),
    email: String(info.email || '').toLowerCase(),
    emailVerified: info.email_verified === true || info.email_verified === 'true',
    name: String(info.name || ''),
  };
  const ttl = Math.min(600, Math.floor((exp - Date.now()) / 1000) - 5);
  if (ttl > 10) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

function requireAdmin_(req) {
  const user = verifyIdToken_(req.idToken);
  if (!user.emailVerified || getSettings_().admins.indexOf(user.email) === -1) {
    fail_('forbidden', 'לחשבון ' + user.email + ' אין הרשאת ניהול', { email: user.email });
  }
  return user;
}

// ---------------------------------------------------------------- domain

function getTraining_(id) {
  id = String(id || '').trim();
  if (!id) fail_('not_found', 'לא נמצאה הדרכה');
  const t = readTrainings_().find(function (x) { return x.id === id; });
  if (!t) fail_('not_found', 'לא נמצאה הדרכה');
  return t;
}

function isOpen_(t) {
  if (t.state === STATE.OPEN) return true;
  if (t.state === STATE.CLOSED) return false;
  return t.date === today_();
}

function publicTraining_(t) {
  return { id: t.id, name: t.name, date: t.date, category: t.category, instructor: t.instructor, open: isOpen_(t) };
}

function adminTraining_(t, count) {
  const p = publicTraining_(t);
  p.state = t.state === STATE.OPEN ? 'open' : t.state === STATE.CLOSED ? 'closed' : 'auto';
  p.count = count;
  return p;
}

function publicPerson_(p) {
  return { empNo: p.empNo, name: p.name, role: p.role };
}

function listTrainings_() {
  const counts = countsById_();
  return readTrainings_()
    .map(function (t) { return adminTraining_(t, counts[t.id] || 0); })
    .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
}

function validateProfile_(p) {
  p = p || {};
  const name = cleanText_(p.name, 60);
  const role = cleanText_(p.role, 40);
  const empNo = normEmp_(p.empNo);
  if (name.length < 2 || !/[א-ת]/.test(name)) fail_('invalid', 'יש להזין שם מלא בעברית');
  if (!role) fail_('invalid', 'יש להזין תפקיד');
  if (!empNo) fail_('invalid', 'מספר עובד לא תקין (ספרות בלבד)');
  return { name: name, role: role, empNo: empNo };
}

/** Employee number: digits only, leading zeros dropped so "0123" and "123" are the same person. */
function normEmp_(v) {
  const s = String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return s.length >= 1 && s.length <= 12 ? s : '';
}

/** Trims, collapses whitespace, and strips characters Sheets would treat as a formula. */
function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().replace(/^[=+\-@]+/, '').trim().slice(0, max);
}

function addPerson_(prof, user) {
  const row = [prof.empNo, prof.name, prof.role, user ? user.email : '', user ? user.sub : '', nowStr_()];
  const sh = sheet_(SHEET.PEOPLE);
  sh.appendRow(row);
  return { row: sh.getLastRow(), empNo: prof.empNo, name: prof.name, role: prof.role,
    email: row[3], sub: row[4], firstSeen: row[5] };
}

function linkGoogle_(person, user) {
  sheet_(SHEET.PEOPLE).getRange(person.row, 4, 1, 2).setValues([[user.email, user.sub]]);
  person.email = user.email;
  person.sub = user.sub;
}

function log_(trainingId, person, method, action, email, by) {
  sheet_(SHEET.LOG).appendRow([new Date(), trainingId, person.empNo, person.name, person.role,
    email || '', method, action, by || '']);
}

/**
 * Sets (present=true) or clears the V for person × training in נוכחות,
 * creating the training row / person column if needed. Must run under the lock.
 */
function mark_(t, person, present) {
  const sh = sheet_(SHEET.ATT);
  const idx = attIndex_(sh);
  const row = ensureTrainingRow_(sh, idx, t);
  let col = idx.emps.indexOf(person.empNo);
  if (col === -1) {
    if (!present) return { changed: false };
    col = ensurePersonCol_(sh, idx, person);
  } else {
    col = FIXED_COLS + 1 + col;
  }
  const cell = sh.getRange(row, col);
  const has = String(cell.getDisplayValue()).trim().toUpperCase() === MARK;
  if (has === present) return { changed: false };
  cell.setValue(present ? MARK : '');
  return { changed: true };
}

function attendeesOf_(t) {
  const sh = sheet_(SHEET.ATT);
  const idx = attIndex_(sh);
  const i = idx.ids.indexOf(t.id);
  if (i === -1 || idx.emps.length === 0) return [];
  const row = HEADER_ROWS + 1 + i;
  const marks = sh.getRange(row, FIXED_COLS + 1, 1, idx.emps.length).getDisplayValues()[0];
  const people = {};
  readPeople_().forEach(function (p) { people[p.empNo] = p; });

  // latest add-entry per employee for time + method
  const meta = {};
  const log = sheet_(SHEET.LOG);
  if (log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, 8).getValues().forEach(function (r) {
      if (String(r[1]) === t.id && r[7] === ACTION.ADD) {
        meta[normEmp_(r[2])] = { time: r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'HH:mm') : '', method: r[6] };
      }
    });
  }
  const out = [];
  marks.forEach(function (m, j) {
    if (String(m).trim().toUpperCase() !== MARK) return;
    const emp = idx.emps[j];
    const p = people[emp] || { name: idx.names[j], role: '' };
    const mt = meta[emp] || {};
    out.push({ empNo: emp, name: p.name, role: p.role, time: mt.time || '', method: mt.method || '' });
  });
  return out.sort(function (a, b) { return a.name.localeCompare(b.name, 'he'); });
}

function countFor_(id) {
  return countsById_()[id] || 0;
}

function countsById_() {
  const sh = sheet_(SHEET.ATT);
  const last = sh.getLastRow();
  const out = {};
  if (last <= HEADER_ROWS) return out;
  const width = Math.max(sh.getLastColumn(), FIXED_COLS);
  sh.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, width).getDisplayValues().forEach(function (r) {
    if (!r[0]) return;
    let n = 0;
    for (let c = FIXED_COLS; c < r.length; c++) if (String(r[c]).trim().toUpperCase() === MARK) n++;
    out[r[0]] = n;
  });
  return out;
}

// ---------------------------------------------------------------- נוכחות sheet

function attIndex_(sh) {
  const lastRow = Math.max(sh.getLastRow(), HEADER_ROWS);
  const lastCol = Math.max(sh.getLastColumn(), FIXED_COLS);
  const ids = lastRow > HEADER_ROWS
    ? sh.getRange(HEADER_ROWS + 1, 1, lastRow - HEADER_ROWS, 1).getDisplayValues().map(function (r) { return r[0]; })
    : [];
  let names = [], emps = [];
  if (lastCol > FIXED_COLS) {
    const h = sh.getRange(1, FIXED_COLS + 1, 2, lastCol - FIXED_COLS).getDisplayValues();
    names = h[0];
    emps = h[1].map(normEmp_);
  }
  return { lastRow: lastRow, lastCol: lastCol, ids: ids, names: names, emps: emps };
}

function attRow_(t, row) {
  const colG = columnLetter_(FIXED_COLS + 1);
  return [t.id, t.name, parseDate_(t.date), t.category, t.instructor,
    '=COUNTIF(' + colG + row + ':' + row + ',"' + MARK + '")'];
}

function ensureTrainingRow_(sh, idx, t) {
  const i = idx.ids.indexOf(t.id);
  if (i !== -1) return HEADER_ROWS + 1 + i;
  const row = idx.lastRow + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  sh.getRange(row, 1, 1, FIXED_COLS).setValues([attRow_(t, row)]);
  idx.ids.push(t.id);
  idx.lastRow = row;
  return row;
}

function ensurePersonCol_(sh, idx, p) {
  const col = idx.lastCol + 1;
  if (col > sh.getMaxColumns()) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 20);
    formatPeopleArea_(sh, col);
  }
  sh.getRange(2, col).setNumberFormat('@');
  sh.getRange(1, col, 2, 1).setValues([[p.name], [p.empNo]]);
  idx.names.push(p.name);
  idx.emps.push(p.empNo);
  idx.lastCol = col;
  return col;
}

/** Rebuilds נוכחות entirely from הדרכות + עובדים + יומן. Runs under the lock. */
function rebuild_() {
  const trainings = readTrainings_();
  const people = readPeople_();
  const known = {};
  people.forEach(function (p) { known[p.empNo] = true; });

  const marks = {};
  const log = sheet_(SHEET.LOG);
  if (log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, 8).getValues().forEach(function (r) {
      const tid = String(r[1]).trim(), emp = normEmp_(r[2]);
      if (!tid || !emp) return;
      if (!known[emp]) { // safety: someone in the log but missing from the registry
        known[emp] = true;
        people.push({ empNo: emp, name: String(r[3]), role: String(r[4]) });
      }
      if (r[7] === ACTION.REMOVE) delete marks[tid + '|' + emp];
      else marks[tid + '|' + emp] = true;
    });
  }

  const width = FIXED_COLS + people.length;
  const h1 = ATT_HEADERS.slice(), h2 = ['', '', '', '', '', 'מספר עובד ←'];
  people.forEach(function (p) { h1.push(p.name); h2.push(p.empNo); });
  const rows = [h1, h2];
  let total = 0;
  trainings.forEach(function (t, i) {
    const r = attRow_(t, HEADER_ROWS + 1 + i);
    people.forEach(function (p) {
      const v = marks[t.id + '|' + p.empNo] ? MARK : '';
      if (v) total++;
      r.push(v);
    });
    rows.push(r);
  });

  const sh = sheet_(SHEET.ATT);
  sh.clearContents();
  if (sh.getMaxColumns() < width + 5) sh.insertColumnsAfter(sh.getMaxColumns(), width + 5 - sh.getMaxColumns());
  if (sh.getMaxRows() < rows.length + 20) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 20 - sh.getMaxRows());
  sh.getRange(2, 1, 1, width).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, width).setValues(rows);
  formatAttendance_(sh);
  return { trainings: trainings.length, people: people.length, marks: total };
}

// ---------------------------------------------------------------- readers

function readTrainings_() {
  const sh = sheet_(SHEET.TRAININGS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const raw = sh.getRange(2, 3, n, 1).getValues();
  return sh.getRange(2, 1, n, 6).getDisplayValues().map(function (r, i) {
    // the date is stored as text; tolerate a hand-edited cell that Sheets turned into a real date
    const d = raw[i][0] instanceof Date ? Utilities.formatDate(raw[i][0], TZ, 'yyyy-MM-dd') : r[2].trim();
    return { row: i + 2, id: r[0].trim(), name: r[1], date: d, category: r[3], instructor: r[4],
      state: r[5].trim() || STATE.AUTO };
  }).filter(function (t) { return t.id; });
}

function readPeople_() {
  const sh = sheet_(SHEET.PEOPLE);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 6).getDisplayValues().map(function (r, i) {
    return { row: i + 2, empNo: normEmp_(r[0]), name: r[1].trim(), role: r[2].trim(), email: r[3].trim(),
      sub: r[4].trim(), firstSeen: r[5] };
  }).filter(function (p) { return p.empNo; });
}

let SETTINGS_MEMO = null;
function getSettings_() {
  if (SETTINGS_MEMO) return SETTINGS_MEMO;
  const sh = sheet_(SHEET.SETTINGS);
  const n = sh.getLastRow() - 1;
  const vals = n >= 1 ? sh.getRange(2, 1, n, 4).getDisplayValues() : [];
  const col = function (i) {
    return vals.map(function (r) { return String(r[i]).trim(); }).filter(Boolean);
  };
  SETTINGS_MEMO = {
    categories: col(0),
    admins: col(1).map(function (s) { return s.toLowerCase(); }),
    clientId: col(2)[0] || '',
    roles: col(3),
  };
  return SETTINGS_MEMO;
}

// ---------------------------------------------------------------- setup & formatting

/** Run once from the script editor (this also grants the web app its permissions). */
function setup() {
  ensureSetup_(true);
  const sh = sheet_(SHEET.SETTINGS);
  SETTINGS_MEMO = null;
  if (getSettings_().admins.length === 0) {
    const me = Session.getEffectiveUser().getEmail();
    if (me) sh.getRange(2, 2).setValue(me.toLowerCase());
  }
  // Touch an external URL so the external_request permission is granted now.
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  return 'ok';
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('נוכחות הדרכות')
    .addItem('בנייה מחדש של "נוכחות" מהיומן', 'rebuildFromMenu')
    .addItem('בדיקת מבנה הלשוניות', 'setup')
    .addToUi();
}

function rebuildFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('בנייה מחדש', 'לשונית "נוכחות" תיבנה מחדש מתוך "יומן", "עובדים" ו"הדרכות". שינויים ידניים בלשונית יימחקו. להמשיך?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const r = withLock_(rebuild_);
  ss_().toast(r.trainings + ' הדרכות, ' + r.people + ' עובדים, ' + r.marks + ' סימוני נוכחות', 'הבנייה הושלמה');
}

let SETUP_CHECKED = false;
function ensureSetup_(force) {
  if (SETUP_CHECKED && !force) return;
  const ss = ss_();
  const names = ss.getSheets().map(function (s) { return s.getName(); });
  const missing = [SHEET.ATT, SHEET.LOG, SHEET.PEOPLE, SHEET.SETTINGS, SHEET.TRAININGS]
    .filter(function (n) { return names.indexOf(n) === -1; });
  if (missing.length || force) withLock_(function () { createSheets_(); });
  SETUP_CHECKED = true;
}

function createSheets_() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);
  try { ss.setSpreadsheetLocale('iw_IL'); } catch (e) { /* locale is cosmetic */ }

  // Reuse the default empty first sheet as נוכחות
  if (!ss.getSheetByName(SHEET.ATT)) {
    const first = ss.getSheets()[0];
    if (ss.getSheets().length === 1 && first.getLastRow() === 0) first.setName(SHEET.ATT);
    else ss.insertSheet(SHEET.ATT, 0);
  }
  const att = ss.getSheetByName(SHEET.ATT);
  if (att.getLastRow() === 0) {
    att.getRange(1, 1, 2, FIXED_COLS).setValues([ATT_HEADERS, ['', '', '', '', '', 'מספר עובד ←']]);
  }
  formatAttendance_(att);

  const simple = [
    [SHEET.LOG, LOG_HEADERS, [3], [1]],
    [SHEET.PEOPLE, PEOPLE_HEADERS, [1], []],
    [SHEET.TRAININGS, TRAINING_HEADERS, [1, 3], []],
    [SHEET.SETTINGS, SETTINGS_HEADERS, [], []],
  ];
  simple.forEach(function (d) {
    let sh = ss.getSheetByName(d[0]);
    if (!sh) sh = ss.insertSheet(d[0]);
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, d[1].length).setValues([d[1]]);
    sh.setRightToLeft(true);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, d[1].length).setFontWeight('bold').setBackground(ACCENT_LIGHT);
    d[2].forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
    d[3].forEach(function (c) { sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss'); });
  });

  const st = ss.getSheetByName(SHEET.SETTINGS);
  if (st.getLastRow() < 2) {
    st.getRange(2, 1, 2, 1).setValues([['בטיחות'], ['מקצועי']]);
    const roles = ['רופא/ה', 'רופא/ה מתמחה', 'אח/ות', 'טכנאי/ת', 'מזכיר/ה', 'כוח עזר', 'סטודנט/ית'];
    st.getRange(2, 4, roles.length, 1).setValues(roles.map(function (r) { return [r]; }));
  }
  st.setColumnWidths(1, 4, 220);
  st.getRange(1, 3).setNote('הדביקו כאן (בתא C2) את ה-Client ID מ-Google Cloud Console');

  // tab order: נוכחות, יומן, עובדים, הדרכות, הגדרות
  try {
    [SHEET.ATT, SHEET.LOG, SHEET.PEOPLE, SHEET.TRAININGS, SHEET.SETTINGS].forEach(function (n, i) {
      ss.setActiveSheet(ss.getSheetByName(n));
      ss.moveActiveSheet(i + 1);
    });
    ss.setActiveSheet(att);
  } catch (e) { /* tab order is cosmetic */ }
}

function formatAttendance_(sh) {
  sh.setRightToLeft(true);
  sh.setFrozenRows(HEADER_ROWS);
  sh.setFrozenColumns(FIXED_COLS);
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  sh.getRange(1, 1, 1, maxC).setFontWeight('bold').setBackground(ACCENT_LIGHT).setWrap(true)
    .setVerticalAlignment('middle');
  sh.getRange(2, 1, 1, maxC).setNumberFormat('@').setFontColor('#6b7280').setFontSize(9)
    .setBackground('#f4f6f7');
  sh.getRange(HEADER_ROWS + 1, 3, maxR - HEADER_ROWS, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(1, FIXED_COLS, maxR, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidths(3, 3, 110);
  sh.setColumnWidth(FIXED_COLS, 90);
  formatPeopleArea_(sh, FIXED_COLS + 1);
}

function formatPeopleArea_(sh, fromCol) {
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (fromCol > maxC) return;
  sh.getRange(1, fromCol, maxR, maxC - fromCol + 1).setHorizontalAlignment('center');
  sh.getRange(HEADER_ROWS + 1, fromCol, maxR - HEADER_ROWS, maxC - fromCol + 1)
    .setFontColor(ACCENT).setFontWeight('bold');
  sh.setColumnWidths(fromCol, maxC - fromCol + 1, 96);
}

// ---------------------------------------------------------------- utils

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) fail_('config', 'הלשונית "' + name + '" חסרה בגיליון');
  return sh;
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(NaN);
}

function newId_() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return s;
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
