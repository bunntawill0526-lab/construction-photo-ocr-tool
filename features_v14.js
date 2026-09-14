(() => {
'use strict';

// V14: 無料・ローカル高精度解析
// - PP-OCRv5 (Japanese) で黒板内の文字と座標を取得
// - WebGPU が使える場合は Qwen3-VL-2B をブラウザ内で実行して意味対応を補正
// - 写真自体は外部APIへ送信しない。モデルファイルだけ初回ダウンロード。
// - 撮影場所（測点）順の自然ソートを追加

const root = document.getElementById('cards');
const analyzePending = document.getElementById('analyzePending');
const reanalyzeAll = document.getElementById('reanalyzeAll');
const sortDate = document.getElementById('sortDate');
const engineBadge = document.getElementById('engineBadge');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const runtimeText = document.getElementById('runtimeText');
const defaultContract = document.getElementById('defaultContract');
if (!root || !analyzePending || !reanalyzeAll) return;

const STATE_WORDS = ['施工前','施工後','作業前','作業後','施工中','作業中','設置前','設置後','撤去前','撤去後','完成','完了'];
const LABEL_RE = /(委託件名|工事名|件名|工種|作業内容|測点|撮影場所|場所|備考|摘要|状態|請負者|施工者|受注者)/;
const PADDLE_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js/+esm';
const HF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0-next.5/+esm';
const QWEN_MODEL = 'huggingworld/Qwen3-VL-2B-Instruct-ONNX';

let paddlePromise = null;
let qwenPromise = null;
let running = false;
const resultByKey = new Map();

function cards(){ return [...root.querySelectorAll('.card')]; }
function keyOf(card){ return card?.querySelector('.thumb')?.src || ''; }
function nfkc(s){ try{return String(s||'').normalize('NFKC');}catch(_){return String(s||'');} }
function cleanText(s){ return nfkc(s).replace(/[\u3000\t\r]+/g,' ').replace(/\s+/g,' ').trim(); }
function dispatchChange(el){ if(el) el.dispatchEvent(new Event('change',{bubbles:true})); }
function setProgress(pct,text){
  if(progressWrap) progressWrap.classList.remove('hidden');
  if(progressBar) progressBar.style.width = `${Math.max(0,Math.min(100,pct))}%`;
  if(progressText) progressText.textContent = text || '';
}
function hideProgress(){ if(progressWrap) progressWrap.classList.add('hidden'); }
function setEngine(text){ if(engineBadge) engineBadge.textContent=text; }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function ensureV14Controls(){
  if(document.getElementById('v14EnginePanel')) return;
  const controls = document.querySelector('.controls');
  if(!controls) return;

  const panel = document.createElement('div');
  panel.id = 'v14EnginePanel';
  panel.className = 'v14EnginePanel';
  const gpu = !!navigator.gpu;
  panel.innerHTML = `
    <div class="v14EngineLine">
      <strong>高精度ローカル解析</strong>
      <span class="v14EngineTag">PP-OCRv5 日本語</span>
      <span class="v14EngineTag">Qwen3-VL 2B</span>
      <label class="v14Check"><input id="v14UseVlm" type="checkbox" ${gpu?'checked':''} ${gpu?'':'disabled'}> Qwen補正を使う</label>
      <span id="v14GpuText" class="muted">${gpu?'WebGPU対応：画像理解を併用':'WebGPU非対応：PaddleOCRのみで解析'}</span>
    </div>
    <div class="muted v14Note">追加料金・APIキー不要。初回のみOCR/VLMモデルをダウンロードします。写真はブラウザ内で処理します。</div>`;
  controls.appendChild(panel);

  analyzePending.textContent = '高精度で未解析を解析';
  reanalyzeAll.textContent = '高精度で全て再解析';

  if(sortDate && !document.getElementById('v14SortPlace')){
    const b=document.createElement('button');
    b.id='v14SortPlace';
    b.type='button';
    b.textContent='撮影場所順';
    b.title='撮影場所（測点）→状態→ファイル名の順に並べ替え';
    sortDate.insertAdjacentElement('afterend',b);
    b.addEventListener('click',sortByPlace);
  }
}

async function ensurePaddle(){
  if(paddlePromise) return paddlePromise;
  setEngine('PaddleOCR読込中');
  paddlePromise=(async()=>{
    const mod=await import(PADDLE_URL);
    const PaddleOCR=mod.PaddleOCR;
    if(!PaddleOCR) throw new Error('PaddleOCR.jsを読み込めませんでした');
    const ocr=await PaddleOCR.create({
      lang:'japan',
      ocrVersion:'PP-OCRv5',
      ortOptions:{backend:'auto'}
    });
    try{ await ocr.initialize?.(); }catch(_){ }
    return ocr;
  })();
  try{
    const ocr=await paddlePromise;
    setEngine('PaddleOCR準備完了');
    return ocr;
  }catch(e){
    paddlePromise=null;
    setEngine('PaddleOCR読込失敗');
    throw e;
  }
}

async function ensureQwen(){
  if(qwenPromise) return qwenPromise;
  if(!navigator.gpu) throw new Error('このブラウザはWebGPUに対応していません');
  setEngine('Qwen3-VL読込中');
  qwenPromise=(async()=>{
    const hf=await import(HF_URL);
    const {AutoProcessor,Qwen3VLForConditionalGeneration,RawImage,env}=hf;
    if(!AutoProcessor||!Qwen3VLForConditionalGeneration||!RawImage) throw new Error('Qwen3-VL用ライブラリを読み込めませんでした');
    if(env){
      env.allowLocalModels=false;
      env.useBrowserCache=true;
    }
    const processor=await AutoProcessor.from_pretrained(QWEN_MODEL);
    const model=await Qwen3VLForConditionalGeneration.from_pretrained(QWEN_MODEL,{
      device:'webgpu',
      dtype:{
        embed_tokens:'fp16',
        vision_encoder:'fp16',
        decoder_model_merged:'q4f16'
      }
    });
    return {hf,processor,model,RawImage};
  })();
  try{
    const x=await qwenPromise;
    setEngine('PaddleOCR + Qwen準備完了');
    return x;
  }catch(e){
    qwenPromise=null;
    setEngine('Qwen読込失敗・Paddle継続');
    throw e;
  }
}

function polyBox(poly){
  if(!Array.isArray(poly)||!poly.length) return null;
  const pts=[];
  for(const p of poly){
    if(Array.isArray(p)&&p.length>=2&&Number.isFinite(+p[0])&&Number.isFinite(+p[1])) pts.push([+p[0],+p[1]]);
  }
  if(!pts.length) return null;
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
  const x=Math.min(...xs),y=Math.min(...ys),r=Math.max(...xs),b=Math.max(...ys);
  return {x,y,w:Math.max(1,r-x),h:Math.max(1,b-y),r,b,cx:(x+r)/2,cy:(y+b)/2};
}

function normalizePaddle(result){
  const out=[];
  for(const it of result?.items||[]){
    const text=cleanText(it?.text||'');
    if(!text) continue;
    const box=polyBox(it?.poly||it?.box||it?.points);
    out.push({text,score:Number(it?.score||0),box});
  }
  return out;
}

function stripKnownLabel(s,re){ return cleanText(s).replace(re,'').replace(/^\s*[:：|｜-]+\s*/,'').trim(); }
function detectState(text){
  const t=nfkc(text).replace(/施エ/g,'施工').replace(/施I/g,'施工').replace(/作業業/g,'作業');
  for(const s of STATE_WORDS) if(t.includes(s)) return s;
  let m=t.match(/施.{0,1}工.{0,1}(前|後)/); if(m)return `施工${m[1]}`;
  m=t.match(/作.{0,1}業.{0,1}(前|後)/); if(m)return `作業${m[1]}`;
  return '';
}

function sameRow(a,b){
  if(!a?.box||!b?.box) return false;
  const tol=Math.max(16,a.box.h*1.0,b.box.h*1.0);
  return Math.abs(a.box.cy-b.box.cy)<=tol;
}

function valueRightOfLabel(items,labelRegex,stripRegex){
  const labs=items.filter(x=>labelRegex.test(x.text));
  for(const lab of labs){
    const own=stripKnownLabel(lab.text,stripRegex);
    if(own&&own!==lab.text) return own;
    if(!lab.box) continue;
    const right=items.filter(x=>x!==lab&&x.box&&sameRow(lab,x)&&x.box.x>=lab.box.r-5)
      .sort((a,b)=>a.box.x-b.box.x);
    if(right.length){
      const txt=right.map(x=>x.text).join(' ').trim();
      if(txt) return txt;
    }
  }
  return '';
}

function sanitizeField(field,v){
  let t=cleanText(v);
  if(!t) return '';
  t=t.replace(/^[|｜:：;；,，、。・\-_=+\s]+|[|｜:：;；,，、。・\-_=+\s]+$/g,'').trim();
  if(!t||t.length===1) return '';
  if(field==='state') return STATE_WORDS.includes(t)?t:detectState(t);
  if(field==='remarks'&&/^(?:なし|無し|空欄|記載なし|記載無し|特になし)$/i.test(t)) return '';
  if(field==='place'&&/^(?:NTT|ＮＴＴ)?\s*西日本株式会社$/i.test(t)) return '';
  if(field==='place'&&/^(?:請負者|施工者|受注者)/.test(t)) return '';
  if(field==='work'&&/(?:NTT|ＮＴＴ)?\s*西日本株式会社/i.test(t)) return '';
  if(field==='contract'&&/^(?:工種|測点|撮影場所|備考|状態|請負者)$/.test(t)) return '';
  return t;
}

function fieldsFromPaddle(items){
  const all=items.map(x=>x.text).join('\n');
  let contract=valueRightOfLabel(items,/(委託件名|工事名|件名)/,/(?:委託件名|工事名|件名)/);
  let work=valueRightOfLabel(items,/(工種|作業内容)/,/(?:工種|作業内容)/);
  let place=valueRightOfLabel(items,/(測点|撮影場所|場所)/,/(?:測点|撮影場所|場所)/);
  let remarks=valueRightOfLabel(items,/(備考|摘要)/,/(?:備考|摘要)/);
  const state=detectState(all);

  // 同一行の状態や請負者は備考から除外
  if(remarks){
    for(const s of STATE_WORDS) remarks=remarks.replaceAll(s,' ');
    remarks=remarks.replace(/(?:請負者|施工者|受注者).*$/,' ').trim();
  }

  // ラベルが一部欠けた場合だけ、座標順の短いフォールバック。
  const byY=items.filter(x=>x.box).sort((a,b)=>a.box.cy-b.box.cy||a.box.x-b.box.x);
  const nonLabel=byY.filter(x=>!LABEL_RE.test(x.text)&&!STATE_WORDS.some(s=>x.text.includes(s))&&!/(?:NTT|ＮＴＴ)?\s*西日本株式会社/.test(x.text));
  if(!place){
    const cand=nonLabel.find(x=>/[棟館階室Ff]|\d/.test(x.text)&&!/(設置|撤去|配線|敷設|工事|更改)/.test(x.text));
    if(cand) place=cand.text;
  }
  if(!work){
    const cand=nonLabel.find(x=>/(設置|撤去|配線|敷設|成端|試験|更新|取替|交換|移設|搬入|接続|切替|開通|設定)/.test(x.text));
    if(cand) work=cand.text;
  }

  return {
    contract:sanitizeField('contract',contract),
    work:sanitizeField('work',work),
    place:sanitizeField('place',place),
    state:sanitizeField('state',state),
    remarks:sanitizeField('remarks',remarks),
    raw:all
  };
}

function cropFromItems(img,items){
  const iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
  const anchors=items.filter(x=>x.box&&LABEL_RE.test(x.text));
  let x=0,y=Math.floor(ih*.28),r=Math.floor(iw*.68),b=ih;
  if(anchors.length){
    const minY=Math.min(...anchors.map(x=>x.box.y));
    const near=items.filter(x=>x.box&&x.box.cy>=minY-80&&x.box.cy<=ih&&x.box.cx<=iw*.88);
    if(near.length){
      x=Math.max(0,Math.floor(Math.min(...near.map(x=>x.box.x))-40));
      y=Math.max(0,Math.floor(Math.min(...near.map(x=>x.box.y))-40));
      r=Math.min(iw,Math.ceil(Math.max(...near.map(x=>x.box.r))+50));
      b=Math.min(ih,Math.ceil(Math.max(...near.map(x=>x.box.b))+50));
    }
  }
  const sw=Math.max(60,r-x),sh=Math.max(60,b-y);
  const maxW=1500,scale=Math.min(1,maxW/sw);
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(sw*scale)); c.height=Math.max(1,Math.round(sh*scale));
  const ctx=c.getContext('2d');
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(img,x,y,sw,sh,0,0,c.width,c.height);
  return c;
}

async function canvasBlob(canvas){
  return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('画像変換失敗')),'image/jpeg',0.94));
}

