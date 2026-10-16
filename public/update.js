// Explicit updates preserve account cookies and all saved family data.
// IMPORTANT : garder cette valeur EGALE a la version de server.js (/api/version)
// sinon le bouton « Mettre à jour » et le toast restent affichés en boucle.
// tests/version-sync.cjs verifie la concordance.
const lumiInterfaceVersion = '2026-10-16.11';
let lumiUpdateBusy = false;
let lumiUpdateNotice = false;
// Mise a jour AUTOMATIQUE (sans passer par Reglages) : la version est
// verifiee a chaque ouverture / retour au premier plan ; elle s'applique
// seulement HORS LECON (ecran des profils, aucune fenetre ouverte), sinon
// elle attend le retour aux profils ou la prochaine ouverture.
let lumiUpdatePending = false;
let lumiReloading = false;
async function checkLumiUpdate() {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;
    const { version } = await response.json();
    const badge = document.getElementById?.('lumi-version');
    if (badge) badge.textContent = version === lumiInterfaceVersion
      ? `Version installée : ${lumiInterfaceVersion} — à jour`
      : `Version installée : ${lumiInterfaceVersion} — le serveur propose ${version}. Touche « Mettre à jour Lumi ».`;
    if (version !== lumiInterfaceVersion) {
      lumiUpdatePending = true;
      document.querySelectorAll('[data-update-lumi]').forEach(button => { button.textContent = '🔄 Nouvelle version — mettre à jour'; });
      if (!lumiUpdateNotice) { lumiUpdateNotice = true; toast('Une nouvelle version de Lumi est prête : elle s\'installe toute seule sur l\'écran des profils (ou à la prochaine ouverture).', 8000); }
      lumiMiseAJourHorsLecon();
    }
  } catch { /* Keep the offline interface available. */ }
}
// En lecon (ou une fenetre ouverte) : on ne recharge jamais tout seul.
function lumiEnLecon() {
  const chat = document.getElementById('screen-chat');
  return !!(chat && !chat.classList.contains('hidden'));
}
function lumiOccupe() {
  if (lumiEnLecon()) return true;
  const modal = document.querySelector ? document.querySelector('.modal:not(.hidden)') : null;
  return !!modal;
}
// Applique la mise a jour au premier moment calme : petit message puis
// rechargement complet (les ?v= et le service worker garantissent le reste).
function lumiMiseAJourHorsLecon() {
  if (!lumiUpdatePending || lumiReloading) return;
  if (lumiOccupe()) return;
  lumiReloading = true;
  try { toast('Mise à jour de Lumi… 🌙', 4000); } catch {}
  setTimeout(() => {
    try { window.location.replace(window.location.pathname + '?_maj=' + Date.now()); }
    catch { window.location.reload(); }
  }, 1200);
}
async function updateLumi() {
  if (lumiUpdateBusy) return;
  if ((typeof chatLoading !== 'undefined' && chatLoading) || (typeof activeChat !== 'undefined' && activeChat) ||
      (typeof archiving !== 'undefined' && archiving) || document.querySelector('#input')?.value.trim() ||
      !document.querySelector('#photo-preview-modal')?.classList.contains('hidden')) {
    toast('Termine ou annule le message et la photo avant de mettre à jour Lumi.', 7000); return;
  }
  lumiUpdateBusy = true;
  const buttons = [...document.querySelectorAll('[data-update-lumi]')];
  buttons.forEach(button => { button.disabled = true; button.textContent = 'Vérification de la mise à jour…'; });
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) throw Error('Connexion nécessaire pour mettre à jour Lumi.');
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await registration.update();
    }
    if (typeof setLiveMic === 'function') setLiveMic(false);
    if (typeof stopSpeech === 'function') stopSpeech();
    location.reload();
  } catch {
    toast('Mise à jour impossible. Vérifie Internet puis réessaie.', 7000);
    lumiUpdateBusy = false;
    buttons.forEach(button => { button.disabled = false; button.textContent = '🔄 Mettre à jour Lumi'; });
  }
}
document.querySelectorAll('[data-update-lumi]').forEach(button => button.addEventListener('click', updateLumi));
window.addEventListener('focus', checkLumiUpdate);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkLumiUpdate(); });
// Une mise a jour en attente s'applique des qu'on est au calme (retour aux
// profils compris), meme sans rebouger l'application.
if (typeof setInterval === 'function') setInterval(() => { try { lumiMiseAJourHorsLecon(); } catch {} }, 4000);
// Service worker : nouvelle verification a chaque ouverture, et rechargement
// quand un nouveau worker prend la main (jamais a la toute premiere visite).
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
});
if ('serviceWorker' in navigator) {
  let lumiHadController = !!navigator.serviceWorker.controller;
  if (typeof navigator.serviceWorker.addEventListener === 'function') navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!lumiHadController) { lumiHadController = true; return; }
    lumiUpdatePending = true;
    lumiMiseAJourHorsLecon();
  });
}
// Nettoyer le marqueur de mise a jour (?_maj=...) de l'adresse apres coup.
try {
  if (new URLSearchParams(location.search).has('_maj')) {
    const u = new URL(location.href); u.searchParams.delete('_maj');
    window.history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  }
} catch {}
checkLumiUpdate();
