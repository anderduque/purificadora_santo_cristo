import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BadgePlus,
  CalendarClock,
  CircleDollarSign,
  ClipboardList,
  Eye,
  EyeOff,
  Home,
  ImagePlus,
  Lock,
  LogOut,
  Phone,
  Search,
  Settings,
  Sparkles,
  Ticket,
  Trophy,
  UserRound
} from "lucide-react";
import "./styles.css";

const logoSrc = "/santo-cristo-logo.jpeg";
const homeSrc = "/santo-cristo-home.jpg";

const emptyForm = {
  firstName: "",
  lastName: "",
  nationalId: "",
  phone: "",
  purchaseAmount: "",
  purchaseNote: ""
};

const emptyRaffle = {
  prize: "Moto",
  date: "",
  lottery: "Loteria del Tachira",
  time: "10:10 pm",
  promoImage: ""
};

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-VE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(`${value}Z`));
}

function formatRaffleDate(value) {
  if (!value) return "Fecha por anunciar";
  return new Intl.DateTimeFormat("es-VE", {
    dateStyle: "long"
  }).format(new Date(`${value}T12:00:00`));
}

function money(value) {
  if (value == null) return "Sin monto";
  return new Intl.NumberFormat("es-VE", {
    style: "currency",
    currency: "USD"
  }).format(value);
}

function couponCountLabel(count) {
  if (count == null) return "";
  if (count === 0) return "Aun no tiene cupones registrados.";
  return `Lleva ${count} ${count === 1 ? "cupon" : "cupones"}.`;
}

function pickRandomParticipant(participants) {
  if (!participants?.length) return null;
  const index = Math.floor(Math.random() * participants.length);
  return participants[index];
}

async function api(path, options) {
  const isFormData = options?.body instanceof FormData;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25000);

  let response;
  try {
    response = await fetch(path, {
      headers: isFormData ? undefined : { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("La solicitud tardo demasiado. Prueba con una imagen mas pequena.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Ocurrio un error.");
  return data;
}

async function fetchCouponCount(nationalId) {
  const response = await api(`/api/coupons/count?nationalId=${encodeURIComponent(nationalId)}`);
  return response.count ?? 0;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Selecciona una imagen valida."));
      return;
    }

    const image = new Image();
    const reader = new FileReader();

    reader.onload = () => {
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));

    image.onload = () => {
      const maxSide = 1200;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);

      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      let quality = 0.78;
      const tryExport = () => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("No se pudo preparar la imagen."));
            return;
          }

          if (blob.size <= 700 * 1024 || quality <= 0.42) {
            if (blob.size > 900 * 1024) {
              reject(new Error("La imagen sigue siendo muy pesada. Usa una imagen mas pequena."));
              return;
            }
            resolve(new File([blob], "promocion-sorteo.jpg", { type: "image/jpeg" }));
            return;
          }

          quality -= 0.12;
          tryExport();
        }, "image/jpeg", quality);
      };

      tryExport();
    };

    image.onerror = () => reject(new Error("La imagen seleccionada no se pudo cargar."));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (path === "/admin") return <AdminApp />;
  if (path === "/participar") return <CustomerRegister />;
  return <CustomerHome />;
}

function CustomerHome() {
  const [raffle, setRaffle] = useState(emptyRaffle);

  useEffect(() => {
    api("/api/raffle").then(setRaffle).catch(() => {});
  }, []);

  return (
    <main className="publicHome" style={{ "--home-image": `url(${homeSrc})` }}>
      <section className="heroPanel">
        <div className="heroCopy">
          <p className="eyebrow publicEyebrow">Rifa de la moto</p>
          <h1>{raffle.prize || "Santo Cristo"}</h1>
          <p>
            Registra tus datos después de tu compra y recibe tu cupón para participar en el sorteo.
          </p>
          <div className="raffleMeta">
            <span><Trophy size={16} /> {raffle.prize || "Moto"}</span>
            <span><CalendarClock size={16} /> {formatRaffleDate(raffle.date)}</span>
            <span><Ticket size={16} /> Sorteo local · {raffle.time || "10:10 pm"}</span>
          </div>
          {raffle.promoImage && (
            <img className="homePromo" src={raffle.promoImage} alt="Promocion del sorteo" />
          )}
          <a className="publicButton" href="/participar">
            <Ticket size={20} />
            Participar en sorteo
          </a>
        </div>
      </section>
      <a className="adminLink" href="/admin" aria-label="Abrir administracion">
        <Settings size={18} />
        Admin
      </a>
    </main>
  );
}

