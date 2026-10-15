
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { randomUUID, timingSafeEqual } = require("crypto");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const API_KEY = process.env.ADMIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (NODE_ENV === "production" && !API_KEY) {
  console.error("ADMIN_API_KEY est obligatoire en production.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL est obligatoire.");
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

const taskStatuses = [
  "queued",
  "running",
  "published",
  "failed",
  "needs_attention",
  "cancelled"
];

const orderStatuses = [
  "awaiting_payment",
  "payment_confirmed",
  "awaiting_review",
  "ready_for_cj",
  "cj_order_created",
  "completed",
  "failed",
  "needs_attention"
];

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    if (NODE_ENV === "production") {
      return res.status(503).json({
        error: "API non configurée."
      });
    }

    return next();
  }

  const supplied = req.get("x-api-key");

  if (typeof supplied !== "string") {
    return res.status(401).json({
      error: "Clé API manquante."
    });
  }

  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: "Clé API invalide."
    });
  }

  next();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      video_path TEXT,
      hashtags JSONB NOT NULL DEFAULT '[]'::jsonb,
      scheduled_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'queued',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS tasks_status_schedule_idx
    ON tasks (status, scheduled_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      telegram_chat_id TEXT,
      customer_reference TEXT,
      product_url TEXT NOT NULL,
      product_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      currency TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      payment_reference TEXT,
      cj_order_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_status_created_idx
    ON orders (status, created_at DESC)
  `);

  console.log("Tables PostgreSQL initialisées.");
}

// Vérification du serveur et de la base de données.
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
    console.error("Health check:", error.message);

    res.status(503).json({
      ok: false,
      service: "mercado-auto-backend",
      database: "unavailable"
    });
  }
});

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
        error: "caption invalide."
      });
    }

    if (
      videoPath != null &&
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

    let schedule = null;

    if (scheduledAt != null) {
      if (typeof scheduledAt !== "string") {
        return res.status(400).json({
          error: "scheduledAt doit être une date ISO."
        });
      }

      const date = new Date(scheduledAt);

      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({
          error: "Date de programmation invalide."
        });
      }

      schedule = date.toISOString();
    }

    const result = await pool.query(
      `INSERT INTO tasks
        (id, type, caption, video_path, hashtags, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        randomUUID(),
        type,
        caption,
        videoPath || null,
        JSON.stringify(hashtags || []),
        schedule
      ]
    );

    res.status(201).json({
      ok: true,
      task: result.rows[0]
    });
  } catch (error) {
    console.error("Create task:", error.message);

    res.status(500).json({
      error: "Impossible de créer la tâche."
    });
  }
});

// Consulter les tâches.
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

    const { status } = req.query;

    if (status && !taskStatuses.includes(status)) {
      return res.status(400).json({
        error: "Statut invalide.",
        allowedStatuses: taskStatuses
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
    console.error("List tasks:", error.message);

    res.status(500).json({
      error: "Impossible de récupérer les tâches."
    });
  }
});

