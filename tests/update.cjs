const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/update.js'), 'utf8');
function setup({ online = true, text = '', version = '2026-10-03.3' } = {}) {
 const buttons = [{ disabled: false, addEventListener() {} }];
 let reloads = 0, checks = 0, message = '';
 const c = vm.createContext({ chatLoading:false,activeChat:null,archiving:false,
   document: {querySelectorAll:()=>buttons,querySelector:s=>s==='#input'?{value:text}:{classList:{contains:()=>true}},addEventListener(){}},
   window:{addEventListener(){}},navigator:{serviceWorker:{register:async()=>({update:async()=>{checks++;}})}},
   fetch:async()=>{if(!online)throw Error('offline');return {ok:true,json:async()=>({version})};},
   location:{reload:()=>{reloads++;}},toast:t=>{message=t;},setLiveMic(){},stopSpeech(){}
 });
 vm.runInContext(source,c);return {c,buttons,reloads:()=>reloads,checks:()=>checks,message:()=>message};
}
test('mise à jour PWA : vérifie le serveur et recharge sans effacer les données ni la connexion',async()=>{
 const t=setup();await t.c.updateLumi();assert.equal(t.checks(),1);assert.equal(t.reloads(),1);
 assert.ok(!source.includes('localStorage.clear'));assert.ok(!source.includes('logout'));
});
test('mise à jour PWA : message en cours ou réseau absent ne provoquent aucun rechargement',async()=>{
 const draft=setup({text:'message non envoyé'});await draft.c.updateLumi();assert.equal(draft.reloads(),0);assert.match(draft.message(),/Termine/);
 const offline=setup({online:false});await offline.c.updateLumi();assert.equal(offline.reloads(),0);assert.equal(offline.buttons[0].disabled,false);assert.match(offline.message(),/Internet/);
});
test('mise à jour PWA : signale la nouvelle version sans interrompre la conversation',async()=>{
 const t=setup({version:'nouvelle-version'});await t.c.checkLumiUpdate();assert.equal(t.reloads(),0);assert.match(t.buttons[0].textContent,/Nouvelle version/);
});
