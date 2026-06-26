// =============================================
//  MEMORRO — app.js
//  Firebase + algoritmo SM-2 simplificado
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// --- CONFIGURACIÓN FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyBPP1ZdTP6MU5aoLH4AUabX-Fh3JH1_xtA",
  authDomain: "memorro-b4939.firebaseapp.com",
  projectId: "memorro-b4939",
  storageBucket: "memorro-b4939.firebasestorage.app",
  messagingSenderId: "787070583852",
  appId: "1:787070583852:web:3c0d4e1347b4786ddc7d89"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const COL = "tarjetas";

// =============================================
//  ALGORITMO SM-2 SIMPLIFICADO
//  calidad: 1=Mal, 2=Regular, 3=Bien, 4=Perfecto
// =============================================
// Calcula el nuevo estado SM-2 a partir de un subobjeto de estado {intervalo, repeticiones, facilidad, ...}
function calcularRepaso(estado, calidad) {
  let { intervalo = 1, repeticiones = 0, facilidad = 2.5 } = estado;

  if (calidad < 2) {
    // Mal: reiniciar
    repeticiones = 0;
    intervalo = 1;
  } else {
    if (repeticiones === 0) intervalo = 1;
    else if (repeticiones === 1) intervalo = 3;
    else intervalo = Math.round(intervalo * facilidad);

    repeticiones += 1;
    facilidad = Math.max(1.3, facilidad + (0.1 - (4 - calidad) * (0.08 + (4 - calidad) * 0.02)));
  }

  const ahora = Date.now();
  const proxima = ahora + intervalo * 24 * 60 * 60 * 1000;

  return { intervalo, repeticiones, facilidad, ultimoRepaso: ahora, proximoRepaso: proxima };
}

// Devuelve el subobjeto SM-2 de una tarjeta para la dirección dada,
// con compatibilidad hacia atrás para tarjetas antiguas (sin fd/df).
function estadoDir(tarjeta, dir) {
  if (tarjeta[dir]) return tarjeta[dir];
  // Tarjeta antigua: usar los campos raíz como estado inicial de fd
  if (dir === "fd") {
    return {
      intervalo:     tarjeta.intervalo     ?? 1,
      repeticiones:  tarjeta.repeticiones  ?? 0,
      facilidad:     tarjeta.facilidad     ?? 2.5,
      ultimoRepaso:  tarjeta.ultimoRepaso  ?? null,
      proximoRepaso: tarjeta.proximoRepaso ?? null,
    };
  }
  // df de tarjeta antigua: empieza desde cero
  return { intervalo: 1, repeticiones: 0, facilidad: 2.5, ultimoRepaso: null, proximoRepaso: null };
}

function esDirDebida(tarjeta, dir) {
  const e = estadoDir(tarjeta, dir);
  if (!e.proximoRepaso) return true;
  return Date.now() >= e.proximoRepaso;
}

function nivelTexto(tarjeta) {
  // Muestra el nivel basado en fd con compatibilidad hacia atrás
  const r = (tarjeta.fd?.repeticiones ?? tarjeta.repeticiones) || 0;
  if (r === 0) return "Nueva";
  if (r === 1) return "Aprendiendo";
  if (r < 4)  return "Progresando";
  return "Dominada";
}

// =============================================
//  ESTADO DE LA APP
// =============================================
let todasTarjetas = [];   // todas las tarjetas de Firestore
let colaRepaso    = [];   // tarjetas debidas hoy
let indiceActual  = 0;
let volteada      = false;
let editandoId    = null; // null = creando nueva
let borrandoId    = null;

