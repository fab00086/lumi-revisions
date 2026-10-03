'use strict';
document.getElementById('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'), status=document.getElementById('delete-status'), secret=document.getElementById('delete-secret');
  if(button.disabled || !document.getElementById('delete-confirm').checked)return;
  button.disabled=true;
  const send=body=>fetch('/api/account/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    // Seul le mot de passe PARENT peut tout effacer (le code famille est connu
    // des enfants). S'il n'existe pas encore, ce champ le crée puis efface.
    let response=await send({password:secret.value});
    if(response.status===409){
      const created=await fetch('/api/account/parent-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:secret.value})});
      if(!created.ok)throw new Error((await created.json().catch(()=>({}))).error || 'Mot de passe non créé.');
      response=await send({password:secret.value});
    }
    const result=await response.json();
    if(!response.ok)throw new Error(result.error || 'Suppression refusée.');
    secret.value='';status.textContent='Compte et données supprimés. Tu peux fermer cette page.';
  }catch(error){status.textContent=error.message;button.disabled=false;}
});
