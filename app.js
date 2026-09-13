(() => {
'use strict';
const P = window.PhotoBookParser;
const SLOT_STATUS_ROWS = [14,33,52,71,91,110,129,148,168,187,206,225,245,264,283,302,322,341,360,379];
const FRAME_RATIO = 3746500 / 1943100;
const items = [];
let worker = null;
let templateFile = null;
let busy = false;
const $ = id => document.getElementById(id);
const el = {
 folderInput:$('folderInput'), photoInput:$('photoInput'), analyzePending:$('analyzePending'), reanalyzeAll:$('reanalyzeAll'), sortDate:$('sortDate'), clearAll:$('clearAll'),
 templateInput:$('templateInput'), templateName:$('templateName'), makeExcel:$('makeExcel'), downloadCsv:$('downloadCsv'), cards:$('cards'), cardTpl:$('cardTpl'), emptyState:$('emptyState'),
 progressWrap:$('progressWrap'), progressBar:$('progressBar'), progressText:$('progressText'), engineBadge:$('engineBadge'), countText:$('countText'), reviewText:$('reviewText'), runtimeText:$('runtimeText'),
 defaultContract:$('defaultContract'), reviewThreshold:$('reviewThreshold'), mappingText:$('mappingText'), cropDialog:$('cropDialog'), closeDialog:$('closeDialog'), debugCanvas:$('debugCanvas'), debugText:$('debugText')
};
function uid(){return crypto.randomUUID ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(16).slice(2)}
function mapping(){ const out={}; for(const line of el.mappingText.value.split(/\r?\n/)){ const i=line.indexOf('='); if(i>0) out[line.slice(0,i).trim()]=line.slice(i+1).trim(); } return out; }
function setProgress(pct,text){ el.progressWrap.classList.remove('hidden'); el.progressBar.style.width=`${Math.max(0,Math.min(100,pct))}%`; el.progressText.textContent=text||''; }
function hideProgress(){ el.progressWrap.classList.add('hidden'); }
function fmtDate(d){ if(!d||isNaN(d)) return ''; const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
async function fileDate(file){
  try{
    const buf=await file.slice(0,256*1024).arrayBuffer(); const v=new DataView(buf); if(v.getUint16(0,false)!==0xFFD8) throw 0;
    let off=2;
    while(off+4<buf.byteLength){ if(v.getUint8(off)!==0xFF){off++;continue;} const m=v.getUint8(off+1); const len=v.getUint16(off+2,false); if(m===0xE1 && len>8){
      const start=off+4; const sig=String.fromCharCode(...new Uint8Array(buf,start,6)); if(sig.startsWith('Exif')){
        const tiff=start+6, le=v.getUint16(tiff,false)===0x4949; const u16=o=>v.getUint16(o,le), u32=o=>v.getUint32(o,le); const ifd0=tiff+u32(tiff+4);
        const readIFD=(pos)=>{const n=u16(pos); const a=[]; for(let i=0;i<n;i++){const p=pos+2+i*12; a.push({tag:u16(p),type:u16(p+2),count:u32(p+4),val:u32(p+8),p});} return a};
        let exifPtr=null; for(const e of readIFD(ifd0)) if(e.tag===0x8769) exifPtr=tiff+e.val;
        if(exifPtr){ for(const e of readIFD(exifPtr)){ if(e.tag===0x9003||e.tag===0x9004){ const p=tiff+e.val; const bytes=new Uint8Array(buf,p,Math.min(e.count,40)); const s=new TextDecoder('ascii').decode(bytes).replace(/\0.*$/,''); const m=s.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]); } } }
      }
    } if(!len||len<2) break; off += 2+len; }
  }catch(_){ }
  return new Date(file.lastModified||Date.now());
}
async function loadImage(file){ return await new Promise((resolve,reject)=>{ const url=URL.createObjectURL(file); const img=new Image(); img.onload=()=>{resolve({img,url});}; img.onerror=e=>{URL.revokeObjectURL(url);reject(e)}; img.src=url; }); }
function luminance(d,i){return 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]}
function detectBoard(canvas){
  const ctx=canvas.getContext('2d',{willReadFrequently:true}), w=canvas.width,h=canvas.height, data=ctx.getImageData(0,0,w,h).data;
  const regionW=Math.min(Math.floor(w*0.55),800), yStart=Math.floor(h*0.33), rows=[];
  for(let y=yStart;y<h;y++){let c=0; const base=y*w*4; for(let x=0;x<regionW;x++){if(luminance(data,base+x*4)<105)c++;} rows.push([y,c]);}
  const raw=rows.filter(r=>r[1]>regionW*.62).map(r=>r[0]);
  const groups=[]; for(const y of raw){ if(!groups.length||y-groups[groups.length-1][groups[groups.length-1].length-1]>2) groups.push([y]); else groups[groups.length-1].push(y); }
  let centers=groups.map(g=>Math.round(g.reduce((a,b)=>a+b,0)/g.length));
  const merged=[]; for(const y of centers){if(merged.length&&y-merged[merged.length-1]<9) merged[merged.length-1]=Math.round((merged[merged.length-1]+y)/2); else merged.push(y);} centers=merged.filter(y=>y>h*.48);
  if(centers.length>4) centers=centers.slice(-4);
  if(centers.length<4){ centers=[Math.round(h*.625),Math.round(h*.728),Math.round(h*.795),Math.round(h*.892)]; }
  const top=centers[0];
  const colCounts=[]; for(let x=0;x<regionW;x++){let c=0; for(let y=top;y<h;y++){const i=(y*w+x)*4;if(luminance(data,i)<105)c++;} colCounts.push(c);}
  const minX=Math.floor(w*.25), maxX=Math.floor(w*.52); let right=-1,best=0; for(let x=minX;x<Math.min(maxX,regionW);x++){ if(colCounts[x]>best){best=colCounts[x];right=x;} }
  if(right<0||best<(h-top)*.65) right=Math.round(w*.415);
  right=Math.min(w,Math.max(Math.round(w*.30),right+3));
  return {x:0,y:top,w:right,h:h-top, lines:[...centers,h], side:'left'};
}
function makeCanvasFromImage(img){ const c=document.createElement('canvas'); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height; c.getContext('2d').drawImage(img,0,0,c.width,c.height); return c; }
function rowCanvas(src, box, rowIndex, variant='gray'){
  const y0=box.lines[rowIndex], y1=box.lines[rowIndex+1], sx=box.x, sw=box.w, sh=Math.max(1,y1-y0);
  const scale=4, c=document.createElement('canvas'); c.width=sw*scale; c.height=sh*scale; const x=c.getContext('2d',{willReadFrequently:true}); x.imageSmoothingEnabled=true; x.imageSmoothingQuality='high'; x.drawImage(src,sx,y0,sw,sh,0,0,c.width,c.height);
  const im=x.getImageData(0,0,c.width,c.height), d=im.data; for(let i=0;i<d.length;i+=4){ let g=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; if(variant==='binary') g=g<175?0:255; else g=Math.max(0,Math.min(255,(g-128)*1.55+128)); d[i]=d[i+1]=d[i+2]=g; } x.putImageData(im,0,0); return c;
}
async function ensureWorker(){
  if(worker) return worker; if(!window.Tesseract) throw new Error('Tesseract.jsの読み込みに失敗しました。社内ネットワークでCDNが遮断されていないか確認してください。');
  el.engineBadge.textContent='OCR読込中';
  worker=await Tesseract.createWorker(['jpn','eng'], Tesseract.OEM.LSTM_ONLY, {logger:m=>{ if(m.status&&typeof m.progress==='number') el.runtimeText.textContent=`${m.status} ${Math.round(m.progress*100)}%`; }});
  await worker.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SINGLE_LINE,preserve_interword_spaces:'1'});
  el.engineBadge.textContent='OCR準備完了'; return worker;
}
async function recognizeRow(c){ const w=await ensureWorker(); const r=await w.recognize(c); return {text:(r.data.text||'').trim(), confidence:r.data.confidence||0}; }
function applyCustomMap(result){ const m=mapping(); if(result.remarks&&m[result.remarks]) result.place=m[result.remarks]; if(!result.contract) result.contract=el.defaultContract.value.trim(); return result; }
async function analyzeItem(item){
  item.status='analyzing'; render(); const loaded=await loadImage(item.file); try{
    const full=makeCanvasFromImage(loaded.img), box=detectBoard(full); item.board=box; const rows=[]; const confs=[];
    for(let r=0;r<4;r++){ const out=await recognizeRow(rowCanvas(full,box,r,'gray')); rows.push(out.text); confs.push(out.confidence); }
    let parsed=applyCustomMap(P.parseBoard(rows.join('\n'),item.file.name));
    if(!parsed.work){const o=await recognizeRow(rowCanvas(full,box,1,'binary')); rows[1]+='\n'+o.text; confs[1]=Math.max(confs[1],o.confidence);}
    if(!parsed.place){const o=await recognizeRow(rowCanvas(full,box,2,'binary')); rows[2]+='\n'+o.text; confs[2]=Math.max(confs[2],o.confidence);}
    if(!parsed.remarks){const o=await recognizeRow(rowCanvas(full,box,3,'binary')); rows[3]+='\n'+o.text; confs[3]=Math.max(confs[3],o.confidence);}
    parsed=applyCustomMap(P.parseBoard(rows.join('\n'),item.file.name));
    const avg=confs.reduce((a,b)=>a+b,0)/Math.max(1,confs.length); parsed.score=Math.round(Math.min(100, parsed.score*.72 + avg*.28));
    item.result=parsed; item.rawRows=rows; item.ocrConfidence=Math.round(avg); item.date=item.date||fmtDate(await fileDate(item.file)); item.status='done';
  } finally { URL.revokeObjectURL(loaded.url); render(); }
}
async function addFiles(list){
  const seen=new Set(items.map(i=>`${i.file.name}|${i.file.size}|${i.file.lastModified}|${i.file.webkitRelativePath||''}`));
  for(const f of list){ if(!/^image\//.test(f.type)&&!/[.](jpe?g|png|bmp|webp|tiff?)$/i.test(f.name))continue; const k=`${f.name}|${f.size}|${f.lastModified}|${f.webkitRelativePath||''}`; if(seen.has(k))continue; seen.add(k); items.push({id:uid(),file:f,status:'pending',result:{contract:'',work:'',place:'',state:'',remarks:'',score:0,rawText:''},date:fmtDate(await fileDate(f)),url:URL.createObjectURL(f)}); }
  render();
}
function reviewCount(){const th=+el.reviewThreshold.value||75; return items.filter(i=>i.status==='done'&&(i.result.score<th||!i.result.work||!i.result.place||!i.result.remarks)).length;}
function syncFromCard(item,card){ item.result.work=card.querySelector('.work').value.trim(); item.result.place=card.querySelector('.place').value.trim(); item.result.state=card.querySelector('.state').value.trim(); item.result.remarks=card.querySelector('.remarks').value.trim(); item.result.contract=card.querySelector('.contract').value.trim(); item.date=card.querySelector('.date').value; }
function render(){
  el.cards.innerHTML=''; el.emptyState.style.display=items.length?'none':'block'; const th=+el.reviewThreshold.value||75;
  items.forEach((item,idx)=>{ const f=el.cardTpl.content.cloneNode(true), card=f.querySelector('.card'), r=item.result||{}; const img=f.querySelector('.thumb'); img.src=item.url; f.querySelector('.filename').textContent=item.file.name; f.querySelector('.work').value=r.work||''; f.querySelector('.place').value=r.place||''; f.querySelector('.state').value=r.state||''; f.querySelector('.remarks').value=r.remarks||''; f.querySelector('.contract').value=r.contract||el.defaultContract.value||''; f.querySelector('.date').value=item.date||''; f.querySelector('.ocrRaw').textContent=(item.rawRows||[]).map((x,i)=>`ROW${i+1}: ${x}`).join('\n') || r.rawText || ''; const badge=f.querySelector('.scoreBadge'); badge.textContent=item.status==='analyzing'?'解析中…':item.status==='pending'?'未解析':`${Math.round(r.score||0)}点`; const review=item.status==='done'&&(r.score<th||!r.work||!r.place||!r.remarks); card.classList.toggle('review',review); card.classList.toggle('good',item.status==='done'&&!review); f.querySelector('.stateLabel').textContent=review?'要確認':item.status==='done'?'OK':item.status==='analyzing'?'解析中':'未解析';
    for(const inp of f.querySelectorAll('.fields input')) inp.addEventListener('change',()=>syncFromCard(item,card));
    f.querySelector('.remove').onclick=()=>{URL.revokeObjectURL(item.url);items.splice(idx,1);render();}; f.querySelector('.up').onclick=()=>{if(idx){[items[idx-1],items[idx]]=[items[idx],items[idx-1]];render();}}; f.querySelector('.down').onclick=()=>{if(idx<items.length-1){[items[idx+1],items[idx]]=[items[idx],items[idx+1]];render();}}; f.querySelector('.reanalyze').onclick=()=>runList([item]); f.querySelector('.debugCrop').onclick=()=>showDebug(item);
    el.cards.appendChild(f);
  });
  el.countText.textContent=`${items.length}枚`; el.reviewText.textContent=`要確認 ${reviewCount()}枚`;
}
async function runList(list){ if(busy||!list.length)return; busy=true; const start=performance.now(); try{ let n=0; for(const item of list){ n++; setProgress((n-1)/list.length*100,`${n}/${list.length} ${item.file.name}`); try{await analyzeItem(item);}catch(e){item.status='error';item.result.score=0;item.result.rawText=String(e&&e.message||e);render();} } setProgress(100,`完了 ${list.length}枚`); el.runtimeText.textContent=`${((performance.now()-start)/1000).toFixed(1)}秒`; setTimeout(hideProgress,1400);}finally{busy=false;} }
function showDebug(item){ if(!item.board)return alert('先に解析してください。'); const img=new Image(); img.onload=()=>{ const src=document.createElement('canvas'); src.width=img.naturalWidth; src.height=img.naturalHeight; src.getContext('2d').drawImage(img,0,0); const b=item.board,c=el.debugCanvas; c.width=b.w;c.height=b.h;c.getContext('2d').drawImage(src,b.x,b.y,b.w,b.h,0,0,b.w,b.h); el.debugText.textContent=(item.rawRows||[]).map((x,i)=>`ROW${i+1}: ${x}`).join('\n'); el.cropDialog.showModal();}; img.src=item.url; }
function csvEscape(s){s=String(s??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}
function downloadCsv(){const rows=[['No','ファイル','委託件名','工種','撮影場所','状態','備考','撮影日','判定点'],...items.map((i,n)=>[n+1,i.file.name,i.result.contract,i.result.work,i.result.place,i.result.state,i.result.remarks,i.date,i.result.score])]; const csv='\uFEFF'+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),'施工写真_OCR結果.csv');}
async function croppedBlob(item){ const loaded=await loadImage(item.file); try{ const src=makeCanvasFromImage(loaded.img), sw=src.width,sh=src.height, target=FRAME_RATIO, ratio=sw/sh; let sx=0,sy=0,cw=sw,ch=sh; if(ratio>target){cw=Math.round(sh*target); sx=item.board&&item.board.side==='right'?sw-cw:item.board&&item.board.side==='left'?0:Math.round((sw-cw)/2);} else if(ratio<target){ch=Math.round(sw/target); sy=Math.round((sh-ch)/2);} const out=document.createElement('canvas'); out.width=1600;out.height=Math.round(1600/target); out.getContext('2d').drawImage(src,sx,sy,cw,ch,0,0,out.width,out.height); return await new Promise(r=>out.toBlob(r,'image/jpeg',.9)); } finally {URL.revokeObjectURL(loaded.url);} }
function xmlDoc(s){return new DOMParser().parseFromString(s,'application/xml')}
function xmlText(doc){return new XMLSerializer().serializeToString(doc)}
function q(doc,sel){return doc.querySelector(sel)}
function all(doc,sel){return [...doc.querySelectorAll(sel)]}
function createNS(doc,ns,name){return doc.createElementNS(ns,name)}
function setCellInline(doc,ref,text){ const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'; let c=all(doc,'c').find(x=>x.getAttribute('r')===ref); if(!c)return; [...c.children].forEach(ch=>{if(['f','v','is'].includes(ch.localName))ch.remove()}); if(text===null||text===undefined||text===''){c.removeAttribute('t');return;} c.setAttribute('t','inlineStr'); const is=createNS(doc,ns,'is'),t=createNS(doc,ns,'t'); t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve'); t.textContent=String(text); is.appendChild(t);c.appendChild(is); }
function prepareSheetXml(baseXml, groupItems, extra){ const doc=xmlDoc(baseXml), ws=doc.documentElement; if(extra){ all(doc,'legacyDrawing').forEach(n=>n.remove()); all(doc,'drawing').forEach(n=>n.remove()); all(doc,'AlternateContent').forEach(n=>{if(n.textContent.includes('ResizePictures')||n.querySelector('controls')) n.remove();}); const sp=q(doc,'sheetPr'); if(sp) sp.removeAttribute('codeName'); const dr=createNS(doc,'http://schemas.openxmlformats.org/spreadsheetml/2006/main','drawing'); dr.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id','rId2'); ws.appendChild(dr); }
  SLOT_STATUS_ROWS.forEach((sr,i)=>{ const it=groupItems[i]; const rows={contract:sr-10,place:sr-6,work:sr-3,state:sr,date:sr+3}; setCellInline(doc,`L${rows.work}`,'工種'); if(it){ setCellInline(doc,`M${rows.contract}`,it.result.contract||el.defaultContract.value); setCellInline(doc,`M${rows.place}`,it.result.place); setCellInline(doc,`M${rows.work}`,it.result.work); setCellInline(doc,`M${rows.state}`,it.result.state); setCellInline(doc,`M${rows.date}`,it.date); } else { for(const rr of Object.values(rows)) setCellInline(doc,`M${rr}`,''); } }); return xmlText(doc); }
function pictureAnchor(relId,id,slotIndex){ const sr=SLOT_STATUS_ROWS[slotIndex], top=sr-11, bottom=sr+5; const rowFrom=top-1,rowTo=bottom; return `<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${rowFrom}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${rowTo}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="施工写真 ${id}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}" cstate="print"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`; }
function emptyDrawing(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>`}
function appendPictures(drawXml, groupItems, globalStart){ let s=drawXml; const close='</xdr:wsDr>'; const at=s.lastIndexOf(close); let add=''; groupItems.forEach((_,i)=>add+=pictureAnchor(`rIdPhoto${i+1}`,2000+globalStart+i,i)); return s.slice(0,at)+add+s.slice(at); }
function drawingRels(groupItems,globalStart){ const rels=groupItems.map((_,i)=>`<Relationship Id="rIdPhoto${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/photo${globalStart+i+1}.jpeg"/>`).join(''); return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`; }
async function makeExcel(){
  if(!items.length)return alert('写真がありません。'); if(!templateFile)return alert('Excelテンプレート（xlsm/xlsx）を選択してください。'); const pending=items.filter(i=>i.status!=='done'); if(pending.length) await runList(pending);
  const bad=reviewCount(); if(bad && !confirm(`要確認が ${bad}枚 あります。このままExcelを作成しますか？`))return;
  if(!window.JSZip)return alert('Excel作成ライブラリの読み込みに失敗しました。'); busy=true; setProgress(0,'Excel作成準備'); try{
    const zip=await JSZip.loadAsync(await templateFile.arrayBuffer()); const baseSheet=await zip.file('xl/worksheets/sheet1.xml').async('string'); const baseDrawing=zip.file('xl/drawings/drawing1.xml')?await zip.file('xl/drawings/drawing1.xml').async('string'):emptyDrawing();
    const groups=[]; for(let i=0;i<items.length;i+=20) groups.push(items.slice(i,i+20));
    const wb=xmlDoc(await zip.file('xl/workbook.xml').async('string')), rel=xmlDoc(await zip.file('xl/_rels/workbook.xml.rels').async('string')), ct=xmlDoc(await zip.file('[Content_Types].xml').async('string'));
    const sheets=q(wb,'sheets'), firstSheet=all(wb,'sheet')[0]; firstSheet.setAttribute('name','施工写真_001'); const relIds=all(rel,'Relationship').map(x=>x.getAttribute('Id')).filter(Boolean).map(x=>+x.replace(/\D/g,'')).filter(Number.isFinite); let nextRel=Math.max(6,...relIds)+1; const sheetIds=all(wb,'sheet').map(x=>+x.getAttribute('sheetId')||0); let nextSheetId=Math.max(1,...sheetIds)+1;
    const ctRoot=ct.documentElement, ctNs='http://schemas.openxmlformats.org/package/2006/content-types'; if(!all(ct,'Default').some(x=>x.getAttribute('Extension')==='jpeg')){const d=createNS(ct,ctNs,'Default');d.setAttribute('Extension','jpeg');d.setAttribute('ContentType','image/jpeg');ctRoot.appendChild(d);} const dn=q(wb,'definedNames'); if(dn){all(dn,'definedName').filter(x=>x.getAttribute('name')==='_xlnm.Print_Area').forEach(x=>x.remove());}
    for(let g=0;g<groups.length;g++){
      const n=g+1, sheetPath=`xl/worksheets/sheet${n}.xml`, drawPath=`xl/drawings/drawing${n}.xml`; if(g===0){zip.file(sheetPath,prepareSheetXml(baseSheet,groups[g],false));} else {
        zip.file(sheetPath,prepareSheetXml(baseSheet,groups[g],true)); const rId=`rId${nextRel++}`; const sh=createNS(wb,'http://schemas.openxmlformats.org/spreadsheetml/2006/main','sheet'); sh.setAttribute('name',`施工写真_${String(n).padStart(3,'0')}`);sh.setAttribute('sheetId',String(nextSheetId++));sh.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id',rId);sheets.appendChild(sh); const rr=createNS(rel,'http://schemas.openxmlformats.org/package/2006/relationships','Relationship');rr.setAttribute('Id',rId);rr.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');rr.setAttribute('Target',`worksheets/sheet${n}.xml`);rel.documentElement.appendChild(rr); const ov=createNS(ct,ctNs,'Override');ov.setAttribute('PartName',`/xl/worksheets/sheet${n}.xml`);ov.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');ctRoot.appendChild(ov); const srels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`; zip.file(`xl/worksheets/_rels/sheet${n}.xml.rels`,srels); }
      const start=g*20; zip.file(drawPath,appendPictures(g===0?baseDrawing:emptyDrawing(),groups[g],start)); zip.file(`xl/drawings/_rels/drawing${n}.xml.rels`,drawingRels(groups[g],start)); if(g>0){const ovd=createNS(ct,ctNs,'Override');ovd.setAttribute('PartName',`/xl/drawings/drawing${n}.xml`);ovd.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.drawing+xml');ctRoot.appendChild(ovd);}
      let dns=q(wb,'definedNames'); if(!dns){dns=createNS(wb,'http://schemas.openxmlformats.org/spreadsheetml/2006/main','definedNames');q(wb,'calcPr')?.before(dns)||wb.documentElement.appendChild(dns);} const dname=createNS(wb,'http://schemas.openxmlformats.org/spreadsheetml/2006/main','definedName');dname.setAttribute('name','_xlnm.Print_Area');dname.setAttribute('localSheetId',String(g));dname.textContent=`'施工写真_${String(n).padStart(3,'0')}'!$B$1:$P$385`;dns.appendChild(dname);
    }
    const calc=q(wb,'calcPr'); if(calc){calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');}
    zip.file('xl/workbook.xml',xmlText(wb)); zip.file('xl/_rels/workbook.xml.rels',xmlText(rel)); zip.file('[Content_Types].xml',xmlText(ct));
    for(let i=0;i<items.length;i++){setProgress(20+70*(i/items.length),`写真 ${i+1}/${items.length} をExcel用に処理`); zip.file(`xl/media/photo${i+1}.jpeg`,await croppedBlob(items[i]));}
    setProgress(94,'Excelファイル圧縮中'); const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}},m=>setProgress(94+m.percent*.06,'Excelファイル圧縮中'));
    const ext=templateFile.name.toLowerCase().endsWith('.xlsm')?'xlsm':'xlsx'; const stamp=new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);downloadBlob(blob,`施工写真_完成_${stamp}.${ext}`);setProgress(100,'Excel作成完了');setTimeout(hideProgress,1600);
  }catch(e){console.error(e);alert('Excel作成エラー: '+(e.message||e));hideProgress();}finally{busy=false;}
}
el.folderInput.onchange=e=>{addFiles(e.target.files);e.target.value=''};el.photoInput.onchange=e=>{addFiles(e.target.files);e.target.value=''};el.templateInput.onchange=e=>{templateFile=e.target.files[0]||null;el.templateName.textContent=templateFile?templateFile.name:'未選択'};el.analyzePending.onclick=()=>runList(items.filter(i=>i.status!=='done'));el.reanalyzeAll.onclick=()=>{items.forEach(i=>i.status='pending');runList([...items])};el.sortDate.onclick=()=>{items.sort((a,b)=>(a.date||'').localeCompare(b.date||''));render()};el.clearAll.onclick=()=>{if(items.length&&confirm('写真を全て削除しますか？')){items.forEach(i=>URL.revokeObjectURL(i.url));items.length=0;render();}};el.downloadCsv.onclick=downloadCsv;el.makeExcel.onclick=makeExcel;el.reviewThreshold.oninput=render;el.closeDialog.onclick=()=>el.cropDialog.close();
window.addEventListener('beforeunload',()=>{for(const i of items)URL.revokeObjectURL(i.url);worker?.terminate?.();});render();
})();
