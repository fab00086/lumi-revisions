# Comparaison Mode Classe Lumi vs OpenMAIC + Plan d'action

Date : 11/10/2026 — fait pendant l'audit des comptes Lumi.

---

## 1. Tableau de comparaison

| Critère | **Lumi (Mode Classe natif)** | **OpenMAIC v1.2.0** |
|---|---|---|
| Type | Feature intégrée app enfant | App autonome pro (enseignant) |
| Stack | Node.js + Express + SQLite | Next.js 16 + LangGraph + Postgres Docker |
| Taille | 1 route + modal (~500 lignes) | ~2221 fichiers TS, 78 routes API, 1014 tests |
| Génération cours | 1 étape, JSON strict, ~6-10 s | 7 étapes server-first, SSE, reprise crash |
| Orchestration | Aucune (1 appel LLM) | LangGraph multi-agent (directeur + prof + élèves IA) |
| Types de scènes | Slides texte + quiz QCM | Slide, quiz, **interactif (3D/jeu/code)**, **PBL** |
| Whiteboard IA | ❌ | ✅ (dessine formules, graphiques, code) |
| Actions de lecture | Suivant + 🔊 | **21 actions** (spotlight, laser, dessin, vidéo…) |
| TTS | 1 provider local (speech.js) | **8 providers** + voice cloning |
| ASR (parler à l'IA) | ✅ (dictée micro) | ✅ |
| Génération images/vidéos | ❌ | ✅ 10 providers image + 7 vidéo |
| Recherche web intégrée | ❌ | ✅ (Tavily, Exa, Brave…) |
| RAG sur documents | ❌ | ✅ (PDF, DOCX, PPTX…) |
| Export | ❌ (prévu P4a) | **PPTX, HTML, ZIP, MP4** |
| PBL (projet multi-séances) | ❌ | ✅ v2 complet |
| Workbench Pro (24 skills) | ❌ | ✅ |
| i18n | FR | **12 langues** |
| **Multi-élèves humains** | ✅ **Comptes famille, profils, isolation** | ❌ 1 owner/navigateur |
| Dashboard enseignant | ❌ | ❌ |
| Devoirs assignés | ✅ **via Pronote** | ❌ |
| Quotas / freemium | ✅ **planLimit, FREE_DAILY** | ✅ usage tracking |
| RGPD (export/effacement) | ✅ | partiel |
| Mode démo admin isolé | ✅ `__lumi_admin_test` | ❌ |
| Cible | **Enfant à la maison** | Enseignant / école |

**Verdict** : pas des concurrents, des **compléments**.
- OpenMAIC = usine à cours pro pour enseignant.
- Lumi = tuteur à la maison avec vrais comptes famille, quotas, RGPD, Pronote.

---

## 2. Décision

- ✅ Garder le Mode Classe **natif** dans Lumi (déjà implanté, 124 tests OK, test réel « les fractions » CM1 OK).
- ❌ Ne **jamais** embedder OpenMAIC dans le cœur de Lumi.

---

## 3. Plan d'action

| Priorité | Action | Statut | Pourquoi |
|---|---|---|---|
| **P4a** 🔥 | **Export PDF/HTML de la classe** dans Lumi (rapport parents) | À faire | Lumi a déjà `classrooms` + `quiz-score` en SQLite → simple et très utile |
| **P4b** | TTS narration auto par étape (améliorer le 🔊 existant) | À faire | TTS local déjà présent, juste à brancher sur chaque slide |
| **P5** | Pont OpenMAIC optionnel : bouton « Mode pro » → appelle `/api/generate-classroom` (port 3001) → importe dans Lumi | Futur | Réservé mode enseignant/école, jamais dans cœur Lumi |
| **P6** | Si besoin whiteboard/PBL → déployer OpenMAIC à côté (docker-compose) comme app sœur, lien depuis Lumi | Futur | Trop lourd pour Lumi cœur |

---

## 4. Où trouver les choses

- **Lumi (app)** : `/media/oem/jfd/PROJET-GLOBAL/01-JFAB-COEUR/JFAB-Claude-Ollama/Sessions-libres/app-revisions/`
  - Mode Classe serveur : `server.js` → `POST/GET /api/classroom` (lignes ~1807-1870)
  - Mode Classe front : `public/app.js`, `public/index.html` (modal `classroom-modal`), `public/style.css` (`.classroom-*`)
  - Tests : `tests/regressions.cjs` (parseClassroom), lancer avec `npm test`
- **OpenMAIC** : `/media/oem/jfd/PROJET-GLOBAL/02-CONTENU/OpenMAIC/`
  - Lancer : `demarrer-openmaic.sh` (port 3001, Postgres Docker + Ollama local 11434)
  - Config modèles : `openmaic.yml` (slot `llm: ollama:gemma4:31b`)
  - Génération headless : `POST /api/generate-classroom`
- **Brain** : recherche "comparaison_mode_classe_lumi_vs_openmaic_plan" ou "maic_analyse_et_plan_mode_classe_lumi".

---

## 5. Rappel état Lumi au 11/10/2026 soir

- ✅ Pronote intégré (attente identifiants dans `.env`)
- ✅ Mode Classe P1-P3 fait (serveur + front + lien devoirs)
- ✅ 124 tests passent / 1 skip (voix)
- ✅ Audit comptes OK (gate, admin, familles, quotas, RGPD, isolation)
- ✅ Tunnel cloudflared actif (accès partout, gate tient à distance)
- ⏳ En attente : P4a export, P4b TTS auto, P5 pont OpenMAIC
