// 図面DXプラットフォーム — メール添付・FAX受信 自動取込ウォッチャー
// Windows タスクスケジューラから定期的に (`node index.js`) 起動される想定。
// 1回の起動で「取り込むべき新着ファイルがあるか」を確認し、あれば処理して終了する。
// 平日日中/平日夜間/休日(祝日)での巡回間隔の切り替えは本スクリプト内で自己判定する
// （タスクスケジューラ側は常に短い間隔で起動してよい）。
const fs = require('fs');
const path = require('path');

const state = require('./lib/state');
const backup = require('./lib/backup');
const { requiredIntervalMinutes } = require('./lib/holidays');
const { listCandidates, dedupKey } = require('./lib/scanFolder');
const { detectNonDrawingDoc } = require('./lib/detectNonDrawing');
const { classifyNonWorkImage } = require('./lib/junkImage');
const fbSync = require('./lib/firestoreSync');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PROCESSED_DIR_NAME = 'processed';
const SKIPPED_DIR_NAME = 'skipped';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `config.json が見つかりません: ${CONFIG_PATH}\n` +
      'config.example.json をコピーして config.json を作成し、環境に合わせて編集してください。'
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function guessDrawingNumber(fileName) {
  const m = fileName.match(/(DWG[-_]?\d+|図番\s*[:：]?\s*([\w\-]+)|[A-Z]{1,3}\d{3,})/i);
  if (!m) return '';
  return m[0].replace(/図番\s*[:：]?\s*/, '');
}

function mailDisplayName(fileName) {
  // ウォッチフォルダ保存時に付与される "yyyymmdd_hhnnss_" 衝突防止プレフィックスを表示名からは除く
  const stripped = fileName.replace(/^\d{8}_\d{6}_/, '');
  return stripped.replace(/\.[^.]+$/, '');
}

