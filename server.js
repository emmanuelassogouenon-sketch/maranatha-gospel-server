// MARANATHA GOSPEL — serveur backend
// Rôle : sélectionner le verset du matin/soir (liste vérifiée),
// faire rédiger la méditation et la prière par l'IA à partir de CE verset,
// stocker le résultat, et envoyer une notification push aux abonnés.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// --- CORS : autorise ton site (Netlify) à appeler ce serveur ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const DATA_FILE = path.join(__dirname, "data", "today.json");
const VERSES_FILE = path.join(__dirname, "data", "verses.json");
const VERSES = JSON.parse(fs.readFileSync(VERSES_FILE, "utf-8"));

// --- Variables d'environnement (à définir sur Render) ---
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY; // nouvelle clé "Key" (pas l'ancienne "Basic")
const GENERATE_SECRET = process.env.GENERATE_SECRET; // mot de passe pour protéger l'endpoint de génération

function readToday() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) {
    return null;
  }
}

function writeToday(content) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(content, null, 2));
}

// --- Choix du verset : toujours pris dans la liste vérifiée, jamais inventé par l'IA ---
function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function pickVerse(moment) {
  const today = new Date();
  const offset = moment === "soir" ? 15 : 0; // décale le soir pour ne pas répéter le même verset que le matin
  const index = (dayOfYear(today) + offset) % VERSES.length;
  return VERSES[index];
}

// --- L'IA rédige UNIQUEMENT la méditation et la prière, jamais le verset ---
async function generateReflection(moment, verse) {
  const prompt = `Tu écris pour le site chrétien "MARANATHA GOSPEL", en français.

Voici le verset biblique du ${moment === "matin" ? "matin" : "soir"} (ne le modifie pas, ne le recopie pas dans ta réponse) :
"${verse.verset}" (${verse.reference})

À partir de ce verset UNIQUEMENT, rédige :
1. Une méditation de 3 à 5 phrases, simple et encourageante, fidèle au sens du verset.
2. Une courte prière (3 à 5 phrases) à la première personne du singulier, en lien avec ce verset.

Réponds STRICTEMENT en JSON valide, sans aucun texte autour, avec ce format exact :
{ "meditation": "...", "priere": "..." }`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    }),
  });

  const data = await response.json();
  const raw = data.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// --- Envoi de la notification push via OneSignal (API actuelle) ---
async function sendNotification(moment, content) {
  const title = moment === "matin" ? "🌅 Verset du matin" : "🌙 Verset du soir";
  const messageBody = `${content.verset} — ${content.reference}`;

  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: "push",
      included_segments: ["Subscribed Users"],
      headings: { fr: title },
      contents: { fr: messageBody },
      url: process.env.SITE_URL || "https://maranathagospel.netlify.app",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Erreur OneSignal:", errText);
  }
}

// --- Endpoint appelé 2x/jour par cron-job.org ---
app.post("/generate", async (req, res) => {
  try {
    if (req.query.secret !== GENERATE_SECRET) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    const moment = req.query.moment === "soir" ? "soir" : "matin";

    const verse = pickVerse(moment);
    const reflection = await generateReflection(moment, verse);

    const content = {
      moment,
      date: new Date().toISOString().slice(0, 10),
      verset: verse.verset,
      reference: verse.reference,
      meditation: reflection.meditation,
      priere: reflection.priere,
    };

    writeToday(content);
    await sendNotification(moment, content);

    res.json({ ok: true, content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Échec de la génération", details: err.message });
  }
});

// --- Endpoint appelé par le site pour afficher le contenu du jour ---
app.get("/api/today", (req, res) => {
  const content = readToday();
  if (!content) return res.status(404).json({ error: "Pas encore de contenu généré" });
  res.json(content);
});

app.get("/", (req, res) => res.send("MARANATHA GOSPEL — serveur en ligne."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
