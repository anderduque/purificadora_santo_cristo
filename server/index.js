import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";
import dotenv from "dotenv";
import { Storage } from "@google-cloud/storage";

const envPath = path.resolve(process.cwd(), ".env");
const envExamplePath = path.resolve(process.cwd(), ".env.example");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (fs.existsSync(envExamplePath)) {
  dotenv.config({ path: envExamplePath });
}

const port = Number(process.env.PORT ?? 4173);
const adminUser = process.env.ADMIN_USER ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "1234";
const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "santo-cristo-local-session";
const bucketName = process.env.STORAGE_BUCKET ?? "purificadorasantocristo.firebasestorage.app";
const storageServiceAccountJson =
  process.env.STORAGE_SERVICE_ACCOUNT_JSON ?? process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const storageServiceAccountPath = process.env.STORAGE_SERVICE_ACCOUNT_PATH;
const publicUploads = process.env.STORAGE_PUBLIC_UPLOADS !== "false";

function loadServiceAccount() {
  if (storageServiceAccountJson) {
    const raw = storageServiceAccountJson.trim().startsWith("{")
      ? storageServiceAccountJson
      : Buffer.from(storageServiceAccountJson, "base64").toString("utf8");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
    return serviceAccount;
  }
  if (storageServiceAccountPath) {
    return JSON.parse(fs.readFileSync(storageServiceAccountPath, "utf8"));
  }
  return null;
}

const serviceAccount = loadServiceAccount();
const storage = new Storage(
  serviceAccount
    ? { credentials: serviceAccount, projectId: serviceAccount.project_id }
    : undefined
);
const bucket = storage.bucket(bucketName);

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
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
    expiresAt: Date.now() + 15 * 60 * 1000
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

const SETTINGS_KEY = "data/settings.json";
const COUPONS_KEY = "data/coupons.json";

function defaultSettings() {
  return {
    coupon_digits: "4",
    raffle_prize: "Moto",
    raffle_date: "",
    raffle_lottery: "Loteria del Tachira",
    raffle_time: "10:10 pm",
    raffle_promo_image_url: "",
    raffle_promo_image_path: "",
    raffle_last_draw: null
  };
}

async function readJson(key, fallback) {
  try {
    const [contents] = await bucket.file(key).download();
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error.code === 404) return fallback;
    throw error;
  }
}

async function writeJson(key, value) {
  await bucket.file(key).save(JSON.stringify(value, null, 2), {
    contentType: "application/json"
  });
}

async function loadSettings() {
  const settings = await readJson(SETTINGS_KEY, null);
  if (settings) return { ...defaultSettings(), ...settings };
  const initial = defaultSettings();
  await writeJson(SETTINGS_KEY, initial);
  return initial;
}

async function saveSettings(next) {
  const settings = { ...defaultSettings(), ...next };
  await writeJson(SETTINGS_KEY, settings);
  return settings;
}

async function getPromoImageUrl(settings) {
  if (!settings.raffle_promo_image_path) {
    return settings.raffle_promo_image_url || "";
  }
  if (publicUploads) {
    return settings.raffle_promo_image_url || "";
  }
  const [signedUrl] = await bucket.file(settings.raffle_promo_image_path).getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000
  });
  return signedUrl;
}

async function setCouponDigits() {
  const settings = await loadSettings();
  settings.coupon_digits = "4";
  await saveSettings(settings);
  return 4;
}

async function getRaffleDetails() {
  const settings = await loadSettings();
  return {
    prize: settings.raffle_prize || "Moto",
    date: settings.raffle_date || "",
    lottery: settings.raffle_lottery || "Loteria del Tachira",
    time: settings.raffle_time || "10:10 pm",
    promoImage: await getPromoImageUrl(settings),
    lastDraw: settings.raffle_last_draw || null
  };
}

function localDateString(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function loadCoupons() {
  return await readJson(COUPONS_KEY, []);
}

async function saveCoupons(coupons) {
  await writeJson(COUPONS_KEY, coupons);
}

function groupParticipants(coupons) {
  const participants = new Map();
  for (const coupon of coupons) {
    const key = coupon.national_id;
    if (!participants.has(key)) {
      participants.set(key, {
        national_id: coupon.national_id,
        first_name: coupon.first_name,
        last_name: coupon.last_name,
        phone: coupon.phone,
        coupon_count: 0
      });
    }
    const entry = participants.get(key);
    entry.coupon_count += 1;
  }
  return Array.from(participants.values()).sort((a, b) => b.coupon_count - a.coupon_count);
}

async function couponCodeExists(code, coupons) {
  return coupons.some((coupon) => coupon.coupon_code === code);
}

async function countCoupons(coupons) {
  return coupons.length;
}

async function generateCouponCode(digits, coupons) {
  const max = 10 ** digits;
  const used = await countCoupons(coupons);

  if (used >= max) {
    throw new Error("No quedan cupones disponibles con esa cantidad de digitos.");
  }

  for (let attempts = 0; attempts < 200; attempts += 1) {
    const code = String(crypto.randomInt(0, max)).padStart(digits, "0");
    if (!(await couponCodeExists(code, coupons))) return code;
  }

  throw new Error("No se pudo generar un cupon unico. Intenta de nuevo.");
}

async function listCoupons({ query = "", date = "", limit = 80 } = {}) {
  const coupons = await loadCoupons();
  const safeQuery = query.toLowerCase();
  let filtered = safeQuery
    ? coupons.filter((coupon) =>
        `${coupon.first_name} ${coupon.last_name} ${coupon.national_id} ${coupon.phone} ${coupon.coupon_code}`
          .toLowerCase()
          .includes(safeQuery)
      )
    : coupons;
  if (date) {
    filtered = filtered.filter((coupon) =>
      String(coupon.created_at_iso || coupon.created_at).startsWith(date)
    );
  }
  return filtered
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, Math.min(limit, 500));
}

