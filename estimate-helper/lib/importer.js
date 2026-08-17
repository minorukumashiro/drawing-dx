// 弥生の元帳エクスポートを Firestore の `yayoiRecords` コレクションへ upsert する共通処理。
//
// bin/import-to-firestore.js（手動実行）と bin/auto-import.js（タスクスケジューラからの自動実行）が
// どちらもこの関数を使う。図面DXプラットフォーム本体のドキュメント(workspaces/default)には一切
// 触れない — 1MB上限に達して壊れるのを避けるための設計。
//
// 再実行しても安全（同じ取引は lib/yayoiSource.js が生成する安定ID
// `${source}_${取引先コード}_{伝票番号}_{明細行番号}` に対して .set(merge) で上書きするだけなので、
// 弥生の元帳を再エクスポートして中身が増えても重複登録されない）。

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { loadYayoiRecords } = require('./yayoiSource');

const COLLECTION = 'yayoiRecords';
const BATCH_SIZE = 400; // Firestoreの1バッチ上限500に余裕を持たせる

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

/**
 * 指定した弥生ファイル群を読み込んでFirestoreへupsertする。
 *
 * @param {object}   opts
 * @param {object}   opts.config    config.json の内容
 * @param {Array}    opts.files     読み込む対象（[{path, type, encoding?}]）。省略時は config.yayoiFiles 全部
 * @param {boolean}  opts.dryRun    trueなら読み込み・件数確認だけ行い書き込まない
 * @param {Function} opts.log       進捗の出力先（既定 console.log）
 * @param {Function} opts.logError  警告の出力先（既定 console.error）
 * @returns {Promise<{read:number, written:number, warnings:string[], duplicateIds:string[]}>}
 */
async function importYayoiFiles({ config, files, dryRun = false, log = console.log, logError = console.error }) {
  const targets = files || config.yayoiFiles;

  log('弥生元帳を読み込み中...');
  const { records, warnings } = await loadYayoiRecords(targets, config.yayoiFieldIndex, config.yayoiItemVoucherKubuns);
  warnings.forEach((w) => logError(`警告: ${w}`));
  log(`読み込み件数: ${records.length}件`);

  // IDの重複チェック（同じファイル内で伝票番号+行番号が衝突していないか）
  const idCount = {};
  records.forEach((r) => { idCount[r.id] = (idCount[r.id] || 0) + 1; });
  const duplicateIds = Object.keys(idCount).filter((id) => idCount[id] > 1);
  if (duplicateIds.length) {
    logError(`警告: ID重複が${duplicateIds.length}件あります（後勝ちでFirestoreには1件だけ書き込まれます）。例: ${duplicateIds.slice(0, 5).join(', ')}`);
  }

  if (dryRun) {
    log('--dry-run のためFirestoreへの書き込みは行いません。サンプル3件:');
    records.slice(0, 3).forEach((r) => log(JSON.stringify(toDoc(r), null, 2)));
    return { read: records.length, written: 0, warnings, duplicateIds };
  }

  if (!records.length) {
    log('書き込むレコードがありません。終了します。');
    return { read: 0, written: 0, warnings, duplicateIds };
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
    log(`  ${written}/${records.length}件 書き込み済み...`);
  }

  log(`完了: ${COLLECTION}コレクションに${written}件をupsertしました。`);
  return { read: records.length, written, warnings, duplicateIds };
}

module.exports = { importYayoiFiles, loadConfig, initFirestore, normalizeClientForMatch, toDoc, COLLECTION };
