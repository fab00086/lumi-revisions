const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const front = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const back = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
function section(s,a,b) { const start=s.indexOf(a); assert.ok(start>=0,a); const end=s.indexOf(b,start);assert.ok(end>start,b);return s.slice(start,end); }
function context(extra={}) { const c={console,createHash:require("node:crypto").createHash,createHmac:require("node:crypto").createHmac,crypto:require("node:crypto").webcrypto,TextEncoder,allowLoginAttempt:()=>true,accessMailConfigured:()=>false,structuredClone,AbortController,AbortSignal,TextDecoder,setTimeout,clearTimeout,...extra};vm.createContext(c);return c; }
function run(c,s) {return vm.runInContext(s,c);}
function element() {const classes=new Set();return {value:'',innerHTML:'',textContent:'',handlers:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},addEventListener(k,fn){this.handlers[k]=fn;},appendChild(){},remove(){},removeAttribute(){},insertAdjacentHTML(pos,text){this.innerHTML+=text;},querySelectorAll(){return [];}};}
function ui() {const els={};return {els,$:id=>els[id]||(els[id]=element())};}

function loadingChat(fetchImpl) {
 const widgets=ui();
 const c=context({...widgets,fetch:fetchImpl,archiving:false,chatGeneration:0,chatLoading:false,
   currentProfile:null,history:[],pendingLessons:new Map(),escapeHtml:String,addBubble(){},speak(){}});
 c.cancelChat=()=>{c.chatGeneration++;c.chatLoading=false;};
 run(c,section(front,'async function startChat(p)', '// Sauvegarde la lecon'));
 return c;
}
test('chargement de leçon raté : libère le chargement et empêche de remplacer un historique inconnu',async()=>{
 const c=loadingChat(async()=>{throw new TypeError('network');});
 await c.startChat({id:'a',name:'Test',age:9});
 assert.equal(c.chatLoading,false);assert.equal(c.currentProfile,null);
});
test('ancien chargement raté : ne déverrouille pas le nouveau profil encore en chargement',async()=>{
 let rejectFirst,finishSecond,n=0;
 const first=new Promise((resolve,reject)=>rejectFirst=reject);
 const second=new Promise(resolve=>finishSecond=resolve);
 const c=loadingChat(()=>n++?second:first);
 const a=c.startChat({id:'a',name:'A',age:9});
 const b=c.startChat({id:'b',name:'B',age:9});
 rejectFirst(new TypeError('network'));await a;
 assert.equal(c.chatLoading,true);assert.equal(c.currentProfile.id,'b');
 finishSecond({ok:true,json:async()=>({history:[]})});await b;
 assert.equal(c.chatLoading,false);assert.equal(c.currentProfile.id,'b');
});

