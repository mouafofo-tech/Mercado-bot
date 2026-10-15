require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ADMIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || "development";

if (NODE_ENV === "production" && !API_KEY) {
console.error("ERREUR : ADMIN_API_KEY est obligatoire en production.");
process.exit(1);
}

if (!DATABASE_URL) {
console.error("ERREUR : DATABASE_URL est obligatoire.");
process.exit(1);
}

const pool = new Pool({
connectionString: DATABASE_URL,
ssl:
process.env.PGSSL === "true"
? { rejectUnauthorized: false }
: undefined,
connectionTimeoutMillis: 10000,
idleTimeoutMillis: 30000,
max: 10
});

app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.use(
rateLimit({
windowMs: 15 * 60 * 1000,
limit: 300,
standardHeaders: "draft-8",
legacyHeaders: false
})
);

function requireApiKey(req, res, next) {
if (!API_KEY) {
if (NODE_ENV === "production") {
return res.status(503).json({
error: "API non configurée."
});
}

return next();

}

const providedKey = req.get("x-api-key");

if (
typeof providedKey !== "string" ||
providedKey.length !== API_KEY.length ||
!require("crypto").timingSafeEqual(
Buffer.from(providedKey),
Buffer.from(API_KEY)
)
) {
return res.status(401).json({
error: "Clé API invalide ou manquante."
});
}

next();
}

const allowedStatuses = [
"queued",
"running",
"published",
"failed",
"needs_attention",
"cancelled"
];

async function initializeDatabase() {
await pool.query("CREATE TABLE IF NOT EXISTS tasks ( id UUID PRIMARY KEY, type TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '', video_path TEXT, hashtags JSONB NOT NULL DEFAULT '[]'::jsonb, scheduled_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'queued', error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() )");

await pool.query("CREATE INDEX IF NOT EXISTS tasks_status_schedule_idx ON tasks (status, scheduled_at)");

console.log("Base de données initialisée.");
}

// Endpoint public pour vérifier si Render répond.
app.get("/health", async (req, res) => {
try {
await pool.query("SELECT 1");

res.json({
  ok: true,
  service: "mercado-auto-backend",
  database: "connected",
  time: new Date().toISOString()
});

} catch (error) {
console.error("Health check database error:", error.message);

res.status(503).json({
  ok: false,
  service: "mercado-auto-backend",
  database: "unavailable"
});

}
});

// Toutes les routes /api nécessitent la clé API.
app.use("/api", requireApiKey);

// Créer une tâche de publication.
app.post("/api/tasks", async (req, res) => {
try {
const {
type,
caption,
videoPath,
hashtags,
scheduledAt
} = req.body || {};

if (type !== "publish_video") {
  return res.status(400).json({
    error: "type doit être publish_video."
  });
}

if (
  typeof caption !== "string" ||
  caption.length > 2200
) {
  return res.status(400).json({
    error: "caption doit être un texte de 0 à 2200 caractères."
  });
}

if (
  videoPath !== undefined &&
  videoPath !== null &&
  (typeof videoPath !== "string" || videoPath.length > 2048)
) {
  return res.status(400).json({
    error: "videoPath invalide."
  });
}

if (
  hashtags !== undefined &&
  (
    !Array.isArray(hashtags) ||
    hashtags.length > 50 ||
    !hashtags.every(
      (tag) => typeof tag === "string" && tag.length <= 100
    )
  )
) {
  return res.status(400).json({
    error: "hashtags doit être une liste de 50 textes maximum."
  });
}

let parsedSchedule = null;

if (scheduledAt !== undefined && scheduledAt !== null) {
  if (typeof scheduledAt !== "string") {
    return res.status(400).json({
      error: "scheduledAt doit être une date ISO valide."
    });
  }

  const date = new Date(scheduledAt);

  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({
      error: "Date de programmation invalide."
    });
  }

  parsedSchedule = date.toISOString();
}

const id = randomUUID();

const result = await pool.query(
  `INSERT INTO tasks
    (id, type, caption, video_path, hashtags, scheduled_at, status)
   VALUES ($1, $2, $3, $4, $5, $6, 'queued')
   RETURNING *`,
  [
    id,
    type,
    caption,
    videoPath || null,
    JSON.stringify(hashtags || []),
    parsedSchedule
  ]
);

return res.status(201).json({
  ok: true,
  task: result.rows[0]
});

} catch (error) {
console.error("Create task error:", error.message);

return res.status(500).json({
  error: "Impossible de créer la tâche."
});

}
});

