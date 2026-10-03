'use strict';
window.addEventListener('pageshow', event => {
  if (event.persisted) { document.getElementById('admin-view').classList.add('hidden'); location.reload(); }
});
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5000); }
async function post(path, body) {
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Action refusée.');
  return j;
}
function showCode(j) { $('code-label').textContent = 'Accès : ' + j.label + (j.approvalMailStatus ? (j.emailConfigured ? ' — invitation e-mail en attente d’envoi' : ' — e-mail conservé en attente : configure le service d’envoi') : ''); $('issued-code').value = j.code; $('code-result').classList.remove('hidden'); $('code-result').scrollIntoView({behavior:'smooth',block:'center'}); }
const today = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
let previousPending = null;
function count(u) { const d=today(); return (Number(u?.chat?.[d]) || 0) + (Number(u?.quiz?.[d]) || 0); }
async function refresh() {
  try {
    const r = await fetch('/api/admin/accounts');
    if (r.status === 401) { $('admin-view').classList.add('hidden'); $('login-box').classList.remove('hidden'); return; }
    if (!r.ok) throw new Error('Chargement impossible.');
    const j = await r.json();
    $('mail-note').textContent = j.emailNotificationsEnabled ? 'Notifications par e-mail configurées pour les nouvelles demandes.' : 'Notifications par e-mail à activer ci-dessous. Les demandes sont bien conservées ici.';
    if (!$('mail-email').value) {
      const settings = await (await fetch('/api/admin/notifications', { cache: 'no-store' })).json();
      $('mail-email').value = settings.email || '';
      $('mail-from').value = settings.from || '';
      $('mail-key').placeholder = settings.hasKey ? 'Clé enregistrée — laisser vide pour conserver' : 're_…';
    }
    $('admin-view').classList.remove('hidden'); $('login-box').classList.add('hidden');
    const list = (j.accounts || []).sort((a,b) => Number(b.pending)-Number(a.pending));
    const pending = list.filter(a=>a.pending).length;
    if (previousPending !== null && pending > previousPending) toast('Une nouvelle famille demande un accès.');
    previousPending = pending;
    $('admin-sub').textContent = `${list.length} famille${list.length>1?'s':''} · ${pending} demande${pending>1?'s':''} à approuver · ${list.reduce((n,a)=>n+count(a.usage),0)} échanges aujourd’hui`;
    $('mode-note').style.display = j.localMode ? 'block' : 'none';
    $('mode-note').textContent = 'L’espace maison reste illimité. Chaque accès famille garde ses propres limites et données.';
    $('clients').replaceChildren(); $('admin-empty').classList.toggle('hidden', list.length > 0);
    for (const a of list) renderFamily(a, j.freeDaily);
  } catch (e) { toast(e.message || 'Connexion impossible.'); }
}
function confirmTwice(button, fn) {
  button.addEventListener('click', async () => {
    if (!button.dataset.confirm) {
      button.dataset.confirm = '1'; const text = button.textContent; button.textContent='Confirmer ?';
      setTimeout(()=>{delete button.dataset.confirm;button.textContent=text;},5000); return;
    }
    delete button.dataset.confirm; await fn();
  });
}
function renderFamily(a, freeDaily) {
  const card = document.createElement('div'); card.className='client-card';
  const limit = a.dailyLimit ?? (a.plan === 'free' ? freeDaily : null);
  card.innerHTML = `<div class="client-id"><strong>${esc(a.label)}</strong><small>${esc(a.email)}</small>${a.contactPhone?`<small>Téléphone SMS : ${esc(a.contactPhone)}</small>`:''}
    <div class="badges"><span class="badge-plan ${a.pending?'trial':a.blocked?'trial expired':'family'}">${a.pending?'Demande à approuver':a.blocked?'Accès bloqué':'Accès autorisé'}</span></div>
    <p>${a.connectedDevices} / ${a.maxDevices} appareils connectés</p><p><b>${count(a.usage)}</b> échanges aujourd’hui · ${limit === null?'illimité':limit+'/jour'}</p>${a.pending && a.notificationStatus?`<small>${a.notificationStatus==='sent'?'Notification transmise au service e-mail':a.notificationStatus==='review'?'Notification à vérifier auprès du service e-mail':'Notification en attente'}</small>`:''}</div>
    <div class="client-ctl"><label>Utilisation<select class="plan-select plan"><option value="free" ${a.plan==='free'||a.pending?'selected':''}>Quota quotidien</option><option value="family" ${a.plan==='family'?'selected':''}>Illimitée</option><option value="trial" ${a.plan==='trial'?'selected':''}>Essai 14 jours</option></select></label>
    <label>Échanges par jour<input class="limit-input daily" type="number" min="1" max="10000" value="${limit ?? freeDaily}"></label><button class="btn-sm save-limit">Enregistrer l’utilisation</button>
    <label>Appareils autorisés<input class="limit-input devices" type="number" min="1" max="20" value="${a.maxDevices}"></label><button class="btn-sm save-devices">Enregistrer les appareils</button></div>
    <div class="client-ctl"><button class="btn-sm issue">${a.pending?'Approuver et créer le code':a.codeAccess?'Remplacer le code':'Créer le code'}</button><button class="btn-sm block">${a.blocked?'Autoriser l’accès':'Bloquer l’accès'}</button><button class="btn-sm disconnect">Libérer tous les appareils</button><button class="btn-sm warn delete">Supprimer la famille</button></div>`;
  if (a.approvalMailStatus) { const note=document.createElement('p'); note.textContent=a.approvalMailStatus==='sent'?'Invitation acceptée par le service e-mail.':a.approvalMailStatus==='review'?'Invitation à vérifier : copie le code ou contacte la famille.':'Invitation e-mail en attente. Vérifie la configuration d’envoi.';card.querySelector('.client-id').appendChild(note); }
  const act = async (action,value) => {try { const j=await post('/api/admin/account',{id:a.id,action,value}); if(j.code) showCode(j); else toast('Enregistré ✓'); await refresh(); return true; } catch(e) {toast(e.message);return false;} };
  card.querySelector('.save-limit').onclick = async () => {
    const plan=card.querySelector('.plan').value, input=card.querySelector('.daily');
    if (plan==='free' && !input.reportValidity()) return;
    if(await act('plan',plan)) { if(plan==='free') await act('limit',Number(input.value)); }
  };
  card.querySelector('.save-devices').onclick = () => {const input=card.querySelector('.devices'); if(input.reportValidity()) act('devices',Number(input.value));};
  const issue=card.querySelector('.issue');
  if(a.codeAccess) confirmTwice(issue,()=>act('issue-code')); else issue.onclick=()=>act('issue-code');
  // Une demande reste en attente jusqu'à l'émission du code.
  const block=card.querySelector('.block'); block.disabled=a.pending; block.onclick=()=>act('blocked',!a.blocked);
  confirmTwice(card.querySelector('.disconnect'),()=>act('disconnect'));
  confirmTwice(card.querySelector('.delete'),()=>act('delete'));
  $('clients').appendChild(card);
}
$('create-plan').onchange = () => {const unlimited=$('create-plan').value==='family'; $('create-daily-label').classList.toggle('hidden',unlimited);$('create-daily').disabled=unlimited;};
$('create-form').onsubmit = async e => {
  e.preventDefault(); if($('create-submit').disabled)return; $('create-submit').disabled=true;
  try {showCode(await post('/api/admin/create-access',{label:$('create-label').value,plan:$('create-plan').value,dailyLimit:Number($('create-daily').value),maxDevices:Number($('create-devices').value)}));$('create-label').value='';await refresh();}
  catch(e){toast(e.message);} finally{$('create-submit').disabled=false;}
};
$('copy-code').onclick = async () => {try {await navigator.clipboard.writeText($('issued-code').value);toast('Code copié.');}catch{$('issued-code').select();toast('Sélectionne et copie le code.');}};
async function shareFamilyInvitation() {
  const code = $('issued-code').value;
  if (!code) { toast('Crée ou approuve un accès avant de le transmettre.'); return; }
  const url = new URL('/',location.href).href, text='Ton accès à Lumi : '+code+'\nOuvre le lien, saisis ce code et confirme être le parent.\nConfidentialité : '+new URL('/confidentialite.html',location.href).href;
  try {if(navigator.share) await navigator.share({title:'Accès Lumi',text,url});else {await navigator.clipboard.writeText(text+'\n'+url);toast('Invitation copiée. Colle-la dans ton message.');}}
  catch(e){if(e.name!=='AbortError')toast('Utilise Copier pour transmettre le code.');}
}
$('sms-code').onclick = shareFamilyInvitation;
$('share-code').onclick = shareFamilyInvitation;
$('close-code').onclick = () => {$('issued-code').value='';$('code-result').classList.add('hidden');};
$('btn-refresh').onclick=refresh;
$('admin-test').onclick = async () => {
  try { await post('/api/admin/demo', {}); location.href = '/'; }
  catch (error) { toast(error.message); }
};
$('mail-form').onsubmit = async e => {
  e.preventDefault();
  if ($('mail-save').disabled) return;
  $('mail-save').disabled = true;
  try {
    const saved = await post('/api/admin/notifications', { email: $('mail-email').value, key: $('mail-key').value, from: $('mail-from').value });
    $('mail-key').value = '';
    $('mail-result').textContent = saved.configured ? 'Enregistré. Les demandes en attente seront également signalées.' : 'Adresse enregistrée. Ajoute la clé Resend pour activer les envois.';
    await refresh();
  } catch (error) { $('mail-result').textContent = error.message; }
  finally { $('mail-save').disabled = false; }
};
setInterval(()=>{if(!document.hidden&&!$('admin-view').classList.contains('hidden'))refresh();},30000);
$('admin-logout').onclick=async()=>{try{await post('/api/admin/logout',{});$('close-code').click();$('admin-view').classList.add('hidden');$('login-box').classList.remove('hidden');$('admin-code').value='';$('mail-key').value='';$('mail-email').value='';}catch(e){toast(e.message);}};
$('admin-login').onclick=async()=>{try{await post('/api/admin/login',{code:$('admin-code').value});$('admin-code').value='';$('login-err').textContent='';await refresh();}catch(e){$('login-err').textContent=e.message;}};
$('admin-code').onkeydown=e=>{if(e.key==='Enter')$('admin-login').click();};
(async()=>{try {const j=await(await fetch('/api/admin/session')).json();if(!j.enabled){$('login-err').textContent='Configure ton code administrateur dans Render : Environment → LUMI_ADMIN_CODE, puis sauvegarde. Ce code reste réservé à la gestion.';$('admin-login').disabled=true;return;}if(j.open)await refresh();}catch{$('login-err').textContent='Connexion impossible. Recharge la page.';}})();