// =============================================
//  FIRESTORE: CRUD
// =============================================
async function cargarTarjetas() {
  const q = query(collection(db, COL), orderBy("creadaEn", "asc"));
  const snap = await getDocs(q);
  todasTarjetas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function guardarTarjeta(frente, dorso) {
  const estadoInicial = { intervalo: 1, repeticiones: 0, facilidad: 2.5, ultimoRepaso: null, proximoRepaso: null };
  const nueva = {
    frente, dorso,
    fd: { ...estadoInicial },  // estado SM-2 dirección frente→dorso
    df: { ...estadoInicial },  // estado SM-2 dirección dorso→frente
    creadaEn: Date.now()
  };
  const ref = await addDoc(collection(db, COL), nueva);
  todasTarjetas.push({ id: ref.id, ...nueva });
}

async function actualizarTarjeta(id, datos) {
  await updateDoc(doc(db, COL, id), datos);
  const i = todasTarjetas.findIndex(t => t.id === id);
  if (i !== -1) todasTarjetas[i] = { ...todasTarjetas[i], ...datos };
}

async function eliminarTarjeta(id) {
  await deleteDoc(doc(db, COL, id));
  todasTarjetas = todasTarjetas.filter(t => t.id !== id);
}

// =============================================
//  NAVEGACIÓN ENTRE VISTAS
// =============================================
function mostrarVista(nombre) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  document.getElementById(`view-${nombre}`).classList.add("active");
  document.querySelector(`.nav-btn[data-view="${nombre}"]`)?.classList.add("active");

  if (nombre === "repasar")  iniciarRepaso();
  if (nombre === "tarjetas") renderLista();
  if (nombre === "nueva")    abrirFormulario();
}

// =============================================
//  VISTA: REPASAR
// =============================================
// Mezcla un array de entradas {tarjeta, dir} evitando que dos entradas
// de la misma tarjeta aparezcan seguidas.
function mezclarSinConsecutivos(arr) {
  // Fisher-Yates shuffle
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  // Reordenar para evitar consecutivos con mismo id
  for (let i = 1; i < a.length; i++) {
    if (a[i].tarjeta.id === a[i - 1].tarjeta.id) {
      // Buscar el siguiente elemento con id distinto para intercambiar
      for (let j = i + 1; j < a.length; j++) {
        if (a[j].tarjeta.id !== a[i - 1].tarjeta.id) {
          [a[i], a[j]] = [a[j], a[i]];
          break;
        }
      }
    }
  }
  return a;
}

function iniciarRepaso() {
  // Construir cola bidireccional: una entrada por cada dirección debida
  // Formato de cada entrada: { tarjeta, dir }  donde dir = "fd" | "df"
  const entradas = [];
  for (const t of todasTarjetas) {
    if (esDirDebida(t, "fd")) entradas.push({ tarjeta: t, dir: "fd" });
    if (esDirDebida(t, "df")) entradas.push({ tarjeta: t, dir: "df" });
  }

  // Mezclar evitando que dos entradas de la misma tarjeta queden consecutivas
  colaRepaso = mezclarSinConsecutivos(entradas);
  indiceActual = 0;

  if (colaRepaso.length === 0) {
    document.getElementById("repaso-vacio").style.display = "block";
    document.getElementById("repaso-activo").style.display = "none";
  } else {
    document.getElementById("repaso-vacio").style.display = "none";
    document.getElementById("repaso-activo").style.display = "block";
    mostrarTarjetaActual();
  }
}

function mostrarTarjetaActual() {
  const total = colaRepaso.length;
  const pct   = Math.round((indiceActual / total) * 100);

  document.getElementById("progreso-barra").style.width = pct + "%";
  document.getElementById("progreso-texto").textContent =
    `${indiceActual} de ${total}`;

  const { tarjeta, dir } = colaRepaso[indiceActual];
  const textoFrente = dir === "fd" ? tarjeta.frente : tarjeta.dorso;
  const textoDorso  = dir === "fd" ? tarjeta.dorso  : tarjeta.frente;

  document.getElementById("texto-frente").textContent = textoFrente;
  document.getElementById("texto-dorso").textContent  = textoDorso;

  // Resetear estado visual SIN animación de volteo
  // (se desactiva la transición momentáneamente para evitar el giro involuntario)
  volteada = false;
  const tarjetaEl = document.getElementById("tarjeta");
  tarjetaEl.style.transition = "none";
  tarjetaEl.classList.remove("volteada");
  // Forzar reflow para que el cambio se aplique antes de reactivar la transición
  tarjetaEl.offsetHeight; // eslint-disable-line no-unused-expressions
  tarjetaEl.style.transition = "";

  document.getElementById("btns-calificacion").style.display = "none";
  document.getElementById("btn-voltear").style.display = "inline-block";
}

function voltearTarjeta() {
  volteada = !volteada;
  document.getElementById("tarjeta").classList.toggle("volteada", volteada);
  if (volteada) {
    document.getElementById("btn-voltear").style.display = "none";
    document.getElementById("btns-calificacion").style.display = "flex";
  } else {
    document.getElementById("btn-voltear").style.display = "inline-block";
    document.getElementById("btns-calificacion").style.display = "none";
  }
}

