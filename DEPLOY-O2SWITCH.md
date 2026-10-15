# Lumi sur o2switch — 13 octobre 2026

## Hébergement actif

- URL : https://lumirevision.com (alias www couvert par le certificat).
- cPanel : avatar.o2switch.net, compte daje4208.
- Application Node 24.21 : /home/daje4208/lumi-backend.
- Racine web publique : /home/daje4208/public_html/lumirevision.com.
- Variables serveur : /home/daje4208/lumi-env.json, permissions 0600 ; ne jamais les afficher.
- Certificat installé avec le plugin Let's Encrypt, validation DNS ; AutoSSL est désactivé sur ce compte.
- Redirection HTTP → HTTPS dans .htaccess, compatible avec X-Forwarded-Proto.
- Sauvegarde initiale de .htaccess : /home/daje4208/lumi-domain-htaccess-before-https.txt, hors racine publique.

## Base SQL des programmes officiels (15/10/2026)

- Source éditable : `data/programmes.json` — toutes les notions et attendus
  officiels, du CP à la 3e, toutes matières (9 niveaux, 568 notions), suivi dans Git.
- Au démarrage, le serveur ouvre `data/programmes.db` (SQLite) **en lecture
  seule** ; si le fichier manque, est vide, ou si le JSON a changé (tampon
  taille+mtime stocké en base), il est reconstruit dans un dossier temporaire
  système puis installé dans `data/` : rien à faire sur o2switch (Node 24 a
  `node:sqlite` intégré), la base « vit » sur l'hébergement, aucun PC requis.
- C'est cette base qui nourrit le tuteur (bloc PROGRAMME SCOLAIRE du niveau),
  les thèmes de quiz au hasard, les mini-classes (notions qui matchent le
  sujet + attendus) et l'écran parent via `/api/curriculum`.
- Repli automatique sur l'ancien `data/curriculum.json` (aujourd'hui
  redondant, réservé aux environnements sans `node:sqlite`).
- Édition : modifier `data/programmes.json` → commit → `git push o2switch main`
  → le redémarrage Passenger reconstruit la base.

## Sources affichées en permanence (15/10/2026)

- Chaque réponse du tuteur embarque désormais la source « Programme officiel
  de l'Éducation nationale — cycle N (…) » (lien eduscol) en tête du bloc
  📚 Sources affiché à l'enfant ; la recherche web s'ajoute quand elle est
  demandée.
- Les interros (quiz) et les mini-classes renvoient une `source` affichée en
  pied de modal (récapitulatif et étapes).

## IA de secours en cas de surcharge (15/10/2026)

- `OLLAMA_FALLBACK_MODEL` (défaut `deepseek-v4.1-flash:cloud`) : si le modèle
  principal renvoie 429 (surcharge), 5xx, timeout ou une erreur réseau, les
  appels texte (normal et streaming) réessaient une fois sur ce modèle avant
  d'afficher une erreur à l'enfant. Vide = pas de secours. Les 400/401/404 ne
  basculent pas. La photo (vision) reste sur le modèle principal.
- Journal : `[IA] glm-… renvoie 503 (surcharge) -> bascule IA de secours …`.

## Gate : compteur de tentatives par client (correctif 15/10/2026)

- Bug constaté : « le code ne s'ouvre pas sur lumirevision.com » — derrière le
  proxy Passenger/Apache, `req.ip` était l'IP du proxy pour TOUT LE MONDE, donc
  la limite de 20 tentatives de code / 15 min était un compteur global
  toutes familles confondues : de vraies familles recevaient « Trop de
  tentatives » avec le bon code.
- Correctif : `app.set('trust proxy', 1)` inconditionnel (l'IP réelle du
  client remplace l'IP du proxy ; les en-têtes forgés par un client ne passent
  pas, seul le dernier saut est de confiance). En local sans proxy : aucun
  changement.

## Voix française de lecture