function parseJsonText(raw){
  const s=String(raw||'').replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<=a) return null;
  try{return JSON.parse(s.slice(a,b+1));}catch(_){return null;}
}

function normalizeVlmObject(obj){
  if(!obj||typeof obj!=='object') return null;
  const pick=(...ks)=>{for(const k of ks){if(obj[k]!=null&&String(obj[k]).trim())return String(obj[k]);}return '';};
  return {
    contract:sanitizeField('contract',pick('工事名_委託件名','工事名・委託件名','委託件名','工事名','contract')),
    work:sanitizeField('work',pick('工種','作業内容','work')),
    place:sanitizeField('place',pick('測点','撮影場所','place')),
    state:sanitizeField('state',pick('状態','state')),
    remarks:sanitizeField('remarks',pick('備考','remarks')),
    contractor:cleanText(pick('請負者','施工者','contractor'))
  };
}

async function qwenAnalyze(canvas,paddleText){
  const {processor,model,RawImage}=await ensureQwen();
  const blob=await canvasBlob(canvas);
  const url=URL.createObjectURL(blob);
  try{
    let image=await RawImage.read(url);
    // OCR用途なので過度に縮小しない。巨大画像だけ抑える。
    if(image.width>1400){
      const h=Math.max(1,Math.round(image.height*1400/image.width));
      image=await image.resize(1400,h);
    }
    const prompt=`施工写真に写っている電子黒板だけを読み取ってください。\nラベルの位置と意味を見て対応付け、次のJSONだけを返してください。推測は禁止。不明・空欄は空文字にしてください。\n状態は 施工前,施工後,作業前,作業後,施工中,作業中,設置前,設置後,撤去前,撤去後,完成,完了 のいずれかが黒板に明記されている時だけ入れてください。\n請負者の会社名を測点・工種・備考へ入れないでください。\n{\"工事名_委託件名\":\"\",\"工種\":\"\",\"測点\":\"\",\"状態\":\"\",\"備考\":\"\",\"請負者\":\"\"}\n参考としてPaddleOCRが検出した文字は以下です。誤認識もあり得るので画像を優先してください。\n${paddleText}`;
    const conversation=[{role:'user',content:[{type:'image'},{type:'text',text:prompt}]}];
    const text=processor.apply_chat_template(conversation,{add_generation_prompt:true});
    const inputs=await processor(text,image);
    const outputs=await model.generate({...inputs,max_new_tokens:220,do_sample:false});
    const promptLen=inputs.input_ids?.dims?.at(-1)||0;
    const sliced=outputs.slice(null,[promptLen,null]);
    const decoded=processor.batch_decode(sliced,{skip_special_tokens:true});
    const raw=decoded?.[0]||'';
    return {data:normalizeVlmObject(parseJsonText(raw)),raw};
  } finally { URL.revokeObjectURL(url); }
}

