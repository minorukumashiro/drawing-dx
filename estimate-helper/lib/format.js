function pad(s, w) {
  s = String(s == null ? '' : s);
  if (s.length >= w) return s.slice(0, w - 1) + '…';
  return s + ' '.repeat(w - s.length);
}

function yen(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

const SOURCE_LABEL = {
  'drawing-dx': '図面DX',
  'yayoi-customer': '弥生:得意先',
  'yayoi-supplier': '弥生:仕入先'
};

function printResultsTable(results) {
  const cols = [
    ['score', 'score', 6], ['出所', 'srcLabel', 12], ['得意先', 'client', 18],
    ['材質', 'material', 10], ['径/サイズ', 'sizeRaw', 16], ['数量', 'qty', 6],
    ['単価', 'unitPriceLabel', 12], ['日付', 'date', 11], ['品名/摘要', 'name', 24], ['マッチ理由', 'reasonsLabel', 30]
  ];
  const header = cols.map(([label, , w]) => pad(label, w)).join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  results.forEach((r) => {
    const row = {
      score: r.score,
      srcLabel: SOURCE_LABEL[r.source] || r.source,
      client: r.client,
      material: r.material || '-',
      sizeRaw: r.sizeRaw || '-',
      qty: r.qty == null ? '-' : r.qty,
      unitPriceLabel: yen(r.unitPrice),
      date: r.date || '-',
      name: r.name,
      reasonsLabel: (r.reasons || []).join('・')
    };
    console.log(cols.map(([, key, w]) => pad(row[key], w)).join(' '));
  });
}

function printStats(stats, label) {
  if (!stats) {
    console.log(`${label}: 単価が分かるデータがありませんでした`);
    return;
  }
  console.log(
    `${label}: 件数${stats.count} / 平均${yen(stats.avg)} / 中央値${yen(stats.median)} / ` +
    `最安${yen(stats.min)} / 最高${yen(stats.max)}`
  );
}

module.exports = { printResultsTable, printStats, yen };
