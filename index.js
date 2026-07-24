require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 20 * * *';
// 冒頭に付けるメンション。@everyone はチャンネルを見られる人だけに通知が飛ぶ。
// 空にすればメンションなしになる。
const MENTION = (process.env.MENTION || '').trim();
const TIMEZONE = 'Asia/Tokyo';
// 日本時間はUTC+9固定（サマータイムなし）なので、時刻計算はこのオフセットで足りる
const JST_OFFSET_HOURS = 9;

// 最後に投稿した時刻の記録先。Macがスリープして定時投稿を取りこぼしたかの判定に使う
const STATE_FILE = path.join(__dirname, 'state.json');
// 取りこぼしに気づくのが遅すぎた場合、何時（JST）を過ぎたら復帰投稿を諦めるか。
// 期限が23:59なので、これ以降に投稿しても押す時間が無い
const CATCHUP_GIVE_UP_HOUR = 23;
// 取りこぼしを確認する間隔
const CATCHUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// 押してもらうスタンプ（この順番でBotが先に付ける）。
// group が切り替わる境目は、メッセージ本文で空行を挟む（時間帯グループ／勤務状況グループ）
const REACTIONS = [
  { emoji: '🌅', label: '午前（9:00〜12:00）', group: 'time' },
  { emoji: '☀️', label: '午後（12:00〜18:00）', group: 'time' },
  { emoji: '🌙', label: '夜（18:00〜24:00）', group: 'time' },
  { emoji: '🏠', label: '在宅勤務', group: 'status' },
  { emoji: '🛌', label: 'オフ', group: 'status' },
  { emoji: '❓', label: '未定', group: 'status' },
];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 現在時刻を日本時間の "YYYY-MM-DD HH:MM:SS" で返す */
function jstNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
}

function log(...args) {
  console.log(`[${jstNow()}]`, ...args);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    // 記録に失敗しても投稿自体は成功しているので、警告だけ出して続行する
    console.error('state.json の書き込みに失敗:', err.message);
  }
}

/** 日本時間の「今日の hour:minute」をUNIXミリ秒で返す */
function jstTimeToday(hour, minute) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour - JST_OFFSET_HOURS, minute);
}

/** 今日の予定投稿時刻。CRON_SCHEDULE が単純な「分 時 * * *」形式のときだけ算出する */
function scheduledTimeToday() {
  const [minute, hour] = CRON_SCHEDULE.trim().split(/\s+/);
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  return jstTimeToday(Number(hour), Number(minute));
}

/** 日本時間での「今日」を {month, day, weekday} で返す */
function todayInJST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  // 曜日はJSTの日付から算出する
  const jstDate = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  return {
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAYS[jstDate.getUTCDay()],
  };
}

/** スタンプの凡例。group が切り替わる境目に空行を入れる */
function buildLegend() {
  const lines = [];
  let prevGroup = null;
  for (const r of REACTIONS) {
    if (prevGroup !== null && r.group !== prevGroup) lines.push('');
    lines.push(`${r.emoji} ${r.label}`);
    prevGroup = r.group;
  }
  return lines.join('\n');
}

function buildMessage() {
  return [
    ...(MENTION ? [MENTION] : []),
    '**明日のオフィス出勤確認**🐹',
    '⏰ 本日23:59まで',
    '※当てはまるもの全てにスタンプしてください！',
    '',
    buildLegend(),
  ].join('\n');
}

