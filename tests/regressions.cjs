const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const front = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const back = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
function section(s,a,b) { const start=s.indexOf(a); assert.ok(start>=0,a); const end=s.indexOf(b,start);assert.ok(end>start,b);return s.slice(start,end); }
function context(extra={}) { const c={console,structuredClone,AbortController,AbortSignal,TextDecoder,setTimeout,clearTimeout,...extra};vm.createContext(c);return c; }
function run(c,s) {return vm.runInContext(s,c);}
function element() {const classes=new Set();return {value:'',innerHTML:'',textContent:'',handlers:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},addEventListener(k,fn){this.handlers[k]=fn;},appendChild(){},remove(){},removeAttribute(){},insertAdjacentHTML(pos,text){this.innerHTML+=text;},querySelectorAll(){return [];}};}
function ui() {const els={};return {els,$:id=>els[id]||(els[id]=element())};}

test('ancienne leçon : le clic ouvre la session',async()=>{
 let click,opened;const c=context({currentProfile:{id:'a'},escapeHtml:String,formatDate:String,renderSession:s=>opened=s,fetch:async()=>({json:async()=>({sessions:[{topic:'Test',count:1}]})}),$:()=>({classList:{remove(){}},querySelectorAll:()=>[{dataset:{idx:'0'},addEventListener:(type,fn)=>click=fn}]})});
 run(c,section(front,'async function openProgress(view)','// Affiche la conversation'));await c.openProgress();click();assert.equal(opened.topic,'Test');
});
test('quiz : rejette indices décimaux, absents et hors limites',()=>{
 const c=context();run(c,section(back,'function parseQuiz(raw, count)',"app.post('/api/quiz'"));
 for(const answer of [4,1.5,-1,null,undefined]) assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B','C','D'],answer}]),5).length,0);
 assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B'],answer:1}]),5)[0].answer,1);
 assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B','C','D','E'],answer:4}]),5).length,0);
});
test('instructions mathématiques : LaTeX conservé',()=>{
 const c=context();run(c,section(back,'function buildSystemPrompt(profile = {})','// ---------- Recherche web'));const prompt=c.buildSystemPrompt();assert.ok(prompt.includes('\\frac{3}{4}'));assert.ok(prompt.includes('\\times'));assert.ok(!prompt.includes('\f'));assert.ok(!prompt.includes('\t'));
});
function store(extra={}) {const c=context({DATA_FILE:'data.json',DATA_DIR:'.',KV_URL:'https://storage.test',KV_TOKEN:'fake',isDeno:false,denoKv:null,...extra});run(c,section(back,'function loadData()','function topicLabel'));return c;}
test('stockage : chargement raté ne devient pas une base vide',async()=>{
 const c=store({fetch:async()=>({ok:false,status:503})});await assert.rejects(c.initStore());assert.throws(()=>c.getData(),/initialisé/);await assert.rejects(c.setData({}),/initialisé/);
});
test('stockage : écriture refusée conserve les données précédentes',async()=>{
 let fail=false;const c=store({fetch:async()=>fail?{ok:true,json:async()=>({error:'refused'})}:{ok:true,json:async()=>({result:'{"a":1}'})}});await c.initStore();const copy=c.getData();copy.a=2;assert.equal(c.getData().a,1);fail=true;await assert.rejects(c.setData(copy));assert.equal(c.getData().a,1);
});
test('stockage : attend et sérialise les sauvegardes',async()=>{
 let resolve;const gate=new Promise(r=>resolve=r);const order=[];const c=store();const first=c.storedRoute(async()=>{order.push('first');await gate;order.push('saved');});const second=c.storedRoute(async()=>order.push('second'));first({},{});second({},{});await Promise.resolve();assert.deepEqual(order,['first']);resolve();await run(c,'writeQueue');assert.deepEqual(order,['first','saved','second']);
});
function chat(fetch) {const u=ui();const bubbles=[];const c=context({...u,fetch,currentProfile:{id:'a',name:'A'},history:[],chatGeneration:0,activeChat:null,chatLoading:false,archiving:false,stopSpeech(){},addTyping(){},removeTyping(){},setStatus(){},escapeHtml:String,renderMarkdown:String,speak(){},saveChild:async()=>{},addBubble(role,html){bubbles.push(html);return {innerHTML:html,parentElement:{appendChild(){}},closest:()=>({remove(){}})};}});run(c,section(front,'async function send(text, imageBase64)','function setStatus'));return {c,bubbles};}
test('chat : ignore la réponse de l’ancien profil et interdit le double envoi',async()=>{
 let resolve,calls=0;const response=new Promise(r=>resolve=r);const {c,bubbles}=chat(()=>{calls++;return response;});const pending=c.send('hello');await c.send('second');assert.equal(calls,1);c.chatGeneration++;c.currentProfile={id:'b'};c.history=[];resolve({ok:true});await pending;assert.equal(c.history.length,0);assert.equal(bubbles.length,1);assert.equal(c.activeChat,null);
});
test('chat : enregistre sous le profil initial et libère le prochain envoi',async()=>{
 const bytes=new TextEncoder().encode('{"type":"delta","text":"Bonjour"}\n{"type":"done"}\n');let n=0,saved;
 const {c}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));c.saveChild=async(p,h)=>saved={id:p.id,messages:h.slice()};await c.send('hello');assert.equal(saved.id,'a');assert.equal(saved.messages.length,2);assert.equal(c.activeChat,null);
});
test('nouvelle leçon : erreur d’archivage préserve la conversation',async()=>{
 const u=ui();const c=context({...u,currentProfile:{id:'a'},history:[{content:'à garder'}],archiving:false,chatLoading:false,activeChat:null,fetch:async()=>({ok:false}),addBubble(){},escapeHtml:String,cancelChat(){throw Error('ne doit pas effacer');}});run(c,section(front,"$('btn-new').addEventListener",'async function openProgress'));await u.$('btn-new').handlers.click();assert.equal(c.history[0].content,'à garder');assert.equal(c.archiving,false);
});
test('espace parent : erreur ajoutée sans remplacer les contrôles',()=>{
 const u=ui();let replaced=false;const box=u.$('parent-content');Object.defineProperty(box,'innerHTML',{get:()=>'',set:()=>replaced=true});box.insertAdjacentHTML=()=>{};u.$('parent-gate').value='1';const c=context({...u,renderParentArea(){}});run(c,section(front,'function enterParentArea()','async function renderParentArea'));c.enterParentArea();assert.equal(replaced,false);
});
test('quiz : réouverture restaure le sujet et ignore une ancienne requête',async()=>{
 const u=ui();let resolve;const c=context({...u,currentProfile:{id:'a'},lastTopic:()=>'',stopSpeech(){},fetch:()=>new Promise(r=>resolve=r),renderQuizQuestion(){throw Error('réponse obsolète');}});run(c,section(front,'let quizGeneration','function renderQuizQuestion'));u.$('quiz-topic').value='maths';const request=c.startQuiz();assert.ok(u.$('quiz-topic-row').classList.contains('hidden'));u.$('btn-quiz-close').handlers.click();u.$('btn-quiz').handlers.click();assert.ok(!u.$('quiz-topic-row').classList.contains('hidden'));resolve({json:async()=>({quiz:[{}]})});await request;assert.equal(run(c,'quizBusy'),false);
});

