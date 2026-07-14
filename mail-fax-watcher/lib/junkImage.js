const sharp = require('sharp');

// メール署名のロゴ・アイコン・バナー等「仕事に不要な小さい画像」を判定する。
//
// 判定はファイル名(image001.png 等)ではなく「サイズの小ささ」で行う。
// 理由: 顧客がメール本文に図面を貼り付けて送ってきた場合も Outlook は image001.png と
//       名付けるため、名前で切ると本物の図面まで落としかねない。実際の図面（写真・
//       スキャン・貼り付け図）は必ず大きいので、バイト数と画素数が小さい画像だけを除外する。
//
// Outlook がメール署名等に埋め込んだ画像の命名 (image001.png, image012.jpg …)。
// マクロが付ける "yyyymmdd_hhnnss_" プレフィックスを外してから判定する。
const INLINE_IMAGE_NAME = /^image\d+\.(png|jpe?g|gif)$/i;
function stripMailPrefix(fileName) {
  return String(fileName || '').replace(/^\d{8}_\d{6}_/, '');
}

// 戻り値: { skip: bool, reason: string|null }
//
// 除外条件は2つ:
//   (1) メール埋込画像の命名 (imageNNN.png 等) — 署名のロゴ/バナーはこの名前になる。
//       実際の図面は PDF か実名の画像で届くため、この命名は署名画像とみなす。
//       （万一これで本物の図面を弾いても skipped フォルダに退避され後から救済できる）
//   (2) 画素サイズが小さい — imageNNN 以外の名前でもロゴ/アイコンは小さいので拾う。
// バイトサイズは主判定に使わない（線画の図面は画素が大きくてもバイトが小さいことがあり、
// バイトで切ると本物の図面を誤除外してしまうため）。寸法が読めない時だけバイトで代替判定する。
async function classifyNonWorkImage(filePath, fileName, sizeBytes, cfg) {
  const minDim = cfg.minImageDimension || 500;
  const minBytes = cfg.minImageBytes || 50 * 1024;

  if (cfg.skipInlineImageNames !== false && INLINE_IMAGE_NAME.test(stripMailPrefix(fileName))) {
    return { skip: true, reason: `メール埋込画像の命名(${stripMailPrefix(fileName)}) 署名/ロゴと判断` };
  }

  try {
    const meta = await sharp(filePath).metadata();
    const maxDim = Math.max(meta.width || 0, meta.height || 0);
    if (maxDim > 0) {
      if (maxDim < minDim) {
        return { skip: true, reason: `小さい画像 ${meta.width}x${meta.height}(<${minDim}px) 署名/ロゴと判断` };
      }
      return { skip: false, reason: null }; // 十分大きい＝図面とみなし、バイトが小さい線画でも通す
    }
  } catch (e) {
    // 寸法が読めない場合のみ、下のバイトサイズで代替判定する
  }
  if (sizeBytes < minBytes) {
    return { skip: true, reason: `小さすぎる画像 ${Math.round(sizeBytes / 1024)}KB(<${Math.round(minBytes / 1024)}KB) 署名/ロゴと判断` };
  }
  return { skip: false, reason: null };
}

module.exports = { classifyNonWorkImage };
