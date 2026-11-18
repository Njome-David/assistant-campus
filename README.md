# Assistant Campus

Assistant conversationnel de démonstration construit avec **Gemini**, **Firebase** et **Cloudflare Workers**.

Le frontend propose une connexion par e-mail/mot de passe, puis envoie les questions à un Worker. Celui-ci interroge Gemini, peut récupérer des données dans Firestore et peut demander à Gemini de rédiger un brouillon d’e-mail. L’application ne gère pas l’envoi d’e-mails : `draftEmail` produit uniquement du texte.

## Fonctionnalités

- Authentification Firebase Auth par e-mail/mot de passe.
- Interface de chat statique hébergée sur Firebase Hosting.
- Appel de Gemini depuis un Cloudflare Worker.
- Recherche du plan d’un cours via Firestore.
- Recherche de l’adresse e-mail d’un enseignant via Firestore.
- Génération d’un brouillon d’e-mail, sans envoi.
- Maximum de cinq échanges outil/réponse Gemini par requête.
- Ressources statiques servies par Firebase Hosting.

## Architecture

```text
Navigateur
  -> Firebase Auth
  -> frontend/index.html
  -> POST Cloudflare Worker
       -> API Gemini
       -> API REST Firestore
```

Les outils déclarés auprès de Gemini sont :

- `getCourseOutline` : lit un document dans `courses/{courseName}`.
- `getTeacherEmail` : lit un document dans `teachers/{teacherName}`.
- `draftEmail` : construit localement un brouillon d’e-mail.

## Structure

```text
frontend/             Interface web statique et configuration Firebase côté navigateur
worker/src/index.js   API Cloudflare Worker, Gemini et accès Firestore
worker/wrangler.jsonc Configuration du Worker
firebase.json         Configuration Firebase Hosting et Firestore
firestore.rules       Règles d’accès Firestore
service-account.json  Compte de service Firebase utilisé par le Worker
gemini-key.txt        Référence locale à la clé Gemini
```

Le contenu de `worker/.dev.vars` ne doit jamais être ajouté au dépôt.

## Prérequis

- Node.js et npm.
- Un projet Firebase avec Firebase Authentication et Cloud Firestore.
- Firebase CLI : `npm install -g firebase-tools`.
- Un compte Cloudflare avec accès à Workers.
- Wrangler installé localement à la racine : `npm install`.
- Une clé API Gemini.
- Un compte de service Firebase doté d’un accès Firestore.

## Installation

À la racine du dépôt :

```bash
npm install
cd worker
npm install
npx wrangler login
cd ..
```

## Initialiser Firebase

Activez les services suivants dans la console Firebase :

1. **Authentication** : activez le fournisseur E-mail/Mot de passe.
2. **Firestore Database** : créez la base en mode compatible avec les règles du projet.
3. **Hosting** : préparez l’hébergement du projet.


Le projet Firebase configuré est `assistant-campus`.

Déployez les règles Firestore :

```bash
firebase deploy --only firestore:rules
```

### Données de démonstration

Les noms utilisés comme identifiants de documents doivent correspondre exactement aux valeurs envoyées à Gemini. Des exemples français sont possibles, mais ils doivent respecter la casse.

Collection `courses` :

```text
courses/{nomDuCours}
  outline: string
  teacher: string
```

Exemple de champs pour `courses/Computer Architecture` :

```text
outline : Plan du cours
teacher : Nom du professeur
```

Collection `teachers` :

```text
teachers/{nomDuProfesseur}
  email: string
```

Exemple :

```text
teachers/Professor Example
  email: example@campus.edu
```

Vous pouvez créer ces données depuis la console Firebase ou le script `firebaseData` prévu dans votre environnement de démonstration.

## Configurer les secrets du Worker

Depuis `worker/` :

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

Lors de la création du secret `FIREBASE_SERVICE_ACCOUNT`, collez le JSON complet du compte de service en une seule valeur. Ne placez pas ce fichier dans le dépôt ni dans le frontend.

