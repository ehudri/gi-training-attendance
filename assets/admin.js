/* Admin page */
(function () {
  const { api, $, esc, busy, toast, formatDate, formatShortDate, todayIso, renderGoogleButton, decodeJwt, qrSvg, checkinUrl } = App;
  const K_TOKEN = 'gi_admin_token';
  let token = null;
  let data = { categories: [], roles: [], people: [], trainings: [], today: todayIso() };
  let current = null;        // training shown in QR / attendees dialog
  let projectorId = null;
  let pollTimer = null;

  // ---------- session
  function saveToken(t) {
    token = t;
    try { sessionStorage.setItem(K_TOKEN, t); } catch (e) { /* ignore */ }
  }
  function loadToken() {
    try {
      const t = sessionStorage.getItem(K_TOKEN);
      if (t && decodeJwt(t).exp * 1000 > Date.now() + 60000) return t;
    } catch (e) { /* ignore */ }
    return null;
  }
  function signOut(message) {
    token = null;
    try { sessionStorage.removeItem(K_TOKEN); } catch (e) { /* ignore */ }
    clearInterval(pollTimer);
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    $('#who').hidden = true;
    showView('signin');
    $('#signin-err').textContent = message || '';
    renderGoogleButton($('#gbtn'), onToken).catch(() => { $('#signin-err').textContent = 'לא ניתן לטעון את הכניסה עם Google.'; });
  }

  function showView(v) {
    ['loading', 'signin', 'app'].forEach(x => { $('#v-' + x).hidden = x !== v; });
  }

  /** Admin API call with the stored ID token; expired token → back to sign-in. */
  async function call(action, payload) {
    const r = await api(action, Object.assign({ idToken: token }, payload || {}));
    if (!r.ok && r.code === 'auth') signOut('פג תוקף ההתחברות. נא להתחבר שוב.');
    if (!r.ok && r.code === 'forbidden') signOut(r.message);
    return r;
  }

  async function onToken(idToken) {
    saveToken(idToken);
    showView('loading');
    await init();
  }

  async function init() {
    const r = await call('adminInit');
    if (!r.ok) {
      if (r.code !== 'auth' && r.code !== 'forbidden') signOut(r.message);
      return;
    }
    data = r;
    $('#who-email').textContent = r.email;
    $('#who').hidden = false;
    $('#sheet-link').href = r.sheetUrl;
    $('#n-cat').innerHTML = r.categories.map(c => `<option>${esc(c)}</option>`).join('');
    $('#roles').innerHTML = r.roles.map(c => `<option value="${esc(c)}">`).join('');
    fillPeople();
    renderList();
    showView('app');
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 15000);
  }

  function fillPeople() {
    $('#people').innerHTML = data.people.map(p => `<option value="${esc(p.empNo)}">${esc(p.name)} · ${esc(p.role)}</option>`).join('');
  }

  async function refresh() {
    if (document.hidden || !token) return;
    const r = await call('listTrainings');
    if (!r.ok) return;
    data.trainings = r.trainings;
    data.today = r.today;
    renderList();
    updateProjectorCount();
  }

  // ---------- list
  function stateText(t) {
    return t.open ? 'פתוח לרישום' : 'סגור';
  }

  function renderList() {
    const list = $('#tlist');
    $('#tlist-empty').hidden = data.trainings.length > 0;
    list.innerHTML = data.trainings.map(t => `
      <article class="titem${t.date === data.today ? ' today' : ''}" data-id="${esc(t.id)}">
        <div>
          <div class="name">${esc(t.name)}</div>
          <div class="meta" style="margin-top:6px">
            <span>${esc(formatShortDate(t.date))}${t.date === data.today ? ' · היום' : ''}</span>
            <span class="chip">${esc(t.category)}</span>
            ${t.instructor ? `<span>${esc(t.instructor)}</span>` : ''}
          </div>
        </div>
        <div class="count"><b>${t.count == null ? '–' : t.count}</b><span>משתתפים</span></div>
        <div class="actions">
          <label class="status">
            <span class="switch"><input type="checkbox" data-act="toggle" ${t.open ? 'checked' : ''} aria-label="פתיחה או סגירה של הרישום"><span></span></span>
            <span>${stateText(t)} ${t.state === 'auto'
              ? '<span class="auto-tag">(אוטומטי)</span>'
              : '<button class="linkbtn" data-act="auto" type="button" style="font-size:13px;padding:8px 2px">חזרה לאוטומטי</button>'}</span>
          </label>
          <button class="btn secondary sm inline" data-act="qr" type="button">QR</button>
          <button class="btn secondary sm inline" data-act="att" type="button">משתתפים</button>
        </div>
      </article>`).join('');
    $('#refreshed').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  }

  function byId(id) { return data.trainings.find(t => t.id === id); }
  function replaceTraining(t) {
    const i = data.trainings.findIndex(x => x.id === t.id);
    if (i === -1) data.trainings.unshift(t);
    else data.trainings[i] = Object.assign({}, data.trainings[i], t, { count: t.count == null ? data.trainings[i].count : t.count });
  }

  $('#tlist').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act === 'toggle') return;
    const t = byId(e.target.closest('.titem').dataset.id);
    if (el.dataset.act === 'qr') openQr(t);
    if (el.dataset.act === 'att') openAttendees(t);
    if (el.dataset.act === 'auto') { e.preventDefault(); setState(t, 'auto'); }
  });
  $('#tlist').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const t = byId(e.target.closest('.titem').dataset.id);
    setState(t, e.target.checked ? 'open' : 'closed');
  });

  async function setState(t, state) {
    busy(true);
    const r = await call('setState', { t: t.id, state });
    busy(false);
    if (!r.ok) { toast(r.message || 'הפעולה נכשלה'); renderList(); return; }
    replaceTraining(r.training);
    renderList();
    toast(r.training.open ? 'הרישום נפתח' : 'הרישום נסגר');
  }

  // ---------- new training
  $('#btn-new').addEventListener('click', () => {
    $('#f-new').reset();
    $('#n-date').value = todayIso();
    $('#new-err').textContent = '';
    $('#d-new').showModal();
    setTimeout(() => $('#n-name').focus(), 50);
  });

  $('#f-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.name.trim()) { $('#new-err').textContent = 'נא להזין שם להדרכה'; return; }
    if (!f.date) { $('#new-err').textContent = 'נא לבחור תאריך'; return; }
    busy(true);
    const r = await call('createTraining', f);
    busy(false);
    if (!r.ok) { $('#new-err').textContent = r.message || 'היצירה נכשלה'; return; }
    replaceTraining(r.training);
    data.trainings.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    renderList();
    $('#d-new').close();
    openQr(r.training);
  });

  // ---------- QR
  function openQr(t) {
    current = t;
    const url = checkinUrl(t.id);
    $('#qr-title').textContent = t.name;
    $('#qr-meta').textContent = `${formatDate(t.date)} · ${t.category}`;
    $('#qr-box').innerHTML = qrSvg(url);
    $('#qr-link').value = url;
    $('#d-qr').showModal();
  }

  $('#btn-copy').addEventListener('click', async () => {
    const input = $('#qr-link');
    try { await navigator.clipboard.writeText(input.value); }
    catch (e) { input.select(); document.execCommand('copy'); }
    toast('הקישור הועתק');
  });

  $('#btn-proj').addEventListener('click', () => {
    const t = current;
    $('#d-qr').close();
    projectorId = t.id;
    $('#proj-title').textContent = t.name;
    $('#proj-sub').textContent = `${formatDate(t.date)} · ${t.category}${t.instructor ? ' · ' + t.instructor : ''}`;
    $('#proj-qr').innerHTML = qrSvg(checkinUrl(t.id));
    updateProjectorCount();
    $('#projector').hidden = false;
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 8000); // faster count while projecting
  });

  function closeProjector() {
    if ($('#projector').hidden) return;
    $('#projector').hidden = true;
    projectorId = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 15000);
  }
  $('#proj-close').addEventListener('click', closeProjector);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProjector(); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) closeProjector(); });

  function updateProjectorCount() {
    if (!projectorId) return;
    const t = byId(projectorId);
    const n = t && t.count != null ? t.count : 0;
    $('#proj-count').textContent = n ? `${n} נרשמו עד כה` : '';
  }

  $('#btn-print').addEventListener('click', () => {
    const t = current;
    const url = checkinUrl(t.id);
    $('#pr-title').textContent = t.name;
    $('#pr-sub').textContent = `${formatDate(t.date)} · ${t.category}${t.instructor ? ' · ' + t.instructor : ''}`;
    $('#pr-qr').innerHTML = qrSvg(url);
    $('#pr-url').textContent = url;
    $('#d-qr').close();
    setTimeout(() => window.print(), 50);
  });

  // ---------- attendees
  async function openAttendees(t) {
    current = t;
    $('#att-title').textContent = t.name;
    $('#att-meta').textContent = formatShortDate(t.date);
    $('#att-list').innerHTML = '<li><div class="spinner" style="margin:12px auto"></div></li>';
    resetAddForm();
    $('#d-att').showModal();
    const r = await call('attendees', { t: t.id });
    if (!r.ok) { $('#att-list').innerHTML = `<li class="empty">${esc(r.message)}</li>`; return; }
    renderAttendees(r.attendees);
  }

  function renderAttendees(list) {
    $('#att-meta').textContent = `${formatShortDate(current.date)} · ${list.length} משתתפים`;
    const t = byId(current.id);
    if (t) { t.count = list.length; renderList(); }
    $('#att-list').innerHTML = list.length ? list.map(a => `
      <li>
        <div class="info"><b>${esc(a.name)}</b><span>${esc(a.role)} · מס' ${esc(a.empNo)}${a.time ? ' · ' + esc(a.time) : ''}${a.method ? ' · ' + esc(a.method) : ''}</span></div>
        <button class="btn danger sm inline" type="button" data-emp="${esc(a.empNo)}" data-name="${esc(a.name)}">הסרה</button>
      </li>`).join('') : '<li class="empty">עדיין אין משתתפים</li>';
  }

  $('#att-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-emp]');
    if (!b) return;
    if (!confirm(`להסיר את ${b.dataset.name} מההדרכה "${current.name}"?`)) return;
    busy(true);
    const r = await call('removeAttendee', { t: current.id, empNo: b.dataset.emp });
    busy(false);
    if (!r.ok) { toast(r.message || 'ההסרה נכשלה'); return; }
    renderAttendees(r.attendees);
    toast('הרישום הוסר');
  });

  function resetAddForm() {
    $('#f-add').reset();
    $('#a-who').textContent = '';
    $('#a-new').hidden = true;
    $('#add-err').textContent = '';
  }

  function lookupEmp() {
    const emp = $('#a-emp').value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const p = data.people.find(x => x.empNo === emp);
    $('#a-who').textContent = p ? `✓ ${p.name} · ${p.role}` : (emp ? 'עובד/ת חדש/ה – נא להזין שם ותפקיד' : '');
    $('#a-new').hidden = !!p || !emp;
    return { emp, p };
  }
  $('#a-emp').addEventListener('input', lookupEmp);

  $('#f-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { emp, p } = lookupEmp();
    if (!emp) { $('#add-err').textContent = 'נא להזין מספר עובד'; return; }
    const payload = { t: current.id, empNo: emp };
    if (!p) {
      payload.name = $('#a-name').value.trim();
      payload.role = $('#a-role').value.trim();
      if (!payload.name || !payload.role) { $('#add-err').textContent = 'נא להזין שם ותפקיד'; return; }
    }
    busy(true);
    const r = await call('addAttendee', payload);
    busy(false);
    if (!r.ok) { $('#add-err').textContent = r.message || 'ההוספה נכשלה'; return; }
    if (!p) { data.people.push(r.person); fillPeople(); }
    renderAttendees(r.attendees);
    resetAddForm();
    toast(r.status === 'already' ? `${r.person.name} כבר רשום/ה` : `נוסף/ה: ${r.person.name}`);
  });

  // ---------- maintenance
  $('#btn-rebuild').addEventListener('click', async () => {
    if (!confirm('לבנות מחדש את לשונית "נוכחות" מתוך היומן? שינויים ידניים בלשונית יימחקו.')) return;
    busy(true);
    const r = await call('rebuild');
    busy(false);
    if (!r.ok) { toast(r.message || 'הבנייה נכשלה'); return; }
    toast(`נבנה מחדש: ${r.trainings} הדרכות, ${r.people} עובדים, ${r.marks} סימונים`);
    refresh();
  });

  // ---------- dialogs: close buttons + backdrop click
  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });
  $('#signout').addEventListener('click', () => signOut());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) refresh(); });

  // ---------- start
  const saved = loadToken();
  if (saved) { token = saved; init(); } else signOut();
})();