Le binaire Piper 2023 exige GLIBC 2.29, alors que le serveur a GLIBC 2.28.
Installation compatible : Python 3.11, piper-tts 1.2.0, onnxruntime 1.17.3, numpy <2.
Environnement : .lumi-voice/venv. Même modèle fr_FR-siwis-medium.onnx.
Le fichier .lumi-voice/piper/piper est un adaptateur Python du protocole JSON
persistant de speech.js. L'ancien binaire est conservé comme piper-native.backup.
Test réel : /voice-check.wav renvoie HTTP 200 et un WAV RIFF valide.

## Dictée Whisper sans Docker

faster-whisper 1.2.1, ctranslate2 4.4.0, onnxruntime 1.17.3, numpy <2,
Python 3.11 ; inférence CPU int8, deux threads. Environnement : .lumi-whisper/venv.
Le modèle small est téléchargé dans .lumi-whisper/models/small, hors racine publique.
Aucun téléchargement ni appel à Hugging Face pendant une dictée.

Variables à configurer :

```env
WHISPER_PYTHON=/home/daje4208/lumi-backend/.lumi-whisper/venv/bin/python
WHISPER_MODEL_PATH=/home/daje4208/lumi-backend/.lumi-whisper/models/small
WHISPER_MODEL_SIZE=small
```

Avec WHISPER_PYTHON renseigné, les routes existantes /api/transcribe/status et
/api/transcribe utilisent whisper-python.js et scripts/whisper-transcribe.py.
Sans cette variable, le service Whishper existant du PC reste utilisé.

