/**
 * 出勤確認の自動投稿（GAS版・2026-11-11）
 * =====================================================================
 * 毎日20時台に「📢｜メインメンバー業務連絡」の「出勤確認」スレッドへ
 * 明日のオフィス出勤確認を投稿し、回答用のスタンプを6つ付ける。
 *
 * もぐメイトの自動配信（jido_haishin.gs）と同じく、GASの時刻トリガー＋ウェブフックで送る。
 * Macの電源やスリープとは関係なく動く。
 *
 * ・投稿はウェブフックで行う（GASから確実に届く）。
 * ・スタンプはウェブフックでは付けられないので「出勤管理マン」ボットで付ける。
 *   DiscordはGASからのボットの操作をときどき弾く（403 / code 40333）ので、
 *   付けられなかった分は10分後の次の起動でやり直し、6つそろうまで続ける。
 *
 * ---------------------------------------------------------------------
 * ■ スクリプト プロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *     WEBHOOK_URL       … 「📢｜メインメンバー業務連絡」のウェブフックURL（知っている人は誰でも投稿できる鍵）
 *     CHANNEL_ID        … 出勤確認スレッドのID
 *     DISCORD_BOT_TOKEN … 出勤管理マンのトークン（スタンプ用）
 *   ★URLやトークンはコードに書かない。ここに置く。
 *
 * ■ 最初にやること（1回だけ）
 *   1. checkSetup() を実行して、実行ログが OK になることを確かめる。投稿はしない。
 *   2. setupTrigger() を実行してトリガーを張る（10分ごと）。
 *
 * ■ 動き方
 *   runAttendance() が10分ごとに起動する。
 *   ・20:00〜22:59（日本時間）に、今日の分がまだなら投稿する（ふつうは20:00〜20:10）
 *   ・投稿したあとは、23:59までスタンプが6つそろうまで付け直す
 *   ・23時を過ぎたらその日は投稿しない（期限23:59に間に合わないため）
 *   ・スレッドが閉じていても、ウェブフックで送ると自動で開く
 *
 * ■ 手で使うもの
 *   checkSetup()      … 設定を確かめる。投稿しない
 *   previewMessage()  … 文面をログに出す。投稿しない
 *   postNow()         … 時間に関係なく今すぐ1回投稿する（今日の分が済んでいても投稿する）
 *   removeTrigger()   … トリガーを外す（止めたいとき）
 */

var ATT = {
  API: 'https://discord.com/api/v10',
  START_HOUR: 20,      // この時刻から投稿する
  GIVE_UP_HOUR: 23,    // この時刻を過ぎたらその日は投稿しない（スタンプの付け直しは続ける）
  MENTION: '@everyone',
  USERNAME: '出勤管理マン',
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
  var g = function (k) { return (p.getProperty(k) || '').trim(); };
  return { webhook: g('WEBHOOK_URL'), channel: g('CHANNEL_ID'), token: g('DISCORD_BOT_TOKEN'), store: p };
}

function jstNow_() {
  var now = new Date();
  return { date: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'), hour: Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H')) };
}

/** URL へ送る。429 と 5xx は待ってやり直す */
function attFetch_(url, opt) {
  opt.muteHttpExceptions = true;
  for (var attempt = 1; attempt <= 4; attempt++) {
    var res = UrlFetchApp.fetch(url, opt), code = res.getResponseCode();
    if (code === 429) {
      var wait = 1;
      try { wait = JSON.parse(res.getContentText()).retry_after || 1; } catch (e) {}
      Utilities.sleep(Math.ceil(wait * 1000) + 300);
      continue;
    }
    if (code >= 500 && attempt < 4) { Utilities.sleep(2000 * attempt); continue; }
    if (code >= 300) throw new Error(code + ' ' + res.getContentText());
    return code === 204 ? null : JSON.parse(res.getContentText());
  }
  throw new Error('再試行しても失敗');
}

function botApi_(method, path) {
  var cfg = attProps_();
  return attFetch_(ATT.API + path, { method: method, headers: { Authorization: 'Bot ' + cfg.token, 'User-Agent': 'DiscordBot (mogulab-attendance, 1.0)' } });
}

