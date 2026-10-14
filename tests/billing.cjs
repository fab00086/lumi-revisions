const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createHash, createHmac, timingSafeEqual, webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, a); return source.slice(start, end); }

// Fixture : meme ordre que le vrai serveur — le webhook Stripe (corps BRUT)
// est enregistre avant le parseur JSON global, les autres routes apres.
async function fixture(env = {}) {
  const records = [];
  let remote = '{}';
  const stripeCalls = [];
  const ok = json => ({ ok: true, json: async () => json });
  let stripeHandler = async url => {
    if (url.includes('/v1/prices/')) return ok({ unit_amount: url.includes('price_y') ? 7900 : 799, currency: 'eur' });
    if (url.includes('/v1/checkout/sessions')) return ok({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' });
    if (url.includes('/v1/billing_portal/sessions')) return ok({ url: 'https://billing.stripe.test/portal_1' });
    if (url.includes('/v1/subscriptions/')) return ok({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { accountId: 'afam' }, items: { data: [{ current_period_end: 4102444800, price: { id: 'price_m', recurring: { interval: 'month' } } }] } });
    return ok({});
  };
  const appProxy = {
    get: (...a) => records.push(['get', ...a]),
    post: (...a) => records.push(['post', ...a]),
    use: (...a) => records.push(['use', ...a]),
    set: () => {}
  };
  const c = vm.createContext({
    console, app: appProxy, URL, URLSearchParams, path, Buffer, structuredClone,
    createHash, createHmac, timingSafeEqual, crypto: webcrypto,
    TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout, btoa, atob,
    process: { env: { LUMI_ADMIN_CODE: 'test-admin', LUMI_ACCESS_CODE: 'test-house', LUMI_PUBLIC_URL: 'https://lumi.test', LUMI_LOCAL_MODE: '0', ...env } },
    ENV: {}, DATA_FILE: 'unused', DATA_DIR: '.', KV_URL: 'https://storage.test', KV_TOKEN: 'test', isDeno: false, denoKv: null,
    fetch: async (url, opt) => {
      if (String(url).startsWith('https://api.stripe.com')) { stripeCalls.push({ url: String(url), opt }); return stripeHandler(String(url), opt); }
      if (opt?.method === 'POST') remote = opt.body;
      return ok({ result: remote });
    }
  });
  vm.runInContext(section('function loadData()', 'function topicLabel'), c);
  await c.initStore();
  vm.runInContext(section('// ---------- Comptes famille (V2) ----------', 'function buildSystemPrompt(profile = {})'), c);
  const app = express();
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), c.stripeWebhook);
  app.use(express.json());
  for (const [method, ...args] of records) app[method](...args);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, cookie) => fetch(base + route, cookie ? { headers: { Cookie: cookie } } : undefined);
  const post = (route, body, cookie) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const setAccount = async (acc, sessions = {}) => { const d = JSON.parse(remote || '{}'); d.accounts = { ...(d.accounts || {}), [acc.id]: acc }; d.sessions = { ...(d.sessions || {}), ...sessions }; await c.setData(d); };
  const sign = (payload, secret = 'whsec_test') => { const t = Math.floor(Date.now() / 1000); return 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + payload).digest('hex'); };
  const webhook = (event, secret = 'whsec_test') => { const payload = JSON.stringify(event); return fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(payload, secret) }, body: payload }); };
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); };
  return { c, base, get, post, setAccount, webhook, stripeCalls, close, onStripe: h => { stripeHandler = h; }, remote: () => remote };
}

const FAMILY = {
  id: 'afam', email: 'parent@example.test', passHash: '', plan: 'free', created: '2026-01-01',
  settings: { label: 'Famille', maxDevices: 2, dailyLimit: 20 }, usage: {}
};
const COOKIE = 'lumi_session=tok';
const SESSION = { tok: { accountId: 'afam', expires: '2999-01-01' } };
const envStripe = { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_YEARLY: 'price_y' };

