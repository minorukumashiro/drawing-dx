#!/usr/bin/env node
// 見積もり自動化 第一段: 図面DXプラットフォーム(Firestore, 読み取り専用) + 弥生元帳エクスポート を
// 横断して、新規引き合いの条件（径・材質・得意先）に近い過去実績を検索し、単価の目安を出すCLI。
//
// 使い方: node bin/estimate.js --diameter 80 --material SUS304 --client "○○工業" [--top 15]
// 詳細は README.md を参照。

const fs = require('fs');
const path = require('path');

const { loadDrawingRecords } = require('../lib/firestoreSource');
const { loadYayoiRecords } = require('../lib/yayoiSource');
const { search, priceStats } = require('../lib/similarity');
const { printResultsTable, printStats } = require('../lib/format');

function parseArgs(argv) {
  const args = { top: null, minScore: null, tolerance: null, source: 'all', json: false, noFirestore: false, noYayoi: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--diameter': case '-d': args.diameter = Number(next()); break;
      case '--material': case '-m': args.material = next(); break;
      case '--client': case '-c': args.client = next(); break;
      case '--size': args.size = next(); break;
      case '--top': args.top = Number(next()); break;
      case '--min-score': args.minScore = Number(next()); break;
      case '--tolerance': args.tolerance = Number(next()); break;
      case '--source': args.source = next(); break;
      case '--config': args.config = next(); break;
      case '--json': args.json = true; break;
      case '--no-firestore': args.noFirestore = true; break;
      case '--no-yayoi': args.noYayoi = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`不明なオプション: ${a}`); process.exit(1); }
    }
  }
  return args;
}

function printHelp() {
  console.log(`見積もり類似実績検索ツール

使い方:
  node bin/estimate.js --diameter 80 --material SUS304 --client "○○工業"

オプション:
  -d, --diameter <mm>   径(mm)。図面の「φ80」の80の部分。
  -m, --material <code> 材質コード（例: SUS304 / SS400）
  -c, --client <name>   得意先名（図面DXの表記または弥生の表記どちらでも可）
      --size <text>     径が分からない場合のサイズ文字列（φ表記が無いものの簡易フォールバック比較用）
      --top <n>         上位n件を表示（既定値はconfig.jsonのdefaultTop、未設定なら15）
      --min-score <n>   このスコア(0-100)未満の結果を除外（既定値はconfig.jsonのdefaultMinScore、未設定なら40）
      --tolerance <r>   径の許容比率（既定0.2 = ±20%）
      --source <name>   all | drawing-dx | yayoi-customer | yayoi-supplier （既定 all）
      --config <path>   config.jsonのパス（既定 ./config.json）
      --json            結果をJSONで出力
      --no-firestore    図面DX(Firestore)を読み込まない（弥生データのみで検索）
      --no-yayoi        弥生データを読み込まない（図面DXのみで検索）
`);
}

function loadConfig(configPath) {
  const p = path.resolve(configPath || path.join(__dirname, '..', 'config.json'));
  if (!fs.existsSync(p)) {
    throw new Error(
      `config.json が見つかりません: ${p}\n` +
      'config.example.json をコピーして config.json を作成し、環境に合わせて設定してください。'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (args.diameter == null && !args.material && !args.client && !args.size) {
    console.error('検索条件を1つ以上指定してください（--diameter / --material / --client / --size）。--help で使い方を表示します。');
    process.exit(1);
  }

  const config = loadConfig(args.config);
  const toleranceRatio = args.tolerance != null ? args.tolerance : (config.defaultToleranceRatio != null ? config.defaultToleranceRatio : 0.2);
  const top = args.top != null ? args.top : (config.defaultTop || 15);
  const minScore = args.minScore != null ? args.minScore : (config.defaultMinScore != null ? config.defaultMinScore : 40);

  let allRecords = [];
  let clientNameMap = {};
  const warnings = [];

  if (!args.noFirestore) {
    try {
      const { records, clientNameMap: cmap } = await loadDrawingRecords(config.serviceAccountKeyPath);
      allRecords = allRecords.concat(records);
      clientNameMap = cmap;
      console.error(`[図面DX] ${records.length}件を読み込みました`);
    } catch (e) {
      warnings.push(`図面DX(Firestore)の読み込みに失敗: ${e.message}`);
    }
  }

  if (!args.noYayoi) {
    const { records, warnings: yw } = await loadYayoiRecords(config.yayoiFiles, config.yayoiFieldIndex, config.yayoiItemVoucherKubuns);
    allRecords = allRecords.concat(records);
    warnings.push(...yw);
    console.error(`[弥生] ${records.length}件を読み込みました`);
  }

  warnings.forEach((w) => console.error(`警告: ${w}`));

  if (args.source && args.source !== 'all') {
    allRecords = allRecords.filter((r) => r.source === args.source);
  }

  const query = {
    diameterMm: args.diameter != null && Number.isFinite(args.diameter) ? args.diameter : null,
    sizeRaw: args.size || '',
    material: args.material || '',
    client: args.client || ''
  };

  const results = search(query, allRecords, { toleranceRatio, clientNameMap })
    .filter((r) => r.score >= minScore)
    .slice(0, top);

  if (args.json) {
    console.log(JSON.stringify({ query, results, stats: priceStats(results) }, null, 2));
    return;
  }

  console.log('');
  console.log(`検索条件: 径=${query.diameterMm != null ? query.diameterMm + 'mm' : '-'} 材質=${query.material || '-'} 得意先=${query.client || '-'} (許容±${Math.round(toleranceRatio * 100)}%)`);
  console.log(`対象実績: ${allRecords.length}件中 スコア${minScore}以上 上位${results.length}件を表示`);
  console.log('');
  if (!results.length) {
    console.log('該当する実績が見つかりませんでした。--min-score を下げるか、条件を減らして再検索してください。');
    return;
  }
  printResultsTable(results);
  console.log('');
  printStats(priceStats(results), '単価の目安（表示中の結果より）');
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
