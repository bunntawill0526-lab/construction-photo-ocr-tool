(() => {
'use strict';

// V6
// 1) 状態（施工前/施工後/作業前/作業後ほか）の補完解析
// 2) 各入力欄から「全写真へ反映」

const cardsRoot = document.getElementById('cards');
if (!cardsRoot) return;

const STATE_WORDS = [
  '施工前','施工後','作業前','作業後',
  '施工中','作業中','設置前','設置後','撤去前','撤去後','完成','完了'
];

function dispatchChange(input){
  input.dispatchEvent(new Event('change', {bubbles:true}));
}

function compactText(s){
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\s\u3000\t\r\n]+/g,'')
    .replace(/[|｜]/g,'')
    .replace(/[・･:：;；,，、。\.\-_―ー]/g,'');
}

function detectState(text){
  const t = compactText(text)
    .replace(/施エ/g,'施工')
    .replace(/施I/g,'施工')
    .replace(/作業業/g,'作業');

  // 明示語だけを採用。写真の内容から状態を推測しない。
  for (const s of STATE_WORDS) {
    if (t.includes(s)) return s;
  }
  // OCRの軽微な空振れ用。施工/作業 + 前後が近接している場合だけ補正。
  let m = t.match(/施.{0,1}工.{0,1}(前|後)/);
  if (m) return `施工${m[1]}`;
  m = t.match(/作.{0,1}業.{0,1}(前|後)/);
  if (m) return `作業${m[1]}`;
  return '';
}

// parser.jsの旧状態語リストを、現行仕様で上書き補完する。
const P = window.PhotoBookParser;
if (P && typeof P.parseBoard === 'function' && !P.__v6StateWrapped) {
  const originalParse = P.parseBoard.bind(P);
  P.parseBoard = (text, filename='') => {
    const r = originalParse(text, filename);
    const state = detectState(`${filename}\n${text}`);
    if (state) r.state = state;
    return r;
  };
  P.__v6StateWrapped = true;
}

// ---------- 状態専用OCR ----------
// V4の工種/測点/備考解析はそのまま。状態が空欄のときだけ、
// 黒板を含む左下領域を追加OCRして明示語を拾う。
let stateWorkerPromise = null;
const stateCache = new Map();      // image src -> state or ''
const stateBusy = new Set();

async function getStateWorker(){
  if (stateWorkerPromise) return stateWorkerPromise;
  stateWorkerPromise = (async () => {
    if (!window.Tesseract) throw new Error('Tesseract.js unavailable');
    const w = await Tesseract.createWorker(['jpn'], Tesseract.OEM.LSTM_ONLY);
    const psm = (Tesseract.PSM && (Tesseract.PSM.SPARSE_TEXT ?? Tesseract.PSM.AUTO)) ?? 11;
    await w.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: '1'
    });
    return w;
  })();
  return stateWorkerPromise;
}