test('abonnement : le plan family payant retombe au quota gratuit quand Stripe ne le confirme plus', () => {
  const c = vm.createContext({ console, ENV: {}, accountPut: async () => {} });
  vm.runInContext(section('const FREE_DAILY', 'function rowToAccount'), c);
  const day = vm.runInContext('todayKey()', c);
  const free = vm.runInContext('FREE_DAILY', c);
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  const mk = (stripe, plan = 'family') => ({ id: 'a', plan, settings: { stripe }, usage: { chat: { [day]: free } } });
  // Actif : illimité. Retard de paiement récent : toujours illimité.
  assert.equal(c.planLimit(mk({ status: 'active', currentPeriodEnd: future })), Infinity);
  assert.equal(c.planLimit(mk({ status: 'trialing' })), Infinity);
  assert.equal(c.planLimit(mk({ status: 'past_due', currentPeriodEnd: past })), Infinity);
  // Retard de plus de 30 jours, impayé, résilié depuis la fin de période : quota gratuit.
  assert.equal(c.planLimit(mk({ status: 'past_due', currentPeriodEnd: new Date(Date.now() - 40 * 864e5).toISOString() })), free);
  assert.equal(c.planLimit(mk({ status: 'unpaid', currentPeriodEnd: past })), free);
  assert.equal(c.planLimit(mk({ status: 'canceled', currentPeriodEnd: past })), free);
  // Résiliation programmée : l'accès court jusqu'à la fin de la période payée.
  assert.equal(c.planLimit(mk({ status: 'canceled', currentPeriodEnd: future })), Infinity);
  // Compte famille offert par l'admin (aucune donnée Stripe) : jamais plafonné.
  assert.equal(c.planLimit({ id: 'a', plan: 'family', settings: {}, usage: { chat: { [day]: 999999 } } }), Infinity);
  // Un plafond posé par l'admin reste prioritaire sur tout.
  assert.equal(c.planLimit({ id: 'a', plan: 'family', settings: { dailyLimit: 5, stripe: { status: 'canceled', currentPeriodEnd: past } }, usage: {} }), 5);
  // Plan effectif affiché : family périmé -> free ; essai fini -> free.
  assert.equal(c.effectivePlan({ plan: 'family', settings: { stripe: { status: 'canceled', currentPeriodEnd: past } } }), 'free');
  assert.equal(c.effectivePlan({ plan: 'family', settings: { stripe: { status: 'active', currentPeriodEnd: future } } }), 'family');
  assert.equal(c.effectivePlan({ plan: 'family', settings: {} }), 'family');
  assert.equal(c.effectivePlan({ plan: 'trial', trialEnds: past }), 'free');
  assert.equal(c.effectivePlan({ plan: 'trial', trialEnds: future }), 'trial');
});

test('webhook Stripe : signature vérifiée, falsification et expiration refusées', () => {
  const c = vm.createContext({ Buffer, createHmac, timingSafeEqual });
  vm.runInContext(section('function stripeVerifySignature', 'function stripeWebhook'), c);
  const payload = Buffer.from(JSON.stringify({ type: 'customer.created' }));
  const t = Math.floor(Date.now() / 1000);
  const header = ts => 't=' + ts + ',v1=' + createHmac('sha256', 'whsec_test').update(ts + '.' + payload).digest('hex');
  assert.equal(c.stripeVerifySignature(payload, header(t), 'whsec_test'), true);
  assert.equal(c.stripeVerifySignature(payload, header(t), 'whsec_autre'), false);
  assert.equal(c.stripeVerifySignature(Buffer.from(payload + ' '), header(t), 'whsec_test'), false);
  assert.equal(c.stripeVerifySignature(payload, header(t - 3600), 'whsec_test'), false);
  assert.equal(c.stripeVerifySignature(payload, 'v1=deadbeef', 'whsec_test'), false);
  assert.equal(c.stripeVerifySignature(payload, '', 'whsec_test'), false);
  assert.equal(c.stripeVerifySignature(payload, 't=abc,v1=' + header(t).split('v1=')[1], 'whsec_test'), false);
});

test('Sans clés Stripe : carte invisible, checkout et webhook refusés proprement', async () => {
  const f = await fixture({});
  try {
    await f.setAccount(FAMILY, SESSION);
    const status = await (await f.get('/api/billing/status', COOKIE)).json();
    assert.equal(status.enabled, false);
    assert.equal(status.subscription, null);
    assert.equal(status.plan, 'free');
    const checkout = await f.post('/api/billing/checkout', { interval: 'month' }, COOKIE);
    assert.equal(checkout.status, 503);
    const webhook = await f.post('/api/stripe/webhook', { type: 'x' });
    assert.equal(webhook.status, 503);
    assert.equal(f.stripeCalls.length, 0, 'aucun appel Stripe sans clé');
  } finally { await f.close(); }
});

