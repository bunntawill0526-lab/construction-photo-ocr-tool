(() => {
'use strict';

// V8 OCR isolation update
// 1) 状態（施工前/施工後/作業前/作業後ほか）の補完解析
// 2) 各入力欄から「全写真へ反映」
// 3) 状態専用OCRはメインOCR完了後にのみ順番に実行し、解析精度を落とす要因を排除

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

  for (const s of STATE_WORDS) {
    if (t.includes(s)) return s;
  }
  let m = t.match(/施.{0,1}工.{0,1}(前|後)/);
  if (m) return `施工${m[1]}`;
  m = t.match(/作.{0,1}業.{0,1}(前|後)/);
  if (m) return `作業${m[1]}`;
  return '';
}

// parser.jsの結果は壊さず、状態だけ追加補完する。
const P = window.PhotoBookParser;
if (P && typeof P.parseBoard === 'function' && !P.__v8StateWrapped) {
  const originalParse = P.parseBoard.bind(P);
  P.parseBoard = (text, filename='') => {
    const r = originalParse(text, filename);
    const state = detectState(`${filename}\n${text}`);
    if (state) r.state = state;
    return r;
  };
  P.__v8StateWrapped = true;
}

// ---------- 状態専用OCR ----------
// 重要: メインOCRとは絶対に並列実行しない。
let stateWorkerPromise = null;
const stateCache = new Map();
const stateBusy = new Set();
let queueTimer = 0;
let queueRunning = false;

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

function coreOcrIsBusy(){
  const texts = [...document.querySelectorAll('.card .scoreBadge')].map(x => x.textContent || '');
  return texts.some(t => /未解析|解析中/.test(t));
}

async function analyzeStateForCard(card){
  const input = card.querySelector('.state');
  const imgEl = card.querySelector('.thumb');
  const filename = card.querySelector('.filename')?.textContent || '';
  const raw = card.querySelector('.ocrRaw')?.textContent || '';
  if (!input || !imgEl || !imgEl.src) return;
  if (input.value.trim()) return;

  // まずメインOCRの既存結果だけで判定。追加OCR不要なら即終了。
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
  if (coreOcrIsBusy()) return;

  stateBusy.add(imgEl.src);
  setStateStatus(card, '状態解析中…');

  try {
    const img = await loadDomImage(imgEl.src);
    if (coreOcrIsBusy()) return;
    const worker = await getStateWorker();
    if (coreOcrIsBusy()) return;

    let result = await worker.recognize(stateCropCanvas(img, false));
    let text = result?.data?.text || '';
    let state = detectState(text);

    if (!state && !coreOcrIsBusy()) {
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

function scheduleStateQueue(delay=800){
  clearTimeout(queueTimer);
  queueTimer = setTimeout(runStateQueue, delay);
}

async function runStateQueue(){
  if (queueRunning) return;
  if (coreOcrIsBusy()) {
    scheduleStateQueue(900);
    return;
  }
  queueRunning = true;
  try {
    const cards = [...document.querySelectorAll('.card')];
    for (const card of cards) {
      if (coreOcrIsBusy()) {
        scheduleStateQueue(900);
        break;
      }
      await analyzeStateForCard(card);
    }
  } finally {
    queueRunning = false;
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
  STATE_WORDS.forEach(v => {
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
}

function enhanceAllV6(){
  document.querySelectorAll('.card').forEach(enhanceCardV6);
  scheduleStateQueue();
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
mo.observe(cardsRoot, {childList:true, subtree:true, characterData:true});

['analyzePending','reanalyzeAll'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', () => scheduleStateQueue(1200));
});
cardsRoot.addEventListener('click', e => {
  if (e.target.closest('.reanalyze')) scheduleStateQueue(1200);
});

window.addEventListener('beforeunload', async () => {
  try {
    const w = await stateWorkerPromise;
    await w?.terminate?.();
  } catch (_) {}
});

})();
