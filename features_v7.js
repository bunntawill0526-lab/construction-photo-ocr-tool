(() => {
'use strict';

// V7
// - Excelテンプレートから写真枠の表示比率を読み取る
// - その比率に合わせてExcel埋込画像を自動生成（元写真は切らない）
// - Excel出力前のプレビュー

const templateInput = document.getElementById('templateInput');
const templateName = document.getElementById('templateName');
const makeExcelBtn = document.getElementById('makeExcel');
const cardsRoot = document.getElementById('cards');
if (!templateInput || !makeExcelBtn || !cardsRoot) return;

const EXPECTED_STATUS_ROWS = [14,33,52,71,91,110,129,148,168,187,206,225,245,264,283,302,322,341,360,379];
const FALLBACK_RATIO = 376 / 306;
window.PhotoBookTemplateMeta = window.PhotoBookTemplateMeta || {
  frameRatio: FALLBACK_RATIO,
  widthPx: 376,
  heightPx: 306,
  slotCount: 20,
  statusRows: [...EXPECTED_STATUS_ROWS],
  source: 'fallback'
};

function xmlDoc(s){ return new DOMParser().parseFromString(s, 'application/xml'); }
function colIndex(ref){
  const m = String(ref || '').match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function rowIndex(ref){ const m = String(ref || '').match(/(\d+)$/); return m ? +m[1] : null; }

function excelColWidthToPx(width){
  width = Number(width);
  if (!Number.isFinite(width) || width <= 0) width = 8.43;
  return Math.max(1, Math.floor(width * 7 + 5));
}
function pointsToPx(pt){
  pt = Number(pt);
  if (!Number.isFinite(pt) || pt <= 0) pt = 15;
  return pt * 96 / 72;
}

function sharedStringsFrom(xml){
  if (!xml) return [];
  const doc = xmlDoc(xml);
  return [...doc.querySelectorAll('si')].map(si => [...si.querySelectorAll('t')].map(t => t.textContent || '').join(''));
}
function cellText(c, shared){
  const type = c.getAttribute('t') || '';
  if (type === 'inlineStr') return [...c.querySelectorAll('is t')].map(t => t.textContent || '').join('');
  const v = c.querySelector('v')?.textContent || '';
  if (type === 's') return shared[+v] || '';
  return v;
}

async function analyzeTemplate(file){
  if (!file || !window.JSZip) return;
  const info = ensureTemplateInfo();
  info.textContent = 'テンプレート解析中…';
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const sheetFile = zip.file('xl/worksheets/sheet1.xml');
    if (!sheetFile) throw new Error('sheet1.xml が見つかりません');
    const sheetXml = await sheetFile.async('string');
    const ssFile = zip.file('xl/sharedStrings.xml');
    const shared = ssFile ? sharedStringsFrom(await ssFile.async('string')) : [];
    const doc = xmlDoc(sheetXml);

    const sheetFmt = doc.querySelector('sheetFormatPr');
    const defaultColWidth = +(sheetFmt?.getAttribute('defaultColWidth') || 8.43);
    const defaultRowHeight = +(sheetFmt?.getAttribute('defaultRowHeight') || 15);

    const colWidths = new Map();
    [...doc.querySelectorAll('cols col')].forEach(col => {
      const min = +(col.getAttribute('min') || 1);
      const max = +(col.getAttribute('max') || min);
      const width = +(col.getAttribute('width') || defaultColWidth);
      for (let i=min; i<=max; i++) colWidths.set(i, width);
    });

    const rowHeights = new Map();
    [...doc.querySelectorAll('sheetData row')].forEach(row => {
      const r = +(row.getAttribute('r') || 0);
      const ht = +(row.getAttribute('ht') || defaultRowHeight);
      if (r) rowHeights.set(r, ht);
    });

    const statusRows = [];
    [...doc.querySelectorAll('c')].forEach(c => {
      const txt = cellText(c, shared).normalize('NFKC').replace(/[\s　]+/g,'');
      if (txt === '状態' || txt === '状\u3000態') {
        const r = rowIndex(c.getAttribute('r'));
        if (r) statusRows.push(r);
      }
    });
    const uniqueStatusRows = [...new Set(statusRows)].sort((a,b)=>a-b);
    const rows = uniqueStatusRows.length ? uniqueStatusRows : [...EXPECTED_STATUS_ROWS];

    // 現行テンプレートの写真枠は D:J。列幅・行高はテンプレート実値を使う。
    let widthPx = 0;
    for (let c=4; c<=10; c++) widthPx += excelColWidthToPx(colWidths.get(c) ?? defaultColWidth);

    const sr = rows[0] || 14;
    const topRow = Math.max(1, sr - 11);
    const bottomRow = sr + 5;
    let heightPx = 0;
    for (let r=topRow; r<=bottomRow; r++) heightPx += pointsToPx(rowHeights.get(r) ?? defaultRowHeight);

    let ratio = widthPx / Math.max(1, heightPx);
    if (!Number.isFinite(ratio) || ratio < 0.4 || ratio > 4) ratio = FALLBACK_RATIO;

    const structureOK = rows.length >= 1 && rows[0] === EXPECTED_STATUS_ROWS[0];
    window.PhotoBookTemplateMeta = {
      frameRatio: ratio,
      widthPx,
      heightPx,
      slotCount: rows.length || 20,
      statusRows: rows,
      source: 'template',
      structureOK,
      filename: file.name
    };

    info.textContent = `テンプレート解析済：写真枠 約${Math.round(widthPx)}×${Math.round(heightPx)}px / 比率 ${ratio.toFixed(3)} / ${rows.length || 20}枠${structureOK ? '' : '（標準配置と差あり）'}`;
    info.classList.toggle('v7Warn', !structureOK);
  } catch (e) {
    console.warn('template analysis failed', e);
    window.PhotoBookTemplateMeta = {
      frameRatio: FALLBACK_RATIO,
      widthPx: 376,
      heightPx: 306,
      slotCount: 20,
      statusRows: [...EXPECTED_STATUS_ROWS],
      source: 'fallback'
    };
    info.textContent = 'テンプレート解析に失敗したため標準写真枠で処理します';
    info.classList.add('v7Warn');
  }
}

function ensureTemplateInfo(){
  let info = document.getElementById('v7TemplateInfo');
  if (info) return info;
  info = document.createElement('span');
  info.id = 'v7TemplateInfo';
  info.className = 'muted v7TemplateInfo';
  (templateName || templateInput.closest('label'))?.insertAdjacentElement('afterend', info);
  return info;
}

templateInput.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (file) analyzeTemplate(file);
});

