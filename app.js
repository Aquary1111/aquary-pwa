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
    impressed: {},
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

  // ---------- API ----------
  function api(action, payload) {
    if (!CFG.GAS_API_URL || CFG.GAS_API_URL.indexOf('http') !== 0) return Promise.reject(new Error('config.js の GAS_API_URL が未設定です。'));
    if (!state.token) return Promise.reject(new Error('AUTH_REQUIRED'));
    return fetch(CFG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload || null, idToken: state.token }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res || res.ok !== true) {
        var msg = (res && res.error) || '通信に失敗しました。';
        if (/AUTH_REQUIRED/.test(msg)) signOut(true);
        throw new Error(msg);
      }
      return res.data;
    });
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
      setTab(state.tab || 'home');
      // クイック操作の「前回」表示用に記録を遅延取得
      api('getRecords', {}).then(function (r) { state.records = r || []; if (state.tab === 'home') viewHome(); }).catch(function () {});
      // 通知バッジ
      refreshActivityBadge();
    }).catch(function (e) {
      var cm = lsGet('me');
      if (cm) {
        state.me = cm; state.tanks = lsGet('tanks') || []; state.settings = lsGet('settings') || {}; state.foods = lsGet('foods') || [];
        paintWho(); setTab(state.tab || 'home');
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
    api('addRecord', { tankId: tankId, type: type, tankName: tankName }).then(function () {
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
      api('recordFeeding', { id: x.scheduleId }).then(function () {
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
      '<div class="meta">' + esc(t.type || '') + (t.volume ? ' ・ ' + esc(t.volume) + 'L' : '') + '</div></div>' +
      '<span class="pill" style="color:' + sc + '">' + esc(t.status || '良好') + '</span></div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px">' +
      params.map(function (p) { return '<div style="background:var(--card2);border:1px solid var(--border);border-radius:8px;padding:6px;text-align:center"><div class="muted" style="font-size:10px">' + p[0] + '</div><div style="font-weight:700;font-size:14px">' + (p[1] !== undefined && p[1] !== '' ? esc(p[1]) : '--') + '</div></div>'; }).join('') +
      '</div>' +
      '<div class="meta" style="margin-bottom:8px">次回換水: ' + (t.nextChange ? esc(fmtDate(t.nextChange)) + (d !== null && d <= 0 ? '（期限超過）' : d !== null ? '（あと' + d + '日）' : '') : '未設定') + '</div>' +
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">' +
      [['換水', 'water'], ['給餌', 'feeding'], ['水質', 'wq'], ['掃除', 'maint']].map(function (a) {
        return '<button class="btn sec" style="font-size:11px;padding:8px 4px" data-act="' + a[1] + '" data-tid="' + esc(t.id) + '" data-tn="' + esc(t.name || '') + '">' + esc(a[0]) + '</button>';
      }).join('') +
      '</div></div>';
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
      (list.length ? list.map(function (t) {
        var items = (t.organisms || []).concat(t.plants || []);
        return '<div class="card"><div style="display:flex;gap:12px;align-items:center">' +
          (t.photoUrl ? '<img class="thumb" style="width:54px;height:54px" src="' + esc(imgUrl(t.photoUrl)) + '">' : '<div class="thumb" style="width:54px;height:54px;display:grid;place-items:center;font-size:22px">🌊</div>') +
          '<div style="flex:1;min-width:0"><div class="ttl">' + esc(t.name || '水槽') + '</div><div class="meta">' + esc(t.ownerName || 'ユーザー') + ' ・ 生体/水草 ' + items.length + '件</div></div></div></div>';
      }).join('') : '<div class="card"><div class="muted">公開中の水槽はまだありません。</div></div>');
  }

  // ================= 図鑑 =================
  function viewEnc() {
    if (state.enc) paintEnc(state.enc, true);
    else app.innerHTML = loadingHtml();
    api('getEncyclopedia', {}).then(function (d) { state.enc = d; lsSet('enc', d); paintEnc(d, false); }).catch(function (e) {
      if (!state.enc) { var c = lsGet('enc'); if (c) { state.enc = c; paintEnc(c, true); } else app.innerHTML = offlineBanner() + '<div class="card"><div class="muted">読み込みに失敗しました：' + esc(e.message) + '</div></div>'; }
      else toast(e.message, 'err');
    });
  }
  function paintEnc(list, cached) {
    var items = Array.isArray(list) ? list : (list && list.items) || [];
    app.innerHTML = offlineBanner() + '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:18px">みんなの図鑑</h2><span class="pill">' + items.length + '種' + (cached ? '・保存済み' : '') + '</span></div></div>' +
      '<div class="grid">' + items.slice(0, 80).map(function (e) {
        var u = e.photoUrl || (e.photoUrls && e.photoUrls[0]) || '';
        return '<div class="enc">' + (u ? '<img src="' + esc(imgUrl(u)) + '" loading="lazy">' : '<div style="aspect-ratio:1/1;display:grid;place-items:center;color:var(--dim)">🐟</div>') +
          '<div class="b"><div class="nm">' + esc(e.name || '') + '</div><div class="sci">' + esc(e.scientific || '') + '</div></div></div>';
      }).join('') + '</div>';
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
    app.innerHTML = offlineBanner() + '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0;font-size:18px">アカウント</h2><button class="btn sec" style="padding:6px 10px" onclick="aqCloseModal()" id="acc-back">ホームへ</button></div>' +
      '<div class="row"><div style="flex:1"><div class="ttl">' + esc(me.displayName || 'ユーザー') + '</div><div class="meta">' + esc(me.accountLabel || '') + (me.isAdmin ? ' ・ 管理者' : '') + '</div></div></div></div>' +
      '<button class="btn sec full" id="signout">ログアウト</button>' +
      '<div class="muted" style="text-align:center;margin-top:18px">Aquary PWA</div>';
    document.getElementById('acc-back').addEventListener('click', function () { setTab('home'); });
    document.getElementById('signout').addEventListener('click', function () { signOut(false); });
  }

  // ---------- 起動 ----------
  (function () { var s = lsGet('token'); if (s && s.t && s.exp - Date.now() > 30 * 1000) { state.token = s.t; state.exp = s.exp; } })();
  nav.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTab(b.getAttribute('data-tab')); });
  window.addEventListener('online', function () { state.online = true; if (state.token) setTab(state.tab); });
  window.addEventListener('offline', function () { state.online = false; });
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });

  function start() { if (state.token) boot(); else renderLogin(); }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
