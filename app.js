/* Aquary PWA — フロント本体（GAS版に寄せた版）
 * タブ: ホーム / 水槽 / 公開水槽 / 図鑑 / 通知（＋ヘッダーのアバターからアカウント）
 * 認証: Google Identity Services の id_token を GAS doPost API へ本文で送る
 * オフライン: 読み取り結果は localStorage にキャッシュ
 */
(function () {
  'use strict';
  var CFG = window.AQUARY_CONFIG || {};
  var app = document.getElementById('app');
  var nav = document.getElementById('nav');
  var whoEl = document.getElementById('who');

  var state = {
    token: null, exp: 0, tab: 'home', online: navigator.onLine,
    me: null, settings: null, foods: null, tanks: null, feeding: {}, records: null,
    publicTanks: null, activity: null, enc: null,
    impressed: {}, queue: lsGet('queue') || [], flushing: false,
  };

  // ---------- utils ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem('aq_' + k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('aq_' + k, JSON.stringify(v)); } catch (e) {} }
  function parseDate(v) { if (!v) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(s) { var d = parseDate(s); return d ? (d.getMonth() + 1) + '/' + d.getDate() : (s ? String(s) : ''); }
  function daysUntil(v) {
    var d = parseDate(v); if (!d) return null;
    var t = new Date(); t.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }
  function imgUrl(u) {
    u = String(u || ''); var m = u.match(/[-\w]{25,}/);
    if (u.indexOf('drive.google.com') >= 0 && m) return 'https://lh3.googleusercontent.com/d/' + m[0];
    return u;
  }
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'こんばんは'; }
  function isPublicTank(t) { return t && (t.isPublic === true || t.isPublic === 'TRUE' || t.isPublic === 'true'); }
  var PARAMS = [
    { key: 'temp', label: '水温', unit: '°C' }, { key: 'ph', label: 'pH', unit: '' },
    { key: 'gh', label: 'GH', unit: '' }, { key: 'kh', label: 'KH', unit: '' },
    { key: 'no2', label: 'NO₂', unit: 'mg/L' }, { key: 'no3', label: 'NO₃', unit: 'mg/L' },
    { key: 'tds', label: 'TDS', unit: 'ppm' }, { key: 'co2', label: 'CO₂', unit: 'mg/L' }
  ];
  var WQT = { temp: [22, 28], ph: [6.0, 7.5], gh: [3, 8], kh: [1, 4], no2: [0, 0.1], no3: [0, 25], tds: [50, 200], co2: [10, 30] };
  function capKey(k) { return k.charAt(0).toUpperCase() + k.slice(1); }
  function targetRange(t, key) {
    var mn = Number(t['target' + capKey(key) + 'Min']); var mx = Number(t['target' + capKey(key) + 'Max']);
    return [isNaN(mn) ? WQT[key][0] : mn, isNaN(mx) ? WQT[key][1] : mx];
  }
  function pColor(key, val, t) {
    if (val === undefined || val === '' || val === null) return 'var(--dim)';
    var v = Number(val); if (isNaN(v)) return 'var(--dim)';
    var r = targetRange(t, key); return (v < r[0] || v > r[1]) ? 'var(--yellow,#ffcf5a)' : 'var(--good)';
  }

  // ---------- API ----------
  function api(action, payload) {
    if (!CFG.GAS_API_URL || CFG.GAS_API_URL.indexOf('http') !== 0) return Promise.reject(new Error('config.js の GAS_API_URL が未設定です。'));
    if (!state.token) return Promise.reject(new Error('AUTH_REQUIRED'));
    return fetch(CFG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload || null, idToken: state.token }),
    }).then(function (r) { return r.json(); }, function () {
      var e = new Error('オフラインのため通信できませんでした。'); e.network = true; throw e;
    }).then(function (res) {
      if (!res || res.ok !== true) {
        var msg = (res && res.error) || '通信に失敗しました。';
        if (/AUTH_REQUIRED/.test(msg)) signOut(true);
        throw new Error(msg);
      }
      return res.data;
    });
  }
  // 書き込み用ラッパ：オフライン（ネットワーク失敗）時は端末に保存し、復帰時に自動送信する。
  function write(action, payload) {
    return api(action, payload).catch(function (e) {
      if (e && e.network) { enqueue(action, payload); return { queued: true }; }
      throw e;
    });
  }
  function enqueue(action, payload) {
    state.queue.push({ action: action, payload: payload, at: Date.now() });
    lsSet('queue', state.queue); updateQueueBanner();
  }
  function flushQueue() {
    if (!state.token || !state.queue.length || state.flushing) return Promise.resolve();
    state.flushing = true;
    var q = state.queue.slice();
    function remove(item) { var i = state.queue.indexOf(item); if (i >= 0) { state.queue.splice(i, 1); lsSet('queue', state.queue); } }
    function step(i) {
      if (i >= q.length) return Promise.resolve();
      return api(q[i].action, q[i].payload).then(function () { remove(q[i]); updateQueueBanner(); return step(i + 1); }, function (e) {
        if (e && e.network) return Promise.resolve(); // 通信不可：次回に持ち越し
        remove(q[i]); updateQueueBanner(); toast('未送信の記録を1件破棄しました', 'err'); return step(i + 1); // 検証エラー等は破棄
      });
    }
    return step(0).then(function () {
      state.flushing = false; updateQueueBanner();
      if (!state.queue.length) { toast('未送信の記録を送信しました'); if (state.tab) setTab(state.tab); }
    });
  }
  function updateQueueBanner() {
    var el = document.getElementById('qbanner');
    if (!state.queue.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'qbanner'; el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:74px;background:#3a2a0a;border:1px solid #6b520a;color:#ffe6a8;padding:8px 14px;border-radius:999px;font-size:12px;z-index:25;display:flex;gap:10px;align-items:center;box-shadow:0 6px 20px #0008'; document.body.appendChild(el); }
    el.innerHTML = '📤 未送信 ' + state.queue.length + '件 <button id="qflush" style="background:var(--accent);color:#00151d;border:none;border-radius:8px;font-weight:700;padding:3px 10px;cursor:pointer;font-family:inherit">送信</button>';
    var fb = document.getElementById('qflush'); if (fb) fb.addEventListener('click', function () { if (!state.online) { toast('オフラインです', 'err'); return; } flushQueue(); });
  }

  // ---------- auth ----------
  function decodeJwtExp(jwt) {
    try { var p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return Number(p.exp || 0) * 1000; } catch (e) { return 0; }
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    state.token = resp.credential; state.exp = decodeJwtExp(resp.credential);
    lsSet('token', { t: resp.credential, exp: state.exp });
    boot();
  }
  function initGis() {
    if (!window.google || !google.accounts || !google.accounts.id) return false;
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true, use_fedcm_for_prompt: true });
    return true;
  }
  function renderLogin() {
    nav.style.display = 'none'; whoEl.innerHTML = '';
    app.innerHTML = '<div class="center"><div>' +
      '<div style="font-size:54px;margin-bottom:8px">🐟</div><h2 style="margin:0 0 6px">Aquary</h2>' +
      '<div class="muted" style="margin-bottom:20px">水槽・水質・給餌・図鑑をまとめて管理</div>' +
      '<div id="gbtn" style="display:flex;justify-content:center"></div>' +
      (CFG.GOOGLE_CLIENT_ID && CFG.GOOGLE_CLIENT_ID.indexOf('apps.googleusercontent') >= 0 ? '' :
        '<div class="muted" style="margin-top:16px;color:var(--red)">config.js の GOOGLE_CLIENT_ID を設定してください。</div>') +
      '</div></div>';
    if (initGis()) {
      google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ja' });
      google.accounts.id.prompt();
    } else setTimeout(renderLogin, 400);
  }
  function signOut(silent) {
    state.token = null; state.exp = 0;
    try { localStorage.removeItem('aq_token'); } catch (e) {}
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
    if (!silent) toast('ログアウトしました');
    renderLogin();
  }
  function tokenValid() { return state.token && state.exp - Date.now() > 30 * 1000; }

  // ---------- modal ----------
  function modal(html) {
    closeModal();
    var ov = document.createElement('div');
    ov.id = 'aq-modal';
    ov.style.cssText = 'position:fixed;inset:0;background:#0009;z-index:30;display:flex;align-items:flex-end;justify-content:center';
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    ov.innerHTML = '<div style="background:var(--card);border:1px solid var(--border);border-top-left-radius:16px;border-top-right-radius:16px;width:100%;max-width:560px;max-height:84vh;overflow:auto;padding:16px 16px calc(20px + env(safe-area-inset-bottom))">' + html + '</div>';
    document.body.appendChild(ov);
  }
  function closeModal() { var m = document.getElementById('aq-modal'); if (m) m.remove(); }
  window.aqCloseModal = closeModal;

  // ---------- 画像（端末で圧縮してから送る：長辺1600px・JPEG） ----------
  function pickImage() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) { resolve(null); return; }
        compressImage(f).then(resolve).catch(function () { resolve(null); });
      });
      inp.click();
    });
  }
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 1600; var w = img.width, h = img.height;
          if (w > max || h > max) { if (w >= h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          var dataUrl = c.toDataURL('image/jpeg', 0.82);
          resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', fileName: 'photo.jpg' });
        };
        img.onerror = reject; img.src = fr.result;
      };
      fr.onerror = reject; fr.readAsDataURL(file);
    });
  }
  function inputRow(id, label, val, type) {
    return '<div style="margin-bottom:8px"><label class="muted" style="font-size:12px">' + esc(label) + '</label>' +
      '<input id="' + id + '"' + (type ? ' type="' + type + '"' : '') + ' value="' + esc(val == null ? '' : val) + '" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)"></div>';
  }
  function textareaRow(id, label, val) {
    return '<div style="margin-bottom:8px"><label class="muted" style="font-size:12px">' + esc(label) + '</label>' +
      '<textarea id="' + id + '" rows="3" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text);font-family:inherit">' + esc(val == null ? '' : val) + '</textarea></div>';
  }
  function val(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }

  // ---------- データ取得 ----------
  function boot() {
    if (!tokenValid()) { renderLogin(); return; }
    nav.style.display = 'flex';
    app.innerHTML = loadingHtml();
    api('bootstrap').then(function (b) {
      b = b || {};
      state.me = b.me || state.me; lsSet('me', state.me);
      state.tanks = b.tanks || []; lsSet('tanks', state.tanks);
      state.settings = b.settings || {}; lsSet('settings', state.settings);
      state.foods = b.foods || []; lsSet('foods', state.foods);
      state.feeding = b.feeding || {};
      paintWho();
      if (state.me && state.me.needsTermsConsent && !state.me.isAdmin) { termsGate(); return; }
      setTab(state.tab || 'home');
      // クイック操作の「前回」表示用に記録を遅延取得
      api('getRecords', {}).then(function (r) { state.records = r || []; if (state.tab === 'home') viewHome(); }).catch(function () {});
      // 通知バッジ
      refreshActivityBadge();
      // オフライン中に貯まった書き込みを送信
      updateQueueBanner(); flushQueue();
    }).catch(function (e) {
      var cm = lsGet('me');
      if (cm) {
        state.me = cm; state.tanks = lsGet('tanks') || []; state.settings = lsGet('settings') || {}; state.foods = lsGet('foods') || [];
        paintWho(); setTab(state.tab || 'home'); updateQueueBanner();
      } else {
        app.innerHTML = '<div class="center"><div><div class="muted">' + esc(e.message) + '</div><button class="btn" style="margin-top:14px" onclick="location.reload()">再読み込み</button></div></div>';
      }
    });
  }
  function paintWho() {
    var me = state.me || {};
    whoEl.innerHTML = (me.avatarUrl ? '<img class="av" id="av-btn" src="' + esc(imgUrl(me.avatarUrl)) + '">' : '<span class="av" id="av-btn" style="display:grid;place-items:center">🐟</span>') ;
    var b = document.getElementById('av-btn'); if (b) { b.style.cursor = 'pointer'; b.addEventListener('click', function () { setTab('account'); }); }
  }
  function loadingHtml() { return '<div class="center"><div class="spin"></div></div>'; }
  function offlineBanner() { return state.online ? '' : '<div class="offline">📴 オフライン表示中（最後に取得した内容です）</div>'; }
  function termsGate() {
    nav.style.display = 'none';
    app.innerHTML = '<div class="center"><div style="max-width:420px">' +
      '<div style="font-size:40px">📜</div><h2 style="margin:6px 0">利用規約・プライバシー</h2>' +
      '<div class="muted" style="line-height:1.8;margin:12px 0">Aquaryを使うには、利用規約とプライバシーポリシーへの同意が必要です。水槽データ・画像はあなたのGoogleアカウントに紐づけて保存されます。</div>' +
      '<button class="btn full" id="terms-ok">同意して始める</button></div></div>';
    document.getElementById('terms-ok').addEventListener('click', function () {
      this.disabled = true; this.textContent = '処理中...';
      api('acceptTerms').then(function (me) { state.me = me || state.me; lsSet('me', state.me); nav.style.display = 'flex'; boot(); })
        .catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('terms-ok'); if (b) { b.disabled = false; b.textContent = '同意して始める'; } });
    });
  }

  // ---------- タブ制御 ----------
  function setTab(tab) {
    state.tab = tab;
    [].forEach.call(nav.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    if (tab === 'home') viewHome();
    else if (tab === 'tanks') viewTanks();
    else if (tab === 'public') viewPublic();
    else if (tab === 'enc') viewEnc();
    else if (tab === 'activity') viewActivity();
    else if (tab === 'account') viewAccount();
  }

  // ================= ホーム =================
  function lastRecordDays(type) {
    if (!state.records) return null;
    var found = null;
    state.records.forEach(function (r) { if (String(r.type) === type) { var d = parseDate(r.createdAt); if (d && (!found || d > found)) found = d; } });
    if (!found) return null;
    var t = new Date(); t.setHours(0, 0, 0, 0); var f = new Date(found); f.setHours(0, 0, 0, 0);
    return Math.round((t.getTime() - f.getTime()) / 86400000);
  }
  function feedingDue(tankId) {
    return (state.feeding[tankId] || []).filter(function (f) { var d = daysUntil(f.nextFeedAt); return d !== null && d <= 0; });
  }
  function todoItems() {
    var tanks = state.tanks || []; var items = [];
    tanks.forEach(function (t) {
      var base = { tankId: t.id, tankName: t.name, photoUrl: t.photoUrl || '', tankType: t.type || '' };
      var d = daysUntil(t.nextChange);
      if (d !== null && d <= 0) items.push(Object.assign({}, base, { priority: 10, kind: 'water', tone: 'warn', title: '換水が必要です', body: '予定日を過ぎています', todo: 'water', actionText: '換水する' }));
      else if (d !== null && d <= 3) items.push(Object.assign({}, base, { priority: 40, kind: 'water', tone: 'near', title: '換水が近いです', body: '次回 ' + fmtDate(t.nextChange), todo: 'water', actionText: '換水する' }));
      var df = feedingDue(t.id);
      if (df.length) items.push(Object.assign({}, base, { priority: 20, kind: 'feeding', tone: 'good', title: '給餌の時間です', body: df[0].foodName || '予定時刻です', todo: 'feeding', scheduleId: df[0].id, actionText: '給餌する' }));
      if (t.status === '注意' || t.status === '危険') items.push(Object.assign({}, base, { priority: t.status === '危険' ? 30 : 60, kind: 'wq', tone: t.status === '危険' ? 'bad' : 'warn', title: '水質を確認', body: '状態: ' + t.status, todo: 'wq', actionText: '測定する' }));
      if (typeof t.filterDays === 'number' && t.filterDays >= 30) items.push(Object.assign({}, base, { priority: 50, kind: 'maint', tone: 'warn', title: 'フィルター掃除', body: '稼働 ' + t.filterDays + '日', todo: 'maint', actionText: '掃除する' }));
    });
    return items.sort(function (a, b) { return (a.priority || 99) - (b.priority || 99); });
  }
  function toneColor(tone) { return tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--yellow,#ffcf5a)' : 'var(--accent)'; }
  function todoHtml() {
    if (state.tanks === null) return '';
    if (!state.tanks.length) return gettingStartedHtml();
    var items = todoItems();
    if (!items.length) return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>今日やること</b><span class="pill" style="color:var(--good)">0件</span></div><div class="muted">急ぎの作業はありません。水槽の様子を軽く見ておきましょう。</div></div>';
    return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>今日やること</b><span class="pill" style="color:#ffb4b4;background:#3a1414;border-color:#6b2a2a">' + items.length + '件</span></div>' +
      items.slice(0, 6).map(function (x) {
        return '<div class="row">' +
          (x.photoUrl ? '<img class="thumb" style="width:48px;height:38px" src="' + esc(imgUrl(x.photoUrl)) + '">' : '<div class="thumb" style="width:48px;height:38px;display:grid;place-items:center">🐟</div>') +
          '<div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(x.tankName || '水槽') + '</div>' +
          '<div class="meta">' + esc(x.title) + ' <span style="color:' + toneColor(x.tone) + '">' + esc(x.body) + '</span></div></div>' +
          '<button class="btn" style="padding:8px 12px;font-size:12px" data-todo="' + esc(JSON.stringify(x)) + '">' + esc(x.actionText) + '</button></div>';
      }).join('') + '</div>';
  }
  function gettingStartedHtml() {
    return '<div class="card"><b>はじめる</b><div class="muted" style="margin-top:8px">まずは水槽を登録しましょう。</div>' +
      '<button class="btn full" style="margin-top:12px" id="add-tank-btn">最初の水槽を追加</button></div>';
  }
  function quickHtml() {
    if (!state.tanks || !state.tanks.length) return '';
    var defs = [['換水', 'water', '#00D5E8'], ['給餌', 'feeding', '#D8F542'], ['水質測定', 'wq', '#35D7FF'], ['フィルター掃除', 'maint', '#8BA6B5']];
    var typeOf = { water: '水換え', feeding: '給餌', wq: '水質測定', maint: 'フィルター掃除' };
    return '<div class="card"><b>クイック操作</b><div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-top:10px">' +
      defs.map(function (a) {
        var last = lastRecordDays(typeOf[a[1]]);
        var lastTxt = last === null ? '未実施' : last === 0 ? '今日' : '前回 ' + last + '日前';
        return '<button class="btn sec" style="flex-direction:column;padding:10px 4px;font-size:11px;color:var(--text)" data-quick="' + a[1] + '">' +
          '<div style="font-size:18px;color:' + a[2] + '">●</div><div style="font-weight:800;margin-top:4px">' + esc(a[0]) + '</div>' +
          '<div class="muted" style="font-size:10px;margin-top:3px">' + esc(lastTxt) + '</div></button>';
      }).join('') + '</div></div>';
  }
  function promoFoods() {
    var list = (state.foods || []).filter(function (f) { return f.affiliateLink && !f.hidden; });
    var featured = String((state.settings && state.settings.featuredProductIds) || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var rank = {}; featured.forEach(function (id, i) { rank[id] = i + 1; });
    return list.sort(function (a, b) {
      var af = rank[a.id] || 9999, bf = rank[b.id] || 9999;
      if (af !== bf) return af - bf;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
    });
  }
  function promoHtml() {
    var foods = promoFoods().slice(0, 2);
    if (!foods.length) return '';
    return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>今日のおすすめ用品</b><span class="pill">PR</span></div>' +
      '<div class="muted" style="margin:6px 0 4px">登録済みの商品リンクからすぐ確認できます</div>' +
      foods.map(function (f) {
        return '<a class="row" href="' + esc(f.affiliateLink) + '" target="_blank" rel="noopener noreferrer" data-aff="' + esc(f.id) + '" style="text-decoration:none;color:var(--text)">' +
          (f.imageUrl ? '<img class="thumb" src="' + esc(imgUrl(f.imageUrl)) + '">' : '<div class="thumb" style="display:grid;place-items:center">🧰</div>') +
          '<div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(f.name) + '</div><div class="meta">' + esc(f.brand || f.type || 'Amazonで見る') + '</div></div>' +
          '<span style="color:#ff9900;font-weight:700;font-size:12px">Amazon</span></a>';
      }).join('') + '</div>';
  }
  function viewHome() {
    var me = state.me || {};
    app.innerHTML = offlineBanner() +
      '<div style="padding:4px 2px 10px"><div class="muted">' + esc(greeting()) + '</div>' +
      '<h2 style="margin:2px 0 0;font-size:20px">' + esc(me.displayName || 'アクアリスト') + 'さんの水槽</h2></div>' +
      todoHtml() + quickHtml() + promoHtml();
    bindHome();
  }
  function bindHome() {
    var addBtn = document.getElementById('add-tank-btn'); if (addBtn) addBtn.addEventListener('click', addTankModal);
    [].forEach.call(app.querySelectorAll('[data-todo]'), function (b) {
      b.addEventListener('click', function () { runTodo(JSON.parse(b.getAttribute('data-todo')), b); });
    });
    [].forEach.call(app.querySelectorAll('[data-quick]'), function (b) {
      b.addEventListener('click', function () { quick(b.getAttribute('data-quick')); });
    });
    // アフィリエイト表示計測（セッション内1回）＋クリック計測
    [].forEach.call(app.querySelectorAll('[data-aff]'), function (a) {
      var id = a.getAttribute('data-aff');
      if (!state.impressed[id]) { state.impressed[id] = 1; api('trackAffiliateImpression', { foodId: id, screen: 'promo_home' }).catch(function () {}); }
      a.addEventListener('click', function () { api('trackAffiliateClick', { foodId: id, screen: 'promo_home' }).catch(function () {}); });
    });
  }

  // ---------- 操作（記録/給餌/todo/クイック） ----------
  var QTYPE = { water: '水換え', feeding: '給餌', wq: '水質測定', maint: 'フィルター掃除' };
  var QLABEL = { water: '換水', feeding: '給餌', wq: '水質測定', maint: 'フィルター掃除' };
  function recordAction(tankId, tankName, type, done) {
    write('addRecord', { tankId: tankId, type: type, tankName: tankName }).then(function (res) {
      if (res && res.queued) { toast('オフライン：送信待ちに保存しました'); if (done) done(); return; }
      toast(type + 'を記録しました');
      api('getRecords', {}).then(function (r) { state.records = r || []; }).catch(function () {});
      // 換水/掃除は水槽側も変わるので再取得
      api('getTanks').then(function (t) { state.tanks = t || []; lsSet('tanks', state.tanks); if (state.tab === 'home') viewHome(); else if (state.tab === 'tanks') viewTanks(); }).catch(function () {});
      if (done) done();
    }).catch(function (e) { toast(e.message, 'err'); if (done) done(e); });
  }
  function chooseTank(title, cb) {
    var tanks = state.tanks || [];
    if (!tanks.length) { toast('水槽がありません', 'err'); return; }
    if (tanks.length === 1) { cb(tanks[0]); return; }
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>' + esc(title) + '</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      tanks.map(function (t) { return '<button class="btn sec full" style="text-align:left;margin-bottom:8px" data-pick="' + esc(t.id) + '">' + esc(t.name || '水槽') + '</button>'; }).join(''));
    [].forEach.call(document.querySelectorAll('[data-pick]'), function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-pick'); var t = tanks.filter(function (x) { return x.id === id; })[0]; closeModal(); cb(t); });
    });
  }
  function quick(kind) {
    chooseTank(QLABEL[kind] + 'する水槽を選択', function (t) {
      if (!confirm('「' + (t.name || '水槽') + '」の' + QLABEL[kind] + 'を記録しますか？')) return;
      recordAction(t.id, t.name, QTYPE[kind]);
    });
  }
  function runTodo(x, btn) {
    if (x.todo === 'feeding' && x.scheduleId) {
      btn.disabled = true; btn.textContent = '記録中...';
      write('recordFeeding', { id: x.scheduleId }).then(function (res) {
        if (res && res.queued) { btn.textContent = '保存 ✓'; toast('オフライン：送信待ちに保存しました'); return; }
        toast('給餌を記録しました'); btn.textContent = '完了 ✓';
        api('bootstrap').then(function (b) { state.feeding = (b && b.feeding) || {}; state.tanks = (b && b.tanks) || state.tanks; if (state.tab === 'home') viewHome(); }).catch(function () {});
      }).catch(function (e) { btn.disabled = false; btn.textContent = x.actionText; toast(e.message, 'err'); });
      return;
    }
    var type = QTYPE[x.kind] || 'その他';
    if (!confirm('「' + (x.tankName || '水槽') + '」の' + (QLABEL[x.kind] || x.title) + 'を記録しますか？')) return;
    btn.disabled = true; btn.textContent = '記録中...';
    recordAction(x.tankId, x.tankName, type, function (e) { if (e) { btn.disabled = false; btn.textContent = x.actionText; } });
  }
  function addTankModal() {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>水槽を追加</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      '<label class="muted">水槽名</label><input id="nt-name" class="inp" style="width:100%;margin:4px 0 12px;padding:10px;background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--text)" placeholder="例: 60cm水槽">' +
      '<label class="muted">水量(L・任意)</label><input id="nt-vol" class="inp" type="number" style="width:100%;margin:4px 0 16px;padding:10px;background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--text)" placeholder="例: 60">' +
      '<button class="btn full" id="nt-save">追加する</button>');
    document.getElementById('nt-save').addEventListener('click', function () {
      var name = (document.getElementById('nt-name').value || '').trim();
      if (!name) { toast('水槽名を入力してください', 'err'); return; }
      var vol = (document.getElementById('nt-vol').value || '').trim();
      this.disabled = true; this.textContent = '追加中...';
      api('addTank', { name: name, volume: vol }).then(function () {
        closeModal(); toast('水槽を追加しました');
        api('getTanks').then(function (t) { state.tanks = t || []; lsSet('tanks', state.tanks); setTab('tanks'); }).catch(function () {});
      }).catch(function (e) { toast(e.message, 'err'); }).then(function () {});
    });
  }

  // ================= 水槽 =================
  function tankCard(t) {
    var params = [['水温', t.temp, '°C'], ['pH', t.ph, ''], ['GH', t.gh, ''], ['KH', t.kh, '']];
    var sc = t.status === '危険' ? 'var(--red)' : t.status === '注意' ? 'var(--yellow,#ffcf5a)' : 'var(--good)';
    var d = daysUntil(t.nextChange);
    return '<div class="card">' +
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">' +
      (t.photoUrl ? '<img class="thumb" style="width:56px;height:56px" src="' + esc(imgUrl(t.photoUrl)) + '">' : '<div class="thumb" style="width:56px;height:56px;display:grid;place-items:center;font-size:24px">🐠</div>') +
      '<div style="flex:1;min-width:0"><div class="ttl">' + esc(t.name || '水槽') + '</div>' +
      '<div class="meta">' + esc(t.type || '') + (t.volume ? ' ・ ' + esc(t.volume) + (/[0-9]$/.test(String(t.volume)) ? 'L' : '') : '') + '</div></div>' +
      '<span class="pill" style="color:' + sc + '">' + esc(t.status || '良好') + '</span></div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px">' +
      params.map(function (p) { return '<div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:6px;text-align:center"><div class="muted" style="font-size:10px">' + p[0] + '</div><div style="font-weight:700;font-size:14px">' + (p[1] !== undefined && p[1] !== '' ? esc(p[1]) : '--') + '</div></div>'; }).join('') +
      '</div>' +
      '<div class="meta" style="margin-bottom:8px">次回換水: ' + (t.nextChange ? esc(fmtDate(t.nextChange)) + (d !== null && d <= 0 ? '（期限超過）' : d !== null ? '（あと' + d + '日）' : '') : '未設定') + '</div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">' +
      [['換水', 'water'], ['給餌', 'feeding'], ['水質', 'wq'], ['掃除', 'maint']].map(function (a) {
        return '<button class="btn sec" style="font-size:11px;padding:8px 4px" data-act="' + a[1] + '" data-tid="' + esc(t.id) + '" data-tn="' + esc(t.name || '') + '">' + esc(a[0]) + '</button>';
      }).join('') +
      '</div>' +
      '<button class="btn sec full" style="margin-top:8px;font-size:12px" data-open="' + esc(t.id) + '">詳細を見る ›</button>' +
      '</div>';
  }
  function viewTanks() {
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 2px 10px"><h2 style="margin:0;font-size:20px">水槽</h2><button class="btn" style="padding:8px 12px;font-size:13px" id="add-tank2">＋ 追加</button></div>' +
      ((state.tanks && state.tanks.length) ? state.tanks.map(tankCard).join('') : '<div class="card"><div class="muted">水槽がまだありません。</div></div>');
    var a = document.getElementById('add-tank2'); if (a) a.addEventListener('click', addTankModal);
    [].forEach.call(app.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-act'), tid = b.getAttribute('data-tid'), tn = b.getAttribute('data-tn');
        if (!confirm('「' + tn + '」の' + QLABEL[kind] + 'を記録しますか？')) return;
        recordAction(tid, tn, QTYPE[kind]);
      });
    });
    [].forEach.call(app.querySelectorAll('[data-open]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-open'); var t = (state.tanks || []).filter(function (x) { return x.id === id; })[0];
        if (t) openDetail(t);
      });
    });
  }

  // ================= 水槽の詳細 =================
  function openDetail(t) { state.selTank = t; state.tankTab = state.tankTab || 'wq'; loadDetail(t.id); viewTankDetail(); }
  function loadDetail(id) {
    state.dd = { wq: null, orgs: null, plants: null, records: null, equip: null };
    function done(tab) { if (state.selTank && state.selTank.id === id && state.tankTab === tab) paintDetailBody(); }
    api('getWaterQuality', { tankId: id }).then(function (d) { state.dd.wq = d || []; done('wq'); }).catch(function () { state.dd.wq = []; done('wq'); });
    api('getOrganisms', { tankId: id }).then(function (d) { state.dd.orgs = d || []; done('orgs'); }).catch(function () { state.dd.orgs = []; done('orgs'); });
    api('getPlants', { tankId: id }).then(function (d) { state.dd.plants = d || []; done('plants'); }).catch(function () { state.dd.plants = []; done('plants'); });
    api('getRecords', { tankId: id }).then(function (d) { state.dd.records = d || []; done('records'); }).catch(function () { state.dd.records = []; done('records'); });
    api('getEquipment', { tankId: id }).then(function (d) { state.dd.equip = d || []; done('equip'); }).catch(function () { state.dd.equip = []; done('equip'); });
    if (state.feeding[id] === undefined) {
      api('getFeedingSchedules', { tankIds: [id] }).then(function (m) { state.feeding[id] = (m && m[id]) || []; done('feeding'); }).catch(function () { state.feeding[id] = []; done('feeding'); });
    }
  }
  var DETAIL_TABS = [['wq', '水質'], ['orgs', '生体'], ['plants', '水草'], ['feeding', '給餌'], ['equip', '設備'], ['records', '記録']];
  function viewTankDetail() {
    var t = state.selTank; if (!t) { setTab('tanks'); return; }
    var emoji = t.type === '海水' ? '🐡' : t.type === 'ビオトープ' ? '🌾' : '🌿';
    var paramGrid = '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin:10px 0">' +
      PARAMS.map(function (p) {
        var val = t[p.key]; var col = pColor(p.key, val, t);
        var has = val !== undefined && val !== '' && val !== null;
        return '<div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:7px;text-align:center">' +
          '<div class="muted" style="font-size:10px">' + p.label + '</div>' +
          '<div style="font-weight:700;font-size:14px">' + (has ? esc(val) : '--') + '<span class="muted" style="font-size:9px">' + p.unit + '</span></div>' +
          '<div style="font-size:9px;color:' + col + '">' + (has ? (col === 'var(--good)' ? '基準内' : '基準外') : '未測定') + '</div></div>';
      }).join('') + '</div>';
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 2px 8px">' +
      '<button class="btn sec" style="padding:6px 10px" id="det-back">←</button>' +
      '<h2 style="margin:0;font-size:18px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.name || '水槽') + '</h2>' +
      '<button class="btn sec" style="padding:6px 10px" id="det-settings">⚙</button></div>' +
      (t.photoUrl ? '<img src="' + esc(imgUrl(t.photoUrl)) + '" style="width:100%;max-height:220px;object-fit:cover;border-radius:14px;background:#0A2D3F">' : '<div style="height:140px;border-radius:14px;background:var(--card2);display:grid;place-items:center;font-size:60px">' + emoji + '</div>') +
      '<div class="card" style="margin-top:10px"><div style="display:flex;justify-content:space-around;text-align:center">' +
      [['設置日', t.setupDate || '未設定'], ['水量', (t.volume || '--')], ['タイプ', t.type || '--']].map(function (r) {
        return '<div><div class="muted" style="font-size:11px">' + r[0] + '</div><div style="font-weight:700;font-size:14px">' + esc(r[1]) + '</div></div>';
      }).join('') + '</div>' + paramGrid + '</div>' +
      '<div class="card" style="padding:6px"><div style="display:flex;gap:4px;overflow:auto" id="det-tabs">' +
      DETAIL_TABS.map(function (d) { return '<button class="btn sec" style="flex:1;font-size:12px;padding:8px 4px' + (state.tankTab === d[0] ? ';background:var(--accent);color:#00151d' : '') + '" data-dt="' + d[0] + '">' + d[1] + '</button>'; }).join('') +
      '</div></div>' +
      '<div id="det-body"></div>';
    document.getElementById('det-back').addEventListener('click', function () { state.selTank = null; setTab('tanks'); });
    document.getElementById('det-settings').addEventListener('click', function () { tankSettingsForm(t); });
    [].forEach.call(app.querySelectorAll('[data-dt]'), function (b) {
      b.addEventListener('click', function () { state.tankTab = b.getAttribute('data-dt'); viewTankDetail(); });
    });
    paintDetailBody();
  }
  function detLoading() { return '<div class="card"><div style="display:flex;justify-content:center;padding:14px"><div class="spin"></div></div></div>'; }
  function statusPill(s) { var c = s === '危険' || s === '死亡' ? 'var(--red)' : s === '注意' || s === '治療中' ? 'var(--yellow,#ffcf5a)' : 'var(--good)'; return '<span class="pill" style="color:' + c + '">' + esc(s || '良好') + '</span>'; }
  function paintDetailBody() {
    var body = document.getElementById('det-body'); if (!body) return;
    var t = state.selTank; var tab = state.tankTab; var dd = state.dd || {};
    if (tab === 'wq') {
      var list = dd.wq;
      body.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>水質の記録</b><button class="btn" style="padding:7px 12px;font-size:12px" id="wq-add">＋ 測定</button></div>' +
        (list === null ? '<div style="display:flex;justify-content:center;padding:10px"><div class="spin"></div></div>' :
          (list.length ? (wqGraph(list, t) + list.slice(0, 30).map(function (w) {
            var vals = PARAMS.filter(function (p) { return w[p.key] !== undefined && w[p.key] !== ''; }).map(function (p) { return p.label + ' ' + esc(w[p.key]); }).join(' / ');
            return '<div class="row"><div style="flex:1;min-width:0"><div class="ttl" style="font-size:12px">' + esc(fmtDate(w.measuredAt)) + '</div><div class="meta">' + (vals || 'データなし') + (w.note ? '<br>' + esc(w.note) : '') + '</div></div></div>';
          }).join('')) : '<div class="muted">まだ測定記録がありません。</div>')) + '</div>';
      var add = document.getElementById('wq-add'); if (add) add.addEventListener('click', function () { wqForm(t); });
      bindWqGraph(list, t);
    } else if (tab === 'orgs' || tab === 'plants') {
      var arr = tab === 'orgs' ? dd.orgs : dd.plants;
      var label = tab === 'orgs' ? '生体' : '水草';
      body.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>' + label + '</b><button class="btn" style="padding:7px 12px;font-size:12px" id="ll-add">＋ 追加</button></div>' +
        (arr === null ? '<div style="display:flex;justify-content:center;padding:10px"><div class="spin"></div></div>' :
          (arr.length ? arr.map(function (o, i) {
            return '<div class="row">' +
              '<div style="flex:1;min-width:0;cursor:' + (tab === 'orgs' ? 'pointer' : 'default') + '"' + (tab === 'orgs' ? ' data-grow="' + i + '"' : '') + '><div class="ttl" style="font-size:13px">' + esc(o.name || '') + (tab === 'orgs' && o.count ? ' ×' + esc(o.count) : '') + '</div>' +
              '<div class="meta">' + esc(o.scientific || '') + (tab === 'plants' && o.placement ? ' ・ ' + esc(o.placement) : '') + (tab === 'orgs' ? ' ・ 成長記録 ›' : '') + '</div></div>' + statusPill(o.status) +
              '<button class="btn sec" style="padding:5px 9px;font-size:11px;margin-left:6px" data-del="' + i + '">削除</button></div>';
          }).join('') : '<div class="muted">登録されていません。</div>')) + '</div>';
      var la = document.getElementById('ll-add'); if (la) la.addEventListener('click', function () { tab === 'orgs' ? organismForm(t) : plantForm(t); });
      [].forEach.call(body.querySelectorAll('[data-grow]'), function (b) { b.addEventListener('click', function () { growthView(arr[Number(b.getAttribute('data-grow'))]); }); });
      [].forEach.call(body.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', function () {
          var o = arr[Number(b.getAttribute('data-del'))];
          if (!confirm('「' + (o.name || '') + '」を削除しますか？')) return;
          api(tab === 'orgs' ? 'deleteOrganism' : 'deletePlant', { id: o.id }).then(function () { toast('削除しました'); loadDetail(t.id); }).catch(function (e) { toast(e.message, 'err'); });
        });
      });
    } else if (tab === 'equip') {
      var eq = dd.equip;
      body.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>設備</b><button class="btn" style="padding:7px 12px;font-size:12px" id="eq-add">＋ 追加</button></div>' +
        (eq === null ? '<div style="display:flex;justify-content:center;padding:10px"><div class="spin"></div></div>' :
          (eq.length ? eq.map(function (e) {
            return '<div class="row"><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(e.name || '') + '</div><div class="meta">' + esc(e.category || '') + (e.brand ? ' ・ ' + esc(e.brand) : '') + (e.model ? ' ' + esc(e.model) : '') + '</div></div>' + statusPill(e.status || '正常') + '</div>';
          }).join('') : '<div class="muted">設備が登録されていません。</div>')) + '</div>';
      var ea = document.getElementById('eq-add'); if (ea) ea.addEventListener('click', function () { equipForm(t); });
    } else if (tab === 'feeding') {
      var fs = state.feeding[t.id];
      body.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>給餌スケジュール</b><button class="btn" style="padding:7px 12px;font-size:12px" id="fs-add">＋ 追加</button></div>' +
        (fs === undefined ? '<div style="display:flex;justify-content:center;padding:10px"><div class="spin"></div></div>' :
          (fs.length ? fs.map(function (f, i) {
            return '<div style="border-bottom:1px solid var(--border);padding:8px 0"><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(f.foodName || '給餌') + '</div>' +
              '<div class="meta">' + esc(f.amount || '') + (f.intervalDays ? ' ・ ' + esc(f.intervalDays) + '日ごと' : '') + (f.preferredTime ? ' ' + esc(f.preferredTime) : '') + (f.nextFeedAt ? ' ・ 次回 ' + esc(fmtDate(f.nextFeedAt)) : '') + '</div></div>' +
              '<button class="btn" style="padding:6px 10px;font-size:12px" data-feed="' + esc(f.id) + '">給餌</button></div>' +
              '<div style="display:flex;gap:6px;margin-top:6px"><button class="btn sec" style="padding:5px 9px;font-size:11px" data-fedit="' + i + '">編集</button><button class="btn sec" style="padding:5px 9px;font-size:11px" data-fdel="' + esc(f.id) + '">削除</button></div></div>';
          }).join('') : '<div class="muted">給餌スケジュールがありません。</div>')) + '</div>';
      var fa = document.getElementById('fs-add'); if (fa) fa.addEventListener('click', function () { feedingForm(t, null); });
      [].forEach.call(body.querySelectorAll('[data-fedit]'), function (b) { b.addEventListener('click', function () { feedingForm(t, fs[Number(b.getAttribute('data-fedit'))]); }); });
      [].forEach.call(body.querySelectorAll('[data-fdel]'), function (b) {
        b.addEventListener('click', function () {
          if (!confirm('この給餌スケジュールを削除しますか？')) return;
          api('deleteFeedingSchedule', { id: b.getAttribute('data-fdel') }).then(function () { toast('削除しました'); api('getFeedingSchedules', { tankIds: [t.id] }).then(function (m) { state.feeding[t.id] = (m && m[t.id]) || []; paintDetailBody(); }).catch(function () {}); }).catch(function (e) { toast(e.message, 'err'); });
        });
      });
      [].forEach.call(body.querySelectorAll('[data-feed]'), function (b) {
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = '...';
          write('recordFeeding', { id: b.getAttribute('data-feed') }).then(function (res) {
            if (res && res.queued) { b.textContent = '保存✓'; toast('オフライン：送信待ちに保存しました'); return; }
            toast('給餌を記録しました');
            api('getFeedingSchedules', { tankIds: [t.id] }).then(function (m) { state.feeding[t.id] = (m && m[t.id]) || []; paintDetailBody(); }).catch(function () { b.disabled = false; b.textContent = '給餌'; });
          }).catch(function (e) { b.disabled = false; b.textContent = '給餌'; toast(e.message, 'err'); });
        });
      });
    } else if (tab === 'records') {
      var rs = dd.records;
      body.innerHTML = '<div class="card"><b>記録</b>' +
        (rs === null ? '<div style="display:flex;justify-content:center;padding:10px"><div class="spin"></div></div>' :
          (rs.length ? rs.slice(0, 50).map(function (r) {
            return '<div class="row"><div style="font-size:18px">' + esc(r.icon || '📝') + '</div><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(r.type || '') + '</div>' + (r.note ? '<div class="meta">' + esc(r.note) + '</div>' : '') + '</div><div class="meta" style="margin-right:6px">' + esc(fmtDate(r.createdAt)) + '</div><button class="btn sec" style="padding:5px 9px;font-size:11px" data-rdel="' + esc(r.id) + '">削除</button></div>';
          }).join('') : '<div class="muted">記録がありません。</div>')) + '</div>';
      [].forEach.call(body.querySelectorAll('[data-rdel]'), function (b) {
        b.addEventListener('click', function () {
          if (!confirm('この記録を削除しますか？')) return;
          api('deleteRecord', { id: b.getAttribute('data-rdel') }).then(function () { toast('削除しました'); api('getRecords', { tankId: t.id }).then(function (d) { state.dd.records = d || []; paintDetailBody(); }).catch(function () {}); }).catch(function (e) { toast(e.message, 'err'); });
        });
      });
    }
  }
  function feedingForm(t, f) {
    var edit = !!f; f = f || {};
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>' + (edit ? '給餌スケジュールを編集' : '給餌スケジュールを追加') + '</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('fe-food', '餌の名前 *', f.foodName) +
      inputRow('fe-amount', '量', f.amount || '少量') +
      inputRow('fe-interval', '何日ごと', f.intervalDays || 1, 'number') +
      inputRow('fe-times', '1日の回数', f.timesPerDay || 1, 'number') +
      inputRow('fe-time', '時刻', f.preferredTime || '09:00', 'time') +
      textareaRow('fe-note', 'メモ', f.note) +
      '<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="fe-cal"' + (f.calendarEnabled ? ' checked' : '') + '> Googleカレンダーにも登録する</label>' +
      '<button class="btn full" id="fe-save">' + (edit ? '保存する' : '追加する') + '</button>');
    document.getElementById('fe-save').addEventListener('click', function () {
      var food = val('fe-food'); if (!food) { toast('餌の名前を入力してください', 'err'); return; }
      var p = { tankId: t.id, foodName: food, amount: val('fe-amount') || '少量', intervalDays: val('fe-interval') || 1, timesPerDay: val('fe-times') || 1, preferredTime: val('fe-time') || '09:00', note: val('fe-note'), calendarEnabled: document.getElementById('fe-cal').checked };
      if (edit) p.id = f.id;
      this.disabled = true; this.textContent = '保存中...';
      api(edit ? 'updateFeedingSchedule' : 'addFeedingSchedule', p).then(function (res) {
        closeModal(); toast(edit ? '保存しました' : '追加しました');
        if (res && res.calendarWarning) toast(res.calendarWarning, 'err');
        api('getFeedingSchedules', { tankIds: [t.id] }).then(function (m) { state.feeding[t.id] = (m && m[t.id]) || []; paintDetailBody(); }).catch(function () {});
      }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('fe-save'); if (b) { b.disabled = false; b.textContent = edit ? '保存する' : '追加する'; } });
    });
  }
  function wqForm(t) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>水質を記録</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr;gap:8px">' +
      PARAMS.map(function (p) {
        return '<div><label class="muted" style="font-size:12px">' + p.label + (p.unit ? '(' + p.unit + ')' : '') + '</label>' +
          '<input id="wq-' + p.key + '" type="number" step="any" inputmode="decimal" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)"></div>';
      }).join('') + '</div>' +
      '<label class="muted" style="font-size:12px;display:block;margin-top:10px">メモ</label>' +
      '<input id="wq-note" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' +
      '<button class="btn full" style="margin-top:14px" id="wq-save">記録する</button>');
    document.getElementById('wq-save').addEventListener('click', function () {
      var payload = { tankId: t.id }; var any = false;
      PARAMS.forEach(function (p) { var v = (document.getElementById('wq-' + p.key).value || '').trim(); if (v !== '') { payload[p.key] = v; any = true; } });
      var note = (document.getElementById('wq-note').value || '').trim(); if (note) payload.note = note;
      if (!any && !note) { toast('1つ以上入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '記録中...';
      write('addWaterQuality', payload).then(function (res) {
        if (res && res.queued) { closeModal(); toast('オフライン：送信待ちに保存しました'); return; }
        closeModal(); toast('水質を記録しました');
        // 水槽の最新値/ステータスを反映
        if (res && state.selTank) { PARAMS.forEach(function (p) { if (payload[p.key] !== undefined) state.selTank[p.key] = payload[p.key]; }); if (res.status) state.selTank.status = res.status; }
        api('getWaterQuality', { tankId: t.id }).then(function (d) { state.dd.wq = d || []; viewTankDetail(); }).catch(function () { viewTankDetail(); });
        api('getTanks').then(function (tk) { state.tanks = tk || []; lsSet('tanks', state.tanks); }).catch(function () {});
      }).catch(function (e) { toast(e.message, 'err'); var btn = document.getElementById('wq-save'); if (btn) { btn.disabled = false; btn.textContent = '記録する'; } });
    });
  }

  function selectRow(id, label, opts, cur) {
    return '<div style="margin-bottom:8px"><label class="muted" style="font-size:12px">' + esc(label) + '</label><select id="' + id + '" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' + opts.map(function (o) { return '<option' + (cur === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select></div>';
  }
  function wqGraph(list, t) {
    var withData = PARAMS.filter(function (p) { return list.some(function (w) { return w[p.key] !== undefined && w[p.key] !== ''; }); });
    if (!withData.length) return '';
    var key = (state.wqKey && withData.some(function (p) { return p.key === state.wqKey; })) ? state.wqKey : withData[0].key;
    var pts = list.filter(function (w) { return w[key] !== undefined && w[key] !== ''; })
      .map(function (w) { return { t: new Date(w.measuredAt).getTime(), v: Number(w[key]) }; })
      .filter(function (x) { return !isNaN(x.v) && !isNaN(x.t); }).sort(function (a, b) { return a.t - b.t; });
    var chips = '<div style="display:flex;gap:6px;overflow:auto;margin-bottom:6px">' + withData.map(function (p) { return '<button class="btn sec" style="padding:5px 10px;font-size:11px;white-space:nowrap' + (p.key === key ? ';background:var(--accent);color:#00151d' : '') + '" data-wqk="' + p.key + '">' + p.label + '</button>'; }).join('') + '</div>';
    if (pts.length < 2) return chips + '<div class="muted" style="font-size:12px;margin-bottom:8px">グラフには2回以上の測定が必要です</div>';
    var W = 320, H = 120, pad = 10;
    var vs = pts.map(function (x) { return x.v; });
    var mn = Math.min.apply(null, vs), mx = Math.max.apply(null, vs); if (mn === mx) { mn -= 1; mx += 1; }
    var r = targetRange(t, key);
    var X = function (i) { return pad + (W - 2 * pad) * i / (pts.length - 1); };
    var Y = function (v) { return pad + (H - 2 * pad) * (1 - (v - mn) / (mx - mn)); };
    var poly = pts.map(function (p, i) { return X(i) + ',' + Y(p.v); }).join(' ');
    var band = (r[0] < mx && r[1] > mn) ? '<rect x="' + pad + '" y="' + Y(Math.min(mx, r[1])) + '" width="' + (W - 2 * pad) + '" height="' + Math.max(0, Y(Math.max(mn, r[0])) - Y(Math.min(mx, r[1]))) + '" fill="rgba(58,210,159,.12)"/>' : '';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:120px;background:var(--card2);border:1px solid var(--border);border-radius:10px;margin-bottom:8px">' + band +
      '<polyline points="' + poly + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
      pts.map(function (p, i) { return '<circle cx="' + X(i) + '" cy="' + Y(p.v) + '" r="2.5" fill="var(--accent)"/>'; }).join('') +
      '<text x="' + pad + '" y="11" fill="var(--sub)" font-size="9">' + mx + '</text><text x="' + pad + '" y="' + (H - 3) + '" fill="var(--sub)" font-size="9">' + mn + '</text></svg>';
    return chips + svg;
  }
  function bindWqGraph() {
    var body = document.getElementById('det-body'); if (!body) return;
    [].forEach.call(body.querySelectorAll('[data-wqk]'), function (b) { b.addEventListener('click', function () { state.wqKey = b.getAttribute('data-wqk'); paintDetailBody(); }); });
  }
  function organismForm(t) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>生体を追加</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('og-name', '名前 *', '') + inputRow('og-sci', '学名', '') + inputRow('og-count', '匹数', '1', 'number') +
      selectRow('og-cat', 'カテゴリー', ['魚類', 'エビ・貝', '貝', 'その他'], '魚類') +
      selectRow('og-status', '状態', ['良好', '注意', '治療中', '死亡', '不明'], '良好') +
      textareaRow('og-note', 'メモ', '') + '<button class="btn full" id="og-save">追加する</button>');
    document.getElementById('og-save').addEventListener('click', function () {
      var name = val('og-name'); if (!name) { toast('名前を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '追加中...';
      api('addOrganism', { tankId: t.id, name: name, scientific: val('og-sci'), count: val('og-count') || 1, category: val('og-cat'), status: val('og-status'), note: val('og-note') })
        .then(function () { closeModal(); toast('追加しました'); loadDetail(t.id); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('og-save'); if (b) { b.disabled = false; b.textContent = '追加する'; } });
    });
  }
  function plantForm(t) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>水草を追加</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('pl-name', '名前 *', '') + inputRow('pl-sci', '学名', '') +
      selectRow('pl-place', '配置', ['前景', '中景', '後景', '活着', '浮草'], '前景') +
      selectRow('pl-status', '状態', ['良好', '注意', '不調'], '良好') +
      textareaRow('pl-note', 'メモ', '') + '<button class="btn full" id="pl-save">追加する</button>');
    document.getElementById('pl-save').addEventListener('click', function () {
      var name = val('pl-name'); if (!name) { toast('名前を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '追加中...';
      api('addPlant', { tankId: t.id, name: name, scientific: val('pl-sci'), placement: val('pl-place'), status: val('pl-status'), note: val('pl-note') })
        .then(function () { closeModal(); toast('追加しました'); loadDetail(t.id); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('pl-save'); if (b) { b.disabled = false; b.textContent = '追加する'; } });
    });
  }
  function equipForm(t) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>設備を追加</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('eq-name', '設備名 *', '') +
      selectRow('eq-cat', 'カテゴリー', ['フィルター', 'ヒーター', '照明', 'CO2', 'クーラー', 'その他'], 'フィルター') +
      inputRow('eq-brand', 'メーカー', '') + inputRow('eq-model', '型番', '') +
      selectRow('eq-status', '状態', ['正常', '注意', '故障'], '正常') +
      textareaRow('eq-note', 'メモ', '') + '<button class="btn full" id="eq-save">追加する</button>');
    document.getElementById('eq-save').addEventListener('click', function () {
      var name = val('eq-name'); if (!name) { toast('設備名を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '追加中...';
      api('addEquipment', { tankId: t.id, name: name, category: val('eq-cat'), brand: val('eq-brand'), model: val('eq-model'), status: val('eq-status'), note: val('eq-note') })
        .then(function () { closeModal(); toast('追加しました'); loadDetail(t.id); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('eq-save'); if (b) { b.disabled = false; b.textContent = '追加する'; } });
    });
  }
  function growthView(o) {
    if (!o) return;
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>' + esc(o.name || '生体') + ' の成長記録</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      '<button class="btn full" id="gl-add" style="margin-bottom:10px">＋ 記録を追加</button><div id="gl-list">' + detLoading() + '</div>');
    document.getElementById('gl-add').addEventListener('click', function () { growthForm(o); });
    function load() {
      api('getGrowthLogs', { organismId: o.id }).then(function (list) {
        var el = document.getElementById('gl-list'); if (!el) return;
        el.innerHTML = (list && list.length) ? list.map(function (g) {
          return '<div style="border-bottom:1px solid var(--border);padding:8px 0">' + (g.photoUrl ? '<img src="' + esc(imgUrl(g.photoUrl)) + '" style="width:100%;border-radius:8px;margin-bottom:6px;background:#0A2D3F">' : '') +
            '<div style="font-size:13px">' + (g.lengthCm ? '<b>' + esc(g.lengthCm) + 'cm</b> ・ ' : '') + esc(g.note || '') + '</div><div class="muted" style="font-size:11px;margin-top:2px">' + esc(fmtDate(g.createdAt)) + '</div></div>';
        }).join('') : '<div class="muted" style="text-align:center;padding:12px">まだ記録はありません</div>';
      }).catch(function (e) { var el = document.getElementById('gl-list'); if (el) el.innerHTML = '<div class="muted">' + esc(e.message) + '</div>'; });
    }
    growthView._reload = load; load();
  }
  function growthForm(o) {
    var photo = null;
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>成長記録を追加</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('gf-len', '体長(cm)', '', 'number') + textareaRow('gf-note', 'メモ', '') +
      '<button class="btn sec full" id="gf-photo" style="margin-bottom:10px">📷 写真を選択（任意）</button><div id="gf-prev"></div>' +
      '<button class="btn full" id="gf-save">記録する</button>');
    document.getElementById('gf-photo').addEventListener('click', function () { pickImage().then(function (img) { photo = img; var pv = document.getElementById('gf-prev'); if (pv) pv.innerHTML = img ? '<div class="muted" style="margin-bottom:10px">✓ 写真を選択しました</div>' : ''; }); });
    document.getElementById('gf-save').addEventListener('click', function () {
      var note = val('gf-note'), len = val('gf-len');
      if (!note && !len && !photo) { toast('写真・体長・メモのいずれかを入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '記録中...';
      var payload = { organismId: o.id, note: note, lengthCm: len };
      if (photo) { payload.base64 = photo.base64; payload.mimeType = photo.mimeType; payload.fileName = photo.fileName; }
      api('addGrowthLog', payload).then(function () { toast('記録しました'); growthView(o); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('gf-save'); if (b) { b.disabled = false; b.textContent = '記録する'; } });
    });
  }

  // ---------- 水槽設定の編集 ----------
  var VIS_KEYS = [['type', 'タイプ'], ['volume', '水量'], ['setupDate', '設置日'], ['status', '状態'], ['temp', '水温'], ['ph', 'pH'], ['gh', 'GH'], ['kh', 'KH'], ['no2', 'NO₂'], ['no3', 'NO₃'], ['tds', 'TDS'], ['co2', 'CO₂'], ['nextChange', '次回換水'], ['filterDays', 'フィルター稼働'], ['lightHours', '照明時間']];
  function parseVis(v) { try { var a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function tankSettingsForm(t) {
    var vis = parseVis(t.publicDataVisibility);
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>水槽の設定</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('ts-name', '水槽名 *', t.name) +
      selectRow('ts-type', 'タイプ', ['ネイチャー', 'シンプル', 'ビオトープ', '海水', 'その他'], t.type || 'ネイチャー') +
      inputRow('ts-volume', '水量(L)', t.volume) + inputRow('ts-setup', '設置日', t.setupDate, 'date') +
      inputRow('ts-light', '照明時間', t.lightHours) + inputRow('ts-wci', '換水間隔(日)', t.waterChangeIntervalDays, 'number') +
      textareaRow('ts-note', 'メモ', t.note) +
      '<div style="border-top:1px solid var(--border);margin:12px 0;padding-top:10px"><label style="display:flex;align-items:center;gap:8px;font-weight:700"><input type="checkbox" id="ts-public"' + (isPublicTank(t) ? ' checked' : '') + '> この水槽を公開する</label>' +
      '<div class="muted" style="font-size:11px;margin:6px 0">公開する項目を選択：</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + VIS_KEYS.map(function (k) { return '<label class="btn sec" style="padding:5px 9px;font-size:11px;cursor:pointer"><input type="checkbox" class="ts-vis" value="' + k[0] + '"' + (vis.indexOf(k[0]) >= 0 ? ' checked' : '') + ' style="margin-right:4px">' + esc(k[1]) + '</label>'; }).join('') + '</div></div>' +
      '<details style="margin-bottom:10px"><summary class="muted" style="font-size:13px;cursor:pointer">水質の基準値（任意）</summary><div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
      PARAMS.map(function (p) { return inputRow('ts-' + p.key + '-min', p.label + ' 最小', t['target' + capKey(p.key) + 'Min'], 'number') + inputRow('ts-' + p.key + '-max', p.label + ' 最大', t['target' + capKey(p.key) + 'Max'], 'number'); }).join('') +
      '</div></details>' +
      '<button class="btn full" id="ts-save">保存する</button>' +
      '<button class="btn sec full" id="ts-del" style="margin-top:8px;color:var(--red)">この水槽を削除</button>');
    document.getElementById('ts-save').addEventListener('click', function () {
      var name = val('ts-name'); if (!name) { toast('水槽名を入力してください', 'err'); return; }
      var pub = document.getElementById('ts-public').checked;
      if (pub && !isPublicTank(t) && !confirm('公開前に、水槽名・メモ・写真に個人情報が含まれていないか確認してください。公開しますか？')) return;
      var p = { id: t.id, name: name, type: val('ts-type'), volume: val('ts-volume'), setupDate: val('ts-setup'), lightHours: val('ts-light'), waterChangeIntervalDays: val('ts-wci'), note: val('ts-note'), isPublic: pub };
      if (pub) { p.publicPreviewConfirmed = true; p.publicDataVisibility = [].map.call(document.querySelectorAll('.ts-vis:checked'), function (c) { return c.value; }); }
      PARAMS.forEach(function (pp) { p['target' + capKey(pp.key) + 'Min'] = val('ts-' + pp.key + '-min'); p['target' + capKey(pp.key) + 'Max'] = val('ts-' + pp.key + '-max'); });
      this.disabled = true; this.textContent = '保存中...';
      api('updateTank', p).then(function () {
        closeModal(); toast('保存しました');
        api('getTanks').then(function (tk) {
          state.tanks = tk || []; lsSet('tanks', state.tanks);
          var nt = state.tanks.filter(function (x) { return x.id === t.id; })[0];
          if (nt) { state.selTank = nt; viewTankDetail(); } else setTab('tanks');
        }).catch(function () { viewTankDetail(); });
      }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('ts-save'); if (b) { b.disabled = false; b.textContent = '保存する'; } });
    });
    document.getElementById('ts-del').addEventListener('click', function () {
      if (!confirm('「' + (t.name || '水槽') + '」を削除しますか？水槽内のデータも削除されます。')) return;
      api('deleteTank', { id: t.id }).then(function () {
        closeModal(); toast('削除しました'); state.selTank = null;
        api('getTanks').then(function (tk) { state.tanks = tk || []; lsSet('tanks', state.tanks); setTab('tanks'); }).catch(function () { setTab('tanks'); });
      }).catch(function (e) { toast(e.message, 'err'); });
    });
  }
  function encPhotoAdd(e) {
    pickImage().then(function (img) {
      if (!img) return;
      toast('写真を追加中...');
      api('updateEncyclopediaPhoto', { encId: e.id, base64: img.base64, mimeType: img.mimeType, fileName: img.fileName }).then(function () {
        toast('写真を追加しました'); reopenEnc(e.id);
      }).catch(function (er) { toast(er.message, 'err'); });
    });
  }
  function encPhotoOp(action, e, index) {
    api(action, { encId: e.id, index: index }).then(function () { toast('更新しました'); reopenEnc(e.id); }).catch(function (er) { toast(er.message, 'err'); });
  }
  function encReorder(e, index, direction) {
    api('reorderEncyclopediaPhoto', { encId: e.id, index: index, direction: direction }).then(function () { reopenEnc(e.id); }).catch(function (er) { toast(er.message, 'err'); });
  }
  function reopenEnc(id) {
    api('getEncyclopedia', encParams()).then(function (d) {
      state.enc = d || []; lsSet('enc', state.enc); paintEncGrid(state.enc);
      var items = Array.isArray(d) ? d : (d && d.items) || [];
      var fresh = items.filter(function (x) { return x.id === id; })[0];
      if (fresh) encDetail(fresh); else closeModal();
    }).catch(function () { closeModal(); });
  }

  // ---------- 用品の管理 ----------
  var FOOD_CATS = ['餌', '掃除用品', '水質用品', '設備用品', '消耗品', 'その他'];
  function foodsView() {
    state.tab = 'foods';
    [].forEach.call(nav.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
    var foods = state.foods || [];
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 2px 10px"><button class="btn sec" style="padding:6px 10px" id="fv-back">←</button><h2 style="margin:0;font-size:20px;flex:1">用品</h2><button class="btn" style="padding:8px 12px;font-size:13px" id="fv-add">＋ 追加</button></div>' +
      (foods.length ? '<div class="card">' + foods.map(function (f, i) {
        return '<div class="row">' + (f.imageUrl ? '<img class="thumb" src="' + esc(imgUrl(f.imageUrl)) + '">' : '<div class="thumb" style="display:grid;place-items:center">🧰</div>') +
          '<div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(f.name || '') + '</div><div class="meta">' + esc(f.category || '') + (f.brand ? ' ・ ' + esc(f.brand) : '') + (f.affiliateLink ? ' ・ <span style="color:#ff9900">PR</span>' : '') + '</div></div>' +
          (f.canEdit ? '<button class="btn sec" style="padding:5px 9px;font-size:11px" data-fe="' + i + '">編集</button>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="card"><div class="muted">用品がまだありません。</div></div>');
    document.getElementById('fv-back').addEventListener('click', function () { setTab('home'); });
    document.getElementById('fv-add').addEventListener('click', function () { foodForm(null); });
    [].forEach.call(app.querySelectorAll('[data-fe]'), function (b) { b.addEventListener('click', function () { foodForm(foods[Number(b.getAttribute('data-fe'))]); }); });
  }
  function foodForm(f) {
    var edit = !!f; f = f || {};
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>' + (edit ? '用品を編集' : '用品を追加') + '</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('fd-name', '用品名 *', f.name) +
      selectRow('fd-cat', 'カテゴリー', FOOD_CATS, f.category || '餌') +
      inputRow('fd-brand', 'メーカー', f.brand) + inputRow('fd-type', 'タイプ', f.type) +
      selectRow('fd-stock', '在庫', ['', 'full', 'half', 'low'], f.stockLevel || '') +
      inputRow('fd-img', '画像URL（任意）', f.imageUrl) +
      ((state.me && state.me.isAdmin) ? (inputRow('fd-amz', 'Amazon商品URL', f.amazonUrl) + inputRow('fd-tag', 'アフィリエイトタグ', f.affiliateTag) + inputRow('fd-rank', '固定表示順（空=なし）', f.recommendRank, 'number') + '<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="fd-hidden"' + (f.hidden ? ' checked' : '') + '> 通常画面に出さない（非表示）</label>') : '') +
      textareaRow('fd-note', 'メモ', f.note) +
      (edit && f.canEdit ? '<button class="btn sec full" id="fd-img-up" style="margin-bottom:8px">📷 画像をアップロード</button>' : '') +
      '<button class="btn full" id="fd-save">' + (edit ? '保存する' : '追加する') + '</button>' +
      (edit && f.canEdit ? '<button class="btn sec full" id="fd-del" style="margin-top:8px;color:var(--red)">削除</button>' : ''));
    var imgup = document.getElementById('fd-img-up');
    if (imgup) imgup.addEventListener('click', function () {
      pickImage().then(function (img) {
        if (!img) return;
        toast('画像をアップロード中...');
        api('updateFoodImage', { foodId: f.id, base64: img.base64, mimeType: img.mimeType, fileName: img.fileName }).then(function () {
          closeModal(); toast('画像を更新しました');
          api('getFoods').then(function (d) { state.foods = d || []; lsSet('foods', state.foods); foodsView(); }).catch(function () {});
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    });
    document.getElementById('fd-save').addEventListener('click', function () {
      var name = val('fd-name'); if (!name) { toast('用品名を入力してください', 'err'); return; }
      var p = { name: name, category: val('fd-cat'), brand: val('fd-brand'), type: val('fd-type'), stockLevel: val('fd-stock'), imageUrl: val('fd-img'), note: val('fd-note') };
      if (edit) p.id = f.id;
      if (state.me && state.me.isAdmin) { p.amazonUrl = val('fd-amz'); p.affiliateTag = val('fd-tag'); p.recommendRank = val('fd-rank'); p.hidden = document.getElementById('fd-hidden').checked; }
      this.disabled = true; this.textContent = '保存中...';
      api(edit ? 'updateFood' : 'addFood', p).then(function () {
        closeModal(); toast(edit ? '保存しました' : '追加しました');
        api('getFoods').then(function (d) { state.foods = d || []; lsSet('foods', state.foods); foodsView(); }).catch(function () { foodsView(); });
      }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('fd-save'); if (b) { b.disabled = false; b.textContent = edit ? '保存する' : '追加する'; } });
    });
    var del = document.getElementById('fd-del');
    if (del) del.addEventListener('click', function () {
      if (!confirm('「' + (f.name || '') + '」を削除しますか？')) return;
      api('deleteFood', { id: f.id }).then(function () { closeModal(); toast('削除しました'); api('getFoods').then(function (d) { state.foods = d || []; lsSet('foods', state.foods); foodsView(); }).catch(function () { foodsView(); }); }).catch(function (e) { toast(e.message, 'err'); });
    });
  }

  // ---------- 管理者メンテナンス ----------
  var ADMIN_TABS = [['dash', 'ダッシュボード'], ['reports', '通報'], ['requests', '要望'], ['users', '制限ユーザー'], ['clicks', 'クリック'], ['settings', '設定']];
  var REPORT_ST = ['未対応', '確認中', '対応済み', '見送り'];
  var REQUEST_ST = ['未対応', '検討中', '対応済み', '見送り'];
  function adminView() {
    state.tab = 'admin'; state.adminTab = state.adminTab || 'dash';
    [].forEach.call(nav.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 2px 8px"><button class="btn sec" style="padding:6px 10px" id="ad-back">←</button><h2 style="margin:0;font-size:20px;flex:1">管理者メンテ</h2></div>' +
      '<div class="card" style="padding:6px"><div style="display:flex;gap:4px;overflow:auto">' +
      ADMIN_TABS.map(function (d) { return '<button class="btn sec" style="font-size:12px;padding:8px 6px;white-space:nowrap' + (state.adminTab === d[0] ? ';background:var(--accent);color:#00151d' : '') + '" data-adt="' + d[0] + '">' + d[1] + '</button>'; }).join('') +
      '</div></div><div id="ad-body">' + detLoading() + '</div>';
    document.getElementById('ad-back').addEventListener('click', function () { setTab('account'); });
    [].forEach.call(app.querySelectorAll('[data-adt]'), function (b) { b.addEventListener('click', function () { state.adminTab = b.getAttribute('data-adt'); adminView(); }); });
    adminLoad();
  }
  function adminBody() { return document.getElementById('ad-body'); }
  function adminLoad() {
    var tab = state.adminTab;
    if (tab === 'dash') api('getAdminDashboardSummary').then(adminDash).catch(adminErr);
    else if (tab === 'reports') api('getEncyclopediaReports').then(adminReports).catch(adminErr);
    else if (tab === 'requests') api('getFeatureRequests').then(adminRequests).catch(adminErr);
    else if (tab === 'users') api('getModerationUsers').then(adminUsers).catch(adminErr);
    else if (tab === 'clicks') api('getAffiliateClickSummary').then(adminClicks).catch(adminErr);
    else if (tab === 'settings') api('getAdminSettings').then(adminSettings).catch(adminErr);
  }
  function adminSettings(d) {
    d = d || {}; var b = adminBody(); if (!b) return;
    b.innerHTML = '<div class="card">' +
      inputRow('as-tag', 'デフォルトAmazonタグ', d.defaultAffiliateTag) +
      inputRow('as-featured', '固定おすすめ用品ID（カンマ区切り）', d.featuredProductIds) +
      textareaRow('as-home', 'ホーム広告メモ', d.homeAdNote) +
      textareaRow('as-detail', '詳細広告メモ', d.detailAdNote) +
      textareaRow('as-ng', 'NGワード（カンマ区切り）', d.ngWords) +
      '<button class="btn full" id="as-save">保存する</button>' +
      '<div class="muted" style="font-size:11px;margin-top:8px">※ Googleログイン設定（クライアントID/シークレット）は安全のため本体アプリの管理画面で変更してください。</div></div>';
    document.getElementById('as-save').addEventListener('click', function () {
      this.disabled = true; this.textContent = '保存中...';
      // googleClientId と未編集項目はそのまま往復させ、設定の消失を防ぐ（secretは触らない）
      api('saveAdminSettings', {
        defaultAffiliateTag: val('as-tag'), featuredProductIds: val('as-featured'),
        homeAdNote: val('as-home'), detailAdNote: val('as-detail'), ngWords: val('as-ng'),
        googleClientId: d.googleClientId || '', clearGoogleClientSecret: false,
      }).then(function () { toast('保存しました'); }).catch(function (e) { toast(e.message, 'err'); }).then(function () { var x = document.getElementById('as-save'); if (x) { x.disabled = false; x.textContent = '保存する'; } });
    });
  }
  function adminErr(e) { var b = adminBody(); if (b) b.innerHTML = '<div class="card"><div class="muted">読み込み失敗：' + esc(e.message) + '</div></div>'; }
  function adminDash(d) {
    d = d || {}; var b = adminBody(); if (!b) return;
    var cards = [['未対応の通報', d.pendingReports], ['未対応の要望', d.pendingRequests], ['通報 合計', d.totalReports]];
    b.innerHTML = '<div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">' +
      cards.map(function (c) { return '<div class="card" style="text-align:center;padding:12px"><div style="font-size:22px;font-weight:800">' + (c[1] == null ? '–' : esc(c[1])) + '</div><div class="muted" style="font-size:11px">' + c[0] + '</div></div>'; }).join('') + '</div>' +
      (Array.isArray(d.checklist) ? '<div class="card"><b>公開前チェック</b>' + d.checklist.map(function (c) { return '<div class="row"><div style="font-size:16px">' + (c.ok ? '✅' : '⚠️') + '</div><div style="flex:1"><div class="ttl" style="font-size:13px">' + esc(c.label) + '</div><div class="meta">' + esc(c.value || '') + '</div></div></div>'; }).join('') + '</div>' : '');
  }
  function adminReports(list) {
    list = list || []; var b = adminBody(); if (!b) return;
    b.innerHTML = list.length ? list.map(function (r, i) {
      return '<div class="card"><div style="font-weight:700;font-size:13px">' + esc(r.entryName || '') + '</div>' +
        '<div class="meta" style="margin:3px 0">通報者: ' + esc(r.reporterName || '') + ' ・ ' + esc(fmtDate(r.createdAt)) + '</div>' +
        '<div style="font-size:13px;white-space:pre-wrap;word-break:break-word;margin-bottom:8px">' + esc(r.reason || '') + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center"><select class="ad-st" data-i="' + i + '" style="flex:1;padding:8px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' + REPORT_ST.map(function (s) { return '<option' + (r.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
        '<button class="btn" style="padding:8px 12px;font-size:12px" data-rep="' + i + '">更新</button></div></div>';
    }).join('') : '<div class="card"><div class="muted">通報はありません。</div></div>';
    [].forEach.call(b.querySelectorAll('[data-rep]'), function (btn) {
      btn.addEventListener('click', function () {
        var i = btn.getAttribute('data-rep'); var sel = b.querySelector('.ad-st[data-i="' + i + '"]');
        btn.disabled = true; btn.textContent = '...';
        api('updateEncyclopediaReport', { id: list[i].id, status: sel.value, adminNote: list[i].adminNote || '' }).then(function () { toast('更新しました'); btn.textContent = '✓'; }).catch(function (e) { btn.disabled = false; btn.textContent = '更新'; toast(e.message, 'err'); });
      });
    });
  }
  function adminRequests(list) {
    list = list || []; var b = adminBody(); if (!b) return;
    b.innerHTML = list.length ? list.map(function (r, i) {
      return '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><div style="font-weight:700;font-size:13px">' + esc(r.title || '(無題)') + '</div><span class="pill">' + esc(r.type || '') + '</span></div>' +
        '<div class="meta" style="margin:3px 0">' + esc(r.requesterName || '') + ' ・ ' + esc(r.priority || '') + ' ・ ' + esc(fmtDate(r.createdAt)) + '</div>' +
        (r.detail ? '<div style="font-size:13px;white-space:pre-wrap;word-break:break-word;margin-bottom:8px">' + esc(r.detail) + '</div>' : '') +
        '<div style="display:flex;gap:8px;align-items:center"><select class="ad-st" data-i="' + i + '" style="flex:1;padding:8px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' + REQUEST_ST.map(function (s) { return '<option' + (r.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
        '<button class="btn" style="padding:8px 12px;font-size:12px" data-req="' + i + '">更新</button></div></div>';
    }).join('') : '<div class="card"><div class="muted">要望はありません。</div></div>';
    [].forEach.call(b.querySelectorAll('[data-req]'), function (btn) {
      btn.addEventListener('click', function () {
        var i = btn.getAttribute('data-req'); var sel = b.querySelector('.ad-st[data-i="' + i + '"]');
        btn.disabled = true; btn.textContent = '...';
        api('updateFeatureRequest', { id: list[i].id, status: sel.value, adminNote: list[i].adminNote || '' }).then(function () { toast('更新しました'); btn.textContent = '✓'; }).catch(function (e) { btn.disabled = false; btn.textContent = '更新'; toast(e.message, 'err'); });
      });
    });
  }
  function adminUsers(list) {
    list = list || []; var b = adminBody(); if (!b) return;
    b.innerHTML = list.length ? '<div class="card">' + list.map(function (u, i) {
      var blocked = u.status === '制限中';
      return '<div class="row"><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(u.displayName || 'ユーザー') + '</div><div class="meta">' + esc(u.status || '通常') + (u.reason ? ' ・ ' + esc(u.reason) : '') + '</div></div>' +
        '<button class="btn ' + (blocked ? 'sec' : '') + '" style="padding:6px 10px;font-size:12px" data-mod="' + i + '">' + (blocked ? '解除' : '制限') + '</button></div>';
    }).join('') + '</div>' : '<div class="card"><div class="muted">制限ユーザーはいません。</div></div>';
    [].forEach.call(b.querySelectorAll('[data-mod]'), function (btn) {
      btn.addEventListener('click', function () {
        var u = list[Number(btn.getAttribute('data-mod'))]; var blocked = u.status === '制限中';
        var reason = blocked ? '' : (prompt('制限理由（任意）') || '');
        if (!blocked && reason === null) return;
        btn.disabled = true;
        api('updateModerationUser', { email: u.email, status: blocked ? '通常' : '制限中', reason: reason }).then(function () { toast('更新しました'); api('getModerationUsers').then(adminUsers).catch(adminErr); }).catch(function (e) { btn.disabled = false; toast(e.message, 'err'); });
      });
    });
  }
  function adminClicks(d) {
    d = d || {}; var b = adminBody(); if (!b) return;
    var cards = [['クリック', d.total], ['表示', d.impressions], ['CTR', (d.ctr != null ? d.ctr + '%' : '–')], ['今日', d.today]];
    b.innerHTML = '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px">' +
      cards.map(function (c) { return '<div class="card" style="text-align:center;padding:10px"><div style="font-size:18px;font-weight:800">' + (c[1] == null ? '–' : esc(c[1])) + '</div><div class="muted" style="font-size:10px">' + c[0] + '</div></div>'; }).join('') + '</div>' +
      (Array.isArray(d.topFoods) && d.topFoods.length ? '<div class="card"><b>クリックの多い用品</b>' + d.topFoods.map(function (f) { return '<div class="row"><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(f.foodName || '') + '</div><div class="meta">' + esc(f.brand || '') + ' ・ CTR ' + (f.ctr != null ? f.ctr + '%' : '–') + '</div></div><div style="font-weight:700">' + esc(f.count || 0) + '</div></div>'; }).join('') + '</div>' : '<div class="card"><div class="muted">クリック記録はありません。</div></div>');
  }

  // ================= 公開水槽 =================
  function viewPublic() {
    if (state.publicTanks) { paintPublic(state.publicTanks); }
    else app.innerHTML = loadingHtml();
    api('getPublicTanks').then(function (d) { state.publicTanks = d || []; lsSet('publicTanks', state.publicTanks); paintPublic(state.publicTanks); }).catch(function (e) {
      if (!state.publicTanks) { var c = lsGet('publicTanks'); if (c) { state.publicTanks = c; paintPublic(c); } else app.innerHTML = offlineBanner() + '<div class="card"><div class="muted">読み込みに失敗しました：' + esc(e.message) + '</div></div>'; }
      else toast(e.message, 'err');
    });
  }
  function paintPublic(list) {
    list = list || [];
    app.innerHTML = offlineBanner() + '<div style="padding:4px 2px 10px"><h2 style="margin:0;font-size:20px">公開水槽</h2></div>' +
      (list.length ? list.map(function (t, i) {
        var items = (t.organisms || []).concat(t.plants || []);
        return '<div class="card" data-pt="' + i + '" style="cursor:pointer"><div style="display:flex;gap:12px;align-items:center">' +
          (t.photoUrl ? '<img class="thumb" style="width:54px;height:54px" src="' + esc(imgUrl(t.photoUrl)) + '">' : '<div class="thumb" style="width:54px;height:54px;display:grid;place-items:center;font-size:22px">🌊</div>') +
          '<div style="flex:1;min-width:0"><div class="ttl">' + esc(t.name || '水槽') + '</div><div class="meta">' + esc(t.ownerName || 'ユーザー') + ' ・ 生体/水草 ' + items.length + '件</div></div><span style="color:var(--dim)">›</span></div></div>';
      }).join('') : '<div class="card"><div class="muted">公開中の水槽はまだありません。</div></div>');
    [].forEach.call(app.querySelectorAll('[data-pt]'), function (c) { c.addEventListener('click', function () { publicTankPosts(list[Number(c.getAttribute('data-pt'))]); }); });
  }
  function isMyTank(id) { return (state.tanks || []).some(function (t) { return t.id === id && isPublicTank(t); }); }
  function publicTankPosts(t) {
    if (!t) return;
    state.pubSel = t;
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;align-items:center;gap:10px;padding:4px 2px 8px"><button class="btn sec" style="padding:6px 10px" id="pp-back">←</button><h2 style="margin:0;font-size:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.name || '水槽') + '</h2></div>' +
      (t.photoUrl ? '<img src="' + esc(imgUrl(t.photoUrl)) + '" style="width:100%;max-height:200px;object-fit:cover;border-radius:14px;background:#0A2D3F">' : '') +
      '<div class="muted" style="margin:8px 2px">' + esc(t.ownerName || 'ユーザー') + 'さんの水槽</div>' +
      (isMyTank(t.id) ? '<button class="btn full" id="pp-compose" style="margin-bottom:10px">＋ 日記を書く</button>' : '') +
      '<div id="pp-posts">' + detLoading() + '</div>';
    document.getElementById('pp-back').addEventListener('click', function () { state.pubSel = null; setTab('public'); });
    var comp = document.getElementById('pp-compose'); if (comp) comp.addEventListener('click', function () { composePost(t); });
    loadPosts(t.id);
  }
  function loadPosts(tankId) {
    api('getTankPosts', { tankId: tankId }).then(function (posts) { paintPosts(posts || []); }).catch(function (e) { var b = document.getElementById('pp-posts'); if (b) b.innerHTML = '<div class="card"><div class="muted">読み込み失敗：' + esc(e.message) + '</div></div>'; });
  }
  function paintPosts(posts) {
    var box = document.getElementById('pp-posts'); if (!box) return;
    if (!posts.length) { box.innerHTML = '<div class="card"><div class="muted">まだ日記はありません。</div></div>'; return; }
    box.innerHTML = posts.map(function (p, i) {
      return '<div class="card"><div style="font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word">' + esc(p.body || '') + '</div>' +
        (p.photoUrl ? '<img src="' + esc(imgUrl(p.photoUrl)) + '" loading="lazy" style="width:100%;border-radius:10px;margin-top:8px;background:#0A2D3F">' : '') +
        '<div style="display:flex;gap:14px;align-items:center;margin-top:10px;color:var(--sub);font-size:13px">' +
        '<button class="btn sec" style="padding:5px 10px;font-size:12px" data-plike="' + i + '">' + (p.likedByMe ? '♥' : '♡') + ' ' + (p.likes || 0) + '</button>' +
        '<button class="btn sec" style="padding:5px 10px;font-size:12px" data-pcom="' + i + '">💬 ' + (p.comments || 0) + '</button>' +
        '<span style="margin-left:auto;color:var(--dim)">' + esc(fmtDate(p.createdAt)) + '</span></div></div>';
    }).join('');
    [].forEach.call(box.querySelectorAll('[data-plike]'), function (b) {
      b.addEventListener('click', function () {
        var p = posts[Number(b.getAttribute('data-plike'))]; b.disabled = true;
        api('likePost', { id: p.id }).then(function (r) {
          p.likedByMe = r && r.likedByMe !== undefined ? r.likedByMe : !p.likedByMe;
          p.likes = r && r.likes !== undefined ? r.likes : (Number(p.likes || 0) + (p.likedByMe ? 1 : -1));
          b.disabled = false; b.innerHTML = (p.likedByMe ? '♥' : '♡') + ' ' + p.likes; b.className = 'btn ' + (p.likedByMe ? '' : 'sec'); b.style.padding = '5px 10px'; b.style.fontSize = '12px';
        }).catch(function (e) { b.disabled = false; toast(e.message, 'err'); });
      });
    });
    [].forEach.call(box.querySelectorAll('[data-pcom]'), function (b) { b.addEventListener('click', function () { postComments(posts[Number(b.getAttribute('data-pcom'))]); }); });
  }
  function postComments(p) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>コメント</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      '<div id="cm-list">' + detLoading() + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><input id="cm-body" placeholder="コメントを書く" maxlength="500" style="flex:1;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)"><button class="btn" id="cm-send">送信</button></div>');
    function load() {
      api('getPostComments', { id: p.id }).then(function (list) {
        var el = document.getElementById('cm-list'); if (!el) return;
        el.innerHTML = (list && list.length) ? list.map(function (c) {
          return '<div style="border-bottom:1px solid var(--border);padding:8px 0"><div style="font-weight:700;font-size:13px">' + esc(c.ownerName || 'ユーザー') + '</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin-top:3px">' + esc(c.body || '') + '</div><div class="muted" style="font-size:11px;margin-top:3px">' + esc(fmtDate(c.createdAt)) + '</div></div>';
        }).join('') : '<div class="muted" style="text-align:center;padding:12px">まだコメントはありません</div>';
      }).catch(function (e) { var el = document.getElementById('cm-list'); if (el) el.innerHTML = '<div class="muted">' + esc(e.message) + '</div>'; });
    }
    load();
    document.getElementById('cm-send').addEventListener('click', function () {
      var body = val('cm-body'); if (!body) { toast('コメントを入力してください', 'err'); return; }
      this.disabled = true;
      api('addPostComment', { id: p.id, body: body }).then(function () { var i = document.getElementById('cm-body'); if (i) i.value = ''; p.comments = Number(p.comments || 0) + 1; load(); var b = document.getElementById('cm-send'); if (b) b.disabled = false; }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('cm-send'); if (b) b.disabled = false; });
    });
  }
  function composePost(t) {
    var photo = null;
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>日記を書く</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      textareaRow('cp-body', '本文', '') +
      '<button class="btn sec full" id="cp-photo" style="margin-bottom:10px">📷 写真を選択（任意）</button><div id="cp-prev"></div>' +
      '<button class="btn full" id="cp-save">投稿する</button>');
    document.getElementById('cp-photo').addEventListener('click', function () {
      pickImage().then(function (img) { photo = img; var pv = document.getElementById('cp-prev'); if (pv) pv.innerHTML = img ? '<div class="muted" style="margin-bottom:10px">✓ 写真を選択しました</div>' : ''; });
    });
    document.getElementById('cp-save').addEventListener('click', function () {
      var body = val('cp-body'); if (!body && !photo) { toast('本文または写真を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '投稿中...';
      var payload = { tankId: t.id, body: body };
      if (photo) { payload.base64 = photo.base64; payload.mimeType = photo.mimeType; payload.fileName = photo.fileName; }
      api('addTankPost', payload).then(function () { closeModal(); toast('日記を投稿しました'); loadPosts(t.id); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('cp-save'); if (b) { b.disabled = false; b.textContent = '投稿する'; } });
    });
  }

  // ================= 図鑑 =================
  var ENC_CATS = ['すべて', '魚類', 'エビ・貝', '水草', 'その他'];
  var ENC_SORTS = ['更新順', '名前順', 'いいね順'];
  function encParams() { return { search: state.encQuery || '', category: state.encCat || 'すべて', sort: state.encSort || '更新順' }; }
  function viewEnc() {
    paintEncShell();
    loadEnc();
  }
  function paintEncShell() {
    app.innerHTML = offlineBanner() +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 2px 8px"><h2 style="margin:0;font-size:20px">図鑑</h2><button class="btn" style="padding:8px 12px;font-size:13px" id="enc-add">＋ 追加</button></div>' +
      '<div class="card" style="padding:10px">' +
      '<div style="display:flex;gap:8px;margin-bottom:8px"><input id="enc-q" value="' + esc(state.encQuery || '') + '" placeholder="名前・学名・分類・分布で検索" style="flex:1;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)"><button class="btn" style="padding:8px 12px;font-size:13px" id="enc-search">検索</button></div>' +
      '<div style="display:flex;gap:6px;overflow:auto;margin-bottom:8px">' + ENC_CATS.map(function (c) { return '<button class="btn sec" style="font-size:12px;padding:6px 10px;white-space:nowrap' + ((state.encCat || 'すべて') === c ? ';background:var(--accent);color:#00151d' : '') + '" data-ecat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
      '<select id="enc-sort" style="width:100%;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' + ENC_SORTS.map(function (s) { return '<option' + ((state.encSort || '更新順') === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
      '</div><div id="enc-grid"></div>';
    document.getElementById('enc-add').addEventListener('click', function () { encForm(null); });
    document.getElementById('enc-search').addEventListener('click', function () { state.encQuery = val('enc-q'); loadEnc(); });
    document.getElementById('enc-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.encQuery = val('enc-q'); loadEnc(); } });
    document.getElementById('enc-sort').addEventListener('change', function () { state.encSort = this.value; loadEnc(); });
    [].forEach.call(app.querySelectorAll('[data-ecat]'), function (b) { b.addEventListener('click', function () { state.encCat = b.getAttribute('data-ecat'); viewEnc(); }); });
  }
  function loadEnc() {
    var grid = document.getElementById('enc-grid'); if (grid) grid.innerHTML = '<div style="display:flex;justify-content:center;padding:20px"><div class="spin"></div></div>';
    api('getEncyclopedia', encParams()).then(function (d) { state.enc = d || []; lsSet('enc', state.enc); paintEncGrid(state.enc); }).catch(function (e) {
      var g = document.getElementById('enc-grid');
      if (state.enc) paintEncGrid(state.enc); else if (g) g.innerHTML = '<div class="card"><div class="muted">読み込み失敗：' + esc(e.message) + '</div></div>';
    });
  }
  function paintEncGrid(list) {
    var items = Array.isArray(list) ? list : (list && list.items) || [];
    var grid = document.getElementById('enc-grid'); if (!grid) return;
    grid.innerHTML = '<div class="muted" style="margin:2px 0 8px">' + items.length + '種</div><div class="grid">' + items.map(function (e, i) {
      var u = e.photoUrl || (e.photoUrls && e.photoUrls[0]) || '';
      return '<div class="enc" data-enc="' + i + '" style="cursor:pointer">' + (u ? '<img src="' + esc(imgUrl(u)) + '" loading="lazy">' : '<div style="aspect-ratio:1/1;display:grid;place-items:center;color:var(--dim)">🐟</div>') +
        '<div class="b"><div class="nm">' + esc(e.name || '') + '</div><div class="sci">' + esc(e.scientific || '') + '</div>' +
        '<div class="muted" style="font-size:11px;margin-top:2px">♥ ' + (e.likes || 0) + '</div></div></div>';
    }).join('') + '</div>';
    [].forEach.call(grid.querySelectorAll('[data-enc]'), function (c) { c.addEventListener('click', function () { encDetail(items[Number(c.getAttribute('data-enc'))]); }); });
  }
  function encDetail(e) {
    if (!e) return;
    var photos = (e.photoUrls && e.photoUrls.length ? e.photoUrls : (e.photoUrl ? [e.photoUrl] : []));
    var rows = [['学名', e.scientific], ['カテゴリー', e.category], ['分類', e.classification], ['分布', e.distribution], ['難易度', e.difficulty ? '★'.repeat(Math.min(5, Number(e.difficulty) || 0)) : ''], ['水温', e.temp || (e.tempMin || e.tempMax ? (e.tempMin || '') + '〜' + (e.tempMax || '') : '')], ['pH', e.ph || (e.phMin || e.phMax ? (e.phMin || '') + '〜' + (e.phMax || '') : '')], ['サイズ', e.size || e.maxLength]];
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b style="font-size:16px">' + esc(e.name || '') + '</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      (photos.length ? '<div style="display:flex;gap:8px;overflow:auto;margin-bottom:10px">' + photos.map(function (u, i) {
        return '<div style="flex-shrink:0;text-align:center"><img src="' + esc(imgUrl(u)) + '" style="height:130px;border-radius:10px;display:block">' +
          '<div style="display:flex;gap:4px;margin-top:4px;justify-content:center">' +
          (i > 0 ? '<button class="btn sec" style="padding:3px 6px;font-size:10px" data-pleft="' + i + '">◀</button>' : '') +
          (i < photos.length - 1 ? '<button class="btn sec" style="padding:3px 6px;font-size:10px" data-pright="' + i + '">▶</button>' : '') +
          (i > 0 ? '<button class="btn sec" style="padding:3px 7px;font-size:10px" data-pmain="' + i + '">メイン</button>' : '<span class="pill" style="font-size:10px">メイン</span>') +
          '<button class="btn sec" style="padding:3px 7px;font-size:10px" data-pdel="' + i + '">削除</button></div></div>';
      }).join('') + '</div>' : '') +
      rows.filter(function (r) { return r[1]; }).map(function (r) { return '<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)"><div class="muted" style="width:74px;flex-shrink:0;font-size:12px">' + r[0] + '</div><div style="flex:1;font-size:13px">' + esc(r[1]) + '</div></div>'; }).join('') +
      (e.care ? '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:3px">飼育方法</div><div style="font-size:13px;line-height:1.7">' + esc(e.care) + '</div></div>' : '') +
      (e.breeding ? '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:3px">繁殖・産卵</div><div style="font-size:13px;line-height:1.7">' + esc(e.breeding) + '</div></div>' : '') +
      (e.desc ? '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:3px">メモ</div><div style="font-size:13px;line-height:1.7">' + esc(e.desc) + '</div></div>' : '') +
      '<div style="display:flex;gap:8px;margin-top:14px">' +
      '<button class="btn ' + (e.likedByMe ? '' : 'sec') + '" style="flex:1" id="enc-like">' + (e.likedByMe ? '♥' : '♡') + ' ' + (e.likes || 0) + '</button>' +
      '<button class="btn sec" id="enc-edit">編集</button>' +
      '<button class="btn sec" id="enc-photo">＋写真</button>' +
      '<button class="btn sec" id="enc-report">通報</button></div>');
    document.getElementById('enc-photo').addEventListener('click', function () { encPhotoAdd(e); });
    [].forEach.call(document.querySelectorAll('[data-pmain]'), function (b) { b.addEventListener('click', function () { encPhotoOp('setEncyclopediaMainPhoto', e, Number(b.getAttribute('data-pmain'))); }); });
    [].forEach.call(document.querySelectorAll('[data-pdel]'), function (b) { b.addEventListener('click', function () { if (!confirm('この写真を削除しますか？')) return; encPhotoOp('deleteEncyclopediaPhoto', e, Number(b.getAttribute('data-pdel'))); }); });
    [].forEach.call(document.querySelectorAll('[data-pleft]'), function (b) { b.addEventListener('click', function () { encReorder(e, Number(b.getAttribute('data-pleft')), -1); }); });
    [].forEach.call(document.querySelectorAll('[data-pright]'), function (b) { b.addEventListener('click', function () { encReorder(e, Number(b.getAttribute('data-pright')), 1); }); });
    document.getElementById('enc-like').addEventListener('click', function () {
      var b = this; b.disabled = true;
      api('likeEncyclopedia', { id: e.id }).then(function (r) {
        e.likedByMe = r && r.likedByMe !== undefined ? r.likedByMe : !e.likedByMe;
        e.likes = r && r.likes !== undefined ? r.likes : (Number(e.likes || 0) + (e.likedByMe ? 1 : -1));
        b.className = 'btn ' + (e.likedByMe ? '' : 'sec'); b.innerHTML = (e.likedByMe ? '♥' : '♡') + ' ' + e.likes; b.disabled = false;
        paintEncGrid(state.enc);
      }).catch(function (er) { b.disabled = false; toast(er.message, 'err'); });
    });
    document.getElementById('enc-edit').addEventListener('click', function () { encForm(e); });
    document.getElementById('enc-report').addEventListener('click', function () { encReport(e); });
  }
  function encReport(e) {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b>図鑑を通報</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      textareaRow('rep-reason', '通報理由', '') +
      '<button class="btn full" id="rep-save">通報する</button>');
    document.getElementById('rep-save').addEventListener('click', function () {
      var reason = val('rep-reason'); if (!reason) { toast('理由を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '送信中...';
      api('reportEncyclopedia', { entryId: e.id, reason: reason }).then(function () { closeModal(); toast('通報を送信しました'); }).catch(function (er) { toast(er.message, 'err'); var b = document.getElementById('rep-save'); if (b) { b.disabled = false; b.textContent = '通報する'; } });
    });
  }
  function encForm(e) {
    var edit = !!e; e = e || {};
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>' + (edit ? '図鑑を編集' : '図鑑を追加') + '</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('ef-name', '名前 *', e.name) + inputRow('ef-sci', '学名', e.scientific) +
      '<div style="margin-bottom:8px"><label class="muted" style="font-size:12px">カテゴリー</label><select id="ef-cat" style="width:100%;margin-top:3px;padding:9px;background:var(--card2);border:1px solid var(--border);border-radius:9px;color:var(--text)">' + ['魚類', 'エビ・貝', '水草', 'その他'].map(function (c) { return '<option' + (e.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></div>' +
      inputRow('ef-diff', '難易度(1-5)', e.difficulty, 'number') + inputRow('ef-dist', '分布', e.distribution) +
      inputRow('ef-temp', '水温', e.temp) + inputRow('ef-ph', 'pH', e.ph) + inputRow('ef-size', 'サイズ', e.size || e.maxLength) +
      textareaRow('ef-care', '飼育方法', e.care) + textareaRow('ef-breeding', '繁殖・産卵', e.breeding) + textareaRow('ef-desc', 'メモ', e.desc) +
      '<button class="btn full" style="margin-top:6px" id="ef-save">' + (edit ? '保存する' : '追加する') + '</button>' +
      (edit ? '<button class="btn sec full" id="ef-del" style="margin-top:8px;color:var(--red)">この図鑑を削除</button>' : ''));
    var efdel = document.getElementById('ef-del');
    if (efdel) efdel.addEventListener('click', function () {
      if (!confirm('「' + (e.name || '') + '」を削除しますか？（登録者または管理者のみ）')) return;
      api('deleteEncyclopedia', { id: e.id }).then(function () { closeModal(); toast('削除しました'); loadEnc(); }).catch(function (er) { toast(er.message, 'err'); });
    });
    document.getElementById('ef-save').addEventListener('click', function () {
      var name = val('ef-name'); if (!name) { toast('名前を入力してください', 'err'); return; }
      var p = { name: name, scientific: val('ef-sci'), category: val('ef-cat'), difficulty: val('ef-diff'), distribution: val('ef-dist'), temp: val('ef-temp'), ph: val('ef-ph'), size: val('ef-size'), care: val('ef-care'), breeding: val('ef-breeding'), desc: val('ef-desc') };
      this.disabled = true; this.textContent = '保存中...';
      var action = edit ? 'updateEncyclopedia' : 'addEncyclopedia';
      if (edit) { p.id = e.id; p.expectedUpdatedAt = e.updatedAt || ''; }
      api(action, p).then(function () { closeModal(); toast(edit ? '保存しました' : '追加しました'); loadEnc(); }).catch(function (er) { toast(er.message, 'err'); var b = document.getElementById('ef-save'); if (b) { b.disabled = false; b.textContent = edit ? '保存する' : '追加する'; } });
    });
  }

  // ================= 通知 =================
  function refreshActivityBadge() {
    api('getMyActivity').then(function (a) {
      state.activity = a || { items: [], seenAt: '' };
      var seen = parseDate(state.activity.seenAt);
      var unread = (state.activity.items || []).filter(function (it) { var d = parseDate(it.createdAt); return d && (!seen || d > seen); }).length;
      var w = document.getElementById('actbadge-wrap');
      if (w) w.innerHTML = '通知' + (unread ? '<span style="background:var(--red);color:#fff;border-radius:999px;font-size:9px;padding:1px 5px;margin-left:3px">' + unread + '</span>' : '');
    }).catch(function () {});
  }
  function viewActivity() {
    if (state.activity) paintActivity(state.activity);
    else app.innerHTML = loadingHtml();
    api('getMyActivity').then(function (a) {
      state.activity = a || { items: [], seenAt: '' }; paintActivity(state.activity);
      api('markActivitySeen').then(function () { var w = document.getElementById('actbadge-wrap'); if (w) w.innerHTML = '通知'; }).catch(function () {});
    }).catch(function (e) { if (!state.activity) app.innerHTML = offlineBanner() + '<div class="card"><div class="muted">読み込みに失敗しました：' + esc(e.message) + '</div></div>'; });
  }
  function paintActivity(a) {
    var items = (a && a.items) || [];
    app.innerHTML = '<div style="padding:4px 2px 10px"><h2 style="margin:0;font-size:20px">通知</h2></div>' +
      (items.length ? '<div class="card">' + items.map(function (it) {
        var icon = it.type === 'like' ? '♥' : '💬';
        var txt = it.type === 'like' ? 'さんがいいねしました' : 'さんがコメントしました';
        return '<div class="row"><div style="font-size:18px">' + icon + '</div><div style="flex:1;min-width:0"><div class="ttl" style="font-size:13px">' + esc(it.userName || 'ユーザー') + txt + '</div><div class="meta">' + esc(it.tankName || '') + (it.body ? '「' + esc(it.body) + '」' : '') + '</div></div><div class="meta">' + esc(fmtDate(it.createdAt)) + '</div></div>';
      }).join('') + '</div>' : '<div class="card"><div class="muted">通知はまだありません。</div></div>');
  }

  // ================= アカウント =================
  function viewAccount() {
    var me = state.me || {};
    app.innerHTML = offlineBanner() + '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0;font-size:18px">アカウント</h2><button class="btn sec" style="padding:6px 10px" id="acc-back">ホームへ</button></div>' +
      '<div class="row">' + (me.avatarUrl ? '<img class="thumb" style="width:48px;height:48px;border-radius:50%" src="' + esc(imgUrl(me.avatarUrl)) + '">' : '<div class="thumb" style="width:48px;height:48px;border-radius:50%;display:grid;place-items:center">🐟</div>') +
      '<div style="flex:1"><div class="ttl">' + esc(me.displayName || 'ユーザー') + '</div><div class="meta">' + esc(me.accountLabel || '') + (me.isAdmin ? ' ・ 管理者' : '') + '</div></div>' +
      '<button class="btn sec" style="padding:6px 10px;font-size:12px" id="acc-profile">編集</button></div></div>' +
      '<button class="btn sec full" id="acc-cal" style="margin-bottom:8px">📅 Googleカレンダー連携' + (me.calendarConnected ? '（連携済み）' : '') + '</button>' +
      '<button class="btn sec full" id="acc-foods" style="margin-bottom:8px">🧰 用品を管理</button>' +
      '<button class="btn sec full" id="acc-feedback" style="margin-bottom:8px">✉️ 問い合わせ・要望を送る</button>' +
      (me.isAdmin ? '<button class="btn sec full" id="acc-admin" style="margin-bottom:8px">🛠 管理者メンテナンス</button>' : '') +
      '<button class="btn sec full" id="signout" style="margin-bottom:16px">ログアウト</button>' +
      '<div class="muted" style="font-size:12px;margin-bottom:6px">データとアカウント</div>' +
      '<button class="btn sec full" id="acc-export" style="margin-bottom:8px">⬇️ 自分のデータをエクスポート</button>' +
      (me.isAdmin ? '' : '<button class="btn sec full" id="acc-delete" style="color:var(--red)">アカウントを削除</button>') +
      '<div class="muted" style="text-align:center;margin-top:18px">Aquary PWA</div>';
    document.getElementById('acc-back').addEventListener('click', function () { setTab('home'); });
    document.getElementById('acc-profile').addEventListener('click', function () { profileForm(); });
    document.getElementById('acc-cal').addEventListener('click', function () { calendarConnect(); });
    document.getElementById('acc-foods').addEventListener('click', function () { foodsView(); });
    document.getElementById('acc-feedback').addEventListener('click', function () { feedbackForm(); });
    var adm = document.getElementById('acc-admin'); if (adm) adm.addEventListener('click', function () { adminView(); });
    document.getElementById('signout').addEventListener('click', function () { signOut(false); });
    document.getElementById('acc-export').addEventListener('click', exportData);
    var del = document.getElementById('acc-delete'); if (del) del.addEventListener('click', deleteAccount);
  }
  function profileForm() {
    var me = state.me || {};
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>プロフィールを編集</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      inputRow('pf-name', 'ニックネーム', me.displayName) +
      '<button class="btn sec full" id="pf-avatar" style="margin-bottom:10px">📷 アイコン画像を変更</button><div id="pf-prev"></div>' +
      '<button class="btn full" id="pf-save">保存する</button>');
    document.getElementById('pf-avatar').addEventListener('click', function () {
      pickImage().then(function (img) {
        if (!img) return;
        toast('アイコンをアップロード中...');
        api('uploadUserAvatar', { base64: img.base64, mimeType: img.mimeType, fileName: img.fileName }).then(function (r) {
          if (state.me && r && r.url) { state.me.avatarUrl = r.url; lsSet('me', state.me); paintWho(); }
          var pv = document.getElementById('pf-prev'); if (pv) pv.innerHTML = '<div class="muted" style="margin-bottom:10px">✓ アイコンを更新しました</div>';
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    });
    document.getElementById('pf-save').addEventListener('click', function () {
      var name = val('pf-name'); if (!name) { toast('ニックネームを入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '保存中...';
      api('updateProfile', { displayName: name }).then(function () {
        if (state.me) { state.me.displayName = name; lsSet('me', state.me); }
        closeModal(); toast('保存しました'); paintWho(); viewAccount();
      }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('pf-save'); if (b) { b.disabled = false; b.textContent = '保存する'; } });
    });
  }
  function exportData() {
    toast('エクスポートを準備中...');
    api('exportMyData').then(function (d) {
      try {
        var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'aquary-export-' + (new Date().toISOString().slice(0, 10)) + '.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        toast('エクスポートしました');
      } catch (e) { toast('ダウンロードに失敗しました', 'err'); }
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function deleteAccount() {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b style="color:var(--red)">アカウントを削除</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      '<div class="muted" style="line-height:1.7;margin-bottom:12px">水槽・記録・画像などあなたのデータが削除されます（投稿は匿名化）。元に戻せません。続けるには <b>DELETE</b> と入力してください。</div>' +
      inputRow('da-confirm', '確認文字', '') +
      '<button class="btn full" id="da-go" style="background:var(--red);color:#fff">削除する</button>');
    document.getElementById('da-go').addEventListener('click', function () {
      if (val('da-confirm') !== 'DELETE') { toast('「DELETE」と入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '削除中...';
      api('deleteMyAccount', { confirmText: 'DELETE' }).then(function () { closeModal(); toast('アカウントを削除しました'); signOut(true); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('da-go'); if (b) { b.disabled = false; b.textContent = '削除する'; } });
    });
  }
  function feedbackForm() {
    modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>問い合わせ・要望</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
      selectRow('fb-type', '種類', ['不具合報告', '改善提案', '機能要望'], '機能要望') +
      inputRow('fb-title', 'タイトル *', '') +
      selectRow('fb-priority', '優先度', ['困っている', 'あると嬉しい', '急ぎ'], 'あると嬉しい') +
      textareaRow('fb-detail', '詳しい内容 *', '') +
      '<button class="btn full" id="fb-save">送信する</button>');
    document.getElementById('fb-save').addEventListener('click', function () {
      var title = val('fb-title'), detail = val('fb-detail');
      if (!title) { toast('タイトルを入力してください', 'err'); return; }
      if (!detail) { toast('詳しい内容を入力してください', 'err'); return; }
      this.disabled = true; this.textContent = '送信中...';
      api('submitFeatureRequest', { type: val('fb-type'), title: title, priority: val('fb-priority'), detail: detail }).then(function () { closeModal(); toast('送信しました。ありがとうございます！'); }).catch(function (e) { toast(e.message, 'err'); var b = document.getElementById('fb-save'); if (b) { b.disabled = false; b.textContent = '送信する'; } });
    });
  }
  function calendarConnect() {
    var connected = state.me && state.me.calendarConnected;
    if (connected) {
      if (!confirm('Googleカレンダー連携を解除しますか？')) return;
      api('disconnectUserCalendar').then(function () {
        toast('連携を解除しました'); if (state.me) state.me.calendarConnected = false; lsSet('me', state.me); viewAccount();
      }).catch(function (e) { toast(e.message, 'err'); });
      return;
    }
    toast('連携URLを準備中...');
    api('startCalendarConnectForApi').then(function (r) {
      var url = r && r.connectUrl;
      if (!url) { toast('連携URLを取得できませんでした', 'err'); return; }
      modal('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>Googleカレンダー連携</b><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()">✕</button></div>' +
        '<div class="muted" style="font-size:13px;line-height:1.7;margin-bottom:12px">下のボタンでGoogleの認証画面を開きます。許可するとカレンダー連携が完了します。認証後はこのアプリに戻り、画面を一度リロードしてください（連携状態が反映されます）。</div>' +
        '<a class="btn full" href="' + esc(url) + '" target="_blank" rel="noopener" id="cal-go" style="text-decoration:none;text-align:center;display:block">Googleで連携する</a>');
      var g = document.getElementById('cal-go'); if (g) g.addEventListener('click', function () { setTimeout(closeModal, 500); });
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ---------- 起動 ----------
  (function () { var s = lsGet('token'); if (s && s.t && s.exp - Date.now() > 30 * 1000) { state.token = s.t; state.exp = s.exp; } })();
  nav.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTab(b.getAttribute('data-tab')); });
  window.addEventListener('online', function () { state.online = true; if (state.token) { flushQueue(); setTab(state.tab); } });
  window.addEventListener('offline', function () { state.online = false; });
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });

  function start() { if (state.token) boot(); else renderLogin(); }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