// ---------- Excel埋込画像をテンプレート比率へ自動フィット ----------
// app.jsは一度1600x約830のキャンバスを作る。ここで元写真から描き直し、
// テンプレートの写真枠比率へCONTAINする。写真は一切トリミングしない。
const previousDrawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function(image, ...args){
  const c = this.canvas;
  const isPhotoExport =
    c && image instanceof HTMLCanvasElement && args.length === 8 &&
    c.width === 1600 && c.height >= 825 && c.height <= 835;

  if (!isPhotoExport) return previousDrawImage.call(this, image, ...args);

  const meta = window.PhotoBookTemplateMeta || {};
  const target = Number(meta.frameRatio) || FALLBACK_RATIO;
  const outW = 1600;
  const outH = Math.max(400, Math.round(outW / target));
  const sw = image.width, sh = image.height;
  c.height = outH;
  this.imageSmoothingEnabled = true;
  this.imageSmoothingQuality = 'high';
  this.fillStyle = '#fff';
  this.fillRect(0,0,outW,outH);
  const scale = Math.min(outW / sw, outH / sh);
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const dx = Math.round((outW - dw) / 2), dy = Math.round((outH - dh) / 2);
  return previousDrawImage.call(this, image, 0,0,sw,sh, dx,dy,dw,dh);
};

// V5の回転出力は標準比率帯(高さ1250-1350)を処理する。
// テンプレート比率でその帯を外れた場合だけV7側で回転を補完する。
let v7ExportAngles = [];
let v7ExportAngleIndex = 0;
function cardAngle(card){
  const t = card.querySelector('.thumb')?.style?.transform || '';
  const m = t.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
  if (!m) return 0;
  return ((Math.round(+m[1]) % 360) + 360) % 360;
}
makeExcelBtn.addEventListener('click', () => {
  v7ExportAngles = [...document.querySelectorAll('.card')].map(cardAngle);
  v7ExportAngleIndex = 0;
}, true);

