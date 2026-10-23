// 選擇統計（遊戲端）：匿名記錄真人玩家的選擇，並取回大家的比例。
// 網址留空（stats-config.js）就完全不運作，不影響遊戲。
//
// 只傳三樣東西：卡片編號、選了哪個選項、一組在這個瀏覽器裡隨機產生的裝置代碼（用來擋重複灌票）。
// 不傳姓名、帳號、手機。
(function(){
  var MIN_SAMPLES = 1;           // 某張卡有幾筆紀錄就顯示比例（2026-10-23 決定：不設門檻，有就顯示）
  var SMALL_SAMPLE = 20;         // 少於這個人次，畫面會標示「樣本少，僅供參考」
  var data = null;               // { cards: { G01:[a,b,c], ... } }

  // 算「測試」的情況，不會混進正式統計：
  //   ① 在自己電腦上開（localhost 或直接雙擊檔案）
  //   ② 網址後面加 ?mode=test（給朋友試玩用，公開網址也能標成測試）
  var forceTest = /[?&]mode=test(&|$)/.test(location.search);
  var mode = (forceTest || location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) ? 'test' : 'prod';

  function url(){ return window.CITY_STATS_URL || ''; }
  function enabled(){ return !!url() && !!deviceId(); }

  function deviceId(){
    try{
      var k = 'cityGameDeviceId', v = localStorage.getItem(k);
      if(!v){
        v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'd' + Math.random().toString(16).slice(2) + Date.now().toString(16);
        localStorage.setItem(k, v);
      }
      return v;
    }catch(e){ return null; }     // 瀏覽器不讓存資料時，就不記錄（沒辦法擋重複）
  }

  function record(cardId, optionIndex){
    if(!enabled() || optionIndex < 0 || optionIndex > 2) return;
    try{
      fetch(url(), {
        method: 'POST', mode: 'no-cors', keepalive: true,
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify({cardId: cardId, optionIndex: optionIndex, deviceId: deviceId(), mode: mode})
      }).catch(function(){});
    }catch(e){}
  }

  // 選舉期間暫停顯示統計（設定在 stats-config.js）：這段時間不抓、也不顯示任何百分比
  function blackout(){
    var b = window.CITY_STATS_BLACKOUT;
    if(!b || b.enabled === false) return false;
    var now = Date.now();
    return now >= new Date(b.from).getTime() && now < new Date(b.to).getTime();
  }

  function load(){
    if(!url() || blackout()){ data = null; return Promise.resolve(null); }
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function(){ ctl.abort(); }, 5000) : null;
    return fetch(url() + '?action=stats&mode=' + mode, ctl ? {signal: ctl.signal} : {})
      .then(function(r){ return r.json(); })
      .then(function(j){ if(timer) clearTimeout(timer); if(j && j.ok){ data = j.blackout ? null : j; } return data; })
      .catch(function(){ if(timer) clearTimeout(timer); return data; });
  }

  // 有多少 % 的玩家選了這個選項；紀錄不夠就回 null
  function share(cardId, optionIndex){
    if(blackout() || !data || !data.cards || !data.cards[cardId]) return null;
    var c = data.cards[cardId], total = c[0] + c[1] + c[2];
    if(total < MIN_SAMPLES || !(optionIndex >= 0 && optionIndex <= 2)) return null;
    return {pct: Math.round(100 * c[optionIndex] / total), total: total, small: total < SMALL_SAMPLE};
  }

  /* ---------- 玩家「點子」（文字想法）----------
     過濾規則和後台 Code.gs 的 ideaProblem_ 一樣（改一邊記得改另一邊）；後台才是最後一道關。 */
  var IDEA_MAX = 100;
  var IDEA_BLOCK = ['幹你', '幹妳', '操你', '操妳', '肏', '他媽的', '他媽', '去死', '賤人', '婊子', '白癡', '白痴',
                    '智障', '王八蛋', '畜生', '混蛋', '廢物', '雜種', '死全家', '支那'];
  function ideaClean(s){
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // 回傳 null＝可以送出；否則是要給玩家看的原因
  function ideaProblem(text){
    text = ideaClean(text);
    var len = Array.from(text).length;
    if(len < 1 || len > IDEA_MAX) return '請輸入 1 到 ' + IDEA_MAX + ' 字。';
    var flat = text.replace(/[\s\-－—_.．。,，]/g, '');
    if(/\d{8,}/.test(flat) || /(?:\+?886|0)9\d{8}/.test(flat) || /[A-Za-z][12]\d{8}/.test(flat) ||
       /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) || /(https?:\/\/|www\.)/i.test(text) ||
       /[a-z0-9-]+\.(com|tw|net|org|io|gov|edu|me|cc)\b/i.test(text)){
      return '請不要填寫電話、Email、網址或身分證字號。';
    }
    for(var i = 0; i < IDEA_BLOCK.length; i++){
      if(text.indexOf(IDEA_BLOCK[i]) >= 0) return '請避免辱罵或不當用詞，換個說法試試。';
    }
    if(/(.)\1{7,}/.test(text) || !/[一-鿿A-Za-z]/.test(text)) return '內容看起來是重複的字或符號，請換個寫法。';
    return null;
  }
  // POST 並嘗試讀回結果；瀏覽器不讓讀（跨網域）時，改成「已送出但不確定」，後台會擋重複所以重送也安全
  function postJson(body){
    return fetch(url(), {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(body)})
      .then(function(r){ return r.json(); })
      .catch(function(){
        try{ fetch(url(), {method: 'POST', mode: 'no-cors', keepalive: true, headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(body)}).catch(function(){}); }catch(e){}
        return {ok: true, unknown: true};
      });
  }
  // 送出一則點子；回傳 Promise<{ok, message}>
  function submitIdea(cardId, text){
    text = ideaClean(text);
    var why = ideaProblem(text);
    if(why) return Promise.resolve({ok: false, message: why});
    if(!enabled()) return Promise.resolve({ok: false, message: '目前無法送出，請稍後再試。'});
    return postJson({type: 'idea', cardId: cardId, text: text, deviceId: deviceId(), mode: mode}).then(function(j){
      if(j && j.ok) return {ok: true};
      return {ok: false, message: (j && j.message) || '送出失敗，請稍後再試。'};
    });
  }

  window.CityStats = {
    enabled: enabled, load: load, record: record, share: share, blackout: blackout,
    mode: mode, MIN_SAMPLES: MIN_SAMPLES, SMALL_SAMPLE: SMALL_SAMPLE,
    ideaProblem: ideaProblem, ideaClean: ideaClean, submitIdea: submitIdea, IDEA_MAX: IDEA_MAX
  };
})();
