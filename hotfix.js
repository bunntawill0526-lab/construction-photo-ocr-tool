(() => {
'use strict';

// V13 OCR geometry
// The old base detector starts too low on some blackboards.  Do not infer the
// upper rows from that start point.  Instead scan the whole lower-left board
// for its long horizontal grid lines, detect the label/value separator, then
// always feed Tesseract the semantic rows:
//   1 = 委託件名 / 工事名
//   2 = 工種
//   3 = 測点
//   4 = 備考 / 状態 area
// This remains project-name/building-name agnostic.

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
const stateMap=new WeakMap();

function lum(d,i){ return 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; }
function median(a){ const b=[...a].sort((x,y)=>x-y); return b.length?b[Math.floor(b.length/2)]:0; }

function groupCenters(vals,mergeGap){
  const groups=[];
  for(const v of vals){
    if(!groups.length || v-groups[groups.length-1][groups[groups.length-1].length-1]>2) groups.push([v]);
    else groups[groups.length-1].push(v);
  }
  let centers=groups.map(g=>Math.round(g.reduce((a,b)=>a+b,0)/g.length));
  const merged=[];
  for(const y of centers){
    if(merged.length && y-merged[merged.length-1] < mergeGap){
      merged[merged.length-1]=Math.round((merged[merged.length-1]+y)/2);
    }else merged.push(y);
  }
  return merged;
}

function scanHorizontalLines(image,x0,bw,threshold){
  const ctx=image.getContext('2d',{willReadFrequently:true});
  const h=image.height;
  const yStart=Math.max(0,Math.floor(h-Math.max(bw*1.18,h*.72)));
  const sw=Math.max(40,Math.min(image.width-x0,Math.floor(bw)));
  const sh=h-yStart;
  const im=ctx.getImageData(x0,yStart,sw,sh),d=im.data;
  const stepX=Math.max(1,Math.floor(sw/720));
  const samples=Math.ceil(sw/stepX);
  const ys=[];
  for(let yy=0;yy<sh;yy++){
    let dark=0;
    for(let xx=0;xx<sw;xx+=stepX){
      if(lum(d,(yy*sw+xx)*4)<145) dark++;
    }
    if(dark>=samples*threshold) ys.push(yStart+yy);
  }
  return groupCenters(ys,Math.max(5,Math.round(bw*.018)));
}

function detectSeparatorX(image,x0,bw,top,bottom){
  try{
    const ctx=image.getContext('2d',{willReadFrequently:true});
    const sx=Math.max(0,Math.floor(x0+bw*.10));
    const ex=Math.min(image.width-1,Math.floor(x0+bw*.36));
    const sy=Math.max(0,Math.floor(top));
    const ey=Math.min(image.height-1,Math.floor(bottom));
    const sw=Math.max(2,ex-sx+1),sh=Math.max(2,ey-sy+1);
    const im=ctx.getImageData(sx,sy,sw,sh),d=im.data;
    const stepY=Math.max(1,Math.floor(sh/650));
    let bestX=-1,best=0;
    for(let xx=0;xx<sw;xx++){
      let dark=0,total=0;
      for(let yy=0;yy<sh;yy+=stepY){ total++; if(lum(d,(yy*sw+xx)*4)<135) dark++; }
      const ratio=dark/Math.max(1,total);
      if(ratio>best){ best=ratio; bestX=sx+xx; }
    }
    if(bestX>=0 && best>.43) return bestX;
  }catch(e){ console.warn('separator scan failed',e); }
  return Math.round(x0+bw*.225);
}

function detectFullBoard(image,current){
  const x0=Math.max(0,Math.floor(current.x));
  const bw=Math.max(80,Math.min(image.width-x0,Math.floor(current.w)));
  let lines=scanHorizontalLines(image,x0,bw,.46);
  if(lines.length<5) lines=scanHorizontalLines(image,x0,bw,.34);

  // The electronic board is at the bottom.  Keep only its final grid sequence.
  // Add the image bottom when the outer bottom rule is clipped by the photo edge.
  const h=image.height;
  lines=lines.filter(y=>y>h*.20 && y<=h-1);
  if(lines.length && h-1-lines[lines.length-1] > Math.max(4,bw*.025) && h-1-lines[lines.length-1] < bw*.22){
    lines.push(h-1);
  }

  // Outer borders are sometimes double rules. Collapse again with a wider gap.
  const compact=[];
  for(const y of lines){
    if(compact.length && y-compact[compact.length-1] < Math.max(6,bw*.025)) compact[compact.length-1]=Math.round((compact[compact.length-1]+y)/2);
    else compact.push(y);
  }
  lines=compact;

  // Expected board grid: top, after contract, after work, after place,
  // before contractor, bottom.  Long-line scanning usually yields these 6.
  if(lines.length>6) lines=lines.slice(-6);

  if(lines.length<6){
    // Geometry fallback uses the board width only, never a project-specific name.
    // Ratios match the common electronic-board form and are used only if the
    // actual grid lines cannot be recovered from pixels.
    const bottom=lines.length?lines[lines.length-1]:h-1;
    const boardH=Math.min(bottom,Math.round(bw*.76));
    const top=Math.max(0,bottom-boardH);
    lines=[
      top,
      Math.round(top+boardH*.13),
      Math.round(top+boardH*.25),
      Math.round(top+boardH*.37),
      Math.round(top+boardH*.86),
      bottom
    ];
  }

  const sepX=detectSeparatorX(image,x0,bw,lines[0],lines[4]);
  return {x:x0,w:bw,lines,sepX};
}

function stateFor(image,current){
  let st=stateMap.get(image);
  if(!st){
    st={calls:0,orig:Array(4).fill(null),profile:detectFullBoard(image,current)};
    stateMap.set(image,st);
  }
  return st;
}

function rowIndexFor(image,current){
  const st=stateFor(image,current);
  if(st.calls<4){
    const idx=st.calls++;
    st.orig[idx]={...current};
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
  const st=stateFor(image,current),p=st.profile,l=p.lines;
  const y0=l[row], y1=l[row+1];
  const xPad=Math.max(2,p.w*.012);
  const left=Math.min(p.x+p.w-20,Math.max(p.x,p.sepX+xPad));
  return {
    x:left,
    y:y0,
    w:Math.max(20,p.x+p.w-left-xPad),
    h:Math.max(8,y1-y0)
  };
}

function drawSemanticRow(ctx,image,row,g){
  const padY=Math.max(1,g.h*(row===3?.045:.08));
  const sx=g.x, sw=g.w;
  const sy=g.y+padY, sh=Math.max(8,g.h-padY*2);
  const c=ctx.canvas;
  c.width=2400;
  c.height=row===3?640:300;
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
    const row=rowIndexFor(image,current);
    const g=semanticGeometry(image,row,current);
    return drawSemanticRow(this,image,row,g);
  }

  // Debug popup: show the actual complete grid that V13 uses.
  if(c && c.id==='debugCanvas' && image instanceof HTMLCanvasElement && args.length===8){
    const current={x:+args[0],y:+args[1],w:+args[2],h:+args[3]};
    const p=stateFor(image,current).profile,l=p.lines;
    const top=l[0],bottom=l[l.length-1];
    c.width=Math.max(1,Math.round(p.w));
    c.height=Math.max(1,Math.round(bottom-top));
    return nativeDrawImage.call(this,image,p.x,top,p.w,bottom-top,0,0,c.width,c.height);
  }

  // Excel photo export is contain-only: never throw away source pixels.
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