// Consulter les tâches, avec pagination.
app.get("/api/tasks", async (req, res) => {
try {
const limit = Math.min(
Math.max(Number.parseInt(req.query.limit, 10) || 20, 1),
100
);

const offset = Math.max(
  Number.parseInt(req.query.offset, 10) || 0,
  0
);

const status = req.query.status;

if (status && !allowedStatuses.includes(status)) {
  return res.status(400).json({
    error: "Filtre de statut invalide."
  });
}

const result = status
  ? await pool.query(
      `SELECT * FROM tasks
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    )
  : await pool.query(
      `SELECT * FROM tasks
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

res.json({
  ok: true,
  tasks: result.rows,
  limit,
  offset
});

} catch (error) {
console.error("List tasks error:", error.message);

res.status(500).json({
  error: "Impossible de récupérer les tâches."
});

}
});

// Mettre à jour le statut d'une tâche.
app.patch("/api/tasks/:id/status", async (req, res) => {
try {
const { status, errorMessage } = req.body || {};

if (!allowedStatuses.includes(status)) {
  return res.status(400).json({
    error: "Statut invalide.",
    allowedStatuses
  });
}

if (
  errorMessage !== undefined &&
  (
    typeof errorMessage !== "string" ||
    errorMessage.length > 1000
  )
) {
  return res.status(400).json({
    error: "errorMessage doit contenir au maximum 1000 caractères."
  });
}

const result = await pool.query(
  `UPDATE tasks
   SET status = $1,
       error_message = $2,
       updated_at = NOW()
   WHERE id = $3
   RETURNING *`,
  [
    status,
    errorMessage || null,
    req.params.id
  ]
);

if (result.rowCount === 0) {
  return res.status(404).json({
    error: "Tâche introuvable."
  });
}

res.json({
  ok: true,
  task: result.rows[0]
});

} catch (error) {
console.error("Update task error:", error.message);

res.status(500).json({
  error: "Impossible de mettre à jour la tâche."
});

}
});

// Statistiques des tâches enregistrées.
app.get("/api/stats", async (req, res) => {
try {
const result = await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status = 'running')::int AS running, COUNT(*) FILTER (WHERE status = 'published')::int AS published, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE status = 'needs_attention')::int AS needs_attention FROM tasks");

res.json({
  ok: true,
  stats: result.rows[0]
});

} catch (error) {
console.error("Stats error:", error.message);

res.status(500).json({
  error: "Impossible de récupérer les statistiques."
});

}
});

// Route inconnue.
app.use((req, res) => {
res.status(404).json({
error: "Route introuvable."
});
});

// Gestion des erreurs inattendues.
app.use((error, req, res, next) => {
if (res.headersSent) {
return next(error);
}

if (error instanceof SyntaxError && "body" in error) {
return res.status(400).json({
error: "JSON invalide."
});
}

console.error("Unexpected error:", error.message);

res.status(500).json({
error: "Erreur interne du serveur."
});
});

let server;

async function start() {
await initializeDatabase();

server = app.listen(PORT, "0.0.0.0", () => {
console.log("MERCADO AUTO écoute sur le port ${PORT}.");
});
}

async function shutdown(signal) {
console.log("${signal} reçu. Arrêt du serveur...");

if (server) {
server.close();
}

await pool.end();
process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
console.error("Démarrage impossible:", error.message);
process.exit(1);
});
