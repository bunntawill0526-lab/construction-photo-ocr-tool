(() => {
'use strict';

const cardsRoot = document.getElementById('cards');
const contractMaster = document.getElementById('defaultContract');
const makeExcelBtn = document.getElementById('makeExcel');
if (!cardsRoot || !contractMaster || !makeExcelBtn) return;

// ---------- shared project / contract name ----------
let forceGlobalContract = false;
let globalContract = contractMaster.value.trim();

function dispatchChange(input){
  input.dispatchEvent(new Event('change', {bubbles:true}));
}

function applyContractToAll(showNotice=true){
  globalContract = contractMaster.value.trim();
  forceGlobalContract = true;
  document.querySelectorAll('.card .contract').forEach(input => {
    if (input.value !== globalContract) {
      input.value = globalContract;
      dispatchChange(input);
    }
  });
  if (showNotice) {
    const n = document.getElementById('contractApplyStatus');
    if (n) {
      n.textContent = `全写真に反映済み（${document.querySelectorAll('.card').length}枚）`;
      clearTimeout(n._timer);
      n._timer = setTimeout(() => n.textContent = '', 2200);
    }
  }
}

function installContractControls(){
  if (document.getElementById('applyContractAll')) return;
  const label = contractMaster.closest('label');
  if (label) {
    const firstText = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (firstText) firstText.textContent = '委託件名／工事名（全写真共通）';
  }

  const row = document.createElement('div');
  row.className = 'v5ContractRow';
  row.innerHTML = '<button id="applyContractAll" type="button" class="secondary">全写真に反映</button><span id="contractApplyStatus" class="muted"></span>';
  contractMaster.insertAdjacentElement('afterend', row);

  document.getElementById('applyContractAll').addEventListener('click', () => applyContractToAll(true));
  contractMaster.addEventListener('change', () => applyContractToAll(true));
  contractMaster.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      contractMaster.blur();
      applyContractToAll(true);
    }
  });
}

// ---------- rotation ----------
// Object URLs are stable for the lifetime of an item, even when app.js re-renders cards.
const rotations = new Map(); // thumb.src -> 0/90/180/270

function normAngle(a){ return ((a % 360) + 360) % 360; }

function applyPreviewRotation(card){
  const img = card.querySelector('.thumb');
  if (!img) return;
  const angle = normAngle(rotations.get(img.src) || 0);
  const fit = () => {
    const wrap = img.closest('.thumbWrap');
    let scale = 1;
    if (wrap && angle % 180 !== 0) {
      const iw = Math.max(1, img.clientWidth || img.naturalWidth || 1);
      const ih = Math.max(1, img.clientHeight || img.naturalHeight || 1);
      const ww = Math.max(1, wrap.clientWidth || iw);
      const wh = Math.max(1, wrap.clientHeight || ih);
      scale = Math.min(1, ww / ih, wh / iw) * 0.98;
    }
    img.style.transform = `rotate(${angle}deg) scale(${scale})`;
    img.style.transformOrigin = '50% 50%';
    img.style.transition = 'transform .18s ease';
  };
  if (img.complete) requestAnimationFrame(fit);
  else img.addEventListener('load', () => requestAnimationFrame(fit), {once:true});

  const badge = card.querySelector('.v5Rotation');
  if (badge) badge.textContent = angle ? `${angle}°` : '';
}

function rotateCard(card, delta){
  const img = card.querySelector('.thumb');
  if (!img) return;
  const next = normAngle((rotations.get(img.src) || 0) + delta);
  rotations.set(img.src, next);
  applyPreviewRotation(card);
}

// Export rotation queue is captured in the same visible order as the app's internal items.
let exportRotations = [];
let exportRotationIndex = 0;

makeExcelBtn.addEventListener('click', () => {
  exportRotations = [...document.querySelectorAll('.card')].map(card => {
    const img = card.querySelector('.thumb');
    return img ? normAngle(rotations.get(img.src) || 0) : 0;
  });
  exportRotationIndex = 0;
}, true);

const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob = function(callback, type, quality){
  const c = this;
  const isExcelPhoto = c.width === 1600 && c.height >= 1250 && c.height <= 1350;
  if (!isExcelPhoto) return nativeToBlob.call(c, callback, type, quality);

  const angle = normAngle(exportRotations[exportRotationIndex++] || 0);
  if (!angle) return nativeToBlob.call(c, callback, type, quality);

  const W = c.width, H = c.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const x = out.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0,0,W,H);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';

  const rightAngle = angle % 180 !== 0;
  const rotatedW = rightAngle ? H : W;
  const rotatedH = rightAngle ? W : H;
  const scale = Math.min(W / rotatedW, H / rotatedH);
  x.translate(W/2, H/2);
  x.rotate(angle * Math.PI / 180);
  x.scale(scale, scale);
  x.drawImage(c, -W/2, -H/2);

  return nativeToBlob.call(out, callback, type, quality);
};

