(() => {
'use strict';

// V10 OCR hotfix
// - keep multi-file input stable
// - normalize OCR rows WITHOUT hard-coding blackboard to x=0 / image bottom
// - reuse detected geometry only when the same-resolution photos actually agree
// - strengthen work-type recovery
// - never crop the construction photo when creating the Excel image

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

const P=window.PhotoBookParser;
if(P&&typeof P.parseBoard==='function'&&!P.__v10WorkWrapped){
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
  P.__v10WorkWrapped=true;
}

const nativeDrawImage=CanvasRenderingContext2D.prototype.drawImage;
const rowState=new WeakMap();
const profileBySize=new Map();
const VALUE_X0=0.24;
const VALUE_X1=0.995;

function rowIndexFor(image,sy){
  let st=rowState.get(image);
  if(!st){st={initial:[],calls:0};rowState.set(image,st);}
  if(st.calls<4){
    const idx=st.calls++;
    st.initial[idx]=sy;
    return idx;
  }
  let best=0,dist=Infinity;
  st.initial.forEach((v,i)=>{const d=Math.abs((v??sy)-sy); if(d<dist){dist=d;best=i;}});
  return best;
}

function stableGeometry(image,row,cur){
  const key=`${image.width}x${image.height}`;
  let p=profileBySize.get(key);
  if(!p){p={rows:Array(4).fill(null)};profileBySize.set(key,p);}
  const old=p.rows[row];
  if(!old){p.rows[row]={...cur};return cur;}

  const close =
    Math.abs(cur.x-old.x) <= Math.max(12,old.w*.08) &&
    Math.abs(cur.w-old.w) <= Math.max(14,old.w*.10) &&
    Math.abs(cur.y-old.y) <= Math.max(14,image.height*.045) &&
    Math.abs(cur.h-old.h) <= Math.max(10,old.h*.28);

  // Same overlay/resolution: smooth tiny detector jitter. If geometry really moved,
  // trust the current detector instead of forcing the old profile.
  if(close){
    const merged={
      x:old.x*.82+cur.x*.18,
      y:old.y*.82+cur.y*.18,
      w:old.w*.82+cur.w*.18,
      h:old.h*.82+cur.h*.18
    };
    p.rows[row]=merged;
    return merged;
  }
  return cur;
}

CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
  const c=this.canvas;

  // rowCanvas() from app.js. Keep app.js's actual detected x/y/w/h and only
  // normalize scale + value-column crop. This avoids the old catastrophic
  // assumption that every blackboard starts at x=0 and touches the bottom edge.
  const isRowOCR=
    c && image instanceof HTMLCanvasElement && args.length===8 &&
    args[4]===0 && args[5]===0 &&
    Math.abs(args[6]-c.width)<2 && Math.abs(args[7]-c.height)<2 &&
    Math.abs(c.width-args[2]*4)<6 && Math.abs(c.height-args[3]*4)<6 &&
    image.width>500 && image.height>400;

  if(isRowOCR){
    const row=rowIndexFor(image,args[1]);
    const current={x:+args[0],y:+args[1],w:+args[2],h:+args[3]};
    const g=stableGeometry(image,row,current);

    const padY=Math.max(1,g.h*.08);
    const sx=g.x+g.w*VALUE_X0;
    const sw=Math.max(20,g.w*(VALUE_X1-VALUE_X0));
    const sy=g.y+padY;
    const sh=Math.max(8,g.h-padY*2);

    c.width=2200;
    c.height=260;
    this.imageSmoothingEnabled=true;
    this.imageSmoothingQuality='high';
    this.fillStyle='#fff';
    this.fillRect(0,0,c.width,c.height);
    return nativeDrawImage.call(this,image,sx,sy,sw,sh,0,0,c.width,c.height);
  }

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
