# PROJET V2 — Lumi (document de reprise)

> **Pour toute nouvelle session** : ce fichier contient tout ce qu'il faut savoir pour reprendre le projet V2 proprement. Mis à jour : 29/09/2026.
> Dossier : `C:\Users\USINE_JFAB\Desktop\JFAB Claude Ollama\Sessions-libres\app-revisions`
> Plan détaillé complet : `C:\Users\USINE_JFAB\.claude\plans\resilient-wibbling-backus.md`

## Contexte

Lumi est une web-app Node/Express + vanilla JS (PWA) : tuteur IA qui aide les enfants à faire leurs devoirs (jamais la réponse finale, guidage par questions). IA : Ollama cloud `glm-5.3-flash:cloud` (texte) + `gemma4:31b` (vision), clé dans `.env`. Déploiement : Render + Upstash (abandonné pour l'instant) ; **usage actuel = local** (Lancer-Lumi.bat, tunnel trycloudflare pour les téléphones).

## Objectif V2 (décisions du propriétaire)

Faire **évoluer l'app actuelle** (pas de refonte), web/PWA, pour la **vendre plus tard** :
1. **Comptes famille** : un parent crée un compte (e-mail + mot de passe), ses enfants dedans, données isolées par compte.
2. **Freemium** : essai complet 14 jours → gratuit généreux (200k tokens/mois ≈ 12-15 devoirs) → premium 5,99 €/mois ou 49,99 €/an (2M tokens, 5 enfants, photos de cahier, recherche web). Pas de facturation réelle en V2 (préparation seulement).
3. **Budget tokens IA par compte/mois**, plafond par échange **selon l'âge** (≤6 : 200 ; 7-10 : 320 ; 11-14 : 400 ; ≥15 : 500 ; photo +180). Quota épuisé → **mode dégradé** (réponses courtes, pas photo/web) → jamais de blocage brutal.
4. Priorités : voix/micro mobile fiables ; design enfant ; gamification pédagogique ; espace parent avancé.
5. Conformité enfant : consentement parental, page légale, minimisation (RGPD-K).

## Phases (ordre approuvé)

| Phase | Contenu | Fichiers principaux | État |
|---|---|---|---|
| 1 | Comptes famille + auth + migration données + mode local | server.js, index.html, app.js, sw.js (v4) | 🔄 en cours |
| 2 | Freemium + budget tokens + jauge usage + page abonnement | server.js, app.js, sw.js (v5) | ⬜ |
| 3 | Points/badges/streaks/matières + file de révision | server.js, app.js, sw.js (v5→) | ⬜ |
| 4 | Design enfant (police ludique auto-hébergée, confettis, avatar) | style.css, fonts, sw.js | ⬜ |
| 5 | Espace parent V2 (actions, limites/jour, rapport hebdo) + legal.html + polish voix | server.js, app.js | ⬜ |

Détails complets de chaque phase dans le fichier de plan cité en tête.

## Règles techniques à respecter (IMPORTANT)

- **Base SQL (V2, fait le 29/09)** : SQLite via `node:sqlite` (Node ≥ 22.5, zéro dépendance), fichier `data/lumi.sqlite`. **Source de vérité en local** : tables `accounts`, `sessions`, `children` (une ligne/enfant, `data` = JSON sessions/résumés), `messages` (une ligne PAR message de conversation). L'ancien `lumi-data.json` est importé automatiquement au 1er démarrage (fichier conservé tel quel = sauvegarde ; un import raté = démarrage refusé). Les helpers (`accountPut`, `childSave`, `childGetFull`…) ont une branche blob (Upstash/Deno KV) pour l'hébergement — en local ils parlent TOUJOURS à SQL.
- **Photo du cahier = LA BASE DE L'APP** (demande du propriétaire, à garder jusqu'au bout) : chemin photo (modèle vision `gemma4:31b`) priorité absolue. `PHOTO_TOKENS = 900` (600 avant : le raisonnement du modèle mangeait le budget → réponses coupées ou raisonnement anglais qui fuyait dans la bulle). Prompt photo dédié : décrire l'énoncé en 1-2 phrases d'abord, redemander une photo si illisible. **Tester une vraie photo de cahier après chaque gros changement serveur.**
- **Tests** : `npm test` (node --test tests/*.cjs) — 28 tests verts. Les tests lisent app.js/server.js **par tranches entre marqueurs `// ----------`** : ne jamais déplacer/renommer ces marqueurs. Le test HTTP charge aussi la tranche `// ---------- Comptes famille (V2) ----------` → `function buildSystemPrompt` ; `let sql` doit rester APRÈS `function loadData()` (dans la tranche).
- **Écritures serveur** : toujours via `storedRoute()` + `writeQueue` ; passer par les helpers (`childSave`, `childMetaSave`, `sessionPut`…), jamais `getData()/setData()` directement dans une route.
- **Migration** : `migrateLegacy()` pure + idempotente (tests dédiés) ; `importJsonToSql()` pour JSON→SQL, ne rien perdre.
- **sw.js** : bumper `CACHE` à CHAQUE changement dans public/ (actuellement **lumi-v4**), sinon les téléphones gardent l'ancienne UI.
- **Mode local préservé** : `LUMI_LOCAL_MODE=1` (défaut) → compte implicite `local` illimité ; la famille ne voit AUCUNE différence. Vendre = `LUMI_LOCAL_MODE=0` → le front devra montrer l'écran de connexion (pas encore fait).
- `.env` (clé Ollama) : ne JAMAIS le pousser sur GitHub. GitHub : `fab00086/lumi-revisions` (token enregistré sur le PC via git credential manager).
- Upstash : clé unique `lumi-data` (branche blob, hébergement uniquement), surveiller la taille (warn > 900 Ko).

## État de la session du 29/09/2026

### Fait
- **Corrections micro/voix iPhone** (validées sur le PC, poussées sur GitHub commit `a38ac6c`) : QR code → tunnel trycloudflare prioritaire ; `unlockVoice()` iOS (énoncé muet au 1er toucher) ; bouton **🩺 Diagnostic micro+voix** dans Réglages (rapport ✅/❌) ; aide iPhone à jour (Siri, Dictée, mode silencieux) ; tests 23/23.
- **Cause iPhone identifiée** : QR pointait vers `https://IP:3443` avec certificat auto-signé → Safari (tous navigateurs iOS) bloque micro/reconnaissance. + iOS exige un 1er énoncé vocal dans un geste utilisateur pour autoriser speechSynthesis.
- Tunnel local vérifié fonctionnel (adresse éphémère, change à chaque démarrage).

### Non résolu
- **Render n'a pas redéployé** l'instance en ligne (auto-deploy probablement off) → déploiement abandonné, on travaille en local. Pour plus tard : dashboard.render.com → Manual Deploy → Deploy latest commit.
- **Le rapport 🩺 Diagnostic de l'iPhone n'a jamais été fourni** → si le micro/son pose encore problème sur l'iPhone, demander ce rapport d'abord (tunnel → ⚙️ → 🩺 → ▶️ Lancer).

### En cours
- **Phase 1 V2** : comptes famille — le SERVEUR est fait (auth, SQL, RGPD, isolation par compte), il reste le FRONT : écran de connexion/création de compte (`#screen-account`), bouton compte/déconnexion dans l'écran profils, `initApp` adapté (visible seulement utile si `LUMI_LOCAL_MODE=0` ; en mode local, aucun changement).

### Fait en plus le 29/09 (demandes du propriétaire, en plus du plan)
- **Base SQL** : SQLite (`data/lumi.sqlite`) = conversations en vraies lignes SQL ; migration des données réelles OK (Manon + historique intacts).
- **RGPD blindé** : consentement parental horodaté (`consent_date`) ; `GET /api/account/export` (droit d'accès, tout en JSON) ; `POST /api/account/delete` (droit à l'effacement, mot de passe exigé, tout supprimé) ; purge auto des conversations > `LUMI_RETENTION_MONTHS` mois (12 par défaut, 0 = jamais) ; e-mail parent uniquement, prénom + âge pour les enfants. Reste : page `legal.html` (Phase 5).
- **Bilan parents (IA)** : à l'archivage d'une leçon, `summarizeLesson()` génère un TITRE + « bien compris » + « à retravailler » (JSON compact, ~350 tokens, jamais bloquant). Affiché dans la vue d'une leçon (progression) et dans l'espace parent (✅/🔧). `sw.js` → `lumi-v4`.
- **Mode discussion micro** (façon ChatGPT voix) : bouton 🎙️ à côté de 🎤 — le micro reste ouvert pendant toute la conversation : il se rouvre tout seul quand Lumi finit de parler, quand iOS coupe la session, après un silence, après une interro ou le bouton ✋. Un appui sur 🎙️ ou 🎤 l'éteint. Tests dédiés dans `tests/voice.cjs`.
- **Anti-répétition** : règle 10 du prompt système — Lumi ne recopie jamais la question de l'enfant et ne repose jamais une question déjà posée (l'enfant se plaignait qu'elle répète).
- **Photo du cahier renforcé** : `PHOTO_TOKENS` 600→900 + prompt photo dédié (voir règles techniques).

### Corrigé en cours de route (29/09) — contexte IA et réponses complètes
- **Diagnostic** : en streaming, le raisonnement interne de `glm-5.3-flash` (en anglais !) consommait TOUT le budget `max_tokens` → réponses vides ou coupées en pleine phrase, lues incomplètement par la voix. Et l'historique envoyé au modèle était tronqué aux 8 derniers messages → contexte perdu vite.
- **Correctifs dans `server.js`** (testés en réel, réponse complète et propre) :
  - `reasoning_effort: 'low'` (const `REASONING_EFFORT`, surchargeable par `OLLAMA_REASONING_EFFORT`) sur les appels IA → réflexion minimale, réponse complète en français, ~3× moins de tokens consommés.
  - `REPLY_TOKENS = 700` / `PHOTO_TOKENS = 600` (au lieu de 320/500).
  - `recentHistory()` : 16 derniers messages avec budget 6 000 caractères (au lieu de 8 messages).
  - Outils de diagnostic laissés dans `tests/test-api-reasoning.mjs` et `tests/test-api-stream.mjs` (appels IA réels, non exécutés par `npm test`).
- Le modèle reste bien `glm-5.3-flash:cloud` (vérifié dans `.env`).

## Reprendre une session

1. Lire ce fichier + le plan complet (`~/.claude/plans/resilient-wibbling-backus.md`).
2. `cd app-revisions && npm test` → doit être vert.
3. Continuer à la phase indiquée « en cours » dans le tableau.
4. À la fin de chaque phase : tests verts + test réel sur le téléphone de la famille via le tunnel + bump sw.js + mise à jour de ce fichier.