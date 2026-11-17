/* Check-in page */
(function () {
  const { api, store, $, esc, busy, formatDate, renderGoogleButton, ICONS } = App;
  const tid = (new URLSearchParams(location.search).get('t') || '').trim();
  const VIEWS = ['loading', 'msg', 'main', 'profile', 'manual', 'done'];
  const K_PROFILES = 'gi_profiles';   // { [googleSub]: {name, role, empNo} }
  const K_LAST = 'gi_last_google';    // { name }
  const K_MANUAL = 'gi_manual';       // {name, role, empNo} when "remember" is ticked
  let training = null;
  let token = null;

  function show(v) {
    VIEWS.forEach(x => { $('#v-' + x).hidden = x !== v; });
    window.scrollTo(0, 0);
  }

  function showMsg(icon, title, text, t) {
    $('#msg-icon').innerHTML = ICONS[icon] || ICONS.alert;
    $('#msg-title').textContent = title;
    $('#msg-text').textContent = text || '';
    $('#msg-training').textContent = t ? `${t.name} · ${formatDate(t.date)}` : '';
    show('msg');
  }

  function showClosed(t) {
    showMsg('lock', 'הרישום סגור', 'הרישום להדרכה זו פתוח רק ביום ההדרכה. לשאלות פנו למדריך/ה.', t || training);
  }

  function fillTraining(t) {
    $('#t-name').textContent = t.name;
    $('#t-cat').textContent = t.category;
    $('#t-cat').hidden = !t.category;
    $('#t-date').textContent = formatDate(t.date);
    $('#t-instr').textContent = t.instructor ? 'מדריך/ה: ' + t.instructor : '';
    $('#manual-sub').textContent = t.name;
    document.title = 'רישום · ' + t.name;
  }

  function fillRoles(roles) {
    if (!roles || !roles.length) return;
    $('#roles').innerHTML = roles.map(r => `<option value="${esc(r)}">`).join('');
  }

  function done(r) {
    const already = r.status === 'already';
    const icon = $('#done-icon');
    icon.className = 'state-icon pop' + (already ? ' soft' : '');
    icon.innerHTML = ICONS.check;
    $('#done-title').textContent = already ? 'כבר נרשמת' : 'נרשמת להדרכה';
    $('#done-name').textContent = r.person.name;
    $('#done-training').textContent = (already ? 'הנוכחות שלך כבר רשומה · ' : '') + training.name;
    show('done');
    if (!already && navigator.vibrate) navigator.vibrate(40);
  }

  function readForm(form) {
    const f = new FormData(form);
    return { name: String(f.get('name') || '').trim(), role: String(f.get('role') || '').trim(), empNo: String(f.get('empNo') || '').replace(/\D/g, '') };
  }

  function validate(p) {
    if (p.name.length < 2 || !/[א-ת]/.test(p.name)) return 'נא להזין שם מלא בעברית';
    if (!p.role) return 'נא להזין תפקיד';
    if (!p.empNo || p.empNo.length > 12) return 'נא להזין מספר עובד (ספרות בלבד)';
    return '';
  }

  function handleError(r, errEl) {
    if (r.code === 'closed') return showClosed(r.training);
    if (r.code === 'not_found') return showMsg('question', 'ההדרכה לא נמצאה', 'ייתכן שהקישור שגוי. סרקו שוב את קוד ה-QR.');
    errEl.textContent = r.message || 'משהו השתבש. נסו שוב.';
  }

  // ---------- Google
  async function onGoogle(idToken, payload) {
    token = idToken;
    $('#main-err').textContent = '';
    const profiles = store.get(K_PROFILES) || {};
    const profile = profiles[payload.sub] || null;
    busy(true);
    const r = await api('checkinGoogle', { t: tid, idToken, profile });
    busy(false);
    if (r.ok) return googleSuccess(r, payload.sub);
    if (r.code === 'need_profile' || (r.code === 'invalid' && profile)) {
      $('#profile-email').textContent = 'מחובר/ת כ-' + (r.email || payload.email || '');
      const saved = profile || {};
      $('#p-name').value = saved.name || (/[א-ת]/.test(r.googleName || '') ? r.googleName : '');
      $('#p-role').value = saved.role || '';
      $('#p-emp').value = saved.empNo || '';
      $('#profile-err').textContent = r.code === 'invalid' ? r.message : '';
      show('profile');
      setTimeout(() => $('#p-name').focus(), 50);
      return;
    }
    handleError(r, $('#main-err'));
  }

  function googleSuccess(r, sub) {
    const profiles = store.get(K_PROFILES) || {};
    profiles[sub] = r.person;
    store.set(K_PROFILES, profiles);
    store.set(K_LAST, { name: r.person.name });
    done(r);
  }

  $('#f-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = readForm(e.target);
    const err = validate(p);
    $('#profile-err').textContent = err;
    if (err) return;
    busy(true);
    const r = await api('checkinGoogle', { t: tid, idToken: token, profile: p });
    busy(false);
    if (r.ok) return googleSuccess(r, App.decodeJwt(token).sub);
    if (r.code === 'auth') {
      show('main');
      $('#main-err').textContent = 'פג תוקף ההתחברות – נא ללחוץ שוב על כניסה עם Google.';
      return;
    }
    handleError(r, $('#profile-err'));
  });

  // ---------- manual
  $('#go-manual').addEventListener('click', () => {
    const saved = store.get(K_MANUAL);
    if (saved) {
      $('#m-name').value = saved.name || '';
      $('#m-role').value = saved.role || '';
      $('#m-emp').value = saved.empNo || '';
    }
    $('#manual-err').textContent = '';
    show('manual');
  });
  $('#back-main').addEventListener('click', () => show('main'));

  $('#f-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = readForm(e.target);
    const err = validate(p);
    $('#manual-err').textContent = err;
    if (err) return;
    busy(true);
    const r = await api('checkinManual', Object.assign({ t: tid }, p));
    busy(false);
    if (r.ok) {
      if ($('#m-remember').checked) store.set(K_MANUAL, p); else store.del(K_MANUAL);
      return done(r);
    }
    handleError(r, $('#manual-err'));
  });

  // ---------- start
  async function init() {
    if (!tid) return showMsg('question', 'לא נמצאה הדרכה', 'הקישור אינו מלא. סרקו את קוד ה-QR שמוצג בהדרכה.');
    const r = await api('training', { t: tid });
    if (!r.ok) {
      if (r.code === 'not_found') return showMsg('question', 'ההדרכה לא נמצאה', 'ייתכן שהקישור שגוי או שההדרכה נמחקה. סרקו שוב את קוד ה-QR.');
      return showMsg('alert', 'לא ניתן לטעון את ההדרכה', r.message);
    }
    training = r.training;
    fillTraining(training);
    fillRoles(r.roles);
    if (!training.open) return showClosed(training);
    const last = store.get(K_LAST);
    if (last && last.name) {
      $('#returning').textContent = `שלום ${last.name}, לחיצה אחת והנוכחות נרשמת.`;
      $('#returning').hidden = false;
    }
    show('main');
    renderGoogleButton($('#gbtn'), onGoogle).catch(() => {
      $('#main-err').textContent = 'לא ניתן לטעון את הכניסה עם Google. אפשר להירשם ידנית.';
    });
  }

  init();
})();
