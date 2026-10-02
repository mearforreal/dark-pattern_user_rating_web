import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool, migrate } from "./db.js";
import { hashStr, seededShuffle } from "../src/shuffle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");
const PORT = Number(process.env.PORT) || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const UUID_RE = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// ---------------------------------------------------------------- images ---

// Images are served by numeric id so the URL never reveals whether a tile is
// the original or an AI variant.
const imagePathCache = new Map();
app.get("/img/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.sendStatus(404);
  let rel = imagePathCache.get(id);
  if (!rel) {
    const { rows } = await pool.query("SELECT path FROM images WHERE id = $1", [id]);
    if (!rows[0]) return res.sendStatus(404);
    rel = rows[0].path;
    imagePathCache.set(id, rel);
  }
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(publicDir, rel));
}));

// Groups in a per-session random order, each with its 4 tiles shuffled.
async function buildPlan(sessionId) {
  const { rows } = await pool.query(
    "SELECT id, group_stem FROM images ORDER BY group_stem, variant",
  );
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group_stem)) groups.set(r.group_stem, []);
    groups.get(r.group_stem).push(r.id);
  }
  const complete = [...groups].filter(([, ids]) => ids.length === 4);
  const ordered = seededShuffle(complete, hashStr(sessionId));
  return ordered.map(([stem, ids]) => ({
    stem,
    tiles: seededShuffle(ids, hashStr(sessionId + stem)).map((id) => ({
      imageId: id,
      url: `/img/${id}`,
    })),
  }));
}

// ---------------------------------------------------------- participants ---

app.post("/api/sessions", wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 200);
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 320);
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email is required" });
  // Email is unique: a returning participant gets their existing session back
  // (name and start time are kept) and continues where they left off.
  const { rows: [s] } = await pool.query(
    `INSERT INTO sessions (name, email, user_agent) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET last_active_at = now()
     RETURNING id, name, email, started_at, (xmax = 0) AS created`,
    [name, email, String(req.get("user-agent") || "").slice(0, 500)],
  );
  const { created, ...session } = s;
  res.status(created ? 201 : 200).json({ ...session, resumed: !created });
}));

async function loadSession(req, res) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const { rows } = await pool.query("SELECT * FROM sessions WHERE id = $1", [id]);
  if (!rows[0]) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return rows[0];
}

app.get("/api/sessions/:id", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  const [plan, sel, fb] = await Promise.all([
    buildPlan(s.id),
    pool.query("SELECT group_stem, image_id, confidence FROM selections WHERE session_id = $1", [s.id]),
    pool.query("SELECT count(*)::int AS n FROM feedback WHERE session_id = $1", [s.id]),
  ]);
  res.json({
    session: { id: s.id, name: s.name, email: s.email, started_at: s.started_at, completed_at: s.completed_at },
    groups: plan,
    selections: Object.fromEntries(
      sel.rows.map((r) => [r.group_stem, { imageId: r.image_id, confidence: r.confidence }]),
    ),
    feedbackCount: fb.rows[0].n,
  });
}));

app.post("/api/sessions/:id/selections", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  const groupStem = String(req.body?.groupStem || "");
  const imageId = Number(req.body?.imageId);
  const tilePosition = Number(req.body?.tilePosition) || null;
  const responseMs = Number.isFinite(req.body?.responseMs) ? Math.round(req.body.responseMs) : null;
  const confidence = Number(req.body?.confidence);
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return res.status(400).json({ error: "Confidence must be 1-5" });
  }

  const { rows: [img] } = await pool.query(
    "SELECT id, is_ai FROM images WHERE id = $1 AND group_stem = $2",
    [imageId, groupStem],
  );
  if (!img) return res.status(400).json({ error: "Image does not belong to that group" });

  await pool.query(
    `INSERT INTO selections
       (session_id, group_stem, image_id, is_ai, tile_position, response_ms, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id, group_stem) DO UPDATE
       SET image_id = EXCLUDED.image_id, is_ai = EXCLUDED.is_ai,
           tile_position = EXCLUDED.tile_position,
           -- a confidence-only edit sends no response time; keep the original
           response_ms = COALESCE(EXCLUDED.response_ms, selections.response_ms),
           confidence = EXCLUDED.confidence,
           selected_at = now(),
           changes = selections.changes + (selections.image_id <> EXCLUDED.image_id)::int`,
    [s.id, groupStem, img.id, img.is_ai, tilePosition, responseMs, confidence],
  );
  const { rows: [c] } = await pool.query(
    `UPDATE sessions SET last_active_at = now() WHERE id = $1
     RETURNING (SELECT count(*)::int FROM selections WHERE session_id = $1) AS count`,
    [s.id],
  );
  res.json({ ok: true, count: c.count });
}));

app.post("/api/sessions/:id/feedback", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  const reason = String(req.body?.reason || "").trim().slice(0, 5000);
  if (reason.length < 10) return res.status(400).json({ error: "Please write at least a sentence" });
  const { rows: [c] } = await pool.query(
    "SELECT count(*)::int AS n FROM selections WHERE session_id = $1", [s.id],
  );
  await pool.query(
    "INSERT INTO feedback (session_id, after_count, reason) VALUES ($1, $2, $3)",
    [s.id, c.n, reason],
  );
  await pool.query("UPDATE sessions SET last_active_at = now() WHERE id = $1", [s.id]);
  res.status(201).json({ ok: true });
}));

