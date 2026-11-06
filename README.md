# 三鷹テニスコート 空き監視

三鷹市の予約システム(yoyaku-mitaka.jp)の空き状況を30分おきにチェックし、`config.yml` の条件に合う空き枠が**新しく出たとき**だけ LINE に通知します。
データの取り方はコートチェッカー(mitaka-tennis-checker.user.js)と同じです。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `config.yml` | 監視条件(施設・曜日・時間・期間)。ここだけ書き換えればOK |
| `watch.js` | 監視スクリプト本体 |
| `package.json` | 必要なライブラリの一覧 |
| `.github/workflows/watch.yml` | 30分おきに自動実行する設定 |
| `state.json` | 前回見つけた空き(自動で作られます) |

## セットアップ手順

### 1. リポジトリを作る
1. GitHub 右上の「+」→「New repository」
2. Repository name: `mitaka-court-watch`
3. **Private** を選ぶ(1回20秒ほどで終わるので、無料枠に十分収まります)
4. 「Create repository」

### 2. ファイルをアップロードする
1. 作ったリポジトリの画面で「uploading an existing file」をクリック
2. `config.yml` `watch.js` `package.json` `README.md` をドラッグ&ドロップ
3. 「Commit changes」

### 3. 自動実行の設定ファイルを作る
`.github` は隠しフォルダでアップロードしにくいので、画面上で作ります。
1. 「Add file」→「Create new file」
2. ファイル名の欄に `.github/workflows/watch.yml` と入力(`/` を打つとフォルダに変わります)
3. `watch.yml` の中身をすべてコピーして貼り付け
4. 「Commit changes」

### 4. テスト実行
1. 上部の「Actions」タブ → 左の「コート空き監視」
2. 右側の「Run workflow」→ 緑の「Run workflow」
3. 30秒ほどで完了。実行をクリックすると、画面下の **Summary** に条件に合う空きが表示されます

ここまでで LINE なしのお試し運用が始まり、以降は30分おきに自動で回ります。

### 5. LINE 通知をつなぐ(お試しで問題なければ)
1. リポジトリの「Settings」→ 左の「Secrets and variables」→「Actions」
2. 「New repository secret」で2つ登録

| Name | Secret |
|---|---|
| `LINE_TOKEN` | チャネルアクセストークン(長期)※再発行したもの |
| `LINE_USER_ID` | あなたのユーザーID(U から始まる文字列) |

次の巡回から、新しい空きが出たときに LINE が届きます。
※ すでに空いている枠は1回目の実行で「既知」になるため、通知は「その後に新しく空いた枠」だけです。

## 条件を変えたいとき
GitHub 上で `config.yml` を開き、右上の鉛筆マークで編集 →「Commit changes」。スマホのブラウザからでも変更できます。
施設を増やすときは、`# ` を外して有効にします(コートチェッカーの⚙設定にある room_id と同じ番号)。

## 頻度・時間帯の変更
`.github/workflows/watch.yml` の `cron:` の行で決めています(時刻は日本時間から9時間引いたUTC)。
- 今: `7,37 0-14,21-23 * * *` → 日本時間 6:07〜23:37 の30分おき
- 1時間おき: `7 0-14,21-23 * * *`

## うまく動かないとき
「Actions」タブで赤い ✕ の実行を開くとエラー内容が出ます。その画面を Claude に見せてください。

## 注意
- 実行は混雑時に数分〜十数分遅れることがあります
- 祝日は holidays-jp の祝日データで判定しています
