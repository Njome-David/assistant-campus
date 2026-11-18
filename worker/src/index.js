/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// export default {
// 	async fetch(request, env, ctx) {
// 		return new Response("Hello World!");
// 	},
// };

// Worker Cloudflare — Agent Gemini + Firestore (plan Spark)

const FIRESTORE_BASE = (projectId) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

// ===== DÉCLARATION DES OUTILS (vue par Gemini) =====
const toolDeclarations = [
  {
    name: "getCourseOutline",
    description: "Récupère le plan du cours et le nom du professeur",
    parameters: {
      type: "object",
      properties: { courseName: { type: "string" } },
      required: ["courseName"]
    }
  },
  {
    name: "getTeacherEmail",
    description: "Récupère l'email d'un enseignant",
    parameters: {
      type: "object",
      properties: { teacherName: { type: "string" } },
      required: ["teacherName"]
    }
  },
  {
    name: "draftEmail",
    description: "Rédige un brouillon d'email, sans l'envoyer",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" }
      },
      required: ["recipient", "subject", "body"]
    }
  }
];

// ===== AUTHENTIFICATION FIREBASE (JWT → token OAuth2) =====
async function getFirebaseAccessToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

  const enc = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(pem);
  const keyData = new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error("Échec du token Firebase : " + JSON.stringify(data));
  }
  return data.access_token;
}

// ===== LECTURE FIRESTORE (API REST) =====
async function firestoreGet(env, token, collection, docId) {
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const url = `${FIRESTORE_BASE(projectId)}/${collection}/${encodeURIComponent(docId)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (resp.status === 404) return null;
  const data = await resp.json();
  return data.fields ? data : null;
}

async function firestoreAdd(env, token, path, fields) {
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const url = `${FIRESTORE_BASE(projectId)}/${path}`;
  const body = {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => {
        if (v instanceof Date) return [k, { timestampValue: v.toISOString() }];
        if (typeof v === "number") return [k, { integerValue: String(v) }];
        return [k, { stringValue: String(v) }];
      })
    )
  };
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

// ===== IMPLÉMENTATION DES OUTILS =====
async function getCourseOutline(env, token, { courseName }) {
  const doc = await firestoreGet(env, token, "courses", courseName);
  if (!doc) return { error: `Cours "${courseName}" introuvable.` };
  return {
    cours: courseName,
    outline: doc.fields.outline.stringValue,
    professeur: doc.fields.teacher.stringValue
  };
}

async function getTeacherEmail(env, token, { teacherName }) {
  const doc = await firestoreGet(env, token, "teachers", teacherName);
  if (!doc) return { error: `Enseignant "${teacherName}" introuvable.` };
  return {
    enseignant: teacherName,
    email: doc.fields.email.stringValue
  };
}

async function draftEmail({ recipient, subject, body }) {
  return {
    brouillon: `À: ${recipient}\nObjet: ${subject}\n\n${body}`,
    note: "Brouillon uniquement."
  };
}

// ===== APPEL GEMINI =====
async function callGemini(env, contents) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
    env.GEMINI_API_KEY;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      tools: [{ functionDeclarations: toolDeclarations }]
    })
  });
  const data = await resp.json();
  if (!data.candidates) {
    throw new Error("Réponse Gemini invalide : " + JSON.stringify(data));
  }
  return data;
}

// ===== HANDLER PRINCIPAL =====
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Méthode non autorisée", {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
      const { message, idToken } = await request.json();
      if (!message || typeof message !== "string") {
        return new Response(JSON.stringify({ error: "Message requis." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Vérification simplifiée pour la démo : le frontend envoie un idToken Firebase.
      // En production, vérifier ce token via Identity Toolkit.
      if (!idToken) {
        return new Response(JSON.stringify({ error: "Connexion requise." }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const firebaseToken = await getFirebaseAccessToken(env);
      const contents = [{ role: "user", parts: [{ text: message }] }];

      let steps = 0;
      let finalText = "";

      while (steps < 5) {
        const data = await callGemini(env, contents);
        const candidate = data.candidates[0];
        const parts = candidate.content.parts || [];

        const functionCalls = parts.filter((p) => p.functionCall);
        if (functionCalls.length === 0) {
          finalText = parts.map((p) => p.text || "").join("");
          break;
        }

        contents.push(candidate.content);

        for (const fc of functionCalls) {
          const { name, args } = fc.functionCall;
          let result;

          if (name === "getCourseOutline")
            result = await getCourseOutline(env, firebaseToken, args);
          else if (name === "getTeacherEmail")
            result = await getTeacherEmail(env, firebaseToken, args);
          else if (name === "draftEmail") result = await draftEmail(args);
          else result = { error: `Outil inconnu: ${name}` };

          contents.push({
            role: "user",
            parts: [{ functionResponse: { name, response: result } }]
          });
        }
        steps++;
      }

      // (Optionnel) Sauvegarde dans Firestore — nécessite l'UID.
      // Pour l'instant, on retourne simplement la réponse.
      return new Response(JSON.stringify({ reply: finalText, steps }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