// FAXファイル名 "<送信元>_<YYYYMMDD>_<HHMMSS>.pdf" から表示名と日付を推測する。
// 送信元は番号のほか「ソウシンモトフメイ」「9999 99」等の不明表記も来るため整形する。
function faxNameAndDate(fileName) {
  const m = fileName.match(/^(.+?)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return { name: fileName.replace(/\.[^.]+$/, ''), date: todayJst() };
  const [, sender, y, mo, d, hh, mm] = m;
  let label;
  if (/^\d+$/.test(sender)) label = sender; // 通常のFAX番号
  else if (/ソウシンモトフメイ|^[9\s]+$/.test(sender)) label = '送信元不明';
  else label = sender; // その他の文字列はそのまま（意味のある名前の可能性）
  return {
    name: `FAX受信 (${label}) ${y}-${mo}-${d} ${hh}:${mm}`,
    date: `${y}-${mo}-${d}`
  };
}

function todayJst() {
  return new Date().toISOString().slice(0, 10);
}

function buildDrawingMeta(id, item) {
  const isFax = item.source === 'fax';
  let name, date;
  if (isFax) {
    ({ name, date } = faxNameAndDate(item.fileName));
  } else {
    name = mailDisplayName(item.fileName) || item.fileName;
    date = todayJst();
  }
  const number = isFax ? '' : guessDrawingNumber(item.fileName);
  const tags = [isFax ? 'FAX取込' : 'メール取込'];
  if (item.oversized) tags.push('サイズ超過:元ファイル要確認');
  // ファイル名から注文書/納品書/見積書らしさを判定してタグ付け（除外はしない=手動振り分けの目印）
  const docKind = detectNonDrawingDoc(item.fileName);
  if (docKind) tags.push(docKind);

  return {
    id,
    number: number || ('DWG-' + String(id).padStart(4, '0')),
    name,
    cat: '未指定',
    mat: '未指定',
    size: '未指定',
    client: '未指定',
    price: 0,
    date,
    tags,
    shape: 'plate',
    status: '待機',
    priority: '中',
    scanned: true,
    imgVer: Date.now()
  };
}

async function processOne(db, item, cfg) {
  const id = await fbSync.reserveIds(db, 1);
  const { doc, oversized } = await fbSync.buildImageDoc(item.filePath, item.ext, cfg.maxImageBytes);
  await fbSync.uploadImageDoc(db, id, doc);
  item.oversized = oversized;
  const meta = buildDrawingMeta(id, item);
  await fbSync.appendDrawings(db, [meta]);

  // ブラウザ側の全体上書き同期(1.5秒デバウンス+3秒エコー抑制)との競合で
  // 追加した図面が消されていないかを少し待ってから確認する。
  await new Promise((r) => setTimeout(r, cfg.verifyDelaySeconds * 1000));
  let present = await fbSync.fetchPresentIds(db, [id]);
  if (present.length === 0) {
    log(`⚠ id=${id} (${item.fileName}) が同期直後に消えていたため再登録します`);
    await fbSync.appendDrawings(db, [meta]);
    await new Promise((r) => setTimeout(r, cfg.verifyDelaySeconds * 1000));
    present = await fbSync.fetchPresentIds(db, [id]);
  }
  return { id, verified: present.length > 0, meta };
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// 1日1回、Firestore全データをNASへバックアップする（config.backup 未設定なら何もしない）。
// 成否を返す（healthに記録し、アプリ側で失敗バナーを出せるようにする）。
async function maybeRunBackup(cfg, st) {
  if (!cfg.backup || !cfg.backup.dir) return true;
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (JST)
  if (st.lastBackupDate === today) return true;
  try {
    const db = fbSync.initFirestore(cfg.firebase.serviceAccountKeyPath);
    await backup.runBackup(db, cfg, st, log);
    st.lastBackupDate = today;
    state.save(st);
    return true;
  } catch (e) {
    log(`⚠ バックアップ失敗: ${e.message}`);
    return false;
  }
}

// 実行結果を Firestore の watcher_health に記録する（失敗しても本処理には影響させない）
async function reportHealth(cfg, payload) {
  try {
    const db = fbSync.initFirestore(cfg.firebase.serviceAccountKeyPath);
    await fbSync.writeHealth(db, payload);
  } catch (e) {
    log(`health書き込み失敗(無視): ${e.message}`);
  }
}

async function main() {
  const cfg = loadConfig();
  const st = state.load();
  const now = new Date();

  if (st.lastRun) {
    const elapsedMin = (now - new Date(st.lastRun)) / 60000;
    const needMin = requiredIntervalMinutes(now, cfg);
    if (elapsedMin < needMin) {
      log(`巡回間隔未到達のためスキップ (前回から${elapsedMin.toFixed(1)}分 / 必要間隔${needMin}分)`);
      return;
    }
  }

  log('取込チェック開始');

  // state整理: mail:エントリは処理時にファイルを processed/ へ移動済みのため90日経過分は安全に削除できる。
  // fax:エントリは共有フォルダに元ファイルが残り続けるため、削除すると再取込されてしまう→保持する。
  {
    const cutoff = now.getTime() - 90 * 24 * 3600 * 1000;
    let pruned = 0;
    for (const k of Object.keys(st.processed)) {
      const v = st.processed[k];
      if (k.startsWith('mail:') && v && v.at && new Date(v.at).getTime() < cutoff) { delete st.processed[k]; pruned++; }
    }
    if (pruned > 0) log(`state整理: 90日経過したメール処理記録 ${pruned} 件を削除`);
  }

  // 監視フォルダの到達性（Outlook保存先・FAX共有の切断検知用。healthに記録しアプリ側で警告表示）
  const mailFolderOk = fs.existsSync(cfg.sources.mailInboxFolder);
  const faxFolderOk = fs.existsSync(cfg.sources.faxFolder);
  if (!mailFolderOk) log(`⚠ メール監視フォルダに到達できません: ${cfg.sources.mailInboxFolder}`);
  if (!faxFolderOk) log(`⚠ FAX共有フォルダに到達できません: ${cfg.sources.faxFolder}`);

  const mailItems = listCandidates(cfg.sources.mailInboxFolder, 'mail', PROCESSED_DIR_NAME);
  // FAXは処理済み・ベースライン済みのファイル名を state から集めて stat を省略する
  // （8千件超のSMB共有では stat が走査時間の大半を占めるため。キーは "fax:<name>|<size>" 形式）。
  // 同名別サイズの再送は取りこぼすが、FAXファイル名にはタイムスタンプが入るため実質衝突しない。
  const knownFaxNames = new Set(
    Object.keys(st.processed)
      .filter((k) => k.startsWith('fax:'))
      .map((k) => k.slice(4, k.lastIndexOf('|')))
  );
  const faxItems = listCandidates(cfg.sources.faxFolder, 'fax', PROCESSED_DIR_NAME, st.faxBaselineSeeded ? knownFaxNames : null);

  // FAX共有フォルダには導入以前からの大量の過去ファイルが蓄積されているため、
  // 初回実行時はそれらを「待機」へ一括登録せず、既存分をベースラインとして記録するだけにする。
  // 以降の実行では、このベースライン以降に現れた新着FAXのみが取込対象になる。
  if (!st.faxBaselineSeeded) {
    for (const item of faxItems) {
      const key = dedupKey(item);
      if (!st.processed[key]) st.processed[key] = { baseline: true, at: now.toISOString() };
    }
    st.faxBaselineSeeded = true;
    log(`FAX共有フォルダの既存ファイル ${faxItems.length} 件をベースラインとして記録しました（今回は取り込まず、次回以降の新着分のみ取り込みます）`);
    state.save(st);
  }

  const allItems = mailItems.concat(faxItems);

  const allowed = new Set(cfg.allowedExtensions.map((e) => e.toLowerCase()));
  const candidates = [];
  for (const item of allItems) {
    if (!allowed.has(item.ext)) continue;
    const key = dedupKey(item);
    if (st.processed[key]) continue; // 処理済み
    if (cfg.excludeNonDrawingDocsByFilename) {
      const kind = detectNonDrawingDoc(item.fileName);
      if (kind) {
        log(`除外(${kind}と判定): ${item.fileName}`);
        st.processed[key] = { skipped: kind, at: now.toISOString() };
        continue;
      }
    }
    // メール署名のロゴ・アイコン等「仕事に不要な小さい画像」を除外（サイズで判定）
    if (cfg.skipNonWorkImages !== false && IMAGE_EXTS.has(item.ext)) {
      const cls = await classifyNonWorkImage(item.filePath, item.fileName, item.size, cfg);
      if (cls.skip) {
        log(`除外(${cls.reason}): ${item.fileName}`);
        st.processed[key] = { skippedNonWork: cls.reason, at: now.toISOString() };
        // 誤判定時に後から確認・救済できるよう、除外したメール画像は skipped フォルダへ退避する
        if (item.source === 'mail') {
          const skDir = path.join(cfg.sources.mailInboxFolder, SKIPPED_DIR_NAME);
          ensureDir(skDir);
          try { fs.renameSync(item.filePath, path.join(skDir, item.fileName)); } catch (e) { log(`退避失敗(無視): ${item.fileName} - ${e.message}`); }
        }
        continue;
      }
    }
    candidates.push({ item, key });
  }
  state.save(st); // 上のループで付けた除外マークを確定保存

  if (candidates.length === 0) {
    log('新規ファイルなし');
    st.lastRun = now.toISOString();
    state.save(st);
    const backupOk = await maybeRunBackup(cfg, st);
    await reportHealth(cfg, { lastRunAt: now.toISOString(), lastSuccessAt: now.toISOString(), okCount: 0, ngCount: 0, lastError: null, mailFolderOk: mailFolderOk, faxFolderOk: faxFolderOk, backupOk: backupOk });
    return;
  }

  log(`新規ファイル ${candidates.length} 件を処理します`);
  const db = fbSync.initFirestore(cfg.firebase.serviceAccountKeyPath);

  ensureDir(path.join(cfg.sources.mailInboxFolder, PROCESSED_DIR_NAME));

  let okCount = 0, ngCount = 0;
  for (const { item, key } of candidates) {
    try {
      const result = await processOne(db, item, cfg);
      if (result.verified) {
        st.processed[key] = { drawingId: result.id, at: now.toISOString() };
        if (item.source === 'mail') {
          const dest = path.join(cfg.sources.mailInboxFolder, PROCESSED_DIR_NAME, item.fileName);
          try { fs.renameSync(item.filePath, dest); } catch (e) { log(`移動失敗(無視): ${item.fileName} - ${e.message}`); }
        }
        // FAXは共有フォルダ側のファイルには触れない（stateで処理済み管理のみ）
        log(`✓ 登録完了 id=${result.id} [${item.source}] ${item.fileName} -> ${result.meta.name}`);
        okCount++;
      } else {
        log(`✗ 未確定のため次回再試行: ${item.fileName} (id=${result.id})`);
        ngCount++;
      }
    } catch (e) {
      log(`✗ 処理失敗: ${item.fileName} - ${e.message}`);
      ngCount++;
    }
    state.save(st); // 1件ごとに保存し、途中失敗しても進捗を失わない
  }

  st.lastRun = now.toISOString();
  state.save(st);
  log(`完了: 成功${okCount}件 / 失敗・再試行待ち${ngCount}件`);
  const backupOk = await maybeRunBackup(cfg, st);
  await reportHealth(cfg, { lastRunAt: now.toISOString(), lastSuccessAt: now.toISOString(), okCount: okCount, ngCount: ngCount, lastError: null, mailFolderOk: mailFolderOk, faxFolderOk: faxFolderOk, backupOk: backupOk });
}

main().catch(async (e) => {
  console.error('致命的エラー:', e);
  // 異常終了もFirestoreに記録し、アプリ側で「自動取込エラー」バナーを出せるようにする
  // （lastSuccessAtはmergeで保持されるため、ここではlastRunAtとlastErrorのみ更新）
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    await reportHealth(cfg, { lastRunAt: new Date().toISOString(), lastError: String(e && e.message || e) });
  } catch (e2) { /* 設定すら読めない場合は諦める（run.logには残る） */ }
  process.exit(1);
});
