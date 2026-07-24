// 図面DXプラットフォームのFirestore(workspaces/default)から drawings[] を読み取り専用で取得する。
// 書き込みは一切行わない。認証情報は mail-fax-watcher/serviceAccountKey.json を流用する想定
// （lib/firestoreSync.js の initFirestore と同じパターン）。

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { extractMaterial, extractDiameterMm } = require('./extract');

const WORKSPACE_DOC = 'default';

function initFirestore(serviceAccountKeyPath) {
  const keyPath = path.resolve(serviceAccountKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Firebaseサービスアカウントキーが見つかりません: ${keyPath}\n` +
      'README.mdの手順に従って config.json の serviceAccountKeyPath を設定してください。'
    );
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// workspaces/default を1回読み取り、drawings[] と masters（弥生得意先コード紐付け等）を返す
async function fetchWorkspace(db) {
  const snap = await db.collection('workspaces').doc(WORKSPACE_DOC).get();
  if (!snap.exists) return { drawings: [], masters: {} };
  const data = snap.data();
  return {
    drawings: Array.isArray(data.drawings) ? data.drawings : [],
    masters: data.masters || {}
  };
}

// index.html の drawing オブジェクト（d.number, d.name, d.mat, d.size, d.client, d.price, d.qty, ...）を
// 検索・実績データとして共通の record 形式に正規化する。
function normalizeDrawing(d) {
  const material = (d.mat || extractMaterial(d.name) || extractMaterial(d.size) || '').toUpperCase().trim();
  const diameterMm = extractDiameterMm(d.size) || extractDiameterMm(d.name);
  const qty = d.qty != null && d.qty !== '' ? Number(d.qty) : null;
  const unitPrice = d.price != null && d.price !== '' ? Number(d.price) : null;
  return {
    source: 'drawing-dx',
    id: 'dx_' + d.id,
    date: d.date || d.deadline || null,
    client: (d.client || '').trim(),
    material,
    diameterMm,
    sizeRaw: d.size || '',
    name: d.name || '',
    number: d.number || '',
    qty,
    unitPrice,
    amount: qty != null && unitPrice != null ? qty * unitPrice : null,
    status: d.status || '',
    raw: d
  };
}

// 弥生の得意先名 <-> 図面DXの取引先名 の紐付け（masterタブ「弥生 得意先突合」で確定した分）を
// { 弥生得意先名: 図面DX取引先名 } の形で返す（クライアント名表記ゆれの吸収に使う）
function buildClientNameMap(masters) {
  const map = {};
  const clientMap = (masters && masters.clientMap) || {};
  Object.keys(clientMap).forEach((dxName) => {
    const entry = clientMap[dxName];
    if (entry && entry.yname) map[entry.yname.trim()] = dxName.trim();
  });
  return map;
}

async function loadDrawingRecords(serviceAccountKeyPath) {
  const db = initFirestore(serviceAccountKeyPath);
  const { drawings, masters } = await fetchWorkspace(db);
  return {
    records: drawings.map(normalizeDrawing),
    clientNameMap: buildClientNameMap(masters)
  };
}

module.exports = { initFirestore, fetchWorkspace, normalizeDrawing, buildClientNameMap, loadDrawingRecords };
