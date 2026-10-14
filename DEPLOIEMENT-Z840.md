# Lumi sur le HP Z840 - fiche de déploiement

Mise à jour : 7 octobre 2026 (accès public ouvert)

## Objectif

Faire tourner Lumi sur le HP Z840 en attendant un hébergement payant. Cette fiche reste dans le dossier du projet ; elle n'est pas publiée sur le site.

## Ce qui fonctionne déjà

| Élément | État |
| --- | --- |
| Application Lumi | Fonctionne sur le Z840. La page principale répond. |
| Site de présentation | Fonctionne à l'adresse locale `https://localhost:3443/site/`. |
| Vidéo TikTok / Facebook | La nouvelle version avec voix plus naturelle est disponible sur `https://localhost:3443/promo/`. |
| Données | Les profils et échanges sont conservés dans la base locale du projet. |
| Accès au moteur d'IA | Le site tourne sur le Z840, mais `glm-5.3-flash:cloud` répond actuellement depuis Ollama Cloud. La configuration et la clé sont dans le fichier privé `.env`. |
| Démarrage automatique | La tâche Windows **Lumi serveur PC** surveille Lumi après l'ouverture de session. Si le lanceur manuel est déjà ouvert, elle évite de démarrer un deuxième serveur. |
| Sauvegarde | La tâche Windows **Lumi sauvegarde quotidienne** est programmée chaque jour à 3 h. Une sauvegarde a été créée et l'intégrité de la base a été vérifiée. |
| Vérification | L'application, le site, la page vidéo, le fichier vidéo et l'API ont répondu correctement sur le PC. Les 124 tests du projet passaient lors de la dernière vérification. |
| Adresse publique | **`https://lumi.tail6bff94.ts.net`** — fonctionne avec un vrai certificat (Let's Encrypt). Le tunnel Tailscale Funnel envoie le trafic vers le serveur local (port HTTP 3000). |
| Comptes famille | Actifs depuis le 07/10/2026 : `LUMI_LOCAL_MODE=0` et `LUMI_ADMIN_CODE` sont dans le `.env`. Chaque famille a son espace séparé ; l'administration demande le code admin. |

Le navigateur peut afficher un avertissement pour l'adresse HTTPS locale : son certificat est créé sur le PC. Le Z840 est configuré pour ne pas se mettre en veille lorsqu'il est branché au secteur.

## Peut-on faire tourner GLM-5.3-Flash sur ce PC ?

Le Z840 a 32 Go de RAM et une RTX 4070 avec 12 Go de mémoire vidéo. GLM-5.3-Flash compte environ 321 milliards de paramètres au total, même si seulement 18 milliards sont actifs pour un jeton. La version locale Q2 publiée par ggml-org occupe 134 Go ; une version Q4 approche 200 Go. Ce modèle ne convient donc pas à la configuration actuelle.

Pour une expérience technique très lente, il faudrait au moins environ 192 Go de RAM, beaucoup d'espace SSD et une version Q2. Pour servir Lumi de façon réellement fluide avec une version Q4, il faut envisager un serveur à plusieurs GPU totalisant environ 256 Go de mémoire vidéo disponible, avec au moins 256 Go de RAM. Ce sont des ordres de grandeur de dimensionnement, pas une garantie de vitesse.

Option réaliste sur le Z840 : garder GLM-5.3-Flash dans le cloud, ou tester un modèle local plus petit déjà installé, comme `gemma4:e4b`, pour le texte et les photos. La qualité pédagogique devra être vérifiée avant tout changement pour les familles.

Sources : [Z.ai, GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash), [ggml-org, version Q2 de 134 Go](https://huggingface.co/ggml-org/GLM-5.3-Flash-GGUF), [version Q4 d'environ 200 Go](https://huggingface.co/bartowski/GLM-5.3-Flash-BF16-GGUF), [Ollama, Gemma 4](https://ollama.com/library/gemma4).

## Ce qui reste à faire

1. **Tester avec un téléphone hors du Wi-Fi.** Ouvrir `https://lumi.tail6bff94.ts.net` en 4G (Wi-Fi coupé), puis vérifier le site, la vidéo, l'inscription d'une famille, les comptes séparés, les photos de cahier, le micro et la voix.
2. **Décider comment recevoir les demandes d'accès.** Aucun service d'envoi d'e-mails n'est configuré. Les demandes peuvent être conservées dans Lumi et consultées dans l'administration (`https://localhost:3443/admin.html`), mais il faut prévoir une façon fiable de les consulter et d'inviter les familles.
3. **Renforcer la continuité.** Les sauvegardes actuelles sont sur le même PC : prévoir une copie sur un autre disque ou un stockage externe. Pour que Lumi démarre avant toute connexion Windows, il faudra installer un vrai service système avec les droits administrateur. Pour l'instant, la session Windows doit avoir été ouverte et le PC doit rester allumé.
4. **Choisir qui doit pouvoir entrer, définitivement.** L'adresse publique est ouverte : le site de présentation est visible de tous et l'application demande de créer un compte famille. Si l'accès doit rester privé, se limiter aux familles invitées et ne pas diffuser le lien.
5. **Plus tard (option payante ~2 €/an) :** un vrai nom de domaine (par exemple `lumi-maison.fr`) avec un tunnel Cloudflare, pour remplacer l'adresse `.ts.net` par un nom plus simple, sans rien changer au parcours des familles.

## Comment marche le tunnel public

- Le logiciel Tailscale (installé sur le PC, compte `prgm0086@`) tourne comme service Windows : il démarre avec le PC, même sans ouvrir de session. Le Funnel est enregistré dans son réglage, donc il revient tout seul après redémarrage.
- L'adresse `https://lumi.tail6bff94.ts.net` est fixe. Le certificat (Let's Encrypt) se renouvelle tout seul.
- Couper le tunnel : `tailscale funnel --https=443 off` dans un terminal. Le rallumer : `tailscale funnel --bg 3000`.
- Le certificat public a été créé à la main une première fois le 07/10/2026 avec `tailscale cert --cert-file ... --key-file ... lumi.tail6bff94.ts.net` (les fichiers temporaires ont été supprimés ensuite).

## Repères sur le PC

- Ouvrir le site : `https://localhost:3443/site/`
- Ouvrir l'application : `https://localhost:3443/`
- Voir la vidéo : `https://localhost:3443/promo/`
- Administration : `https://localhost:3443/admin.html` (demande le code admin)
- Depuis l'extérieur : `https://lumi.tail6bff94.ts.net` (même adresses, sans le `localhost`)
- Sauvegardes locales : `data/backups/` dans ce projet
- Journaux du serveur automatique : `data/logs/` dans ce projet

Ne pas partager le fichier `.env`, les sauvegardes ou les journaux : ils peuvent contenir des informations privées.
