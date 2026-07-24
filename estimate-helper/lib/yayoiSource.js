// 弥生販売25「元帳印刷」画面の「エクスポート」で出力される得意先元帳/仕入先元帳のテキスト(CSV)を
// 読み込み、共通の record 形式に正規化する。
//
// 実データ(Shimt.txt = 仕入先元帳の実エクスポート, 2026-07-24確認)で判明した形式:
//  - 拡張子は .txt（カンマ区切り・全フィールドダブルクォート囲み）
//  - 文字コードは Shift_JIS(cp932)
//  - 見出し行は無い。1行=1明細（またはメモ/入金/税等の1行）で、列位置が固定
//  - 1ファイル = 1取引先（得意先/仕入先を1社ずつ指定してエクスポートする運用）。
//    ただし各行にも取引先名がそのまま入っているため、ファイル名には依存しない
//  - 列位置は以下（0始まり。config.json の yayoiFieldIndex で上書き可能）:
//      3  日付       (YYYYMMDD。例 "20090220")
//      4  伝票番号   （年度で振り直されるため、単独では一意にならない点に注意）
//      5  伝票種別   ("14"=仕入伝票、"24"=売上伝票、"13"=仕入先への支払伝票、"23"=得意先からの入金伝票。
//                      商品/取引の実明細が乗るのは"14"/"24"の伝票のみ)
//      10 取引先コード
//      13 明細行番号
//      14 行区分     （伝票種別ごとに意味が変わる。仕入/売上伝票(14/24)では "1"=商品明細行、
//                      "99"=消費税。支払/入金伝票(13/23)では "1"〜"5"が現金/振込/手数料/相殺等を表す
//                      —つまり行区分だけでは実績行かどうか判定できず、伝票種別(5)と組み合わせる必要がある）
//      17 摘要        （品名・仕様。ここに材質記号やφ径が入っていることが多い）
//      19 単位
//      23 数量
//      24 単価
//      25 金額
//      30 見積番号   （入っていれば）
//      39 取引先名   （フルネーム。得意先元帳はさらに住所等が後ろに続く）
//
// 伝票種別(5)が仕入/売上伝票("14"/"24")、かつ行区分(14)が"1"、かつ金額(25)が正の行だけを
// 実績データとして採用する。support: 最初は行区分(14)だけで判定していたが、得意先元帳の実データで
// 入金伝票(伝票種別"23")内の「現金 小切手」行が行区分"1"になっており誤って実績扱いされる事故があった
// （2026-07-24確認）。伝票種別を条件に加えて修正済み。
//
// 弥生のバージョン・環境によって列位置がずれる可能性があるため、config.json の
// yayoiFieldIndex で個別に上書きできるようにしてある。実データが手元の想定と違う場合は、
// まず `--no-firestore --json` で生データ(raw配列)を確認し、yayoiFieldIndexを調整すること。

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { extractMaterial, extractDiameterMm } = require('./extract');

// 実績データとして採用しない摘要（値引・手数料・入金等の管理行）
const ADMIN_DESC_RE = /^(値引|御値引|出精|手数料|振込|消費税|相殺|繰越|残高)/;

// 商品/取引の実明細が乗る伝票種別(field5)。仕入伝票="14", 売上伝票="24"。
// 支払伝票="13", 入金伝票="23" はここに含めない（現金・振込・手数料等の管理行のため）
const DEFAULT_ITEM_VOUCHER_KUBUNS = ['14', '24'];

const DEFAULT_FIELD_INDEX = {
  date: 3,
  voucherNo: 4,
  voucherKubun: 5,
  partnerCode: 10,
  lineNo: 13,
  lineKubun: 14,
  description: 17,
  unit: 19,
  quantity: 23,
  unitPrice: 24,
  amount: 25,
  quoteNo: 30,
  partnerName: 39
};

function normalizeDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{6}$/.test(s)) return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`; // 念のため(古い版のYYMMDD形式向け)
  return s || null;
}

function toNumber(raw) {
  const t = String(raw == null ? '' : raw).replace(/[,¥￥\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ダブルクォートCSV1行を配列にする（値の中の "" はエスケープされたダブルクォートとして扱う）
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function readTextRows(filePath, encoding) {
  const buf = fs.readFileSync(filePath);
  let text;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.slice(3).toString('utf8'); // UTF-8 BOM
  } else if (encoding === 'utf8') {
    text = buf.toString('utf8');
  } else {
    const iconv = require('iconv-lite');
    text = iconv.decode(buf, encoding || 'cp932'); // 弥生の元帳エクスポート既定はShift_JIS(cp932)
  }
  return text.split(/\r\n|\n/).filter((l) => l.length > 0).map(parseCsvLine);
}

// index.htmlの弥生得意先突合と同じくExcel(.xlsx)書き出しに対応する可能性も残しておく
// （ヘッダー行「日付」「摘要」等が1行目にある場合のみ簡易対応。基本は上記のテキスト形式を使う）
async function readXlsxRowsAsPlainText(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values || []).map((v) => {
      if (v == null) return '';
      if (typeof v === 'object') return String(v.text || v.result || '');
      return String(v);
    }));
  });
  return rows;
}

async function readRows(filePath, encoding) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx') return readXlsxRowsAsPlainText(filePath);
  return readTextRows(filePath, encoding); // .txt / .csv とも同じ固定位置CSVとして扱う
}

async function loadYayoiFile(fileConfig, fieldIndexOverride, itemVoucherKubuns) {
  const filePath = path.resolve(fileConfig.path);
  if (!fs.existsSync(filePath)) {
    throw new Error(`弥生エクスポートファイルが見つかりません: ${filePath}`);
  }
  const type = fileConfig.type === 'supplier' ? 'supplier' : 'customer';
  const source = type === 'supplier' ? 'yayoi-supplier' : 'yayoi-customer';
  const FI = Object.assign({}, DEFAULT_FIELD_INDEX, fieldIndexOverride || {});
  const itemVouchers = itemVoucherKubuns || DEFAULT_ITEM_VOUCHER_KUBUNS;

  const rows = await readRows(filePath, fileConfig.encoding);
  if (!rows.length) return { records: [], warning: `データ行が空でした: ${filePath}` };

  const records = [];
  let skippedShort = 0;
  rows.forEach((row, i) => {
    if (row.length <= FI.partnerName) { skippedShort++; return; } // 想定より列が少ない行は無視
    const voucherKubun = String(row[FI.voucherKubun] || '').trim();
    const kubun = String(row[FI.lineKubun] || '').trim();
    const description = String(row[FI.description] || '').trim();
    const amount = toNumber(row[FI.amount]);

    if (itemVouchers.indexOf(voucherKubun) < 0) return; // 支払/入金伝票など、商品明細を含まない伝票は除外
    if (kubun !== '1') return; // 商品/取引明細行のみ対象（税・メモ等は除外）
    if (!description || ADMIN_DESC_RE.test(description)) return;
    if (amount == null || amount <= 0) return; // 値引(マイナス)・金額0のメモ行を除外

    const qty = toNumber(row[FI.quantity]);
    const unitPrice = toNumber(row[FI.unitPrice]);
    const client = String(row[FI.partnerName] || '').trim() || '(不明)';
    const partnerCode = String(row[FI.partnerCode] || '').trim();
    const voucherNo = String(row[FI.voucherNo] || '').trim();
    const lineNo = String(row[FI.lineNo] || '').trim();

    const dateForId = normalizeDate(row[FI.date]) || 'nodate';
    records.push({
      source,
      // 伝票番号+明細行番号+取引先コード+日付から安定したIDを作る（同じ取引はファイルを再エクスポートしても
      // 同じIDになるため、Firestoreへのupsertで重複登録を防げる）。
      // 伝票番号(voucherNo)は年度で振り直される（別年に同じ番号が再利用される）ため、日付も含めないと
      // 別年の別取引が同一IDになって上書き事故になる（実データで確認済み）。
      id: `${source}_${partnerCode || 'na'}_${dateForId}_${voucherNo || 'na'}_${lineNo || i}`,
      partnerCode,
      voucherNo,
      lineNo,
      date: normalizeDate(row[FI.date]),
      client,
      material: extractMaterial(description),
      diameterMm: extractDiameterMm(description),
      sizeRaw: description,
      name: description,
      number: String(row[FI.quoteNo] || '').trim(),
      qty,
      unitPrice: unitPrice != null ? unitPrice : (qty ? amount / qty : null),
      amount,
      status: '',
      raw: row
    });
  });

  const warning = skippedShort > 0 && skippedShort === rows.length
    ? `列数が想定(${FI.partnerName + 1}列以上)に満たない行ばかりでした。config.jsonのyayoiFieldIndexを実データに合わせて確認してください: ${filePath}`
    : null;
  return { records, warning };
}

async function loadYayoiRecords(fileConfigs, fieldIndexOverride, itemVoucherKubuns) {
  const records = [];
  const warnings = [];
  for (const fc of fileConfigs || []) {
    try {
      const { records: recs, warning } = await loadYayoiFile(fc, fieldIndexOverride, itemVoucherKubuns);
      records.push(...recs);
      if (warning) warnings.push(warning);
    } catch (e) {
      warnings.push(`${fc.path}: ${e.message}`);
    }
  }
  return { records, warnings };
}

module.exports = { loadYayoiFile, loadYayoiRecords, DEFAULT_FIELD_INDEX, DEFAULT_ITEM_VOUCHER_KUBUNS };
