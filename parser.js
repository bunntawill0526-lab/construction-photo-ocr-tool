(function(global){
  'use strict';

  const WORK_TYPES = ['機器設置','機器撤去','無線AP設置','AP設置','スイッチ設置','SW設置','LAN配線','光ケーブル敷設','ケーブル敷設','配線','成端','試験','機器更新'];
  const STATE_WORDS = ['施工前','施工後','作業前','作業後','施工中','作業中','設置前','設置後','撤去前','撤去後','完成','完了'];
  const KNOWN_CODE_PLACE = {
    'KR-2FCommonLaboratory-2':'交隣館 2F 共同研究室6',
    'KR-2FCommonLaboratory-1':'交隣館 2F 共同研究室3',
    'TC2-1FHistoricalMuseum':'知真館2号館 1F 歴史資料館',
    'BJ-318Hall':'磐上館 3F 318前廊下'
  };

  // 互換用。案件名は固定しない。
  const DEFAULT_PROJECT = '';

  function nfkc(s){ try{return String(s||'').normalize('NFKC');}catch(_){return String(s||'');} }
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

  function stripLabel(s, kind=''){
    let t=compact(s).replace(/^[|I｜\-_=+\s]+|[|I｜\-_=+\s]+$/g,'').trim();
    const labels = {
      contract: /^(?:委託件名|工事名|件名)\s*[:：]?\s*/,
      work: /^(?:工種|作業内容)\s*[:：]?\s*/,
      place: /^(?:測点|撮影場所|場所)\s*[:：]?\s*/,
      remarks: /^(?:備考|摘要)\s*[:：]?\s*/,
      state: /^(?:状態|状\s*態)\s*[:：]?\s*/
    };
    if(labels[kind]) t=t.replace(labels[kind],'').trim();
    return t.replace(/^[|I｜\-_=+\s]+|[|I｜\-_=+\s]+$/g,'').trim();
  }

  function isJunk(s){
    const t=nfkc(s).replace(/[\s|｜Iil1\-_=+.,:;・、。／\\]+/g,'');
    return t.length===0;
  }

  function extractState(text, filename=''){
    const s=nfkc(filename+' '+text).replace(/施エ/g,'施工').replace(/施I/g,'施工');
    for(const k of STATE_WORDS) if(s.includes(k)) return k;
    let m=s.match(/施.{0,1}工.{0,1}(前|後)/); if(m) return `施工${m[1]}`;
    m=s.match(/作.{0,1}業.{0,1}(前|後)/); if(m) return `作業${m[1]}`;
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
    const t=asciiLoose(text), collapsed=t.replace(/\s+/g,'');
    const patterns=[
      /(?:YM|VM|V?M)[-ー]?[0-9]{3,4}/ig,
      /(?:[I1|]?K?R)[-ー]?[0-9]FCommon[A-Za-z0-9-]{3,40}/ig,
      /(?:[I1|]?T?C2)[-ー]?[0-9]F[A-Za-z0-9-]{3,40}/ig,
      /(?:B?[J1I])[-ー]?[0-9]{3,4}[A-Za-z-]{0,30}/ig,
      /[A-Z]{1,8}-[A-Za-z0-9-]{2,60}/g
    ];
    const cands=[];
    for(const p of patterns){
      for(const m of collapsed.matchAll(p)){
        const c=normalizeCodeCandidate(m[0],t);
        if(c.length>=3) cands.push(c);
      }
    }
    return cands[0]||'';
  }

  function normalizeWork(s){
    const t=stripLabel(s,'work');
    if(!t || isJunk(t)) return '';
    for(const w of WORK_TYPES) if(t.includes(w)) return w;
    if(/撤去|取外|取り外/.test(t)) return /AP|無線/i.test(t)?'無線AP撤去':(/機器/.test(t)?'機器撤去':t);
    if(/機.?器/.test(t)&&/設[置宣直買]/.test(t)) return '機器設置';
    if(/AP|無線/i.test(t) && /設[置宣直買]/.test(t)) return '無線AP設置';
    if(/SW|スイッチ/i.test(t) && /設[置宣直買]/.test(t)) return 'スイッチ設置';
    return t;
  }

  function normalizeRemarks(s){
    const t=stripLabel(s,'remarks');
    if(!t || isJunk(t)) return '';
    const code=extractCode(t);
    return code || t;
  }

  function extractContract(text){
    const lines=nfkc(text).split(/\r?\n/).map(x=>stripLabel(x,'contract'));
    const explicit=nfkc(text).split(/\r?\n/).find(x=>/(委託件名|工事名|件名)/.test(x));
    if(explicit){ const v=stripLabel(explicit,'contract'); if(v && !isJunk(v)) return v; }
    return lines.find(x=>x && !isJunk(x)) || '';
  }

  function extractWork(text){
    const lines=nfkc(text).split(/\r?\n/);
    const explicit=lines.find(x=>/(工種|作業内容)/.test(x));
    if(explicit) return normalizeWork(explicit);
    for(const x of lines){ const n=normalizeWork(x); if(WORK_TYPES.some(w=>n===w)) return n; }
    return '';
  }

  function extractPlace(text, code=''){
    const lines=nfkc(text).split(/\r?\n/);
    const explicit=lines.find(x=>/(測点|撮影場所|場所)/.test(x));
    if(explicit){ const v=stripLabel(explicit,'place'); if(v&&!isJunk(v)) return v; }
    if(code && KNOWN_CODE_PLACE[code]) return KNOWN_CODE_PLACE[code];
    return '';
  }

  // 電子黒板の4段をそのまま意味に割り当てる。
  // 1段目=委託件名/工事名、2段目=工種、3段目=測点、4段目=備考。
  // 案件名・建物名・測点名を辞書で限定しない。
  function parseRows(rows, filename=''){
    const r=(rows||[]).slice(0,4);
    while(r.length<4) r.push('');

    let contract=stripLabel(r[0],'contract');
    let work=normalizeWork(r[1]);
    let place=stripLabel(r[2],'place');
    let remarks=normalizeRemarks(r[3]);

    if(isJunk(contract)) contract='';
    if(isJunk(place)) place='';

    // 旧案件コードの補正は、測点OCRが空のときだけ補助的に使う。
    if(!place && remarks && KNOWN_CODE_PLACE[remarks]) place=KNOWN_CODE_PLACE[remarks];

    const state=extractState(r.join('\n'),filename);
    let score=0;
    if(contract) score+=20;
    if(work) score+=25;
    if(place) score+=30;
    if(remarks) score+=20;
    if(state) score+=5;

    return {contract,work,place,state,remarks,score:Math.min(100,score),rawText:r.join('\n')};
  }

  function parseBoard(text, filename=''){
    const raw=nfkc(text||'');
    const lines=raw.split(/\r?\n/);

    // 通常はOCR側が4段を順番どおり渡してくるので、位置を最優先する。
    if(lines.length>=4){
      const positioned=parseRows(lines,filename);
      // 4項目のうち2項目以上取れたら、案件固有辞書より位置情報を信頼する。
      const got=[positioned.contract,positioned.work,positioned.place,positioned.remarks].filter(Boolean).length;
      if(got>=2) return positioned;
    }

    // フォールバック：ラベルが読めた場合はラベルから拾う。
    const code=extractCode(raw);
    const contract=extractContract(raw);
    const work=extractWork(raw);
    const place=extractPlace(raw,code);
    const state=extractState(raw,filename);
    const remarks=code;
    let score=0;
    if(contract) score+=20; if(work) score+=25; if(place) score+=30; if(remarks) score+=20; if(state) score+=5;
    return {contract,work,place,state,remarks,score:Math.min(100,score),rawText:raw};
  }

  global.PhotoBookParser={
    parseBoard,parseRows,extractCode,extractPlace,extractWork,extractState,
    normalizeCodeCandidate,similarity,DEFAULT_PROJECT
  };
  if(typeof module!=='undefined'&&module.exports) module.exports=global.PhotoBookParser;
})(typeof window!=='undefined'?window:globalThis);
