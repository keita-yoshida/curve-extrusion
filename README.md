# Curve Extrusion

SVG / DXF の閉じた図形を押し出して STL を書き出す Web アプリです。

**Python もサーバーも不要**で、ブラウザ内だけで完結します。ファイルはどこにもアップロードされません。

---

## 構成

静的ファイルだけで動きます。ビルド手順もパッケージマネージャも不要です。

```
index.html                 UI
assets/
  app.js                   画面の配線・状態管理
  regions.js               閉ループの入れ子判定／押し出し
  svg-source.js            SVG → 閉領域、単位(mm)の読み取り
  dxf-source.js            DXF → 閉領域（円弧・スプライン・ブロック展開・線分の接続）
  viewer.js                Three.js の3Dプレビュー
  style.css
vendor/
  three/                   Three.js r185（MIT）+ SVGLoader / STLExporter / OrbitControls
  dxf-parser/              dxf-parser 1.1.2（MIT）
app.py                     旧 Streamlit 版（参考用に残しています）
```

依存ライブラリは `vendor/` に同梱してあるため、CDN にもネットワークにも依存しません。

## ローカルで動かす

ES modules を使うので `file://` では開けません。任意の静的サーバーを立ててください。

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## 公開する

`.github/workflows/pages.yml` がリポジトリ全体を GitHub Pages へ公開します。

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main` に push する

Netlify・Cloudflare Pages・S3 などにリポジトリの中身をそのまま置いても動きます（ビルドコマンドなし、公開ディレクトリはルート）。

---

## 機能

### 実寸の決め方

3Dプリント用に mm でサイズを決められます。

| モード | 動作 |
| --- | --- |
| ファイルの単位から自動 | SVG は `width="80mm"` と `viewBox` から、DXF は `$INSUNITS` から算出。実寸指定が無い SVG は CSS の 1px = 25.4/96 mm として扱います |
| 倍率を指定 | 1ユーザー単位 = N mm |
| 幅／高さを指定 | 図形全体の外接矩形を N mm に合わせます |

### 穴の判定方法（SVG のみ）

- **パス単位** … `fill-rule`（`nonzero` / `evenodd`）に従って `<path>` 要素ごとに穴を判定します。SVG の仕様どおりの結果になります
- **図形全体** … 閉じたパスを全部集めてから包含関係で判定します。外形と穴が別々の要素として書き出されている図面向けです

### DXF の対応要素

`LINE` / `LWPOLYLINE`（bulge 円弧含む）/ `POLYLINE` / `CIRCLE` / `ARC` / `ELLIPSE` / `SPLINE` / `INSERT`（ブロック参照・配列複写を展開）。

バラバラに並んだ線分は端点どうしを自動で接続して閉ループにします。閉じられなかった線はスキップし、本数を警告に出します。

---

## 旧 Streamlit 版との違い

| | 旧版 (`app.py`) | 現行（静的） |
| --- | --- | --- |
| 実行環境 | Streamlit Cloud（Python + trimesh + shapely） | ブラウザのみ |
| ファイルの扱い | サーバーへアップロード | 端末内で処理、送信なし |
| サイズ指定 | なし（座標値がそのまま出力） | mm 単位で自動／倍率／幅・高さ指定 |
| 曲線の粗さ | 固定 | 分割数を調整可能 |
| 穴の判定 | 全体で包含判定 | パス単位（fill-rule 準拠）と全体を切替 |
| 原点 | 入力座標のまま | XY中心を原点、Z下端を 0 に配置（切替可） |

`app.py` と `requirements.txt` / `packages.txt` は残してあるので、Streamlit 版も引き続きデプロイできます。

---

## ライセンス

同梱ライブラリのライセンスは `vendor/three/LICENSE`（Three.js, MIT）および `vendor/dxf-parser/LICENSE`（dxf-parser, MIT）を参照してください。
