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

## 5. 💳 Paiement en ligne « Lumi Famille » (Stripe) — à tester en local d'abord

L'abonnement famille (accès illimité) s'active depuis **l'espace parent →
carte « Passe à Lumi Famille »** : 7,99 €/mois ou 69,90 €/an (2 mois offerts). Tant que Stripe
n'est pas configuré, cette carte reste invisible et Lumi marche comme avant.

1. Crée un compte Stripe (mode **Test** au début) : https://dashboard.stripe.com/register
2. Crée un produit « Lumi Famille » avec deux tarifs récurrents :
   - `7,99 € / mois` → note l'identifiant `price_...`
   - `69,90 € / an` → note l'identifiant `price_...`
3. Dans le `.env` local, **à la fin du fichier** (ne jamais insérer au milieu) :

   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PRICE_MONTHLY=price_...
   STRIPE_PRICE_YEARLY=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...   (donné à l'étape 4)
   ```

4. Webhooks en local : installe le Stripe CLI (https://docs.stripe.com/stripe-cli),
   puis `stripe login` et :

   ```
   stripe listen --forward-to http://localhost:3000/api/stripe/webhook
   ```

   La commande affiche un secret `whsec_...` → mets-le dans
   `STRIPE_WEBHOOK_SECRET` puis relance Lumi (`bash lancer-lumi.sh`).

5. Test : espace parent → carte abonnement → paie avec la carte de test
   `4242 4242 4242 4242` (date future, CVC quelconque). Au retour sur Lumi :
   « Merci ! L'abonnement Lumi Famille est actif 💜 », et l'admin voit
   « 💳 Abonnement mensuel jusqu'au … » dans `/admin.html`.

   📱 **iPhone/iPad** : le paiement par carte fonctionne aussi dans l'app
   installée (Lumi pré-ouvre la page de paiement pour contourner le blocage
   des popups par Safari). En revanche **Apple Pay n'apparaît que si Lumi est
   ouverte dans Safari** (règle Apple : jamais dans une app-webview). En cas
   de souci, conseille d'ouvrir Lumi dans Safari pour payer.

## 6. Stripe en ligne (Render) — quand le test local est validé

- Ajoute dans Render → Environment les 4 variables `STRIPE_*` avec les
  valeurs **Live** (`sk_live_...`, prix live) → puis Manual Deploy.
- Crée le webhook en ligne : Stripe → Développeurs → Webhooks → Ajouter un
  point de terminaison `https://lumi-revisions.onrender.com/api/stripe/webhook`
  → événements : `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted` →
  copie le secret `whsec_...` dans `STRIPE_WEBHOOK_SECRET` → redéploie.
- Résiliation, changement de carte, factures : via « Gérer mon abonnement »
  (portail Stripe) dans l'espace parent. Abonnement expiré ou impayé → Lumi
  repasse doucement au quota gratuit (pas de coupure brutale).
- Sécurité : chaque webhook est vérifié par signature, les clés restent
  uniquement dans les variables d'environnement (jamais dans le code, jamais
  affichées dans l'app), et les comptes famille offerts à la main restent
  illimités sans toucher à Stripe.

## 7. 🎤 Dictée Whisper locale (optionnel — bien meilleure pour les enfants)

Si **Whishper** (Whisper en Docker) tourne sur le PC : `docker compose up -d`
dans `~/Projets/whishper` → interface sur http://localhost:8082. Lumi le
détecte tout seul (`/api/transcribe/status`) :

- 🎤 (appui simple ou appuyé long) enregistre la voix puis la fait transcrire
  par Whisper (`small`, français) — beaucoup plus fiable que le navigateur
  sur les petites voix. Sinon, la dictée du navigateur est utilisée : rien
  ne casse, sur Render comme sur o2switch.
- Confidentialité : l'audio et la transcription sont supprimés après coup,
  côté Lumi **et** côté Whishper (rien ne s'accumule).
- Réglages `.env` optionnels : `WHISPER_API_URL` (défaut
  `http://127.0.0.1:8082`), `WHISPER_MODEL_SIZE` (défaut `small`),
  `WHISPER_DEVICE` (`cpu`).
- o2switch : l'app Node s'y héberge de la même façon (mêmes variables
  d'environnement), mais un hébergement mutualisé ne peut pas faire tourner
  Whisper — la dictée repassera automatiquement sur le navigateur. Pour
  Whisper partout, il faut que le PC (ou un petit serveur dédié) soit
  joignable.