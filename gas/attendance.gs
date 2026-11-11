/**
 * 出勤確認の自動投稿（GAS版・2026-11-11）
 * =====================================================================
 * 毎日20時台に「📢｜メインメンバー業務連絡」の「出勤確認」スレッドへ
 * 明日のオフィス出勤確認を投稿し、回答用のスタンプを6つ付ける。
 *
 * もぐメイトの自動配信（jido_haishin.gs）と同じく、GASの時刻トリガーで動かす。
 * Macの電源やスリープとは関係なく動く。
 * ウェブフックではスタンプを付けられないので、投稿は「出勤管理マン」ボットで行う。
 *
 * ---------------------------------------------------------------------
 * ■ 最初にやること（1回だけ）
 *
 *   1. プロジェクトの設定 → スクリプト プロパティ に2件登録する。
 *        DISCORD_BOT_TOKEN … 出勤管理マンのトークン（~/mogurabo-discord-1/.env の DISCORD_TOKEN と同じ）
 *        CHANNEL_ID        … 1529357135698464878 （出勤確認スレッド）
 *      ★トークンはコードに書かない。ここに置く。
 *
 *   2. checkSetup() を実行して、実行ログが全部 OK になることを確かめる。投稿はしない。
 *   3. previewMessage() を実行して、投稿される文面を確かめる。投稿はしない。
 *   4. setupTrigger() を実行してトリガーを張る（10分ごと）。
 *
 * ■ 動き方
 *   runAttendance() が10分ごとに起動する。
 *   ・20:00〜22:59（日本時間）のあいだで、今日の分がまだなら投稿する（ふつうは20:00〜20:10）
 *   ・今日の分があれば何もしない（スレッドの直近の投稿も見るので、Macのボットと二重にならない）
 *   ・23時を過ぎたらその日は送らない（期限23:59に間に合わないため）
 *   ・スレッドが自動で閉じていたら開け直してから投稿する
 *
 * ■ 手で使うもの
 *   checkSetup()      … 設定とボットの権限を確かめる。投稿しない
 *   previewMessage()  … 文面をログに出す。投稿しない
 *   postNow()         … 時間に関係なく今すぐ1回投稿する（今日の分が済んでいても投稿する）
 *   removeTrigger()   … トリガーを外す（止めたいとき）
 */

var ATT = {
  API: 'https://discord.com/api/v10',
  START_HOUR: 20,      // この時刻から投稿する
  GIVE_UP_HOUR: 23,    // この時刻を過ぎたらその日は送らない
  SINCE_HOUR: 19,      // この時刻より後のボットの投稿を「今日の分」とみなす
  MARK: '明日のオフィス出勤確認',
  MENTION: '@everyone',
  REACTIONS: [
    { emoji: '🌅', label: '午前（9:00〜12:00）', group: 'time' },
    { emoji: '☀️', label: '午後（12:00〜18:00）', group: 'time' },
    { emoji: '🌙', label: '夜（18:00〜24:00）', group: 'time' },
    { emoji: '🏠', label: '在宅勤務', group: 'status' },
    { emoji: '🛌', label: 'オフ', group: 'status' },
    { emoji: '❓', label: '未定', group: 'status' },
  ],
};

function buildAttendanceMessage_() {
  var legend = [], prev = null;
  ATT.REACTIONS.forEach(function (r) {
    if (prev !== null && r.group !== prev) legend.push('');
    legend.push(r.emoji + ' ' + r.label);
    prev = r.group;
  });
  return [ATT.MENTION, '**明日のオフィス出勤確認**🐹', '⏰ 本日23:59まで', '※当てはまるもの全てにスタンプしてください！', '']
    .concat(legend).join('\n');
}

function attProps_() {
  var p = PropertiesService.getScriptProperties();
  return { token: (p.getProperty('DISCORD_BOT_TOKEN') || '').trim(), channel: (p.getProperty('CHANNEL_ID') || '').trim(), store: p };
}

function attApi_(method, path, body) {
  var cfg = attProps_();
  for (var attempt = 1; attempt <= 5; attempt++) {
    var opt = {
      method: method,
      headers: { Authorization: 'Bot ' + cfg.token, 'User-Agent': 'DiscordBot (mogulab-attendance, 1.0)' },
      muteHttpExceptions: true,
    };
    if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
    var res = UrlFetchApp.fetch(ATT.API + path, opt);
    var code = res.getResponseCode();
    if (code === 429) {
      var wait = 1;
      try { wait = JSON.parse(res.getContentText()).retry_after || 1; } catch (e) {}
      Utilities.sleep(Math.ceil(wait * 1000) + 200);
      continue;
    }
    if (code >= 500 && attempt < 5) { Utilities.sleep(2000 * attempt); continue; }
    if (code >= 300) throw new Error(method + ' ' + path + ' → ' + code + ' ' + res.getContentText());
    return code === 204 ? null : JSON.parse(res.getContentText());
  }
  throw new Error(method + ' ' + path + ' → 再試行しても失敗');
}

