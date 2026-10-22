// « Le lien ouvre Chrome et rien ne marche » : sur iPhone, Savika a besoin de
// Safari (voix, micro, installation) ; dans les navigateurs internes des
// messageries, on guide. gateBrowserHint() detecte l'appareil et le navigateur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const front = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function hintAvec(ua, extra = {}) {
  const start = front.indexOf('function gateBrowserHint()');
  const end = front.indexOf('function showGateBrowserHint()', start);
  assert.ok(start >= 0 && end > start, 'gateBrowserHint introuvable');
  const c = vm.createContext({
    navigator: { userAgent: ua, platform: extra.platform || (ua.includes('iPhone') ? 'iPhone' : 'Linux armv8l'), maxTouchPoints: extra.touch ?? 5, standalone: extra.standalone },
    window: { matchMedia: () => ({ matches: !!extra.standalone }) }
  });
  vm.runInContext(front.slice(start, end), c);
  return c.gateBrowserHint();
}

test('guide d ouverture : iPhone -> Safari requis, autres navigateurs et messageries guides', () => {
  // iPhone Safari : rien à signaler.
  assert.equal(hintAvec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), '');
  // iPhone Chrome (CriOS) : guide Safari.
  assert.equal(hintAvec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1'), 'ios-other');
  // iPhone navigateur interne WhatsApp (pas de Safari/ dans l UA) : guide Safari.
  assert.equal(hintAvec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'), 'ios-other');
  // iPhone Instagram : guide Safari.
  assert.equal(hintAvec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0'), 'ios-other');
  // iPhone app installée (standalone) : rien à signaler.
  assert.equal(hintAvec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', { standalone: true }), '');
  // iPadOS 13+ se déclare MacIntel avec points tactiles : traité comme iOS.
  assert.equal(hintAvec('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { platform: 'MacIntel', touch: 5 }), '');
  // Android Chrome : rien à signaler (installation native possible).
  assert.equal(hintAvec('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'), '');
  // Android navigateur interne Facebook : guide Chrome.
  assert.equal(hintAvec('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 [FBAN/FB4A;FBAV/460.0]'), 'android-inapp');
  // Android navigateur interne TikTok : guide Chrome.
  assert.equal(hintAvec('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 TikTok 35.1'), 'android-inapp');
  // Ordinateur Mac (sans tactile) : rien à signaler.
  assert.equal(hintAvec('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { platform: 'MacIntel', touch: 0 }), '');
});