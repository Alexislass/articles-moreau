# Robot de publication — Drive → WordPress

Ce dépôt publie automatiquement les articles validés dans un dossier Google Drive
vers un site WordPress.

**Fonctionnement :** toutes les 15 minutes, GitHub Actions regarde le dossier
`NOTAIRES ARTICLES`, repère les Google Docs dont l'en-tête contient
`status: PUBLIER`, les convertit en HTML WordPress, crée l'article via l'API REST,
puis repasse le Doc en `status: PUBLIÉ` pour ne pas le republier.

> Pendant les tests, le robot crée les articles en **brouillon** (`DEFAULT_STATUS: "draft"`).
> Rien ne part en ligne tant que tu n'as pas changé ce réglage.

---

## Contenu du dépôt

```
publish.mjs                     ← le robot (à ne pas modifier pour démarrer)
package.json
.gitignore
.github/workflows/publish.yml   ← la planification (cron) + le lancement manuel
README.md
```

---

## Installation pas à pas

### 1. Créer le dépôt GitHub

1. Sur github.com → **New repository** → nom : `notaire-publisher` → **Private** → Create.
2. Téléverse tous les fichiers de ce dossier (glisser-déposer ou `git push`),
   en respectant l'arborescence (le dossier `.github/workflows/` doit être conservé).

### 2. Créer le « compte de service » Google (accès au Drive)

Le robot a besoin de lire le dossier Drive et d'y écrire `PUBLIÉ`. On utilise pour
cela un *compte de service* (un robot Google), sans jamais partager ton mot de passe.

1. Va sur https://console.cloud.google.com → crée un projet (ex. `notaire-publisher`).
2. Menu **APIs & Services → Library** : active **Google Drive API** puis **Google Docs API**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   - Donne-lui un nom, valide. Pas besoin de rôle particulier.
4. Ouvre le compte de service créé → onglet **Keys → Add key → Create new key → JSON**.
   - Un fichier `.json` se télécharge : **c'est lui qu'on collera dans GitHub** (étape 4).
5. Note l'**adresse e-mail** du compte de service (ressemble à
   `xxx@notaire-publisher.iam.gserviceaccount.com`).

### 3. Partager le dossier Drive avec le compte de service

1. Dans Google Drive, ouvre le dossier **`NOTAIRES ARTICLES`**.
2. **Partager** → colle l'e-mail du compte de service → rôle **Éditeur** → Envoyer.
   - Le rôle Éditeur est nécessaire pour repasser les Docs en `PUBLIÉ`.

### 4. Créer le mot de passe d'application WordPress

1. `crayondigital.fr/wp-admin` → **Utilisateurs → Profil**.
2. Section **Mots de passe d'application** → nom (ex. `Publisher`) → **Ajouter**.
3. Copie le mot de passe affiché (format `xxxx xxxx xxxx xxxx`). Il ne sera plus réaffiché.

### 5. Enregistrer les secrets dans GitHub

Dépôt → **Settings → Secrets and variables → Actions → New repository secret**.
Crée ces 4 secrets :

| Nom du secret                 | Valeur                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `WP_URL`                      | `https://crayondigital.fr`                                   |
| `WP_USER`                     | ton identifiant WordPress                                     |
| `WP_PASS`                     | le mot de passe d'application (étape 4)                       |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **tout le contenu** du fichier `.json` du compte de service  |

> Les secrets GitHub sont chiffrés. Personne (toi y compris) ne peut les relire ensuite.

### 6. Lancer un premier test

1. Mets dans le dossier Drive un Doc au bon format avec `status: PUBLIER`
   (tu peux reprendre l'article « succession » de test).
2. Dépôt GitHub → onglet **Actions** → workflow **« Publier les articles notaire »**
   → bouton **Run workflow** (lancement manuel immédiat, sans attendre le cron).
3. Vérifie :
   - dans WordPress, un article en **brouillon** est apparu ;
   - dans Drive, le Doc est passé en **`status: PUBLIÉ`**.

---

## Passage en production

Quand le rendu te convient, dans `.github/workflows/publish.yml` change :

```yaml
DEFAULT_STATUS: "draft"
```

en `"publish"` (mise en ligne immédiate dès `PUBLIER`) ou `"future"`
(mise en ligne programmée à la date `schedule_date` indiquée dans le Doc).

---

## Diffusion automatique LinkedIn + Instagram (optionnel, via Zernio)

Quand un article passe en ligne (`DEFAULT_STATUS: "publish"`), le robot peut publier
automatiquement un post **LinkedIn** (accroche + lien) et **Instagram** (légende + image
de couverture). C'est géré par le service **Zernio** (getlate.dev), gratuit jusqu'à 2 comptes.

Le texte des posts est rédigé par le plugin de génération (champs `linkedin_post` et
`instagram_caption` du Doc). Si ces champs ou les secrets Zernio sont absents, le robot
publie l'article normalement et **saute simplement la diffusion sociale**.

### Mise en place
1. Crée un compte sur **[zernio.com](https://zernio.com)** (plan gratuit, 2 comptes).
2. **Connecte LinkedIn et Instagram** dans le tableau de bord Zernio.
   - Instagram doit être un compte **Professionnel/Créateur lié à une page Facebook**
     (exigence de Meta). Zernio guide la connexion.
3. **Settings → API Keys → Create API Key** : copie la clé (`sk_...`).
4. Récupère l'**ID de chaque compte connecté** (account `_id`) dans le dashboard
   (ou via l'API `GET /api/v1/accounts`).
5. Ajoute ces 3 secrets dans GitHub (Settings → Secrets → Actions) :

| Secret | Valeur |
| --- | --- |
| `ZERNIO_API_KEY` | la clé `sk_...` |
| `ZERNIO_LINKEDIN_ID` | l'ID du compte LinkedIn connecté |
| `ZERNIO_INSTAGRAM_ID` | l'ID du compte Instagram connecté |

Au prochain article publié, les posts partiront tout seuls. Pour ne diffuser que sur
LinkedIn pour l'instant, laisse `ZERNIO_INSTAGRAM_ID` vide.

## Réglages utiles

- **Fréquence** : la ligne `cron: "*/15 * * * *"` = toutes les 15 min. Mets `"*/30 * * * *"`
  pour 30 min, etc. (heure UTC ; GitHub peut décaler de quelques minutes).
- **Nom du dossier** : change `DRIVE_FOLDER_NAME` si tu renommes le dossier Drive.
- **Plusieurs articles dans un Doc** : sépare-les par une ligne `=====`.

## Format attendu d'un article (en-tête du Doc)

```
Titre de l'article (première ligne)

slug: titre-de-larticle
excerpt: Résumé court pour le SEO.
categories: Succession, Patrimoine
tags: succession, notaire
status: PUBLIER
schedule_date: 2026-06-24T09:00:00

---

Corps de l'article. ## pour les sous-titres, **gras**, et une section FAQ.
```

## Sécurité

- Aucun identifiant n'est stocké dans le code : tout passe par les **secrets GitHub**.
- Garde le dépôt en **privé**.
- Le fichier JSON du compte de service ne doit **jamais** être committé (déjà couvert par `.gitignore`).