// ---------- drag reordering ----------
let dragIndex = -1;

function moveItemByExistingButtons(from, to){
  if (from === to || from < 0 || to < 0) return;
  let current = from;
  const direction = to > from ? 1 : -1;
  while (current !== to) {
    const cards = [...cardsRoot.querySelectorAll('.card')];
    const card = cards[current];
    if (!card) break;
    const btn = direction > 0 ? card.querySelector('.down') : card.querySelector('.up');
    if (!btn) break;
    btn.click();
    current += direction;
  }
}

cardsRoot.addEventListener('dragstart', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const cards = [...cardsRoot.querySelectorAll('.card')];
  dragIndex = cards.indexOf(card);
  card.classList.add('v5Dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragIndex));
  }
});

cardsRoot.addEventListener('dragover', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  cardsRoot.querySelectorAll('.v5DropTarget').forEach(x => x.classList.remove('v5DropTarget'));
  card.classList.add('v5DropTarget');
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});

cardsRoot.addEventListener('drop', e => {
  const target = e.target.closest('.card');
  if (!target) return;
  e.preventDefault();
  const cards = [...cardsRoot.querySelectorAll('.card')];
  const to = cards.indexOf(target);
  const from = dragIndex >= 0 ? dragIndex : Number(e.dataTransfer?.getData('text/plain'));
  cardsRoot.querySelectorAll('.v5DropTarget,.v5Dragging').forEach(x => x.classList.remove('v5DropTarget','v5Dragging'));
  dragIndex = -1;
  moveItemByExistingButtons(from, to);
});

cardsRoot.addEventListener('dragend', () => {
  cardsRoot.querySelectorAll('.v5DropTarget,.v5Dragging').forEach(x => x.classList.remove('v5DropTarget','v5Dragging'));
  dragIndex = -1;
});

// ---------- enhance cards after every app.js render ----------
function enhanceCard(card){
  if (card.dataset.v5Enhanced === '1') {
    if (forceGlobalContract) {
      const input = card.querySelector('.contract');
      if (input && input.value !== globalContract) { input.value = globalContract; dispatchChange(input); }
    }
    applyPreviewRotation(card);
    return;
  }
  card.dataset.v5Enhanced = '1';
  card.draggable = true;
  card.title = 'ドラッグして写真順を入れ替えできます';

  const actions = card.querySelector('.actions');
  if (actions) {
    const hint = document.createElement('span');
    hint.className = 'v5DragHint';
    hint.textContent = '☰ ドラッグで並替';
    actions.prepend(hint);

    const left = document.createElement('button');
    left.type = 'button'; left.className = 'rotateLeft'; left.textContent = '↺ 左90°';
    const right = document.createElement('button');
    right.type = 'button'; right.className = 'rotateRight'; right.textContent = '↻ 右90°';
    const badge = document.createElement('span');
    badge.className = 'v5Rotation';
    actions.append(left, right, badge);
    left.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rotateCard(card, -90); });
    right.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); rotateCard(card, 90); });
  }

  if (forceGlobalContract) {
    const input = card.querySelector('.contract');
    if (input && input.value !== globalContract) { input.value = globalContract; dispatchChange(input); }
  }
  applyPreviewRotation(card);
}

function enhanceAll(){
  document.querySelectorAll('.card').forEach(enhanceCard);
}

installContractControls();

const style = document.createElement('style');
style.textContent = `
.v5ContractRow{display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap}
.v5ContractRow button{padding:7px 10px;font-size:12px}
.card[draggable="true"]{cursor:grab}
.card.v5Dragging{opacity:.55;cursor:grabbing}
.card.v5DropTarget{outline:3px solid #2563eb;outline-offset:2px}
.v5DragHint{display:inline-flex;align-items:center;color:#667085;font-size:12px;font-weight:700;padding:6px 4px;user-select:none}
.v5Rotation{display:inline-flex;align-items:center;min-width:28px;color:#475467;font-size:12px;font-weight:700}
.thumbWrap{overflow:hidden}
`;
document.head.appendChild(style);

enhanceAll();
new MutationObserver(() => enhanceAll()).observe(cardsRoot, {childList:true, subtree:true});
window.addEventListener('resize', enhanceAll);

})();