function CustomerRegister() {
  const [form, setForm] = useState(emptyForm);
  const [createdCoupon, setCreatedCoupon] = useState(null);
  const [couponCount, setCouponCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  }

  useEffect(() => {
    const nationalId = form.nationalId.trim();
    if (!nationalId) {
      setCouponCount(null);
      return;
    }
    const handle = window.setTimeout(() => {
      fetchCouponCount(nationalId)
        .then((count) => setCouponCount(count))
        .catch(() => setCouponCount(null));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [form.nationalId]);

  async function submitPurchase(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const data = await api("/api/coupons", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          purchaseNote: form.purchaseNote || "Registro cliente"
        })
      });
      setCreatedCoupon({
        ...data.coupon,
        customerCouponCount: data.customerCouponCount
      });
      setForm(emptyForm);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (createdCoupon) {
    return (
      <main className="registerPage">
        <section className="successPanel">
          <img className="miniLogo" src={logoSrc} alt="Santo Cristo Purificadora de Agua" />
          <p className="eyebrow publicEyebrow">Cupon generado</p>
          <strong>{createdCoupon.coupon_code}</strong>
          <h1>{createdCoupon.first_name} {createdCoupon.last_name}</h1>
          <p>Guarda este número. La administración también lo tiene registrado.</p>
          {createdCoupon.customerCouponCount != null && (
            <small className="couponCountHint">
              {couponCountLabel(createdCoupon.customerCouponCount)}
            </small>
          )}
          <div className="successActions">
            <button className="publicButton" onClick={() => setCreatedCoupon(null)}>
              <BadgePlus size={20} />
              Registrar otro
            </button>
            <a className="ghostButton" href="/">
              <Home size={18} />
              Inicio
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="registerPage">
      <section className="customerFormPanel">
        <a className="backButton" href="/">
          <Home size={18} />
          Inicio
        </a>
        <img className="miniLogo" src={logoSrc} alt="Santo Cristo Purificadora de Agua" />
        <p className="eyebrow publicEyebrow">Participar en sorteo</p>
        <h1>Ingresa tus datos</h1>
        <p className="formLead">Cada compra registrada genera un cupón único para la rifa.</p>

        {error && <div className="alert error">{error}</div>}

        <form className="customerForm" onSubmit={submitPurchase}>
          <Field label="Nombre" icon={<UserRound />}>
            <input
              value={form.firstName}
              onChange={(event) => updateField("firstName", event.target.value)}
              autoComplete="given-name"
              required
            />
          </Field>
          <Field label="Apellido" icon={<UserRound />}>
            <input
              value={form.lastName}
              onChange={(event) => updateField("lastName", event.target.value)}
              autoComplete="family-name"
              required
            />
          </Field>
          <Field label="Cedula" icon={<ClipboardList />}>
            <input
              value={form.nationalId}
              onChange={(event) => updateField("nationalId", event.target.value)}
              inputMode="numeric"
              required
            />
          </Field>
          {couponCount != null && (
            <p className="couponCountHint">{couponCountLabel(couponCount)}</p>
          )}
          <Field label="Telefono" icon={<Phone />}>
            <input
              value={form.phone}
              onChange={(event) => updateField("phone", event.target.value)}
              inputMode="tel"
              required
            />
          </Field>
          <button className="publicButton wide" disabled={loading} type="submit">
            <Ticket size={20} />
            {loading ? "Guardando..." : "Guardar y generar cupón"}
          </button>
        </form>
      </section>
    </main>
  );
}

function AdminApp() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    api("/api/auth/me")
      .then((data) => setAuthenticated(data.authenticated))
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
    return (
      <main className="adminLoginPage">
        <section className="adminLoginCard compact">
          <img className="loginLogo" src={logoSrc} alt="Santo Cristo Purificadora de Agua" />
          <p>Verificando acceso...</p>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return <AdminLogin onSuccess={() => setAuthenticated(true)} />;
  }

  return <AdminDashboard onLogout={() => setAuthenticated(false)} />;
}

function AdminLogin({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submitLogin(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="adminLoginPage">
      <a className="loginHomeLink" href="/">
        <Home size={18} />
        Inicio cliente
      </a>
      <p className="loginKicker">Acceso administrativo</p>
      <form className="adminLoginCard" onSubmit={submitLogin}>
        <img className="loginLogo" src={logoSrc} alt="Santo Cristo Purificadora de Agua" />
        <h1>Panel de administración</h1>
        <p>Gestiona cupones, sorteo y configuración interna desde un solo lugar.</p>

        {error && <div className="alert error">{error}</div>}

        <label className="loginField">
          <span>Usuario</span>
          <input
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="admin"
            required
            value={username}
          />
        </label>

        <label className="loginField">
          <span>Contraseña</span>
          <div className="passwordBox">
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              onClick={() => setShowPassword((current) => !current)}
              type="button"
            >
              {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
            </button>
          </div>
        </label>

        <button className="loginButton" disabled={loading} type="submit">
          <Lock size={20} />
          {loading ? "Ingresando..." : "Iniciar sesión"}
        </button>
      </form>
      <small className="loginFooter">© Santo Cristo</small>
    </main>
  );
}

function AdminDashboard({ onLogout }) {
  const [activeModule, setActiveModule] = useState("home");
  const [form, setForm] = useState(emptyForm);
  const [customerCouponCount, setCustomerCouponCount] = useState(null);
  const [stats, setStats] = useState(null);
  const [coupons, setCoupons] = useState([]);
  const [createdCoupon, setCreatedCoupon] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [raffle, setRaffle] = useState(emptyRaffle);
  const [raffleForm, setRaffleForm] = useState(emptyRaffle);
  const [raffleImageFile, setRaffleImageFile] = useState(null);
  const [raffleParticipants, setRaffleParticipants] = useState([]);
  const [raffleSelection, setRaffleSelection] = useState(null);
  const [raffleWinner, setRaffleWinner] = useState(null);
  const [raffleTotals, setRaffleTotals] = useState({ participants: 0, coupons: 0 });
  const [rafflePreparing, setRafflePreparing] = useState(false);
  const [showDrawConfirm, setShowDrawConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function loadInitial() {
    const [statsData, couponsData, raffleData] = await Promise.all([
      api("/api/stats"),
      api("/api/coupons"),
      api("/api/raffle")
    ]);
    setStats(statsData);
    setCoupons(couponsData);
    setRaffle(raffleData);
    setRaffleForm(raffleData);
  }

  useEffect(() => {
    loadInitial().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      api(`/api/coupons?q=${encodeURIComponent(query)}`)
        .then(setCoupons)
        .catch((err) => setError(err.message));
    }, 250);

    return () => window.clearTimeout(handle);
  }, [query]);

  const fullName = useMemo(() => {
    return `${form.firstName} ${form.lastName}`.trim() || "Nuevo cliente";
  }, [form.firstName, form.lastName]);

  const groupedCoupons = useMemo(() => {
    const map = new Map();
    for (const coupon of coupons) {
      const key = coupon.national_id;
      if (!map.has(key)) {
        map.set(key, {
          national_id: coupon.national_id,
          first_name: coupon.first_name,
          last_name: coupon.last_name,
          phone: coupon.phone,
          codes: []
        });
      }
      map.get(key).codes.push(coupon.coupon_code);
    }
    return Array.from(map.values());
  }, [coupons]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
    setNotice("");
  }

  function updateRaffleField(field, value) {
    setRaffleForm((current) => ({ ...current, [field]: value }));
    setError("");
    setNotice("");
  }

  async function saveRaffle(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    try {
      let raffleData = await api("/api/raffle", {
        method: "PUT",
        body: JSON.stringify(raffleForm)
      });

      if (raffleImageFile) {
        const compressedImage = await compressImage(raffleImageFile);
        const uploadData = new FormData();
        uploadData.append("promoImage", compressedImage);
        raffleData = await api("/api/raffle/promo-image", {
          method: "POST",
          body: uploadData
        });
      }

      setRaffle(raffleData);
      setRaffleForm(raffleData);
      setRaffleImageFile(null);
      setNotice("Detalles del sorteo guardados.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitPurchase(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    try {
      const data = await api("/api/coupons", {
        method: "POST",
        body: JSON.stringify(form)
      });
      setCreatedCoupon(data.coupon);
      setStats(data.stats);
      setForm(emptyForm);
      setCustomerCouponCount(data.customerCouponCount ?? null);
      const countText = data.customerCouponCount != null
        ? ` Cliente con ${data.customerCouponCount} ${data.customerCouponCount === 1 ? "cupon" : "cupones"}.`
        : "";
      setNotice(`Compra registrada y cupon generado.${countText}`);
      setCoupons(await api("/api/coupons"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmFourDigits() {
    setError("");
    setNotice("");
    try {
      const data = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ couponDigits: 4 })
      });
      setStats(data.stats);
      setNotice("Los cupones nuevos se mantienen en 4 digitos.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
  }

  useEffect(() => {
    const nationalId = form.nationalId.trim();
    if (!nationalId) {
      setCustomerCouponCount(null);
      return;
    }
    const handle = window.setTimeout(() => {
      fetchCouponCount(nationalId)
        .then((count) => setCustomerCouponCount(count))
        .catch(() => setCustomerCouponCount(null));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [form.nationalId]);

  async function prepareRaffle() {
    setRafflePreparing(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/raffle/participants");
      setRaffleParticipants(data.participants ?? []);
      setRaffleTotals({
        participants: data.totalParticipants ?? 0,
        coupons: data.totalCoupons ?? 0
      });
      setRaffleSelection(pickRandomParticipant(data.participants ?? []));
      setRaffleWinner(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setRafflePreparing(false);
    }
  }

  async function drawRaffle() {
    setRafflePreparing(true);
    setError("");
    setNotice("");
    try {
      const data = await api("/api/raffle/draw", { method: "POST" });
      setRaffleWinner(data.winner);
      setRaffleSelection(data.winner);
      setRaffleTotals({
        participants: data.totalParticipants ?? 0,
        coupons: data.totalCoupons ?? 0
      });
      setNotice("Sorteo realizado correctamente.");
    } catch (err) {
      setError(err.message);
    } finally {
      setShowDrawConfirm(false);
      setRafflePreparing(false);
    }
  }

  const adminModules = [
    {
      id: "register",
      icon: <BadgePlus />,
      title: "Registrar compra",
      text: "Cargar cliente y generar cupon manualmente.",
      metric: stats?.lastCoupon?.coupon_code ?? "-----"
    },
    {
      id: "coupons",
      icon: <ClipboardList />,
      title: "Participantes",
      text: "Consultar, buscar y auditar cupones registrados.",
      metric: stats?.totalCoupons ?? 0
    },
    {
      id: "raffle",
      icon: <ImagePlus />,
      title: "Detalles del sorteo",
      text: "Definir premio, fecha, loteria, hora e imagen.",
      metric: raffle.prize || "Moto"
    },
    {
      id: "draw",
      icon: <Sparkles />,
      title: "Realizar sorteo",
      text: "Preparar participantes y elegir ganador local.",
      metric: `${raffleTotals.participants} participantes`
    },
    {
      id: "settings",
      icon: <Settings />,
      title: "Formato del cupón",
      text: "Mantener la numeración alineada a Super Gana.",
      metric: "4 digitos"
    }
  ];

  const activeTitle =
    activeModule === "home"
      ? "Centro de control"
      : adminModules.find((module) => module.id === activeModule)?.title ?? "Administracion";

  return (
    <main className="adminShell">
      <aside className="adminSidebar">
        <a className="sidebarHome" href="/">
          <Home size={18} />
          Inicio cliente
        </a>
        <button className="sidebarHome" onClick={logout} type="button">
          <LogOut size={18} />
          Cerrar sesión
        </button>
        <div className="brand">
          <img className="brandImage" src={logoSrc} alt="Santo Cristo Purificadora de Agua" />
          <div>
            <p>Purificadora</p>
            <h1>Santo Cristo</h1>
          </div>
        </div>

        <nav className="moduleNav" aria-label="Modulos administrativos">
          <button className={activeModule === "home" ? "active" : ""} onClick={() => setActiveModule("home")} type="button">
            <Home size={18} />
            Inicio
          </button>
          {adminModules.map((module) => (
            <button
              className={activeModule === module.id ? "active" : ""}
              key={module.id}
              onClick={() => setActiveModule(module.id)}
              type="button"
            >
              {React.cloneElement(module.icon, { size: 18 })}
              {module.title}
            </button>
          ))}
        </nav>
      </aside>

      <section className="adminWorkspace">
        <header className="adminTopbar">
          <div>
            <p className="eyebrow">Administracion</p>
            <h2>{activeTitle}</h2>
          </div>
          <div className="adminStatus">
            <span>{stats?.totalCoupons ?? 0} cupones</span>
            <span>{stats?.totalCustomers ?? 0} clientes</span>
          </div>
        </header>

        {(notice || error) && (
          <div className={error ? "alert error" : "alert"}>
            {error || notice}
          </div>
        )}

        {activeModule === "home" && (
          <>
            <section className="executiveHero">
              <div>
                <p className="eyebrow">Panel Santo Cristo</p>
                <h3>Dashboard Purificadora</h3>
                <p>
                  Organiza registros, participantes y detalles del sorteo con una vista
                  limpia, pensada para el trabajo diario de la purificadora.
                </p>
              </div>
              <div className="executiveStats">
                <Stat icon={<Ticket />} label="Cupones" value={stats?.totalCoupons ?? 0} />
                <Stat icon={<UserRound />} label="Clientes" value={stats?.totalCustomers ?? 0} />
                <Stat icon={<Settings />} label="Digitos" value="4" />
              </div>
            </section>

            <section className="moduleGrid">
              {adminModules.map((module) => (
                <button className="moduleCard" key={module.id} onClick={() => setActiveModule(module.id)} type="button">
                  <span className="moduleIcon">{React.cloneElement(module.icon, { size: 24 })}</span>
                  <strong>{module.title}</strong>
                  <p>{module.text}</p>
                  <small>{module.metric}</small>
                </button>
              ))}
            </section>
          </>
        )}

        {activeModule === "settings" && (
          <section className="adminPanel narrowPanel">
            <div className="formTitle">
              <Settings size={22} />
              <div>
                <h3>Formato Super Gana</h3>
                <p>Los cupones se generan con 4 digitos para coincidir con la loteria.</p>
              </div>
            </div>
            <div className="fixedCouponFormat">
              <strong>0000</strong>
              <span>Cupones nuevos de 4 digitos</span>
            </div>
            <button className="primary submit" onClick={confirmFourDigits} type="button">
              <Settings size={18} />
              Confirmar formato
            </button>
          </section>
        )}

        {activeModule === "raffle" && (
          <section className="raffleSettings">
              <form className="formSurface raffleForm" onSubmit={saveRaffle}>
                <div className="formTitle">
                  <Trophy size={22} />
                  <div>
                    <h3>Detalles del sorteo</h3>
                    <p>Estos datos se muestran al cliente en la pantalla principal.</p>
                  </div>
                </div>

                <div className="fieldGrid raffleFieldGrid">
                  <Field label="Que se rifa" icon={<Trophy />}>
                    <input
                      value={raffleForm.prize}
                      onChange={(event) => updateRaffleField("prize", event.target.value)}
                      placeholder="Moto"
                      required
                    />
                  </Field>
                  <Field label="Fecha" icon={<CalendarClock />}>
                    <input
                      value={raffleForm.date}
                      onChange={(event) => updateRaffleField("date", event.target.value)}
                      type="date"
                    />
                  </Field>
                  <Field label="Hora" icon={<CalendarClock />}>
                    <input
                      value={raffleForm.time}
                      onChange={(event) => updateRaffleField("time", event.target.value)}
                      placeholder="10:10 pm"
                    />
                  </Field>
                  <label className="field fileField">
                    <span>
                      <ImagePlus size={16} />
                      Imagen promocional
                    </span>
                  <input
                    accept="image/*"
                    onChange={(event) => {
                      setRaffleImageFile(event.target.files?.[0] ?? null);
                      setError("");
                      setNotice("");
                    }}
                    type="file"
                  />
                  {raffleImageFile && (
                    <small className="fileHint">
                      Se optimizara antes de guardarse.
                    </small>
                  )}
                </label>
                </div>

                <button className="primary submit" disabled={loading} type="submit">
                  <Settings size={18} />
                  {loading ? "Guardando..." : "Guardar sorteo"}
                </button>
              </form>

              <section className="rafflePreview">
                <p className="eyebrow">Vista publica</p>
                {raffle.promoImage ? (
                  <img src={raffle.promoImage} alt="Promocion del sorteo" />
                ) : (
                  <div className="promoPlaceholder">
                    <ImagePlus size={28} />
                  </div>
                )}
                <strong>{raffle.prize || "Moto"}</strong>
                <span>Sorteo local · {raffle.time || "10:10 pm"}</span>
                <small>{formatRaffleDate(raffle.date)}</small>
              </section>
          </section>
        )}

        {activeModule === "draw" && (
          <section className="raffleDrawPanel">
            <div className="formTitle">
              <Sparkles size={22} />
              <div>
                <h3>Realizar sorteo local</h3>
                <p>Prepara la lista y selecciona un ganador al instante.</p>
              </div>
            </div>

            <div className="raffleActions">
              <button className="primary" onClick={prepareRaffle} type="button" disabled={rafflePreparing}>
                {rafflePreparing ? "Preparando..." : "Preparar sorteo"}
              </button>
              <button
                className="primary danger"
                onClick={() => setShowDrawConfirm(true)}
                type="button"
                disabled={rafflePreparing || raffleParticipants.length === 0}
              >
                Realizar sorteo
              </button>
            </div>

            {showDrawConfirm && (
              <div className="raffleConfirm">
                <p>Confirma que deseas realizar el sorteo local ahora.</p>
                <div className="confirmActions">
                  <button className="primary" onClick={drawRaffle} type="button" disabled={rafflePreparing}>
                    Confirmar sorteo
                  </button>
                  <button className="ghostButton" onClick={() => setShowDrawConfirm(false)} type="button">
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            <div className="raffleStatsRow">
              <span>{raffleTotals.participants} participantes, {raffleTotals.coupons} cupones</span>
            </div>

            {raffleSelection && (
              <div className="raffleSelection">
                <p className="eyebrow">Seleccion propuesta</p>
                <strong>{raffleSelection.first_name} {raffleSelection.last_name}</strong>
                <span>Cedula: {raffleSelection.national_id}</span>
                <small>{raffleSelection.coupon_count} cupones</small>
                <button
                  className="ghostButton"
                  type="button"
                  onClick={() => setRaffleSelection(pickRandomParticipant(raffleParticipants))}
                  disabled={!raffleParticipants.length}
                >
                  Recalcular seleccion
                </button>
              </div>
            )}

            {raffleWinner && (
              <div className="raffleWinner">
                <p className="eyebrow">Ganador</p>
                <strong>{raffleWinner.first_name} {raffleWinner.last_name}</strong>
                <span>Cedula: {raffleWinner.national_id}</span>
                <small>{raffleWinner.coupon_count} cupones</small>
              </div>
            )}

            <div className="raffleParticipants">
              <div className="raffleParticipantsHeader">
                <p className="eyebrow">Participantes</p>
                <span className="raffleMetaInline">
                  {raffleTotals.participants} participantes, {raffleTotals.coupons} cupones
                </span>
              </div>
              {raffleParticipants.length === 0 ? (
                <p className="empty">No hay participantes aun. Prepara el sorteo para verlos.</p>
              ) : (
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Cedula</th>
                        <th>Telefono</th>
                        <th>Cupones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {raffleParticipants.map((participant) => (
                        <tr key={participant.national_id}>
                          <td>{participant.first_name} {participant.last_name}</td>
                          <td>{participant.national_id}</td>
                          <td>{participant.phone}</td>
                          <td className="codeCell">{participant.coupon_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {activeModule === "register" && (
          <div className="contentGrid">
          <form className="formSurface" onSubmit={submitPurchase}>
            <div className="formTitle">
              <BadgePlus size={22} />
              <div>
                <h3>{fullName}</h3>
                <p>Una compra equivale a un cupon.</p>
              </div>
            </div>

            <div className="fieldGrid">
              <Field label="Nombre" icon={<UserRound />}>
                <input
                  value={form.firstName}
                  onChange={(event) => updateField("firstName", event.target.value)}
                  autoComplete="given-name"
                  required
                />
              </Field>
              <Field label="Apellido" icon={<UserRound />}>
                <input
                  value={form.lastName}
                  onChange={(event) => updateField("lastName", event.target.value)}
                  autoComplete="family-name"
                  required
                />
              </Field>
              <Field label="Cedula" icon={<ClipboardList />}>
                <input
                  value={form.nationalId}
                  onChange={(event) => updateField("nationalId", event.target.value)}
                  inputMode="numeric"
                  required
                />
              </Field>
              {customerCouponCount != null && (
                <p className="couponCountHint">{couponCountLabel(customerCouponCount)}</p>
              )}
              <Field label="Telefono" icon={<Phone />}>
                <input
                  value={form.phone}
                  onChange={(event) => updateField("phone", event.target.value)}
                  inputMode="tel"
                  required
                />
              </Field>
              <Field label="Monto" icon={<CircleDollarSign />}>
                <input
                  value={form.purchaseAmount}
                  onChange={(event) => updateField("purchaseAmount", event.target.value)}
                  inputMode="decimal"
                  placeholder="Opcional"
                />
              </Field>
              <Field label="Detalle" icon={<Sparkles />}>
                <input
                  value={form.purchaseNote}
                  onChange={(event) => updateField("purchaseNote", event.target.value)}
                  placeholder="Botellon, caja, recarga..."
                />
              </Field>
            </div>

            <button className="primary submit" disabled={loading} type="submit">
              <Ticket size={18} />
              {loading ? "Registrando..." : "Registrar compra"}
            </button>
          </form>

          <section className="couponPreview">
            {createdCoupon ? (
              <>
                <p className="eyebrow">Cupon generado</p>
                <strong>{createdCoupon.coupon_code}</strong>
                <span>
                  {createdCoupon.first_name} {createdCoupon.last_name}
                </span>
                <small>{formatDate(createdCoupon.created_at)}</small>
              </>
            ) : (
              <>
                <p className="eyebrow">Ultimo cupon</p>
                <strong>{stats?.lastCoupon?.coupon_code ?? "-----"}</strong>
                <span>
                  {stats?.lastCoupon
                    ? `${stats.lastCoupon.first_name} ${stats.lastCoupon.last_name}`
                    : "Aun no hay registros"}
                </span>
                <small>{formatDate(stats?.lastCoupon?.created_at)}</small>
              </>
            )}
          </section>
          </div>
        )}

        {activeModule === "coupons" && (
          <section className="listSurface">
          <div className="listHeader">
            <div>
              <p className="eyebrow">Participantes</p>
              <h2>Cupones registrados</h2>
            </div>
            <label className="searchBox">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre, cedula, telefono o cupon"
              />
            </label>
          </div>

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Cedula</th>
                  <th>Telefono</th>
                  <th>Cupones</th>
                  <th>#</th>
                </tr>
              </thead>
              <tbody>
                {groupedCoupons.map((participant) => (
                  <tr key={participant.national_id}>
                    <td>{participant.first_name} {participant.last_name}</td>
                    <td>{participant.national_id}</td>
                    <td>{participant.phone}</td>
                    <td>
                      <div className="couponBadges">
                        {participant.codes.map((code) => (
                          <span key={code} className="couponBadge">{code}</span>
                        ))}
                      </div>
                    </td>
                    <td className="codeCell">{participant.codes.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {groupedCoupons.length === 0 && <p className="empty">No hay cupones para mostrar.</p>}
          </div>
          </section>
        )}
      </section>
    </main>
  );
}

function Field({ children, icon, label }) {
  return (
    <label className="field">
      <span>
        {React.cloneElement(icon, { size: 16 })}
        {label}
      </span>
      {children}
    </label>
  );
}

function Stat({ icon, label, value }) {
  return (
    <div className="stat">
      {React.cloneElement(icon, { size: 18 })}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