async function postAttendanceCheck(client) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`チャンネル ${CHANNEL_ID} がテキストチャンネルとして取得できない`);
  }

  // 投稿先はスレッド。放置するとDiscordが自動アーカイブし、アーカイブ中は投稿できない。
  // （Macがスリープ等で1日投稿を飛ばすとこれが起きる）
  if (channel.isThread() && channel.archived) {
    await channel.setArchived(false);
    log('スレッドがアーカイブされていたので解除した');
  }

  const message = await channel.send({
    content: buildMessage(),
    allowedMentions: { parse: ['everyone', 'roles'] },
  });
  log(`投稿した: #${channel.name} (message id: ${message.id})`);

  // スタンプは順番どおりに1つずつ（並列だとレート制限で順序が崩れる）。
  // 1つ失敗しても残りは付けたいので、個別にエラーを拾う。
  let added = 0;
  for (const { emoji, label } of REACTIONS) {
    try {
      await message.react(emoji);
      added += 1;
    } catch (err) {
      console.error(`スタンプ ${emoji}（${label}）を付けられなかった:`, err.message);
    }
  }
  log(`スタンプ ${added}/${REACTIONS.length} 個を付けた`);

  writeState({ lastPostedMs: Date.now(), lastPostedAt: jstNow(), messageId: message.id });
}

let posting = false;

/** 定時投稿と復帰投稿の共通入口。多重実行を防ぐ */
async function runPost(client, reason) {
  if (posting) {
    log(`${reason}: 前の投稿処理が実行中のためスキップ`);
    return;
  }
  posting = true;
  try {
    await postAttendanceCheck(client);
  } catch (err) {
    console.error(`投稿に失敗 (${reason}):`, err.message);
  } finally {
    posting = false;
  }
}

/**
 * 定時投稿を取りこぼしていないか確認し、必要なら今すぐ投稿する。
 * node-cron はスリープ中に過ぎた時刻を後から実行しないので、この補完が要る。
 */
async function catchUpIfMissed(client) {
  const scheduled = scheduledTimeToday();
  if (scheduled === null) return;

  const now = Date.now();
  if (now < scheduled) return; // まだ今日の予定時刻前

  const { lastPostedMs = 0 } = readState();
  if (lastPostedMs >= scheduled) return; // 今日の分は投稿済み

  if (now > jstTimeToday(CATCHUP_GIVE_UP_HOUR, 0)) {
    log(`今日の投稿が抜けているが、${CATCHUP_GIVE_UP_HOUR}時を過ぎているので復帰投稿は見送る`);
    return;
  }

  log('今日の定時投稿が抜けている（スリープ等）。復帰投稿する');
  await runPost(client, '復帰投稿');
}

function requireEnv() {
  const missing = ['DISCORD_TOKEN', 'CHANNEL_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`.env が足りない: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`CRON_SCHEDULE の形式が不正: ${CRON_SCHEDULE}`);
    process.exit(1);
  }
}

async function main() {
  requireEnv();

  const runNow = process.argv.includes('--now');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    log(`ログイン成功: ${client.user.tag}`);

    if (runNow) {
      try {
        await postAttendanceCheck(client);
      } catch (err) {
        console.error('テスト投稿に失敗:', err.message);
        process.exitCode = 1;
      }
      await client.destroy();
      return;
    }

    cron.schedule(CRON_SCHEDULE, () => runPost(client, '定時投稿'), { timezone: TIMEZONE });

    log(`スケジュール開始: "${CRON_SCHEDULE}" (${TIMEZONE}) — 常駐中。止めるには Ctrl+C`);

    // 起動直後と一定間隔で取りこぼしを確認する。
    // Macがスリープから復帰した直後もここで拾える。
    const checkCatchUp = () => {
      catchUpIfMissed(client).catch((err) => console.error('復帰確認に失敗:', err.message));
    };
    checkCatchUp();
    setInterval(checkCatchUp, CATCHUP_CHECK_INTERVAL_MS);
    log(`取りこぼし確認: ${CATCHUP_CHECK_INTERVAL_MS / 60000}分ごと（${CATCHUP_GIVE_UP_HOUR}時まで）`);
  });

  client.on('error', (err) => console.error('Discordクライアントエラー:', err.message));

  await client.login(TOKEN);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('起動に失敗:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildMessage,
  todayInJST,
  REACTIONS,
  // 検証用
  _scheduledTimeToday: scheduledTimeToday,
  _jstTimeToday: jstTimeToday,
  _readState: readState,
};
