// Explicit updates preserve account cookies and all saved family data.
const lumiInterfaceVersion = '2026-10-03.17';
let lumiUpdateBusy = false;
let lumiUpdateNotice = false;
async function checkLumiUpdate() {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;
    const { version } = await response.json();
    if (version !== lumiInterfaceVersion) {
      document.querySelectorAll('[data-update-lumi]').forEach(button => { button.textContent = '🔄 Nouvelle version — mettre à jour'; });
      if (!lumiUpdateNotice) { lumiUpdateNotice = true; toast('Une nouvelle version de Lumi est disponible. Utilise « Mettre à jour Lumi ».', 8000); }
    }
  } catch { /* Keep the offline interface available. */ }
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
checkLumiUpdate();
