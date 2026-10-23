// 電腦玩家的選擇邏輯。遊戲畫面（index.html）和模擬程式（tools/sim.js）共用這一份。
//
// 用法：CityBot.choose(opts, st, level) → { index, reason }
//   opts  ：目前這張卡可選的選項（已含「先擱置」的備案）
//   st    ：{ ind:{s,t,e,c}, budget, round, rounds, n（玩家人數）, dec（每回合每項指標下滑多少）,
//            income（每回合稅收）, cfg（game-data 的 config）}
//   level ：'easy' 輕鬆 | 'normal' 普通 | 'random' 純隨機（只給模擬比較用）
(function(root){
  var KEYS = ['s','t','e','c'];
  var NAMES = {s:'🙂市民滿意度', t:'🚗交通順暢', e:'🌿環境整潔', c:'🤝照顧與安全'};

  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

  // 這項指標現在有多急：離「安全線」越遠、越接近 0，權重越大。
  // 安全線會把每回合的下滑算進去：滿意度要留 1 回合緩衝，其他三項要留 2 回合緩衝，
  // 這樣電腦會提早補強，不會等到快崩盤才想到。
  function weight(k, st){
    var v = st.ind[k];
    var dec = st.dec || 0;
    var target = k==='s' ? st.cfg.winSatisfaction : st.cfg.minOtherIndicator + 1;
    var safe = target + dec * (k==='s' ? 1 : 2);
    var w = (k==='s' ? 1.4 : 1.0) + Math.max(0, safe - v) / 10;
    if(v <= 15 + dec) w += 2; else if(v <= 25 + dec) w += 1;
    return w;
  }

  // 預算有多緊：算「剩下的錢（含之後的稅收）平均每次事件能花多少」，越少越要省
  function budgetPressure(st){
    var left = st.rounds - st.round + 1;
    var events = left * st.n * 0.6;
    var available = st.budget + (st.income || 0) * left;
    var perEvent = events > 0 ? available / events : 99;
    return clamp(2.2 / Math.max(perEvent, 0.5), 0.15, 1.6);
  }

  function weakestKey(st){
    var w = KEYS[0];
    KEYS.forEach(function(k){ if(st.ind[k] < st.ind[w]) w = k; });
    return w;
  }

  function choose(opts, st, level){
    var ok = [];
    opts.forEach(function(o,i){ if(o.cost <= st.budget) ok.push(i); });
    if(!ok.length) ok = opts.map(function(_,i){ return i; });

    function randomPick(){ return ok[Math.floor(Math.random()*ok.length)]; }

    if(level === 'random'){
      return { index: randomPick(), reason: '' };
    }

    var easy = level === 'easy';
    // 輕鬆：偶爾失誤，隨手選一個
    if(easy && Math.random() < 0.2){
      return { index: randomPick(), reason: '憑感覺隨手選了一個' };
    }

    var weak = weakestKey(st);
    var lambda = easy ? 0 : budgetPressure(st);   // 輕鬆版不太算預算
    var best = ok[0], bestScore = -1e9, bestGain = {};

    ok.forEach(function(i){
      var o = opts[i], score = 0, gain = {};
      KEYS.forEach(function(k){
        var f = o.fx[k] || 0;
        var w = easy ? (k===weak ? 3 : 1) : weight(k, st);
        gain[k] = w * f;
        score += w * f;
      });
      score -= lambda * o.cost * 2;
      if(!easy) score *= 1 + (Math.random() - 0.5) * 0.2;   // 普通：不會每次都最佳解
      if(score > bestScore){ bestScore = score; best = i; bestGain = gain; }
    });

    // 說明為什麼這樣選：看哪一項指標貢獻最大
    var topKey = KEYS[0];
    KEYS.forEach(function(k){ if(bestGain[k] > bestGain[topKey]) topKey = k; });
    var o = opts[best];
    var reason = '想先補強' + NAMES[topKey];
    if(!easy){
      if(o.cost === 0) reason += '，而且不花錢';
      else if(lambda >= 0.8) reason += '，預算吃緊所以選比較省的';
    }
    return { index: best, reason: reason };
  }

  root.CityBot = { choose: choose };
})(typeof window !== 'undefined' ? window : this);
