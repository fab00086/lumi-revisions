# 🚀 Mettre Lumi en ligne gratuitement (Render)

Le but : l'app marche sur le téléphone **partout** (plus besoin du PC allumé),
avec un vrai HTTPS (plus besoin d'installer le certificat sur l'iPhone).

Le PC reste utilisable : la version locale continue de fonctionner comme avant.

## 1. Créer le stockage gratuit (Upstash) — garde les profils et historiques

1. Va sur **https://upstash.com** → « Sign Up » (gratuit, e-mail ou GitHub).
2. « Create Database » → nom : `lumi` → région : `eu-west` (Paris/Londres) → Create.
3. Dans la page de la base, descends jusqu'à « **REST API** ».
   Copie les deux valeurs affichées :
   - `UPSTASH_REDIS_REST_URL` (commence par https://...)
   - `UPSTASH_REDIS_REST_TOKEN`

## 2. Créer l'app sur Render

1. Va sur **https://render.com** → « Get Started » (gratuit, e-mail ou GitHub).
2. Une fois connecté : **New +** → **Web Service**.
3. Render demande un dépôt de code. Le plus simple sans GitHub :
   - « Build and deploy from a Git repository » → connecte ton compte GitHub,
   - crée un dépôt `lumi-revisions` et mets-y le contenu de ce dossier
     (sans le dossier `data`, sans `.env`, sans `node_modules`).
   - Dans Render : **New + → Web Service →** choisis le dépôt `lumi-revisions`.
4. **Runtime** : Node • **Plan** : Free
5. **Environment Variables** — ajoute :

   | Clé | Valeur |
   |---|---|
   | `OLLAMA_BASE_URL` | `https://ollama.com` |
   | `OLLAMA_API_KEY` | ta clé Ollama (celle du `.env`) |
   | `OLLAMA_MODEL` | `glm-5.3-flash:cloud` |
   | `OLLAMA_VISION_MODEL` | `gemma4:31b` |
   | `LUMI_ACCESS_CODE` | un code de famille, ex. `LUMI-FAMILLE-2026` |
   | `UPSTASH_REDIS_REST_URL` | (celui du §1) |
   | `UPSTASH_REDIS_REST_TOKEN` | (celui du §1) |
   | `NO_HTTPS` | `1` |
   | `NO_OPEN_BROWSER` | `1` |

6. **Create Web Service** → 2-3 minutes plus tard, Render donne une adresse du
   type `https://lumi-revisions.onrender.com` → c'est l'URL de la famille 🎉

## 3. Côté famille

- Ouvre l'URL (ou mets-la en favori / sur l'écran d'accueil du téléphone).
- Une seule fois : entre le **code d'accès** choisi à l'étape 5.
  Le navigateur s'en souvient (cookie 1 an).
- L'écran d'accueil « 📱 Connecter un téléphone » ne sert plus à rien en ligne :
  tout le monde ouvre simplement la même adresse.

## 4. À savoir

- **Gratuit** : le service s'endort après ~15 min sans visite. La 1re ouverture
  après une pause met 30-40 s (l'app affiche une page d'attente du navigateur).
- **HTTPS** : vrai certificat géré par Render → plus d'avertissement, micro et
  voix fonctionnent directement sur iPhone/iPad, sans installer de certificat.
- **Mises à jour** : je modifie le code → tu pousses sur GitHub → Render
  redéploie tout seul. Les données (profils, historiques) sont sur Upstash,
  elles survivent aux mises à jour.
- **Clé API** : jamais dans le code, seulement dans les réglages de Render.
- L'app affiche un écran « code d'accès » avant tout : seuls ceux qui ont le
  code peuvent utiliser ta clé Ollama.