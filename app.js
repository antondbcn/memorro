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

function esDebida(estado) {
  if (!estado.proximoRepaso) return true;
  return Date.now() >= estado.proximoRepaso;
}

function nivelTexto(estado) {
  const r = estado.repeticiones || 0;
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
  const estadoInicial = { intervalo: 1, repeticiones: 0, facilidad: 2.5,
                          ultimoRepaso: null, proximoRepaso: null };
  const nueva = {
    frente, dorso,
    fd: { ...estadoInicial },
    df: { ...estadoInicial },
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
function iniciarRepaso() {
  // Cada tarjeta genera hasta dos items: fd (frente→dorso) y df (dorso→frente)
  const estadoInicial = { intervalo: 1, repeticiones: 0, facilidad: 2.5,
                          ultimoRepaso: null, proximoRepaso: null };
  colaRepaso = [];
  todasTarjetas.forEach(t => {
    const fd = t.fd || { ...estadoInicial };
    const df = t.df || { ...estadoInicial };
    if (esDebida(fd)) colaRepaso.push({ ...t, _dir: "fd", _estado: fd });
    if (esDebida(df)) colaRepaso.push({ ...t, _dir: "df", _estado: df });
  });
  // Mezclar para que no salgan siempre juntas las dos caras de la misma tarjeta
  for (let i = colaRepaso.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colaRepaso[i], colaRepaso[j]] = [colaRepaso[j], colaRepaso[i]];
  }
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

  const t = colaRepaso[indiceActual];
  // fd → pregunta=frente, respuesta=dorso  |  df → pregunta=dorso, respuesta=frente
  const pregunta  = t._dir === "fd" ? t.frente : t.dorso;
  const respuesta = t._dir === "fd" ? t.dorso  : t.frente;
  document.getElementById("texto-frente").textContent = pregunta;
  document.getElementById("texto-dorso").textContent  = respuesta;

  // Resetear estado visual
  volteada = false;
  document.getElementById("tarjeta").classList.remove("volteada");
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
  const t      = colaRepaso[indiceActual];
  const nuevos = calcularRepaso(t._estado, calidad);
  // Actualizar solo el subobjeto correspondiente (fd o df) en Firestore
  await actualizarTarjeta(t.id, { [t._dir]: nuevos });

  indiceActual++;
  if (indiceActual >= colaRepaso.length) {
    // Sesión completada
    document.getElementById("progreso-barra").style.width = "100%";
    document.getElementById("progreso-texto").textContent = "¡Sesión completada!";
    document.getElementById("tarjeta-escena").style.display = "none";
    document.getElementById("acciones-repaso").style.display = "none";

    // Mostrar mensaje
    const wrap = document.getElementById("repaso-activo");
    const msg  = document.createElement("p");
    msg.className = "vacio-titulo";
    msg.style.marginTop = "2rem";
    msg.textContent = "¡Has repasado todas las tarjetas de hoy!";
    wrap.appendChild(msg);
  } else {
    mostrarTarjetaActual();
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
    const estadoInicial = { intervalo: 1, repeticiones: 0, facilidad: 2.5,
                            ultimoRepaso: null, proximoRepaso: null };
    const fd = t.fd || { ...estadoInicial };
    const df = t.df || { ...estadoInicial };
    const nivel = `fd: ${nivelTexto(fd)} · df: ${nivelTexto(df)}`;
    const item = document.createElement("div");
    item.className = "item-tarjeta";
    item.innerHTML = `
      <div class="item-textos">
        <div class="item-frente">${escHtml(t.frente)}</div>
        <div class="item-dorso">${escHtml(t.dorso)}</div>
      </div>
      <span class="item-nivel">${nivel}</span>
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

  // Modal
  document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
  document.getElementById("modal-confirmar").addEventListener("click", confirmarBorrado);
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === document.getElementById("modal-overlay")) cerrarModal();
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
