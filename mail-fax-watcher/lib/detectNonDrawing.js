// index.html の detectNonDrawingDoc() をそのまま移植したもの。
// 図面ではなく注文書・納品書・見積書と思われるファイル名を検出する（あくまでファイル名だけの粗いヒント）。
// ユーザー方針により既定では無効（config.excludeNonDrawingDocsByFilename=false）＝除外はせずタグだけ付けて「待機」に入れる。
// 「加工指示書（図面代用）」かどうかの判断はここでは行わない。実際に加工できる情報が書かれているかは
// 人が中身を見て判断するしかないため、drawing-DX側の図面登録・待機整理画面で「種別」として選ぶ運用にしている。
// index.html 側のロジックを変更した場合はこちらも手動で合わせること。
function detectNonDrawingDoc(text) {
  if (!text) return null;
  if (/注文書|発注書/.test(text)) return '注文書';
  if (/納品書/.test(text)) return '納品書';
  if (/見積書|御見積|お見積/.test(text)) return '見積書';
  return null;
}

module.exports = { detectNonDrawingDoc };
