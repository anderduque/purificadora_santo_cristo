import express from "express";
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const isVercel = Boolean(process.env.VERCEL);
const uploadsDir = isVercel ? path.join("/tmp", "uploads") : path.join(dataDir, "uploads");
const dbPath = path.join(dataDir, "santo-cristo.sqlite");
const port = Number(process.env.PORT ?? 4173);
const adminUser = process.env.ADMIN_USER ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "1234";
const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "santo-cristo-local-session";
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID ?? "purificadorasantocristo";
const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const preferFirestore =
  isVercel ||
  process.env.DATA_STORE === "firestore" ||
  Boolean(firebaseServiceAccountJson || firebaseServiceAccountPath || process.env.GOOGLE_APPLICATION_CREDENTIALS);
let useSqlite = !preferFirestore;

fs.mkdirSync(uploadsDir, { recursive: true });

let db = null;
async function initializeSqlite() {
  if (db) return;
  fs.mkdirSync(dataDir, { recursive: true });
  const { default: Database } = await import("better-sqlite3");
  db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      national_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      purchase_amount REAL,
      purchase_note TEXT,
      coupon_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES ('coupon_digits', '4');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('raffle_prize', 'Moto');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('raffle_date', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('raffle_lottery', 'Loteria del Tachira');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('raffle_time', '10:10 pm');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('raffle_promo_image', '');
  `);
}

if (useSqlite) {
  await initializeSqlite();
}

let firestore = null;
if (preferFirestore) {
  try {
    const firebaseOptions = { projectId: firebaseProjectId };
    if (firebaseServiceAccountJson) {
      const serviceAccountText = firebaseServiceAccountJson.trim().startsWith("{")
        ? firebaseServiceAccountJson
        : Buffer.from(firebaseServiceAccountJson, "base64").toString("utf8");
      const serviceAccount = JSON.parse(serviceAccountText);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
      }
      firebaseOptions.credential = cert(serviceAccount);
    } else if (firebaseServiceAccountPath) {
      const serviceAccount = JSON.parse(
        fs.readFileSync(path.resolve(rootDir, firebaseServiceAccountPath), "utf8")
      );
      firebaseOptions.credential = cert(serviceAccount);
    } else {
      firebaseOptions.credential = applicationDefault();
    }

    if (getApps().length === 0) initializeApp(firebaseOptions);
    firestore = getFirestore();
  } catch (error) {
    console.warn(`Firestore no disponible, usando SQLite local: ${error.message}`);
    if (!isVercel) {
      useSqlite = true;
      await initializeSqlite();
    }
  }
}

const app = express();
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

const upload = multer({
  storage: firestore
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadsDir),
        filename: (_req, file, cb) => {
          const extension = path.extname(file.originalname).toLowerCase() || ".jpg";
          cb(null, `promo-${Date.now()}${extension}`);
        }
      }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Solo se permiten imagenes."));
    }
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 }
});

function clean(value) {
  return String(value ?? "").trim();
}

function parseCookies(req) {
  return Object.fromEntries(
    clean(req.headers.cookie)
      .split(";")
      .filter(Boolean)
      .map((cookie) => {
        const [key, ...rest] = cookie.trim().split("=");
        return [key, decodeURIComponent(rest.join("="))];
      })
  );
}

function sameText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signSession(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function verifySessionToken(token) {
  const [payload, signature] = clean(token).split(".");
  if (!payload || !signature || !sameText(signature, signSession(payload))) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.expiresAt > Date.now() && session.username === adminUser;
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  const token = parseCookies(req).admin_session;
  return Boolean(token && verifySessionToken(token));
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Debes iniciar sesion para entrar al panel administrativo." });
  }
  next();
}

function normalizeDigits(value) {
  return clean(value).replace(/[^\d]/g, "");
}

function getCouponDigits() {
  return 4;
}

async function setCouponDigits() {
  if (firestore) {
    await setFirestoreSetting("coupon_digits", "4");
    return 4;
  }

  db.prepare("UPDATE settings SET value = ? WHERE key = 'coupon_digits'").run("4");
  return 4;
}

function getSqliteSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? fallback;
}

function setSqliteSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, clean(value));
}

async function getFirestoreSetting(key, fallback = "") {
  const snapshot = await firestore.collection("settings").doc(key).get();
  return snapshot.exists ? snapshot.data().value ?? fallback : fallback;
}

async function setFirestoreSetting(key, value) {
  await firestore.collection("settings").doc(key).set({
    value: clean(value),
    updated_at: new Date().toISOString()
  }, { merge: true });
}

async function getSetting(key, fallback = "") {
  if (firestore) return getFirestoreSetting(key, fallback);
  return getSqliteSetting(key, fallback);
}

async function setSetting(key, value) {
  if (firestore) return setFirestoreSetting(key, value);
  return setSqliteSetting(key, value);
}

async function getRaffleDetails() {
  return {
    prize: await getSetting("raffle_prize", "Moto"),
    date: await getSetting("raffle_date"),
    lottery: await getSetting("raffle_lottery", "Loteria del Tachira"),
    time: await getSetting("raffle_time", "10:10 pm"),
    promoImage: await getSetting("raffle_promo_image")
  };
}

function localDateString(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function mapFirestoreCoupon(doc) {
  const data = doc.data();
  return {
    id: data.id ?? doc.id,
    first_name: data.first_name,
    last_name: data.last_name,
    national_id: data.national_id,
    phone: data.phone,
    purchase_amount: data.purchase_amount ?? null,
    purchase_note: data.purchase_note ?? null,
    coupon_code: data.coupon_code ?? doc.id,
    created_at: data.created_at ?? localDateString(),
    created_at_iso: data.created_at_iso ?? null
  };
}

async function couponCodeExists(code) {
  if (firestore) {
    const snapshot = await firestore.collection("coupons").doc(code).get();
    return snapshot.exists;
  }

  return Boolean(db.prepare("SELECT 1 FROM coupons WHERE coupon_code = ?").get(code));
}

async function countCoupons() {
  if (firestore) {
    const snapshot = await firestore.collection("coupons").get();
    return snapshot.size;
  }

  return db.prepare("SELECT COUNT(*) AS count FROM coupons").get().count;
}

async function generateCouponCode(digits) {
  const max = 10 ** digits;
  const used = await countCoupons();

  if (used >= max) {
    throw new Error("No quedan cupones disponibles con esa cantidad de digitos.");
  }

  for (let attempts = 0; attempts < 200; attempts += 1) {
    const code = String(crypto.randomInt(0, max)).padStart(digits, "0");
    if (!(await couponCodeExists(code))) return code;
  }

  throw new Error("No se pudo generar un cupon unico. Intenta de nuevo.");
}

async function listCoupons({ query = "", limit = 80 } = {}) {
  if (firestore) {
    const snapshot = await firestore
      .collection("coupons")
      .orderBy("created_at", "desc")
      .limit(Math.min(limit, 500))
      .get();
    const rows = snapshot.docs.map(mapFirestoreCoupon);
    const safeQuery = query.toLowerCase();

    if (!safeQuery) return rows;
    return rows.filter((coupon) =>
      `${coupon.first_name} ${coupon.last_name} ${coupon.national_id} ${coupon.phone} ${coupon.coupon_code}`
        .toLowerCase()
        .includes(safeQuery)
    );
  }

  return query
    ? db
        .prepare(
          `SELECT * FROM coupons
           WHERE lower(first_name || ' ' || last_name || ' ' || national_id || ' ' || phone || ' ' || coupon_code)
           LIKE ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(`%${query}%`, limit)
    : db.prepare("SELECT * FROM coupons ORDER BY id DESC LIMIT ?").all(limit);
}

async function getStats() {
  if (firestore) {
    const coupons = await listCoupons({ limit: 10000 });
    const totalCustomers = new Set(coupons.map((coupon) => coupon.national_id)).size;
    const lastCoupon = coupons[0]
      ? {
          coupon_code: coupons[0].coupon_code,
          first_name: coupons[0].first_name,
          last_name: coupons[0].last_name,
          created_at: coupons[0].created_at
        }
      : null;

    return {
      totalCoupons: coupons.length,
      totalCustomers,
      couponDigits: getCouponDigits(),
      lastCoupon,
      dataStore: "firestore"
    };
  }

  const totalCoupons = db.prepare("SELECT COUNT(*) AS count FROM coupons").get().count;
  const totalCustomers = db
    .prepare("SELECT COUNT(DISTINCT national_id) AS count FROM coupons")
    .get().count;
  const lastCoupon = db
    .prepare("SELECT coupon_code, first_name, last_name, created_at FROM coupons ORDER BY id DESC LIMIT 1")
    .get();

  return {
    totalCoupons,
    totalCustomers,
    couponDigits: getCouponDigits(),
    lastCoupon: lastCoupon ?? null,
    dataStore: "sqlite"
  };
}

async function createCoupon(payload) {
  const couponCode = await generateCouponCode(getCouponDigits());
  const now = new Date();
  const coupon = {
    first_name: payload.firstName,
    last_name: payload.lastName,
    national_id: payload.nationalId,
    phone: payload.phone,
    purchase_amount: payload.purchaseAmount,
    purchase_note: payload.purchaseNote || null,
    coupon_code: couponCode,
    created_at: localDateString(now),
    created_at_iso: now.toISOString(),
    source: firestore ? "firestore" : "sqlite"
  };

  if (firestore) {
    await firestore.collection("coupons").doc(couponCode).set({
      ...coupon,
      id: couponCode,
      audit: {
        action: "created",
        created_at: now.toISOString()
      }
    });
    return { id: couponCode, ...coupon };
  }

  const result = db
    .prepare(
      `INSERT INTO coupons (
        first_name, last_name, national_id, phone, purchase_amount, purchase_note, coupon_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      coupon.first_name,
      coupon.last_name,
      coupon.national_id,
      coupon.phone,
      coupon.purchase_amount,
      coupon.purchase_note,
      coupon.coupon_code,
      coupon.created_at
    );

  return db.prepare("SELECT * FROM coupons WHERE id = ?").get(result.lastInsertRowid);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dataStore: firestore ? "firestore" : "sqlite" });
});

app.post("/api/auth/login", (req, res) => {
  const username = clean(req.body.username);
  const password = String(req.body.password ?? "");

  if (!sameText(username, adminUser) || !sameText(password, adminPassword)) {
    return res.status(401).json({ error: "Usuario o contrasena incorrectos." });
  }

  const token = createSessionToken(username);
  res.cookie("admin_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ authenticated: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("admin_session");
  res.json({ authenticated: false });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get("/api/stats", requireAdmin, async (_req, res) => {
  res.json(await getStats());
});

app.get("/api/coupons", requireAdmin, async (req, res) => {
  const query = clean(req.query.q).toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 80), 300);
  res.json(await listCoupons({ query, limit }));
});

app.post("/api/coupons", async (req, res) => {
  const firstName = clean(req.body.firstName);
  const lastName = clean(req.body.lastName);
  const nationalId = normalizeDigits(req.body.nationalId);
  const phone = normalizeDigits(req.body.phone);
  const purchaseNote = clean(req.body.purchaseNote);
  const purchaseAmount =
    req.body.purchaseAmount === "" || req.body.purchaseAmount == null
      ? null
      : Number(req.body.purchaseAmount);

  if (!firstName || !lastName || !nationalId || !phone) {
    return res.status(400).json({ error: "Nombre, apellido, cedula y telefono son obligatorios." });
  }

  if (nationalId.length < 5) {
    return res.status(400).json({ error: "La cedula debe tener al menos 5 digitos." });
  }

  if (phone.length < 7) {
    return res.status(400).json({ error: "El telefono debe tener al menos 7 digitos." });
  }

  if (purchaseAmount !== null && (!Number.isFinite(purchaseAmount) || purchaseAmount < 0)) {
    return res.status(400).json({ error: "El monto de compra no es valido." });
  }

  try {
    const coupon = await createCoupon({
      firstName,
      lastName,
      nationalId,
      phone,
      purchaseAmount,
      purchaseNote
    });
    res.status(201).json({ coupon, stats: await getStats() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/settings", requireAdmin, (_req, res) => {
  res.json({ couponDigits: getCouponDigits() });
});

app.put("/api/settings", requireAdmin, async (_req, res) => {
  const digits = await setCouponDigits();
  res.json({ couponDigits: digits, stats: await getStats() });
});

app.get("/api/raffle", async (_req, res) => {
  res.json(await getRaffleDetails());
});

app.put("/api/raffle", requireAdmin, async (req, res) => {
  await setSetting("raffle_prize", req.body.prize);
  await setSetting("raffle_date", req.body.date);
  await setSetting("raffle_lottery", req.body.lottery);
  await setSetting("raffle_time", req.body.time);
  res.json(await getRaffleDetails());
});

app.post("/api/raffle/promo-image", requireAdmin, upload.single("promoImage"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Debes seleccionar una imagen." });
  }

  const currentImage = await getSetting("raffle_promo_image");
  if (currentImage?.startsWith("/uploads/")) {
    const currentPath = path.join(uploadsDir, path.basename(currentImage));
    if (fs.existsSync(currentPath)) fs.unlinkSync(currentPath);
  }

  if (firestore) {
    const imageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    if (imageData.length > 950000) {
      return res.status(400).json({
        error: "La imagen es muy pesada para Firestore. Usa una imagen menor a 700 KB."
      });
    }
    await setSetting("raffle_promo_image", imageData);
  } else {
    await setSetting("raffle_promo_image", `/uploads/${req.file.filename}`);
  }
  res.json(await getRaffleDetails());
});

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: "La imagen es demasiado grande. Usa una imagen menor a 8 MB." });
  }
  res.status(400).json({ error: error.message || "No se pudo procesar la solicitud." });
});

if (process.env.NODE_ENV === "production" && !isVercel) {
  const distDir = path.join(rootDir, "dist");
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

if (!isVercel) {
  app.listen(port, () => {
    console.log(`Santo Cristo API lista en http://localhost:${port}`);
  });
}

export default app;
