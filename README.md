# drawing-dx

## スキャンPDFのページ分割

「図面登録」または「一括登録」で複数ページPDFを選択すると、ページ単位のPDFへ自動分割します。
ページ番号付きのファイル名で一括登録画面に表示されるので、内容を確認して「チェックした図面を登録」を押してください。
初期ステータスは各ページとも「待機」です。図番が未入力なら登録時に固有番号を採番します。
分割には pdf-lib 1.17.1 を使用し、元のページの解像度・用紙サイズ・回転を保持します。

単票PDFは元のファイルを使用し、「図面登録」のOCR入力フローを維持します。
ZIP取込は従来どおり1ファイル1件です。注文書・納品書・見積書のファイル名による除外には既存の `detectNonDrawingDoc` を使用します。
暗号化・破損PDFや分割ライブラリの読込失敗はエラーを表示し、一括選択した他の正常なファイルは処理を継続します。
PDF内部の画像にしか存在しない書類名について、新たな自動除外は行いません。

## 回帰テスト

Node.js 22以降と `pdf-lib@1.17.1` を使用します。アプリ自体のビルドは不要です。
ライブラリを一時ディレクトリへ用意して、PowerShellで実行できます。

```powershell
curl.exe --fail --location https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js --output "$env:TEMP\drawing-dx-pdf-lib.cjs"
$env:PDF_LIB_PATH = "$env:TEMP\drawing-dx-pdf-lib.cjs"
node --test --test-isolation=none tests/scan-import.cjs
```

実PDFのページ分割・登録データ、単票と画像の維持、除外判定、失敗時の継続、キャンセル、ZIP取込、単票OCR経路、JavaScript構文を検証します。
テストは画面・保存先をスタブ化しており、Firestoreには書き込みません。
