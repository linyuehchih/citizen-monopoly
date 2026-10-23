// 選擇統計（遊戲端）：匿名記錄真人玩家的選擇，並取回大家的比例。
// 網址留空（stats-config.js）就完全不運作，不影響遊戲。
//
// 只傳三樣東西：卡片編號、選了哪個選項、一組在這個瀏覽器裡隨機產生的裝置代碼（用來擋重複灌票）。
// 不傳姓名、帳號、手機。
(function(){
  var MIN_SAMPLES = 20;          // 某張卡的紀錄少於這個數字，就不顯示比例
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
    if(!b) return false;
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
    return {pct: Math.round(100 * c[optionIndex] / total), total: total};
  }

  window.CityStats = {
    enabled: enabled, load: load, record: record, share: share, blackout: blackout,
    mode: mode, MIN_SAMPLES: MIN_SAMPLES
  };
})();
