// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
//  Sustituye estos valores por los de tu proyecto en Firebase Console.
// ═══════════════════════════════════════════════════════════════════════════
import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs,
         addDoc, updateDoc, deleteDoc,
         doc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTES DEL ALGORITMO DE REPASO
//  Modelo de curva de olvido por tarjeta: cada tarjeta tiene un intervalo H
//  (en minutos) que se dobla al acertar y se reduce a la mitad al fallar.
// ═══════════════════════════════════════════════════════════════════════════
const INITIAL_INTERVAL_MIN = 720;    // minutos: intervalo inicial de una tarjeta nueva
const MIN_INTERVAL_MIN     = 1;    // minutos: suelo mínimo del intervalo
const SUCCESS_MULTIPLIER   = 2;    // al acertar, el intervalo se multiplica por esto
const FAILURE_MULTIPLIER   = 0.5;  // al fallar, el intervalo se multiplica por esto
const REPEAT_MULTIPLIER = 1; // "repetir": intervalo intacto, solo se reinicia el reloj

const firebaseConfig = {
  apiKey: "AIzaSyBPP1ZdTP6MU5aoLH4AUabX-Fh3JH1_xtA",
  authDomain: "memorro-b4939.firebaseapp.com",
  projectId: "memorro-b4939",
  storageBucket: "memorro-b4939.firebasestorage.app",
  messagingSenderId: "787070583852",
  appId: "1:787070583852:web:3c0d4e1347b4786ddc7d89"
};

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: Card
//  Modelo de datos de una tarjeta. No tiene lógica de UI.
// ═══════════════════════════════════════════════════════════════════════════
class Card {
  /**
   * @param {string}    id        – ID del documento en Firestore (vacío si es nueva)
   * @param {string}    front     – Texto del frente
   * @param {string}    back      – Texto del dorso
   * @param {number}    interval  – Intervalo H en minutos hasta el próximo repaso ideal
   * @param {Date|null} lastReviewed – Fecha del último repaso (null si nunca se ha repasado)
   * @param {Date|null} createdAt
   */
  constructor(id, front, back, interval = INITIAL_INTERVAL_MIN, lastReviewed = null, createdAt = null) {
    this.id           = id;
    this.front        = front.trim();
    this.back         = back.trim();
    this.interval     = Math.max(MIN_INTERVAL_MIN, interval);
    this.lastReviewed = lastReviewed;      // Date | null
    this.createdAt    = createdAt ?? new Date();
  }

  /** Momento en que la tarjeta "vence" (toca repasarla).
   *  Si nunca se ha repasado, está vencida desde su creación. */
  get dueAt() {
    if (!this.lastReviewed) return this.createdAt;
    return new Date(this.lastReviewed.getTime() + this.interval * 60000);
  }

  /** Datos planos para guardar en Firestore (sin el id) */
  toFirestore() {
    return {
      front:        this.front,
      back:         this.back,
      interval:     this.interval,
      lastReviewed: this.lastReviewed ? Timestamp.fromDate(this.lastReviewed) : null,
      createdAt:    serverTimestamp(),
    };
  }

  /** Construye un Card desde un DocumentSnapshot de Firestore */
  static fromFirestore(snapshot) {
    const d = snapshot.data();
    return new Card(
      snapshot.id,
      d.front    ?? "",
      d.back     ?? "",
      d.interval ?? INITIAL_INTERVAL_MIN,
      d.lastReviewed ? d.lastReviewed.toDate() : null,
      d.createdAt?.toDate() ?? null,
    );
  }

