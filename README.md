# もぐラボ 出勤確認Bot

毎日 **20:00（日本時間）** に、翌日のオフィス出勤確認メッセージを投稿し、
回答用のスタンプを自動で付けるDiscord Bot。

## 投稿内容

```
**明日のオフィス出勤確認**🐹
⏰ 本日23:59まで
※当てはまるもの全てにスタンプしてください！

🌅 午前（9:00〜12:00）
☀️ 午後（12:00〜18:00）
🌙 夜（18:00〜24:00）

🏠 在宅勤務
🛌 オフ
❓ 未定
```

投稿は当日20時・期限は当日23:59（「本日」＝投稿日）。

## セットアップ

```bash
# Node.js は ~/.local/node に導入済み
export PATH="$HOME/.local/node/bin:$PATH"

npm install
cp .env.example .env   # DISCORD_TOKEN を記入
```

### Botをサーバーに招待する

```
https://discord.com/oauth2/authorize?client_id=1529354530263797860&scope=bot&permissions=68672
```

必要権限: チャンネルを見る / メッセージ送信 / リアクション追加 / 履歴閲覧

## 使い方

```bash
npm start     # 常駐して毎日20時に投稿
npm run now   # 今すぐ1回だけ投稿（動作確認用）
```

## 取りこぼし復帰

node-cron はスリープ中に過ぎた時刻を後から実行しない。
このMacは `sleep 1`（1分でスリープ）設定なので、20時に寝ていると
その日の投稿が丸ごと抜ける。

対策として **5分ごとに「今日の分を投稿したか」を確認**し、
抜けていればMacが起きた時点で即投稿する。

| 状況 | 動作 |
|---|---|
| 20時にMacが起きていた | 定時どおり20:00に投稿 |
| 20時にスリープ→21時に復帰 | 21時台の確認で復帰投稿 |
| 23時を過ぎて気づいた | 見送る（期限23:59に間に合わないため） |
| 既に投稿済み | 何もしない |

投稿記録は `state.json`（git管理外）。判定は「今日の予定時刻より後に投稿したか」なので、
テスト投稿（`npm run now`）を昼間にしても定時投稿は抑止されない。

`CATCHUP_GIVE_UP_HOUR` で諦める時刻を変更できる（`index.js`）。

## 常時起動（launchd）

Macログイン時に自動起動し、落ちても再起動する。

```bash
cp launchd/com.mogurabo.attendance-bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mogurabo.attendance-bot.plist
```

| 操作 | コマンド |
|---|---|
| 状態確認 | `launchctl list \| grep attendance` |
| ログ | `tail -f logs/bot.log` |
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.mogurabo.attendance-bot.plist` |

※ Macがスリープ・シャットダウン中は投稿されない。確実に毎日流したいならサーバー（Railway等）に置くのが安全。

## 設定変更

| 項目 | 場所 |
|---|---|
| 投稿時刻 | `.env` の `CRON_SCHEDULE`（cron形式・Asia/Tokyo） |
| 投稿先チャンネル | `.env` の `CHANNEL_ID` |
| スタンプの種類・文言 | `index.js` の `REACTIONS` |
| メッセージ本文 | `index.js` の `buildMessage()` |

## 注意

`.env` にはBotトークンが入っている。git管理外（`.gitignore` 済み）。
漏れた場合は Discord Developer Portal で **Reset Token**。

## 自動投稿のしくみ（2026-11-11〜）

| 役割 | どこで | 内容 |
|---|---|---|
| 時刻を守る | GAS「出勤確認（出勤管理マン）」 `gas/attendance.gs` | 10分ごとに起動し、20時台に GitHub Actions を呼ぶ。成功を確かめ、失敗なら呼び直す |
| 送る | GitHub Actions「出勤確認の投稿」 `.github/workflows/attendance.yml` → `scripts/post-once.js` | ボットで投稿しスタンプを付ける。今日の分があれば何もしない |
| 予備 | Macの常駐ボット（launchd） | 20:20以降、スレッドに今日の分が無ければ送る（Macが起きていれば） |

- GitHub の定時実行（schedule）は7時間以上遅れて11/10が抜けたので使わない。呼び出し（workflow_dispatch）は遅れない。
- GAS から Discord のボット操作は弾かれる（403 / 40333）ので、GAS からは直接送らない。
- GAS の更新は `cd gas && clasp push`。管理用の入口（`gas/admin.gs`、合言葉は `.gas_admin_key`）で設定の確認・トリガー張りができる。