// Mettre à jour le statut d'une tâche.
app.patch("/api/tasks/:id/status", async (req, res) => {
  try {
    const { status, errorMessage } = req.body || {};

    if (!taskStatuses.includes(status)) {
      return res.status(400).json({
        error: "Statut de tâche invalide.",
        allowedStatuses: taskStatuses
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
        error: "errorMessage invalide."
      });
    }

    const result = await pool.query(
      `UPDATE tasks
       SET status = $1,
           error_message = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, errorMessage || null, req.params.id]
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
    console.error("Update task:", error.message);

    res.status(500).json({
      error: "Impossible de mettre à jour la tâche."
    });
  }
});

// Enregistrer une commande MERCADO.
// Cette route ne confirme PAS le paiement et ne commande PAS chez CJ.
app.post("/api/orders", async (req, res) => {
  try {
    const {
      telegramChatId,
      customerReference,
      productUrl,
      productName,
      quantity,
      currency,
      amount
    } = req.body || {};

    if (
      typeof productUrl !== "string" ||
      productUrl.length > 2048 ||
      !/^https:\/\/\S+$/i.test(productUrl)
    ) {
      return res.status(400).json({
        error: "productUrl doit être une URL HTTPS valide."
      });
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100
    ) {
      return res.status(400).json({
        error: "quantity doit être un entier entre 1 et 100."
      });
    }

    if (
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency)
    ) {
      return res.status(400).json({
        error: "currency doit être un code ISO, par exemple USD."
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0 ||
      numericAmount > 100000000
    ) {
      return res.status(400).json({
        error: "amount invalide."
      });
    }

    if (
      telegramChatId != null &&
      String(telegramChatId).length > 100
    ) {
      return res.status(400).json({
        error: "telegramChatId invalide."
      });
    }

    const result = await pool.query(
      `INSERT INTO orders (
        id,
        telegram_chat_id,
        customer_reference,
        product_url,
        product_name,
        quantity,
        currency,
        amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        randomUUID(),
        telegramChatId == null ? null : String(telegramChatId),
        customerReference || null,
        productUrl,
        typeof productName === "string"
          ? productName.slice(0, 250)
          : null,
        quantity,
        currency,
        numericAmount
      ]
    );

    res.status(201).json({
      ok: true,
      message: "Commande enregistrée. Paiement à vérifier.",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Create order:", error.message);

    res.status(500).json({
      error: "Impossible d'enregistrer la commande."
    });
  }
});

// Consulter les commandes.
app.get("/api/orders", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 20, 1),
      100
    );

    const offset = Math.max(
      Number.parseInt(req.query.offset, 10) || 0,
      0
    );

    const { status } = req.query;

    if (status && !orderStatuses.includes(status)) {
      return res.status(400).json({
        error: "Statut de commande invalide.",
        allowedStatuses: orderStatuses
      });
    }

    const result = status
      ? await pool.query(
          `SELECT * FROM orders
           WHERE status = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [status, limit, offset]
        )
      : await pool.query(
          `SELECT * FROM orders
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );

    res.json({
      ok: true,
      orders: result.rows,
      limit,
      offset
    });
  } catch (error) {
    console.error("List orders:", error.message);

    res.status(500).json({
      error: "Impossible de récupérer les commandes."
    });
  }
});

// Les statuts financiers ne peuvent pas être modifiés par cette route.
// Ils doivent être mis à jour après vérification côté serveur
// via une intégration officielle CamerPay ou CJ.
app.patch("/api/orders/:id/status", async (req, res) => {
  return res.status(501).json({
    error: "Mise à jour financière désactivée.",
    message:
      "Intègre d'abord la vérification officielle CamerPay/CJ avant de modifier le statut."
  });
});

// Statistiques.
app.get("/api/stats", async (req, res) => {
  try {
    const [taskResult, orderResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE status = 'running')::int AS running,
          COUNT(*) FILTER (WHERE status = 'published')::int AS published,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (
            WHERE status = 'needs_attention'
          )::int AS needs_attention
        FROM tasks
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE status = 'awaiting_payment'
          )::int AS awaiting_payment,
          COUNT(*) FILTER (
            WHERE status = 'payment_confirmed'
          )::int AS payment_confirmed,
          COUNT(*) FILTER (
            WHERE status = 'completed'
          )::int AS completed,
          COUNT(*) FILTER (
            WHERE status = 'failed'
          )::int AS failed
        FROM orders
      `)
    ]);

    res.json({
      ok: true,
      tasks: taskResult.rows[0],
      orders: orderResult.rows[0]
    });
  } catch (error) {
    console.error("Stats:", error.message);

    res.status(500).json({
      error: "Impossible de récupérer les statistiques."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route introuvable."
  });
});

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
    console.log(`MERCADO AUTO écoute sur le port ${PORT}.`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} reçu. Arrêt du serveur...`);

  if (server) {
    await new Promise((resolve) => server.close(resolve));
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
