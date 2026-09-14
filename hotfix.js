(() => {
'use strict';

// V12 OCR geometry fix
// - keep multi-file input stable
// - the base detector often starts at 測点 and misses the two rows above it
// - recover the two horizontal separators above 測点 and remap OCR as:
//   1=委託件名/工事名  2=工種  3=測点  4=備考領域
// - keep full-photo export as CONTAIN (no crop)

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

const nativeDrawImage=CanvasRenderingContext2D.prototype.drawImage;
const rowState=new WeakMap();
const VALUE_X0=0.21;
const VALUE_X1=0.995;

function lum(d,i){return 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];}

function stateFor(image){
  let st=rowState.get(image);
  if(!st){
    st={calls:0,orig:Array(4).fill(null),measure:null,upper:null};
    rowState.set(image,st);
  }
  return st;
}

function findUpperSeparators(image,measure){
  try{
    const ctx=image.getContext('2d',{willReadFrequently:true});
    const x0=Math.max(0,Math.floor(measure.x));
    const sw=Math.max(40,Math.min(image.width-x0,Math.floor(measure.w)));
    const lookUp=Math.max(measure.h*4.2,measure.w*.34);
    const y0=Math.max(0,Math.floor(measure.y-lookUp));
    const y1=Math.min(image.height,Math.floor(measure.y+4));
    const sh=Math.max(8,y1-y0);
    const im=ctx.getImageData(x0,y0,sw,sh),d=im.data;
    const step=sw>700?2:1;
    const samples=Math.ceil(sw/step);
    const ys=[];
    for(let yy=0;yy<sh;yy++){
      let dark=0;
      for(let xx=0;xx<sw;xx+=step){
        const i=(yy*sw+xx)*4;
        if(lum(d,i)<135) dark++;
      }
      if(dark>=samples*.42) ys.push(y0+yy);
    }
    const groups=[];
    for(const y of ys){
      if(!groups.length||y-groups[groups.length-1][groups[groups.length-1].length-1]>2) groups.push([y]);
      else groups[groups.length-1].push(y);
    }
    const centers=groups
      .map(g=>Math.round(g.reduce((a,b)=>a+b,0)/g.length))
      .filter(y=>y<measure.y-3)
      .sort((a,b)=>a-b);

    if(centers.length>=2){
      const sep1=centers[centers.length-1];
      const top=centers[centers.length-2];
      const minGap=Math.max(8,measure.h*.35);
      if(sep1-top>=minGap&&measure.y-sep1>=minGap*.65){
        return {top,sep1};
      }
    }
  }catch(e){ console.warn('upper row scan failed',e); }

  // Fallback only when line scan fails. Top rows on this board are shorter than 測点.
  const rowH=Math.max(12,measure.h*.72);
  return {top:Math.max(0,measure.y-rowH*2),sep1:Math.max(0,measure.y-rowH)};
}

function rawRowIndex(image,current){
  const st=stateFor(image);
  if(st.calls<4){
    const idx=st.calls++;
    st.orig[idx]={...current};
    if(idx===0){
      st.measure={...current};
      st.upper=findUpperSeparators(image,current);
    }
    return idx;
  }
  let best=0,dist=Infinity;
  st.orig.forEach((g,i)=>{
    if(!g) return;
    const d=Math.abs(g.y-current.y);
    if(d<dist){dist=d;best=i;}
  });
  return best;
}

function semanticGeometry(image,row,current){
  const st=stateFor(image);
  const m=st.measure||st.orig[0]||current;
  if(!st.upper) st.upper=findUpperSeparators(image,m);
  const u=st.upper;
  const place=st.orig[0]||m;
  const remarks=st.orig[1]||current;

  if(row===0){
    return {x:m.x,y:u.top,w:m.w,h:Math.max(8,u.sep1-u.top)};
  }
  if(row===1){
    return {x:m.x,y:u.sep1,w:m.w,h:Math.max(8,m.y-u.sep1)};
  }
  if(row===2){
    return {x:place.x,y:place.y,w:place.w,h:place.h};
  }
  // The base detector's second row is the large 備考/状態 area.
  return {x:remarks.x,y:remarks.y,w:remarks.w,h:remarks.h};
}

function drawSemanticRow(ctx,image,row,g){
  const padY=Math.max(1,g.h*.07);
  const sx=g.x+g.w*VALUE_X0;
  const sw=Math.max(20,g.w*(VALUE_X1-VALUE_X0));
  const sy=g.y+padY;
  const sh=Math.max(8,g.h-padY*2);
  const c=ctx.canvas;
  c.width=2200;
  c.height=row===3?520:260;
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,c.width,c.height);
  return nativeDrawImage.call(ctx,image,sx,sy,sw,sh,0,0,c.width,c.height);
}

CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
  const c=this.canvas;

  const isRowOCR=
    c && image instanceof HTMLCanvasElement && args.length===8 &&
    args[4]===0 && args[5]===0 &&
    Math.abs(args[6]-c.width)<2 && Math.abs(args[7]-c.height)<2 &&
    Math.abs(c.width-args[2]*4)<6 && Math.abs(c.height-args[3]*4)<6 &&
    image.width>500 && image.height>400;

  if(isRowOCR){
    const current={x:+args[0],y:+args[1],w:+args[2],h:+args[3]};
    const row=rawRowIndex(image,current);
    const g=semanticGeometry(image,row,current);
    return drawSemanticRow(this,image,row,g);
  }

  // Make the debug popup show the whole board, not only the detected lower half.
  if(c && c.id==='debugCanvas' && image instanceof HTMLCanvasElement && args.length===8){
    const measure={x:+args[0],y:+args[1],w:+args[2],h:Math.max(8,(+args[3])*.20)};
    const u=findUpperSeparators(image,measure);
    const fullY=Math.max(0,u.top);
    const fullH=Math.max(20,(+args[1])+(+args[3])-fullY);
    c.width=Math.max(1,Math.round(args[2]));
    c.height=Math.max(1,Math.round(fullH));
    return nativeDrawImage.call(this,image,args[0],fullY,args[2],fullH,0,0,c.width,c.height);
  }

  const isPhotoExport=
    c && image instanceof HTMLCanvasElement && args.length===8 &&
    c.width===1600 && c.height>=825 && c.height<=835;

  if(isPhotoExport){
    const target=376/306;
    const outW=1600,outH=Math.round(outW/target);
    const sw=image.width,sh=image.height;
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
