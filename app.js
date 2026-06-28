// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════════════
import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs,
         addDoc, updateDoc, deleteDoc,
         doc, serverTimestamp }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTES DEL ALGORITMO DE REPASO
// ═══════════════════════════════════════════════════════════════════════════
const COOLDOWN_MAX    = 10;
const PERFECT_RATIO   = 7;
const INITIAL_WEIGHT  = 5;
const RATING_DELTA    = { perfect: 0, good: 1, ok: 2, bad: 3 };

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
// ═══════════════════════════════════════════════════════════════════════════
class Card {
  constructor(id, front, back, weight = INITIAL_WEIGHT, createdAt = null) {
    this.id        = id;
    this.front     = front.trim();
    this.back      = back.trim();
    this.weight    = Math.max(1, weight);
    this.cooldown  = 0;
    this.createdAt = createdAt ?? new Date();
  }

  get isPerfect() { return this.weight === 1; }

  toFirestore() {
    return {
      front:     this.front,
      back:      this.back,
      weight:    this.weight,
      createdAt: serverTimestamp(),
    };
  }

  static fromFirestore(snapshot) {
    const d = snapshot.data();
    return new Card(
      snapshot.id,
      d.front  ?? "",
      d.back   ?? "",
      d.weight ?? INITIAL_WEIGHT,
      d.createdAt?.toDate() ?? null,
    );
  }