test('statut et checkout : tarifs lus chez Stripe, prix jamais devinés', async () => {
  const f = await fixture(envStripe);
  try {
    await f.setAccount(FAMILY, SESSION);
    const status = await (await f.get('/api/billing/status', COOKIE)).json();
    assert.equal(status.enabled, true);
    assert.equal(status.plan, 'free');
    assert.equal(status.prices.month.amount, 7.99);
    assert.deepEqual(status.prices.year, { interval: 'year', amount: 79, currency: 'eur' });
    // checkout mensuel : paramètres d'abonnement complets, retour sur Lumi
    const r = await f.post('/api/billing/checkout', { interval: 'month' }, COOKIE);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).url, 'https://checkout.stripe.test/cs_test_1');
    const body = decodeURIComponent(f.stripeCalls.at(-1).opt.body);
    assert.match(body, /mode=subscription/);
    assert.match(body, /line_items\[0\]\[price\]=price_m/);
    assert.match(body, /client_reference_id=afam/);
    assert.match(body, /subscription_data\[metadata\]\[accountId\]=afam/);
    assert.match(body, /success_url=https:\/\/lumi.test\/\?billing=success/);
    assert.match(body, /customer_email=parent@example.test/);
    assert.match(body, /allow_promotion_codes=true/);
    // annuel : c'est bien le second tarif qui part
    await f.post('/api/billing/checkout', { interval: 'year' }, COOKIE);
    assert.match(decodeURIComponent(f.stripeCalls.at(-1).opt.body), /line_items\[0\]\[price\]=price_y/);
    // sans compte connecté : rien ne fuit, aucune session ouverte
    assert.equal((await f.post('/api/billing/checkout', { interval: 'month' })).status, 401);
    assert.equal((await f.get('/api/billing/status')).status, 401);
  } finally { await f.close(); }
});

test('webhook abonnement : activation, portail, résiliation — le compte suit Stripe', async () => {
  const f = await fixture(envStripe);
  try {
    await f.setAccount(FAMILY, SESSION);
    // Abonnement souscrit : l'événement subscription.updated active l'accès famille.
    const activeSub = {
      id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { accountId: 'afam' }, cancel_at_period_end: false,
      items: { data: [{ current_period_end: 4102444800, price: { id: 'price_y', recurring: { interval: 'year' } } }] }
    };
    let r = await f.webhook({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: activeSub } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).received, true);
    let saved = await f.c.accountById('afam');
    assert.equal(saved.plan, 'family');
    assert.equal(saved.settings.stripe.customerId, 'cus_1');
    assert.equal(saved.settings.stripe.interval, 'year');
    assert.ok(saved.settings.stripe.currentPeriodEnd.startsWith('2100-'));
    // Déjà abonné : un second checkout est refusé, le portail est proposé.
    const again = await f.post('/api/billing/checkout', { interval: 'month' }, COOKIE);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).portal, true);
    const portal = await f.post('/api/billing/portal', {}, COOKIE);
    assert.equal(portal.status, 200);
    assert.equal((await portal.json()).url, 'https://billing.stripe.test/portal_1');
    assert.match(decodeURIComponent(f.stripeCalls.at(-1).opt.body), /customer=cus_1/);
    // Échec de paiement : Stripe prévient, Lumi garde l'accès (retard récent).
    r = await f.webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { ...activeSub, status: 'past_due' } } });
    assert.equal(r.status, 200);
    saved = await f.c.accountById('afam');
    assert.equal(saved.plan, 'family');
    assert.equal(saved.settings.stripe.status, 'past_due');
    // Résiliation : l'accès court jusqu'à la fin de période payée…
    r = await f.webhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { ...activeSub, status: 'canceled' } } });
    assert.equal(r.status, 200);
    assert.equal((await f.c.accountById('afam')).plan, 'family');
    // …puis le compte repasse en gratuit, en gardant le client Stripe (factures).
    r = await f.webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { ...activeSub, status: 'canceled', items: { data: [{ current_period_end: 1700000000, price: { id: 'price_y', recurring: { interval: 'year' } } }] } } } });
    assert.equal(r.status, 200);
    saved = await f.c.accountById('afam');
    assert.equal(saved.plan, 'free');
    assert.equal(saved.settings.stripe.customerId, 'cus_1');
    // Signature invalide : refusée, rien ne bouge.
    r = await f.webhook({ id: 'evt_5', type: 'customer.subscription.updated', data: { object: activeSub } }, 'whsec_faux');
    assert.equal(r.status, 400);
    assert.equal((await f.c.accountById('afam')).plan, 'free');
  } finally { await f.close(); }
});

