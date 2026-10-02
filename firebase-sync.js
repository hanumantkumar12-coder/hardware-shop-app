// ============================================
// FIREBASE SYNC — Dual-write + Fallback + Realtime
// Works alongside Supabase (primary) for always-on availability
// ============================================
(function(){
  // Init Firebase
  if(typeof FIREBASE_CONFIG!=='undefined'&&FIREBASE_CONFIG.apiKey){
    try{
      firebase.initializeApp(FIREBASE_CONFIG);
      window.fbDb=firebase.firestore();
      window.fbAuth=firebase.auth();
      window.FB_CONFIGURED=true;
      // Firestore offline persistence for resilience
      fbDb.enablePersistence({synchronizeTabs:true}).catch(()=>{});
    }catch(e){
      console.warn('Firebase init failed:',e);
      window.FB_CONFIGURED=false;
    }
  }else{
    window.FB_CONFIGURED=false;
    console.warn('Firebase not configured — Supabase only mode');
  }

  const SID='avfdpkytaxeqiuzmpxdu'; // shop ID = Supabase project ref

  // ---- Dual Write: mirror every write to Firebase ----
  window.dualWrite=async function(collection,docId,data,op){
    if(!FB_CONFIGURED)return;
    try{
      const ref=fbDb.collection('shops').doc(SID).collection(collection).doc(String(docId));
      if(op==='delete')await ref.delete();
      else await ref.set({...data,_synced_at:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    }catch(e){console.warn('FB dualWrite fail:',collection,e);}
  };

  // ---- Dual Delete ----
  window.dualDelete=async function(collection,docId){
    if(!FB_CONFIGURED)return;
    try{
      await fbDb.collection('shops').doc(SID).collection(collection).doc(String(docId)).delete();
    }catch(e){console.warn('FB dualDelete fail:',collection,e);}
  };

  // ---- Batch Dual Write (multiple docs at once) ----
  window.dualWriteBatch=async function(collection,docs){
    if(!FB_CONFIGURED||!docs.length)return;
    try{
      const batch=fbDb.batch();
      const base=fbDb.collection('shops').doc(SID).collection(collection);
      docs.forEach(d=>{
        const ref=base.doc(String(d.id));
        batch.set(ref,{...d,_synced_at:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      });
      await batch.commit();
    }catch(e){console.warn('FB batchWrite fail:',collection,e);}
  };

  // ---- Fallback Read: read from Firebase if Supabase fails ----
  window.firebaseRead=async function(collection,queryFn){
    if(!FB_CONFIGURED)return null;
    try{
      const ref=fbDb.collection('shops').doc(SID).collection(collection);
      return await queryFn(ref);
    }catch(e){
      console.warn('FB fallback read fail:',collection,e);
      return null;
    }
  };

  // ---- Firebase Auth Sync ----
  window.syncFirebaseAuth=async function(email,password){
    if(!FB_CONFIGURED)return;
    try{
      await fbAuth.signInWithEmailAndPassword(email,password);
    }catch(e){
      if(e.code==='auth/user-not-found'){
        try{await fbAuth.createUserWithEmailAndPassword(email,password);}
        catch(e2){console.warn('FB auth create fail:',e2);}
      }else if(e.code==='auth/wrong-password'){
        // Firebase user exists with different password — ignore (Supabase is primary)
      }else{
        console.warn('FB auth sync fail:',e.code);
      }
    }
  };

  window.signOutFirebase=async function(){
    if(!FB_CONFIGURED)return;
    try{await fbAuth.signOut();}catch(e){}
  };

  // ---- Realtime Listener ----
  window.onFirebaseChange=function(collection,callback){
    if(!FB_CONFIGURED)return function(){};
    return fbDb.collection('shops').doc(SID).collection(collection)
      .onSnapshot(snapshot=>{
        const changes=[];
        snapshot.docChanges().forEach(change=>{
          changes.push({type:change.type,id:change.doc.id,data:change.doc.data()});
        });
        if(changes.length>0)callback(changes);
      },err=>console.warn('FB listener error:',collection,err));
  };

  // ---- Safe Query: try Supabase first, fallback to Firebase ----
  window.safeQuery=async function(supabasePromise,collection,firebaseQueryFn){
    try{
      const{data,error}=await supabasePromise;
      if(error)throw error;
      // Also dual-write the result if it's a mutation
      return{data,error:null,source:'supabase'};
    }catch(e){
      console.warn('Supabase failed, trying Firebase:',e.message);
      const fbData=await firebaseRead(collection,firebaseQueryFn);
      if(fbData!==null)return{data:fbData,error:null,source:'firebase'};
      return{data:null,error:e,source:'none'};
    }
  };

  // ---- Firebase → Supabase sync (reverse: push FB changes back) ----
  window.syncFromFirebase=async function(table){
    if(!FB_CONFIGURED)return;
    try{
      const snap=await fbDb.collection('shops').doc(SID).collection(table).get();
      const docs=snap.docs.map(d=>({id:+d.id,...d.data()}));
      if(docs.length>0&&typeof db!=='undefined'&&db){
        // Upsert to Supabase
        for(const doc of docs){
          const{id,...rest}=doc;
          if(rest._synced_at)delete rest._synced_at;
          await db.from(table).upsert(rest,{onConflict:'id'}).then(()=>{});
        }
      }
    }catch(e){console.warn('FB→Supabase sync fail:',table,e);}
  };

  console.log('FB_SYNC loaded. Firebase:',FB_CONFIGURED?'ready':'not configured');
})();
