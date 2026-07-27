# dji-log 飛行日誌（iPhone単独版・実験）

DJIの飛行記録から国交省様式1の飛行日誌を作るWebアプリ。**iPhoneだけで完結**します。
Mac版（`../dji-log`）とは別の実験プロジェクトです。

## 特徴

- **サーバー不要**：解析・保存・Excel出力をすべてブラウザ内で行う
- **DJI APIキー不要**：暗号化されたログでも、飛行日誌に必要な項目は平文のまま読める
- **ホーム画面に追加**すればアプリのように使える（オフライン可）
- 飛行記録は端末外に出ない（住所表示のときだけ国土地理院に座標を問い合わせる）

## 使い方

1. iPhoneのSafariでこのアプリを開く
2. 共有ボタン →「ホーム画面に追加」（アプリとして使えるようになる）
3. 「飛行記録を読み込む」→「ファイル」App →「このiPhone内」→ **DJI Fly** → **FlightRecords**
   → .txt を選択（まとめて選べる）
4. 設定で操縦者氏名と機体の登録記号（JU〜）を入力
5. 記録をタップして目的・特定飛行などを補記
6. 「様式1 Excelを書き出す」→ 共有シートから「ファイル」Appに保存

## 動かし方（開発時）

```bash
python3 -m http.server 8310 --directory dji-log-mobile
```

iPhoneから使うには、同じWi-Fi上のMacのIPアドレス（例 `http://192.168.1.5:8310`）を開く。
ホーム画面に追加して常用する場合は、HTTPSで配信できる場所（GitHub Pages等）に置くのが確実。

## なぜDJI APIキーが要らないのか

v13以降のDJIログは暗号化されており、飛行経路（フレーム）の復号にはDJIサーバーから
取得する鍵が必要です。ただし**ログ先頭のDetailsブロックは平文**で、そこに

- 飛行開始時刻・飛行時間
- 累積移動距離・最高高度
- 離陸地点の緯度経度
- 機体名・シリアル番号

が入っています。飛行日誌に必要な項目はこれで揃うため、復号せずに済ませています。
Mac版のフレーム解析と値が一致することを実ログで確認済みです。

（ブラウザからはDJIのAPIがCORSで叩けないため、仮に復号したくてもできません。
飛行経路の詳細な分析が必要な場合はMac版を使ってください。）

## 実機に触らずに検証する

iPhoneを出す前に、Safariと同じWebKitエンジンで自動検証できる。**Xcodeは不要**。

```bash
npm install
npx playwright install webkit
npm run serve &
node tools/verify-webkit.mjs "path/to/DJIFlightRecord_....txt"
```

iPhone 15の画面サイズで、WASM解析・IndexedDB保存・Excel生成・レイアウト崩れ
（横スクロール、ラベルのはみ出し）を確認し、`webkit-shot.png` を残す。

実機でしか確かめられないのは次の2つだけ:

- 「ファイル」App から DJI Fly → FlightRecords を選ぶ操作
- ホーム画面に追加したときの動作（Service Workerは**HTTPSかlocalhostが必要**。
  `http://192.168.x.x:8310` では登録されない）

## Mac版との違い

| | Mac版 | iPhone単独版 |
|---|---|---|
| 記録の取り込み | USB接続で自動 | 「ファイル」Appから手動選択 |
| DJI APIキー | 必要 | 不要 |
| 住所 | 番地（街区・地番）まで | 町丁目まで |
| 飛行経路の解析 | あり（最大変位など） | なし |
| 飛行日誌の作成 | ○ | ○ |

## 構成

- `js/parser.js` — WASM版 dji-log-parser でログを解析
- `js/db.js` — IndexedDB への保存と飛行判定
- `js/geocode.js` — 国土地理院の逆ジオコーダ
- `js/export.js` — 様式1のExcel生成（SheetJS）
- `vendor/` — dji-log-parser (MIT) / SheetJS (Apache-2.0)
- `data/muni.json` — 市区町村コード表（国土地理院）
