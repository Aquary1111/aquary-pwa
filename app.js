/* Aquary PWA — フロント本体
 * - Google Identity Services で id_token を取得
 * - GAS doPost API（text/plain・単純リクエスト）へ action+payload を送る
 * - 読み取り結果は localStorage にキャッシュしてオフラインでも表示
 */
(function () {
  'use strict';
  var CFG = window.AQUARY_CONFIG || {};
  var app = document.getElementById('app');
  var nav = document.getElementById('nav');
  var whoEl = document.getElementById('who');

  var state = { token: null, exp: 0, me: null, tab: 'home', online: navigator.onLine };

  // ---------- utils ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem('aq_' + k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('aq_' + k, JSON.stringify(v)); } catch (e) {} }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s); if (isNaN(d.getTime())) return String(s);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  // Drive画像URLを認証不要のCDN形式へ（iframe版 fixDriveImages と同等の簡易版）
  function imgUrl(u) {
    u = String(u || '');
    var m = u.match(/[-\w]{25,}/);
    if (u.indexOf('drive.google.com') >= 0 && m) return 'https://lh3.googleusercontent.com/d/' + m[0];
    return u;
  }

  // ---------- API ----------
  function api(action, payload) {
    if (!CFG.GAS_API_URL || CFG.GAS_API_URL.indexOf('http') !== 0) {
      return Promise.reject(new Error('config.js の GAS_API_URL が未設定です。'));
    }
    if (!state.token) return Promise.reject(new Error('AUTH_REQUIRED'));
    return fetch(CFG.GAS_API_URL, {
      method: 'POST',
      // 単純リクエストにするため text/plain。カスタムヘッダは付けない（プリフライト回避）。
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload || null, idToken: state.token }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res || res.ok !== true) {
        var msg = (res && res.error) || '通信に失敗しました。';
        if (/AUTH_REQUIRED/.test(msg)) { signOut(true); }
        throw new Error(msg);
      }
      return res.data;
    });
  }
  // 読み取り：まずキャッシュを返しつつ裏で更新（stale-while-revalidate）
  function read(action, cacheKey, payload) {
    var cached = lsGet(cacheKey);
    var live = api(action, payload).then(function (d) { lsSet(cacheKey, d); return d; });
    return { cached: cached, live: live };
  }

  // ---------- auth (Google Identity Services) ----------
  function decodeJwtExp(jwt) {
    try {
      var p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number(p.exp || 0) * 1000;
    } catch (e) { return 0; }
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    state.token = resp.credential;
    state.exp = decodeJwtExp(resp.credential);
    lsSet('token', { t: resp.credential, exp: state.exp });
    boot();
  }
  function initGis() {
    if (!window.google || !google.accounts || !google.accounts.id) return false;
    google.accounts.id.initialize({
      client_id: CFG.GOOGLE_CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      use_fedcm_for_prompt: true,
    });
    return true;
  }
  function renderLogin() {
    nav.style.display = 'none';
    whoEl.innerHTML = '';
    app.innerHTML =
      '<div class="center"><div>' +
      '<div style="font-size:54px;margin-bottom:8px">🐟</div>' +
      '<h2 style="margin:0 0 6px">Aquary</h2>' +
      '<div class="muted" style="margin-bottom:20px">水槽・水質・給餌・図鑑をまとめて管理</div>' +
      '<div id="gbtn" style="display:flex;justify-content:center"></div>' +
      (CFG.GOOGLE_CLIENT_ID && CFG.GOOGLE_CLIENT_ID.indexOf('apps.googleusercontent') >= 0 ? '' :
        '<div class="muted" style="margin-top:16px;color:var(--red)">config.js の GOOGLE_CLIENT_ID を設定してください。</div>') +
      '</div></div>';
    var ok = initGis();
    if (ok) {
      google.accounts.id.renderButton(document.getElementById('gbtn'),
        { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ja' });
      google.accounts.id.prompt();
    } else {
      // GISスクリプトの読み込み待ち
      setTimeout(renderLogin, 400);
    }
  }
  function signOut(silent) {
    state.token = null; state.exp = 0;
    try { localStorage.removeItem('aq_token'); } catch (e) {}
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
    if (!silent) toast('ログアウトしました');
    renderLogin();
  }
  function tokenValid() { return state.token && state.exp - Date.now() > 30 * 1000; }

  // ---------- views ----------
  function setTab(tab) {
    state.tab = tab;
    [].forEach.call(nav.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
    if (tab === 'home') viewHome();
    else if (tab === 'enc') viewEnc();
    else viewAccount();
  }
  function offlineBanner() {
    return state.online ? '' : '<div class="offline">📴 オフライン表示中（最後に取得した内容です）</div>';
  }
  function loadingHtml() { return '<div class="center"><div class="spin"></div></div>'; }

  function tankRow(t) {
    return '<div class="row">' +
      (t.photoUrl ? '<img class="thumb" src="' + esc(imgUrl(t.photoUrl)) + '" loading="lazy">' : '<div class="thumb" style="display:grid;place-items:center">🐟</div>') +
      '<div style="min-width:0;flex:1">' +
      '<div class="ttl">' + esc(t.name || '水槽') + '</div>' +
      '<div class="meta">' + esc(t.type || '') + (t.volume ? ' ・ ' + esc(t.volume) + 'L' : '') +
      (t.status ? ' ・ <span class="pill">' + esc(t.status) + '</span>' : '') + '</div>' +
      '</div>' +
      (t.id ? '<button class="btn" style="padding:8px 12px;font-size:12px" data-wc="' + esc(t.id) + '" data-nm="' + esc(t.name || '') + '">換水を記録</button>' : '') +
      '</div>';
  }

  function viewHome() {
    var r = read('getTanks', 'tanks');
    function paint(list, fromCache) {
      list = list || [];
      app.innerHTML = offlineBanner() +
        '<div class="card"><h2>あなたの水槽 ' + (fromCache ? '（保存済み）' : '') + '</h2>' +
        (list.length ? list.map(tankRow).join('') : '<div class="muted">水槽がまだありません。</div>') +
        '</div>';
      bindWaterChange();
    }
    if (r.cached) paint(r.cached, true);
    else app.innerHTML = loadingHtml();
    r.live.then(function (d) { paint(d, false); }).catch(function (e) {
      if (!r.cached) app.innerHTML = offlineBanner() + '<div class="card"><div class="muted">読み込みに失敗しました：' + esc(e.message) + '</div></div>';
      else toast(e.message, 'err');
    });
  }
  function bindWaterChange() {
    [].forEach.call(app.querySelectorAll('[data-wc]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-wc'), nm = btn.getAttribute('data-nm');
        if (!confirm('「' + nm + '」の換水を記録しますか？')) return;
        btn.disabled = true; btn.textContent = '記録中...';
        api('addRecord', { tankId: id, type: '水換え', tankName: nm }).then(function () {
          btn.textContent = '記録しました ✓';
          toast('換水を記録しました');
        }).catch(function (e) { btn.disabled = false; btn.textContent = '換水を記録'; toast(e.message, 'err'); });
      });
    });
  }

  function viewEnc() {
    var r = read('getEncyclopedia', 'enc', {});
    function paint(list, fromCache) {
      // getEncyclopedia の戻りは配列 or {items:[...]} を許容
      var items = Array.isArray(list) ? list : (list && list.items) || [];
      app.innerHTML = offlineBanner() +
        '<div class="card"><h2>みんなの図鑑 ' + (fromCache ? '（保存済み）' : '') + '・' + items.length + '種</h2></div>' +
        '<div class="grid">' + items.slice(0, 60).map(function (e) {
          var u = (e.photoUrl) || (e.photoUrls && e.photoUrls[0]) || '';
          return '<div class="enc">' +
            (u ? '<img src="' + esc(imgUrl(u)) + '" loading="lazy">' : '<div style="aspect-ratio:1/1;display:grid;place-items:center;color:var(--dim)">🐟</div>') +
            '<div class="b"><div class="nm">' + esc(e.name || '') + '</div><div class="sci">' + esc(e.scientific || '') + '</div></div>' +
            '</div>';
        }).join('') + '</div>';
    }
    if (r.cached) paint(r.cached, true);
    else app.innerHTML = loadingHtml();
    r.live.then(function (d) { paint(d, false); }).catch(function (e) {
      if (!r.cached) app.innerHTML = offlineBanner() + '<div class="card"><div class="muted">読み込みに失敗しました：' + esc(e.message) + '</div></div>';
      else toast(e.message, 'err');
    });
  }

  function viewAccount() {
    var me = state.me || {};
    app.innerHTML = offlineBanner() +
      '<div class="card"><h2>アカウント</h2>' +
      '<div class="row"><div style="flex:1"><div class="ttl">' + esc(me.displayName || 'ユーザー') + '</div>' +
      '<div class="meta">' + esc(me.accountLabel || '') + (me.isAdmin ? ' ・ 管理者' : '') + '</div></div></div>' +
      '</div>' +
      '<button class="btn sec full" id="signout">ログアウト</button>' +
      '<div class="muted" style="text-align:center;margin-top:18px">Aquary PWA（試験版）</div>';
    document.getElementById('signout').addEventListener('click', function () { signOut(false); });
  }

  // ---------- boot ----------
  function paintWho() {
    var me = state.me || {};
    whoEl.innerHTML = (me.avatarUrl ? '<img class="av" src="' + esc(imgUrl(me.avatarUrl)) + '">' : '') +
      '<span>' + esc(me.displayName || '') + '</span>';
  }
  function boot() {
    if (!tokenValid()) { renderLogin(); return; }
    nav.style.display = 'flex';
    app.innerHTML = loadingHtml();
    api('getMe').then(function (me) {
      state.me = me; lsSet('me', me); paintWho(); setTab(state.tab || 'home');
    }).catch(function (e) {
      // オフライン等：キャッシュのmeで継続
      var cm = lsGet('me');
      if (cm) { state.me = cm; paintWho(); setTab(state.tab || 'home'); }
      else { app.innerHTML = '<div class="center"><div><div class="muted">' + esc(e.message) + '</div>' +
        '<button class="btn" style="margin-top:14px" onclick="location.reload()">再読み込み</button></div></div>'; }
    });
  }

  // restore token
  (function () {
    var saved = lsGet('token');
    if (saved && saved.t && saved.exp - Date.now() > 30 * 1000) { state.token = saved.t; state.exp = saved.exp; }
  })();

  // nav events
  nav.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    setTab(b.getAttribute('data-tab'));
  });
  window.addEventListener('online', function () { state.online = true; if (state.token) setTab(state.tab); });
  window.addEventListener('offline', function () { state.online = false; });

  // service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // start
  function start() {
    if (state.token) boot();
    else renderLogin();
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
