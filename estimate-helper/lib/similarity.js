// 新規の引き合い条件(query)と過去実績(record)の類似度を計算する。
// index.html の calcSimilarity() と同じ考え方（径の近さ・材質一致/類似・得意先一致）だが、
// query 側は「径だけ分かっている」「材質は未定」等、情報が部分的なことが多いため、
// query に存在する項目だけで満点(100)を構成するよう重みを動的に正規化する。

const { materialGroupIndex, extractNums } = require('./extract');

const WEIGHTS = { diameter: 40, material: 35, client: 25 };

function diameterScore(qDiameter, rDiameter, toleranceRatio) {
  if (qDiameter == null || rDiameter == null) return null;
  const ratio = Math.min(qDiameter, rDiameter) / Math.max(qDiameter, rDiameter);
  if (ratio >= 1 - toleranceRatio * 0.25) return 1; // ほぼ同一（許容幅の1/4以内）
  if (ratio >= 1 - toleranceRatio) return 0.75; // 指定許容幅(既定±20%)以内
  if (ratio >= 1 - toleranceRatio * 2) return 0.35; // 許容幅の2倍以内はわずかに加点
  return 0;
}

// φ表記が無いレコード向けのフォールバック（サイズ文字列中の最大数値を代表寸法とみなす。
// index.html の calcSimilarity() が extractNums()[0] を主要寸法として比較しているのと同じ考え方）
function representativeSize(record) {
  if (record.diameterMm != null) return record.diameterMm;
  const nums = extractNums(record.sizeRaw);
  return nums.length ? nums[0] : null;
}

function sizeNumFallbackScore(qText, rText, toleranceRatio) {
  const qn = extractNums(qText), rn = extractNums(rText);
  if (!qn.length || !rn.length) return null;
  return diameterScore(qn[0], rn[0], toleranceRatio);
}

// 全角英数字を半角化した上で大文字化・trim（"ＡＬＨ" と "ALH" を同一視する）
function normalizeMaterialText(s) {
  return String(s || '').normalize('NFKC').toUpperCase().trim();
}

// query.material と record を比較する。JIS材質コード(SUS304等)としての一致/類似に加え、
// "ALH"「ALK」等JISパターン外の社内呼称は lib/extract.js の extractMaterial() では拾えないため、
// 摘要(sizeRaw/name)への直接部分一致もフォールバックとして見る
function materialScore(qMat, record) {
  if (!qMat) return null;
  const q = normalizeMaterialText(qMat);
  const rMat = normalizeMaterialText(record.material);
  if (rMat) {
    if (q === rMat) return 1;
    const qg = materialGroupIndex(q), rg = materialGroupIndex(rMat);
    if (qg >= 0 && qg === rg) return 0.7;
    if (q.slice(0, 2) === rMat.slice(0, 2)) return 0.4;
  }
  const rText = normalizeMaterialText(record.sizeRaw || record.name);
  if (rText && q.length >= 2 && rText.indexOf(q) >= 0) return 0.8;
  return rMat ? 0 : (rText ? 0 : null); // 材質・摘要どちらも情報が無ければ対象外(null)、あれば不一致(0)
}

// 法人格表記・空白の差を吸収して比較するための正規化（"○○（株）" と "株式会社○○" 等を同一視）
function normalizeClientName(s) {
  return String(s || '')
    .replace(/[\s　]/g, '')
    .replace(/株式会社|（株）|\(株\)|㈱|有限会社|（有）|\(有\)|㈲/g, '');
}

function clientScore(qClient, rClient, clientNameMap) {
  if (!qClient) return null;
  const q = qClient.trim();
  const r = (rClient || '').trim();
  if (!r) return 0;
  if (q === r) return 1;
  // 弥生名 <-> 図面DX名 の紐付け（masterタブ「弥生 得意先突合」で確定済みのもの）を考慮
  const mapped = clientNameMap && (clientNameMap[q] === r || clientNameMap[r] === q);
  if (mapped) return 1;
  const qn = normalizeClientName(q), rn = normalizeClientName(r);
  if (qn && rn && qn === rn) return 1;
  if (qn && rn && qn.length >= 2 && (rn.indexOf(qn) >= 0 || qn.indexOf(rn) >= 0)) return 0.85;
  return 0;
}

// query: { diameterMm, sizeRaw, material, client }
// record: normalize済みレコード（source, client, material, diameterMm, sizeRaw, ...）
// 戻り値: { score(0-100), reasons: string[] } / 該当項目が一つも無ければ score=0
function scoreRecord(query, record, opts) {
  const toleranceRatio = (opts && opts.toleranceRatio) || 0.2;
  const clientNameMap = opts && opts.clientNameMap;
  const parts = [];
  const reasons = [];

  let dScore = null;
  if (query.diameterMm != null) {
    dScore = diameterScore(query.diameterMm, representativeSize(record), toleranceRatio);
  } else if (query.sizeRaw) {
    dScore = sizeNumFallbackScore(query.sizeRaw, record.sizeRaw, toleranceRatio);
  }
  if (dScore != null) {
    parts.push({ weight: WEIGHTS.diameter, value: dScore });
    if (dScore >= 1) reasons.push('径ほぼ一致');
    else if (dScore >= 0.75) reasons.push(`径が近い(±${Math.round(toleranceRatio * 100)}%以内)`);
    else if (dScore > 0) reasons.push('径がやや近い');
  }

  const mScore = materialScore(query.material, record);
  if (mScore != null) {
    parts.push({ weight: WEIGHTS.material, value: mScore });
    if (mScore >= 1) reasons.push('材質一致');
    else if (mScore >= 0.8) reasons.push('摘要に材質名あり');
    else if (mScore >= 0.7) reasons.push('材質グループ類似');
    else if (mScore > 0) reasons.push('材質系統類似');
  }

  const cScore = clientScore(query.client, record.client, clientNameMap);
  if (cScore != null) {
    parts.push({ weight: WEIGHTS.client, value: cScore });
    if (cScore >= 1) reasons.push('得意先一致');
  }

  if (parts.length === 0) return { score: 0, reasons: [] };
  const maxTotal = parts.reduce((s, p) => s + p.weight, 0);
  const total = parts.reduce((s, p) => s + p.weight * p.value, 0);
  return { score: Math.round((total / maxTotal) * 100), reasons };
}

function search(query, records, opts) {
  return records
    .map((r) => {
      const { score, reasons } = scoreRecord(query, r, opts);
      return Object.assign({ score, reasons }, r);
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

function priceStats(results) {
  const prices = results.map((r) => r.unitPrice).filter((p) => p != null && Number.isFinite(p) && p > 0);
  if (!prices.length) return null;
  const sorted = prices.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    median
  };
}

module.exports = { scoreRecord, search, priceStats, WEIGHTS };