test('routes HTTP : sauvegardes concurrentes préservées et échec signalé', async()=>{
 const express=require('express');const app=express();app.use(express.json());let stored='{}',fail=false;
 const c=store({app,fetch:async(url,options)=>{
   if(options.method==='POST') { if(fail)return {ok:false,status:503}; stored=options.body;return {ok:true,json:async()=>({result:'OK'})}; }
   return {ok:true,json:async()=>({result:stored})};
 }});
 await c.initStore();run(c,section(back,'function topicLabel(history)','// Adresses IP locales'));run(c,section(back,'// ---------- Comptes famille (V2) ----------','function buildSystemPrompt(profile = {})'));run(c,section(back,"app.get('/api/profiles'",'// ---------- Demarrage'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  const results=await Promise.all([post('/api/child',{id:'a',history:[{role:'user',content:'A'}]}),post('/api/child',{id:'b',history:[{role:'user',content:'B'}]})]);assert.ok(results.every(r=>r.ok));assert.equal(JSON.parse(stored).spaces.local.a.history[0].content,'A');assert.equal(JSON.parse(stored).spaces.local.b.history[0].content,'B');
  fail=true;const refused=await post('/api/child',{id:'a',action:'archive'});assert.equal(refused.status,503);const old=await (await fetch(base+'/api/child?id=a')).json();assert.equal(old.history[0].content,'A');assert.equal(old.sessions.length,0);
  fail=false;assert.equal((await post('/api/child',{id:'a',action:'archive'})).status,200);const archived=await (await fetch(base+'/api/child?id=a')).json();assert.equal(archived.history.length,0);assert.equal(archived.sessions[0].messages[0].content,'A');
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('sauvegarde locale : fichier invalide ne devient pas une base vide',()=>{
 const c=store({fs:{existsSync:()=>true,readFileSync:()=>'{corrompu'}});assert.throws(()=>c.loadData());
});
test('sauvegarde locale : remplace le fichier seulement après écriture du temporaire',()=>{
 const calls=[];const c=store({fs:{mkdirSync(){},writeFileSync:(file)=>calls.push(file),renameSync:(a,b)=>calls.push([a,b])}});c.saveData({a:1});assert.equal(calls[0],'data.json.tmp');assert.deepEqual(calls[1],['data.json.tmp','data.json']);
});
test('conversation non sauvegardée : conservée en mémoire pour réessayer',async()=>{
 const c=context({pendingLessons:new Map(),fetch:async()=>({ok:false})});run(c,section(front,'async function saveChild(', 'function addBubble'));await assert.rejects(c.saveChild({id:'a'},[{content:'à garder'}]));assert.equal(c.pendingLessons.get('a')[0].content,'à garder');c.fetch=async()=>({ok:true});await c.saveChild({id:'a'},c.pendingLessons.get('a'));assert.equal(c.pendingLessons.size,0);
});
test('migration V2 : profils à plats deviennent l’espace du compte local',()=>{
 const c=context();run(c,section(back,'function migrateLegacy(data)','function topicLabel'));
 const before={profiles:[{id:'a',name:'A',age:7}],a:{name:'A',age:7,history:[{role:'user',content:'x'}],sessions:[]}};
 const m=c.migrateLegacy(before);
 assert.equal(m.accounts.local.id,'local');assert.equal(m.spaces.local.a.history[0].content,'x');
 assert.equal(c.migrateLegacy(m),m); // idempotente : relancer ne change rien
 const intact={a:1};assert.equal(c.migrateLegacy(intact),intact); // sans profils -> intact
});
test('mots de passe : PBKDF2, jamais en clair, vérifiable',async()=>{
 const c=context({crypto:globalThis.crypto,TextEncoder,btoa:globalThis.btoa,atob:globalThis.atob});
 run(c,section(back,'function bufToB64','function parseCookies'));
 const h=await c.hashPassword('secret123');
 assert.match(h,/^pbkdf2:/);assert.ok(!h.includes('secret123'));
 assert.equal(await c.verifyPassword('secret123',h),true);
 assert.equal(await c.verifyPassword('faux',h),false);
 assert.equal(await c.verifyPassword('secret123',''),false);
});
test('RGPD : effacement du compte supprime tout, export donne tout',async()=>{
 const c=store({app:{post(){},get(){}},fetch:async()=>({ok:true,json:async()=>({result:'{}'})})});
 await c.initStore();
 run(c,section(back,'// ---------- Comptes famille (V2) ----------','function buildSystemPrompt(profile = {})'));
 const d=c.getData();
 d.accounts={x:{id:'x',email:'a@b.c',passHash:'h',plan:'free',created:'2026-01-01',consentDate:'2026-01-01',settings:{},usage:{}}};
 d.sessions={t1:{accountId:'x',expires:'2999-01-01'},t2:{accountId:'y',expires:'2999-01-01'}};
 d.spaces={x:{profiles:[{id:'k',name:'K',age:7}],k:{name:'K',age:7,history:[{role:'user',content:'perso'}],sessions:[{topic:'T'}]}}};
 await c.setData(d);
 const exported=await c.accountExport('x');
 assert.equal(exported.account.email,'a@b.c');assert.equal(exported.children[0].conversations[0].content,'perso');assert.equal(exported.children[0].sessions[0].topic,'T');
 await c.accountErase('x');
 const after=c.getData();
 assert.equal(after.accounts.x,undefined);assert.equal(after.spaces.x,undefined);assert.equal(after.sessions.t1,undefined);
 assert.ok(after.sessions.t2); // les autres comptes ne sont pas touchés
});
