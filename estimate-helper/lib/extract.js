// 図面DXプラットフォーム(index.html)の parseOCR() / calcSimilarity() と同じ考え方の
// 材質・径(サイズ)抽出ロジック。弥生の摘要・品名テキストや図面DXのフィールドから
// 「材質コード」「代表径(mm)」を推定するために使う。

// index.html の材質パターン一覧と同じ
const MATERIAL_PATTERNS = [
  'SUS\\d{3}[A-Z]{0,3}', 'SS\\d{3}', 'S[0-9]{2}C', 'SCM\\d{3}', 'SNCM\\d{3}',
  'A\\d{4}[A-Z]?', 'FC\\d{2,3}', 'FCD\\d{2,3}', 'SK[A-Z]?\\d{1,2}', 'SKD\\d{1,2}',
  'SKH\\d{1,2}', 'SUJ\\d', 'C\\d{4}', 'SPHC', 'SPCC', 'SECC', 'SGCC'
];
const MATERIAL_RE = new RegExp('(' + MATERIAL_PATTERNS.join('|') + ')', 'i');

// index.html の calcSimilarity() の材質グループと同じ（近い材質の判定に使う）
const MATERIAL_GROUPS = [
  ['SUS304', 'SUS316', 'SUS420', 'SUS303'],
  ['SS400', 'S45C', 'S50C', 'S55C'],
  ['SCM435', 'SCM440', 'SNCM439'],
  ['A5052', 'A2017', 'A6061', 'A7075'],
  ['FC250', 'FC200', 'FC300', 'FCD450', 'FCD600'],
  ['SKD11', 'SKD61', 'SKH51', 'SK3']
];

function extractMaterial(text) {
  if (!text) return '';
  const m = String(text).match(MATERIAL_RE);
  return m ? m[1].toUpperCase() : '';
}

function materialGroupIndex(mat) {
  if (!mat) return -1;
  for (let i = 0; i < MATERIAL_GROUPS.length; i++) {
    if (MATERIAL_GROUPS[i].indexOf(mat) >= 0) return i;
  }
  return -1;
}

// φ80×L120 のような表記から代表径(mm)を取り出す。φが無ければ null。
const DIAMETER_RE = /[φΦ]\s?(\d+\.?\d*)/;
function extractDiameterMm(text) {
  if (!text) return null;
  const m = String(text).match(DIAMETER_RE);
  return m ? Number(m[1]) : null;
}

// index.html の extractNums() と同じ（φが無い場合のサイズ比較フォールバック用）
function extractNums(text) {
  if (!text) return [];
  const m = String(text).match(/\d+\.?\d*/g);
  return m ? m.map(Number).sort((a, b) => b - a) : [];
}

module.exports = {
  MATERIAL_GROUPS,
  extractMaterial,
  materialGroupIndex,
  extractDiameterMm,
  extractNums
};
