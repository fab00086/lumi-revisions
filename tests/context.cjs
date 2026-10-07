const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const back = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function extract(s, start, end) { return s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start))); }

test('contexte : garde plus de seize messages et le texte de la photo', () => {
  const c = vm.createContext({});
  vm.runInContext(extract(back, 'function lessonHistory(', '// ---------- Endpoint principal'), c);
  const history = [{role:'user', content:'[Lecture de la photo]\nExercice 7 : 18 billes.'},
    ...Array.from({length:40}, (_, i) => ({role:i%2?'user':'assistant', content:'échange '+i}))];
  assert.equal(c.lessonHistory(history).length, 41);
  const large = [...history, ...Array.from({length:100}, (_, i) => ({role:i%2?'user':'assistant', content:'x'.repeat(1000)}))];
  const result = c.lessonHistory(large);
  assert.ok(result.some(h => h.content.includes('18 billes')));
  assert.equal(result.at(-1).content, large.at(-1).content);
  assert.match(result[0].content, /omis/);
  assert.ok(result.slice(1).reduce((n,h)=>n+h.content.length,0) <= 48000);
});

test('voix : retire ponctuation et URL, conserve le sens des fractions et décimales', () => {
  const c = vm.createContext({});
  vm.runInContext(extract(front, 'function cleanForSpeech(', '// ---------- Profils'), c);
  const text = c.cleanForSpeech('## Bravo ! Lis **3/4**, puis 2,5. [Source](https://exemple.fr/a). $\\frac{1}{2} \\times 4$');
  assert.match(text, /3 sur 4/);
  assert.match(text, /2 virgule 5/);
  assert.match(text, /1 sur 2 fois 4/);
  assert.doesNotMatch(text, /[.,/\\!#*]|https/);
  assert.match(c.cleanForSpeech('Place un point et une virgule.'), /point et une virgule/);
});

test('stream : ne diffuse jamais le raisonnement à la place de la réponse', async () => {
  const deltas = [];
  const c = vm.createContext({TextDecoder, AbortSignal, ENV:{}, BASE_URL:'http://test', API_KEY:'fake', MODEL:'text', VISION_MODEL:'vision', REASONING_EFFORT:'low', REPLY_TOKENS:4096, PHOTO_TOKENS:4096,
    fetch:async()=>({ok:true,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning":"private thoughts"}}]}\n\n'));controller.close();}})})});
  vm.runInContext(extract(back, 'async function streamOllama(', '// Conserve le début'), c);
  await assert.rejects(c.streamOllama([{role:'user',content:'test'}], {onDelta:d=>deltas.push(d)}), /pas fourni/);
  assert.equal(deltas.length,0);
});

test('photo : transcription jointe au tuteur et retournée pour sauvegarde', async () => {
  let handler, visionCall, tutorMessages;
  const events = [];
  const c = vm.createContext({console, ENV:{}, app:{post(route,fn){handler=fn;}}, PHOTO_TOKENS:4096,
    reserveUsage:async()=>({account:{id:'test'}}), resolveAccount:async()=>({account:{id:'test'}}), accountPut:async()=>{}, buildSystemPrompt:()=> 'Tuteur', lessonHistory:h=>h,
    callOllama:async(messages,options)=>{visionCall={messages,options};return {content:'Exercice 9 : comparer 7/8 et 5/6.'};},
    streamOllama:async(messages,options)=>{tutorMessages=messages;options.onDelta('Quel dénominateur commun ?');},
    searchWeb:async()=>{throw Error('recherche non demandée');}, Buffer});
  vm.runInContext(extract(back, 'const FREE_DAILY', 'function rowToAccount'), c);
  vm.runInContext(extract(back, 'const PHOTO_MAX_BYTES', '// Les erreurs affichees'), c);
  vm.runInContext(extract(back, "app.post('/api/chat'", '// ---------- Quiz'), c);
  const res={writeHead(){},write(line){events.push(JSON.parse(line));},end(){}};
  const jpeg=Buffer.from([0xFF,0xD8,0xFF,0xE0,1,2,3,4,5,6,7,8]).toString('base64');
  await handler({body:{image:jpeg,history:[{role:'user',content:'Je suis en CM2'}],profile:{}}},res);
  assert.equal(visionCall.options.image,jpeg);
  assert.ok(tutorMessages.some(m=>m.content==='Je suis en CM2'));
  assert.match(tutorMessages.at(-1).content,/7\/8 et 5\/6/);
  assert.match(events.at(-1).userContent,/\[Lecture de la photo\]/);
  assert.equal(events.at(-1).type,'done');
});

function streamContext(chunks) {
  const c = vm.createContext({ TextDecoder, AbortSignal, BASE_URL:'http://test', API_KEY:'fake',
    MODEL:'text', VISION_MODEL:'vision', REASONING_EFFORT:'low', REPLY_TOKENS:4096, PHOTO_TOKENS:4096,
    fetch:async()=>({ok:true,body:new ReadableStream({start(controller){
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }})}) });
  vm.runInContext(extract(back, 'async function streamOllama(', '// Conserve le début'), c);
  return c;
}
test('stream : traite la dernière réponse même sans saut de ligne', async () => {
  const c = streamContext(['data: {"choices":[{"delta":{"content":"Bonjour é"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lève."},"finish_reason":"stop"}]}']);
  assert.equal(await c.streamOllama([{role:'user',content:'test'}]), 'Bonjour élève.');
});
test('stream : dernier événement tronqué interdit de valider la réponse', async () => {
  const c = streamContext(['data: {"choices":[{"delta":{"content":"Un début"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}']);
  await assert.rejects(c.streamOllama([{role:'user',content:'test'}]), /interrompue/);
});
test('stream : une erreur du fournisseur ne devient jamais un succès partiel', async () => {
  const c = streamContext(['data: {"choices":[{"delta":{"content":"Un début"}}]}\n\n',
    'data: {"error":{"message":"internal details"}}\n\n']);
  await assert.rejects(c.streamOllama([{role:'user',content:'test'}]), /momentanément indisponible/);
});
