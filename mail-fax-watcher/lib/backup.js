// Firestore全データの日次バックアップ（NASへ書き出し）
// - meta/   : workspaces/default 全体のスナップショット（日次・世代管理）
// - images/ : workspaces/default/images/{id} を増分バックアップ（updatedフィールド基準）
//             削除された図面の画像ファイルも残るため、誤削除からの復元にも使える
// - docs/   : workspaces/insp_* rdoc_*（検査報告書・関連書類。追記型・不変なので未取得分のみ）
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Firestore Timestamp等をJSON化できる形に変換
function toPlain(v) {
  return JSON.parse(JSON.stringify(v));
}

async function runBackup(db, cfg, st, log) {
  const root = cfg.backup.dir;
  const keep = cfg.backup.keepGenerations || 30;
  const metaDir = path.join(root, 'meta');
  const imagesDir = path.join(root, 'images');
  const docsDir = path.join(root, 'docs');
  ensureDir(metaDir); ensureDir(imagesDir); ensureDir(docsDir);

  const result = { metaOk: false, images: 0, docs: 0 };

  // 1) メタデータ全体のスナップショット（日次・世代管理）
  const snap = await db.collection('workspaces').doc('default').get();
  if (!snap.exists) throw new Error('workspaces/default が存在しません');
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (ローカル=JST)
  const metaPath = path.join(metaDir, `dxp_meta_${today}.json`);
  fs.writeFileSync(metaPath, JSON.stringify({ backedUpAt: new Date().toISOString(), data: toPlain(snap.data()) }));
  result.metaOk = true;

  // 世代整理: dxp_meta_*.json を新しい順に keep 件残して削除
  const metaFiles = fs.readdirSync(metaDir).filter((f) => /^dxp_meta_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  for (const f of metaFiles.slice(keep)) {
    try { fs.unlinkSync(path.join(metaDir, f)); } catch (e) { /* 無視 */ }
  }

  // 2) 画像の増分バックアップ（updated > 前回最大値 のみ取得）
  const since = st.backupImagesSince || 0;
  let maxUpdated = since;
  const imgSnap = await db.collection('workspaces').doc('default').collection('images')
    .where('updated', '>', since).get();
  for (const doc of imgSnap.docs) {
    const d = doc.data();
    fs.writeFileSync(path.join(imagesDir, `${doc.id}.json`), JSON.stringify(d));
    if (typeof d.updated === 'number' && d.updated > maxUpdated) maxUpdated = d.updated;
    result.images++;
  }
  st.backupImagesSince = maxUpdated;

  // 3) 検査報告書(insp_*)・関連書類(rdoc_*)（不変ドキュメントのため未取得分のみ）
  if (!st.backedUpDocs) st.backedUpDocs = {};
  const refs = await db.collection('workspaces').listDocuments();
  for (const ref of refs) {
    const id = ref.id;
    if (!/^(insp_|rdoc_)/.test(id)) continue;
    if (st.backedUpDocs[id]) continue;
    const d = await ref.get();
    if (!d.exists) continue;
    fs.writeFileSync(path.join(docsDir, `${id}.json`), JSON.stringify(toPlain(d.data())));
    st.backedUpDocs[id] = 1;
    result.docs++;
  }

  log(`バックアップ完了: meta=${today}.json / 画像 ${result.images}件更新 / 書類 ${result.docs}件追加 (保存先 ${root})`);
  return result;
}

module.exports = { runBackup };
