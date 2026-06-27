// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
//  Sustituye estos valores por los de tu proyecto en Firebase Console.
// ═══════════════════════════════════════════════════════════════════════════
import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs,
         addDoc, updateDoc, deleteDoc,
         doc, serverTimestamp }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
   * @param {string} id       – ID del documento en Firestore (vacío si es nueva)
   * @param {string} front    – Texto del frente
   * @param {string} back     – Texto del dorso
   * @param {Date|null} createdAt
   */
  constructor(id, front, back, createdAt = null) {
    this.id        = id;
    this.front     = front.trim();
    this.back      = back.trim();
    this.createdAt = createdAt ?? new Date();
  }

  /** Datos planos para guardar en Firestore (sin el id) */
  toFirestore() {
    return {
      front:     this.front,
      back:      this.back,
      createdAt: serverTimestamp(),
    };
  }

  /** Construye un Card desde un DocumentSnapshot de Firestore */
  static fromFirestore(snapshot) {
    const d = snapshot.data();
    return new Card(
      snapshot.id,
      d.front  ?? "",
      d.back   ?? "",
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

  /** Actualiza frente y dorso de una tarjeta existente. */
  async update(card) {
    const ref = doc(this._db, this._col.path, card.id);
    await updateDoc(ref, { front: card.front, back: card.back });
  }

  /** Elimina una tarjeta por su id. */
  async remove(cardId) {
    const ref = doc(this._db, this._col.path, cardId);
    await deleteDoc(ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: ReviewSession
//  Controla el flujo de repaso: elegir tarjeta, registrar resultado.
// ═══════════════════════════════════════════════════════════════════════════
class ReviewSession {
  /** @param {Card[]} cards */
  constructor(cards) {
    this._cards   = [...cards];
    this._current = null;
  }

  get hasCards() { return this._cards.length > 0; }

  /** Elige una tarjeta al azar y la devuelve */
  pickRandom() {
    if (!this.hasCards) return null;
    const idx      = Math.floor(Math.random() * this._cards.length);
    this._current  = this._cards[idx];
    return this._current;
  }

  /**
   * Registra la valoración del usuario sobre la tarjeta actual.
   * Por ahora solo devuelve el objeto; aquí se podrá añadir lógica de SM-2 etc.
   * @param {"perfect"|"good"|"ok"|"bad"} rating
   */
  recordRating(rating) {
    return { card: this._current, rating };
  }

  /** Permite actualizar el pool de tarjetas sin crear una sesión nueva */
  updateCards(cards) {
    this._cards = [...cards];
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
    this.$reviewEmpty    = document.getElementById("review-empty");

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
      if (e.code === "Space" || e.code === "Enter") {
        // Solo en la vista de review y si no hay modal abierto
        if (!this.$views.review.classList.contains("hidden") &&
            this.$modalOverlay.classList.contains("hidden") &&
            !this.$cardFlipper.classList.contains("flipped")) {
          e.preventDefault();
          this._flipCard();
        }
      }
    });

    // Review: valorar
    document.querySelectorAll(".btn-rating").forEach(btn => {
      btn.addEventListener("click", () => this._rateCard(btn.dataset.rating));
    });

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
      this.$reviewEmpty.classList.remove("hidden");
      return;
    }

    this.$reviewEmpty.classList.add("hidden");

    const card = this._session.pickRandom();
    this.$cardFrontText.textContent = card.front;
    this.$cardBackText.textContent  = card.back;

    this.$cardScene.classList.remove("hidden");
  }

  _flipCard() {
    this.$cardFlipper.classList.add("flipped");
    // Mostrar valoración tras la animación
    setTimeout(() => this.$ratingArea.classList.remove("hidden"), 300);
  }

  _rateCard(rating) {
    this._session.recordRating(rating);
    // Pequeña pausa visual antes de la siguiente tarjeta
    this.$ratingArea.classList.add("hidden");
    this.$cardScene.classList.add("hidden");
    setTimeout(() => this._renderReview(), 150);
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
