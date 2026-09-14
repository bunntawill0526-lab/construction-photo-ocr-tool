(() => {
'use strict';

// V9 UI only
// - 複数写真を選択してまとめてドラッグ並べ替え
// - 写真一覧を縦1列からレスポンシブなタイル表示へ
// - OCR/解析ロジックには触れない

const cardsRoot = document.getElementById('cards');
const statusbar = document.querySelector('.statusbar');
if (!cardsRoot || !statusbar) return;

const selected = new Set(); // key = thumb.src
let lastSelectedKey = '';
let dragKeys = [];
let dragSourceKey = '';
let rafPending = false;

function cardKey(card){
  return card?.querySelector('.thumb')?.src || '';
}

function cards(){ return [...cardsRoot.querySelectorAll('.card')]; }
function keys(){ return cards().map(cardKey).filter(Boolean); }

function dispatchClick(el){
  if (!el) return;
  el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
}

function ensureToolbar(){
  let bar = document.getElementById('v9PhotoToolbar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'v9PhotoToolbar';
  bar.className = 'panel v9PhotoToolbar';
  bar.innerHTML = `
    <div class="v9PhotoToolbarLeft">
      <strong>写真一覧</strong>
      <span id="v9SelectedCount" class="v9SelectedCount">選択 0枚</span>
      <button id="v9SelectAll" type="button">全選択</button>
      <button id="v9ClearSelection" type="button">選択解除</button>
      <span class="muted">複数選択したまま写真をドラッグすると、まとめて移動</span>
    </div>
    <div class="v9ViewSwitch" role="group" aria-label="写真表示切替">
      <button id="v9GridView" type="button">▦ タイル</button>
      <button id="v9ListView" type="button">☰ 1列</button>
    </div>`;
  statusbar.insertAdjacentElement('afterend', bar);

  bar.querySelector('#v9SelectAll').addEventListener('click', () => {
    keys().forEach(k => selected.add(k));
    refreshSelection();
  });
  bar.querySelector('#v9ClearSelection').addEventListener('click', () => {
    selected.clear(); lastSelectedKey=''; refreshSelection();
  });
  bar.querySelector('#v9GridView').addEventListener('click', () => setView('grid'));
  bar.querySelector('#v9ListView').addEventListener('click', () => setView('list'));
  return bar;
}

function setView(mode){
  const grid = mode !== 'list';
  cardsRoot.classList.toggle('v9Compact', grid);
  document.body.classList.toggle('v9CompactBody', grid);
  document.getElementById('v9GridView')?.classList.toggle('v9Active', grid);
  document.getElementById('v9ListView')?.classList.toggle('v9Active', !grid);
  try { localStorage.setItem('photobook-view-v9', grid ? 'grid' : 'list'); } catch (_) {}
}

function selectionRange(aKey, bKey){
  const order = keys();
  const a = order.indexOf(aKey), b = order.indexOf(bKey);
  if (a < 0 || b < 0) return [bKey];
  const lo = Math.min(a,b), hi = Math.max(a,b);
  return order.slice(lo,hi+1);
}

function toggleSelection(card, e){
  const key = cardKey(card);
  if (!key) return;
  if (e?.shiftKey && lastSelectedKey) {
    selectionRange(lastSelectedKey, key).forEach(k => selected.add(k));
  } else {
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    lastSelectedKey = key;
  }
  refreshSelection();
}

function refreshSelection(){
  const live = new Set(keys());
  [...selected].forEach(k => { if (!live.has(k)) selected.delete(k); });
  cards().forEach((card, i) => {
    const k = cardKey(card);
    const isSel = selected.has(k);
    card.classList.toggle('v9Selected', isSel);
    const btn = card.querySelector('.v9Select');
    if (btn) {
      btn.classList.toggle('v9On', isSel);
      btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      btn.title = isSel ? '選択解除' : '複数選択';
      btn.textContent = isSel ? '✓' : '';
    }
    const no = card.querySelector('.v9OrderNo');
    if (no && no.textContent !== String(i+1)) no.textContent = String(i+1);
  });
  const count = document.getElementById('v9SelectedCount');
  if (count) count.textContent = `選択 ${selected.size}枚`;
}

function enhanceCard(card){
  if (!card.dataset.v9Enhanced) {
    card.dataset.v9Enhanced = '1';
    card.draggable = true;

    const thumb = card.querySelector('.thumbWrap');
    if (thumb) {
      const sel = document.createElement('button');
      sel.type = 'button';
      sel.className = 'v9Select';
      sel.setAttribute('aria-label','写真を選択');
      sel.setAttribute('aria-pressed','false');
      sel.addEventListener('mousedown', e => e.stopPropagation());
      sel.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        toggleSelection(card, e);
      });
      thumb.appendChild(sel);

      const no = document.createElement('span');
      no.className = 'v9OrderNo';
      thumb.appendChild(no);

      const dragHint = document.createElement('span');
      dragHint.className = 'v9DragPhotoHint';
      dragHint.textContent = 'ドラッグ';
      thumb.appendChild(dragHint);
    }
  }
}

function enhanceAll(){
  cards().forEach(enhanceCard);
  refreshSelection();
}

function scheduleEnhance(){
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending=false; enhanceAll(); });
}

