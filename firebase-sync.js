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

  // auth step tracer — survives reloads so failures are visible on screen
  window.atr=function(k,v){
    try{
      var t=JSON.parse(localStorage.getItem('authTrace')||'{}');
      t.t=Date.now();t[k]=v;
      localStorage.setItem('authTrace',JSON.stringify(t));
    }catch(e){}
  };
  try{window.atr('pageLoad',(new Date()).toISOString().slice(11,19)+' url='+location.search);}catch(e){}

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
      const unsub=fbAuth.onAuthStateChanged(u=>{if(!done){done=true;unsub();resolve(u);}});
      setTimeout(()=>{if(!done){done=true;unsub();resolve(fbAuth.currentUser);}},3000);
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
        const d=await col.doc(eml).get();
        if(d.exists){
          const p={...d.data()};delete p._ts;
          try{await col.doc(String(uid)).set({...p,id:uid},{merge:true});}catch(e){}
          return{...p,id:uid};
        }
      }
      const d2=await col.doc(String(uid)).get();
      if(d2.exists){const p={...d2.data()};delete p._ts;return{...p,id:d2.id};}
      const defRole=(eml==='hanumantkumar12@gmail.com')?'owner':'staff';
      const prof={name:(email||'User').split('@')[0],role:defRole,active:true,email:eml||null,
                  created_at:new Date().toISOString()};
      await col.doc(eml||String(uid)).set(prof);
      return{id:uid,...prof};
    }catch(e){console.warn('fbGetProfile:',e);return null;}
  };

  // ========================================================
  // ROW CACHE — small collections, short TTL, write-invalidated
  // ========================================================
  const TTL=2000;
  const _cache=new Map();
  const _pending=new Map();

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
      try{
        const snap=await FB_BASE().collection(table).get();
        const rows=snap.docs.map(docToRow);
        _cache.set(table,{ts:Date.now(),rows});
        return rows;
      }finally{_pending.delete(table);}
    })();
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
      FB_BASE().collection('audit_log').doc(String(aid)).set({
        id:aid,
        acted_at:new Date().toISOString(),
        actor:u?u.uid:null,
        actor_name:who?(who.name||who.email):(u?u.email:'?'),
        action:action,table_name:table,row_id:String(rowId),
        old_row:oldRow||null,new_row:newRow||null
      }).catch(()=>{});
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
      await FB_BASE().collection(this.table).doc(String(id)).set(row);
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
      await FB_BASE().collection(this.table).doc(String(id)).set(body,{merge:true});
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
      const batch=fbDb.batch();
      targets.forEach(t=>{batch.delete(FB_BASE().collection(this.table).doc(String(t.id)));});
      await batch.commit();
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
        await FB_BASE().collection('products').doc(String(prod.id)).set(
          {current_stock:newStock,updated_at:now},{merge:true});
        movements.push({product_id:it.product_id,qty:-it.qty,reason:'sale',
          ref_table:'sales',ref_id:saleId,created_at:now,created_by:uid});
      }
      itemRows.push({sale_id:saleId,product_id:it.product_id,qty:it.qty,
        unit_price:it.unit_price,cost_at_sale:prod?+(prod.purchase_price||0):0,
        amount:itemAmount});
    }

    const itemCol=FB_BASE().collection('sale_items');
    let itemId=nextIdFrom(await loadRows('sale_items'));
    for(const r of itemRows){await itemCol.doc(String(itemId)).set(r);itemId++;}

    const due=Math.max(v_total-(+p_paid||0),0);
    const sale={id:saleId,invoice_no:invoice_no,customer_id:(p_customer_id===undefined?null:p_customer_id),
      total:v_total,paid_amount:+p_paid||0,due_amount:due,payment_mode:p_mode||'cash',
      notes:null,created_at:now,created_by:uid};
    await FB_BASE().collection('sales').doc(String(saleId)).set(sale);
    writeAudit('INSERT','sales',saleId,null,sale);

    if(movements.length){
      const mvCol=FB_BASE().collection('stock_movements');
      let mvId=nextIdFrom(await loadRows('stock_movements'));
      for(const m of movements){await mvCol.doc(String(mvId)).set(m);mvId++;}
    }

    if(p_customer_id!==null&&p_customer_id!==undefined){
      const custRows=await loadRows('customers');
      const cust=custRows.find(c=>eqMatch(c.id,p_customer_id));
      if(cust){
        let bal=+cust.balance||0;
        if(due>0)bal+=due;
        else if((+p_paid||0)>v_total)bal-=(+p_paid-v_total);
        else if(due===0&&(+p_paid||0)===v_total)bal=bal;
        await FB_BASE().collection('customers').doc(String(cust.id)).set(
          {balance:bal,updated_at:now},{merge:true});
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
    await FB_BASE().collection('payments').doc(String(payId)).set(pay);
    writeAudit('INSERT','payments',payId,null,pay);

    if(p_customer_id!==null&&p_customer_id!==undefined){
      const custRows=await loadRows('customers');
      const cust=custRows.find(c=>eqMatch(c.id,p_customer_id));
      if(cust){
        await FB_BASE().collection('customers').doc(String(cust.id)).set(
          {balance:(+cust.balance||0)-(+p_amount||0),updated_at:now},{merge:true});
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
      await FB_BASE().collection('products').doc(docId).set(prodUpdates[docId],{merge:true});
    }
    const itCol=FB_BASE().collection('purchase_items');
    let itId=nextIdFrom(await loadRows('purchase_items'));
    for(const r of itemRows){await itCol.doc(String(itId)).set(r);itId++;}

    const pur={id:purId,supplier_name:p_supplier||'---',total:v_total,
      paid_amount:+p_paid||0,notes:null,created_at:now,created_by:uid};
    await FB_BASE().collection('purchases').doc(String(purId)).set(pur);
    writeAudit('INSERT','purchases',purId,null,pur);

    if(movements.length){
      const mvCol=FB_BASE().collection('stock_movements');
      let mvId=nextIdFrom(await loadRows('stock_movements'));
      for(const m of movements){await mvCol.doc(String(mvId)).set(m);mvId++;}
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
      if(window.atr)atr('oauth','google-attempt');
      const doRedirect=async(why)=>{
        if(window.atr)atr('fb',why+'→redirect');
        try{
          await fbAuth.signInWithRedirect(provider);
          return{data:null,error:null};
        }catch(e2){
          if(window.atr)atr('fb','redirectERR:'+(e2.code||e2.message));
          return{data:null,error:{message:authErr(e2),code:e2.code}};
        }
      };
      const isTouch=('ontouchstart' in window)||(navigator.maxTouchPoints>0)||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'');
      if(isTouch)return doRedirect('touch-device');
      try{
        const c=await fbAuth.signInWithPopup(provider);
        if(window.atr)atr('fb','popup-ok');
        return{data:{user:c.user},error:null};
      }catch(e){
        if(e.code==='auth/popup-blocked'||e.code==='auth/popup-closed-by-user'){
          return doRedirect(e.code==='auth/popup-blocked'?'popup-blocked':'popup-closed');
        }
        if(window.atr)atr('fb','ERR '+(e.code||e.message));
        return{data:null,error:{message:authErr(e),code:e.code}};}
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
  console.log('firebase-sync v4 loaded. Mode:',FB_CONFIGURED?'Firebase (Auth + Firestore)':'NOT CONFIGURED');
})();