app.post("/api/sessions/:id/complete", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  await pool.query(
    `UPDATE sessions SET completed_at = COALESCE(completed_at, now()), last_active_at = now()
     WHERE id = $1`,
    [s.id],
  );
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- admin ---

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server" });
  }
  if (!safeEqual(req.get("x-admin-password") || "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  next();
}
app.use("/api/admin", requireAdmin);

app.get("/api/admin/stats", wrap(async (_req, res) => {
  const [totals, byVariant, byGroup] = await Promise.all([
    pool.query(`
      SELECT (SELECT count(*)::int FROM sessions) AS sessions,
             (SELECT count(*)::int FROM sessions WHERE completed_at IS NOT NULL) AS completed,
             (SELECT count(*)::int FROM selections) AS selections,
             (SELECT count(*)::int FROM selections WHERE is_ai) AS ai_picks,
             (SELECT count(*)::int FROM feedback) AS feedback,
             (SELECT count(DISTINCT group_stem)::int FROM images) AS groups,
             (SELECT round(avg(response_ms))::int FROM selections) AS avg_response_ms,
             (SELECT round(avg(confidence), 2)::float FROM selections) AS avg_confidence`),
    pool.query(`
      SELECT i.variant, count(*)::int AS n, round(avg(s.confidence), 2)::float AS avg_confidence
        FROM selections s JOIN images i ON i.id = s.image_id
       GROUP BY i.variant`),
    pool.query(`
      SELECT s.group_stem,
             count(*)::int AS picks,
             count(*) FILTER (WHERE NOT s.is_ai)::int AS original_picks,
             count(*) FILTER (WHERE i.variant = 'A')::int AS a,
             count(*) FILTER (WHERE i.variant = 'B')::int AS b,
             count(*) FILTER (WHERE i.variant = 'C')::int AS c,
             round(avg(s.confidence), 2)::float AS avg_confidence
        FROM selections s JOIN images i ON i.id = s.image_id
       GROUP BY s.group_stem
       ORDER BY s.group_stem`),
  ]);
  res.json({
    totals: totals.rows[0],
    byVariant: Object.fromEntries(
      byVariant.rows.map((r) => [r.variant, { n: r.n, avgConfidence: r.avg_confidence }]),
    ),
    byGroup: byGroup.rows,
  });
}));

app.get("/api/admin/sessions", wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT se.id, se.name, se.email, se.started_at, se.last_active_at, se.completed_at,
           EXTRACT(EPOCH FROM (COALESCE(se.completed_at, se.last_active_at) - se.started_at))::int
             AS duration_s,
           count(sl.id)::int AS picks,
           count(sl.id) FILTER (WHERE sl.is_ai)::int AS ai_picks,
           round(avg(sl.confidence), 2)::float AS avg_confidence,
           (SELECT string_agg(f.reason, E'\n---\n' ORDER BY f.created_at)
              FROM feedback f WHERE f.session_id = se.id) AS reason
      FROM sessions se
      LEFT JOIN selections sl ON sl.session_id = se.id
     GROUP BY se.id
     ORDER BY se.started_at DESC`);
  res.json(rows);
}));

app.get("/api/admin/sessions/:id", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  const [sel, fb] = await Promise.all([
    pool.query(`
      SELECT sl.group_stem, sl.image_id, i.name AS image_name, i.variant, sl.is_ai,
             sl.tile_position, sl.response_ms, sl.confidence, sl.changes, sl.selected_at
        FROM selections sl JOIN images i ON i.id = sl.image_id
       WHERE sl.session_id = $1
       ORDER BY sl.selected_at`, [s.id]),
    pool.query(
      "SELECT after_count, reason, created_at FROM feedback WHERE session_id = $1 ORDER BY created_at",
      [s.id]),
  ]);
  res.json({ session: s, selections: sel.rows, feedback: fb.rows });
}));

app.delete("/api/admin/sessions/:id", wrap(async (req, res) => {
  const s = await loadSession(req, res);
  if (!s) return;
  await pool.query("DELETE FROM sessions WHERE id = $1", [s.id]);
  res.json({ ok: true });
}));

function csvCell(v) {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get("/api/admin/export.csv", wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT se.id AS session_id, se.name, se.email, se.started_at AS session_started_at,
           se.completed_at AS session_completed_at,
           EXTRACT(EPOCH FROM (COALESCE(se.completed_at, se.last_active_at) - se.started_at))::int
             AS session_duration_s,
           sl.group_stem, i.name AS image_name, i.variant, sl.is_ai,
           sl.confidence, sl.tile_position, sl.response_ms, sl.changes, sl.selected_at,
           (SELECT string_agg(f.reason, ' | ' ORDER BY f.created_at)
              FROM feedback f WHERE f.session_id = se.id) AS reason
      FROM sessions se
      JOIN selections sl ON sl.session_id = se.id
      JOIN images i ON i.id = sl.image_id
     ORDER BY se.started_at, sl.selected_at`);
  const cols = rows.length ? Object.keys(rows[0]) : ["session_id"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="selections.csv"');
  res.send(csv);
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// ------------------------------------------------------- built frontend ---

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

await migrate();
app.listen(PORT, () => console.log(`server listening on :${PORT}`));
