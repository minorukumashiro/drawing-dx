#!/usr/bin/env node
// 弥生の元帳エクスポートを自動でFirestore(`yayoiRecords`)へ取り込むウォッチャー。
// タスクスケジューラから定期起動される（auto-import-runner.cmd 経由 / install-auto-import-task.ps1 で登録）。
//
// 背景:
//   弥生販売25には元帳を直接取得するAPIが無く、「元帳印刷」→「エクスポート」のGUI操作が必要。
//   従来はそのあと手で `node bin/import-to-firestore.js` を叩く運用だったため、叩き忘れると
//   図面DXの「💰 類似実績検索」が古い単価のまま古い実績しか出さない状態になっていた。
//   このスクリプトはエクスポート先フォルダを見張り、ファイルが更新されたら自動で取り込む。
//   （弥生のGUIでエクスポートする操作だけは人が行う。それ以降は無人化される）
//
// 動作:
//   1. config.autoImport.watchFolders のフォルダを走査し、得意先元帳/仕入先元帳のファイル名
//      パターンに一致するファイルを集める
//   2. 前回実行時のサイズ・更新日時（state.json）と比較して、新規・更新されたものだけを対象にする
//   3. 対象ファイルを archiveFolder へタイムスタンプ付きでコピーしてから取り込む
//      （弥生は同じファイル名に上書きエクスポートするため、取引先を変えて連続エクスポートすると
//        前の内容が消える。アーカイブしておけば後から再取込できる）
//   4. lib/importer.js でFirestoreへupsert（IDが安定しているので再取込しても重複しない）
//   5. 成功したファイルだけ state を更新する（失敗したものは次回自動で再試行される）
//
// 使い方:
//   node bin/auto-import.js              変更があれば取り込む（タスクスケジューラ用）
//   node bin/auto-import.js --dry-run    取り込まずに、対象ファイルと件数だけ確認する
//   node bin/auto-import.js --force      変更が無くても全ファイルを取り込む

const fs = require('fs');
const path = require('path');

const { importYayoiFiles, loadConfig } = require('../lib/importer');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  archiveFolder: 'data/archive',
  archiveKeep: 60,
  archiveMaxTotalMB: 1000,
  stateFile: 'data/auto-import-state.json',
  settleSeconds: 60,   // 直近まで書き込まれているファイルは書きかけの可能性があるので次回に回す
  minFileBytes: 100    // 空・ヘッダのみのエクスポート事故を取り込まないための下限
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, config: null };
  argv.forEach((a) => {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
  });
  return args;
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function readState(stateFilePath) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch (e) {
    return { files: {}, lastRunAt: null, lastImportAt: null };
  }
}

function writeState(stateFilePath, state) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

// 監視フォルダを走査し、得意先/仕入先のパターンに一致するファイルを {path, type, stat} で返す。
function scanWatchFolders(watchFolders) {
  const found = [];
  (watchFolders || []).forEach((wf) => {
    const dir = wf.path;
    if (!fs.existsSync(dir)) {
      log(`警告: 監視フォルダが存在しません: ${dir}`);
      return;
    }
    const customerRe = new RegExp(wf.customerPattern || '^Tokmt.*\\.txt$', 'i');
    const supplierRe = new RegExp(wf.supplierPattern || '^Shimt.*\\.txt$', 'i');
    fs.readdirSync(dir).forEach((name) => {
      const type = customerRe.test(name) ? 'customer' : (supplierRe.test(name) ? 'supplier' : null);
      if (!type) return;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        return;
      }
      if (!stat.isFile()) return;
      found.push({ path: full, type, size: stat.size, mtimeMs: stat.mtimeMs, encoding: wf.encoding });
    });
  });
  return found;
}

