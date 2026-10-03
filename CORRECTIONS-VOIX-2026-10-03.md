# Corrections voix iPhone / Render — 3 octobre 2026

## Correctif 2 — micro qui « se met en veille » en mode discussion

**Symptôme** : en mode discussion (🎙️) sur iPhone, le micro se coupe tout seul
après quelques instants.

**Deux causes cumulées, deux corrections :**

1. **L'écran se met en veille** → écran noir = page masquée = Safari coupe le
   micro (`visibilitychange`, comportement voulu). **Correction** : l'app
   demande un **verrou d'écran** (Screen Wake Lock API, Safari ≥ iOS 16.4)
   tant que le mode discussion est actif (`keepScreenAwake()` appelé depuis
   `setLiveMic()`). Au retour au premier plan le verrou est repris ; si l'API
   est absente ou refusée, rien ne casse.

2. **Les pauses de réflexion éteignaient le micro** : sur iPhone, chaque
   session de reconnaissance s'arrête après ~5 s de silence ; le mode se
   fermait après 3 sessions « vides ». Or une session avec un début de phrase
   (résultat intermédiaire) était comptée comme vide. **Correction** :
   `emptyMicSessions = 0` dès qu'un résultat intermédiaire arrive — le mode ne
   s'éteint plus que sur **3 silences complets** d'affilée, jamais sur une
   pause de réflexion.

Version montée à **2026-10-03.19** (`server.js` + `public/update.js`) — sur
l'iPhone : « 🔄 Mettre à jour Lumi » dans les réglages après redéploiement.

---

## Symptôme constaté (corrigé après retour)

Sur iPhone (Safari, via l'URL Render en ligne) :

- ✅ **la voix Lumi (piper, serveur) sort bien dans le lecteur audio** —
  le serveur Render a donc bien la voix installée (le `postinstall`
  `scripts/setup-voice.mjs` fait son travail) ;
- ❌ **les voix du téléphone (Thomas, Amélie…) restent muettes** quand on
  choisit « Voix du téléphone » dans les réglages.

## Diagnostic

Le silence des voix natives n'est **pas** un problème de serveur : c'est un
comportement iPhone/Safari caractéristique —

- La **synthèse vocale du téléphone** (speechSynthesis : Thomas, Amélie…)
  suit le **commutateur « mode silencieux »** et le **volume de la sonnerie**.
- Le **lecteur `<audio>`** (voix Lumi en WAV) suit lui le **volume multimédia**
  et **n'est pas coupé** par le mode silencieux.

C'est pourquoi le lecteur joue alors que les voix du téléphone restent muettes.

**Vérifications côté iPhone** : désactiver le mode silencieux (bouton latéral),
monter le volume, vérifier que Siri et la Dictée sont activés dans les Réglages,
puis tester les voix sur `/test-voix.html`. L'app affiche déjà cette aide au
bout de 5 s quand une voix native ne démarre pas.

## Corrections apportées

Toutes dans `public/app.js` (+ numéros de version dans `server.js` et
`public/update.js` → **2026-10-03.18**, pour forcer le rechargement sur l'iPhone
via « 🔄 Mettre à jour Lumi ») :

1. **Filet de secours** (utile, mais sans rapport avec le silence des voix
   natives) — `checkServerVoice()` interroge `/api/speech/status` au démarrage,
   après l'ouverture du gate et après l'entrée du code. Si la voix piper est
   **absente sur ce serveur** (build sans postinstall, etc.), bascule durable
   sur la voix du téléphone. Dans `speakAudio()`, une réponse 503
   « Voix en cours d'installation » déclenche la même bascule et **relit le
   message immédiatement** avec la voix du téléphone.
   ⚠️ Ce mécanisme ne résout pas le problème observé : basculer vers des voix
   muettes ne rend pas le son. Il protège seulement contre un serveur sans
   voix installée.

2. **Menu des voix lisible** — si la voix serveur est absente, l'option
   « Lumi — voix française » apparaît grisée avec « (indisponible ici) ».

## Résultat attendu

- **Voix Lumi** : fonctionne déjà en ligne (lecteur audio).
- **Voix du téléphone** : fonctionnelles une fois le mode silencieux désactivé
  et le volume monté sur l'iPhone ; l'app guide l'utilisateur si une voix ne
  démarre pas.

## Vérifications

- `npm test` : **106/106 tests passent** (dont toute la série voix Safari / micro).