function clearDropMarks(){
  cardsRoot.querySelectorAll('.v9DropBefore,.v9DropAfter,.v9Dragging').forEach(c =>
    c.classList.remove('v9DropBefore','v9DropAfter','v9Dragging'));
}

function dropAfter(card, e){
  const r = card.getBoundingClientRect();
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  // タイル表示では同一行の左右も順番として扱う。
  if (Math.abs(e.clientY - cy) < r.height * 0.28) return e.clientX > cx;
  return e.clientY > cy;
}

function reorderTo(desired){
  // app.js が持つ内部配列とズレないよう、既存の↑ボタンを使って並べ替える。
  for (let target=0; target<desired.length; target++) {
    const want = desired[target];
    let guard = 0;
    while (guard++ < desired.length + 5) {
      const now = cards();
      const pos = now.findIndex(c => cardKey(c) === want);
      if (pos < 0 || pos <= target) break;
      const up = now[pos].querySelector('.up');
      if (!up) break;
      dispatchClick(up);
    }
  }
  scheduleEnhance();
}

// V5の単体ドラッグをキャプチャ段階で置き換える。
cardsRoot.addEventListener('dragstart', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.closest('input,button,textarea,select,summary')) {
    e.preventDefault(); e.stopImmediatePropagation(); return;
  }
  e.stopImmediatePropagation();
  const key = cardKey(card);
  if (!key) { e.preventDefault(); return; }

  if (!selected.has(key)) {
    selected.clear(); selected.add(key); lastSelectedKey = key;
  }
  const order = keys();
  dragKeys = order.filter(k => selected.has(k));
  dragSourceKey = key;
  cards().forEach(c => { if (selected.has(cardKey(c))) c.classList.add('v9Dragging'); });
  refreshSelection();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragKeys.join('\n'));
  }
}, true);