function mergeResults(paddle,qwen){
  const q=qwen||{};
  const r={
    contract:q.contract||paddle.contract||'',
    work:q.work||paddle.work||'',
    place:q.place||paddle.place||'',
    state:q.state||paddle.state||'',
    remarks:q.remarks||paddle.remarks||''
  };
  // 明らかな誤配置は最後に落とす。
  if(/^(?:NTT|ＮＴＴ)?\s*西日本株式会社$/i.test(r.place)) r.place=paddle.place||'';
  if(r.work.length===1) r.work=paddle.work||'';
  if(!STATE_WORDS.includes(r.state)) r.state='';
  return r;
}

function applyResult(card,res,meta){
  const mapping=[['work',res.work],['place',res.place],['state',res.state],['remarks',res.remarks],['contract',res.contract||defaultContract?.value||'']];
  for(const [cls,val] of mapping){
    const input=card.querySelector('.'+cls);
    if(input){ input.value=val||''; dispatchChange(input); }
  }
  const raw=card.querySelector('.ocrRaw');
  if(raw) raw.textContent=`[PP-OCRv5]\n${meta.paddleRaw||''}\n\n[Qwen3-VL]\n${meta.qwenRaw||'(未使用 / 利用不可)'}`;
  const filled=[res.contract,res.work,res.place,res.state,res.remarks].filter(Boolean).length;
  const score=Math.min(99,60+filled*8+(meta.usedQwen?3:0));
  const badge=card.querySelector('.scoreBadge');
  if(badge) badge.textContent=`AI ${score}点`;
  const stateLabel=card.querySelector('.stateLabel');
  if(stateLabel){
    const ok=!!(res.work&&res.place);
    stateLabel.textContent=ok?'OK':'要確認';
  }
  card.classList.toggle('good',!!(res.work&&res.place));
  card.classList.toggle('review',!(res.work&&res.place));
  const key=keyOf(card);
  if(key) resultByKey.set(key,{res:{...res},meta:{...meta},score});
}

