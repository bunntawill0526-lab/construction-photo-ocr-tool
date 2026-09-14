(() => {
'use strict';

// V4 hotfix
// - stabilise multi-file input
// - normalise this project's fixed electronic-blackboard rows before OCR
// - strengthen work-type recovery
// - NEVER crop the construction photo when creating the Excel image

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

// Parser recovery. OCR is still the source; this only repairs likely reading errors.
const P=window.PhotoBookParser;
if(P&&typeof P.parseBoard==='function'){
  const originalParse=P.parseBoard.bind(P);
  P.parseBoard=(text,filename='')=>{
    const r=originalParse(text,filename);
    const t=String(text||'').normalize('NFKC').replace(/[\s　]+/g,'');
    if(!r.work){
      if(/撤去/.test(t)) r.work=/AP|無線/i.test(t)?'無線AP撤去':'機器撤去';
      else if(/機.?器/.test(t)&&!/(撤去|取外|取り外)/.test(t)) r.work='機器設置';
      else if(/設[置宣直買]/.test(t)){
        if(/AP|無線/i.test(t)) r.work='無線AP設置';
        else if(/SW|スイッチ/i.test(t)) r.work='スイッチ設置';
        else r.work='機器設置';
      } else if(/成端/.test(t)) r.work='成端';
      else if(/試験/.test(t)) r.work='試験';
      else if(/LAN/i.test(t)&&/配線/.test(t)) r.work='LAN配線';
      else if(/光/.test(t)&&/(敷設|配線)/.test(t)) r.work='光ケーブル敷設';
      else if(/配線/.test(t)) r.work='配線';
      else if(/^(YM|KR|TC2|BJ)-/i.test(r.remarks||'')) r.work='機器設置';
    }
    return r;
  };
}

const nativeDrawImage=CanvasRenderingContext2D.prototype.drawImage;

// The blackboard overlay used in these photos has the same pixel layout.
// Instead of trusting per-photo line detection, use the first detected width for
// each source resolution and crop the four upper rows at fixed proportions.
const boardWidthBySize=new Map();
const rowState=new WeakMap();
const ROW_BOUNDS=[0,0.278,0.455,0.716,1.0];
const FULL_BOARD_H_PER_W=0.75;
const TOP4_H_PER_W=0.471;
const VALUE_X0_PER_W=0.255;
const VALUE_X1_PER_W=0.992;

function rememberBoardWidth(image,detected){
  const key=`${image.width}x${image.height}`;
  const sane=Math.max(image.width*.30,Math.min(image.width*.50,detected));
  const old=boardWidthBySize.get(key);
  if(!old){boardWidthBySize.set(key,sane);return sane;}
  // Ignore one-off detection jumps. The overlay resolution is fixed.
  const ratio=sane/old;
  if(ratio>.93&&ratio<1.07){const merged=old*.8+sane*.2;boardWidthBySize.set(key,merged);return merged;}
  return old;
}

function fixedRowIndex(image,sy){
  let st=rowState.get(image);
  if(!st){st={initial:[],calls:0};rowState.set(image,st);}
  if(st.calls<4){
    const idx=st.calls++;
    st.initial[idx]=sy;
    return idx;
  }
  let best=0,dist=Infinity;
  st.initial.forEach((v,i)=>{const d=Math.abs((v??sy)-sy);if(d<dist){dist=d;best=i;}});
  return best;
}

CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
  const c=this.canvas;

  // rowCanvas() in app.js: source is the full-photo canvas, destination is 4x the detected row.
  const isRowOCR=
    c && image instanceof HTMLCanvasElement && args.length===8 &&
    args[4]===0 && args[5]===0 &&
    Math.abs(args[6]-c.width)<2 && Math.abs(args[7]-c.height)<2 &&
    Math.abs(c.width-args[2]*4)<6 && Math.abs(c.height-args[3]*4)<6 &&
    image.width>500 && image.height>400;

  if(isRowOCR){
    const detectedW=args[2];
    const boardW=rememberBoardWidth(image,detectedW);
    const row=fixedRowIndex(image,args[1]);
    const boardTop=image.height-boardW*FULL_BOARD_H_PER_W;
    const top4H=boardW*TOP4_H_PER_W;
    const yA=boardTop+top4H*ROW_BOUNDS[row];
    const yB=boardTop+top4H*ROW_BOUNDS[row+1];
    const rowH=Math.max(10,yB-yA);
    const padY=Math.max(2,rowH*.10);
    const sx=boardW*VALUE_X0_PER_W;
    const sw=boardW*(VALUE_X1_PER_W-VALUE_X0_PER_W);
    const sy=yA+padY;
    const sh=Math.max(8,rowH-padY*2);

    // Give Tesseract the same geometry every time, independent of line-detection jitter.
    c.width=2200;
    c.height=260;
    this.imageSmoothingEnabled=true;
    this.imageSmoothingQuality='high';
    this.fillStyle='#fff';
    this.fillRect(0,0,c.width,c.height);
    return nativeDrawImage.call(this,image,sx,sy,sw,sh,0,0,c.width,c.height);
  }

  // croppedBlob() in app.js originally uses a 1600x~830 export canvas.
  // Replace that operation with true CONTAIN. No source pixels are discarded.
  const isPhotoExport=
    c && image instanceof HTMLCanvasElement && args.length===8 &&
    c.width===1600 && c.height>=825 && c.height<=835;

  if(isPhotoExport){
    const target=376/306;
    const outW=1600, outH=Math.round(outW/target);
    const sw=image.width, sh=image.height;
    c.height=outH;
    this.imageSmoothingEnabled=true;
    this.imageSmoothingQuality='high';
    this.fillStyle='#fff';
    this.fillRect(0,0,outW,outH);
    const scale=Math.min(outW/sw,outH/sh);
    const dw=Math.round(sw*scale),dh=Math.round(sh*scale);
    const dx=Math.round((outW-dw)/2),dy=Math.round((outH-dh)/2);
    return nativeDrawImage.call(this,image,0,0,sw,sh,dx,dy,dw,dh);
  }

  return nativeDrawImage.call(this,image,...args);
};

})();