const previousToBlob = HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob = function(callback, type, quality){
  const c = this;
  const target = Number(window.PhotoBookTemplateMeta?.frameRatio) || FALLBACK_RATIO;
  const expectedH = Math.max(400, Math.round(1600 / target));
  const isExcelPhoto = c.width === 1600 && Math.abs(c.height - expectedH) <= 4;
  if (!isExcelPhoto) return previousToBlob.call(c, callback, type, quality);

  // 標準帯はV5が回転処理するので二重回転させない。
  if (c.height >= 1250 && c.height <= 1350) return previousToBlob.call(c, callback, type, quality);

  const angle = v7ExportAngles[v7ExportAngleIndex++] || 0;
  if (!angle) return previousToBlob.call(c, callback, type, quality);

  const W = c.width, H = c.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const x = out.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0,0,W,H);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  const rightAngle = angle % 180 !== 0;
  const rotatedW = rightAngle ? H : W;
  const rotatedH = rightAngle ? W : H;
  const scale = Math.min(W / rotatedW, H / rotatedH);
  x.translate(W/2,H/2);
  x.rotate(angle * Math.PI / 180);
  x.scale(scale,scale);
  x.drawImage(c,-W/2,-H/2);
  return previousToBlob.call(out, callback, type, quality);
};