async function analyzeCard(card,useVlm){
  const img=card.querySelector('.thumb');
  if(!img?.src) throw new Error('写真が見つかりません');
  const badge=card.querySelector('.scoreBadge');
  if(badge) badge.textContent='Paddle解析中…';

  const ocr=await ensurePaddle();
  const [pResult]=await ocr.predict(img,{textRecScoreThresh:0.25,textDetBoxThresh:0.45,textDetUnclipRatio:1.8});
  const items=normalizePaddle(pResult);
  const p=fieldsFromPaddle(items);
  let qData=null,qRaw='';

  if(useVlm&&navigator.gpu){
    try{
      if(badge) badge.textContent='Qwen解析中…';
      const crop=cropFromItems(img,items);
      const q=await qwenAnalyze(crop,p.raw);
      qData=q.data; qRaw=q.raw;
    }catch(e){
      console.warn('Qwen3-VL fallback to PaddleOCR',e);
      qRaw='Qwen利用不可: '+(e?.message||String(e));
    }
  }

  const final=mergeResults(p,qData);
  applyResult(card,final,{paddleRaw:p.raw,qwenRaw:qRaw,usedQwen:!!qData});
}

function useVlmEnabled(){ return !!document.getElementById('v14UseVlm')?.checked && !!navigator.gpu; }
function pendingCards(){
  return cards().filter(card=>{
    const b=card.querySelector('.scoreBadge')?.textContent||'';
    const r=resultByKey.get(keyOf(card));
    return !r || /未解析|エラー/.test(b);
  });
}