/** ウェブフックで投稿して、メッセージIDを返す */
function postByWebhook_() {
  var cfg = attProps_();
  var url = cfg.webhook + (cfg.webhook.indexOf('?') >= 0 ? '&' : '?') + 'wait=true&thread_id=' + cfg.channel;
  var msg = attFetch_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ content: buildAttendanceMessage_(), username: ATT.USERNAME, allowed_mentions: { parse: ['everyone', 'roles'] } }),
  });
  var t = jstNow_();
  cfg.store.setProperties({ LAST_POSTED_DATE: t.date, LAST_MESSAGE_ID: msg.id, REACTED: '' });
  Logger.log('投稿した（message id: ' + msg.id + '）');
  return msg.id;
}

/** まだ付いていないスタンプを付ける。弾かれたらそこで止めて、次の起動でやり直す */
function addMissingReactions_() {
  var cfg = attProps_();
  var id = cfg.store.getProperty('LAST_MESSAGE_ID');
  if (!id || !cfg.token) return;
  var done = (cfg.store.getProperty('REACTED') || '').split(',').filter(String);
  for (var i = 0; i < ATT.REACTIONS.length; i++) {
    var e = ATT.REACTIONS[i].emoji;
    if (done.indexOf(e) >= 0) continue;
    try {
      botApi_('put', '/channels/' + cfg.channel + '/messages/' + id + '/reactions/' + encodeURIComponent(e) + '/@me');
      done.push(e);
      cfg.store.setProperty('REACTED', done.join(','));
      Utilities.sleep(400);
    } catch (err) {
      Logger.log('スタンプ ' + e + ' は次の起動でやり直す: ' + err.message);
      break;
    }
  }
  Logger.log('スタンプ ' + done.length + '/' + ATT.REACTIONS.length);
}

/** トリガーから10分ごとに呼ばれる */
function runAttendance() {
  var t = jstNow_(), cfg = attProps_();
  if (t.hour < ATT.START_HOUR) return;
  var postedToday = cfg.store.getProperty('LAST_POSTED_DATE') === t.date;
  var reactedAll = (cfg.store.getProperty('REACTED') || '').split(',').filter(String).length >= ATT.REACTIONS.length;
  if (postedToday && reactedAll) return;
  if (!postedToday && t.hour >= ATT.GIVE_UP_HOUR) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    if (cfg.store.getProperty('LAST_POSTED_DATE') !== t.date) postByWebhook_();
    addMissingReactions_();
  } finally {
    lock.releaseLock();
  }
}

function checkSetup() {
  var cfg = attProps_();
  Logger.log((cfg.webhook ? 'OK ' : 'NG ') + 'WEBHOOK_URL');
  Logger.log((cfg.channel ? 'OK ' : 'NG ') + 'CHANNEL_ID');
  Logger.log((cfg.token ? 'OK ' : 'NG ') + 'DISCORD_BOT_TOKEN（スタンプ用）');
  if (cfg.webhook) {
    var w = attFetch_(cfg.webhook, { method: 'get' });
    Logger.log('OK ウェブフック: 「' + w.name + '」（部屋のID ' + w.channel_id + '）');
  }
  try { Logger.log('OK ボット: ' + botApi_('get', '/users/@me').username); }
  catch (e) { Logger.log('注意 ボットが今は弾かれた（スタンプは次の起動でやり直すので問題なし）: ' + e.message); }
  var n = ScriptApp.getProjectTriggers().filter(function (x) { return x.getHandlerFunction() === 'runAttendance'; }).length;
  Logger.log((n ? 'OK ' : 'まだ ') + 'トリガー ' + n + '本');
  Logger.log('今日の投稿: ' + (cfg.store.getProperty('LAST_POSTED_DATE') === jstNow_().date ? '済み' : 'まだ'));
}

function previewMessage() { Logger.log(buildAttendanceMessage_()); }

function postNow() { postByWebhook_(); addMissingReactions_(); }

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