function loadDomImage(src){
  return new Promise((resolve,reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function stateCropCanvas(img, binary=false){
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;

  // 電子黒板は左下にある。位置ズレも許容するため少し広めに取る。
  const sx = 0;
  const sy = Math.max(0, Math.floor(sh * 0.38));
  const cw = Math.min(sw, Math.floor(sw * 0.58));
  const ch = sh - sy;

  const targetW = 1800;
  const targetH = Math.max(500, Math.round(targetW * ch / Math.max(1,cw)));
  const c = document.createElement('canvas');
  c.width = targetW;
  c.height = targetH;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#fff';
  x.fillRect(0,0,c.width,c.height);
  x.drawImage(img, sx,sy,cw,ch, 0,0,c.width,c.height);

  const im = x.getImageData(0,0,c.width,c.height);
  const d = im.data;
  for (let i=0;i<d.length;i+=4){
    let g = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
    if (binary) g = g < 176 ? 0 : 255;
    else g = Math.max(0, Math.min(255, (g - 128) * 1.48 + 128));
    d[i]=d[i+1]=d[i+2]=g;
  }
  x.putImageData(im,0,0);
  return c;
}

function setStateStatus(card, text){
  let s = card.querySelector('.v6StateStatus');
  if (!s) {
    const input = card.querySelector('.state');
    if (!input) return;
    s = document.createElement('span');
    s.className = 'v6StateStatus';
    input.insertAdjacentElement('afterend', s);
  }
  s.textContent = text || '';
}

async function analyzeStateForCard(card){
  const input = card.querySelector('.state');
  const imgEl = card.querySelector('.thumb');
  const score = card.querySelector('.scoreBadge')?.textContent || '';
  const filename = card.querySelector('.filename')?.textContent || '';
  const raw = card.querySelector('.ocrRaw')?.textContent || '';
  if (!input || !imgEl || !imgEl.src) return;
  if (/未解析|解析中/.test(score)) return;

  // 手入力済みなら触らない。
  if (input.value.trim()) return;

  const direct = detectState(`${filename}\n${raw}`);
  if (direct) {
    input.value = direct;
    dispatchChange(input);
    stateCache.set(imgEl.src, direct);
    setStateStatus(card, '状態: 自動認識');
    return;
  }

  if (stateCache.has(imgEl.src)) {
    const cached = stateCache.get(imgEl.src);
    if (cached && !input.value.trim()) {
      input.value = cached;
      dispatchChange(input);
      setStateStatus(card, '状態: 自動認識');
    }
    return;
  }
  if (stateBusy.has(imgEl.src)) return;
  stateBusy.add(imgEl.src);
  setStateStatus(card, '状態解析中…');

  try {
    const img = await loadDomImage(imgEl.src);
    const worker = await getStateWorker();
    let result = await worker.recognize(stateCropCanvas(img, false));
    let text = result?.data?.text || '';
    let state = detectState(text);

    if (!state) {
      result = await worker.recognize(stateCropCanvas(img, true));
      text += '\n' + (result?.data?.text || '');
      state = detectState(text);
    }

    stateCache.set(imgEl.src, state || '');
    if (state && !input.value.trim()) {
      input.value = state;
      dispatchChange(input);
      setStateStatus(card, '状態: 自動認識');
    } else {
      setStateStatus(card, '');
    }
  } catch (e) {
    console.warn('state OCR failed', e);
    stateCache.set(imgEl.src, '');
    setStateStatus(card, '');
  } finally {
    stateBusy.delete(imgEl.src);
  }
}

// ---------- 任意項目の全写真反映 ----------
const BULK_FIELDS = [
  {cls:'work',     label:'工種'},
  {cls:'place',    label:'撮影場所'},
  {cls:'state',    label:'状態'},
  {cls:'remarks',  label:'備考'},
  {cls:'contract', label:'工事名／委託件名'},
  {cls:'date',     label:'撮影日'}
];

function applyFieldToAll(cls, value){
  document.querySelectorAll(`.card .${cls}`).forEach(input => {
    input.value = value;
    dispatchChange(input);
  });

  // 工事名/委託件名は上部の共通欄とも同期する。
  if (cls === 'contract') {
    const master = document.getElementById('defaultContract');
    if (master && master.value !== value) master.value = value;
  }
}

function installBulkButton(card, spec){
  const input = card.querySelector(`.${spec.cls}`);
  if (!input) return;
  const label = input.closest('label');
  if (!label || label.querySelector(`.v6ApplyAll[data-field="${spec.cls}"]`)) return;

  if (spec.cls === 'contract') {
    const textNode = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (textNode) textNode.textContent = '工事名／委託件名';
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'v6ApplyAll';
  btn.dataset.field = spec.cls;
  btn.textContent = '全写真へ';
  btn.title = `${spec.label}の現在値を全写真へ反映`;
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('dragstart', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const value = input.value;
    applyFieldToAll(spec.cls, value);
    btn.textContent = '反映済';
    setTimeout(() => btn.textContent = '全写真へ', 1200);
  });
  label.appendChild(btn);
}

function ensureStateDatalist(){
  if (document.getElementById('v6StateList')) return;
  const dl = document.createElement('datalist');
  dl.id = 'v6StateList';
  ['施工前','施工後','作業前','作業後','施工中','作業中','設置前','設置後','撤去前','撤去後','完成','完了']
    .forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      dl.appendChild(o);
    });
  document.body.appendChild(dl);
}

function enhanceCardV6(card){
  BULK_FIELDS.forEach(spec => installBulkButton(card, spec));
  const state = card.querySelector('.state');
  if (state) {
    state.setAttribute('list', 'v6StateList');
    state.placeholder = '施工前 / 施工後 / 作業前 / 作業後';
  }
  analyzeStateForCard(card);
}

function enhanceAllV6(){
  document.querySelectorAll('.card').forEach(enhanceCardV6);
}

ensureStateDatalist();

const style = document.createElement('style');
style.textContent = `
.fields label{position:relative}
.v6ApplyAll{position:absolute;right:0;top:-3px;padding:2px 7px!important;font-size:10px!important;line-height:1.3;border-radius:999px;background:#f8fafc;color:#475467;border:1px solid #cbd5e1;z-index:2}
.v6ApplyAll:hover{background:#eef2ff;color:#1d4ed8}
.v6StateStatus{font-size:10px;color:#2563eb;margin-top:2px;font-weight:700;min-height:13px}
`;
document.head.appendChild(style);

enhanceAllV6();
const mo = new MutationObserver(() => enhanceAllV6());
mo.observe(cardsRoot, {childList:true, subtree:true});

window.addEventListener('beforeunload', async () => {
  try {
    const w = await stateWorkerPromise;
    await w?.terminate?.();
  } catch (_) {}
});

})();