cardsRoot.addEventListener('dragover', e => {
  const card = e.target.closest('.card');
  if (!card || !dragKeys.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  clearDropMarks();
  cards().forEach(c => { if (selected.has(cardKey(c))) c.classList.add('v9Dragging'); });
  if (!selected.has(cardKey(card))) {
    card.classList.add(dropAfter(card,e) ? 'v9DropAfter' : 'v9DropBefore');
  }
  if (e.dataTransfer) e.dataTransfer.dropEffect='move';
}, true);

cardsRoot.addEventListener('drop', e => {
  const targetCard = e.target.closest('.card');
  if (!targetCard || !dragKeys.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();

  const current = keys();
  const moving = current.filter(k => dragKeys.includes(k));
  const target = cardKey(targetCard);
  const after = dropAfter(targetCard,e);
  clearDropMarks();

  if (!moving.length || moving.includes(target)) {
    dragKeys=[]; dragSourceKey=''; refreshSelection(); return;
  }

  const remaining = current.filter(k => !moving.includes(k));
  let insertAt = remaining.indexOf(target);
  if (insertAt < 0) insertAt = remaining.length;
  else if (after) insertAt += 1;
  const desired = [...remaining.slice(0,insertAt), ...moving, ...remaining.slice(insertAt)];
  reorderTo(desired);
  dragKeys=[]; dragSourceKey='';
  refreshSelection();
}, true);

cardsRoot.addEventListener('dragend', e => {
  if (!dragSourceKey && !dragKeys.length) return;
  e.stopImmediatePropagation();
  dragKeys=[]; dragSourceKey=''; clearDropMarks(); refreshSelection();
}, true);

// Ctrl/Cmd + 写真部分クリックでも複数選択できる。
cardsRoot.addEventListener('click', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.target.closest('input,button,textarea,select,summary,details')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  toggleSelection(card, e);
}, true);

const style = document.createElement('style');
style.textContent = `
body.v9CompactBody main{max-width:1760px}
.v9PhotoToolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;position:sticky;top:8px;z-index:20;padding:9px 12px;background:rgba(255,255,255,.96);backdrop-filter:blur(8px)}
.v9PhotoToolbarLeft,.v9ViewSwitch{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.v9PhotoToolbar button{padding:6px 9px;font-size:12px}
.v9SelectedCount{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;background:#eef2ff;color:#1d4ed8;font-size:12px;font-weight:800}
.v9ViewSwitch .v9Active{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
.cards.v9Compact{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;align-items:start}
.cards.v9Compact .card{display:flex;flex-direction:column;min-width:0;height:100%}
.cards.v9Compact .thumbWrap{width:100%;min-height:0;aspect-ratio:16/10;max-height:none}
.cards.v9Compact .thumb{width:100%;height:100%;max-height:none;object-fit:contain}
.cards.v9Compact .meta{padding:10px}
.cards.v9Compact .topline{margin-bottom:8px;align-items:flex-start}
.cards.v9Compact .filename{font-size:12px;line-height:1.35;max-height:2.7em;overflow:hidden}
.cards.v9Compact .fields{grid-template-columns:1fr 1fr;gap:7px}
.cards.v9Compact .fields .wide{grid-column:1/-1}
.cards.v9Compact .fields input{padding:6px 7px;font-size:12px}
.cards.v9Compact .actions{flex-wrap:wrap;margin-top:8px;gap:5px}
.cards.v9Compact .actions button{padding:5px 7px;font-size:11px}
.cards.v9Compact .v5DragHint{display:none}
.cards.v9Compact .ocrDetails{margin-top:7px;font-size:11px}
.card.v9Selected{outline:3px solid #2563eb;outline-offset:1px;box-shadow:0 0 0 4px rgba(37,99,235,.12),0 4px 16px rgba(15,23,42,.10)}
.card.v9Dragging{opacity:.48}
.card.v9DropBefore{box-shadow:-7px 0 0 #2563eb,0 2px 10px rgba(15,23,42,.06)}
.card.v9DropAfter{box-shadow:7px 0 0 #2563eb,0 2px 10px rgba(15,23,42,.06)}
.v9Select{position:absolute;right:8px;top:8px;width:30px;height:30px;padding:0!important;border-radius:50%;border:2px solid rgba(255,255,255,.9);background:rgba(17,24,39,.72);color:#fff;font-size:18px;line-height:26px;z-index:7;box-shadow:0 2px 8px rgba(0,0,0,.22)}
.v9Select.v9On{background:#2563eb;border-color:#fff}
.v9OrderNo{position:absolute;left:8px;bottom:8px;display:flex;align-items:center;justify-content:center;min-width:29px;height:25px;padding:0 7px;border-radius:999px;background:rgba(17,24,39,.78);color:#fff;font-size:12px;font-weight:800;z-index:6}
.v9DragPhotoHint{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);padding:4px 8px;border-radius:999px;background:rgba(17,24,39,.62);color:#fff;font-size:10px;font-weight:700;opacity:0;transition:opacity .15s;pointer-events:none}
.thumbWrap:hover .v9DragPhotoHint{opacity:1}
@media(max-width:1100px){.cards.v9Compact{grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}}
@media(max-width:720px){.v9PhotoToolbar{position:static}.cards.v9Compact{grid-template-columns:1fr}.cards.v9Compact .thumbWrap{aspect-ratio:16/10}}
`;
document.head.appendChild(style);

ensureToolbar();
let saved='grid';
try { saved = localStorage.getItem('photobook-view-v9') || 'grid'; } catch (_) {}
setView(saved);
enhanceAll();
new MutationObserver(scheduleEnhance).observe(cardsRoot,{childList:true,subtree:true});

})();
