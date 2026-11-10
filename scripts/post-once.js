// GitHub Actions から1回だけ実行する出勤確認の投稿（2026-11-10）。
// Macが寝ていても投稿が抜けないように、常駐Botではなくクラウドの定時実行で動かす。
// Discordには常時接続せず、Botトークンで直接 API を呼ぶ（投稿・スタンプ・スレッドのアーカイブ解除）。
//
// 1日に何回か起動されても、今日の分がもう投稿されていれば何もしない（重複しない）。
// DRY_RUN=1 なら、投稿せずに「投稿するかどうか」だけを確かめる。

const { buildMessage, REACTIONS, _jstTimeToday: jstTimeToday } = require('../index.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const DRY_RUN = process.env.DRY_RUN === '1';
const API = 'https://discord.com/api/v10';
const MARK = '明日のオフィス出勤確認';
const START_HOUR = 19; // この時刻（JST）より後の投稿を「今日の分」とみなす
const GIVE_UP_HOUR = 23; // 期限23:59に間に合わないので、これ以降は投稿しない

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (attendance-check, 1.0)',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt <= 5) {
      const data = await res.json().catch(() => ({}));
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000) + 200);
      continue;
    }
    if (res.status >= 500 && attempt <= 3) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
}

async function main() {
  if (!TOKEN || !CHANNEL_ID) throw new Error('DISCORD_TOKEN / CHANNEL_ID が設定されていない');

  const me = await api('GET', '/users/@me');
  const channel = await api('GET', `/channels/${CHANNEL_ID}`);
  console.log(`Bot: ${me.username} / 投稿先: #${channel.name}`);

  const now = Date.now();
  const start = jstTimeToday(START_HOUR, 0);
  if (now < start) {
    console.log(`まだ${START_HOUR}時前なので投稿しない`);
    return;
  }

  const recent = await api('GET', `/channels/${CHANNEL_ID}/messages?limit=50`);
  const posted = recent.find(
    (m) => m.author?.id === me.id && m.content.includes(MARK) && Date.parse(m.timestamp) >= start,
  );
  if (posted) {
    console.log(`今日の分は投稿済み（${posted.timestamp}）。何もしない`);
    return;
  }

  if (now > jstTimeToday(GIVE_UP_HOUR, 0)) {
    console.log(`${GIVE_UP_HOUR}時を過ぎたので今日の投稿は見送る`);
    return;
  }

  const archived = Boolean(channel.thread_metadata?.archived);
  if (DRY_RUN) {
    console.log(`[確認のみ] 今日の分はまだ。本番なら投稿する（スレッドのアーカイブ: ${archived ? 'あり→解除する' : 'なし'}）`);
    return;
  }

  if (archived) {
    await api('PATCH', `/channels/${CHANNEL_ID}`, { archived: false });
    console.log('スレッドがアーカイブされていたので解除した');
  }

  const message = await api('POST', `/channels/${CHANNEL_ID}/messages`, {
    content: buildMessage(),
    allowed_mentions: { parse: ['everyone', 'roles'] },
  });
  console.log(`投稿した (message id: ${message.id})`);

  let added = 0;
  for (const { emoji, label } of REACTIONS) {
    try {
      await api('PUT', `/channels/${CHANNEL_ID}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`);
      added += 1;
    } catch (err) {
      console.error(`スタンプ ${emoji}（${label}）を付けられなかった:`, err.message);
    }
    await sleep(400);
  }
  console.log(`スタンプ ${added}/${REACTIONS.length} 個を付けた`);
}

main().catch((err) => {
  console.error('失敗:', err.message);
  process.exit(1);
});
