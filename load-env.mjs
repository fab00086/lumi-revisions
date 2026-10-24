// Chargement des variables d'environnement — DOIT rester la 1re importation
// de server.js : plusieurs modules (speech.js, et les constantes OLLAMA_* en
// tete de server.js) lisent process.env des l'importation, donc ce module
// doit s'executer avant eux (ordre des imports ESM = ordre d'evaluation).
//
// Ordre de chargement (une variable deja presente dans l'environnement n'est
// JAMAIS ecrasee par dotenv) :
//   1. LUMI_ENV_FILE : chemin explicite, si defini ;
//   2. /home/oem/Projets/lumi-secrets/app-revisions/.env — ext4, chmod 600
//      (l'ancien .env du depot NTFS etait en 777, lisible par tout processus) ;
//   3. repli historique : .env du dossier courant (comportement dotenv par
//      defaut — c'est aussi le cas des hebergeurs type o2switch/Render, dont
//      les variables du panneau priment de toute facon).
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';

const SECURE_ENV = '/home/oem/Projets/lumi-secrets/app-revisions/.env';
const picked = process.env.LUMI_ENV_FILE || (existsSync(SECURE_ENV) ? SECURE_ENV : undefined);
loadEnv(picked ? { path: picked } : undefined);