La dictée exige une session famille ou admin. Limite existante : 20/min/famille.
Une inférence à la fois par processus Node ; une seconde demande reçoit HTTP 429.
Audio : formats existants WAV, WebM/Opus, Ogg, MP4/M4A, MP3 ; 12 Mo au maximum,
20 secondes décodées maximum (le micro de Lumi s'arrête à 15 secondes).
Le processus est arrêté après 75 secondes et le dossier temporaire audio est
supprimé sur succès, erreur ou dépassement du délai. Aucun transcript n'est enregistré
par le moteur ; le texte revient à l'écran pour relecture.

Premier benchmark sur phrase synthétique française : tiny, 0,52 s de transcription
après chargement ; small, 4,382 s au total, démarrage Python et chargement compris.
Ces mesures ne valident pas la précision sur des voix d'enfants ni sous forte charge.
Le mode conversation vocale continue à utiliser la reconnaissance du navigateur ;
Whisper concerne la dictée par appui et le maintien du bouton micro.

## Android

Projet actif : /home/oem/Projets/lumi-apk. server.url=https://lumirevision.com.
APK signée 1.0.1, versionCode 2 :
/media/oem/jfd/PROJET-GLOBAL/livraisons/Lumi/Lumi-o2switch-1.0.1.apk.

## Maintenance

SSH fonctionne désormais par clé après autorisation de l’IP du réseau sur le port 22
dans cPanel. Le blocage initial venait de l’absence d’autorisation IP (0/5), pas d’un
ban démontré. La clé d’hôte ED25519 a été comparée avec celle obtenue sur le serveur
via cPanel authentifié avant son ajout dans known_hosts. Lanceur du Bureau :
Lumi-SSH-o2switch.desktop → /home/oem/.local/bin/lumi-ssh-o2switch.
Le lanceur ouvre directement /home/daje4208/lumi-backend et conserve le terminal
avec un menu après la session. Test --check : SSH Lumi OK.
Administration également possible via cPanel UAPI, FTP avec TLS et tâches cron ponctuelles.
Retirer chaque tâche cron par sa linekey après exécution ; ne jamais utiliser crontab -r.
Avant activation Whisper, server.js et lumi-env.json ont été sauvegardés côté serveur
avec le suffixe .before-whisper-python. Sauvegardes locales sur jfd/sauvegardes/.

Stripe n'est pas configuré dans les variables de cet hébergement ; aucune modification
du compte Stripe ni du service Render n'a été effectuée.

## Mise à jour 2026-10-13.1 (bannière PWA + durcissements)

Déployée le 13/10/2026 par scp + `touch tmp/restart.txt` (SSH par clé actif) :

- Bannière « Installer Lumi » proposée une fois par appareil après l'affichage des
  profils (Android → invite native, iPhone → guide Safari ; mémorisée dans
  `localStorage` sous `lumi-install-banner`, jamais sur une app déjà installée).
- « Entrer » sur l'écran d'accès ne reste plus silencieux quand le champ code est
  vide : message explicite affiché.
- Service worker cache `lumi-v41` ; préchargement du squelette désormais séquentiel
  (un fichier après l'autre) pour éviter les rafales de requêtes qui déclenchaient
  la protection anti-flood o2switch (erreurs 429 sur les ressources constatées le
  13/10 pendant des tests intensifs depuis une même IP).
- `data/curriculum.json` manquait sur le serveur (erreur au démarrage dans
  lumi-passenger.log) : fichier renvoyé depuis le dépôt local, dernier démarrage
  propre.
- Version interface passée à 2026-10-13.1 (server.js + public/update.js) ; une app
  installée plus ancienne affiche « Nouvelle version — mettre à jour » sur ses
  boutons de mise à jour.

## Mise à jour 2026-10-13.2 (affichage de la version)

- La version de l'interface est maintenant affichée dans ⚙️ Paramètres & Partage
  (`#lumi-version`, rempli par update.js) : « Version installée : … — à jour » ou
  invitation à mettre à jour avec la version proposée par le serveur.
- Après déploiement, empreintes SHA-256 vérifiées identiques PC ↔ o2switch pour
  server.js, public/index.html et public/update.js.

## Mise à jour 2026-10-13.3 (couper la parole à Lumi sur iPhone)

Demande utilisateur : ne plus perdre la possibilité d'interrompre Lumi en parlant
en mode discussion 🎙️ sur iPhone (le barge-in avait été désactivé le 7/10 pour
éviter les crashes micro `audio-capture`).

- Le micro reste ouvert pendant la voix de Lumi (les quatre `stopListening()`
  « iOS » sur lecture ont été retirés) ; l'enfant qui parle par-dessus coupe la
  voix immédiatement (`stopSpeech()` dans `onresult` et `onsoundstart`, actif
  pour toutes les plateformes).
- Garde-fous anti-crash conservés : aucune relance du micro pendant la lecture ;
  une session qui meurt pendant la voix sans avoir rien entendu ne compte plus
  comme une mort anormale (pas de relance ni de rechargement de secours) — le
  micro revient seul via `micLiveResume()` à la fin de la voix. Après une
  interruption, une relance est planifiée seulement si la session est morte.
- Tests : tests/voice.cjs adaptés au nouveau comportement (58 tests voix, suite
  complète 159 tests — 158 pass, 1 skip). Service worker `lumi-v42`.
- Si Safari redevient instable sur iPhone (micro capricieux après interruption),
  le repli consiste à remettre `|| isIOS` sur les arrêts de micro pendant la voix.

## Mise à jour 2026-10-13.4 (dictée clavier iPhone + veilleur de lecture)

- Demande utilisateur (le micro Safari « marche une fois puis plus rien » sur
  iPhone, OK sur Android) : nouveau réglage ⚙️ « Dictée iPhone : utiliser le
  micro du clavier d'Apple 🎤 » (`lumidictkeyboard`). Activé : le bouton 🎤
  (et l'appui long) ouvre le clavier sur le champ de saisie — la dictée native
  iOS est fiable, aucun conflit avec la voix de Lumi ; astuce affichée une fois.
- Correctif mode Conversation : veilleur `armVoiceWatchdog` (setInterval 1,5 s) —
  si Safari n'émet jamais l'événement de fin de lecture, la voix est considérée
  terminée (ended / fin de durée) et le micro reprend via micLiveResume ; garde
  `endHandled` pour éviter les doubles traitements. Service worker `lumi-v43`.
- Tests : voix 60, suite complète 161 (160 pass, 1 skip).
