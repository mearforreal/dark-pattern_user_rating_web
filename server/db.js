import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

try {
  process.loadEnvFile();
} catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("! DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}

// Railway's private URL (postgres.railway.internal) needs no SSL. Set PGSSL=true
// when connecting through the public proxy URL from your own machine.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  // Give sessions created before usernames existed one of their own.
  const { rows } = await pool.query("SELECT id, name FROM sessions WHERE username IS NULL");
  for (const r of rows) {
    await withUniqueUsername(r.name, (username) =>
      pool.query("UPDATE sessions SET username = $1 WHERE id = $2", [username, r.id]),
    );
  }
}

// "Alex Smith" -> "alexsmith-4821". The random suffix keeps usernames unique
// and hard to guess, so one participant can't resume another's session.
export function makeUsername(name) {
  const base =
    String(name)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "participant";
  return `${base}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}

// Runs fn(username) with fresh usernames until it doesn't hit the unique index.
export async function withUniqueUsername(name, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(makeUsername(name));
    } catch (e) {
      if (e.code !== "23505" || !String(e.constraint).includes("username") || attempt >= 20) throw e;
    }
  }
}
