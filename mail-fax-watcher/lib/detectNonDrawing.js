// index.html の detectNonDrawingDoc() をそのまま移植したもの。
// 図面ではなく注文書・納品書・見積書と思われるファイル名を検出する。
// ユーザー方針により既定では無効（config.excludeNonDrawingDocsByFilename=false）。
// index.html 側のロジックを変更した場合はこちらも手動で合わせること。
function detectNonDrawingDoc(text) {
  if (!text) return null;
  if (/注文書|発注書/.test(text)) return '注文書';
  if (/納品書/.test(text)) return '納品書';
  if (/見積書|御見積|お見積/.test(text)) return '見積書';
  return null;
}

module.exports = { detectNonDrawingDoc };
