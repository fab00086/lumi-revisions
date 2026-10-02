const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const {createHash,webcrypto} = require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
async function fixture(adminCode = 'test-admin') {
  const app=express();app.use(express.json());let remote='{}', fail=false;
  const c=vm.createContext({console,app,structuredClone,createHash,crypto:webcrypto,TextEncoder,TextDecoder,AbortController,AbortSignal,setTimeout,clearTimeout,
    process:{env:{LUMI_ADMIN_CODE:adminCode,LUMI_ACCESS_CODE:'test-house'}},ENV:{},DATA_FILE:'unused',DATA_DIR:'.',KV_URL:'https://storage.test',KV_TOKEN:'test',isDeno:false,denoKv:null,
    fetch:async(url,opt)=>{if(fail)throw Error('offline');if(opt?.method==='POST')remote=opt.body;return {ok:true,json:async()=>({result:remote})};}});
  vm.runInContext(section('function loadData()','function topicLabel'),c);await c.initStore();
  // Même ordre de protection que dans le serveur complet.
  vm.runInContext(section('const ACCESS_CODE =','// Certificat telechargeable'),c);
  vm.runInContext(section('// ---------- Comptes famille (V2) ----------','function buildSystemPrompt(profile = {})'),c);
  app.get('/api/test-space',async(req,res)=>{const a=await c.resolveAccount(req);res.json({id:a.account.id});});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const admin='lumi_admin='+vm.runInContext('adminCookieValue()',c);
  const post=(route,body,cookie=admin)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const create=async(label='Test',maxDevices=1,plan='free',dailyLimit=2)=>(await post('/api/admin/create-access',{label,maxDevices,plan,dailyLimit})).json();
  const unlock=async(code,cookie='')=>{const r=await post('/api/unlock',{code,consent:true},cookie);return {r,cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
  return {c,base,admin,post,create,unlock,remote:()=>remote,fail:()=>{fail=true;},close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
test('code famille : un seul compte, consentement, plafond appareils et isolation de la maison',async()=>{
  const f=await fixture();try {
    assert.equal((await f.post('/api/admin/create-access',{label:'X'},'')).status,401);
    const a=await f.create('A'),b=await f.create('B');assert.notEqual(a.code,b.code);assert.ok(!f.remote().includes(a.code));
    assert.equal((await f.post('/api/unlock',{code:a.code},'')).status,400);
    const first=await f.unlock(a.code);assert.equal(first.r.status,200);assert.match(first.r.headers.getSetCookie()[0],/HttpOnly/);
    assert.equal((await f.unlock(a.code,first.cookie)).r.status,200);
    assert.equal((await f.unlock(a.code)).r.status,403);
    const second=await f.unlock(b.code);assert.equal(second.r.status,200);
    const id=async cookie=>(await(await fetch(f.base+'/api/test-space',{headers:{Cookie:cookie}})).json()).id;
    assert.notEqual(await id(first.cookie),await id(second.cookie));
    assert.equal((await f.post('/api/auth/register',{email:'extra@famille.fr',password:'test-pass',consent:true},first.cookie)).status,403);
    const accounts=await f.c.allAccounts();assert.equal(accounts.length,2);
    const acc=accounts.find(x=>x.settings.label==='A');
    await f.post('/api/admin/account',{id:acc.id,action:'blocked',value:true});
    assert.equal((await fetch(f.base+'/api/test-space',{headers:{Cookie:first.cookie+'; lumi_access='+vm.runInContext('accessCookieValue()',f.c)}})).status,401);
    assert.equal((await f.unlock(a.code)).r.status,401);
  }finally{await f.close();}
});
test('demande publique : aucun accès avant approbation, code remplacé et sessions révoquées',async()=>{
 const f=await fixture();try {
   assert.equal((await f.post('/api/access-request',{name:'Famille',email:'parent@example.test',consent:false},'')).status,400);
   assert.equal((await f.post('/api/access-request',{name:'Famille',email:'parent@example.test',consent:true},'')).status,202);
   assert.equal((await f.post('/api/access-request',{name:'Famille',email:'parent@example.test',consent:true},'')).status,202);
   const rows=await f.c.allAccounts();assert.equal(rows.length,1);const acc=rows[0];assert.equal(acc.settings.pending,true);
   const issued=await(await f.post('/api/admin/account',{id:acc.id,action:'issue-code'})).json();
   const connected=await f.unlock(issued.code);assert.equal(connected.r.status,200);
   const renewed=await(await f.post('/api/admin/account',{id:acc.id,action:'issue-code'})).json();
   assert.notEqual(issued.code,renewed.code);assert.equal((await f.unlock(issued.code)).r.status,401);
   assert.equal((await fetch(f.base+'/api/test-space',{headers:{Cookie:connected.cookie}})).status,401);
   assert.equal((await f.unlock(renewed.code)).r.status,200);
 }finally{await f.close();}
});
test('quota partagé et simultané : réservation sérialisée, illimité et comptage des jetons préservent le blocage',async()=>{
 const f=await fixture();try {
   const a=await f.create('Limitée',2,'free',2),conn=await f.unlock(a.code);const req={headers:{cookie:conn.cookie}};
   const result=await Promise.all([f.c.reserveUsage(req,'chat'),f.c.reserveUsage(req,'quiz'),f.c.reserveUsage(req,'chat')]);
   assert.equal(result.filter(r=>r.account).length,2);assert.equal(result.filter(r=>r.error).length,1);
   const acc=result[0].account;await f.post('/api/admin/account',{id:acc.id,action:'blocked',value:true});await f.c.countTokens(acc,100);
   assert.equal((await f.c.accountById(acc.id)).settings.blocked,true);
   const b=await f.create('Illimitée',1,'family');const con=await f.unlock(b.code);const unlimited=await f.c.resolveAccount({headers:{cookie:con.cookie}});
   assert.equal(f.c.planLimit(unlimited.account),Infinity);
 }finally{await f.close();}
});
test('création impossible si le cloud refuse la sauvegarde : aucun code accepté',async()=>{
 const f=await fixture();try {f.fail();assert.equal((await f.post('/api/admin/create-access',{label:'X',maxDevices:1,plan:'free',dailyLimit:2})).status,503);assert.equal((await f.c.allAccounts()).length,0);}finally{await f.close();}
});
test('connexions simultanées : une seule place accordée et libération immédiate par le responsable',async()=>{
 const f=await fixture();try {
   const a=await f.create();const connections=await Promise.all([f.unlock(a.code),f.unlock(a.code)]);
   assert.deepEqual(connections.map(c=>c.r.status).sort(),[200,403]);
   const acc=(await f.c.allAccounts())[0];
   await f.post('/api/admin/account',{id:acc.id,action:'disconnect'});
   assert.equal((await f.unlock(a.code)).r.status,200);
 }finally{await f.close();}
});
test('partage natif : ouvre le choix de messagerie avec un lien sans code ni données privées',async()=>{
 const front=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
 const start=front.indexOf('async function shareLumi()'),end=front.indexOf("$('btn-share-app')",start);let shared;
 const c=vm.createContext({URL,location:{href:'https://lumi.test/?code=secret'},navigator:{share:async value=>shared=value},toast(){throw Error('partage raté');}});
 vm.runInContext(front.slice(start,end),c);await c.shareLumi();
 assert.equal(shared.url,'https://lumi.test/');assert.match(shared.text,/Demander un accès/);assert.ok(!JSON.stringify(shared).includes('secret'));
});
test('une nouvelle famille ne récupère pas les anciens profils maison du navigateur',async()=>{
 const front=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');let imports=0;
 const c=vm.createContext({fetch:async url=>({ok:true,json:async()=>url==='/api/auth/me'?{local:false}:[]}),localStorage:{getItem(){imports++;return '[{"id":"maison"}]';}},saveProfiles:async()=>{throw Error('migration vers famille interdite');}});
 vm.runInContext('let profilesCache=[];let profileFetchGeneration=0;'+front.slice(front.indexOf('async function fetchProfiles()'),front.indexOf('function loadProfiles()')),c);
 await c.fetchProfiles();assert.equal(imports,0);assert.equal(vm.runInContext('profilesCache.length',c),0);
});


test('admin : les espaces de copie autour de la variable Render ne rendent pas le code inutilisable',async()=>{
 const f=await fixture('  test-admin\r\n');try {
   const r=await f.post('/api/admin/login',{code:'test-admin'},'');assert.equal(r.status,200);
   const cookie=r.headers.getSetCookie()[0].split(';')[0];
   assert.equal((await fetch(f.base+'/api/admin/accounts',{headers:{Cookie:cookie}})).status,200);
   assert.equal((await f.post('/api/admin/login',{code:'autre-code'},'')).status,401);
 }finally{await f.close();}
});
