#!/usr/bin/env node
// 弥生の元帳エクスポート(config.jsonのyayoiFiles)を読み込み、Firestoreの新規コレクション
// `yayoiRecords`（1件=1ドキュメント）にupsertする。図面DXプラットフォーム本体のドキュメント
// (workspaces/default)には一切触れない — 1MB上限に達して壊れるのを避けるための設計。
//
// 書き込みは管理者権限(serviceAccountKey.json)で行う。ブラウザ側(index.html)はこのコレクションを
// 読み取り専用でしか使わない。
//
// 使い方:
//   node bin/import-to-firestore.js            実際にインポートする
//   node bin/import-to-firestore.js --dry-run   書き込まずに件数・サンプルだけ確認する
//
// 再実行しても安全（同じ取引は lib/yayoiSource.js が生成する安定ID
// `${source}_${取引先コード}_{伝票番号}_{明細行番号}` に対して .set() で上書きするだけなので、
// 弥生の元帳を再エクスポートして中身が増えても重複登録されない）。

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { loadYayoiRecords } = require('../lib/yayoiSource');

const COLLECTION = 'yayoiRecords';
const BATCH_SIZE = 400; // Firestoreの1バッチ上限500に余裕を持たせる

function parseArgs(argv) {
  const args = { dryRun: false, config: null };
  argv.forEach((a) => {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
  });
  return args;
}

function loadConfig(configPath) {
  const p = path.resolve(configPath || path.join(__dirname, '..', 'config.json'));
  if (!fs.existsSync(p)) {
    throw new Error(`config.json が見つかりません: ${p}\nconfig.example.jsonをコピーして作成してください。`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function initFirestore(serviceAccountKeyPath) {
  const keyPath = path.resolve(serviceAccountKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Firebaseサービスアカウントキーが見つかりません: ${keyPath}`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

// 法人格表記・空白の差を吸収した比較用フィールド（index.html の jissekiNormalizeClient と同じ正規化）。
// 図面DX側は取引先名を法人格無しで登録することが多く（例:「不二新製作所」）、弥生側は
// 元帳の正式名（例:「（有）不二新製作所」）で入っているため、完全一致のFirestoreクエリだと
// ヒットしない問題があった（2026-07-27発覚）。径・材質が未入力の図面（取込直後の待機図面等）は
// 取引先名だけでyayoiRecordsを絞り込む必要があり、その際にこの正規化済みフィールドで検索する。
function normalizeClientForMatch(s) {
  return String(s || '').replace(/[\s　]/g, '').replace(/株式会社|（株）|\(株\)|㈱|有限会社|（有）|\(有\)|㈲/g, '');
}

// Firestoreドキュメントに保存するフィールドだけを抜き出す（rawの生配列は保存しない）
function toDoc(rec) {
  return {
    source: rec.source,
    partnerCode: rec.partnerCode || '',
    voucherNo: rec.voucherNo || '',
    lineNo: rec.lineNo || '',
    date: rec.date || null,
    client: rec.client || '',
    clientNormalized: normalizeClientForMatch(rec.client || ''),
    material: rec.material || '',
    diameterMm: rec.diameterMm != null ? rec.diameterMm : null,
    sizeRaw: rec.sizeRaw || '',
    name: rec.name || '',
    quoteNo: rec.number || '',
    qty: rec.qty != null ? rec.qty : null,
    unitPrice: rec.unitPrice != null ? rec.unitPrice : null,
    amount: rec.amount != null ? rec.amount : null,
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);

  console.log('弥生元帳を読み込み中...');
  const { records, warnings } = await loadYayoiRecords(config.yayoiFiles, config.yayoiFieldIndex, config.yayoiItemVoucherKubuns);
  warnings.forEach((w) => console.error(`警告: ${w}`));
  console.log(`読み込み件数: ${records.length}件`);

  // IDの重複チェック（同じファイル内で伝票番号+行番号が衝突していないか）
  const idCount = {};
  records.forEach((r) => { idCount[r.id] = (idCount[r.id] || 0) + 1; });
  const dupIds = Object.keys(idCount).filter((id) => idCount[id] > 1);
  if (dupIds.length) {
    console.error(`警告: ID重複が${dupIds.length}件あります（後勝ちでFirestoreには1件だけ書き込まれます）。例: ${dupIds.slice(0, 5).join(', ')}`);
  }

  if (args.dryRun) {
    console.log('--dry-run のためFirestoreへの書き込みは行いません。サンプル3件:');
    records.slice(0, 3).forEach((r) => console.log(JSON.stringify(toDoc(r), null, 2)));
    return;
  }

  if (!records.length) {
    console.log('書き込むレコードがありません。終了します。');
    return;
  }

  const db = initFirestore(config.serviceAccountKeyPath);
  const col = db.collection(COLLECTION);

  let written = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach((rec) => {
      const docId = rec.id.replace(/\//g, '_').slice(0, 1400); // Firestoreドキュメント名に'/'は使えない
      batch.set(col.doc(docId), toDoc(rec), { merge: true });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`  ${written}/${records.length}件 書き込み済み...`);
  }

  console.log(`完了: ${COLLECTION}コレクションに${written}件をupsertしました。`);
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
