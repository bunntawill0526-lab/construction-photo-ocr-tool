(() => {
'use strict';

// 1) multiple-file selection: keep a stable Array before the real <input> is cleared.
function stabilizeFileInput(id){
  const input=document.getElementById(id);
  if(!input||typeof input.onchange!=='function') return;
  const original=input.onchange;
  input.onchange=e=>{
    const files=Array.from(e.target.files||[]);
    e.target.value='';
    return original({target:{files,value:''}});
  };
}
stabilizeFileInput('folderInput');
stabilizeFileInput('photoInput');

// 2) work-type recovery. Keep normal OCR first, then repair common OCR errors.
const P=window.PhotoBookParser;
if(P&&typeof P.parseBoard==='function'){
  const originalParse=P.parseBoard.bind(P);
  P.parseBoard=(text,filename='')=>{
    const r=originalParse(text,filename);
    if(!r.work){
      const t=String(text||'').normalize('NFKC').replace(/\s+/g,'');
      if(/撤去/.test(t)) r.work=/AP|無線/i.test(t)?'無線AP撤去':'機器撤去';
      else if(/設[置宣]/.test(t)){
        if(/AP|無線/i.test(t)) r.work='無線AP設置';
        else if(/SW|スイッチ/i.test(t)) r.work='スイッチ設置';
        else r.work='機器設置';
      } else if(/成端/.test(t)) r.work='成端';
      else if(/試験/.test(t)) r.work='試験';
      else if(/LAN/i.test(t)&&/配線/.test(t)) r.work='LAN配線';
      else if(/光/.test(t)&&/(敷設|配線)/.test(t)) r.work='光ケーブル敷設';
      else if(/配線/.test(t)) r.work='配線';
      // Current project note-code families are installation photos; use only as last fallback.
      else if(/^(YM|KR|TC2|BJ)-/i.test(r.remarks||'')) r.work='機器設置';
    }
    return r;
  };
}

// 3) Excel photo frame hotfix.
// Old app rendered export images at 1600x830 (ratio ~1.928), but the actual D:J template frame is ~376x306 (ratio ~1.22876).
// Intercept only that export canvas and redraw from the ORIGINAL source canvas at the correct ratio.
const nativeDrawImage=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
  const c=this.canvas;
  const isOldExportCanvas=c&&c.width===1600&&c.height>=825&&c.height<=835&&image instanceof HTMLCanvasElement&&args.length===8;
  if(!isOldExportCanvas) return nativeDrawImage.call(this,image,...args);

  const target=376/306;
  const outW=1600, outH=Math.round(outW/target);
  const sw=image.width, sh=image.height, ratio=sw/sh;
  c.height=outH;
  this.fillStyle='#fff'; this.fillRect(0,0,outW,outH);

  let sx=0,sy=0,cw=sw,ch=sh,contain=false;
  if(ratio>target){
    cw=Math.round(sh*target);
    const loss=1-cw/sw;
    if(loss>.20) contain=true;
    else {
      // Electronic blackboards in these construction photos are normally at lower left/right.
      // Scan lower half and keep the darker side so the board is not cropped away.
      try{
        const x=image.getContext('2d',{willReadFrequently:true});
        const y0=Math.floor(sh*.50), sampleH=Math.max(1,sh-y0), band=Math.max(1,Math.floor(sw*.28));
        const score=(x0)=>{const d=x.getImageData(x0,y0,band,sampleH).data;let n=0;for(let i=0;i<d.length;i+=16){const g=.2126*d[i]+.7152*d[i+1]+.0722*d[i+2];if(g<95)n++;}return n;};
        const l=score(0), rr=score(sw-band);
        sx=l>rr*1.12?0:rr>l*1.12?sw-cw:Math.round((sw-cw)/2);
      }catch(_){sx=Math.round((sw-cw)/2);}
    }
  } else if(ratio<target){
    ch=Math.round(sw/target);
    const loss=1-ch/sh;
    if(loss>.20) contain=true;
    else sy=Math.round((sh-ch)/2);
  }

  if(contain){
    const scale=Math.min(outW/sw,outH/sh),dw=Math.round(sw*scale),dh=Math.round(sh*scale),dx=Math.round((outW-dw)/2),dy=Math.round((outH-dh)/2);
    return nativeDrawImage.call(this,image,0,0,sw,sh,dx,dy,dw,dh);
  }
  return nativeDrawImage.call(this,image,sx,sy,cw,ch,0,0,outW,outH);
};
})();