async function calificar(calidad) {
  const { tarjeta, dir } = colaRepaso[indiceActual];
  const estadoActual = estadoDir(tarjeta, dir);
  const nuevoEstado  = calcularRepaso(estadoActual, calidad);

  // Guardar en Firestore solo el subobjeto de la dirección correspondiente
  await actualizarTarjeta(tarjeta.id, { [dir]: nuevoEstado });

  indiceActual++;

  const escena = document.getElementById("tarjeta-escena");

  if (indiceActual >= colaRepaso.length) {
    // Fade out y luego mostrar fin de sesión
    escena.classList.add("fadout");
    setTimeout(() => {
      document.getElementById("progreso-barra").style.width = "100%";
      document.getElementById("progreso-texto").textContent = "¡Sesión completada!";
      escena.style.display = "none";
      document.getElementById("acciones-repaso").style.display = "none";
      const wrap = document.getElementById("repaso-activo");
      const msg  = document.createElement("p");
      msg.className = "vacio-titulo";
      msg.style.marginTop = "2rem";
      msg.textContent = "¡Has repasado todas las tarjetas de hoy!";
      wrap.appendChild(msg);
    }, 200);
  } else {
    // Fade out → actualizar contenido → fade in
    escena.classList.add("fadout");
    setTimeout(() => {
      mostrarTarjetaActual();          // actualiza textos con la tarjeta ya en posición frente
      escena.classList.remove("fadout");
    }, 200);
  }
}