function jstNow_() {
  var now = new Date();
  return {
    date: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'),
    hour: Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H')),
  };
}

/** 今日の SINCE_HOUR 時（日本時間）以降に、ボットが出勤確認を投稿済みか */
function postedToday_(meId) {
  var cfg = attProps_();
  var since = new Date(jstNow_().date + 'T' + ('0' + ATT.SINCE_HOUR).slice(-2) + ':00:00+09:00').getTime();
  var msgs = attApi_('get', '/channels/' + cfg.channel + '/messages?limit=50');
  return msgs.some(function (m) {
    return m.author && m.author.id === meId && String(m.content).indexOf(ATT.MARK) >= 0 && new Date(m.timestamp).getTime() >= since;
  });
}

function postAttendance_() {
  var cfg = attProps_();
  var ch = attApi_('get', '/channels/' + cfg.channel);
  if (ch.thread_metadata && ch.thread_metadata.archived) {
    attApi_('patch', '/channels/' + cfg.channel, { archived: false });
    Logger.log('スレッドが閉じていたので開け直した');
  }
  var msg = attApi_('post', '/channels/' + cfg.channel + '/messages', {
    content: buildAttendanceMessage_(),
    allowed_mentions: { parse: ['everyone', 'roles'] },
  });
  var added = 0;
  ATT.REACTIONS.forEach(function (r) {
    try {
      attApi_('put', '/channels/' + cfg.channel + '/messages/' + msg.id + '/reactions/' + encodeURIComponent(r.emoji) + '/@me');
      added++;
    } catch (e) {
      Logger.log('スタンプ ' + r.emoji + ' を付けられなかった: ' + e.message);
    }
    Utilities.sleep(400);
  });
  cfg.store.setProperty('LAST_POSTED_DATE', jstNow_().date);
  Logger.log('投稿した（message id: ' + msg.id + '）。スタンプ ' + added + '/' + ATT.REACTIONS.length);
}

/** トリガーから10分ごとに呼ばれる */
function runAttendance() {
  var t = jstNow_(), cfg = attProps_();
  if (t.hour < ATT.START_HOUR || t.hour >= ATT.GIVE_UP_HOUR) return;
  if (cfg.store.getProperty('LAST_POSTED_DATE') === t.date) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    if (cfg.store.getProperty('LAST_POSTED_DATE') === t.date) return;
    var me = attApi_('get', '/users/@me');
    if (postedToday_(me.id)) {
      cfg.store.setProperty('LAST_POSTED_DATE', t.date);
      Logger.log('今日の分はスレッドに投稿済み（Macのボットなど）。何もしない');
      return;
    }
    postAttendance_();
  } finally {
    lock.releaseLock();
  }
}

function checkSetup() {
  var cfg = attProps_();
  Logger.log((cfg.token ? 'OK ' : 'NG ') + 'DISCORD_BOT_TOKEN');
  Logger.log((cfg.channel ? 'OK ' : 'NG ') + 'CHANNEL_ID');
  if (!cfg.token || !cfg.channel) return;
  var me = attApi_('get', '/users/@me');
  Logger.log('OK ボット: ' + me.username);
  var ch = attApi_('get', '/channels/' + cfg.channel);
  Logger.log('OK 投稿先: #' + ch.name + (ch.thread_metadata && ch.thread_metadata.archived ? '（閉じている→投稿時に開け直す）' : ''));
  attApi_('get', '/channels/' + cfg.channel + '/messages?limit=1');
  Logger.log('OK 過去の投稿を読める');
  Logger.log('今日の分: ' + (postedToday_(me.id) ? '投稿済み' : 'まだ'));
  var n = ScriptApp.getProjectTriggers().filter(function (x) { return x.getHandlerFunction() === 'runAttendance'; }).length;
  Logger.log((n ? 'OK ' : 'まだ ') + 'トリガー ' + n + '本');
}

function previewMessage() { Logger.log(buildAttendanceMessage_()); }

function postNow() { postAttendance_(); }

function setupTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('runAttendance').timeBased().everyMinutes(10).create();
  Logger.log('トリガーを張った（10分ごと）');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (x) {
    if (x.getHandlerFunction() === 'runAttendance') ScriptApp.deleteTrigger(x);
  });
}
