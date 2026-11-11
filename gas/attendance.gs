/**
 * 出勤確認の自動投稿（GAS版・2026-11-11）
 * =====================================================================
 * 毎日20時台に「📢｜メインメンバー業務連絡」の「出勤確認」スレッドへ
 * 明日のオフィス出勤確認を投稿し、回答用のスタンプを6つ付ける。
 *
 * 役割の分け方
 *   ・GAS（ここ）… 時刻を守る係。10分ごとに起動し、20時台に GitHub Actions を呼ぶ。
 *   ・GitHub Actions（ktizon1005-eng/mogurabo-discord の「出勤確認の投稿」）… 送る係。
 *     出勤管理マンのボットで投稿し、スタンプを付ける。スレッドに今日の分があれば何もしない。
 *
 * なぜこう分けたか（2026-11-11）
 *   ・GitHub の定時実行は7時間以上遅れて、11/10 の投稿が抜けた。呼び出しで動かす場合は遅れない。
 *   ・GAS から Discord のボット操作をすると、Discord に弾かれる（403 / code 40333、10回中10回）。
 *   ・ウェブフックではスタンプを付けられない。
 *
 * ■ スクリプト プロパティ
 *     GH_TOKEN … GitHub のトークン（Actions を呼ぶ権限）
 *     GH_REPO  … ktizon1005-eng/mogurabo-discord
 *
 * ■ 動き方
 *   runAttendance() が10分ごとに起動する。
 *   ・20:00〜22:59（日本時間）に、今日まだ呼んでいなければ GitHub Actions を呼ぶ
 *   ・次の起動で、その実行が成功したかを GitHub に聞く。失敗していればもう一度呼ぶ
 *     （送る側が「今日の分があれば何もしない」ので、二重には出ない）
 *   ・23時を過ぎたらその日は呼ばない（期限23:59に間に合わないため）
 *
 * ■ 手で使うもの
 *   checkSetup()   … 設定を確かめる。投稿しない
 *   dispatchDry()  … GitHub Actions を「確認だけ（投稿しない）」で呼ぶ
 *   postNow()      … 時間に関係なく今すぐ呼ぶ（今日の分があれば送る側で何もしない）
 *   removeTrigger()… トリガーを外す（止めたいとき）
 */

var ATT = {
  START_HOUR: 20,
  GIVE_UP_HOUR: 23,
  WORKFLOW: 'attendance.yml',
};

function attProps_() {
  var p = PropertiesService.getScriptProperties();
  var g = function (k) { return (p.getProperty(k) || '').trim(); };
  return { token: g('GH_TOKEN'), repo: g('GH_REPO') || 'ktizon1005-eng/mogurabo-discord', store: p };
}

function jstNow_() {
  var now = new Date();
  return { date: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'), hour: Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H')) };
}

function gh_(method, path, body) {
  var cfg = attProps_();
  var opt = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch('https://api.github.com' + path, opt), code = res.getResponseCode();
  if (code >= 300) throw new Error(method + ' ' + path + ' → ' + code + ' ' + res.getContentText().slice(0, 200));
  return code === 204 ? null : JSON.parse(res.getContentText());
}

/** GitHub Actions を呼ぶ */
function dispatch_(dryRun) {
  var cfg = attProps_();
  gh_('post', '/repos/' + cfg.repo + '/actions/workflows/' + ATT.WORKFLOW + '/dispatches',
    { ref: 'main', inputs: { dry_run: dryRun ? 'true' : 'false' } });
  Logger.log('GitHub Actions を呼んだ（' + (dryRun ? '確認だけ' : '本番') + '）');
}

/** 指定時刻より後に始まった実行のうち、いちばん新しいもの */
function latestRunSince_(isoSince) {
  var cfg = attProps_();
  var runs = gh_('get', '/repos/' + cfg.repo + '/actions/workflows/' + ATT.WORKFLOW + '/runs?event=workflow_dispatch&per_page=5').workflow_runs || [];
  var since = new Date(isoSince).getTime() - 60000;
  var hit = runs.filter(function (r) { return new Date(r.created_at).getTime() >= since; });
  return hit.length ? hit[0] : null;
}

/** トリガーから10分ごとに呼ばれる */
function runAttendance() {
  var t = jstNow_(), cfg = attProps_();
  if (t.hour < ATT.START_HOUR || t.hour >= ATT.GIVE_UP_HOUR) return;
  if (cfg.store.getProperty('DONE_DATE') === t.date) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var sentAt = cfg.store.getProperty('DISPATCHED_AT');
    var sentToday = cfg.store.getProperty('DISPATCHED_DATE') === t.date;
    if (sentToday && sentAt) {
      var run = latestRunSince_(sentAt);
      if (run && run.status === 'completed' && run.conclusion === 'success') {
        cfg.store.setProperty('DONE_DATE', t.date);
        Logger.log('今日の投稿は完了（GitHub の実行 ' + run.id + '）');
        return;
      }
      if (run && run.status !== 'completed') { Logger.log('GitHub の実行がまだ動いている'); return; }
      Logger.log('前の呼び出しが成功していないので、もう一度呼ぶ');
    }
    dispatch_(false);
    cfg.store.setProperties({ DISPATCHED_DATE: t.date, DISPATCHED_AT: new Date().toISOString() });
  } finally {
    lock.releaseLock();
  }
}

function checkSetup() {
  var cfg = attProps_();
  Logger.log((cfg.token ? 'OK ' : 'NG ') + 'GH_TOKEN');
  Logger.log('OK GH_REPO: ' + cfg.repo);
  if (cfg.token) {
    var w = gh_('get', '/repos/' + cfg.repo + '/actions/workflows/' + ATT.WORKFLOW);
    Logger.log('OK 呼び先: 「' + w.name + '」（状態 ' + w.state + '）');
  }
  var n = ScriptApp.getProjectTriggers().filter(function (x) { return x.getHandlerFunction() === 'runAttendance'; }).length;
  Logger.log((n ? 'OK ' : 'まだ ') + 'トリガー ' + n + '本');
  Logger.log('今日: ' + (cfg.store.getProperty('DONE_DATE') === jstNow_().date ? '投稿済み' : 'まだ'));
}

function dispatchDry() { dispatch_(true); }

function postNow() { dispatch_(false); }

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