test('ancienne leçon : le clic ouvre la session',async()=>{
 let click,opened;const c=context({currentProfile:{id:'a'},escapeHtml:String,formatDate:String,renderSession:s=>opened=s,fetch:async()=>({json:async()=>({sessions:[{topic:'Test',count:1}]})}),$:()=>({classList:{remove(){}},querySelectorAll:()=>[{dataset:{idx:'0'},addEventListener:(type,fn)=>click=fn}]})});
 run(c,section(front,'async function openProgress(view)','// Affiche la conversation'));await c.openProgress();click();assert.equal(opened.topic,'Test');
});
test('quiz : rejette indices décimaux, absents et hors limites',()=>{
 const c=context();run(c,section(back,'function parseQuiz(raw, count)',"app.get('/api/curriculum'"));
 for(const answer of [4,1.5,-1,null,undefined]) assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B','C','D'],answer}]),5).length,0);
 assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B'],answer:1}]),5)[0].answer,1);
 assert.equal(c.parseQuiz(JSON.stringify([{question:'Q',options:['A','B','C','D','E'],answer:4}]),5).length,0);
});
test('instructions mathématiques : LaTeX conservé',()=>{
 const c=context();run(c,section(back,'function buildSystemPrompt(profile = {})','// ---------- Recherche web'));const prompt=c.buildSystemPrompt();assert.ok(prompt.includes('\\frac{3}{4}'));assert.ok(prompt.includes('\\times'));assert.ok(!prompt.includes('\f'));assert.ok(!prompt.includes('\t'));
});
test('programme scolaire : le tuteur recoit les notions du bon niveau',()=>{
 const c=context({CURRICULUM:{CM1:{Maths:['les nombres décimaux','l\'aire du rectangle']}},AGE_LEVEL:{9:'CM1'}});
 run(c,section(back,'function profileLevel(profile','// ---------- Stockage des donnees des enfants ----------'));
 run(c,section(back,'function buildSystemPrompt(profile = {})','// ---------- Recherche web'));
 // age 9 -> CM1 (AgeLevel), les notions sont injectees dans le prompt
 const p=c.buildSystemPrompt({name:'Manon',age:9});
 assert.match(p,/PROGRAMME SCOLAIRE \(CM1\)/);assert.match(p,/nombres décimaux/);assert.match(p,/aire du rectangle/);
 // la classe choisie par le parent gagne sur l'age (CM2 absent des donnees : pas de bloc)
 assert.ok(!c.buildSystemPrompt({name:'M',age:9,level:'CM2'}).includes('PROGRAMME SCOLAIRE'));
 // aucune donnee programme : le prompt reste utilisable, sans crash
 const c2=context();run(c2,section(back,'function profileLevel(profile','// ---------- Stockage des donnees des enfants ----------'));
 run(c2,section(back,'function buildSystemPrompt(profile = {})','// ---------- Recherche web'));
 assert.ok(c2.buildSystemPrompt({name:'Manon',age:9}).includes('Lumi'));
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
test('mode discussion : un échec IA libère la réponse avant de reprendre le micro',async()=>{
 const {c}=chat(async()=>{throw new TypeError('network');});
 c.safeText=()=> 'Connexion indisponible';let stopped=0,resumed=0;
 c.stopListening=()=>stopped++;
 c.micLiveResume=()=>{assert.equal(c.activeChat,null);resumed++;};
 await c.send('question');assert.equal(stopped,1);assert.equal(resumed,1);
});
test('photo : énoncé sauvegardé même si le tuteur échoue',async()=>{
 const content='[Lecture de la photo]\nLea a 18 billes et en donne 5.';
 const bytes=new TextEncoder().encode(JSON.stringify({type:'photo',userContent:content})+'\n'+JSON.stringify({type:'error',error:'Modèle indisponible'})+'\n');let n=0,saved;
 const {c}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));
 c.saveChild=async(p,h)=>saved=h.slice();c.speak=()=>assert.fail('erreur prononcée');
 await c.send('Lis cet exercice');assert.equal(saved.length,1);assert.equal(c.history[0].content,content);
});
test('photo : échange réussi sans doublon de l’énoncé',async()=>{
 const content='[Lecture de la photo]\n18 billes.';
 const events=[{type:'photo',userContent:content},{type:'delta',text:'Que faut-il chercher ?'},{type:'done',userContent:content}];
 const bytes=new TextEncoder().encode(events.map(e=>JSON.stringify(e)).join('\n')+'\n');let n=0;
 const {c}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));
 await c.send('Lis cet exercice');assert.equal(c.history.length,2);assert.equal(c.history[0].content,content);assert.equal(c.history[1].role,'assistant');
});
test('chat : ignore la réponse de l’ancien profil et interdit le double envoi',async()=>{
 let resolve,calls=0;const response=new Promise(r=>resolve=r);const {c,bubbles}=chat(()=>{calls++;return response;});const pending=c.send('hello');await c.send('second');assert.equal(calls,1);c.chatGeneration++;c.currentProfile={id:'b'};c.history=[];resolve({ok:true});await pending;assert.equal(c.history.length,0);assert.equal(bubbles.length,1);assert.equal(c.activeChat,null);
});
test('chat : enregistre sous le profil initial et libère le prochain envoi',async()=>{
 const bytes=new TextEncoder().encode('{"type":"delta","text":"Bonjour"}\n{"type":"done"}\n');let n=0,saved;
 const {c}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));c.saveChild=async(p,h)=>saved={id:p.id,messages:h.slice()};await c.send('hello');assert.equal(saved.id,'a');assert.equal(saved.messages.length,2);assert.equal(c.activeChat,null);
});
test('chat : conserve la transcription reçue pour le prochain échange',async()=>{
 const content='[Lecture de la photo]\nExercice 7 : 18 billes';
 const bytes=new TextEncoder().encode(JSON.stringify({type:'delta',text:'Commençons.'})+'\n'+JSON.stringify({type:'done',userContent:content})+'\n');let n=0,saved;
 const {c}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));
 c.saveChild=async(p,h)=>saved=h.slice();await c.send('Lis mon exercice');assert.equal(saved[0].content,content);assert.equal(c.history[0].content,content);
});
test('chat : réponse interrompue non mémorisée et non prononcée',async()=>{
 const bytes=new TextEncoder().encode('{"type":"delta","text":"Réponse partielle"}\n');let n=0;
 const {c,bubbles}=chat(async()=>({ok:true,body:{getReader:()=>({read:async()=>n++?{done:true}:{done:false,value:bytes}})}}));
 c.speak=()=>assert.fail('réponse incomplète prononcée');await c.send('Question');assert.equal(c.history.length,0);assert.match(bubbles.at(-1),/interrompue/);
});
test('nouvelle leçon : confirmation en 2 taps, erreur d’archivage préserve la conversation',async()=>{
 const u=ui();const c=context({...u,currentProfile:{id:'a'},history:[{content:'à garder'}],archiving:false,chatLoading:false,activeChat:null,fetch:async()=>({ok:false}),addBubble(){},escapeHtml:String,cancelChat(){throw Error('ne doit pas effacer');}});run(c,section(front,"$('btn-new').addEventListener",'async function openProgress'));
 const btn=u.$('btn-new');
 await btn.handlers.click();assert.equal(btn.textContent,'Terminer ?');assert.equal(c.archiving,false);assert.equal(c.history[0].content,'à garder');
 await btn.handlers.click();await new Promise(r=>setImmediate(r));assert.equal(c.archiving,false);assert.equal(c.history[0].content,'à garder');
});
test('photo du cahier : prévisualisation, envoi seulement sur confirmation',async()=>{
 const u=ui();let sent=-1,opened=0;
 const c=context({...u,send:(t,img)=>{sent=img;},openCamera:()=>{opened++;},finishCamera:(b)=>{c.__finished=b;},compressImage:async()=>null,toast(){},stopSpeech(){},stopListening(){},stopCamera(){},chatBusy:()=>false,cameraStream:null,cameraCallback:null,cameraFileTarget:null});
 run(c,section(front,'// Bouton 📷 du cahier','// Photo de profil (selfie)'));
 const img=u.$('photo-preview-img'),modal=u.$('photo-preview-modal');
 u.$('btn-camera').handlers.click();assert.equal(opened,1,'la caméra s’ouvre, rien de plus');assert.equal(sent,-1);
 c.showNotebookPhotoPreview('IMG');assert.ok(!modal.classList.contains('hidden'));assert.ok(img.src.includes('IMG'));
 u.$('btn-photo-send').handlers.click();assert.equal(sent,'IMG');assert.ok(modal.classList.contains('hidden'));assert.equal(run(c,'pendingNotebookPhoto'),null);
 c.showNotebookPhotoPreview('RETRY');
 u.$('btn-photo-retake').handlers.click();assert.equal(opened,2,'refaire rouvre la caméra');assert.ok(modal.classList.contains('hidden'));
 u.$('btn-photo-preview-close').handlers.click();assert.equal(run(c,'pendingNotebookPhoto'),null);
 // galerie : image illisible -> message, pas d'envoi
 u.els.mic.handlers.change({target:{files:[{}],value:''}});await new Promise(r=>setImmediate(r));assert.equal(c.__finished,undefined);assert.equal(sent,'IMG');
});
test('photo du cahier : Lumi encore en train de répondre -> la photo reste en prévisualisation',()=>{
 const u=ui();let sent=null,msg='';
 const c=context({...u,send:(t,img)=>{sent=img;},openCamera(){},finishCamera(){},compressImage:async()=>null,toast:m=>{msg=m;},chatBusy:()=>true});
 run(c,section(front,'// Bouton 📷 du cahier','// Photo de profil (selfie)'));
 c.showNotebookPhotoPreview('IMG');u.$('btn-photo-send').handlers.click();
 assert.equal(sent,null,'pas d’envoi perdu');assert.equal(run(c,'pendingNotebookPhoto'),'IMG');
 assert.ok(!u.$('photo-preview-modal').classList.contains('hidden'));assert.match(msg,/Attends/);
});
test('photo : validation serveur (type, encodage, taille)',()=>{
 const c=context({Buffer});run(c,section(back,'const PHOTO_MAX_BYTES','// Les erreurs affichees'));
 const jpeg=Buffer.from([0xFF,0xD8,0xFF,0xE0,1,2,3,4,5,6,7,8]).toString('base64');
 const png=Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,0]).toString('base64');
 assert.equal(c.cleanPhoto(null),null);assert.equal(c.cleanPhoto(''),null);
 assert.equal(c.cleanPhoto(jpeg),jpeg);assert.equal(c.cleanPhoto('data:image/jpeg;base64,'+jpeg),jpeg);assert.equal(c.cleanPhoto(png),png);
 assert.equal(c.cleanPhoto({}),false);assert.equal(c.cleanPhoto('pas une image !'),false);
 assert.equal(c.cleanPhoto(Buffer.from('<svg></svg>').toString('base64')),false);
 assert.equal(c.cleanPhoto('data:text/html;base64,'+jpeg),false);
 assert.equal(c.cleanPhoto(jpeg+'A'.repeat(12*1024*1024)),false,'trop lourde');
});
test('photo : erreur de lecture expliquée à l’enfant',()=>{
 const c=context();run(c,section(back,'const CHILD_SAFE_ERROR','// Conserve le début'));
 assert.match(c.friendlyError(new Error('La lecture de la photo n’a pas marché. Réessaie.')),/photo/);
 assert.match(c.friendlyError(new Error('Ollama 500: {secret}')),/occupée/);
});
test('freemium : local et essai illimités, free plafonné et compté par jour',async()=>{
 const c=context({accountPut:async()=>{},console,ENV:{}});
 run(c,section(back,'const FREE_DAILY','function rowToAccount'));
 const day=run(c,'todayKey()');
 const mk=(over)=>({id:'a',plan:'free',settings:{},usage:{},...over});
 // plan local : jamais limité, jamais compté
 const local=mk({id:'local',plan:'local',usage:{chat:{[day]:9999}}});
 assert.ok(c.quotaOk(local,'chat'));await c.countUsage(local,'chat');assert.equal(local.usage.chat[day],9999);
 // essai dans les temps : illimité. Expiré : plafonné.
 const trial=mk({plan:'trial',trialEnds:new Date(Date.now()+86400000).toISOString(),usage:{chat:{[day]:9999}}});
 assert.ok(c.quotaOk(trial,'chat'));
 const expired=mk({plan:'trial',trialEnds:new Date(Date.now()-86400000).toISOString(),usage:{chat:{[day]:0}}});
 assert.ok(c.quotaOk(expired,'chat'));expired.usage.chat[day]=run(c,'FREE_DAILY');assert.ok(!c.quotaOk(expired,'chat'));
 // plan free : FREE_DAILY par jour
 const free=mk({usage:{chat:{[day]:run(c,'FREE_DAILY')-1}}});
 assert.ok(c.quotaOk(free,'chat'));
 await c.countUsage(free,'chat');assert.equal(free.usage.chat[day],run(c,'FREE_DAILY'));assert.ok(!c.quotaOk(free,'chat'));
 // dailyLimit du compte famille écrase le défaut
 const fam=mk({settings:{dailyLimit:2},usage:{chat:{[day]:2}}});
 assert.ok(!c.quotaOk(fam,'chat'));
 // plafond spécial posé par l'admin : il gagne même sur famille / essai en cours
 const famSpec=mk({plan:'family',settings:{dailyLimit:3},usage:{chat:{[day]:3}}});
 assert.ok(!c.quotaOk(famSpec,'chat'));
 const trialSpec=mk({plan:'trial',trialEnds:new Date(Date.now()+86400000).toISOString(),settings:{dailyLimit:1},usage:{chat:{[day]:1}}});
 assert.ok(!c.quotaOk(trialSpec,'chat'));
 // famille sans plafond : illimité par défaut
 const famInf=mk({plan:'family',usage:{chat:{[day]:999999}}});
 assert.ok(c.quotaOk(famInf,'chat'));
 // l'usage est compté même sur un compte illimité (visibilité admin de la conso)
 await c.countUsage(famInf,'chat');assert.equal(famInf.usage.chat[day],1000000);
 await c.countUsage(trialSpec,'chat');assert.equal(trialSpec.usage.chat[day],2);
 // jetons : cumulés par jour, jamais pour la maison
 assert.ok(c.tokenEstimate('12345678901234567890')>0);
 await c.countTokens(famInf,c.messageTokens([{content:'12345678901234567890'}])+c.tokenEstimate('coucou'));
 assert.equal(famInf.usage.tok[day],9); // ceil(20/3.2)=7 + ceil(6/3.2)=2
 const local2=mk({id:'local',plan:'local',usage:{}});
 await c.countTokens(local2,500);assert.equal(local2.usage.tok,undefined);
 // chat et quiz partagent le plafond quotidien
 const both=mk({usage:{chat:{[day]:0},quiz:{[day]:run(c,'FREE_DAILY')}}});
 assert.ok(!c.quotaOk(both,'chat'));assert.ok(!c.quotaOk(both,'quiz'));
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
test('admin ventes : code requis, actions sur compte, local intouchable, effacement complet',async()=>{
 const express=require('express');const app=express();app.use(express.json());
 // La section extrait déclarée inclut `const ENV = globalThis.process.env` :
 // il faut donc fournir un faux process, pas seulement un stub ENV.
 const c=store({app,process:{env:{LUMI_ADMIN_CODE:'secret'}},ENV:{LUMI_ADMIN_CODE:'secret'},fetch:async()=>({ok:true,json:async()=>({result:'{}'})})});
 await c.initStore();
 run(c,section(back,'// ---------- Comptes famille (V2) ----------','function buildSystemPrompt(profile = {})'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const adminCookie='lumi_admin='+run(c,'adminCookieValue()');
 const post=(route,body,h)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(h?{Cookie:h}:{})},body:JSON.stringify(body)});
 try {
  // sans code : 401 ; avec le mauvais code : 401
  assert.equal((await fetch(base+'/api/admin/accounts')).status,401);
  assert.equal((await post('/api/admin/login',{code:'faux'})).status,401);
  await post('/api/admin/login',{code:'secret'});
  assert.ok((await (await fetch(base+'/api/admin/accounts',{headers:{Cookie:adminCookie}})).json()).accounts);
  // compte client : plan family, puis plafond spécial
  const d=c.getData();
  d.accounts={clt:{id:'clt',email:'clt@famille.fr',passHash:'h',plan:'trial',trialEnds:new Date(Date.now()-86400000).toISOString(),created:'2026-10-01',settings:{},usage:{}},local:{id:'local',plan:'local',settings:{},usage:{}}};
  await c.setData(d);
  let j=await (await fetch(base+'/api/admin/accounts',{headers:{Cookie:adminCookie}})).json();
  assert.equal(j.accounts.length,1);assert.equal(j.accounts[0].email,'clt@famille.fr');assert.ok(j.accounts[0].trialEnds);
  const pr=await post('/api/admin/account',{id:'clt',action:'plan',value:'family'},adminCookie);
    j=await (await fetch(base+'/api/admin/accounts',{headers:{Cookie:adminCookie}})).json();assert.equal(j.accounts[0].plan,'family');
  await post('/api/admin/account',{id:'clt',action:'limit',value:'3'},adminCookie);
  j=await (await fetch(base+'/api/admin/accounts',{headers:{Cookie:adminCookie}})).json();assert.equal(j.accounts[0].dailyLimit,3);
  // le compte local (ta maison) est intouchable
  const refused=await post('/api/admin/account',{id:'local',action:'plan',value:'free'},adminCookie);assert.equal(refused.status,400);
  // suppression = effacement RGPD complet
  await post('/api/admin/account',{id:'clt',action:'delete'},adminCookie);
  assert.equal(c.getData().accounts.clt,undefined);
  const after=await (await fetch(base+'/api/admin/accounts',{headers:{Cookie:adminCookie}})).json();assert.equal(after.accounts.length,0);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
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
