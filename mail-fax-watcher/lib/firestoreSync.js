const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const WORKSPACE_DOC = 'default';

// index.html の compressImageForSync() と同じ 品質/縮小 の候補リスト
const COMPRESS_ATTEMPTS = [
  { scale: 1.0, quality: 92 },
  { scale: 1.0, quality: 85 },
  { scale: 0.85, quality: 88 },
  { scale: 0.75, quality: 85 },
  { scale: 0.65, quality: 82 },
  { scale: 0.55, quality: 80 },
  { scale: 0.45, quality: 78 },
  { scale: 0.35, quality: 75 }
];

function initFirestore(serviceAccountKeyPath) {
  const keyPath = path.resolve(serviceAccountKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Firebaseサービスアカウントキーが見つかりません: ${keyPath}\nREADME.mdの手順に従って取得・配置してください。`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function mimeForExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  return null;
}

function toDataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// 画像を maxBytes(dataURL文字列長) に収まるまで JPEG で再エンコードしていく。
// 収まらなければ null（＝画像本体は同期しない。ブラウザ側の compressImageForSync と同じ諦め方）。
async function compressImageToFit(buffer, maxBytes) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1000;
  const h = meta.height || 1000;
  for (const a of COMPRESS_ATTEMPTS) {
    const targetW = Math.max(1, Math.round(w * a.scale));
    const targetH = Math.max(1, Math.round(h * a.scale));
    const out = await sharp(buffer)
      .resize(targetW, targetH, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: a.quality })
      .toBuffer();
    const dataUrl = toDataUrl('image/jpeg', out);
    if (dataUrl.length < maxBytes) return dataUrl;
  }
  return null;
}

// 1件分のファイルから Firestore images/{id} ドキュメントの中身を作る。
// 戻り値: { doc: {image?,pdf?,updated}, oversized: bool }
async function buildImageDoc(filePath, ext, maxBytes) {
  const buffer = fs.readFileSync(filePath);
  const mime = mimeForExt(ext);
  const doc = { updated: Date.now() };
  let oversized = false;

  if (mime === 'application/pdf') {
    const dataUrl = toDataUrl(mime, buffer);
    if (dataUrl.length < maxBytes) {
      doc.pdf = dataUrl;
    } else {
      oversized = true; // ブラウザ側と同じく、大きすぎるPDFは本文を同期しない
    }
  } else if (mime) {
    const dataUrl = toDataUrl(mime, buffer);
    if (dataUrl.length < maxBytes) {
      doc.image = dataUrl;
    } else {
      const compressed = await compressImageToFit(buffer, maxBytes);
      if (compressed) doc.image = compressed;
      else oversized = true;
    }
  }
  return { doc, oversized };
}

// images/{id} は set() で丸ごと上書きするため、既存の図面が同じidを使っていないか
// 書き込み直前にもう一度確認する（reserveIdsのすり抜け対策の最終防波堤）。
// 2026-07-10: この確認が無かったため、既存図面の画像を誤って上書きする事故が発生した。
async function assertIdNotInUse(db, id) {
  const ref = db.collection('workspaces').doc(WORKSPACE_DOC);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const drawings = Array.isArray(data.drawings) ? data.drawings : [];
  const inUse = drawings.some((d) => String(d.id) === String(id));
  if (inUse) {
    throw new Error(`id衝突を検出したため images/${id} への書き込みを中止しました（既存の図面が同じidを使用中）`);
  }
}

async function uploadImageDoc(db, id, doc) {
  if (Object.keys(doc).length <= 1) return; // updatedしか無い＝中身が無い
  await assertIdNotInUse(db, id);
  await db.collection('workspaces').doc(WORKSPACE_DOC).collection('images').doc(String(id)).set(doc);
}

// nextId を count 件分まとめて予約し、開始IDを返す。
// ドキュメントの nextId フィールドが何らかの理由で既存の drawings の id より
// 小さい/同じ値になっている場合に備え、実際に使用済みの最大id+1 も下限として必ず考慮する
// （2026-07-10: nextIdフィールドが既存drawingと同じ値になっており、images/{id}を
//  誤って上書きする事故が発生したための安全策）。
async function reserveIds(db, count) {
  const ref = db.collection('workspaces').doc(WORKSPACE_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const drawings = Array.isArray(data.drawings) ? data.drawings : [];
    const maxUsedId = drawings.reduce((max, d) => {
      const n = Number(d.id);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const storedNextId = typeof data.nextId === 'number' ? data.nextId : 100;
    const startId = Math.max(storedNextId, maxUsedId + 1);
    tx.update(ref, { nextId: startId + count });
    return startId;
  });
}

// 新規図面メタデータを drawings 配列に追記する（既存フィールドは触らない部分更新）。
// 万一 newDrawings の id が既存の drawings と衝突していたら、images/{id} を巻き添えで
// 壊さないよう書き込み自体を中止する（reserveIds の安全策をすり抜けた場合の最終防波堤）。
async function appendDrawings(db, newDrawings) {
  const ref = db.collection('workspaces').doc(WORKSPACE_DOC);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const drawings = Array.isArray(data.drawings) ? data.drawings.slice() : [];
    const existingIds = new Set(drawings.map((d) => String(d.id)));
    for (const nd of newDrawings) {
      if (existingIds.has(String(nd.id))) {
        throw new Error(`id衝突を検出したため書き込みを中止しました: id=${nd.id} は既存のdrawingsに既に存在します`);
      }
    }
    // 新しいものを先頭に追加（ブラウザの一括登録 unshift と同じ並び）
    const merged = newDrawings.concat(drawings);
    tx.update(ref, {
      drawings: merged,
      lastModified: FieldValue.serverTimestamp(),
      lastClient: 'mail-fax-watcher'
    });
  });
}

// 指定IDが実際に drawings 配列に残っているか確認する（ブラウザ側の全体上書き同期との
// 競合でクロバーされていないかのセルフチェック用）。
async function fetchPresentIds(db, ids) {
  const ref = db.collection('workspaces').doc(WORKSPACE_DOC);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const drawings = Array.isArray(data.drawings) ? data.drawings : [];
  const present = new Set(drawings.map((d) => d.id));
  return ids.filter((id) => present.has(id));
}

module.exports = {
  initFirestore,
  mimeForExt,
  buildImageDoc,
  uploadImageDoc,
  reserveIds,
  appendDrawings,
  fetchPresentIds
};
