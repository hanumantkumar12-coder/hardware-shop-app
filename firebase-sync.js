// ============================================================
// FIREBASE SYNC — PRIMARY backend (never pauses)
// Supabase = BACKUP (resume manually on pause alert)
//
// Strategy:
//   1. Auth: Firebase primary, Supabase secondary (migration on login)
//   2. Reads: Supabase first (fast); if paused -> Firestore fallback
//   3. Writes: Supabase first, debounced full sync to Firebase
//   4. RPCs: Firebase native implementation when Supabase down
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

  // ========================================================
  // AUTH — Firebase primary
  // ========================================================
  window.fbLogin=async function(email,pass){
    if(!FB_CONFIGURED)return{error:{message:'Firebase not configured'}};
    try{
      const cred=await fbAuth.signInWithEmailAndPassword(email,pass);
      if(typeof db!=='undefined'&&db){
        db.auth.signInWithPassword({email,password:pass}).catch(()=>{});
      }
      return{user:cred.user,error:null};
    }catch(e){
      // NO auto-create here — doLogin migrates only after Supabase verifies password
      return{error:{message:e.message,code:e.code}};
    }
  };

  // Called after Supabase verifies an existing user — creates matching Firebase account
  window.fbMigrateLogin=async function(email,pass){
    if(!FB_CONFIGURED)return{error:{message:'not configured'}};
    try{
      const cred=await fbAuth.createUserWithEmailAndPassword(email,pass);
      return{user:cred.user,error:null};
    }catch(e){
      try{
        const cred=await fbAuth.signInWithEmailAndPassword(email,pass);
        return{user:cred.user,error:null};
      }catch(e2){return{error:{message:e2.message,code:e2.code}};}
    }
  };

  window.fbLogout=async function(){
    if(FB_CONFIGURED){try{await fbAuth.signOut();}catch(e){}}
    if(typeof db!=='undefined'&&db){try{await db.auth.signOut();}catch(e){}}
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
  // PROFILE — keyed by email (stable across auth providers)
  // ========================================================
  window.fbGetProfile=async function(uid,email){
    if(!FB_CONFIGURED)return null;
    try{
      const col=FB_BASE().collection('profiles');
      const eml=(email||'').toLowerCase();
      // 1) canonical doc by email (profiles migrated/synced with email field)
      if(eml){
        const d=await col.doc(eml).get();
        if(d.exists){
          const p={...d.data()};
          // mirror under uid for compatibility
          try{await col.doc(String(uid)).set({...p,id:uid},{merge:true});}catch(e){}
          return{id:uid,...p};
        }
      }
      // 2) doc by uid
      const d2=await col.doc(String(uid)).get();
      if(d2.exists)return{id:d2.id,...d2.data()};
      // 3) create default (least privilege)
      const defRole=(eml==='hanumantkumar12@gmail.com')?'owner':'staff';
      const prof={name:(email||'User').split('@')[0],role:defRole,active:true,email:eml||null,
                  created_at:new Date().toISOString()};
      await col.doc(eml||String(uid)).set(prof);
      return{id:uid,...prof};
    }catch(e){console.warn('fbGetProfile:',e);return null;}
  };

  // ========================================================
  // DUAL WRITE — mirror one row to Firebase
  // ========================================================
  window.dualWrite=async function(collection,docId,data,op){
    if(!FB_CONFIGURED)return;
    try{
      const ref=FB_BASE().collection(collection).doc(String(docId));
      if(op==='delete')await ref.delete();
      else await ref.set({...data,id:docId,_ts:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    }catch(e){console.warn('FB write fail:',collection,e);}
  };

  window.dualDelete=async function(collection,docId){
    if(!FB_CONFIGURED)return;
    try{await FB_BASE().collection(collection).doc(String(docId)).delete();}catch(e){}
  };

  // ========================================================
  // FULL SYNC — pull all Supabase tables -> Firestore
  // (debounced; covers EVERY write path incl. RPC mutations)
  // ========================================================
  const SYNC_TABLES=['profiles','products','customers','suppliers','sales','sale_items',
                     'purchases','purchase_items','payments','expenses','stock_movements'];
  let _syncTimer=null,_syncing=false;
  window.syncAllToFirebase=function(){
    if(!FB_CONFIGURED)return;
    clearTimeout(_syncTimer);
    _syncTimer=setTimeout(_syncAll,2000);
  };
  async function _syncAll(){
    if(_syncing)return;
    if(!FB_CONFIGURED||typeof db==='undefined'||!db)return;
    _syncing=true;
    try{
      for(const t of SYNC_TABLES){
        let rows=null;
        try{
          const{data,error}=await db.from(t).select('*').limit(10000);
          if(!error)rows=data;
        }catch(e){}
        if(!rows||!rows.length)continue;
        // profiles: key by email when available
        const keyOf=(r)=>t==='profiles'&&r.email?String(r.email).toLowerCase():String(r.id);
        for(let i=0;i<rows.length;i+=400){
          const chunk=rows.slice(i,i+400);
          const batch=fbDb.batch();
          const base=FB_BASE().collection(t);
          chunk.forEach(r=>{
            const{id,...rest}=r;
            const docId=keyOf(r);
            const payload={...rest,id:(t==='profiles'&&r.email)?(rest.id||docId):id,
                           _ts:firebase.firestore.FieldValue.serverTimestamp()};
            batch.set(base.doc(docId),payload,{merge:true});
          });
          await batch.commit();
        }
      }
      console.log('[FB_SYNC] all tables synced to Firebase');
    }catch(e){console.warn('[FB_SYNC] sync error:',e);}
    finally{_syncing=false;}
  }

  // ========================================================
  // FIRESTORE QUERY — fallback reads
  // ========================================================
  window.fbQuery=async function(table,opts){
    if(!FB_CONFIGURED)return null;
    opts=opts||{};
    try{
      let q=FB_BASE().collection(table);
      if(opts.where){
        opts.where.forEach(([field,op,val])=>{q=q.where(field,op,val);});
      }
      if(opts.orderBy){
        const[field,dir]=opts.orderBy;
        q=q.orderBy(field,dir||'asc');
      }
      if(opts.limit)q=q.limit(opts.limit);
      const snap=await q.get();
      return snap.docs.map(d=>{const v=d.data();return{...v,id:(v.id!==undefined&&!isNaN(+v.id))?+v.id:(isNaN(+d.id)?d.id:+d.id)};});
    }catch(e){console.warn('fbQuery fail:',table,e);return null;}
  };

  // ========================================================
  // URL PARSER — extract table+query from Supabase REST URL
  // ========================================================
  function parseRestUrl(url){
    try{
      const u=new URL(url);
      const match=u.pathname.match(/\/rest\/v1\/(\w+)/);
      if(!match)return null;
      const table=match[1];
      const params=u.searchParams;
      const result={table,where:[],inFilters:[],orderBy:null,limit:null,offset:0,select:null,joins:[]};

      const sel=params.get('select');
      if(sel)result.select=sel;

      const order=params.get('order');
      if(order){
        const[first]=order.split(',');
        const[col,dir]=first.split('.');
        result.orderBy=[col,dir==='desc'?'desc':'asc'];
      }

      const limit=params.get('limit');
      if(limit)result.limit=+limit;

      const offset=params.get('offset');
      if(offset)result.offset=+offset;

      if(sel&&sel.includes('(')){
        for(const m of sel.matchAll(/(\w+)\(([^)]+)\)/g)){result.joins.push({table:m[1],cols:m[2]});}
      }

      for(const[key,val]of params){
        if(['select','order','limit','offset','on_conflict','columns'].includes(key))continue;
        const eqIdx=val.indexOf('.');
        if(eqIdx>0){
          const op=val.substring(0,eqIdx);
          const value=val.substring(eqIdx+1);
          if(op==='in'){
            const list=(value.startsWith('(')?value.slice(1,-1):value).split(',').map(v=>{
              const n=+v;return isNaN(n)?v:n;
            });
            result.inFilters.push([key,list]);
            continue;
          }
          const opMap={eq:'==',neq:'!=',gt:'>',gte:'>=',lt:'<',lte:'<='};
          if(opMap[op])result.where.push([key,opMap[op],isNaN(+value)?value:+value]);
        }
      }
      return result;
    }catch(e){return null;}
  }

  // ========================================================
  // FETCH INTERCEPTOR — Supabase paused -> Firestore fallback
  // ========================================================
  const _origFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input instanceof Request?input.url:(input&&input.url)||'');

    if(!url.includes('.supabase.co')||!FB_CONFIGURED){
      return _origFetch(input,init);
    }

    try{
      const resp=await _origFetch(input,init);
      if(resp.status>=500){
        console.warn('Supabase 5xx ('+resp.status+'), falling back to Firebase');
        return fbFallbackResponse(url,init);
      }
      if(resp.status>=400&&resp.status!==401&&resp.status!==403){
        const body=await resp.clone().text();
        if(resp.status===404||resp.status===410||resp.status===429||
           body.includes('pause')||body.includes('not found')||body.includes('PGRST')){
          console.warn('Supabase unavailable ('+resp.status+'), falling back to Firebase');
          return fbFallbackResponse(url,init);
        }
      }
      return resp;
    }catch(e){
      console.warn('Supabase unreachable, falling back to Firebase:',e.message);
      return fbFallbackResponse(url,init);
    }
  };

  // Read Accept / Range headers from fetch init (object, Headers, or array)
  function hdr(init,name){
    if(!init||!init.headers)return null;
    const h=init.headers;
    if(typeof Headers!=='undefined'&&h instanceof Headers)return h.get(name);
    if(Array.isArray(h)){const f=h.find(x=>x[0].toLowerCase()===name.toLowerCase());return f?f[1]:null;}
    for(const k of Object.keys(h)){if(k.toLowerCase()===name.toLowerCase())return h[k];}
    return null;
  }

  function jsonResp(obj,status){
    return new Response(JSON.stringify(obj),{status:status||200,headers:{'Content-Type':'application/json'}});
  }

  function fbFallbackResponse(url,init){
    const method=((init&&init.method)||(url.method)||'GET').toUpperCase();
    const parsed=parseRestUrl(url);

    // POST = insert or RPC
    if(method==='POST'){
      const body=(init&&init.body)?JSON.parse(init.body):{};
      if(url.includes('/rpc/')){
        const rpcName=url.split('/rpc/')[1].split('?')[0];
        return fbHandleRpc(rpcName,body);
      }
      if(!parsed)return jsonResp([],201);
      return fbHandleInsert(parsed.table,body);
    }
    if(method==='PATCH'){
      const body=(init&&init.body)?JSON.parse(init.body):{};
      if(!parsed)return jsonResp([]);
      return fbHandleUpdate(parsed,body,init);
    }
    if(method==='DELETE'){
      if(!parsed)return jsonResp([]);
      return fbHandleDelete(parsed);
    }
    if(!parsed)return jsonResp([]);
    return fbHandleSelect(parsed,init);
  }

  async function fbHandleSelect(parsed,init){
    try{
      const accept=hdr(init,'Accept')||'';
      const wantsObject=accept.includes('vnd.pgrst.object');

      let rows=await fbQuery(parsed.table,{
        where:parsed.where,
        orderBy:parsed.orderBy,
        limit:undefined
      });
      if(rows===null)rows=[];

      // client-side IN filters (Firestore whereIn caps at 10 anyway)
      if(parsed.inFilters.length){
        rows=rows.filter(r=>parsed.inFilters.every(([key,list])=>list.includes(r[key])));
      }

      // joins (e.g. sales select=*,customers(name))
      if(parsed.joins.length&&rows.length){
        for(const join of parsed.joins){
          const fkCol=join.table.replace(/s$/,'')+'_id';
          const fkCol2=join.table+'_id';
          const ids=new Set();
          rows.forEach(r=>{const fk=r[fkCol]||r[fkCol2];if(fk!==undefined&&fk!==null)ids.add(String(fk));});
          if(ids.size){
            const joinRows=await fbQuery(join.table,{})||[];
            const joinMap={};
            joinRows.forEach(j=>{joinMap[String(j.id)]=j;});
            rows=rows.map(r=>{
              const fk=r[fkCol]||r[fkCol2];
              return{...r,[join.table]:(fk!==undefined&&fk!==null)?joinMap[String(fk)]||null:null};
            });
          }
        }
      }

      // offset AFTER ordering/filtering
      if(parsed.offset)rows=rows.slice(parsed.offset);
      if(parsed.limit!==null&&parsed.limit!==undefined)rows=rows.slice(0,parsed.limit);

      // PostgREST object mode (.single() / .maybeSingle())
      if(wantsObject){
        if(rows.length===1)return jsonResp(rows[0]);
        return jsonResp({code:'PGRST116',
          details:'The result contains '+rows.length+' rows',
          hint:null,
          message:'JSON object requested, multiple (or no) rows returned'},406);
      }
      return jsonResp(rows);
    }catch(e){
      console.warn('fbHandleSelect error:',e);
      return jsonResp([]);
    }
  }

  async function fbHandleInsert(table,body){
    try{
      const docs=Array.isArray(body)?body:[body];
      const results=[];
      for(const doc of docs){
        const ref=FB_BASE().collection(table).doc();
        const data={...doc};
        if(data.id===undefined||data.id===null)data.id=(table==='profiles'&&doc.email)?doc.email:Date.now()+Math.floor(Math.random()*1000);
        data._ts=firebase.firestore.FieldValue.serverTimestamp();
        await ref.set(data);
        results.push({...doc,id:data.id});
      }
      return jsonResp(results,201);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  async function fbHandleUpdate(parsed,body,init){
    try{
      const col=FB_BASE().collection(parsed.table);
      const targets=[];
      if(parsed.where.length){
        let q=col;
        parsed.where.forEach(([f,op,v])=>{q=q.where(f,op,v);});
        const snap=await q.get();
        snap.docs.forEach(d=>targets.push(d));
      }
      const before=[];
      for(const doc of targets){
        before.push({...doc.data(),id:doc.id});
        await doc.ref.update({...body,_ts:firebase.firestore.FieldValue.serverTimestamp()});
      }
      const accept=hdr(init,'Accept')||'';
      if(accept.includes('return=representation')||accept.includes('json')){
        const updated=targets.map(d=>{const v={...before[targets.indexOf(d)]};return{...v,...body};});
        return jsonResp(updated);
      }
      return jsonResp([]);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  async function fbHandleDelete(parsed){
    try{
      const col=FB_BASE().collection(parsed.table);
      let q=col;
      parsed.where.forEach(([f,op,v])=>{q=q.where(f,op,v);});
      const snap=await q.get();
      const batch=fbDb.batch();
      snap.docs.forEach(d=>batch.delete(d.ref));
      await batch.commit();
      return jsonResp([]);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  // ========================================================
  // RPC HANDLER — Firebase-native implementations
  // ========================================================
  function fbHandleRpc(name,body){
    const handlers={
      create_sale:fbCreateSale,
      receive_payment:fbReceivePayment,
      create_purchase:fbCreatePurchase
    };
    const handler=handlers[name];
    if(!handler){
      return jsonResp({message:'RPC not available in Firebase mode: '+name},400);
    }
    return handler(body);
  }

  async function fbCreateSale(body){
    try{
      const{p_customer_id,p_items,p_paid,p_mode}=body;
      let v_total=0;
      const saleId=Date.now();

      for(const it of(p_items||[])){
        const itemAmount=it.qty*it.unit_price;
        v_total+=itemAmount;
        const prodRef=FB_BASE().collection('products').doc(String(it.product_id));
        const prodDoc=await prodRef.get();
        if(prodDoc.exists){
          const curStock=+(prodDoc.data().current_stock||0);
          await prodRef.update({current_stock:curStock-(+it.qty),updated_at:new Date().toISOString(),
            _ts:firebase.firestore.FieldValue.serverTimestamp()});
          await FB_BASE().collection('stock_movements').add({
            product_id:it.product_id,qty:-it.qty,reason:'sale',
            ref_table:'sales',ref_id:saleId,created_at:new Date().toISOString()
          });
        }
        await FB_BASE().collection('sale_items').add({
          sale_id:saleId,product_id:it.product_id,qty:it.qty,
          unit_price:it.unit_price,amount:itemAmount
        });
      }

      const due=Math.max(v_total-(p_paid||0),0);
      await FB_BASE().collection('sales').doc(String(saleId)).set({
        id:saleId,customer_id:p_customer_id||null,total:v_total,
        paid_amount:p_paid||0,due_amount:due,payment_mode:p_mode||'cash',
        status:'completed',created_at:new Date().toISOString(),
        created_by:fbAuth.currentUser?fbAuth.currentUser.uid:null,
        _ts:firebase.firestore.FieldValue.serverTimestamp()
      });

      if(p_customer_id&&due>0){
        const custRef=FB_BASE().collection('customers').doc(String(p_customer_id));
        const custDoc=await custRef.get();
        if(custDoc.exists){
          const curBal=+(custDoc.data().balance||0);
          await custRef.update({balance:curBal+due,updated_at:new Date().toISOString(),
            _ts:firebase.firestore.FieldValue.serverTimestamp()});
        }
      }
      return jsonResp(saleId);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  async function fbReceivePayment(body){
    try{
      const{p_customer_id,p_amount,p_mode,p_note}=body;
      await FB_BASE().collection('payments').add({
        id:Date.now(),direction:'received',customer_id:p_customer_id,amount:p_amount,
        mode:p_mode||'cash',note:p_note||null,created_at:new Date().toISOString(),
        created_by:fbAuth.currentUser?fbAuth.currentUser.uid:null,
        _ts:firebase.firestore.FieldValue.serverTimestamp()
      });
      const custRef=FB_BASE().collection('customers').doc(String(p_customer_id));
      const custDoc=await custRef.get();
      if(custDoc.exists){
        const curBal=+(custDoc.data().balance||0);
        await custRef.update({balance:curBal-p_amount,updated_at:new Date().toISOString(),
          _ts:firebase.firestore.FieldValue.serverTimestamp()});
      }
      return jsonResp(null);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  async function fbCreatePurchase(body){
    try{
      const{p_supplier,p_items,p_paid}=body;
      const purId=Date.now();
      let v_total=0;
      for(const it of(p_items||[])){
        v_total+=it.qty*(it.unit_cost||0);
        const prodRef=FB_BASE().collection('products').doc(String(it.product_id));
        const prodDoc=await prodRef.get();
        if(prodDoc.exists){
          const d=prodDoc.data();
          const upd={current_stock:+(d.current_stock||0)+(+it.qty),updated_at:new Date().toISOString(),
            _ts:firebase.firestore.FieldValue.serverTimestamp()};
          if(it.unit_cost>0)upd.purchase_price=it.unit_cost;
          await prodRef.update(upd);
          await FB_BASE().collection('stock_movements').add({
            product_id:it.product_id,qty:it.qty,reason:'purchase',
            ref_table:'purchases',ref_id:purId,created_at:new Date().toISOString()
          });
        }
        await FB_BASE().collection('purchase_items').add({
          purchase_id:purId,product_id:it.product_id,qty:it.qty,
          unit_cost:it.unit_cost||0,amount:it.qty*(it.unit_cost||0)
        });
      }
      await FB_BASE().collection('purchases').doc(String(purId)).set({
        id:purId,supplier_name:p_supplier||'---',total:v_total,
        paid_amount:p_paid||0,created_at:new Date().toISOString(),
        _ts:firebase.firestore.FieldValue.serverTimestamp()
      });
      return jsonResp(purId);
    }catch(e){
      return jsonResp({message:e.message},400);
    }
  }

  // ========================================================
  // REALTIME LISTENERS
  // ========================================================
  window.onFirebaseChange=function(collection,callback){
    if(!FB_CONFIGURED)return function(){};
    return FB_BASE().collection(collection)
      .onSnapshot(snapshot=>{
        const changes=[];
        snapshot.docChanges().forEach(change=>{
          changes.push({type:change.type,id:change.doc.id,data:change.doc.data()});
        });
        if(changes.length>0)callback(changes);
      },err=>{});
  };

  window.FB_STATUS={configured:FB_CONFIGURED,sid:SID,mode:FB_CONFIGURED?'firebase-primary':'supabase-only'};
  console.log('FB_SYNC v3 loaded. Mode:',FB_CONFIGURED?'Firebase PRIMARY + Supabase backup':'Supabase only');
})();
