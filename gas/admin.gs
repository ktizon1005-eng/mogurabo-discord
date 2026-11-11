/**
 * 管理用の入口（Claude が外から設定・確認するためのもの）。
 * 合言葉（ハッシュだけをここに置く）が合ったときだけ動く。合言葉は Mac の ~/mogurabo-discord-1/.gas_admin_key。
 *   GET  ?key=…&do=check    … checkSetup() の結果を返す（投稿しない）
 *   GET  ?key=…&do=dry      … GitHub Actions を「確認だけ（投稿しない）」で呼ぶ
 *   GET  ?key=…&do=trigger  … トリガーを張る
 *   GET  ?key=…&do=cleanup  … もう使わないプロパティ（ボットのトークンなど）を消す
 *   POST ?key=…&do=set      … 本文 {"GH_TOKEN": "..."} をスクリプト プロパティに入れる
 */
var ADMIN_KEY_SHA256 = 'de97049dd01dd1814c26a61358689ef0f2975c6db3788824e6eb468df69234cb';

function adminOk_(e) {
  var k = String(((e && e.parameter) || {}).key || '');
  var h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, k, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  return h === ADMIN_KEY_SHA256;
}

function adminRun_(e, body) {
  if (!adminOk_(e)) return ContentService.createTextOutput('forbidden');
  var p = e.parameter, out = [];
  try {
    if (p['do'] === 'set' && body) {
      var v = JSON.parse(body), keys = [];
      Object.keys(v).forEach(function (k) { if (/^(GH_TOKEN|GH_REPO)$/.test(k)) { PropertiesService.getScriptProperties().setProperty(k, String(v[k])); keys.push(k); } });
      out.push('入れた: ' + keys.join(', '));
    } else if (p['do'] === 'check') {
      checkSetup(); out.push(Logger.getLog());
    } else if (p['do'] === 'dry') {
      dispatchDry(); out.push(Logger.getLog());
    } else if (p['do'] === 'trigger') {
      setupTrigger(); out.push(Logger.getLog());
    } else if (p['do'] === 'cleanup') {
      ['DISCORD_BOT_TOKEN', 'CHANNEL_ID', 'WEBHOOK_URL', 'LAST_POSTED_DATE', 'LAST_MESSAGE_ID', 'REACTED'].forEach(function (k) { PropertiesService.getScriptProperties().deleteProperty(k); });
      out.push('消した');
    } else {
      out.push('do=check / dry / trigger / cleanup / set');
    }
  } catch (err) { out.push('エラー: ' + err.message); }
  return ContentService.createTextOutput(out.join('\n'));
}

function doGet(e) { return adminRun_(e, null); }
function doPost(e) { return adminRun_(e, e.postData && e.postData.contents); }