Pour l’environnement local, créez `worker/.dev.vars` avec :

```text
GEMINI_API_KEY=votre_cle_gemini
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"assistant-campus","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

Dans le compte de service, la clé privée doit conserver les caractères de nouvelle ligne attendus par le JWT.

## Développement local

Lancer le Worker :

```bash
cd worker
npm run dev
```

Par défaut, Wrangler affiche une adresse locale sur le port `8787`. Pour tester le frontend sans le déployer, ouvrez [frontend/index.html](frontend/index.html) via un serveur HTTP local. Le frontend pointe actuellement vers l’URL publique du Worker.

Pour que l’application locale utilise un Worker local, remplacez temporairement `WORKER_URL` dans [frontend/index.html](frontend/index.html) par l’adresse affichée par Wrangler.

## Déploiement

Déployer le Worker :

```bash
cd worker
npm run deploy
```

Après un déploiement, mettez à jour `WORKER_URL` dans [frontend/index.html](frontend/index.html) si l’adresse du Worker a changé.

Déployer les règles et le frontend Firebase :

```bash
firebase deploy --only firestore:rules,hosting
```

L’application est alors servie depuis le dossier défini par `firebase.json`, actuellement `frontend/`.

## API du Worker

### Requête

`POST` vers l’URL du Worker :

```json
{
  "message": "Consulte Computer Architecture, trouve le professeur et rédige un mot.",
  "idToken": "jeton_firebase"
}
```

### Réponse

```json
{
  "reply": "Réponse finale de Gemini",
  "steps": 2
}
```

Erreurs courantes :

- `400 Message requis.` : le champ `message` est absent ou vide.
- `401 Connexion requise.` : le champ `idToken` est absent.
- `405 Méthode non autorisée` : une méthode autre que `POST` est utilisée.
- `500` : erreur Gemini, JWT Firebase, Firestore ou parsing des données.

Les préflight CORS sont acceptés. Pour une démonstration locale, l’origine est actuellement autorisée avec `Access-Control-Allow-Origin: *`.

## Sécurité

Cette version est une démonstration :

- le frontend envoie un `idToken`, mais le Worker ne vérifie actuellement pas sa signature avec Identity Toolkit ;
- toute origine peut appeler le Worker depuis son navigateur ;
- les secrets Gemini et Firebase ne doivent exister que dans les secrets Wrangler ou `.dev.vars` ;
- les écrans de données `courses` et `teachers` sont en lecture seule pour les utilisateurs authentifiés ;
- les sessions sous `users/{uid}/sessions` sont limitées à l’utilisateur correspondant par les règles Firestore.

Pour une utilisation en production, vérifiez cryptographiquement le jeton Firebase côté Worker, limitez les origines CORS, ajoutez les quotas de Gemini, appliquez une limite de débit et prévoyez une gestion plus stricte des erreurs.

## Tests

Le projet Worker contient Vitest et le plugin Cloudflare, mais aucun test automatisé n’est fourni pour le moment :

```bash
cd worker
npm test
```

Le Worker peut être observé en direct :

```bash
cd worker
npx wrangler tail
```

## Dépannage

- **Erreur Gemini invalide** : vérifiez `GEMINI_API_KEY` et le nom du modèle configuré dans `worker/src/index.js`.
- **Échec du token Firebase** : vérifiez que `FIREBASE_SERVICE_ACCOUNT` contient un JSON valide et que la clé privée appartient au bon projet.
- **Cours ou enseignant introuvable** : vérifiez le chemin, l’identifiant exact du document et les champs `outline`, `teacher` ou `email`.
- **Connexion impossible** : vérifiez que le fournisseur E-mail/Mot de passe est activé dans Firebase Auth.
- **Frontend déployé mais appel ancien Worker** : vérifiez `WORKER_URL` dans `frontend/index.html`, puis redéployez Hosting.
