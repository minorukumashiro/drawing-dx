// Run: $env:PDF_LIB_PATH='<path to pdf-lib@1.17.1>'; node --test tests/scan-import.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFLib = require(process.env.PDF_LIB_PATH || 'pdf-lib');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function section(text, start, end) { return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start))); }
const helper = section(html, 'async function splitScanPdf(', 'function openBulkRegister(');
const detector = section(html, 'function detectNonDrawingDoc(', 'function saveDwg(');
function harness(overrides = {}) {
  const S = { bulkItems: [], bulkOpen: true };
  const DRAWINGS = [], scannedPdfs = {}, scannedImages = {}, pdfThumbnails = {};
  let input, id = 0;
  const alerts = [];
  const document = {
    createElement() { return input = { style: {}, click() {} }; },
    body: { appendChild() {}, removeChild() {}, contains() { return true; } },
    getElementById() { return null; }
  };
  class FileReader {
    readAsDataURL(file) {
      file.arrayBuffer().then(b => this.onload({ target: { result: 'data:'+file.type+';base64,'+Buffer.from(b).toString('base64') } }));
    }
  }
  const deps = { PDFLib, File, S, DRAWINGS, scannedPdfs, scannedImages, pdfThumbnails,
    document, FileReader, alert: msg => alerts.push(msg), confirm: () => true,
    render() {}, bulkLoadPreview() {}, saveAll() {}, allocDrawingId: () => ++id,
    URL, ocrFromPdf() {}, runOCR() {},
    closeReg() { S.regReadToken++; S.regOpen=false; },
    openBulkRegister() { S.bulkOpen=true; S.bulkItems=[]; },
    MASTERS: { clients: [] }, JSZip: {},
    closeBulkRegister() { S.bulkOpen = false; }, ...overrides };
  const code = helper + detector +
    section(html, 'function bulkPickFiles(', '// === 画像指紋') +
    section(html, 'async function bulkSubmit(', 'function closeReg(') +
    section(html, 'async function processRegisterFile(', 'function demoSearch(') +
    section(html, 'async function importAlritZip(', '// === BULK REGISTER ===');
  const api = new Function(...Object.keys(deps), code + '\nreturn {splitScanPdf,scanBulkItem,bulkPickFiles,bulkSubmit,detectNonDrawingDoc,processRegisterFile,importAlritZip};')(...Object.values(deps));
  return { ...api, S, DRAWINGS, scannedPdfs, alerts, async pick(files) {
    api.bulkPickFiles();
    const change = input.onchange;
    await change({ target: { files } });
  } };
}
async function pdfFile(count, name = 'DWG-123_scan.pdf') {
  const doc = await PDFLib.PDFDocument.create();
  for (let i=0; i<count; i++) {
    const page = doc.addPage([300+i*100, 500+i*100]);
    page.setRotation(PDFLib.degrees(i*90));
    page.drawText('Drawing page '+(i+1));
  }
  return new File([await doc.save()], name, { type: 'application/pdf', lastModified: 1234 });
}
test('multiple pages retain PDF geometry/rotation and register as distinct waiting drawings', async () => {
  const h = harness();
  await h.pick([await pdfFile(3)]);
  assert.equal(h.S.bulkSelected, 3);
  assert.deepEqual(h.S.bulkItems.map(it=>it.name), ['DWG-123_scan_p1.pdf','DWG-123_scan_p2.pdf','DWG-123_scan_p3.pdf']);
  for (const [i,it] of h.S.bulkItems.entries()) {
    const doc = await PDFLib.PDFDocument.load(await it.file.arrayBuffer());
    assert.equal(doc.getPageCount(), 1);
    assert.equal(doc.getPage(0).getWidth(), 300+i*100);
    assert.equal(doc.getPage(0).getRotation().angle, i*90);
    assert.equal(it.status, '待機');
    assert.equal(it.number, '');
  }
  await h.bulkSubmit();
  assert.equal(h.DRAWINGS.length, 3);
  assert.equal(new Set(h.DRAWINGS.map(d=>d.number)).size, 3);
  for (const d of h.DRAWINGS) {
    assert.equal(d.status, '待機');
    const saved = await PDFLib.PDFDocument.load(Buffer.from(h.scannedPdfs[d.id].split(',')[1], 'base64'));
    assert.equal(saved.getPageCount(), 1);
  }
});
test('single-page PDF and image keep original bytes, names and number inference', async () => {
  const h = harness();
  const single = await pdfFile(1);
  const image = new File(['image'], 'part.png', { type:'image/png' });
  await h.pick([single, image]);
  assert.equal(h.S.bulkItems[0].file, single);
  assert.equal(h.S.bulkItems[0].number, 'DWG-123');
  assert.equal(h.S.bulkItems[1].file, image);
  await h.bulkSubmit();
  assert.equal(h.scannedPdfs[1], 'data:application/pdf;base64,'+Buffer.from(await single.arrayBuffer()).toString('base64'));
});
test('existing document exclusion runs before PDF parsing; bad PDF does not block other files', async () => {
  const h = harness();
  await h.pick(['注文書.pdf','納品書.pdf','見積書.pdf','broken.pdf'].map(name=>new File(['bad'],name)).concat(await pdfFile(2)));
  assert.equal(h.S.bulkItems.length, 2);
  assert.equal(h.alerts.length, 2);
  assert.match(h.alerts[0], /broken.pdf/);
  assert.match(h.alerts[1], /注文書.*納品書.*見積書/s);
});
test('missing library fails explicitly, while image import remains available', async () => {
  const h = harness({ PDFLib: undefined });
  await h.pick([await pdfFile(2), new File(['img'],'image.png')]);
  assert.equal(h.S.bulkItems.length, 1);
  assert.match(h.alerts[0], /ライブラリ/);
});
test('closing modal during processing discards pending import', async () => {
  const h = harness();
  const file = await pdfFile(2);
  const pending = h.pick([file]);
  h.S.bulkOpen = false;
  await pending;
  assert.equal(h.S.bulkItems.length, 0);
});
test('ZIP keeps original multipage PDF, excludes documents and ignores other folders', async () => {
  const file = await pdfFile(3);
  const paths = ['drawing/ABC123.pdf','drawing/注文書.pdf','drawing/納品書.pdf','drawing/見積書.pdf','other/part.pdf'];
  const h = harness({ JSZip: { async loadAsync() { return { forEach(cb) {
    paths.forEach(p=>cb(p,{ dir:false, async async() { return file; } }));
  } }; } } });
  await h.importAlritZip({target:{files:[file],value:'zip'}});
  assert.equal(h.S.bulkItems.length,1);
  assert.equal(h.S.bulkItems[0].name,'ABC123.pdf');
  const doc = await PDFLib.PDFDocument.load(await h.S.bulkItems[0].file.arrayBuffer());
  assert.equal(doc.getPageCount(),3);
});
test('scan registration routes multipage PDF to waiting bulk items', async () => {
  const h = harness();
  h.S.regOpen=true;
  await h.processRegisterFile(await pdfFile(2));
  assert.equal(h.S.regOpen,false);
  assert.equal(h.S.bulkItems.length,2);
  assert.ok(h.S.bulkItems.every(it=>it.status==='待機'));
});
test('scan registration keeps single-page OCR flow and excludes document names', async () => {
  let called=0;
  const h=harness({ocrFromPdf(){called++;}});
  h.S.regOpen=true;
  const single=await pdfFile(1);
  await h.processRegisterFile(single);
  await new Promise(r=>setTimeout(r,0));
  assert.equal(called,1);
  assert.equal(h.S.regFileObj,single);
  assert.equal(h.S.regOpen,true);
  assert.equal(h.S.bulkItems.length,0);
  await h.processRegisterFile(new File(['bad'],'注文書.pdf'));
  assert.match(h.alerts[0],/除外/);
  assert.equal(called,1);
});
test('all inline scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
});
