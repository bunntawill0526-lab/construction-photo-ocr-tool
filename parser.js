(function(global){
  'use strict';
  const WORK_TYPES = ['機器設置','機器撤去','無線AP設置','AP設置','スイッチ設置','SW設置','LAN配線','光ケーブル敷設','ケーブル敷設','配線','成端','試験','機器更新'];
  const KNOWN = {
    'KR-2FCommonLaboratory-2': {place:'交隣館 2F 共同研究室6'},
    'KR-2FCommonLaboratory-1': {place:'交隣館 2F 共同研究室3'},
    'TC2-1FHistoricalMuseum': {place:'知真館2号館 1F 歴史資料館'},
    'BJ-318Hall': {place:'磐上館 3F 318前廊下'},
  };
  const DEFAULT_PROJECT = '同志社大学2026年インフラ系情報システムリプレース作業';
  function nfkc(s){ try{return (s||'').normalize('NFKC');}catch(_){return s||'';} }
  function compact(s){ return nfkc(s).replace(/[\u3000\t\r]/g,' ').replace(/\s+/g,' ').trim(); }
  function asciiLoose(s){
    return nfkc(s)
      .replace(/[‐‑‒–—―ーｰ−]/g,'-')
      .replace(/[｜|]/g,'I')
      .replace(/[＃#]/g,'')
      .replace(/[，、]/g,',')
      .replace(/[：:]/g,':');
  }
  function similarity(a,b){
    a=compact(a); b=compact(b); if(!a||!b) return 0;
    const m=a.length,n=b.length; const dp=Array(n+1).fill(0).map((_,j)=>j);
    for(let i=1;i<=m;i++){ let prev=dp[0]; dp[0]=i; for(let j=1;j<=n;j++){ const old=dp[j]; dp[j]=Math.min(dp[j]+1,dp[j-1]+1,prev+(a[i-1]===b[j-1]?0:1)); prev=old; } }
    return 1-dp[n]/Math.max(m,n);
  }
  function extractState(text, filename=''){
    const s=nfkc(filename+' '+text);
    for(const k of ['施工前','施工後','作業前','作業後','着手前','完了後']) if(s.includes(k)) return k;
    return '';
  }
  function normalizeCodeCandidate(raw, text=''){
    let s=asciiLoose(raw).replace(/\s+/g,'').replace(/[\[\]{}()<>「」『』]/g,'');
    s=s.replace(/^[^A-Za-z0-9]+/,'').replace(/[^A-Za-z0-9-]+$/,'');
    if(/(?:\d|Museum|Hall|Hal)I$/i.test(s)) s=s.slice(0,-1);
    s=s.replace(/^[MVWY]{1,2}-(\d{3,4})$/i,'YM-$1').replace(/^V?M-(\d{3,4})$/i,'YM-$1');
    s=s.replace(/^[I1|]?K?R-(2FCommon)/i,'KR-$1').replace(/^R-(2FCommon)/i,'KR-$1');
    s=s.replace(/^(?:[0-9]?I)?T?C2-(1FHist)/i,'TC2-$1').replace(/^C2-(1FHist)/i,'TC2-$1');
    s=s.replace(/^[^A-Z]*B?[J1I]-(\d{3,4})Hall?$/i,'BJ-$1Hall').replace(/^B[J1I]-/i,'BJ-').replace(/^J-(\d{3,4})Hal+l?$/i,'BJ-$1Hall');
    s=s.replace(/Labo(?:lon|tor|tory|rotory|latory|lotor)/i,'Laboratory');
    s=s.replace(/Commonlab(?:otor|olory|olatory|otory)/i,'CommonLaboratory');
    s=s.replace(/Histoncal/i,'Historical').replace(/HistoncalMuseuml?/i,'HistoricalMuseum');
    s=s.replace(/HistoricalMuseuml$/i,'HistoricalMuseum');
    if(/^YM\d{3,4}$/i.test(s)) s=s.replace(/^YM/i,'YM-');
    const t=nfkc(text);
    if(/^R-/.test(s) && /共同研究室|交隣館/.test(t)) s='K'+s;
    if(/^C2-/.test(s) && /歴史資料館|知真館/.test(t)) s='T'+s;
    return s;
  }
  function extractCode(text){
    const t=asciiLoose(text);
    const collapsed=t.replace(/\s+/g,'');
    const patterns=[
      /(?:YM|VM|V?M)[-ー]?[0-9]{3,4}/ig,
      /(?:[I1|]?K?R)[-ー]?[0-9]FCommon[A-Za-z0-9-]{3,40}/ig,
      /(?:[I1|]?T?C2)[-ー]?[0-9]F[A-Za-z0-9-]{3,40}/ig,
      /(?:B?[J1I])[-ー]?[0-9]{3,4}[A-Za-z-]{0,30}/ig,
      /[A-Z]{1,4}-[A-Za-z0-9-]{4,45}/g
    ];
    const cands=[];
    for(const p of patterns){ for(const m of collapsed.matchAll(p)){ const c=normalizeCodeCandidate(m[0],t); if(c.length>=4) cands.push(c); } }
    if(!cands.length) return '';
    function score(c){
      let s=0;
      if(/^YM-\d{3,4}$/.test(c)) s+=100;
      if(/^KR-2FCommonLaboratory-[12]$/i.test(c)) s+=100;
      if(/^TC2-1FHistoricalMuseum$/i.test(c)) s+=100;
      if(/^BJ-\d{3,4}Hall$/i.test(c)) s+=100;
      s+=Math.min(30,c.length);
      if(/^[A-Z]{1,4}-/.test(c)) s+=20;
      return s;
    }
    return [...new Set(cands)].sort((a,b)=>score(b)-score(a))[0];
  }
  function findFloorRoom(text){
    const t=compact(text).replace(/\s*F\s*/g,'F ');
    let m=t.match(/([1-9])F\s*(YM\s*\d{3,4})/i); if(m) return `${m[1]}F ${m[2].replace(/\s/g,'').toUpperCase()}`;
    m=t.match(/([1-9])F\s*(共同研究室\s*\d+)/); if(m) return `${m[1]}F ${m[2].replace(/\s+/,' ')}`;
    m=t.match(/([1-9])F\s*(歴史資料館)/); if(m) return `${m[1]}F ${m[2]}`;
    m=t.match(/([1-9])F\s*(\d{3,4})\s*前?廊下/); if(m) return `${m[1]}F ${m[2]}前廊下`;
    return '';
  }
  function extractPlace(text, code=''){
    const t=compact(text);
    if(KNOWN[code]) return KNOWN[code].place;
    if(/^YM-(\d{3,4})$/.test(code)){
      const room=RegExp.$1; const floorMatch=t.match(/([1-9])F\s*Y?M?\s*\d{3,4}/i); const floor=floorMatch?floorMatch[1]:room[0];
      return `有徳館東館 ${floor}F YM${room}`;
    }
    let building='';
    for(const b of ['有徳館東館','交隣館','知真館2号館','磐上館']) if(t.includes(b)) { building=b; break; }
    const fr=findFloorRoom(t);
    if(building&&fr) return `${building} ${fr}`;
    return building||fr;
  }
  function extractWork(text){
    const t=compact(text);
    for(const w of WORK_TYPES) if(t.includes(w)) return w;
    if(/機器.{0,2}設[置宣]/.test(t) || /機器設[置宣]/.test(t) || (/機器/.test(t)&&/設置/.test(t))) return '機器設置';
    return '';
  }
  function extractContract(text, code=''){
    const t=compact(text);
    if((t.includes('同志社')&&t.includes('2026')) || /^(YM|KR|TC2|BJ)-/.test(code)) return DEFAULT_PROJECT;
    const line=t.split(/\n/).find(x=>/委託|工事名|件名/.test(x)); return line?line.replace(/^.*?(委託件名|工事名|件名)\s*/,''):'';
  }
  function parseBoard(text, filename=''){
    const raw=nfkc(text||'');
    const code=extractCode(raw);
    const place=extractPlace(raw,code);
    const work=extractWork(raw);
    const state=extractState(raw,filename);
    const contract=extractContract(raw,code);
    let score=0;
    if(code) score+=30; if(place) score+=25; if(work) score+=20; if(contract) score+=15; if(/[測点備考工種委託件名]/.test(raw)) score+=10;
    return {contract, work, place, state, remarks:code, score:Math.min(100,score), rawText:raw};
  }
  global.PhotoBookParser={parseBoard,extractCode,extractPlace,extractWork,extractState,normalizeCodeCandidate,similarity,DEFAULT_PROJECT};
  if(typeof module!=='undefined'&&module.exports) module.exports=global.PhotoBookParser;
})(typeof window!=='undefined'?window:globalThis);
