// ============================================================
// FIREBASE BACKEND — sole database + auth (never pauses)
//
// Data:  shops/{SID}/{collection}/{id}   (Firestore)
// Auth:  Firebase Authentication (Email/Password + Google)
//
// Exposes `window.db` — a Supabase-compatible facade
// (db.from / db.rpc / db.auth) so app code keeps working.
// ============================================================
(function(){
  // ---- INIT FIREBASE ----
  if(typeof FIREBASE_CONFIG!=='undefined'&&FIREBASE_CONFIG.apiKey){
    try{
      firebase.initializeApp(FIREBASE_CONFIG);
      window.fbDb=firebase.firestore();
      window.fbAuth=firebase.auth();
      window.FB_CONFIGURED=true;
      fbDb.enablePersistence({synchronizeTabs:true}).catch(()=>{});
    }catch(e){console.warn('FB init fail:',e);window.FB_CONFIGURED=false;}
  }else{window.FB_CONFIGURED=false;}

  const SID='avfdpkytaxeqiuzmpxdu';
  const FB_BASE=()=>fbDb.collection('shops').doc(SID);
  window.FB_SID=SID;
  // GCIP default web OAuth client (project hkshophisaab) — used for the
  // relay-free Google flow: id_token comes back in the URL fragment.
  const GOOGLE_OAUTH_CLIENT='495779454990-nkdu47nfhnbu3cfmb9bfeu271frekiqk.apps.googleusercontent.com';

  // auth step tracer — survives reloads so failures are visible on screen
  window.atr=function(k,v){
    try{
      var t=JSON.parse(localStorage.getItem('authTrace')||'{}');
      t.t=Date.now();t[k]=v;
      localStorage.setItem('authTrace',JSON.stringify(t));
    }catch(e){}
  };
  // page-load history + firebase storage snapshot (before auth init consumes it)
  try{
    var t0=JSON.parse(localStorage.getItem('authTrace')||'{}');
    t0.loadHistory=t0.loadHistory||[];
    var href=location.href.replace('https://hanumantkumar12-coder.github.io/hardware-shop-app','');
    if(href.length>96)href=href.slice(0,96)+'…';
    t0.loadHistory.push((new Date()).toISOString().slice(11,19)+' '+href);
    if(t0.loadHistory.length>6)t0.loadHistory=t0.loadHistory.slice(-6);
    localStorage.setItem('authTrace',JSON.stringify(t0));
  }catch(e){}
  try{
    var ks=[];
    for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('firebase')!==-1)ks.push(k);}
    window.atr('fbstore',ks.length?ks.map(function(x){return x.substring(0,55);}).join(' | '):'none');
  }catch(e){}
  try{
    if(indexedDB&&indexedDB.databases){
      indexedDB.databases().then(function(ds){
        var f=(ds||[]).map(function(d){return d.name||''}).filter(function(n){return /firebase/i.test(n);});
        window.atr('idbDbs',f.length?f.join(','):'none');
      }).catch(function(){});
    }
  }catch(e){}
  // auth event relay observability — iframe + postMessage from __/auth/handler
  try{
    var _msgs=[],_ifs=[];
    window.addEventListener('message',function(ev){
      try{
        var d=ev.data,tag='';
        if(d&&typeof d==='object')tag=':'+(d.eventType||d.type||'obj');
        else if(typeof d==='string')tag=':str';
        var o=String(ev.origin||'').replace(/^https?:\/\//,'');
        _msgs.push(o+tag);if(_msgs.length>7)_msgs.shift();
        window.atr('msgs',_msgs.join(' ~ '));
      }catch(e){}
    });
    var _noteI=function(src){
      try{
        if(!src)return;
        var s=String(src).replace(/^https?:\/\//,'');
        _ifs.push(s.substring(0,70));if(_ifs.length>4)_ifs.shift();
        window.atr('iframes',_ifs.join(' ~ '));
      }catch(e){}
    };
    var _mo=new MutationObserver(function(ms){
      ms.forEach(function(m){
        if(m.type==='attributes'&&m.target.tagName==='IFRAME'){_noteI(m.target.src);return;}
        [].forEach.call(m.addedNodes,function(n){if(n&&n.tagName==='IFRAME')_noteI(n.src);});
      });
    });
    _mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  }catch(e){}
  // storage health probes — shown in the login debug banner
  try{sessionStorage.setItem('p','1');sessionStorage.removeItem('p');window.atr('ss','ok');}catch(e){window.atr('ss','FAIL');}
  try{
    var pr=indexedDB.open('probe'+Date.now());
    pr.onsuccess=function(){window.atr('idb','ok');try{pr.result.close();}catch(e){}};
    pr.onerror=function(){window.atr('idb','FAIL:'+(pr.error&&pr.error.name));};
  }catch(e){window.atr('idb','throw:'+(e&&e.message));}

  // global error surfacing + Firestore SDK health probe
  try{
    window.addEventListener('error',function(ev){
      try{window.atr('err','onerror:'+((ev&&ev.message)||'?'));}catch(e){}
    });
    window.addEventListener('unhandledrejection',function(ev){
      try{
        var r=ev&&ev.reason;
        window.atr('err','rej:'+(((r&&r.code)||(r&&r.message))||r));
      }catch(e){}
    });
  }catch(e){}
  window.fbProbe=function(){
    return withTimeout(FB_BASE().collection('products').limit(3).get(),10000,'probe-timeout')
      .then(function(s){
        window.atr('probe','sdk-OK:'+s.size);
        return{sdk:true,size:s.size};
      })
      .catch(function(e){
        var msg=((e&&e.code)||(e&&e.message)||String(e));
        window.atr('probe','sdk-FAIL:'+msg);
        return loadRowsRest('products').then(function(rows){
          window.atr('probe','rest-OK:'+rows.length);
          return{sdk:false,rest:true,size:rows.length};
        }).catch(function(e2){
          window.atr('probe','rest-FAIL:'+((e2&&e2.message)||e2));
          return{sdk:false,rest:false};
        });
      });
  };

  // ---- Google sign-in without the handler/iframe event relay -------------
  // Firebase's redirect flow depends on a hidden __/auth/iframe posting an
  // event back; that relay never delivers on some browsers, so the SDK
  // returns null. Here the OAuth id_token is read straight from the URL
  // fragment and traded for a Firebase session via signInWithCredential.
  function fragmentParams(){
    const h=(location.hash||'').replace(/^#/,'');
    const o={};
    if(!h)return o;
    h.split('&').forEach(function(kv){
      const i=kv.indexOf('=');
      o[decodeURIComponent(i<0?kv:kv.slice(0,i))]=i<0?'':decodeURIComponent(kv.slice(i+1).replace(/\+/g,'%20'));
    });
    return o;
  }
  function noteAuthErr(msg){
    try{localStorage.setItem('authErr',Date.now()+'|'+msg);}catch(e){}
  }
  window.__googleFragmentHandled=false;
  window.__googleTokenReady=null;
  window.completeGoogleFragment=function(){
    let p={};
    try{p=fragmentParams();}catch(e){}
    if(!p.id_token&&!p.error)return false;
    window.__googleFragmentHandled=true;
    try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
    try{
      const want=sessionStorage.getItem('gState');
      if(p.state&&want&&p.state!==want)window.atr('oauth','state-mismatch');
    }catch(e){}
    if(p.error){
      window.atr('fb','googleERR:'+p.error);
      noteAuthErr('Google: '+(p.error_description||p.error).slice(0,140));
      return true;
    }
    window.atr('oauth','fragment-return:id_token');
    const cred=fbAuth.GoogleAuthProvider.credential(p.id_token);
    window.__googleTokenReady=fbAuth.signInWithCredential(cred).then(function(c){
      window.atr('fb','credential-ok:'+((c&&c.user&&(c.user.email||c.user.uid))||'?'));
      return c;
    }).catch(function(e){
      window.atr('fb','credential-ERR:'+((e&&e.code)||(e&&e.message)||e));
      noteAuthErr('Google sign-in failed: '+(((e&&e.message)||e)+'').replace(/^Firebase:\s*/,''));
      throw e;
    });
    return true;
  };
  try{if(FB_CONFIGURED)window.completeGoogleFragment();}catch(e){window.atr('frag','throw:'+((e&&e.message)||e));}

  // ========================================================
  // AUTH helpers
  // ========================================================
  function authErr(e){
    const m=(e&&e.message)||'';
    const code=(e&&e.code)||'';
    if(code==='auth/invalid-credential'||code==='auth/wrong-password'||code==='auth/user-not-found')
      return 'Invalid email or password';
    if(code==='auth/too-many-requests')return 'Too many attempts — try again later';
    if(code==='auth/invalid-email')return 'Invalid email address';
    if(code==='auth/network-request-failed')return 'Network error — check connection';
    if(code==='auth/unauthorized-domain')
      return 'This website domain is not allowed. Add it in Firebase Console → Authentication → Settings → Authorized domains.';
    if(code==='auth/popup-blocked')return 'Popup blocked — allow popups for this site';
    if(code==='auth/popup-closed-by-user'||code==='auth/cancelled-popup-request'||code==='auth/popup-closed-without-complete')return 'Sign-in cancelled';
    if(code==='auth/operation-not-allowed')return 'This sign-in method is turned off in Firebase Console';
    return m.replace(/^Firebase:\s*/,'')||'Login failed';
  }

  window.fbLogin=async function(email,pass){
    if(!FB_CONFIGURED)return{error:{message:'Firebase not configured'}};
    try{
      const cred=await fbAuth.signInWithEmailAndPassword(email,pass);
      if(window.atr)atr('fbLogin','ok');
      return{user:cred.user,error:null};
    }catch(e){if(window.atr)atr('fbLogin','ERR '+(e.code||e.message));return{error:{message:authErr(e),code:e.code}};}
  };

  window.fbLogout=async function(){
    if(FB_CONFIGURED){try{await fbAuth.signOut();}catch(e){}}
  };

  window.fbGetCurrentUser=function(){
    if(!FB_CONFIGURED)return Promise.resolve(null);
    return new Promise(resolve=>{
      let done=false;
      try{window.atr&&atr('u','wait');}catch(e){}
      const unsub=fbAuth.onAuthStateChanged(u=>{
        try{window.atr&&atr('u','cb:'+(u?('user:'+(u.email||u.uid)):'null'));}catch(e){}
        if(!done){done=true;try{unsub();}catch(e){}resolve(u);}
      });
      setTimeout(()=>{
        try{window.atr&&atr('u','timeout->'+(fbAuth.currentUser?'user':'null'));}catch(e){}
        if(!done){done=true;try{unsub();}catch(e){}resolve(fbAuth.currentUser);}
      },3000);
    });
  };

  // ========================================================
  // PROFILE — canonical doc keyed by lowercase email
  // ========================================================
  window.fbGetProfile=async function(uid,email){
    if(!FB_CONFIGURED)return null;
    try{
      const col=FB_BASE().collection('profiles');
      const eml=(email||'').toLowerCase();
      if(eml){
        const pd=await docGet('profiles',eml);
        if(pd){
          const p={...pd};delete p._ts;
          try{await docSet('profiles',uid,{...p,id:uid},true);}catch(e){}
          return{...p,id:uid};
        }
      }
      const p2=await docGet('profiles',uid);
      if(p2){const p={...p2};delete p._ts;return{...p,id:uid};}
      const defRole=(eml==='hanumantkumar12@gmail.com')?'owner':'staff';
      const prof={name:(email||'User').split('@')[0],role:defRole,active:true,email:eml||null,
                  created_at:new Date().toISOString()};
      await docSet('profiles',eml||String(uid),prof,false);
      return{id:uid,...prof};
    }catch(e){console.warn('fbGetProfile:',e);return null;}
  };

  // ========================================================
  // ROW CACHE — small collections, short TTL, write-invalidated
  // ========================================================
  const TTL=2000;
  const SDK_TIMEOUT=8000;
  const _cache=new Map();
  const _pending=new Map();

  function withTimeout(p,ms,msg){
    return new Promise((res,rej)=>{
      let done=false;
      const t=setTimeout(function(){if(!done){done=true;rej(new Error(msg||'timeout'));}},ms);
      Promise.resolve(p).then(
        v=>{if(!done){done=true;clearTimeout(t);res(v);}},
        e=>{if(!done){done=true;clearTimeout(t);rej(e);}}
      );
    });
  }

  // ---- Firestore REST bridge (used when the SDK WebChannel stalls) ----
  function restToken(){
    if(!fbAuth||!fbAuth.currentUser)return Promise.reject(new Error('no-auth'));
    return fbAuth.currentUser.getIdToken();
  }
  function restUrl(table,id){
    let u='https://firestore.googleapis.com/v1/projects/'+FIREBASE_CONFIG.projectId+
           '/databases/default/documents/shops/'+SID+'/'+encodeURIComponent(table);
    if(id!==undefined&&id!==null)u+='/'+encodeURIComponent(String(id));
    return u;
  }
  function restMap(fields){
    const o={};
    for(const k in fields){
      const v=fields[k];
      if(v===null||typeof v!=='object'){o[k]=v;continue;}
      if('stringValue'in v)o[k]=v.stringValue;
      else if('booleanValue'in v)o[k]=v.booleanValue;
      else if('integerValue'in v)o[k]=Number(v.integerValue);
      else if('doubleValue'in v)o[k]=Number(v.doubleValue);
      else if('timestampValue'in v)o[k]=v.timestampValue;
      else if('nullValue'in v)o[k]=null;
      else if('arrayValue'in v)o[k]=(v.arrayValue.values||[]).map(function(x){return toVal2(x);});
      else if('mapValue'in v)o[k]=restMap(v.mapValue.fields||{});
      else o[k]=null;
    }
    return o;
  }
  function toVal2(v){
    if(v===null||typeof v!=='object')return v;
    if('stringValue'in v)return v.stringValue;
    if('booleanValue'in v)return v.booleanValue;
    if('integerValue'in v)return Number(v.integerValue);
    if('doubleValue'in v)return Number(v.doubleValue);
    if('timestampValue'in v)return v.timestampValue;
    if('nullValue'in v)return null;
    if('arrayValue'in v)return (v.arrayValue.values||[]).map(toVal2);
    if('mapValue'in v)return restMap(v.mapValue.fields||{});
    return null;
  }
  function restRow(doc){
    const row=restMap(doc.fields||{});
    const seg=String(doc.name||'').split('/');
    const docId=seg.length?seg[seg.length-1]:'';
    if(row.id===undefined||row.id===null){const n=+docId;row.id=isNaN(n)?docId:n;}
    else if(typeof row.id==='string'&&/^-?\d+$/.test(row.id))row.id=+row.id;
    if(row._ts!==undefined)delete row._ts;
    return row;
  }
  function toVal(v){
    if(v===null||v===undefined)return{nullValue:null};
    if(typeof v==='boolean')return{booleanValue:v};
    if(typeof v==='number')return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
    if(v instanceof Date)return{timestampValue:v.toISOString()};
    if(Array.isArray(v))return{arrayValue:{values:v.map(toVal)}};
    if(typeof v==='object')return{mapValue:{fields:toFields(v)}};
    return{stringValue:String(v)};
  }
  function toFields(obj){
    const f={};
    for(const k in obj){if(obj[k]!==undefined)f[k]=toVal(obj[k]);}
    return f;
  }
  async function loadRowsRest(table){
    const tok=await restToken();
    let page=null,rows=[];
    do{
      let u=restUrl(table)+'?pageSize=1000';
      if(page)u+='&pageToken='+encodeURIComponent(page);
      const r=await fetch(u,{headers:{'Authorization':'Bearer '+tok}});
      if(!r.ok)throw new Error('rest-read-'+r.status);
      const j=await r.json();
      const docs=j.documents||[];
      for(let i=0;i<docs.length;i++)rows.push(restRow(docs[i]));
      page=j.nextPageToken||null;
    }while(page);
    return rows;
  }
  async function docSet(table,id,row,merge){
    try{
      await withTimeout(FB_BASE().collection(table).doc(String(id)).set(row,merge?{merge:true}:undefined),SDK_TIMEOUT,'sdk-timeout');
      if(window.atr)atr('wmode','sdk:'+table);
      return;
    }catch(e){
      if(window.atr)atr('wmode','rest:'+table);
      const tok=await restToken();
      const r=await fetch(restUrl(table,id),{
        method:merge?'PATCH':'PUT',
        headers:{'Authorization':'Bearer '+tok,'Content-Type':'application/json'},
        body:JSON.stringify({fields:toFields(row)})
      });
      if(!r.ok)throw new Error('rest-write-'+r.status);
    }
  }
  async function docGet(table,id){
    try{
      const d=await withTimeout(FB_BASE().collection(table).doc(String(id)).get(),SDK_TIMEOUT,'sdk-timeout');
      if(d.exists)return d.data();
      return null;
    }catch(e){
      const tok=await restToken();
      const r=await fetch(restUrl(table,id),{headers:{'Authorization':'Bearer '+tok}});
      if(r.status===404)return null;
      if(!r.ok)throw new Error('rest-read-'+r.status);
      const j=await r.json();
      return restMap(j.fields||{});
    }
  }
  async function docDelete(table,id){
    try{
      await withTimeout(FB_BASE().collection(table).doc(String(id)).delete(),SDK_TIMEOUT,'sdk-timeout');
      return;
    }catch(e){
      const tok=await restToken();
      const r=await fetch(restUrl(table,id),{method:'DELETE',headers:{'Authorization':'Bearer '+tok}});
      if(!r.ok&&r.status!==404)throw new Error('rest-del-'+r.status);
    }
  }

  function docToRow(doc){
    const v=doc.data()||{};
    const row={};
    for(const k in v){if(k==='_ts')continue;row[k]=v[k];}
    if(row.id===undefined||row.id===null){
      const n=+doc.id;row.id=isNaN(n)?doc.id:n;
    }else if(typeof row.id==='string'&&/^-?\d+$/.test(row.id)){
      row.id=+row.id;
    }
    return row;
  }

  async function loadRows(table){
    const c=_cache.get(table);
    if(c&&Date.now()-c.ts<TTL)return c.rows;
    if(_pending.has(table))return _pending.get(table);
    const p=(async()=>{
      let rows;
      try{
        const snap=await withTimeout(FB_BASE().collection(table).get(),SDK_TIMEOUT,'sdk-timeout');
        rows=snap.docs.map(docToRow);
        if(window.atr)atr('mode','sdk:'+table);
      }catch(e){
        if(window.atr)atr('mode','rest:'+table+' ['+(((e&&e.code)||(e&&e.message))||e)+']');
        rows=await loadRowsRest(table);
      }
      if(window.atr)atr('sel',table+'='+rows.length);
      _cache.set(table,{ts:Date.now(),rows});
      return rows;
    })().finally(function(){_pending.delete(table);});
    _pending.set(table,p);
    p.catch(()=>{});
    return p;
  }
  function dropCache(t){if(t)_cache.delete(t);else _cache.clear();}

  function clean(obj){
    const out={};
    for(const k in obj){if(obj[k]!==undefined)out[k]=obj[k];}
    return out;
  }

  function nextIdFrom(rows){
    let max=0;
    rows.forEach(r=>{const n=+r.id;if(!isNaN(n)&&isFinite(n)&&n>max)max=n;});
    return max+1;
  }

  // ========================================================
  // AUDIT — mirror of Supabase aud_* triggers (client-side)
  // tables: products, customers, suppliers, sales, purchases, payments
  // ========================================================
  const AUDITED=['products','customers','suppliers','sales','purchases','payments'];
  function writeAudit(action,table,rowId,oldRow,newRow){
    if(!FB_CONFIGURED||!AUDITED.includes(table))return;
    try{
      const aid=Date.now()*1000+Math.floor(Math.random()*1000);
      let who=null;
      try{if(typeof meProfile!=='undefined'&&meProfile)who=meProfile;}catch(e){}
      const u=fbAuth.currentUser;
      docSet('audit_log',aid,{
        id:aid,
        acted_at:new Date().toISOString(),
        actor:u?u.uid:null,
        actor_name:who?(who.name||who.email):(u?u.email:'?'),
        action:action,table_name:table,row_id:String(rowId),
        old_row:oldRow||null,new_row:newRow||null
      },false).catch(()=>{});
    }catch(e){}
  }

  // ========================================================
  // FILTER / SORT helpers (SQL-like semantics, client-side)
  // ========================================================
  function eqMatch(a,b){
    if(a===undefined)a=null;if(b===undefined)b=null;
    if(a===null||b===null)return a===b;
    if(typeof a==='number'||typeof b==='number'){
      const na=+a,nb=+b;
      if(!isNaN(na)&&!isNaN(nb)&&isFinite(na)&&isFinite(nb))return na===nb;
    }
    if(typeof a==='boolean'||typeof b==='boolean')return (a?'1':'0')===(b?'1':'0');
    return String(a)===String(b);
  }
  function normCmp(v){
    if(v===null||v===undefined)return null;
    if(typeof v==='number')return isFinite(v)?v:null;
    if(typeof v==='boolean')return v?1:0;
    if(typeof v==='string'){
      if(/^\d{4}-\d{2}-\d{2}/.test(v))return v;      // date-like → compare by Date.parse
      if(v!==''&&!isNaN(+v)&&isFinite(+v))return +v;
      return v;
    }
    return v;
  }
  function rel(a,b){                                       // sort compare, nulls last
    const A=normCmp(a),B=normCmp(b);
    if(A===null&&B===null)return 0;
    if(A===null)return 1;
    if(B===null)return -1;
    if(typeof A==='string'&&typeof B==='string'){
      const ta=Date.parse(A),tb=Date.parse(B);
      if(!isNaN(ta)&&!isNaN(tb))return ta-tb;
      return A<B?-1:A>B?1:0;
    }
    const na=typeof A==='number'?A:+A, nb=typeof B==='number'?B:+B;
    if(!isNaN(na)&&!isNaN(nb))return na-nb;
    return String(A)<String(B)?-1:String(A)>String(B)?1:0;
  }
  function relMatch(a,b,op){                               // >, >=, <, <=
    const A=normCmp(a),B=normCmp(b);
    if(A===null||B===null)return false;                    // SQL: null comparisons are false
    if(typeof A==='string'&&typeof B==='string'){
      const ta=Date.parse(A),tb=Date.parse(B);
      if(!isNaN(ta)&&!isNaN(tb))return op==='>'?ta>tb:op==='>='?ta>=tb:op==='<'?ta<tb:ta<=tb;
      return op==='>'?A>B:op==='>='?A>=B:op==='<'?A<B:A<=B;
    }
    const na=+A,nb=+B;
    if(!isNaN(na)&&!isNaN(nb))
      return op==='>'?na>nb:op==='>='?na>=nb:op==='<'?na<nb:na<=nb;
    return false;
  }

  // ========================================================
  // QUERY BUILDER — thenable, Supabase-compatible surface
  // ========================================================
  function QB(table){
    this.table=table;
    this._op='select';
    this._select='*';
    this._filters=[];
    this._orders=[];
    this._limit=null;
    this._range=null;
    this._mode='many';
    this._values=null;
  }
  QB.prototype.select=function(cols){
    if(this._op==='select'&&cols!==undefined&&cols!==null)this._select=cols;
    return this;
  };
  QB.prototype.insert=function(v){this._op='insert';this._values=v;return this;};
  QB.prototype.update=function(v){this._op='update';this._values=v;return this;};
  QB.prototype.delete=function(){this._op='delete';return this;};
  QB.prototype.eq=function(f,v){this._filters.push({op:'eq',f:f,v:v});return this;};
  QB.prototype.neq=function(f,v){this._filters.push({op:'neq',f:f,v:v});return this;};
  QB.prototype.gt=function(f,v){this._filters.push({op:'gt',f:f,v:v});return this;};
  QB.prototype.gte=function(f,v){this._filters.push({op:'gte',f:f,v:v});return this;};
  QB.prototype.lt=function(f,v){this._filters.push({op:'lt',f:f,v:v});return this;};
  QB.prototype.lte=function(f,v){this._filters.push({op:'lte',f:f,v:v});return this;};
  QB.prototype.in=function(f,arr){this._filters.push({op:'in',f:f,v:arr||[]});return this;};
  QB.prototype.order=function(f,opts){
    this._orders.push({f:f,asc:!opts||opts.ascending!==false});
    return this;
  };
  QB.prototype.limit=function(n){this._limit=n;return this;};
  QB.prototype.range=function(a,b){this._range=[a,b];return this;};
  QB.prototype.single=function(){this._mode='single';return this;};
  QB.prototype.maybeSingle=function(){this._mode='maybe';return this;};
  QB.prototype.then=function(onFulfilled,onRejected){
    return this._run().then(onFulfilled,onRejected);
  };

  QB.prototype._match=function(r){
    return this._filters.every(f=>{
      const v=r[f.f];
      switch(f.op){
        case 'eq':return eqMatch(v,f.v);
        case 'neq':return (v===null||v===undefined)?false:!eqMatch(v,f.v);
        case 'gt':return relMatch(v,f.v,'>');
        case 'gte':return relMatch(v,f.v,'>=');
        case 'lt':return relMatch(v,f.v,'<');
        case 'lte':return relMatch(v,f.v,'<=');
        case 'in':return (f.v||[]).some(x=>eqMatch(v,x));
        default:return true;
      }
    });
  };

  function parseSelect(sel){
    const joins=[];
    if(!sel||sel==='*')return{cols:null,joins:joins};
    let rest=sel.replace(/(\w+)\s*\(([^)]*)\)/g,function(m,tb,cs){joins.push({table:tb,cols:cs});return '';});
    rest=rest.replace(/^,\s*/,'').replace(/,\s*$/,'').trim();
    const cols=(rest===''||rest==='*')?null:rest.split(',').map(s=>s.trim()).filter(Boolean);
    return{cols:cols,joins:joins};
  }

  async function applyJoins(rows,joins){
    for(const j of joins){
      const fk=j.table.replace(/s$/,'')+'_id';
      const fk2=j.table+'_id';
      const needed=new Set();
      rows.forEach(r=>{
        const v=(r[fk]!==undefined&&r[fk]!==null)?r[fk]:r[fk2];
        if(v!==undefined&&v!==null)needed.add(String(v));
      });
      const emb=needed.size?await loadRows(j.table):[];
      const map={};emb.forEach(r=>{map[String(r.id)]=r;});
      const want=(j.cols||'').split(',').map(s=>s.trim()).filter(c=>c&&c!=='*');
      rows.forEach(r=>{
        const v=(r[fk]!==undefined&&r[fk]!==null)?r[fk]:r[fk2];
        const src=(v!==undefined&&v!==null)?map[String(v)]:null;
        if(!src){r[j.table]=null;return;}
        if(!want.length){r[j.table]={...src};return;}
        const o={};want.forEach(c=>{o[c]=(src[c]===undefined)?null:src[c];});
        r[j.table]=o;
      });
    }
    return rows;
  }

  QB.prototype._run=async function(){
    try{
      if(this._op==='insert')return{data:await this._doInsert(),error:null};
      if(this._op==='update')return{data:await this._doUpdate(),error:null};
      if(this._op==='delete'){await this._doDelete();return{data:null,error:null};}
      return{data:await this._doSelect(),error:null};
    }catch(e){
      console.warn('db.'+this.table+'.'+this._op+' failed:',e);
      return{data:null,error:{message:(e&&e.message)||'Query failed'}};
    }
  };

  QB.prototype._doSelect=async function(){
    let rows=await loadRows(this.table);
    rows=rows.filter(r=>this._match(r));
    if(this._orders.length){
      const orders=this._orders;
      rows=rows.slice().sort(function(a,b){
        for(let i=0;i<orders.length;i++){
          const c=rel(a[orders[i].f],b[orders[i].f]);
          if(c!==0)return orders[i].asc?c:-c;
        }
        return 0;
      });
    }
    if(this._range)rows=rows.slice(this._range[0],this._range[1]+1);
    if(this._limit!==null&&this._limit!==undefined)rows=rows.slice(0,this._limit);

    const ps=parseSelect(this._select);
    if(ps.joins.length&&rows.length)rows=await applyJoins(rows.map(r=>({...r})),ps.joins);
    else rows=rows.map(r=>({...r}));

    if(ps.cols){
      rows=rows.map(r=>{
        const o={};
        ps.cols.forEach(k=>{o[k]=(r[k]===undefined)?null:r[k];});
        return o;
      });
    }

    if(this._mode==='single'){
      if(rows.length!==1)throw new Error('JSON object requested, multiple (or no) rows returned');
      return rows[0];
    }
    if(this._mode==='maybe'){
      if(rows.length>1)throw new Error('JSON object requested, multiple (or no) rows returned');
      return rows.length?rows[0]:null;
    }
    return rows;
  };

  QB.prototype._doInsert=async function(){
    const docs=Array.isArray(this._values)?this._values:[this._values];
    const rows=await loadRows(this.table);
    let maxId=nextIdFrom(rows);
    const out=[];
    for(const d of docs){
      let id=d.id;
      if(id===undefined||id===null||id===''){id=maxId;maxId=id+1;}
      const row=clean({...d,id:id});
      await docSet(this.table,id,row,false);
      writeAudit('INSERT',this.table,id,null,row);
      out.push(row);
    }
    dropCache(this.table);
    return out;
  };

  QB.prototype._doUpdate=async function(){
    const patch=clean(this._values||{});
    const rows=await loadRows(this.table);
    const targets=rows.filter(r=>this._match(r));
    const out=[];
    for(const t of targets){
      const id=t.id;
      const before={...t};
      const body={...patch,id:id};
      await docSet(this.table,id,body,true);
      const after={...t,...body};
      writeAudit('UPDATE',this.table,id,before,after);
      out.push(after);
    }
    dropCache(this.table);
    return out;
  };

  QB.prototype._doDelete=async function(){
    const rows=await loadRows(this.table);
    const targets=rows.filter(r=>this._match(r));
    if(targets.length){
      for(const t of targets)await docDelete(this.table,t.id);
      targets.forEach(t=>{writeAudit('DELETE',this.table,t.id,{...t},null);});
    }
    dropCache(this.table);
    return null;
  };

  // ========================================================
  // RPC — Firebase-native implementations of Postgres fns
  // ========================================================
  async function fbCreateSale(body){
    const{p_customer_id,p_items,p_paid,p_mode}=body;
    let v_total=0;
    const saleRows=await loadRows('sales');
    const saleId=nextIdFrom(saleRows);
    const invRow=saleRows.map(r=>+r.invoice_no).filter(n=>!isNaN(n));
    const invoice_no=invRow.length?Math.max.apply(null,invRow)+1:saleId;
    const now=new Date().toISOString();
    const uid=fbAuth.currentUser?fbAuth.currentUser.uid:null;
    const itemRows=[];
    const movements=[];

    for(const it of(p_items||[])){
      const itemAmount=it.qty*it.unit_price;
      v_total+=itemAmount;
      const prodRows=await loadRows('products');
      const prod=prodRows.find(p=>eqMatch(p.id,it.product_id));
      if(prod){
        const newStock=+(+prod.current_stock||0)-(+it.qty);
        await docSet('products',prod.id,{current_stock:newStock,updated_at:now},true);
        movements.push({product_id:it.product_id,qty:-it.qty,reason:'sale',
          ref_table:'sales',ref_id:saleId,created_at:now,created_by:uid});
      }
      itemRows.push({sale_id:saleId,product_id:it.product_id,qty:it.qty,
        unit_price:it.unit_price,cost_at_sale:prod?+(prod.purchase_price||0):0,
        amount:itemAmount});
    }

    const itemCol=FB_BASE().collection('sale_items');
    let itemId=nextIdFrom(await loadRows('sale_items'));
    for(const r of itemRows){await docSet('sale_items',itemId,r,false);itemId++;}

    const due=Math.max(v_total-(+p_paid||0),0);
    const sale={id:saleId,invoice_no:invoice_no,customer_id:(p_customer_id===undefined?null:p_customer_id),
      total:v_total,paid_amount:+p_paid||0,due_amount:due,payment_mode:p_mode||'cash',
      notes:null,created_at:now,created_by:uid};
    await docSet('sales',saleId,sale,false);
    writeAudit('INSERT','sales',saleId,null,sale);

    if(movements.length){
      const mvCol=FB_BASE().collection('stock_movements');
      let mvId=nextIdFrom(await loadRows('stock_movements'));
      for(const m of movements){await docSet('stock_movements',mvId,m,false);mvId++;}
    }

    if(p_customer_id!==null&&p_customer_id!==undefined){
      const custRows=await loadRows('customers');
      const cust=custRows.find(c=>eqMatch(c.id,p_customer_id));
      if(cust){
        let bal=+cust.balance||0;
        if(due>0)bal+=due;
        else if((+p_paid||0)>v_total)bal-=(+p_paid-v_total);
        else if(due===0&&(+p_paid||0)===v_total)bal=bal;
        await docSet('customers',cust.id,{balance:bal,updated_at:now},true);
      }
    }

    dropCache('sales');dropCache('sale_items');dropCache('products');
    dropCache('stock_movements');dropCache('customers');
    return saleId;
  }

  async function fbReceivePayment(body){
    const{p_customer_id,p_amount,p_mode,p_note}=body;
    const now=new Date().toISOString();
    const uid=fbAuth.currentUser?fbAuth.currentUser.uid:null;
    const payRows=await loadRows('payments');
    const payId=nextIdFrom(payRows);
    const pay={id:payId,direction:'received',customer_id:p_customer_id,
      supplier_id:null,amount:+p_amount||0,mode:p_mode||'cash',note:p_note||null,
      created_at:now,created_by:uid};
    await docSet('payments',payId,pay,false);
    writeAudit('INSERT','payments',payId,null,pay);

    if(p_customer_id!==null&&p_customer_id!==undefined){
      const custRows=await loadRows('customers');
      const cust=custRows.find(c=>eqMatch(c.id,p_customer_id));
      if(cust){
        await docSet('customers',cust.id,{balance:(+cust.balance||0)-(+p_amount||0),updated_at:now},true);
      }
    }
    dropCache('payments');dropCache('customers');
    return null;
  }

  async function fbCreatePurchase(body){
    const{p_supplier,p_items,p_paid}=body;
    const purRows=await loadRows('purchases');
    const purId=nextIdFrom(purRows);
    const now=new Date().toISOString();
    const uid=fbAuth.currentUser?fbAuth.currentUser.uid:null;
    let v_total=0;
    const itemRows=[];
    const movements=[];
    const prodUpdates={};

    for(const it of(p_items||[])){
      const amt=it.qty*(it.unit_cost||0);
      v_total+=amt;
      const prodRows=await loadRows('products');
      const prod=prodRows.find(p=>eqMatch(p.id,it.product_id));
      if(prod){
        const upd={current_stock:+(prod.current_stock||0)+(+it.qty),updated_at:now};
        if(it.unit_cost>0)upd.purchase_price=it.unit_cost;
        prodUpdates[String(prod.id)]=upd;
        movements.push({product_id:it.product_id,qty:+it.qty,reason:'purchase',
          ref_table:'purchases',ref_id:purId,created_at:now,created_by:uid});
      }
      itemRows.push({purchase_id:purId,product_id:it.product_id,qty:it.qty,
        unit_cost:it.unit_cost||0,amount:amt});
    }

    for(const docId in prodUpdates){
      await docSet('products',docId,prodUpdates[docId],true);
    }
    const itCol=FB_BASE().collection('purchase_items');
    let itId=nextIdFrom(await loadRows('purchase_items'));
    for(const r of itemRows){await docSet('purchase_items',itId,r,false);itId++;}

    const pur={id:purId,supplier_name:p_supplier||'---',total:v_total,
      paid_amount:+p_paid||0,notes:null,created_at:now,created_by:uid};
    await docSet('purchases',purId,pur,false);
    writeAudit('INSERT','purchases',purId,null,pur);

    if(movements.length){
      const mvCol=FB_BASE().collection('stock_movements');
      let mvId=nextIdFrom(await loadRows('stock_movements'));
      for(const m of movements){await docSet('stock_movements',mvId,m,false);mvId++;}
    }

    dropCache('purchases');dropCache('purchase_items');dropCache('products');
    dropCache('stock_movements');
    return purId;
  }

  async function rpc(name,args){
    if(!FB_CONFIGURED)return{data:null,error:{message:'Firebase not configured'}};
    try{
      if(name==='create_sale')return{data:await fbCreateSale(args||{}),error:null};
      if(name==='receive_payment'){await fbReceivePayment(args||{});return{data:null,error:null};}
      if(name==='create_purchase')return{data:await fbCreatePurchase(args||{}),error:null};
      return{data:null,error:{message:'Unknown RPC: '+name}};
    }catch(e){
      console.warn('rpc '+name+' failed:',e);
      return{data:null,error:{message:(e&&e.message)||'Operation failed'}};
    }
  }

  // ========================================================
  // db.auth — Firebase Authentication (Supabase-compatible)
  // ========================================================
  const authShim={
    async signInWithPassword(creds){
      if(!FB_CONFIGURED)return{data:null,error:{message:'Firebase not configured'}};
      try{
        const c=await fbAuth.signInWithEmailAndPassword(creds.email,creds.password);
        return{data:{user:c.user},error:null};
      }catch(e){return{data:null,error:{message:authErr(e),code:e.code}};}
    },
    async getUser(){
      return{data:{user:FB_CONFIGURED?fbAuth.currentUser:null},error:null};
    },
    onAuthStateChange(cb){
      if(!FB_CONFIGURED)return{data:{subscription:null}};
      return fbAuth.onAuthStateChanged(function(u){
        try{cb(u?'SIGNED_IN':'SIGNED_OUT',{user:u});}catch(e){}
      });
    },
    async signOut(){await fbLogout();return{data:null,error:null};},
    async resetPasswordForEmail(email){
      if(!FB_CONFIGURED)return{data:null,error:{message:'Firebase not configured'}};
      try{
        await fbAuth.sendPasswordResetEmail(email);
        return{data:null,error:null};
      }catch(e){return{data:null,error:{message:authErr(e),code:e.code}};}
    },
    async signInWithOAuth(opts){
      if(!FB_CONFIGURED)return{data:null,error:{message:'Firebase not configured'}};
      if(!opts||opts.provider!=='google')
        return{data:null,error:{message:'Only Google sign-in is supported'}};
      const provider=new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({prompt:'select_account'});
      if(window.atr)atr('oauth','google-attempt');
      // Always redirect: no popups, and the result is handled by the SDK on return.
      try{
        if(window.atr)atr('fb','signInWithRedirect');
        await fbAuth.signInWithRedirect(provider);
        return{data:null,error:null};
      }catch(e){
        if(window.atr)atr('fb','redirectERR:'+((e&&e.code)||(e&&e.message)));
        return{data:null,error:{message:authErr(e),code:e&&e.code}};
      }
    }
  };

  // ========================================================
  // window.db — the app-facing facade
  // ========================================================
  window.db={
    from:function(table){return new QB(table);},
    rpc:rpc,
    auth:authShim
  };

  window.FB_STATUS={configured:FB_CONFIGURED,sid:SID,mode:FB_CONFIGURED?'firebase-only':'not-configured'};
  // immediate, boot-independent health probe so the banner always has data
  setTimeout(function(){
    try{
      if(window.fbProbe){
        window.atr&&atr('probe','start');
        window.fbProbe();
      }else{window.atr&&atr('probe','fbProbe-missing');}
    }catch(e){try{atr('probe','throw:'+(e&&e.message));}catch(_){}}
  },1200);
  console.log('firebase-sync v4 loaded. Mode:',FB_CONFIGURED?'Firebase (Auth + Firestore)':'NOT CONFIGURED');
})();