function timestampForFilename(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 弥生は同じファイル名に上書きエクスポートするため、取り込む前にスナップショットを退避する。
function archiveFile(file, archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const base = path.basename(file.path, path.extname(file.path)).replace(/[\\/:*?"<>|]/g, '_');
  const dest = path.join(archiveDir, `${file.type}_${base}_${timestampForFilename(new Date(file.mtimeMs))}.txt`);
  if (!fs.existsSync(dest)) fs.copyFileSync(file.path, dest);
  return dest;
}

// アーカイブが無制限に増えないよう、新しい方から keep 件かつ合計 maxTotalMB までを残す。
// 得意先元帳の全社分エクスポートは1ファイル50MB超になるため、件数だけでは容量を抑えられない。
function pruneArchive(archiveDir, keep, maxTotalMB) {
  if (!fs.existsSync(archiveDir)) return 0;
  const entries = fs.readdirSync(archiveDir)
    .map((name) => {
      const full = path.join(archiveDir, name);
      try {
        const st = fs.statSync(full);
        return { full, mtimeMs: st.mtimeMs, size: st.size };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const maxTotalBytes = maxTotalMB > 0 ? maxTotalMB * 1024 * 1024 : Infinity;
  let running = 0;
  const doomed = [];
  entries.forEach((e, i) => {
    running += e.size;
    // 最新の1件だけは、単体でサイズ上限を超えていても消さずに残す（再取込の最後の砦）
    const overCount = keep > 0 && i >= keep;
    const overSize = i > 0 && running > maxTotalBytes;
    if (overCount || overSize) doomed.push(e);
  });

  let removed = 0;
  doomed.forEach((e) => {
    try {
      fs.unlinkSync(e.full);
      removed += 1;
    } catch (err) { /* 消せなくても実害は無いので次回に回す */ }
  });
  return removed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const ai = Object.assign({}, DEFAULTS, config.autoImport || {});

  if (!ai.watchFolders || !ai.watchFolders.length) {
    throw new Error('config.json に autoImport.watchFolders が設定されていません（config.example.json を参照）。');
  }

  const stateFilePath = resolveFromRoot(ai.stateFile);
  const archiveDir = resolveFromRoot(ai.archiveFolder);
  const state = readState(stateFilePath);
  state.files = state.files || {};

  const found = scanWatchFolders(ai.watchFolders);
  const now = Date.now();
  const targets = [];
  const skipped = [];

  found.forEach((f) => {
    if (f.size < ai.minFileBytes) {
      skipped.push(`${path.basename(f.path)}: サイズが${f.size}バイトしかないため無視`);
      return;
    }
    if (now - f.mtimeMs < ai.settleSeconds * 1000) {
      skipped.push(`${path.basename(f.path)}: 更新直後のため次回に回す（書き込み中の可能性）`);
      return;
    }
    const prev = state.files[f.path];
    const changed = !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
    if (changed || args.force) targets.push(f);
  });

  state.lastRunAt = new Date().toISOString();

  if (!targets.length) {
    skipped.forEach((s) => log(s));
    log(`変更なし（監視対象 ${found.length} ファイル）。何もせず終了します。`);
    if (!args.dryRun) writeState(stateFilePath, state);
    return;
  }

  skipped.forEach((s) => log(s));
  log(`更新を検出: ${targets.length}件 → ${targets.map((t) => path.basename(t.path)).join(', ')}`);

  let totalRead = 0;
  let totalWritten = 0;
  let failed = 0;

  // ファイル単位で取り込む。1ファイルが壊れていても他のファイルの取込は進める。
  for (const f of targets) {
    const label = `${path.basename(f.path)} [${f.type}]`;
    try {
      if (!args.dryRun) {
        const archived = archiveFile(f, archiveDir);
        log(`  アーカイブ: ${path.basename(archived)}`);
      }
      const result = await importYayoiFiles({
        config,
        files: [{ path: f.path, type: f.type, encoding: f.encoding }],
        dryRun: args.dryRun,
        log: (m) => log(`  ${m}`),
        logError: (m) => log(`  ${m}`)
      });
      totalRead += result.read;
      totalWritten += result.written;
      if (!args.dryRun) {
        state.files[f.path] = {
          size: f.size,
          mtimeMs: f.mtimeMs,
          type: f.type,
          importedAt: new Date().toISOString(),
          records: result.read
        };
        state.lastImportAt = state.files[f.path].importedAt;
      }
      log(`✓ ${label}: 読込${result.read}件 / 書込${result.written}件`);
    } catch (e) {
      failed += 1;
      log(`✗ ${label}: ${e.message}（state を更新しないので次回自動で再試行します）`);
    }
  }

  if (!args.dryRun) {
    writeState(stateFilePath, state);
    const removed = pruneArchive(archiveDir, ai.archiveKeep, ai.archiveMaxTotalMB);
    if (removed) log(`アーカイブを${removed}件整理しました（最大${ai.archiveKeep}件 / 合計${ai.archiveMaxTotalMB}MBまで保持）。`);
  }

  log(`完了: 対象${targets.length}ファイル / 読込${totalRead}件 / 書込${totalWritten}件 / 失敗${failed}件`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  log(`エラー: ${e.message}`);
  process.exit(1);
});
