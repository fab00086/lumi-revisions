'use strict';
document.getElementById('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'), status=document.getElementById('delete-status'), secret=document.getElementById('delete-secret');
  if(button.disabled || !document.getElementById('delete-confirm').checked)return;
  button.disabled=true;
  try {
    const response=await fetch('/api/account/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:secret.value})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error || 'Suppression refusée.');
    secret.value='';status.textContent='Compte et données supprimés. Tu peux fermer cette page.';
  }catch(error){status.textContent=error.message;button.disabled=false;}
});
