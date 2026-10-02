const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
function worker(fetchImpl, cached) {
  const handlers = {}, saved = [];
  const c = vm.createContext({ URL, Response, location:{origin:'https://lumi.test'},
    self:{addEventListener:(name,fn)=>handlers[name]=fn}, fetch:fetchImpl,
    caches:{match:async()=>cached,open:async()=>({put:async(req,r)=>saved.push(await r.text())})} });
  vm.runInContext(source, c);
  return { handlers, saved };
}
test('iPhone/PWA : une ouverture charge les correctifs malgré un ancien cache', async () => {
  const w = worker(async()=>new Response('nouvelle interface'), new Response('ancienne interface'));
  let response;
  w.handlers.fetch({request:{url:'https://lumi.test/app.js',method:'GET'},respondWith:p=>response=p});
  assert.equal(await (await response).text(), 'nouvelle interface');
  assert.deepEqual(w.saved, ['nouvelle interface']);
});
test('PWA hors ligne : conserve une interface utilisable et laisse les appels IA au réseau', async () => {
  const w = worker(async()=>{throw new TypeError('offline');}, new Response('interface hors ligne'));
  let response;
  w.handlers.fetch({request:{url:'https://lumi.test/',method:'GET',mode:'navigate'},respondWith:p=>response=p});
  assert.equal(await (await response).text(), 'interface hors ligne');
  w.handlers.fetch({request:{url:'https://lumi.test/api/chat',method:'GET'},respondWith:()=>assert.fail('API mise en cache')});
});