// ---------- Excel出力プレビュー ----------
function ensurePreviewUI(){
  let btn = document.getElementById('v7PreviewBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'v7PreviewBtn';
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = '出力プレビュー';
    makeExcelBtn.insertAdjacentElement('beforebegin', btn);
    btn.addEventListener('click', openPreview);
  }

  let dlg = document.getElementById('v7PreviewDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'v7PreviewDialog';
    dlg.innerHTML = `
      <div class="v7PreviewHead">
        <div><h2>Excel出力プレビュー</h2><div id="v7PreviewMeta" class="muted"></div></div>
        <button id="v7PreviewClose" type="button">閉じる</button>
      </div>
      <div class="v7Pager">
        <button id="v7PrevPage" type="button">← 前</button>
        <strong id="v7PageText"></strong>
        <button id="v7NextPage" type="button">次 →</button>
      </div>
      <div id="v7PreviewBody"></div>
      <div class="v7PreviewFooter"><button id="v7MakeExcelFromPreview" class="success" type="button">この内容でExcel作成</button></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#v7PreviewClose').onclick = () => dlg.close();
    dlg.querySelector('#v7MakeExcelFromPreview').onclick = () => { dlg.close(); makeExcelBtn.click(); };
    dlg.querySelector('#v7PrevPage').onclick = () => setPreviewPage(previewPage - 1);
    dlg.querySelector('#v7NextPage').onclick = () => setPreviewPage(previewPage + 1);
  }
  return dlg;
}

function snapshotCards(){
  return [...document.querySelectorAll('.card')].map((card, i) => ({
    no: i+1,
    src: card.querySelector('.thumb')?.src || '',
    angle: cardAngle(card),
    filename: card.querySelector('.filename')?.textContent || '',
    work: card.querySelector('.work')?.value || '',
    place: card.querySelector('.place')?.value || '',
    state: card.querySelector('.state')?.value || '',
    remarks: card.querySelector('.remarks')?.value || '',
    contract: card.querySelector('.contract')?.value || '',
    date: card.querySelector('.date')?.value || ''
  }));
}

let previewItems = [];
let previewPage = 0;
function loadImage(src){
  return new Promise((resolve,reject) => { const im = new Image(); im.onload=()=>resolve(im); im.onerror=reject; im.src=src; });
}
async function drawPreviewPhoto(canvas, item){
  const ratio = Number(window.PhotoBookTemplateMeta?.frameRatio) || FALLBACK_RATIO;
  const W = 560, H = Math.max(160, Math.round(W / ratio));
  canvas.width = W; canvas.height = H;
  const x = canvas.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0,0,W,H);
  try {
    const im = await loadImage(item.src);
    const angle = item.angle || 0;
    const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    const rightAngle = angle % 180 !== 0;
    const rw = rightAngle ? ih : iw, rh = rightAngle ? iw : ih;
    const scale = Math.min(W/rw, H/rh);
    x.save();
    x.translate(W/2,H/2);
    x.rotate(angle * Math.PI / 180);
    x.drawImage(im,-iw*scale/2,-ih*scale/2,iw*scale,ih*scale);
    x.restore();
  } catch (_) {}
}

function slotHtml(item){
  const esc = s => String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  return `<article class="v7Slot">
    <div class="v7SlotTop"><strong>No.${item.no}</strong><span>${esc(item.filename)}</span></div>
    <canvas class="v7SlotCanvas"></canvas>
    <div class="v7SlotFields">
      <div><b>工種</b>${esc(item.work)}</div><div><b>撮影場所</b>${esc(item.place)}</div>
      <div><b>状態</b>${esc(item.state)}</div><div><b>備考</b>${esc(item.remarks)}</div>
      <div class="wide"><b>工事名／委託件名</b>${esc(item.contract)}</div><div><b>撮影日</b>${esc(item.date)}</div>
    </div>
  </article>`;
}

function setPreviewPage(page){
  const dlg = ensurePreviewUI();
  const pages = Math.max(1, Math.ceil(previewItems.length / 20));
  previewPage = Math.max(0, Math.min(pages-1, page));
  const start = previewPage * 20;
  const group = previewItems.slice(start, start + 20);
  const body = dlg.querySelector('#v7PreviewBody');
  body.innerHTML = `<div class="v7Sheet">${group.map(slotHtml).join('')}</div>`;
  dlg.querySelector('#v7PageText').textContent = `施工写真_${String(previewPage+1).padStart(3,'0')}　(${previewPage+1}/${pages})`;
  dlg.querySelector('#v7PrevPage').disabled = previewPage <= 0;
  dlg.querySelector('#v7NextPage').disabled = previewPage >= pages-1;
  [...body.querySelectorAll('.v7SlotCanvas')].forEach((c, i) => drawPreviewPhoto(c, group[i]));
}

function openPreview(){
  const dlg = ensurePreviewUI();
  previewItems = snapshotCards();
  if (!previewItems.length) { alert('写真がありません。'); return; }
  const meta = window.PhotoBookTemplateMeta || {};
  dlg.querySelector('#v7PreviewMeta').textContent = `${meta.filename || '標準テンプレート'} / 写真枠比率 ${(Number(meta.frameRatio)||FALLBACK_RATIO).toFixed(3)} / 20枚ごとに1シート`;
  setPreviewPage(0);
  dlg.showModal();
}

const style = document.createElement('style');
style.textContent = `
.v7TemplateInfo{display:inline-block;margin-left:4px}.v7Warn{color:#b54708!important;font-weight:700}
#v7PreviewDialog{width:min(1180px,96vw);max-height:94vh;padding:16px;border:0;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.38)}
.v7PreviewHead,.v7Pager,.v7PreviewFooter{display:flex;align-items:center;justify-content:space-between;gap:12px}.v7PreviewHead h2{margin:0 0 4px}.v7Pager{justify-content:center;margin:12px 0}.v7PreviewFooter{justify-content:flex-end;margin-top:14px}
#v7PreviewBody{max-height:72vh;overflow:auto;background:#eef2f6;padding:12px;border-radius:10px}.v7Sheet{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.v7Slot{background:#fff;border:1px solid #cfd6df;border-radius:9px;padding:8px;min-width:0}.v7SlotTop{display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px}.v7SlotTop span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#667085}
.v7SlotCanvas{display:block;width:100%;height:auto;background:#fff;border:1px solid #e5e7eb}.v7SlotFields{display:grid;grid-template-columns:1fr 1.5fr;gap:3px 8px;margin-top:6px;font-size:10px}.v7SlotFields div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.v7SlotFields b{color:#667085;margin-right:5px}.v7SlotFields .wide{grid-column:1/-1}
@media(max-width:760px){.v7Sheet{grid-template-columns:1fr}#v7PreviewDialog{width:98vw;padding:10px}}
`;
document.head.appendChild(style);

ensureTemplateInfo();
ensurePreviewUI();
})();
