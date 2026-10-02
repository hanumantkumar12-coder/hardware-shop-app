// ============================================================
// FIREBASE SYNC — PRIMARY backend (never pauses)
// Supabase = BACKUP (resume manually on pause alert)
//
// Strategy:
//   1. Auth: Firebase primary, Supabase secondary
//   2. Reads: Supabase first (fast); if paused -> Firestore fallback
//   3. Writes: Firebase first (always works), mirror to Supabase
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
      // Also try Supabase (best-effort, for backup data access)
      if(typeof db!=='undefined'&&db){
        db.auth.signInWithPassword({email,password:pass}).catch(()=>{});
      }
      return{user:cred.user,error:null};
    }catch(e){
      if(e.code==='auth/user-not-found'){
        try{
          const cred=await fbAuth.createUserWithEmailAndPassword(email,pass);
          return{user:cred.user,error:null};
        }catch(e2){return{error:{message:e2.message}};}
      }
      return{error:{message:e.message,code:e.code}};
    }
  };

  window.fbLogout=async function(){
    if(!FB_CONFIGURED)return;
    try{await fbAuth.signOut();}catch(e){}
    if(typeof db!=='undefined'&&db){try{await db.auth.signOut();}catch(e){}}
  };

  window.fbGetCurrentUser=function(){
    if(!FB_CONFIGURED)return Promise.resolve(null);
    return new Promise(resolve=>{
      const unsub=fbAuth.onAuthStateChanged(u=>{unsub();resolve(u);});
      setTimeout(()=>{unsub();resolve(null);},3000);
    });
  };

  // ========================================================
  // PROFILE — fetch from Firestore
  // ========================================================
  window.fbGetProfile=async function(uid,email){
    if(!FB_CONFIGURED)return null;
    try{
      const doc=await FB_BASE().collection('profiles').doc(uid).get();
      if(doc.exists)return{id:doc.id,...doc.data()};
      // Auto-create profile
      const prof={name:email||'User',role:'owner',active:true,created_at:new Date().toISOString()};
      await FB_BASE().collection('profiles').doc(uid).set(prof);
      return{id:uid,...prof};
    }catch(e){console.warn('fbGetProfile:',e);return null;}
  };

  // ========================================================
  // DUAL WRITE — Firebase first, Supabase best-effort
  // ========================================================
  window.dualWrite=async function(collection,docId,data,op){
    // Firebase write (primary — always works)
    if(FB_CONFIGURED){
      try{
        const ref=FB_BASE().collection(collection).doc(String(docId));
        if(op==='delete')await ref.delete();
        else await ref.set({...data,id:docId,_ts:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      }catch(e){console.warn('FB write fail:',collection,e);}
    }
    // Supabase write (backup — best effort, may be paused)
    if(typeof db!=='undefined'&&db&&CONFIGURED){
      // Already handled by existing Supabase call in the calling code
    }
  };

  window.dualDelete=async function(collection,docId){
    if(!FB_CONFIGURED)return;
    try{await FB_BASE().collection(collection).doc(String(docId)).delete();}catch(e){}
  };

  window.dualWriteBatch=async function(collection,docs){
    if(!FB_CONFIGURED||!docs.length)return;
    try{
      const batch=fbDb.batch();
      const base=FB_BASE().collection(collection);
      docs.forEach(d=>{
        batch.set(base.doc(String(d.id)),{...d,_ts:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      });
      await batch.commit();
    }catch(e){console.warn('FB batch:',collection,e);}
  };

  // ========================================================
  // FIRESTORE QUERY — fallback reads
  // ========================================================
  window.fbQuery=async function(table,opts){
    if(!FB_CONFIGURED)return null;
    opts=opts||{};
    try{
      let q=FB_BASE().collection(table);
      // Apply equality filters
      if(opts.where){
        opts.where.forEach(([field,op,val])=>{q=q.where(field,op,val);});
      }
      // Order
      if(opts.orderBy){
        const[field,dir]=opts.orderBy;
        q=q.orderBy(field,dir||'asc');
      }
      // Limit
      if(opts.limit)q=q.limit(opts.limit);
      const snap=await q.get();
      return snap.docs.map(d=>({id:isNaN(+d.id)?d.id:+d.id,...d.data()}));
    }catch(e){console.warn('fbQuery fail:',table,e);return null;}
  };

  // ========================================================
  // URL PARSER — extract table+query from Supabase REST URL
  // ========================================================
  function parseRestUrl(url){
    try{
      const u=new URL(url);
      const path=u.pathname; // /rest/v1/products
      const match=path.match(/\/rest\/v1\/(\w+)/);
      if(!match)return null;
      const table=match[1];
      const params=u.searchParams;
      const result={table,where:[],orderBy:null,limit:null,offset:0,select:null,joins:[]};

      // select
      const sel=params.get('select');
      if(sel)result.select=sel;

      // order=col.asc or order=col.desc
      const order=params.get('order');
      if(order){
        const parts=order.split(',');
        const[first]=parts;
        const[col,dir]=first.split('.');
        result.orderBy=[col,dir==='desc'?'desc':'asc'];
      }

      // limit
      const limit=params.get('limit');
      if(limit)result.limit=+limit;

      // offset / range
      const offset=params.get('offset');
      if(offset)result.offset=+offset;

      // Extract joins from select: *,customers(name)
      if(sel&&sel.includes('(')){
        const joinMatches=sel.matchAll(/(\w+)\(([^)]+)\)/g);
        for(const m of joinMatches){result.joins.push({table:m[1],cols:m[2]});}
      }

      // Filters: col=eq.val, col=gt.val, etc.
      for(const[key,val]of params){
        if(['select','order','limit','offset','on_conflict','columns'].includes(key))continue;
        const eqIdx=val.indexOf('.');
        if(eqIdx>0){
          const op=val.substring(0,eqIdx);
          const value=val.substring(eqIdx+1);
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

    // Try Supabase first
    try{
      const resp=await _origFetch(input,init);
      // If Supabase returns error status (project paused/deleted), fallback
      if(resp.status>=400&&resp.status<500&&resp.status!==401&&resp.status!==403){
        const body=await resp.clone().text();
        if(body.includes('pause')||body.includes('not found')||body.includes('PGRST')||resp.status===404||resp.status===410){
          console.warn('Supabase unavailable ('+resp.status+'), falling back to Firebase');
          return fbFallbackResponse(url,init);
        }
      }
      return resp;
    }catch(e){
      // Network error — Supabase paused/unreachable
      console.warn('Supabase unreachable, falling back to Firebase:',e.message);
      return fbFallbackResponse(url,init);
    }
  };

  function fbFallbackResponse(url,init){
    const parsed=parseRestUrl(url);
    if(!parsed){
      // Can't parse — return empty array (PostgREST convention)
      return new Response(JSON.stringify([]),{status:200,headers:{'Content-Type':'application/json'}});
    }

    const method=(init&&init.method)||'GET';

    // POST = insert or RPC
    if(method==='POST'){
      const body=init&&init.body?JSON.parse(init.body):{};
      if(url.includes('/rpc/')){
        // RPC call — handle known RPCs
        const rpcName=url.split('/rpc/')[1].split('?')[0];
        return fbHandleRpc(rpcName,body);
      }
      // Regular insert
      return fbHandleInsert(parsed.table,body);
    }

    // PATCH = update
    if(method==='PATCH'){
      const body=init&&init.body?JSON.parse(init.body):{};
      return fbHandleUpdate(parsed,body);
    }

    // DELETE
    if(method==='DELETE'){
      return fbHandleDelete(parsed);
    }

    // GET = select
    return fbHandleSelect(parsed);
  }

  async function fbHandleSelect(parsed){
    try{
      let data=await fbQuery(parsed.table,{
        where:parsed.where,
        orderBy:parsed.orderBy,
        limit:parsed.limit||undefined
      });
      if(data===null)data=[];

      // Handle joins (e.g., customers(name) in sales select)
      if(parsed.joins.length&&data.length){
        for(const join of parsed.joins){
          // Collect foreign keys
          const fkCol=join.table.replace(/s$/,'')+'_id'; // customers -> customer_id
          const fkCol2=join.table+'_id';
          const ids=new Set();
          data.forEach(row=>{
            const fk=row[fkCol]||row[fkCol2];
            if(fk)ids.add(String(fk));
          });
          if(ids.size){
            const joinDocs=await fbQuery(join.table,{where:null});
            const joinMap={};
            (joinDocs||[]).forEach(j=>{joinMap[String(j.id)]=j;});
            data=data.map(row=>{
              const fk=row[fkCol]||row[fkCol2];
              return{...row,[join.table]:fk?joinMap[String(fk)]||null:null};
            });
          }
        }
      }

      // Filter results that had postgrest-specific filters we couldn't map
      return new Response(JSON.stringify(data),{
        status:200,headers:{'Content-Type':'application/json'}
      });
    }catch(e){
      console.warn('fbHandleSelect error:',e);
      return new Response(JSON.stringify([]),{status:200,headers:{'Content-Type':'application/json'}});
    }
  }

  async function fbHandleInsert(table,body){
    try{
      const docs=Array.isArray(body)?body:[body];
      const results=[];
      for(const doc of docs){
        const ref=FB_BASE().collection(table).doc();
        const dataWithId={...doc,id:doc.id||ref.id,_ts:firebase.firestore.FieldValue.serverTimestamp()};
        // If no numeric id, generate one
        if(!doc.id)dataWithId.id=Date.now()+Math.floor(Math.random()*1000);
        await ref.set(dataWithId);
        results.push(dataWithId);
      }
      // PostgREST insert returns the inserted rows (when .select() is called)
      return new Response(JSON.stringify(results),{status:201,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
    }
  }

  async function fbHandleUpdate(parsed,body){
    try{
      const col=FB_BASE().collection(parsed.table);
      const targets=[];
      if(parsed.where.length){
        let q=col;
        parsed.where.forEach(([f,op,v])=>{q=q.where(f,op,v);});
        const snap=await q.get();
        snap.docs.forEach(d=>targets.push(d));
      }
      for(const doc of targets){
        await doc.ref.update({...body,_ts:firebase.firestore.FieldValue.serverTimestamp()});
      }
      return new Response(JSON.stringify([]),{status:200,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
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
      return new Response(JSON.stringify([]),{status:200,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
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
      return new Response(JSON.stringify({message:'RPC not available in Firebase mode: '+name}),
        {status:400,headers:{'Content-Type':'application/json'}});
    }
    return handler(body);
  }

  async function fbCreateSale(body){
    try{
      const{p_customer_id,p_items,p_paid,p_mode}=body;
      let v_total=0;
      const saleId=Date.now();

      // Create sale
      const saleData={
        id:saleId,
        customer_id:p_customer_id||null,
        total:0,
        paid_amount:p_paid||0,
        due_amount:0,
        payment_mode:p_mode||'cash',
        created_at:new Date().toISOString(),
        created_by:fbAuth.currentUser?fbAuth.currentUser.uid:null
      };

      // Create items + update stock
      for(const it of(p_items||[])){
        const itemAmount=it.qty*it.unit_price;
        v_total+=itemAmount;
        // Reduce stock
        const prodRef=FB_BASE().collection('products').doc(String(it.product_id));
        const prodDoc=await prodRef.get();
        if(prodDoc.exists){
          const curStock=+(prodDoc.data().current_stock||0);
          const newStock=curStock-(+it.qty);
          await prodRef.update({current_stock:newStock,updated_at:new Date().toISOString()});
          // Stock movement
          await FB_BASE().collection('stock_movements').add({
            product_id:it.product_id,qty:-it.qty,reason:'sale',
            ref_table:'sales',ref_id:saleId,created_at:new Date().toISOString()
          });
        }
        // Sale item
        await FB_BASE().collection('sale_items').add({
          sale_id:saleId,product_id:it.product_id,qty:it.qty,
          unit_price:it.unit_price,amount:itemAmount
        });
      }

      // Update sale total + due
      const due=Math.max(v_total-(p_paid||0),0);
      saleData.total=v_total;
      saleData.due_amount=due;
      await FB_BASE().collection('sales').doc(String(saleId)).set(saleData);

      // Update customer balance
      if(p_customer_id&&due>0){
        const custRef=FB_BASE().collection('customers').doc(String(p_customer_id));
        const custDoc=await custRef.get();
        if(custDoc.exists){
          const curBal=+(custDoc.data().balance||0);
          await custRef.update({balance:curBal+due,updated_at:new Date().toISOString()});
        }
      }

      // Return as PostgREST RPC result (scalar)
      return new Response(JSON.stringify(saleId),{status:200,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
    }
  }

  async function fbReceivePayment(body){
    try{
      const{p_customer_id,p_amount,p_mode,p_note}=body;
      await FB_BASE().collection('payments').add({
        direction:'received',customer_id:p_customer_id,amount:p_amount,
        mode:p_mode||'cash',note:p_note||null,created_at:new Date().toISOString(),
        created_by:fbAuth.currentUser?fbAuth.currentUser.uid:null
      });
      // Update customer balance
      const custRef=FB_BASE().collection('customers').doc(String(p_customer_id));
      const custDoc=await custRef.get();
      if(custDoc.exists){
        const curBal=+(custDoc.data().balance||0);
        await custRef.update({balance:curBal-p_amount,updated_at:new Date().toISOString()});
      }
      return new Response(JSON.stringify(null),{status:200,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
    }
  }

  async function fbCreatePurchase(body){
    try{
      const{p_supplier,p_items,p_paid}=body;
      const purId=Date.now();
      let v_total=0;

      for(const it of(p_items||[])){
        v_total+=it.qty*(it.unit_cost||0);
        // Increase stock
        const prodRef=FB_BASE().collection('products').doc(String(it.product_id));
        const prodDoc=await prodRef.get();
        if(prodDoc.exists){
          const d=prodDoc.data();
          const newStock=+(d.current_stock||0)+(+it.qty);
          const updateData={current_stock:newStock,updated_at:new Date().toISOString()};
          if(it.unit_cost>0)updateData.purchase_price=it.unit_cost;
          await prodRef.update(updateData);
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
        paid_amount:p_paid||0,created_at:new Date().toISOString()
      });

      return new Response(JSON.stringify(purId),{status:200,headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({message:e.message}),{status:400,headers:{'Content-Type':'application/json'}});
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

  // ========================================================
  // MIGRATION — push Firebase data to Supabase when it resumes
  // ========================================================
  window.syncFirebaseToSupabase=async function(table){
    if(!FB_CONFIGURED||typeof db==='undefined'||!db)return;
    try{
      const data=await fbQuery(table,{limit:5000});
      if(!data||!data.length)return;
      for(const doc of data){
        const{id,...rest}=doc;
        if(rest._ts)delete rest._ts;
        await db.from(table).upsert(rest,{onConflict:'id'}).then(()=>{});
      }
      console.log('Synced',data.length,'rows from FB to Supabase:',table);
    }catch(e){console.warn('FB→Supabase sync fail:',table,e);}
  };

  // ========================================================
  // STATUS
  // ========================================================
  window.FB_STATUS={
    configured:FB_CONFIGURED,
    sid:SID,
    mode:FB_CONFIGURED?'firebase-primary':'supabase-only'
  };

  console.log('FB_SYNC v2 loaded. Mode:',FB_CONFIGURED?'Firebase PRIMARY + Supabase backup':'Supabase only');
})();