  matches(filter) {
    const q = filter.toLowerCase();
    return this.front.toLowerCase().includes(q)
        || this.back.toLowerCase().includes(q);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: CardRepository
// ═══════════════════════════════════════════════════════════════════════════
class CardRepository {
  constructor(db, collectionName = "cards") {
    this._db  = db;
    this._col = collection(db, collectionName);
  }

  async fetchAll() {
    const snap = await getDocs(this._col);
    return snap.docs.map(Card.fromFirestore);
  }

  async add(card) {
    const ref = await addDoc(this._col, card.toFirestore());
    card.id = ref.id;
    return card;
  }

  async update(card) {
    const ref = doc(this._db, this._col.path, card.id);
    await updateDoc(ref, { front: card.front, back: card.back, weight: card.weight });
  }

  async remove(cardId) {
    const ref = doc(this._db, this._col.path, cardId);
    await deleteDoc(ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: ReviewSession
// ═══════════════════════════════════════════════════════════════════════════
class ReviewSession {
  constructor(cards) {
    this._cards   = [...cards];
    this._current = null;
    this._turn    = 0;
  }

  get hasCards() { return this._cards.length > 0; }

  pick() {
    if (!this.hasCards) return null;

    this._cards.forEach(c => { if (c.cooldown > 0) c.cooldown--; });

    const showPerfect = (this._turn % PERFECT_RATIO === 0);
    this._turn++;

    let pool;

    if (showPerfect) {
      pool = this._availablePool(c => c.isPerfect);
      if (pool.length === 0) pool = this._availablePool(c => !c.isPerfect);
    } else {
      pool = this._availablePool(c => !c.isPerfect);
      if (pool.length === 0) pool = this._availablePool(c => c.isPerfect);
    }

    if (pool.length === 0) {
      pool = showPerfect
        ? this._cards.filter(c =>  c.isPerfect)
        : this._cards.filter(c => !c.isPerfect);
      if (pool.length === 0) pool = [...this._cards];
    }

    this._current = this._weightedRandom(pool);
    this._current.cooldown = COOLDOWN_MAX;
    return this._current;
  }

  recordRating(rating) {
    const delta = RATING_DELTA[rating] ?? 0;
    if (this._current && delta > 0) {
      this._current.weight = Math.max(1, this._current.weight + delta);
    }
    return { card: this._current, delta };
  }

  updateCards(cards) {
    const cooldownMap = new Map(this._cards.map(c => [c.id, c.cooldown]));
    this._cards = cards.map(c => {
      c.cooldown = cooldownMap.get(c.id) ?? 0;
      return c;
    });
  }

  _availablePool(predicate) {
    return this._cards.filter(c => predicate(c) && c.cooldown === 0);
  }

  _weightedRandom(pool) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    let r = Math.random() * total;
    for (const card of pool) {
      r -= card.weight;
      if (r <= 0) return card;
    }
    return pool[pool.length - 1];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: App
// ═══════════════════════════════════════════════════════════════════════════
class App {
  constructor(repository) {
    this._repo    = repository;
    this._cards   = [];
    this._session = new ReviewSession([]);
    this._editingCard = null;
    this._filterDebounceTimer = null;

    this._bindDOM();
    this._bindEvents();
  }

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

    // Add – tabs
    this.$addTabs        = document.querySelectorAll(".add-tab");
    this.$formSingle     = document.getElementById("add-form-single");
    this.$formBatch      = document.getElementById("add-form-batch");

    // Add – single
    this.$addFront       = document.getElementById("add-front");
    this.$addBack        = document.getElementById("add-back");
    this.$addDouble      = document.getElementById("add-double");
    this.$btnAddSave     = document.getElementById("btn-add-save");
    this.$addFeedback    = document.getElementById("add-feedback");

    // Add – batch
    this.$batchInput     = document.getElementById("batch-input");
    this.$batchDouble    = document.getElementById("batch-double");
    this.$btnBatchSave   = document.getElementById("btn-batch-save");
    this.$batchFeedback  = document.getElementById("batch-feedback");

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

  _bindEvents() {
    // Navegación
    this.$navBtns.forEach(btn => {
      btn.addEventListener("click", () => this._navigateTo(btn.dataset.view));
    });

    // Add – tab switching
    this.$addTabs.forEach(tab => {
      tab.addEventListener("click", () => this._switchAddTab(tab.dataset.tab));
    });

    // Review: voltear con clic en tarjeta o teclado
    this.$cardScene.addEventListener("click", () => {
      if (!this.$cardFlipper.classList.contains("flipped")) this._flipCard();
    });
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Enter") {
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

    // Add single: guardar
    this.$btnAddSave.addEventListener("click", () => this._addCard());

    // Add batch: guardar
    this.$btnBatchSave.addEventListener("click", () => this._addBatch());

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
    this.$navBtns.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    Object.entries(this.$views).forEach(([name, el]) => {
      el.classList.toggle("hidden", name !== viewName);
    });

    if (viewName === "edit") {
      this.$searchInput.value = "";
      this._renderCardList();
    }

    if (viewName === "review") {
      this._renderReview();
    }
  }

  // ─── Tab switching en vista Añadir ────────────────────────────────────
  _switchAddTab(tabName) {
    this.$addTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
    this.$formSingle.classList.toggle("hidden", tabName !== "single");
    this.$formBatch.classList.toggle("hidden",  tabName !== "batch");
  }

  // ─── Badges ───────────────────────────────────────────────────────────
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
    this.$cardFlipper.classList.remove("flipped");
    this.$ratingArea.classList.add("hidden");

    if (!this._session.hasCards) {
      this.$cardScene.classList.add("hidden");
      this.$reviewEmpty.classList.remove("hidden");
      return;
    }

    this.$reviewEmpty.classList.add("hidden");

    const card = this._session.pick();
    this.$cardFrontText.textContent = card.front;
    this.$cardBackText.textContent  = card.back;

    this.$cardScene.classList.remove("hidden");
  }

  _flipCard() {
    this.$cardFlipper.classList.add("flipped");
    setTimeout(() => this.$ratingArea.classList.remove("hidden"), 300);
  }

  async _rateCard(rating) {
    const card = this._session._current;
    if (card) {
      card.weight = Math.max(1, card.weight - 1);
    }
    const { card: ratedCard } = this._session.recordRating(rating);

    if (ratedCard) {
      this._repo.update(ratedCard).catch(err =>
        console.error("Error persistiendo weight:", err)
      );
    }

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
  //  MODAL
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
  //  VIEW: ADD – SINGLE
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

  // ═══════════════════════════════════════════════════════════════════════
  //  VIEW: ADD – BATCH
  // ═══════════════════════════════════════════════════════════════════════
  async _addBatch() {
    const raw    = this.$batchInput.value;
    const double = this.$batchDouble.checked;

    // Parsear líneas: ignorar vacías y las que no tengan ';'
    const pairs = raw
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.includes(";"))
      .map(line => {
        const idx   = line.indexOf(";");
        const front = line.slice(0, idx).trim();
        const back  = line.slice(idx + 1).trim();
        return { front, back };
      })
      .filter(({ front, back }) => front && back);

    if (pairs.length === 0) {
      this._showFeedback(
        this.$batchFeedback,
        "No se encontraron pares válidos. Usa el formato «término;traducción».",
        "error"
      );
      return;
    }

    // Deshabilitar botón mientras se guardan
    this.$btnBatchSave.disabled = true;
    this.$btnBatchSave.textContent = "Guardando…";

    try {
      let created = 0;
      for (const { front, back } of pairs) {
        const cards = [new Card("", front, back)];
        if (double) cards.push(new Card("", back, front));

        for (const card of cards) {
          await this._repo.add(card);
          this._cards.push(card);
          created++;
        }
      }

      this._session.updateCards(this._cards);
      this._updateBadges();

      this.$batchInput.value = "";

      const msg = `✓ ${created} tarjeta${created !== 1 ? "s" : ""} añadida${created !== 1 ? "s" : ""} (${pairs.length} par${pairs.length !== 1 ? "es" : ""}).`;
      this._showFeedback(this.$batchFeedback, msg, "success");

    } catch (err) {
      this._showFeedback(this.$batchFeedback, "Error al guardar. Inténtalo de nuevo.", "error");
      console.error(err);
    } finally {
      this.$btnBatchSave.disabled = false;
      this.$btnBatchSave.textContent = "Añadir tarjetas";
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  _showFeedback(el, msg, type) {
    el.textContent = msg;
    el.className   = `form-feedback ${type}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4000);
  }

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
