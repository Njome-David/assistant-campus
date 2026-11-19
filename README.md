# Assistant Campus

Assistant de campus bilingue (français/anglais) avec Firebase Authentication, Firestore, Gemini et Cloudflare Workers. Il retrouve des informations de cours, répond aux questions et rédige des brouillons d’e-mails sans les envoyer. Les conversations sont enregistrées dans Firestore.

## Configuration

Prérequis : Node.js/npm, Firebase CLI, un projet Firebase et un compte Cloudflare avec Wrangler.

1. Activez **E-mail/Mot de passe** dans Firebase Authentication et créez une base Cloud Firestore.
2. Installez les dépendances :

   ```bash
   npm install
   cd worker && npm install
   ```

3. Créez les secrets Wrangler depuis `worker/` :

   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put FIREBASE_WEB_API_KEY
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
   ```

   `FIREBASE_SERVICE_ACCOUNT` doit contenir le JSON complet d’un compte de service ayant accès à Firestore.

Pour le développement local, placez ces trois valeurs dans `worker/.dev.vars` au lieu de créer les secrets Wrangler. Ne commitez jamais ce fichier ou le compte de service.

## Données Firestore

Ajoutez les documents suivants. Les identifiants sont sensibles à la casse et doivent correspondre aux noms donnés à l’assistant.

```text
courses/{courseName}: outline (string), teacher (string)
teachers/{teacherName}: email (string)
```

Les conversations sont enregistrées sous `users/{uid}/sessions`.

## Lancer et déployer

Lancer le Worker localement depuis `worker/` :

```bash
npm run dev
```

Pour tester le frontend, servez le dossier `frontend/` avec un serveur HTTP. Pour utiliser le Worker local, mettez temporairement son URL Wrangler dans `WORKER_URL` dans `frontend/index.html`.

Déployer le Worker, puis le site et les règles Firestore :

```bash
cd worker && npm run deploy
cd ..
firebase deploy --only firestore:rules,hosting
```

Le projet Firebase configuré est `assistant-campus`. Si l’URL du Worker change, mettez `WORKER_URL` à jour avant de redéployer Hosting.

## Sécurité

Le Worker vérifie le jeton Firebase, mais accepte les requêtes de toutes les origines (`Access-Control-Allow-Origin: *`). Restreignez CORS et ajoutez une limite de débit avant toute utilisation en production. Conservez les clés uniquement dans les secrets Wrangler ou dans `worker/.dev.vars` en local.
