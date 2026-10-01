// Creates the tables and seeds `images` from public/images/{original,variants}.
// Files in original/ are is_ai=false; files in variants/ (<stem>_A|B|C.ext) are
// is_ai=true. Upserts by file name, so it is safe to re-run after adding images.
//
// Usage: npm run db:seed
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, migrate } from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.resolve(__dirname, "..", "public", "images");
const EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function listImages(dir) {
  return fs
    .readdirSync(path.join(imagesDir, dir))
    .filter((f) => EXTS.has(path.extname(f).toLowerCase()))
    .sort();
}

const rows = [];
const originalStems = new Set();

for (const name of listImages("original")) {
  const stem = name.slice(0, -path.extname(name).length);
  originalStems.add(stem);
  rows.push({ name, stem, variant: "original", isAi: false, p: `images/original/${name}` });
}

let orphans = 0;
for (const name of listImages("variants")) {
  const m = name.match(/^(.*)_([ABC])\.[^.]+$/);
  if (!m || !originalStems.has(m[1])) {
    console.warn(`  skip variant with no matching original: ${name}`);
    orphans++;
    continue;
  }
  rows.push({ name, stem: m[1], variant: m[2], isAi: true, p: `images/variants/${name}` });
}

await migrate();

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const r of rows) {
    await client.query(
      `INSERT INTO images (name, group_stem, variant, is_ai, path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE
         SET group_stem = EXCLUDED.group_stem, variant = EXCLUDED.variant,
             is_ai = EXCLUDED.is_ai, path = EXCLUDED.path`,
      [r.name, r.stem, r.variant, r.isAi, r.p],
    );
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

const { rows: [c] } = await pool.query(
  `SELECT count(*) FILTER (WHERE NOT is_ai)::int AS originals,
          count(*) FILTER (WHERE is_ai)::int AS ai
     FROM images`,
);
console.log(`images seeded: ${c.originals} original, ${c.ai} AI variants` +
  (orphans ? ` (${orphans} orphan variants skipped)` : ""));
await pool.end();