async function runHighPrecision(list){
  if(running||!list.length) return;
  running=true;
  const start=performance.now(), useVlm=useVlmEnabled();
  try{
    for(let i=0;i<list.length;i++){
      const card=list[i];
      const name=card.querySelector('.filename')?.textContent||`写真${i+1}`;
      setProgress(i/list.length*100,`${i+1}/${list.length} ${name}`);
      try{ await analyzeCard(card,useVlm); }
      catch(e){
        console.error(e);
        const b=card.querySelector('.scoreBadge'); if(b)b.textContent='解析エラー';
        const raw=card.querySelector('.ocrRaw'); if(raw)raw.textContent=String(e?.message||e);
      }
    }
    setProgress(100,`完了 ${list.length}枚`);
    if(runtimeText) runtimeText.textContent=`高精度解析 ${((performance.now()-start)/1000).toFixed(1)}秒`;
    setEngine(useVlm?'PaddleOCR + Qwen解析完了':'PaddleOCR解析完了');
    setTimeout(hideProgress,1400);
  } finally { running=false; }
}

// 既存Tesseract解析ボタンをV14へ置き換える。
analyzePending.addEventListener('click',e=>{
  e.preventDefault();e.stopImmediatePropagation();
  runHighPrecision(pendingCards());
},true);
reanalyzeAll.addEventListener('click',e=>{
  e.preventDefault();e.stopImmediatePropagation();
  runHighPrecision(cards());
},true);