  /** Devuelve true si el texto de filtro aparece en frente o dorso */
  matches(filter) {
    const q = filter.toLowerCase();
    return this.front.toLowerCase().includes(q)
        || this.back.toLowerCase().includes(q);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: CardRepository
//  Toda la interacción con Firestore pasa por aquí.
// ═══════════════════════════════════════════════════════════════════════════
class CardRepository {
  /**
   * @param {import("firebase/firestore").Firestore} db
   * @param {string} collectionName
   */
  constructor(db, collectionName = "cards") {
    this._db  = db;
    this._col = collection(db, collectionName);
  }

  /** Carga todas las tarjetas de Firestore → Array<Card> */
  async fetchAll() {
    const snap = await getDocs(this._col);
    return snap.docs.map(Card.fromFirestore);
  }

  /** Guarda una nueva tarjeta. Devuelve la Card con el id asignado. */
  async add(card) {
    const ref = await addDoc(this._col, card.toFirestore());
    card.id = ref.id;
    return card;
  }

  /** Actualiza frente, dorso, intervalo y fecha de último repaso de una tarjeta existente. */
  async update(card) {
    const ref = doc(this._db, this._col.path, card.id);
    await updateDoc(ref, {
      front:        card.front,
      back:         card.back,
      interval:     card.interval,
      lastReviewed: card.lastReviewed ? Timestamp.fromDate(card.lastReviewed) : null,
    });
  }

  /** Elimina una tarjeta por su id. */
  async remove(cardId) {
    const ref = doc(this._db, this._col.path, cardId);
    await deleteDoc(ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: ReviewSession
//  Controla el flujo de repaso: selección por tarjeta más vencida según H.
// ═══════════════════════════════════════════════════════════════════════════
class ReviewSession {
  /** @param {Card[]} cards */
  constructor(cards) {
    this._cards   = [...cards];
    this._current = null;
  }

  get hasCards() { return this._cards.length > 0; }

  /**
   * Elige la tarjeta más vencida (mayor tiempo transcurrido desde que tocaba
   * repasarla). Si varias tarjetas están vencidas por igual (mismo número de
   * minutos completos de retraso — típico al importar varias tarjetas nuevas
   * a la vez), se elige al azar entre ellas. Devuelve null si ninguna tarjeta
   * está vencida todavía.
   */
  pick() {
    if (!this.hasCards) return null;

    const now = new Date();
    const due = this._cards
      .map(card => ({ card, overdueMin: Math.floor((now - card.dueAt) / 60000) }))
      .filter(x => x.overdueMin >= 0);

    if (due.length === 0) {
      this._current = null;
      return null;
    }

    const maxOverdue = Math.max(...due.map(x => x.overdueMin));
    const tied        = due.filter(x => x.overdueMin === maxOverdue);

    this._current = tied[Math.floor(Math.random() * tied.length)].card;
    return this._current;
  }

  /**
   * Registra el resultado del repaso: ajusta el intervalo (×2 si acierto,
   * ÷2 si fallo, con suelo mínimo) y resetea la fecha de último repaso.
   * @param {boolean} success
   * @returns {Card|null} la tarjeta actualizada
   */
  recordRating(success) {
    const card = this._current;
    if (!card) return null;

    card.interval = success
      ? card.interval * SUCCESS_MULTIPLIER
      : Math.max(MIN_INTERVAL_MIN, card.interval * FAILURE_MULTIPLIER);
    card.lastReviewed = new Date();

    return card;
  }

 /**
  * Registra "repetir": el intervalo no cambia, solo se resetea
  * la fecha de último repaso, así que la tarjeta reaparece
  * tras el mismo intervalo que ya tenía.
  */
 recordRepeat() {
   const card = this._current;
   if (!card) return null;

   card.lastReviewed = new Date();
   return card;
 }

  /** Permite actualizar el pool sin crear una sesión nueva */
  updateCards(cards) {
    this._cards = cards;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: App
//  Controlador principal: coordina vistas, repositorio y sesión.
// ═══════════════════════════════════════════════════════════════════════════
class App {
  constructor(repository) {
    this._repo    = repository;
    this._cards   = [];          // caché local
    this._session = new ReviewSession([]);
    this._editingCard = null;    // tarjeta abierta en el modal
    this._filterDebounceTimer = null;

    this._bindDOM();
    this._bindEvents();
  }

  // ─── Cachés de elementos DOM ──────────────────────────────────────────
  _bindDOM() {
    // Views
    this.$views = {
      review : document.getElementById("view-review"),
      edit   : document.getElementById("view-edit"),
      add    : document.getElementById("view-add"),
    };

    // Review
    this.$reviewCount    = document.getElementById("review-count");
    this.$cardScene      = document.getElementById("card-scene");
    this.$cardFlipper    = document.getElementById("card-flipper");
    this.$cardFrontText  = document.getElementById("card-front-text");
    this.$cardBackText   = document.getElementById("card-back-text");
    this.$ratingArea     = document.getElementById("rating-area");
    this.$btnRepeat      = document.querySelector('.btn-rating[data-rating="repeat"]');
    this.$reviewEmpty    = document.getElementById("review-empty");
    this.$reviewWaiting  = document.getElementById("review-waiting");

    // Edit
    this.$editCount      = document.getElementById("edit-count");
    this.$searchInput    = document.getElementById("search-input");
    this.$cardList       = document.getElementById("card-list");
    this.$editEmpty      = document.getElementById("edit-empty");

    // Add
    this.$addFront       = document.getElementById("add-front");
    this.$addBack        = document.getElementById("add-back");
    this.$addDouble      = document.getElementById("add-double");
    this.$btnAddSave     = document.getElementById("btn-add-save");
    this.$addFeedback    = document.getElementById("add-feedback");

    // Modal
    this.$modalOverlay   = document.getElementById("modal-overlay");
    this.$editFront      = document.getElementById("edit-front");
    this.$editBack       = document.getElementById("edit-back");
    this.$btnModalClose  = document.getElementById("btn-modal-close");
    this.$btnModalSave   = document.getElementById("btn-modal-save");
    this.$btnModalDelete = document.getElementById("btn-modal-delete");
    this.$editFeedback   = document.getElementById("edit-feedback");

    // Nav
    this.$navBtns = document.querySelectorAll(".nav-btn");
  }

  // ─── Event listeners ──────────────────────────────────────────────────
  _bindEvents() {
    // Navegación
    this.$navBtns.forEach(btn => {
      btn.addEventListener("click", () => this._navigateTo(btn.dataset.view));
    });

    // Review: voltear con clic en tarjeta o teclado
    this.$cardScene.addEventListener("click", () => {
      if (!this.$cardFlipper.classList.contains("flipped")) this._flipCard();
    });

    document.addEventListener("keydown", (e) => {
      const inReviewView = !this.$views.review.classList.contains("hidden");
      const modalClosed = this.$modalOverlay.classList.contains("hidden");
      if (!inReviewView || !modalClosed) return;

      const flipped = this.$cardFlipper.classList.contains("flipped");

      // Voltear: solo si aún no está resuelta
      if (!flipped && (e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown")) {
        e.preventDefault();
        this._flipCard();
        return;
      }

      // Valorar/repetir: solo si ya está volteada
      if (flipped && !this.$ratingArea.classList.contains("hidden")) {
        if (e.code === "ArrowLeft")  { e.preventDefault(); this._rateCard(false); }
        if (e.code === "ArrowRight") { e.preventDefault(); this._rateCard(true); }
        if (e.code === "ArrowUp")    { e.preventDefault(); this._repeatCard(); }
      }
    });

      
    // Review: valorar (acierto/fallo/repetir)
    document.querySelectorAll(".btn-rating").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.rating === "repeat") {
          this._repeatCard();
        } else {
          this._rateCard(btn.dataset.rating === "success");
        }
      });
    });

    // Review: valorar mediante swipe (móvil) — derecha = acierto, izquierda = fallo
    this._bindSwipeGesture();

    // Edit: filtro con debounce
    this.$searchInput.addEventListener("input", () => {
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => this._renderCardList(), 800);
    });

    // Add: guardar
    this.$btnAddSave.addEventListener("click", () => this._addCard());

    // Modal: cerrar
    this.$btnModalClose.addEventListener("click", () => this._closeModal());
    this.$modalOverlay.addEventListener("click", (e) => {
      if (e.target === this.$modalOverlay) this._closeModal();
    });

    // Modal: guardar y eliminar
    this.$btnModalSave.addEventListener("click",   () => this._saveEdit());
    this.$btnModalDelete.addEventListener("click", () => this._deleteCard());
  }

  // ─── Inicialización ───────────────────────────────────────────────────
  async init() {
    try {
      this._cards = await this._repo.fetchAll();
      this._session.updateCards(this._cards);
      this._updateBadges();
      this._renderReview();
    } catch (err) {
      console.error("Error cargando tarjetas:", err);
    }
  }

  // ─── Navegación ───────────────────────────────────────────────────────
  _navigateTo(viewName) {
    // Actualizar nav buttons
    this.$navBtns.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    // Mostrar/ocultar vistas
    Object.entries(this.$views).forEach(([name, el]) => {
      el.classList.toggle("hidden", name !== viewName);
    });

    // Al abrir "edit" renderizamos la lista
    if (viewName === "edit") {
      this.$searchInput.value = "";
      this._renderCardList();
    }

    // Al abrir "review" preparamos la siguiente tarjeta
    if (viewName === "review") {
      this._renderReview();
    }
  }

  // ─── Badges de contador ───────────────────────────────────────────────
  _updateBadges() {
    const n = this._cards.length;
    const label = n === 1 ? "1 tarjeta" : `${n} tarjetas`;
    this.$reviewCount.textContent = label;
    this.$editCount.textContent   = label;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  VIEW: REVIEW
  // ═══════════════════════════════════════════════════════════════════════
  _renderReview() {
    // Resetear estado visual
    this.$cardFlipper.classList.remove("flipped");
    this.$ratingArea.classList.add("hidden");

    if (!this._session.hasCards) {
      this.$cardScene.classList.add("hidden");
      this.$reviewWaiting.classList.add("hidden");
      this.$reviewEmpty.classList.remove("hidden");
      return;
    }

    this.$reviewEmpty.classList.add("hidden");

    const card = this._session.pick();

    if (!card) {
      // Ninguna tarjeta está vencida todavía
      this.$cardScene.classList.add("hidden");
      this.$reviewWaiting.classList.remove("hidden");
      return;
    }

    this.$reviewWaiting.classList.add("hidden");
    this.$cardFrontText.textContent = card.front;
    this.$cardBackText.textContent  = card.back;

    this.$cardScene.classList.remove("hidden");
  }

  _flipCard() {
    this.$cardFlipper.classList.add("flipped");
    // Mostrar valoración tras la animación
    setTimeout(() => this.$ratingArea.classList.remove("hidden"), 300);
  }

  /** @param {boolean} success – true si acierto, false si fallo */
  async _rateCard(success) {
    const ratedCard = this._session.recordRating(success);

    // Persistir el nuevo intervalo en Firestore de forma asíncrona (sin bloquear la UI)
    if (ratedCard) {
      this._repo.update(ratedCard).catch(err =>
        console.error("Error persistiendo intervalo:", err)
      );
    }

    // Pequeña pausa visual antes de la siguiente tarjeta
    this.$ratingArea.classList.add("hidden");
    this.$cardScene.classList.add("hidden");
    setTimeout(() => this._renderReview(), 150);
  }

  async _repeatCard() {
    const card = this._session.recordRepeat();

    if (card) {
      this._repo.update(card).catch(err =>
        console.error("Error persistiendo repetición:", err)
      );
    }

    this.$ratingArea.classList.add("hidden");
    this.$cardScene.classList.add("hidden");
    setTimeout(() => this._renderReview(), 150);
  }

  // ─── Gesto de swipe en la tarjeta volteada ────────────────────────────
  // Derecha = acierto ("right" = correcto), izquierda = fallo, arriba = repetir
_bindSwipeGesture() {
  const SWIPE_THRESHOLD = 80;
  const TILT_FACTOR     = 20;
  const VSWIPE_THRESHOLD = 80; // umbral vertical para "repetir"

  let dragging = false;
  let startX = 0, startY = 0;
  let currentX = 0, currentY = 0;

  const getX = (e) => (e.touches ? e.touches[0].clientX : e.clientX);
  const getY = (e) => (e.touches ? e.touches[0].clientY : e.clientY);

  const canSwipe = () =>
    this.$cardFlipper.classList.contains("flipped") &&
    !this.$ratingArea.classList.contains("hidden");

  const onStart = (e) => {
    if (!canSwipe()) return;
    dragging = true;
    startX = currentX = getX(e);
    startY = currentY = getY(e);
    this.$cardFlipper.style.transition = "none";
  };

  const onMove = (e) => {
    if (!dragging) return;
    currentX = getX(e);
    currentY = getY(e);
    const dx = currentX - startX;
    const dy = currentY - startY;

    this.$cardFlipper.style.transform =
      `translate(${dx}px, ${dy}px) rotate(${dx / TILT_FACTOR}deg) rotateY(180deg)`;

    // Prioridad: si el movimiento vertical hacia arriba es dominante, se marca "repetir"
    const verticalDominant = -dy > Math.abs(dx);

    this.$cardScene.classList.toggle("swipe-success", !verticalDominant && dx >  SWIPE_THRESHOLD * 0.4);
    this.$cardScene.classList.toggle("swipe-fail",    !verticalDominant && dx < -SWIPE_THRESHOLD * 0.4);
    this.$cardScene.classList.toggle("swipe-repeat",   verticalDominant && -dy > VSWIPE_THRESHOLD * 0.4);
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    const dx = currentX - startX;
    const dy = currentY - startY;

    this.$cardFlipper.style.transition = "";
    this.$cardFlipper.style.transform  = "";
    this.$cardScene.classList.remove("swipe-success", "swipe-fail", "swipe-repeat");

    const verticalDominant = -dy > Math.abs(dx);

    if (verticalDominant && -dy > VSWIPE_THRESHOLD) {
      this._repeatCard();
    } else if (!verticalDominant && Math.abs(dx) > SWIPE_THRESHOLD) {
      this._rateCard(dx > 0);
    }
  };

  this.$cardScene.addEventListener("touchstart", onStart, { passive: true });
  this.$cardScene.addEventListener("touchmove",  onMove,  { passive: true });
  this.$cardScene.addEventListener("touchend",   onEnd);

  this.$cardScene.addEventListener("mousedown", onStart);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup",   onEnd);
}

  // ═══════════════════════════════════════════════════════════════════════
  //  VIEW: EDIT
  // ═══════════════════════════════════════════════════════════════════════
  _renderCardList() {
    const filter  = this.$searchInput.value.trim();
    const visible = filter
      ? this._cards.filter(c => c.matches(filter))
      : this._cards;

    this.$cardList.innerHTML = "";

    if (visible.length === 0) {
      this.$editEmpty.classList.remove("hidden");
      return;
    }

    this.$editEmpty.classList.add("hidden");

    visible.forEach(card => {
      const item = document.createElement("div");
      item.className = "card-list-item";
      item.innerHTML = `
        <div class="card-list-front">${this._esc(card.front)}</div>
        <div class="card-list-back">${this._esc(card.back)}</div>
      `;
      item.addEventListener("click", () => this._openModal(card));
      this.$cardList.appendChild(item);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MODAL: Edit / Delete
  // ═══════════════════════════════════════════════════════════════════════
  _openModal(card) {
    this._editingCard         = card;
    this.$editFront.value     = card.front;
    this.$editBack.value      = card.back;
    this.$editFeedback.classList.add("hidden");
    this.$modalOverlay.classList.remove("hidden");
  }

  _closeModal() {
    this.$modalOverlay.classList.add("hidden");
    this._editingCard = null;
  }

  async _saveEdit() {
    const front = this.$editFront.value.trim();
    const back  = this.$editBack.value.trim();

    if (!front || !back) {
      this._showFeedback(this.$editFeedback, "Frente y dorso son obligatorios.", "error");
      return;
    }

    this._editingCard.front = front;
    this._editingCard.back  = back;

    try {
      await this._repo.update(this._editingCard);
      this._session.updateCards(this._cards);
      this._updateBadges();
      this._closeModal();
      this._renderCardList();
    } catch (err) {
      this._showFeedback(this.$editFeedback, "Error al guardar. Inténtalo de nuevo.", "error");
      console.error(err);
    }
  }

  async _deleteCard() {
    if (!confirm(`¿Eliminar la tarjeta "${this._editingCard.front}"?`)) return;

    try {
      await this._repo.remove(this._editingCard.id);
      this._cards = this._cards.filter(c => c.id !== this._editingCard.id);
      this._session.updateCards(this._cards);
      this._updateBadges();
      this._closeModal();
      this._renderCardList();
    } catch (err) {
      this._showFeedback(this.$editFeedback, "Error al eliminar.", "error");
      console.error(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  VIEW: ADD
  // ═══════════════════════════════════════════════════════════════════════
  async _addCard() {
    const front  = this.$addFront.value.trim();
    const back   = this.$addBack.value.trim();
    const double = this.$addDouble.checked;

    if (!front || !back) {
      this._showFeedback(this.$addFeedback, "Frente y dorso son obligatorios.", "error");
      return;
    }

    try {
      const cards = [new Card("", front, back)];
      if (double) cards.push(new Card("", back, front));

      for (const card of cards) {
        await this._repo.add(card);
        this._cards.push(card);
      }

      this._session.updateCards(this._cards);
      this._updateBadges();

      // Limpiar formulario
      this.$addFront.value = "";
      this.$addBack.value  = "";
      this.$addDouble.checked = true;

      const msg = double
        ? "✓ Dos tarjetas añadidas (frente→dorso y dorso→frente)."
        : "✓ Tarjeta añadida.";
      this._showFeedback(this.$addFeedback, msg, "success");

    } catch (err) {
      this._showFeedback(this.$addFeedback, "Error al añadir la tarjeta.", "error");
      console.error(err);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  _showFeedback(el, msg, type) {
    el.textContent = msg;
    el.className   = `form-feedback ${type}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4000);
  }

  /** Escapa HTML para evitar XSS al insertar texto de tarjetas en el DOM */
  _esc(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════
const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);
const repository  = new CardRepository(db);
const app         = new App(repository);

app.init();
