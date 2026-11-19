const FIRESTORE_BASE = (projectId) => `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

const toolDeclarations = [
  {
    name: "getCourseOutline",
    description: "Récupère le plan du cours et le nom du professeur",
    parameters: { type: "object", properties: { courseName: { type: "string" } }, required: ["courseName"] }
  },
  {
    name: "getTeacherEmail",
    description: "Récupère l'email d'un enseignant",
    parameters: { type: "object", properties: { teacherName: { type: "string" } }, required: ["teacherName"] }
  },
  {
    name: "draftEmail",
    description: "Rédige un brouillon d'email, sans l'envoyer. L'expéditeur est toujours l'utilisateur connecté.",
    parameters: {
      type: "object",
      properties: { recipient: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["recipient", "subject", "body"]
    }
  }
];

async function getFirebaseAccessToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(pem);
  const keyData = new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey("pkcs8", keyData.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  const resp = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const data = await resp.json();
  return data.access_token;
}

async function firestoreGet(env, token, collection, docId) {
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const resp = await fetch(`${FIRESTORE_BASE(projectId)}/${collection}/${encodeURIComponent(docId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  const data = await resp.json();
  return data.fields ? data : null;
}

async function firestoreAdd(env, token, path, fields) {
  const projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => {
    if (v instanceof Date) return [k, { timestampValue: v.toISOString() }];
    if (typeof v === "number") return [k, { integerValue: String(v) }];
    return [k, { stringValue: String(v) }];
  }))};
  await fetch(`${FIRESTORE_BASE(projectId)}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function callGemini(env, contents) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + env.GEMINI_API_KEY;
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents, tools: [{ functionDeclarations: toolDeclarations }] }) });
  return await resp.json();
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      const { message, idToken } = await request.json();
      if (!message || !idToken) throw new Error("Message et token requis.");

      // Point 6 : Vérification réelle du token
      const authResp = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + env.FIREBASE_WEB_API_KEY, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken })
      });
      const authData = await authResp.json();
      if (!authData.users || authData.users.length === 0) throw new Error("Token invalide ou expiré.");
      
      const userUid = authData.users[0].localId;
      const userEmail = authData.users[0].email;
      const firebaseToken = await getFirebaseAccessToken(env);

      // Injection du nom de l'utilisateur dans le contexte (Point 6/9)
      const contents = [{ role: "user", parts: [{ text: `[Utilisateur connecté : ${userEmail}]\n\n${message}` }] }];
      
      let steps = 0;
      let finalText = "";
      let trace = ["Accès au modèle Gemini"]; // Point 8

      while (steps < 5) {
        const data = await callGemini(env, contents);
        if (!data.candidates) throw new Error("Indisponibilité temporaire du modèle. Réessayez.");
        
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
          trace.push(`Appel de l'outil : ${name} (${JSON.stringify(args)})`); // Point 8
          
          let result;
          if (name === "getCourseOutline") {
            const doc = await firestoreGet(env, firebaseToken, "courses", args.courseName);
            result = doc ? { cours: args.courseName, outline: doc.fields.outline.stringValue, professeur: doc.fields.teacher.stringValue } : { error: `Cours "${args.courseName}" introuvable.` };
          } else if (name === "getTeacherEmail") {
            const doc = await firestoreGet(env, firebaseToken, "teachers", args.teacherName);
            result = doc ? { enseignant: args.teacherName, email: doc.fields.email.stringValue } : { error: `Enseignant "${args.teacherName}" introuvable.` };
          } else if (name === "draftEmail") {
            // Point 6 : On ajoute l'email de l'utilisateur dans le brouillon
            result = { brouillon: `De: ${userEmail}\nÀ: ${args.recipient}\nObjet: ${args.subject}\n\n${args.body}`, note: "Brouillon uniquement." };
          } else {
            result = { error: `Outil inconnu: ${name}` };
          }
          contents.push({ role: "user", parts: [{ functionResponse: { name, response: result } }] });
        }
        steps++;
        trace.push("Retour au modèle avec les résultats");
      }

      // Point 7 : Sauvegarde dans Firestore
      await firestoreAdd(env, firebaseToken, `users/${userUid}/sessions`, { message, reply: finalText, timestamp: new Date(), steps });

      return new Response(JSON.stringify({ reply: finalText, trace }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};