async function getStats() {
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
    dataStore: "storage"
  };
}

async function createCoupon(payload) {
  const coupons = await loadCoupons();
  const couponCode = await generateCouponCode(getCouponDigits(), coupons);
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
    source: "storage"
  };
  coupons.unshift({ id: couponCode, ...coupon });
  await saveCoupons(coupons);
  const customerCouponCount = coupons.filter((row) => row.national_id === coupon.national_id).length;
  return { id: couponCode, ...coupon, customer_coupon_count: customerCouponCount };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dataStore: "storage" });
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
    maxAge: 15 * 60 * 1000
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
  const date = clean(req.query.date);
  const limit = Math.min(Number(req.query.limit ?? 80), 300);
  res.json(await listCoupons({ query, date, limit }));
});

app.delete("/api/coupons/:code", requireAdmin, async (req, res) => {
  const code = clean(req.params.code);
  if (!code) return res.status(400).json({ error: "Codigo de cupon requerido." });
  const coupons = await loadCoupons();
  const index = coupons.findIndex((c) => c.coupon_code === code);
  if (index === -1) return res.status(404).json({ error: "Cupon no encontrado." });
  coupons.splice(index, 1);
  await saveCoupons(coupons);
  res.json({ deleted: true, coupon_code: code });
});

app.get("/api/coupons/count", async (req, res) => {
  const raw = clean(req.query.nationalId).toUpperCase();
  if (!raw) return res.json({ nationalId: "", count: 0 });
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return res.json({ nationalId: raw, count: 0 });
  const coupons = await loadCoupons();
  const count = coupons.filter((coupon) =>
    coupon.national_id === raw ||
    coupon.national_id.replace(/[^\d]/g, "") === digits
  ).length;
  res.json({ nationalId: raw, count });
});

app.post("/api/coupons", async (req, res) => {
  const firstName = clean(req.body.firstName);
  const lastName = clean(req.body.lastName);
  const nationalId = clean(req.body.nationalId).toUpperCase();
  const nationalIdDigits = nationalId.replace(/[^\d]/g, "");
  const phone = normalizeDigits(req.body.phone);
  const purchaseNote = clean(req.body.purchaseNote);
  const purchaseAmount =
    req.body.purchaseAmount === "" || req.body.purchaseAmount == null
      ? null
      : Number(req.body.purchaseAmount);

  if (!firstName || !lastName || !nationalId || !phone) {
    return res.status(400).json({ error: "Nombre, apellido, cedula y telefono son obligatorios." });
  }

  if (nationalIdDigits.length < 5) {
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
    res.status(201).json({
      coupon,
      stats: await getStats(),
      customerCouponCount: coupon.customer_coupon_count
    });
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
  const settings = await loadSettings();
  settings.raffle_prize = clean(req.body.prize) || settings.raffle_prize;
  settings.raffle_date = clean(req.body.date);
  settings.raffle_lottery = clean(req.body.lottery) || settings.raffle_lottery;
  settings.raffle_time = clean(req.body.time) || settings.raffle_time;
  await saveSettings(settings);
  res.json(await getRaffleDetails());
});

app.get("/api/raffle/participants", requireAdmin, async (_req, res) => {
  const coupons = await loadCoupons();
  const participants = groupParticipants(coupons);
  res.json({
    participants,
    totalParticipants: participants.length,
    totalCoupons: coupons.length
  });
});

app.post("/api/raffle/draw", requireAdmin, async (_req, res) => {
  const coupons = await loadCoupons();
  const participants = groupParticipants(coupons);
  if (participants.length === 0) {
    return res.status(400).json({ error: "No hay participantes registrados." });
  }

  const winner = participants[crypto.randomInt(0, participants.length)];
  const drawnAt = new Date().toISOString();
  const settings = await loadSettings();
  settings.raffle_last_draw = {
    winner,
    drawn_at: drawnAt,
    totalParticipants: participants.length,
    totalCoupons: coupons.length
  };
  await saveSettings(settings);

  res.json({
    winner,
    drawnAt,
    totalParticipants: participants.length,
    totalCoupons: coupons.length
  });
});

app.post("/api/raffle/promo-image", requireAdmin, upload.single("promoImage"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Debes seleccionar una imagen." });
  }
  const settings = await loadSettings();

  if (settings.raffle_promo_image_path) {
    await bucket.file(settings.raffle_promo_image_path).delete().catch(() => {});
  }

  const extension = path.extname(req.file.originalname || "").toLowerCase() || ".jpg";
  const objectPath = `uploads/promo-${Date.now()}${extension}`;
  const file = bucket.file(objectPath);
  await file.save(req.file.buffer, {
    contentType: req.file.mimetype,
    resumable: false
  });

  if (publicUploads) {
    await file.makePublic().catch(() => {});
  }

  if (publicUploads) {
    const encodedPath = objectPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    settings.raffle_promo_image_url = `https://storage.googleapis.com/${bucketName}/${encodedPath}`;
  } else {
    settings.raffle_promo_image_url = "";
  }
  settings.raffle_promo_image_path = objectPath;
  await saveSettings(settings);
  res.json(await getRaffleDetails());
});

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: "La imagen es demasiado grande. Usa una imagen menor a 8 MB." });
  }
  res.status(400).json({ error: error.message || "No se pudo procesar la solicitud." });
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve("dist");
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Santo Cristo API lista en http://localhost:${port}`);
  });
}

export default app;