// 各カードの「再解析」もV14を優先。
root.addEventListener('click',e=>{
  const btn=e.target.closest('.reanalyze');
  if(!btn) return;
  const card=btn.closest('.card');
  if(!card) return;
  e.preventDefault();e.stopImmediatePropagation();
  runHighPrecision([card]);
},true);

function placeKey(card){
  return nfkc(card.querySelector('.place')?.value||'').replace(/\s+/g,' ').trim();
}
function stateRank(s){
  s=nfkc(s||'');
  if(/施工前|作業前|設置前|撤去前/.test(s)) return 0;
  if(/施工中|作業中/.test(s)) return 1;
  if(/施工後|作業後|設置後|撤去後|完成|完了/.test(s)) return 2;
  return 3;
}
function clickUp(btn){ btn?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); }
function reorderTo(desiredKeys){
  for(let target=0;target<desiredKeys.length;target++){
    const want=desiredKeys[target];
    let guard=0;
    while(guard++<desiredKeys.length+5){
      const now=cards();
      const pos=now.findIndex(c=>keyOf(c)===want);
      if(pos<0||pos<=target) break;
      clickUp(now[pos].querySelector('.up'));
    }
  }
}
function sortByPlace(){
  const now=cards();
  const indexed=now.map((card,i)=>({card,key:keyOf(card),i,place:placeKey(card),state:card.querySelector('.state')?.value||'',file:card.querySelector('.filename')?.textContent||''}));
  indexed.sort((a,b)=>{
    if(!a.place&&!b.place) return a.i-b.i;
    if(!a.place) return 1;
    if(!b.place) return -1;
    const p=a.place.localeCompare(b.place,'ja',{numeric:true,sensitivity:'base'});
    if(p) return p;
    const sr=stateRank(a.state)-stateRank(b.state); if(sr) return sr;
    const f=a.file.localeCompare(b.file,'ja',{numeric:true,sensitivity:'base'}); if(f) return f;
    return a.i-b.i;
  });
  reorderTo(indexed.map(x=>x.key));
  setTimeout(reapplyBadges,50);
}

function reapplyBadges(){
  for(const card of cards()){
    const saved=resultByKey.get(keyOf(card));
    if(!saved) continue;
    const badge=card.querySelector('.scoreBadge');
    if(badge) badge.textContent=`AI ${saved.score}点`;
    const sl=card.querySelector('.stateLabel');
    if(sl) sl.textContent=(saved.res.work&&saved.res.place)?'OK':'要確認';
  }
}

// 並べ替えや表示切替でapp.jsがカードを描き直してもV14の表示を維持。
new MutationObserver(()=>requestAnimationFrame(reapplyBadges)).observe(root,{childList:true,subtree:true});

const style=document.createElement('style');
style.textContent=`
.v14EnginePanel{margin-top:10px;padding:10px 12px;border:1px solid #dbeafe;background:#f8fbff;border-radius:12px}
.v14EngineLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.v14EngineTag{display:inline-flex;padding:3px 8px;border-radius:999px;background:#e0f2fe;color:#075985;font-size:11px;font-weight:800}
.v14Check{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700}
.v14Check input{width:auto}
.v14Note{font-size:11px;margin-top:5px}
#v14SortPlace{font-weight:700}
`;
document.head.appendChild(style);

ensureV14Controls();
setEngine(navigator.gpu?'高精度OCR待機':'PaddleOCR待機');

})();
