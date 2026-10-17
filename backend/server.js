
"use strict";

const express = require("express");
const path = require("node:path");
const helmet = require("helmet");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const PGSSL = process.env.PGSSL === "true";

if (!DATABASE_URL) {
  console.error("ERREUR : DATABASE_URL est absente.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !ADMIN_API_KEY) {
  console.error("ERREUR : ADMIN_API_KEY est absente.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Affiche backend/public/index.html à la racine du site.
app.use(express.static(path.join(__dirname, "public")));

function requireApiKey(req, res, next) {
  // En développement local uniquement, la clé peut être absente.
  if (process.env.NODE_ENV !== "production" && !ADMIN_API_KEY) {
    return next();
  }

  const suppliedKey = req.get("x-api-key");

  if (!ADMIN_API_KEY || suppliedKey !== ADMIN_API_KEY) {
    return res.status(401).json({
      error: "Clé API absente ou invalide."
    });
  }

  next();
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

// Création des tables au démarrage.
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending',
      cj_product_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("Tables PostgreSQL vérifiées.");
}

// Santé du serveur et de la base de données.
app.get("/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");

  res.json({
    ok: true,
    service: "mercado-auto-backend",
    database: "connected",
    time: new Date().toISOString()
  });
}));

// Routes protégées du tableau de bord.
app.use("/api", requireApiKey);

app.get("/api/tasks", asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200"
  );
  res.json(result.rows);
}));

app.post("/api/tasks", asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();

  if (!title) {
    return res.status(400).json({ error: "Le titre est obligatoire." });
  }

  const result = await pool.query(
    `INSERT INTO tasks (title, description)
     VALUES ($1, $2) RETURNING *`,
    [title, description]
  );

  res.status(201).json(result.rows[0]);
}));

app.patch("/api/tasks/:id/status", asyncRoute(async (req, res) => {
  const id = req.params.id;
  const status = String(req.body.status || "").trim();
  const allowed = ["pending", "in_progress", "completed", "failed"];

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "ID invalide." });
  }

  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: "Statut invalide.",
      allowed
    });
  }

  const result = await pool.query(
    `UPDATE tasks
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Tâche introuvable." });
  }

  res.json(result.rows[0]);
}));

app.get("/api/orders", asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM orders ORDER BY created_at DESC LIMIT 200"
  );
  res.json(result.rows);
}));

app.post("/api/orders", asyncRoute(async (req, res) => {
  const customerName = String(req.body.customer_name || "").trim();
  const productName = String(req.body.product_name || "").trim();
  const amount = Number(req.body.amount ?? 0);
  const currency = String(req.body.currency || "USD").trim().toUpperCase();
  const cjProductUrl = String(req.body.cj_product_url || "").trim();

  if (!productName) {
    return res.status(400).json({
      error: "Le nom du produit est obligatoire."
    });
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "Montant invalide." });
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: "Devise invalide." });
  }

  if (cjProductUrl) {
    try {
      const url = new URL(cjProductUrl);
      if (url.protocol !== "https:" ||
          !/(^|\.)cjdropshipping\.com$/i.test(url.hostname)) {
        return res.status(400).json({
          error: "Le lien produit CJ doit utiliser le domaine officiel HTTPS."
        });
      }
    } catch {
      return res.status(400).json({ error: "Lien CJ invalide." });
    }
  }

  const result = await pool.query(
    `INSERT INTO orders
      (customer_name, product_name, amount, currency, cj_product_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [customerName, productName, amount, currency, cjProductUrl]
  );

  res.status(201).json(result.rows[0]);
}));

app.patch("/api/orders/:id/status", asyncRoute(async (req, res) => {
  const id = req.params.id;
  const status = String(req.body.status || "").trim();
  const allowed = [
    "pending",
    "paid",
    "processing",
    "shipped",
    "completed",
    "cancelled",
    "failed"
  ];

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "ID invalide." });
  }

  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: "Statut invalide.",
      allowed
    });
  }

  const result = await pool.query(
    `UPDATE orders
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Commande introuvable." });
  }

  res.json(result.rows[0]);
}));

app.get("/api/stats", asyncRoute(async (req, res) => {
  const [tasks, orders] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM tasks
    `),
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM orders
    `)
  ]);

  res.json({
    tasks: tasks.rows[0],
    orders: orders.rows[0]
  });
}));

// Route de secours : doit rester après les autres routes.
app.use((req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});

// Gestion des erreurs.
app.use((err, req, res, next) => {
  console.error("Erreur serveur :", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: "Erreur interne du serveur."
  });
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MERCADO AUTO écoute sur le port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Démarrage impossible :", err.message);
  process.exit(1);
});

async function shutdown() {
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
