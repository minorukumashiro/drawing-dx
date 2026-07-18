const fs = require('fs');
const path = require('path');

// mail-inbox配下 / fax共有配下を1階層だけ列挙する（processedサブフォルダは除外）。
// フォルダが存在しない/読めない場合は空配列を返す（FAX共有の一時的な切断などに耐える）。
// knownNames: 既に処理済み/ベースライン済みのファイル名集合。渡された場合、該当ファイルは
// stat自体を省略する（数千ファイルのSMB共有ではstatが走査時間の大半を占めるため）。
function listCandidates(dirPath, source, processedDirName, knownNames) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    console.warn(`[scan] フォルダを読み込めません (${source}): ${dirPath} - ${e.message}`);
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (ent.isDirectory()) continue; // processedサブフォルダ等は無視
    if (processedDirName && ent.name === processedDirName) continue;
    if (knownNames && knownNames.has(ent.name)) continue; // 処理済み: stat省略
    const filePath = path.join(dirPath, ent.name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue;
    }
    out.push({
      source,
      filePath,
      fileName: ent.name,
      ext: path.extname(ent.name).toLowerCase(),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs)
    });
  }
  return out;
}

function dedupKey(item) {
  if (item.source === 'mail') {
    // メール添付は同名ファイルが再送されるケースもあるためサイズ+更新時刻も含める
    return `mail:${item.fileName}|${item.size}|${item.mtimeMs}`;
  }
  // FAXはファイル名に送信元番号+タイムスタンプが入るため名前+サイズで十分一意
  return `fax:${item.fileName}|${item.size}`;
}

module.exports = { listCandidates, dedupKey };
