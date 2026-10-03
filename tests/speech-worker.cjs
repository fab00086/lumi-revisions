const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');

test('moteur vocal : réponses successives et simultanées distinctes, redémarrage après arrêt',async t=>{
 const speech=await import(pathToFileURL(path.join(__dirname,'../speech.js')).href);
 if(!speech.speechAvailable()){t.skip('Modèle vocal absent sur cette machine.');return;}
 try{
  const [a,b]=await Promise.all([speech.generateSpeech('Bonjour.'),speech.generateSpeech('Cette deuxième réponse doit rester différente.')]);
  assert.equal(a.toString('ascii',0,4),'RIFF');assert.equal(b.toString('ascii',0,4),'RIFF');assert.notDeepEqual(a,b);
  assert.ok(a.length>1000);assert.ok(b.length>1000);
  speech.closeSpeechWorker();
  const c=await speech.generateSpeech('Le moteur a redémarré.');assert.equal(c.toString('ascii',0,4),'RIFF');assert.ok(c.length>1000);
 }finally{speech.closeSpeechWorker();}
});
