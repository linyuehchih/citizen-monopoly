// 連線層：用 Firebase 即時資料庫讓大家的畫面同步。只在「開房間／加入房間」時才會載入 Firebase，單機玩完全不碰。
//
// 房間資料（rooms/{代碼}）：
//   meta     房主、人數、狀態（lobby 大廳／playing 遊戲中／over 結束）
//   seats    0～3 號座位：host 房主／human 朋友／bot 電腦／open 空位
//   view     房主發布的畫面（core 棋盤與指標、feed 動態紀錄、prompt 目前的彈出視窗）
//   actions  朋友送給房主的操作（擲骰子、選選項、按繼續），房主讀完就刪掉
//   suggest  朋友對選項的「建議」
//   save     房主的存檔（房主重新整理後可以接回來）
// 安全規則在 backend/firebase-rules.json。
(function(){
  var SDK = [
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js'
  ];
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 I、L、O、0、1
  var SESSION_KEY = 'cityNetSession';
  var AWAY_MS = 15000;                                  // 座位超過這麼久沒心跳，算離線

  var S = { ready: null, uid: null, db: null, offset: 0, seats: {}, hb: null, unsub: [] };

  function cfg(){ return window.CITY_FIREBASE || null; }
  function available(){ var c = cfg(); return !!(c && c.apiKey && c.databaseURL); }

  function loadScript(src){
    return new Promise(function(res, rej){
      var s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = function(){ rej(new Error('連線元件載入失敗，請檢查網路後重試')); };
      document.head.appendChild(s);
    });
  }

  // 載入 Firebase、匿名登入（不需要註冊，只是讓系統分得出誰是誰）
  function init(){
    if(S.ready) return S.ready;
    if(!available()) return Promise.reject(new Error('這個版本沒有開放連線功能'));
    S.ready = SDK.reduce(function(p, src){ return p.then(function(){ return loadScript(src); }); }, Promise.resolve())
      .then(function(){
        firebase.initializeApp(cfg());
        // 網址有 &tab= 時用「分頁專屬」身分，方便在同一台電腦開兩個分頁測試
        var P = firebase.auth.Auth.Persistence;
        return firebase.auth().setPersistence(/[?&]tab=/.test(location.search) ? P.SESSION : P.LOCAL);
      })
      .then(function(){ return firebase.auth().signInAnonymously(); })
      .then(function(cred){
        S.uid = cred.user.uid;
        S.db = firebase.database();
        S.db.ref('.info/serverTimeOffset').on('value', function(s){ S.offset = s.val() || 0; });
        return S.uid;
      })
      .catch(function(e){ S.ready = null; throw e; });
    return S.ready;
  }

  function ref(code, path){ return S.db.ref('rooms/' + code + (path ? '/' + path : '')); }
  function stamp(){ return firebase.database.ServerValue.TIMESTAMP; }
  function serverNow(){ return Date.now() + S.offset; }
  function newCode(){
    var s = '';
    for(var i = 0; i < 5; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return s;
  }

  // ---------- 開房間（房主）----------
  // opts: { n, level, mode, hostName, seats:[{type,name}] }；回傳房間代碼
  async function createRoom(opts){
    await init();
    var code = null;
    for(var t = 0; t < 6 && !code; t++){
      var c = newCode();
      var snap = await ref(c, 'meta').once('value');
      if(!snap.exists()) code = c;
    }
    if(!code) throw new Error('開房間失敗，請再試一次');
    // 先寫 meta（之後座位的寫入權限要靠它判斷誰是房主）
    await ref(code, 'meta').set({
      hostUid: S.uid, n: opts.n, status: 'lobby', createdAt: stamp(),
      level: opts.level || 'normal', mode: opts.mode || 'prod'
    });
    var seats = {};
    opts.seats.forEach(function(s, i){
      seats[i] = { type: s.type, name: s.name || '' };
      if(s.type === 'host') seats[i].uid = S.uid;
    });
    await ref(code, 'seats').update(seats);   // 規則是「每個座位」各自授權，所以用 update 逐座位寫入
    return code;
  }

  // ---------- 加入（朋友）----------
  async function peek(code){
    await init();
    var snap = await ref(code, 'meta').once('value');
    if(!snap.exists()) return null;
    var seats = (await ref(code, 'seats').once('value')).val() || {};
    return { meta: snap.val(), seats: seats };
  }

  // 搶一個空位；用 transaction，兩個人同時搶同一個位子時只有一個人會成功
  async function claimSeat(code, name){
    await init();
    var info = await peek(code);
    if(!info) throw new Error('找不到這個房間');
    if(info.meta.status !== 'lobby') throw new Error('這個房間已經開始遊戲了');
    for(var i = 0; i < info.meta.n; i++){
      var seat = info.seats[i];
      if(seat && seat.type === 'open'){
        var res = await ref(code, 'seats/' + i).transaction(function(cur){
          if(cur && cur.type === 'open') return { type: 'human', uid: S.uid, name: name || '', lastSeen: stamp() };
          return;   // 已經被別人搶走，放棄
        });
        if(res.committed) return i;
      }
    }
    throw new Error('房間已經滿了');
  }

  // ---------- 即時監聽 ----------
  function watchRoom(code, cb){
    var meta = null, seats = null;
    function fire(){ if(meta) cb({ meta: meta, seats: seats || {} }); }
    var r1 = ref(code, 'meta'), r2 = ref(code, 'seats');
    r1.on('value', function(s){ meta = s.val(); fire(); });
    r2.on('value', function(s){ seats = s.val() || {}; S.seats = seats; fire(); });
    S.unsub.push(function(){ r1.off(); r2.off(); });
  }
  function watchView(code, cb){
    var r = ref(code, 'view');
    r.on('value', function(s){ cb(s.val() || {}); });
    S.unsub.push(function(){ r.off(); });
  }
  function watchSuggest(code, cb){
    var r = ref(code, 'suggest');
    r.on('value', function(s){ cb(s.val() || {}); });
    S.unsub.push(function(){ r.off(); });
  }
  // 房主：收朋友送來的操作，處理完就刪掉。座位的 uid 對不上的操作直接丟掉
  function watchActions(code, cb){
    var r = ref(code, 'actions');
    r.on('child_added', function(s){
      var a = s.val();
      s.ref.remove();
      var seat = S.seats && S.seats[a && a.seat];
      if(a && seat && seat.uid && seat.uid === a.uid) cb(a);
    });
    S.unsub.push(function(){ r.off(); });
  }

  // ---------- 發布與傳送 ----------
  function publish(code, parts){ return ref(code, 'view').update(parts); }
  function setStatus(code, status){ return ref(code, 'meta/status').set(status); }
  function setSeat(code, i, val){ return ref(code, 'seats/' + i).set(val); }
  function sendAction(code, seat, type, extra){
    var a = { seat: seat, uid: S.uid, type: type, t: stamp() };
    if(extra) for(var k in extra) a[k] = extra[k];
    return ref(code, 'actions').push(a);
  }
  function suggest(code, seat, idx){ return ref(code, 'suggest/' + seat).set(idx); }
  function clearSuggest(code){
    var u = {}; for(var i = 0; i < 4; i++) u[i] = null;
    return ref(code, 'suggest').update(u);
  }
  function saveState(code, str){ return ref(code, 'save').set(str); }
  async function loadState(code){ var s = await ref(code, 'save').once('value'); return s.val(); }

  // ---------- 心跳與離線偵測 ----------
  function startHeartbeat(code, seat){
    stopHeartbeat();
    function beat(){ ref(code, 'seats/' + seat + '/lastSeen').set(stamp()).catch(function(){}); }
    beat();
    S.hb = setInterval(beat, 5000);
  }
  function stopHeartbeat(){ if(S.hb){ clearInterval(S.hb); S.hb = null; } }
  // 這個朋友座位是不是已經離線（太久沒心跳）
  function seatAway(i){
    var s = S.seats && S.seats[i];
    if(!s || s.type !== 'human') return false;
    if(!s.lastSeen) return false;
    return serverNow() - s.lastSeen > AWAY_MS;
  }

  // ---------- 重新整理後接回來 ----------
  function saveSession(o){ try{ localStorage.setItem(SESSION_KEY, JSON.stringify(o)); }catch(e){} }
  function loadSession(){ try{ return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }catch(e){ return null; } }
  function clearSession(){ try{ localStorage.removeItem(SESSION_KEY); }catch(e){} }

  function leave(){
    stopHeartbeat();
    S.unsub.forEach(function(f){ try{ f(); }catch(e){} });
    S.unsub = [];
  }

  window.CityNet = {
    available: available, init: init, uid: function(){ return S.uid; },
    createRoom: createRoom, peek: peek, claimSeat: claimSeat,
    watchRoom: watchRoom, watchView: watchView, watchActions: watchActions, watchSuggest: watchSuggest,
    publish: publish, setStatus: setStatus, setSeat: setSeat, sendAction: sendAction,
    suggest: suggest, clearSuggest: clearSuggest, saveState: saveState, loadState: loadState,
    startHeartbeat: startHeartbeat, stopHeartbeat: stopHeartbeat, seatAway: seatAway, serverNow: serverNow,
    saveSession: saveSession, loadSession: loadSession, clearSession: clearSession, leave: leave
  };
})();
