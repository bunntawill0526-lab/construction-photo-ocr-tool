(function(global){
  'use strict';

  const STATE_WORDS = ['施工前','施工後','作業前','作業後','施工中','作業中','設置前','設置後','撤去前','撤去後','完成','完了'];
  const KNOWN_CODE_PLACE = {
    'KR-2FCommonLaboratory-2':'交隣館 2F 共同研究室6',
    'KR-2FCommonLaboratory-1':'交隣館 2F 共同研究室3',
    'TC2-1FHistoricalMuseum':'知真館2号館 1F 歴史資料館',
    'BJ-318Hall':'磐上館 3F 318前廊下'
  };
  const DEFAULT_PROJECT = '';

  function nfkc(s){ try{return String(s||'').normalize('NFKC');}catch(_){return String(s||'');} }
  function compact(s){ return nfkc(s).replace(/[\u3000\t\r]/g,' ').replace(/\s+/g,' ').trim(); }
  function similarity(a,b){
    a=compact(a); b=compact(b); if(!a||!b) return 0;
    const m=a.length,n=b.length,dp=Array.from({length:n+1},(_,j)=>j);
    for(let i=1;i<=m;i++){
      let prev=dp[0]; dp[0]=i;
      for(let j=1;j<=n;j++){
        const old=dp[j];
        dp[j]=Math.min(dp[j]+1,dp[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));
        prev=old;
      }
    }
    return 1-dp[n]/Math.max(m,n);
  }

  function stripEdges(s){
    return compact(s)
      .replace(/^[|｜Iil1\-_=+・:：;；,，、。\s]+/g,'')
      .replace(/[|｜Iil1\-_=+・:：;；,，、。\s]+$/g,'')
      .trim();
  }

  function stripLabel(s,kind=''){
    let t=stripEdges(s);
    const labels={
      contract:/^(?:委託件名|工事名|件名)\s*[:：]?\s*/,
      work:/^(?:工種|作業内容)\s*[:：]?\s*/,
      place:/^(?:測点|撮影場所|場所)\s*[:：]?\s*/,
      remarks:/^(?:備考|摘要)\s*[:：]?\s*/,
      state:/^(?:状態|状\s*態)\s*[:：]?\s*/,
      contractor:/^(?:請負者|施工者|受注者)\s*[:：]?\s*/
    };
    if(labels[kind]) t=t.replace(labels[kind],'').trim();
    return stripEdges(t);
  }

  function isJunk(s){
    const raw=nfkc(s);
    const t=raw.replace(/[\s|｜Iil1\-_=+.,:;・、。／\\]+/g,'');
    if(!t) return true;
    if(t.length===1) return true;
    if(/^([A-Za-z0-9ぁ-んァ-ヶ一-龠々])\1{3,}$/.test(t)) return true;
    return false;
  }

  function extractState(text,filename=''){
    const s=nfkc(filename+' '+text).replace(/施エ/g,'施工').replace(/施I/g,'施工').replace(/作業業/g,'作業');
    for(const k of STATE_WORDS) if(s.includes(k)) return k;
    let m=s.match(/施.{0,1}工.{0,1}(前|後)/); if(m) return `施工${m[1]}`;
    m=s.match(/作.{0,1}業.{0,1}(前|後)/); if(m) return `作業${m[1]}`;
    return '';
  }

  function normalizeCodeCandidate(raw){
    let s=nfkc(raw).replace(/[‐‑‒–—―ーｰ−]/g,'-').replace(/\s+/g,'').replace(/[\[\]{}()<>「」『』]/g,'');
    s=s.replace(/^[^A-Za-z0-9]+/,'').replace(/[^A-Za-z0-9-]+$/,'');
    s=s.replace(/^[MVWY]{1,2}-(\d{3,4})$/i,'YM-$1').replace(/^V?M-(\d{3,4})$/i,'YM-$1');
    s=s.replace(/^[I1|]?K?R-(2FCommon)/i,'KR-$1').replace(/^R-(2FCommon)/i,'KR-$1');
    s=s.replace(/^(?:[0-9]?I)?T?C2-(1FHist)/i,'TC2-$1').replace(/^C2-(1FHist)/i,'TC2-$1');
    s=s.replace(/^J-(\d{3,4})Hal+l?$/i,'BJ-$1Hall').replace(/^B[J1I]-/i,'BJ-');
    s=s.replace(/Commonlab(?:otor|olory|olatory|otory)/i,'CommonLaboratory');
    s=s.replace(/Histoncal/i,'Historical').replace(/HistoricalMuseuml$/i,'HistoricalMuseum');
    if(/^YM\d{3,4}$/i.test(s)) s=s.replace(/^YM/i,'YM-');
    return s;
  }

  function extractCode(text){
    const t=nfkc(text).replace(/[‐‑‒–—―ーｰ−]/g,'-').replace(/\s+/g,'');
    const pats=[
      /(?:YM|VM|V?M)-?[0-9]{3,4}/ig,
      /(?:[I1|]?K?R)-?[0-9]FCommon[A-Za-z0-9-]{3,40}/ig,
      /(?:[I1|]?T?C2)-?[0-9]F[A-Za-z0-9-]{3,40}/ig,
      /(?:B?[J1I])-[0-9]{3,4}[A-Za-z-]{0,30}/ig,
      /[A-Z]{1,8}-[A-Za-z0-9-]{2,60}/g
    ];
    for(const p of pats){
      const m=t.match(p);
      if(m&&m[0]) return normalizeCodeCandidate(m[0]);
    }
    return '';
  }

  function normalizeContract(s){
    const t=stripLabel(s,'contract');
    if(isJunk(t)) return '';
    if(/^(?:工種|測点|備考|状態|請負者|施工者|受注者)\b/.test(t)) return '';
    return t;
  }

  function normalizeWork(s){
    let t=stripLabel(s,'work');
    if(isJunk(t)) return '';
    t=t.replace(/設[宣直買]/g,'設置').replace(/撤[法去]/g,'撤去');
    const action=/(設置|撤去|配線|敷設|成端|試験|更新|取替|交換|移設|搬入|接続|切替|開通|設定|施工)/;
    if(!action.test(t)) return '';
    if(/(?:測点|請負者|株式会社)/.test(t)&&!/(設置|撤去|配線|敷設|成端|試験|更新|取替|交換|移設)/.test(t)) return '';
    return t;
  }

  function normalizePlace(s){
    const t=stripLabel(s,'place');
    if(isJunk(t)) return '';
    if(/^(?:請負者|施工者|受注者)/.test(t)) return '';
    if(/株式会社/.test(t)&&!/[棟館階室F\d]/.test(t)) return '';
    if(STATE_WORDS.some(x=>t===x)) return '';
    return t;
  }

  function normalizeRemarks(s){
    let t=stripLabel(s,'remarks');
    if(!t) return '';
    for(const st of STATE_WORDS) t=t.replaceAll(st,' ');
    t=t.replace(/(?:請負者|施工者|受注者)\s*[:：]?\s*[^\n]*/g,' ');
    t=stripEdges(t);
    if(isJunk(t)) return '';
    if(/^(?:NTT|ＮＴＴ)?\s*西日本株式会社$/i.test(t)) return '';
    const code=extractCode(t);
    return code||t;
  }

  function extractExplicit(lines,regex,kind,normalizer){
    for(const line of lines){
      if(regex.test(line)){
        const v=normalizer ? normalizer(line) : stripLabel(line,kind);
        if(v&&!isJunk(v)) return v;
      }
    }
    return '';
  }

  function parseRows(rows,filename=''){
    const r=(rows||[]).slice(0,4);
    while(r.length<4) r.push('');

    const contract=normalizeContract(r[0]);
    const work=normalizeWork(r[1]);
    let place=normalizePlace(r[2]);
    const state=extractState(r.join('\n'),filename);
    const remarks=normalizeRemarks(r[3]);
    if(!place&&remarks&&KNOWN_CODE_PLACE[remarks]) place=KNOWN_CODE_PLACE[remarks];

    let score=0;
    if(contract) score+=20;
    if(work) score+=25;
    if(place) score+=30;
    if(remarks) score+=20;
    if(state) score+=5;
    return {contract,work,place,state,remarks,score:Math.min(100,score),rawText:r.join('\n')};
  }

  function parseBoard(text,filename=''){
    const raw=nfkc(text||'');
    const lines=raw.split(/\r?\n/).map(x=>compact(x)).filter((x,i)=>x!==''||i<4);

    if(lines.length>=4){
      const positioned=parseRows(lines,filename);
      const got=[positioned.contract,positioned.work,positioned.place,positioned.remarks].filter(Boolean).length;
      if(got>=2||positioned.state) return positioned;
    }

    const contract=extractExplicit(lines,/(委託件名|工事名|件名)/,'contract',normalizeContract);
    const work=extractExplicit(lines,/(工種|作業内容)/,'work',normalizeWork);
    let place=extractExplicit(lines,/(測点|撮影場所|場所)/,'place',normalizePlace);
    const state=extractState(raw,filename);
    const remarkLine=lines.find(x=>/(備考|摘要)/.test(x))||'';
    const remarks=normalizeRemarks(remarkLine)||extractCode(raw);
    if(!place&&remarks&&KNOWN_CODE_PLACE[remarks]) place=KNOWN_CODE_PLACE[remarks];

    let score=0;
    if(contract) score+=20; if(work) score+=25; if(place) score+=30; if(remarks) score+=20; if(state) score+=5;
    return {contract,work,place,state,remarks,score:Math.min(100,score),rawText:raw};
  }

  global.PhotoBookParser={parseBoard,parseRows,extractCode,extractState,normalizeCodeCandidate,similarity,DEFAULT_PROJECT};
  if(typeof module!=='undefined'&&module.exports) module.exports=global.PhotoBookParser;
})(typeof window!=='undefined'?window:globalThis);