// =============================================
//  VISTA: LISTA
// =============================================
function renderLista(filtro = "") {
  const lista = document.getElementById("lista-tarjetas");
  const vacia = document.getElementById("lista-vacia");
  lista.innerHTML = "";

  const filtradas = filtro
    ? todasTarjetas.filter(t =>
        t.frente.toLowerCase().includes(filtro) ||
        t.dorso.toLowerCase().includes(filtro))
    : todasTarjetas;

  if (filtradas.length === 0) {
    vacia.style.display = "block";
    return;
  }
  vacia.style.display = "none";

  filtradas.forEach(t => {
    const item = document.createElement("div");
    item.className = "item-tarjeta";
    item.innerHTML = `
      <div class="item-textos">
        <div class="item-frente">${escHtml(t.frente)}</div>
        <div class="item-dorso">${escHtml(t.dorso)}</div>
      </div>
      <span class="item-nivel">${nivelTexto(t)}</span>
      <div class="item-acciones">
        <button class="btn-icono editar" data-id="${t.id}">Editar</button>
        <button class="btn-icono eliminar" data-id="${t.id}">Borrar</button>
      </div>
    `;
    lista.appendChild(item);
  });

  lista.querySelectorAll(".btn-icono.editar").forEach(btn =>
    btn.addEventListener("click", () => abrirEdicion(btn.dataset.id)));
  lista.querySelectorAll(".btn-icono.eliminar").forEach(btn =>
    btn.addEventListener("click", () => abrirModal(btn.dataset.id)));
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// =============================================
//  VISTA: FORMULARIO
// =============================================
function abrirFormulario(id = null) {
  editandoId = id;
  document.getElementById("form-titulo").textContent =
    id ? "Editar tarjeta" : "Nueva tarjeta";
  document.getElementById("form-error").textContent = "";

  if (id) {
    const t = todasTarjetas.find(t => t.id === id);
    document.getElementById("input-frente").value = t?.frente || "";
    document.getElementById("input-dorso").value  = t?.dorso  || "";
  } else {
    document.getElementById("input-frente").value = "";
    document.getElementById("input-dorso").value  = "";
  }
}

function abrirEdicion(id) {
  mostrarVista("nueva");
  abrirFormulario(id);
}

async function onGuardar() {
  const frente = document.getElementById("input-frente").value.trim();
  const dorso  = document.getElementById("input-dorso").value.trim();
  const err    = document.getElementById("form-error");

  if (!frente || !dorso) {
    err.textContent = "Rellena los dos campos antes de guardar.";
    return;
  }
  err.textContent = "";

  try {
    if (editandoId) {
      await actualizarTarjeta(editandoId, { frente, dorso });
    } else {
      await guardarTarjeta(frente, dorso);
    }
    mostrarVista("tarjetas");
  } catch (e) {
    err.textContent = "Error al guardar. Comprueba tu conexión.";
    console.error(e);
  }
}

// =============================================
//  MODAL BORRADO
// =============================================
function abrirModal(id) {
  borrandoId = id;
  document.getElementById("modal-overlay").style.display = "flex";
}
function cerrarModal() {
  borrandoId = null;
  document.getElementById("modal-overlay").style.display = "none";
}
async function confirmarBorrado() {
  if (!borrandoId) return;
  try {
    await eliminarTarjeta(borrandoId);
    cerrarModal();
    renderLista(document.getElementById("buscador").value.toLowerCase());
  } catch(e) {
    console.error(e);
    cerrarModal();
  }
}

// =============================================
//  IMPORTACIÓN CSV
//  Formato esperado: dos columnas (frente,dorso)
//  con o sin cabecera, delimitador , o ;
// =============================================

// Normaliza un texto para comparación: minúsculas, sin acentos, sin espacios extra
function normalizar(s) {
  return s.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

// Distancia de Levenshtein (para fuzzy matching)
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similitud(a, b) {
  const na = normalizar(a), nb = normalizar(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Parsea CSV simple (coma o punto y coma, respeta comillas dobles)
function parsearCSV(texto) {
  const sep = texto.includes(";") && !texto.includes(",") ? ";" : ",";
  const lineas = texto.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const filas = [];
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    // Split respetando comillas dobles
    const cols = [];
    let cur = "", dentro = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') { dentro = !dentro; continue; }
      if (c === sep && !dentro) { cols.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    cols.push(cur.trim());
    if (cols.length >= 2) filas.push(cols);
  }
  return filas;
}

// Estado temporal de importación
let pendientesImportar = []; // tarjetas limpias a insertar
let duplicadosFuzzy    = []; // { nueva, existente, sim }

function onArchivoCSV(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ""; // reset para permitir reimportar el mismo fichero

  const reader = new FileReader();
  reader.onload = ev => procesarCSV(ev.target.result);
  reader.readAsText(file, "UTF-8");
}

function procesarCSV(texto) {
  // Quitar BOM si existe
  const contenido = texto.replace(/^\uFEFF/, "");
  const filas = parsearCSV(contenido);

  if (filas.length === 0) {
    mostrarResultadoImport("El fichero está vacío o no tiene el formato correcto.", true);
    return;
  }

  // Detectar si la primera fila es cabecera (ninguna celda coincide con tarjetas existentes
  // y parece texto genérico: "frente","alemán","front","palabra", etc.)
  const palabrasCabecera = ["frente","dorso","front","back","alemán","español",
                            "german","spanish","palabra","traduccion","traducción","question","answer"];
  let inicio = 0;
  const primeraFila0 = normalizar(filas[0][0]);
  if (palabrasCabecera.some(p => primeraFila0.includes(p))) inicio = 1;

  const nuevas = filas.slice(inicio).map(f => ({
    frente: f[0].trim(),
    dorso:  f[1].trim()
  })).filter(t => t.frente && t.dorso);

  if (nuevas.length === 0) {
    mostrarResultadoImport("No se encontraron entradas válidas.", true);
    return;
  }

  // --- DEDUPLICACIÓN ---
  const exactas   = new Set(todasTarjetas.map(t => normalizar(t.frente)));
  pendientesImportar = [];
  duplicadosFuzzy    = [];

  for (const nueva of nuevas) {
    const normNueva = normalizar(nueva.frente);

    // 1. Duplicado exacto → descartar silenciosamente
    if (exactas.has(normNueva)) continue;

    // 2. Fuzzy: buscar la tarjeta existente más parecida
    let maxSim = 0, masParecida = null;
    for (const existente of todasTarjetas) {
      const s = similitud(nueva.frente, existente.frente);
      if (s > maxSim) { maxSim = s; masParecida = existente; }
    }

    if (maxSim >= 0.85 && masParecida) {
      duplicadosFuzzy.push({ nueva, existente: masParecida, sim: maxSim });
    } else {
      pendientesImportar.push(nueva);
    }
  }

  if (duplicadosFuzzy.length > 0) {
    // Mostrar modal de revisión
    mostrarModalDuplicados();
  } else {
    ejecutarImportacion();
  }
}

function mostrarModalDuplicados() {
  const lista = document.getElementById("dup-lista");
  lista.innerHTML = "";
  for (const { nueva, existente } of duplicadosFuzzy) {
    const item = document.createElement("div");
    item.className = "dup-item";
    item.innerHTML = `
      <strong>${escHtml(nueva.frente)}</strong> → ${escHtml(nueva.dorso)}<br>
      <span>Similar a: <em>${escHtml(existente.frente)}</em> → ${escHtml(existente.dorso)}</span>
    `;
    lista.appendChild(item);
  }
  document.getElementById("modal-duplicados").style.display = "flex";
}

async function ejecutarImportacion(incluirFuzzy = false) {
  const aCargear = incluirFuzzy
    ? [...pendientesImportar, ...duplicadosFuzzy.map(d => d.nueva)]
    : pendientesImportar;

  if (aCargear.length === 0) {
    mostrarResultadoImport("No hay tarjetas nuevas que importar.");
    return;
  }

  try {
    for (const t of aCargear) {
      await guardarTarjeta(t.frente, t.dorso);
    }
    const omitidas = duplicadosFuzzy.length - (incluirFuzzy ? 0 : duplicadosFuzzy.length);
    const msg = `✓ ${aCargear.length} tarjeta${aCargear.length !== 1 ? "s" : ""} importada${aCargear.length !== 1 ? "s" : ""}` +
      (omitidas > 0 ? ` · ${omitidas} omitida${omitidas !== 1 ? "s" : ""} por similitud` : "");
    mostrarResultadoImport(msg);
  } catch(e) {
    mostrarResultadoImport("Error al guardar en la base de datos.", true);
    console.error(e);
  }
}

function mostrarResultadoImport(msg, esError = false) {
  const el = document.getElementById("import-resultado");
  el.textContent = msg;
  el.className = "import-resultado" + (esError ? " error" : "");
  setTimeout(() => { el.textContent = ""; el.className = "import-resultado"; }, 5000);
}

// =============================================
//  EVENTOS
// =============================================
function bindEventos() {
  // Navegación
  document.querySelectorAll(".nav-btn, [data-view]").forEach(el =>
    el.addEventListener("click", () => {
      const v = el.dataset.view;
      if (v) mostrarVista(v);
    })
  );

  // Voltear (botón y clic en tarjeta)
  document.getElementById("btn-voltear").addEventListener("click", voltearTarjeta);
  document.getElementById("tarjeta-escena").addEventListener("click", voltearTarjeta);

  // Calificar
  document.querySelectorAll(".btn-cal").forEach(btn =>
    btn.addEventListener("click", () => calificar(parseInt(btn.dataset.cal)))
  );

  // Buscador
  document.getElementById("buscador").addEventListener("input", e =>
    renderLista(e.target.value.toLowerCase())
  );

  // Formulario
  document.getElementById("btn-guardar").addEventListener("click", onGuardar);
  document.getElementById("btn-cancelar").addEventListener("click", () =>
    mostrarVista(editandoId ? "tarjetas" : "repasar")
  );

  // Modal borrado
  document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
  document.getElementById("modal-confirmar").addEventListener("click", confirmarBorrado);
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === document.getElementById("modal-overlay")) cerrarModal();
  });

  // Importación CSV
  document.getElementById("btn-importar").addEventListener("click", () =>
    document.getElementById("input-csv").click()
  );
  document.getElementById("input-csv").addEventListener("change", onArchivoCSV);

  // Modal duplicados fuzzy
  document.getElementById("dup-omitir").addEventListener("click", () => {
    document.getElementById("modal-duplicados").style.display = "none";
    ejecutarImportacion(false);
  });
  document.getElementById("dup-incluir").addEventListener("click", () => {
    document.getElementById("modal-duplicados").style.display = "none";
    ejecutarImportacion(true);
  });
  document.getElementById("modal-duplicados").addEventListener("click", e => {
    if (e.target === document.getElementById("modal-duplicados")) {
      document.getElementById("modal-duplicados").style.display = "none";
      ejecutarImportacion(false);
    }
  });
}

// =============================================
//  INICIO
// =============================================
async function init() {
  bindEventos();
  await cargarTarjetas();
  mostrarVista("repasar");
}

init().catch(console.error);