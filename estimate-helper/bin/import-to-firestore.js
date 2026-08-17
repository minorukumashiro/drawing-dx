#!/usr/bin/env node
// 弥生の元帳エクスポート(config.jsonのyayoiFiles)を読み込み、Firestoreの新規コレクション
// `yayoiRecords`（1件=1ドキュメント）にupsertする手動実行用のCLI。
// 実際の読み込み・書き込み処理は lib/importer.js に置いてあり、自動取込
// (bin/auto-import.js) と共通のコードを使う。
//
// 使い方:
//   node bin/import-to-firestore.js            実際にインポートする
//   node bin/import-to-firestore.js --dry-run   書き込まずに件数・サンプルだけ確認する
//
// 弥生のエクスポート操作のたびに手で叩かなくて済むよう、フォルダを監視して自動で取り込む
// bin/auto-import.js も用意してある（README「弥生データの自動取込」参照）。

const { importYayoiFiles, loadConfig } = require('../lib/importer');

function parseArgs(argv) {
  const args = { dryRun: false, config: null };
  argv.forEach((a) => {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
  });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  await importYayoiFiles({ config, dryRun: args.dryRun });
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