test('espace parent : carte abonnement invisible sans configuration, vrais prix sinon', async () => {
  const front = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = front.indexOf('function billingCardHtml(b)');
  const end = front.indexOf('function wireBillingCard()', start);
  assert.ok(start >= 0 && end > start);
  const code = front.slice(start, end);
  const c = vm.createContext({});
  vm.runInContext(code, c);
  assert.equal(c.billingCardHtml(null), '');
  assert.equal(c.billingCardHtml({ enabled: false }), '');
  const off = c.billingCardHtml({ enabled: true, plan: 'free', subscription: null, prices: { month: { amount: 7.99 }, year: { amount: 79 } } });
  assert.match(off, /Passe à Lumi Famille/);
  assert.match(off, /Mensuel — 7,99 €\/mois/);
  assert.match(off, /Annuel — 79 €\/an/);
  assert.match(off, /quota gratuit s’applique/);
  assert.doesNotMatch(off, /Gérer mon abonnement/);
  assert.doesNotMatch(off, /Apple Pay/, 'le conseil iPhone ne s’affiche pas sur ordinateur');
  const on = c.billingCardHtml({ enabled: true, plan: 'family', subscription: { status: 'active', interval: 'year', currentPeriodEnd: '2100-01-01T00:00:00.000Z', cancelAtPeriodEnd: false }, prices: {} });
  assert.match(on, /Actif jusqu’au 01\/01\/2100/);
  assert.match(on, /formule annuelle/);
  assert.match(on, /Gérer mon abonnement/);
  const due = c.billingCardHtml({ enabled: true, plan: 'free', subscription: { status: 'past_due' }, prices: {} });
  assert.match(due, /dernier paiement n’a pas abouti/);
  const stopped = c.billingCardHtml({ enabled: true, plan: 'free', subscription: { status: 'canceled', currentPeriodEnd: '2020-01-01T00:00:00.000Z' }, prices: {} });
  assert.match(stopped, /Passe à Lumi Famille/);
  assert.match(stopped, /Gérer mon abonnement/);
  // iPhone : le conseil Safari/Apple Pay apparaît, et le paiement ouvre une
  // fenêtre pré-ouverte AVANT le fetch (sinon Safari bloque le popup).
  const iPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ios = vm.createContext({ navigator: { userAgent: iPhone } });
  vm.runInContext(code, ios);
  assert.match(ios.billingCardHtml({ enabled: true, plan: 'free', subscription: null, prices: {} }), /Apple Pay/);
  const openCalls = [];
  const pendingWin = { location: {}, closed: false, close() { this.closed = true; } };
  const ctx = vm.createContext({
    navigator: { userAgent: iPhone }, $: () => ({ textContent: '' }),
    window: { open: (u, t) => { openCalls.push([u, t]); return pendingWin; } },
    location: {}, fetch: async () => ({ ok: true, json: async () => ({ url: 'https://checkout.stripe.test/cs' }) })
  });
  vm.runInContext(code, ctx);
  await ctx.startBilling('month');
  assert.deepEqual(openCalls, [['', '_blank']]);
  assert.equal(pendingWin.location.href, 'https://checkout.stripe.test/cs');
  // Échec côté serveur : la fenêtre pré-ouverte est refermée, rien n’est perdu.
  ctx.fetch = async () => ({ ok: false, json: async () => ({ error: 'refusé' }) });
  await ctx.startBilling('month');
  assert.equal(pendingWin.closed, true);
  // Ordinateur : pas de fenêtre pré-ouverte, redirection directe.
  const desk = vm.createContext({
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, $: () => ({ textContent: '' }),
    window: { open: () => { throw new Error('pas de popup sur ordinateur'); } },
    location: {}, fetch: async () => ({ ok: true, json: async () => ({ url: 'https://checkout.stripe.test/desk' }) })
  });
  vm.runInContext(code, desk);
  await desk.startBilling('year');
  assert.equal(desk.location.href, 'https://checkout.stripe.test/desk');
});

test('checkout terminé : abonnement relu chez Stripe ; relecture en échec = repli sûr', async () => {
  const f = await fixture(envStripe);
  try {
    await f.setAccount(FAMILY, SESSION);
    let r = await f.webhook({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { accountId: 'afam' }, subscription: 'sub_1', customer: 'cus_1' } } });
    assert.equal(r.status, 200);
    let saved = await f.c.accountById('afam');
    assert.equal(saved.plan, 'family');
    assert.equal(saved.settings.stripe.subscriptionId, 'sub_1');
    assert.equal(f.stripeCalls.filter(call => call.url.includes('/v1/subscriptions/')).length, 1);
    // Stripe injoignable à la relecture : le repli note l'abonnement, sans casser le webhook.
    await f.setAccount(FAMILY, SESSION);
    f.onStripe(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'indisponible' } }) }));
    r = await f.webhook({ id: 'evt_cs2', type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { accountId: 'afam' }, subscription: 'sub_2', customer: 'cus_2' } } });
    assert.equal(r.status, 200);
    saved = await f.c.accountById('afam');
    assert.equal(saved.plan, 'family');
    assert.equal(saved.settings.stripe.subscriptionId, 'sub_2');
    assert.equal(saved.settings.stripe.status, 'active');
  } finally { await f.close(); }
});
