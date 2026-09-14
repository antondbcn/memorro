// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════════════
import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs,
         addDoc, updateDoc, deleteDoc,
         doc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const INITIAL_INTERVAL_MIN = 720;
const MIN_INTERVAL_MIN     = 2;
const SUCCESS_MULTIPLIER   = 1.8;
const FAILURE_MULTIPLIER   = 0.5;
const DEFAULT_DECK_NAME    = "General";
const LS_CURRENT_DECK_KEY  = "flashcards.currentDeck";
const EVAL_ACCEPT_THRESHOLD = 0.95;  // similitud mínima para "Aceptada"
const EVAL_FAIL_THRESHOLD   = 0.70;  // por debajo de esto, "Equivocada"
const LS_EVAL_MODE_PREFIX   = "flashcards.evalMode.";

// Umbral de auto-eliminación: si el intervalo de una tarjeta supera este
// valor (en minutos), se considera "dominada" y se borra automáticamente
// al calcularse tras un repaso. 10 días = 10 * 24 * 60.
const AUTO_DELETE_INTERVAL_MIN = 10 * 24 * 60;
let TOTAL_SLICES = 0;
let _interval = MIN_INTERVAL_MIN;
while (_interval <= AUTO_DELETE_INTERVAL_MIN) {
  _interval *= SUCCESS_MULTIPLIER;
  TOTAL_SLICES++;
}

const firebaseConfig = {
  apiKey: "AIzaSyBPP1ZdTP6MU5aoLH4AUabX-Fh3JH1_xtA",
  authDomain: "memorro-b4939.firebaseapp.com",
  projectId: "memorro-b4939",
  storageBucket: "memorro-b4939.firebasestorage.app",
  messagingSenderId: "787070583852",
  appId: "1:787070583852:web:3c0d4e1347b4786ddc7d89"
};

// Distancia de Levenshtein estándar (programación dinámica, una fila).
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    const currRow = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,       // borrado
        currRow[j - 1] + 1,   // inserción
        prevRow[j - 1] + cost // sustitución
      );
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

// Normalización acordada: solo trim + colapsar espacios múltiples.
// NO toca mayúsculas, acentos, diéresis ni signos.
function normalizeEvalText(str) {
  return str.trim().replace(/\s+/g, " ");
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: Card
// ═══════════════════════════════════════════════════════════════════════════
class Card {
  /**
   * @param {string}    id
   * @param {string}    front
   * @param {string}    back
   * @param {string}    deck          – nombre de la baraja a la que pertenece
   * @param {number}    interval
   * @param {Date|null} lastReviewed
   * @param {Date|null} createdAt
   */
  constructor(id, front, back, deck, interval = INITIAL_INTERVAL_MIN, lastReviewed = null, createdAt = null) {
    this.id           = id;
    this.front        = front.trim();
    this.back         = back.trim();
    this.deck         = deck;
    this.interval     = Math.max(MIN_INTERVAL_MIN, interval);
    this.lastReviewed = lastReviewed;
    this.createdAt    = createdAt ?? new Date();
  }

  get dueAt() {
    if (!this.lastReviewed) return this.createdAt;
    return new Date(this.lastReviewed.getTime() + this.interval * 60000);
  }

  // Se considera "zombi" (dominada) cuando su intervalo supera el umbral.
  // No se persiste en Firestore: se deduce del intervalo en cada lectura.
  get zombie() {
    return this.interval > AUTO_DELETE_INTERVAL_MIN;
  }

  // Porciones del pastel de progreso: 0 = nueva, 1 = en el mínimo,
  // TOTAL_SLICES = a punto de zombificarse.
  get progressSlices() {
    if (!this.lastReviewed) return 0;

    let clicksRemaining = 0;
    let _interval = this.interval;
    while (_interval <= AUTO_DELETE_INTERVAL_MIN) {
      _interval *= SUCCESS_MULTIPLIER;
      clicksRemaining++;
    }

    const filled = TOTAL_SLICES - clicksRemaining;
    return Math.max(0, Math.min(TOTAL_SLICES, filled));
  }

  toFirestore() {
    return {
      front:        this.front,
      back:         this.back,
      deck:         this.deck,
      interval:     this.interval,
      lastReviewed: this.lastReviewed ? Timestamp.fromDate(this.lastReviewed) : null,
      createdAt:    serverTimestamp(),
    };
  }

  static fromFirestore(snapshot) {
    const d = snapshot.data();
    return new Card(
      snapshot.id,
      d.front ?? "",
      d.back  ?? "",
      d.deck  ?? DEFAULT_DECK_NAME,
      d.interval ?? INITIAL_INTERVAL_MIN,
      d.lastReviewed ? d.lastReviewed.toDate() : null,
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
    await updateDoc(ref, {
      front:        card.front,
      back:         card.back,
      deck:         card.deck,
      interval:     card.interval,
      lastReviewed: card.lastReviewed ? Timestamp.fromDate(card.lastReviewed) : null,
    });
  }

  async remove(cardId) {
    const ref = doc(this._db, this._col.path, cardId);
    await deleteDoc(ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: DeckRepository
// ═══════════════════════════════════════════════════════════════════════════
class DeckRepository {
  constructor(db, collectionName = "decks") {
    this._db  = db;
    this._col = collection(db, collectionName);
  }

  async fetchAll() {
    const snap = await getDocs(this._col);
    return snap.docs.map(d => ({ id: d.id, name: d.data().name }));
  }

  async add(name) {
    const ref = await addDoc(this._col, { name, createdAt: serverTimestamp() });
    return { id: ref.id, name };
  }

  async remove(deckId) {
    const ref = doc(this._db, this._col.path, deckId);
    await deleteDoc(ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: ReviewSession
//
//  Cuatro categorías de tarjetas, en orden de prioridad:
//   1. "ontime"  – dentro de ±10% de su intervalo (ventana de vencimiento)
//   2. "overdue" – vencidas más allá de ese margen
//   3. (no se muestran nunca: las que aún no han llegado a su momento)
//   4. "new"     – nunca repasadas
//
//  Dentro de cada categoría con más de un candidato, la elección es
//  uniformemente aleatoria (no solo entre las "más vencidas").
// ═══════════════════════════════════════════════════════════════════════════
class ReviewSession {
  constructor(cards) {
    this._cards           = [...cards];
    this._current         = null;
    this._currentCategory = null;
  }

  get hasCards() { return this._cards.length > 0; }

  get currentCategory() { return this._currentCategory; }
  get currentCard() { return this._current; }

  pick() {
    if (!this.hasCards) return null;
    const now = new Date();

    const dueEntries = this._cards
      .filter(card => card.lastReviewed)
      .map(card => ({ card, overdueMin: (now - card.dueAt) / 60000 }))
      .filter(entry => entry.overdueMin >= 0);

    if (dueEntries.length > 0) {
      const marginEntries = dueEntries.filter(entry =>
        entry.overdueMin <= Math.max(1, entry.card.interval * 0.1)
      );

      if (marginEntries.length > 0) {
        const chosen = marginEntries[Math.floor(Math.random() * marginEntries.length)];
        this._current         = chosen.card;
        this._currentCategory = "ontime";
        return this._current;
      }

      const chosen = dueEntries[Math.floor(Math.random() * dueEntries.length)];
      this._current         = chosen.card;
      this._currentCategory = "overdue";
      return this._current;
    }

    const newCards = this._cards.filter(card => !card.lastReviewed);
    if (newCards.length > 0) {
      this._current         = newCards[Math.floor(Math.random() * newCards.length)];
      this._currentCategory = "new";
      return this._current;
    }

    this._current         = null;
    this._currentCategory = null;
    return null;
  }

  recordRating(success) {
    const card = this._current;
    if (!card) return null;

    const isNew = !card.lastReviewed;
    if (isNew) {
      card.interval = success ? 1440 : 3;
    } else {
      card.interval = success
        ? card.interval * SUCCESS_MULTIPLIER
        : Math.max(MIN_INTERVAL_MIN, card.interval * FAILURE_MULTIPLIER);
    }
    card.lastReviewed = new Date();
    return card;
  }

  recordRepeat() {
    const card = this._current;
    if (!card) return null;
    if (!card.lastReviewed) card.interval = 60;
    card.lastReviewed = new Date();
    return card;
  }

  updateCards(cards) {
    this._cards = cards;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLASS: App
// ═══════════════════════════════════════════════════════════════════════════
class App {
  constructor(cardRepo, deckRepo) {
    this._cardRepo = cardRepo;
    this._deckRepo = deckRepo;

    this._cards   = [];          // TODAS las tarjetas, de todas las barajas
    this._decks   = [];          // [{id, name}]
    this._currentDeck = null;    // nombre de la baraja activa

    this._session = new ReviewSession([]);
    this._editingCard = null;
    this._evalEvaluated = false; // ¿ya se ha evaluado la tarjeta actual en modo auto?
    this._filterDebounceTimer = null;

    this._bindDOM();
    this._bindEvents();
  }

  // ─── Cachés de elementos DOM ──────────────────────────────────────────
  _bindDOM() {
    this.$views = {
      review     : document.getElementById("view-review"),
      edit       : document.getElementById("view-edit"),
      add        : document.getElementById("view-add"),
      histograma : document.getElementById("view-histograma"),
    };

    // Deck bar
    this.$deckBarBtn   = document.getElementById("deck-bar-btn");
    this.$deckBarName  = document.getElementById("deck-bar-name");

    // Deck modal
    this.$deckModalOverlay = document.getElementById("deck-modal-overlay");
    this.$btnDeckModalClose = document.getElementById("btn-deck-modal-close");
    this.$deckList      = document.getElementById("deck-list");
    this.$deckNewName   = document.getElementById("deck-new-name");
    this.$btnDeckAdd     = document.getElementById("btn-deck-add");
    this.$deckFeedback  = document.getElementById("deck-feedback");

    // Review
    this.$reviewCount   = document.getElementById("review-count");
    this.$cardScene     = document.getElementById("card-scene");
    this.$progressPie = document.getElementById("progress-pie");
    this.$cardFlipper   = document.getElementById("card-flipper");
    this.$cardFrontText = document.getElementById("card-front-text");
    this.$cardBackText  = document.getElementById("card-back-text");
    this.$ratingArea    = document.getElementById("rating-area");
    this.$reviewEmpty   = document.getElementById("review-empty");
    this.$reviewWaiting = document.getElementById("review-waiting");
    this.$reviewLoading = document.getElementById("review-loading");
    this.$evalArea     = document.getElementById("eval-area");
    this.$evalInputWrap = document.getElementById("eval-input-wrap");
    this.$evalInput     = document.getElementById("eval-input");
    this.$evalSubmit    = document.getElementById("eval-submit");

    // Edit
    this.$editCount   = document.getElementById("edit-count");
    this.$searchInput = document.getElementById("search-input");
    this.$cardList    = document.getElementById("card-list");
    this.$editEmpty   = document.getElementById("edit-empty");

    // Histogram
    this.$histogramCount   = document.getElementById("histogram-count");
    this.$histogramChart   = document.getElementById("histogram-chart");
    this.$histogramEmpty   = document.getElementById("histogram-empty");
    this.$histogramHorizon = document.getElementById("histogram-horizon");

    // Add - individual
    this.$addFront      = document.getElementById("add-front");
    this.$addBack       = document.getElementById("add-back");
    this.$addDouble     = document.getElementById("add-double");
    this.$btnAddSave    = document.getElementById("btn-add-save");
    this.$addFeedback   = document.getElementById("add-feedback");

    // Add - tabs
    this.$addTabBtns = document.querySelectorAll(".add-tab-btn");
    this.$addPanels  = document.querySelectorAll(".add-panel");

    // Add - batch
    this.$addBatchText     = document.getElementById("add-batch-text");
    this.$addBatchDouble   = document.getElementById("add-batch-double");
    this.$btnAddBatchSave  = document.getElementById("btn-add-batch-save");
    this.$addBatchFeedback = document.getElementById("add-batch-feedback");

    // Modal (edición de tarjeta)
    this.$modalOverlay    = document.getElementById("modal-overlay");
    this.$editFront       = document.getElementById("edit-front");
    this.$editBack        = document.getElementById("edit-back");
    this.$btnModalClose   = document.getElementById("btn-modal-close");
    this.$btnModalSave    = document.getElementById("btn-modal-save");
    this.$btnModalDelete  = document.getElementById("btn-modal-delete");
    this.$btnModalZombify = document.getElementById("btn-modal-zombify");
    this.$editFeedback    = document.getElementById("edit-feedback");

    // Nav
    this.$navBtns = document.querySelectorAll(".nav-btn");
  }

  // ─── Event listeners ──────────────────────────────────────────────────
  _bindEvents() {
     this.$navBtns.forEach(btn => {
       btn.addEventListener("click", () => {
         if (btn.dataset.action === "edit-current") {
           this._editCurrentReviewCard();
           return;
         }
         this._navigateTo(btn.dataset.view);
       });
     });

    // Deck bar / modal
    this.$btnModalSave.addEventListener("click",   () => this._saveEdit());
    this.$btnModalDelete.addEventListener("click", () => this._deleteCard());
    this.$btnModalZombify.addEventListener("click", () => this._zombifyCard());
    this.$deckBarBtn.addEventListener("click", () => this._openDeckModal());
    this.$btnDeckModalClose.addEventListener("click", () => this._closeDeckModal());
    this.$deckModalOverlay.addEventListener("click", (e) => {
      if (e.target === this.$deckModalOverlay) this._closeDeckModal();
    });
    this.$btnDeckAdd.addEventListener("click", () => this._createDeck());
    this.$deckNewName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._createDeck();
    });

    // Review: voltear
    this.$cardScene.addEventListener("click", () => {
      const mode = this._getEvalMode(this._currentDeck);
      if (mode === "auto") return; // en modo auto no hay volteo por tap
      if (!this.$cardFlipper.classList.contains("flipped")) this._flipCard();
    });

    this.$progressPie.addEventListener("click", (e) => {
  e.stopPropagation(); // que no dispare el flip de la tarjeta
      const card = this._session.currentCard;
      if (!card) return;
      this._editingCard = card;   // _zombifyCard() opera sobre this._editingCard
      this._zombifyCard();
    });

    document.addEventListener("keydown", (e) => {
      const inReviewView = !this.$views.review.classList.contains("hidden");
      const modalsClosed = this.$modalOverlay.classList.contains("hidden")
                        && this.$deckModalOverlay.classList.contains("hidden");
      if (!inReviewView || !modalsClosed) return;

      // NUEVO: si el foco está en un campo de texto, no interpretar teclas como atajos de repaso
      const typingInField = document.activeElement === this.$evalInput
                          || document.activeElement === this.$searchInput
                          || document.activeElement === this.$deckNewName;

      const mode = this._getEvalMode(this._currentDeck);

      if (mode === "auto") {
        if (typingInField) return; // deja que Space/Enter funcionen con normalidad en el input
        if (this._evalEvaluated && e.code === "ArrowRight") {
          e.preventDefault();
          this._advanceEvalReview();
        }
        return; // en modo auto, nada de flip/rating-area por teclado
      }

      // ─── a partir de aquí, comportamiento exactamente igual que hasta ahora (modo self) ───
      const flipped = this.$cardFlipper.classList.contains("flipped");

      if (!flipped && (e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown")) {
        e.preventDefault();
        this._flipCard();
        return;
      }

      if (flipped && !this.$ratingArea.classList.contains("hidden")) {
        if (e.code === "ArrowLeft")  { e.preventDefault(); this._rateCard(false); }
        if (e.code === "ArrowRight") { e.preventDefault(); this._rateCard(true); }
        if (e.code === "ArrowUp")    { e.preventDefault(); this._repeatCard(); }
      }
    });


    document.querySelectorAll(".btn-rating").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.rating === "repeat") this._repeatCard();
        else this._rateCard(btn.dataset.rating === "success");
      });
    });

    //Listeners de evaluación
    this.$evalSubmit.addEventListener("click", () => {
      if (this._evalEvaluated) this._advanceEvalReview();
      else this._evaluateInput();
    });

    this.$evalInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this._evaluateInput();
      }
    });

    this._bindSwipeGesture();

    this.$searchInput.addEventListener("input", () => {
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => this._renderCardList(), 800);
    });

    this.$btnAddSave.addEventListener("click", () => this._addCard());

    this.$addTabBtns.forEach(btn => {
      btn.addEventListener("click", () => this._switchAddTab(btn.dataset.tab));
    });

    this.$btnAddBatchSave.addEventListener("click", () => this._addBatch());

    this.$histogramHorizon.addEventListener("change", () => this._renderHistogram());

    this.$btnModalClose.addEventListener("click", () => this._closeModal());
    this.$modalOverlay.addEventListener("click", (e) => {
      if (e.target === this.$modalOverlay) this._closeModal();
    });

  }

  // ─── Inicialización ───────────────────────────────────────────────────
  async init() {
    try {
      this._decks = await this._deckRepo.fetchAll();

      if (this._decks.length === 0) {
        const deck = await this._deckRepo.add(DEFAULT_DECK_NAME);
        this._decks.push(deck);
      }

      const storedDeck = localStorage.getItem(LS_CURRENT_DECK_KEY);
      this._currentDeck = this._decks.some(d => d.name === storedDeck)
        ? storedDeck
        : this._decks[0].name;
      localStorage.setItem(LS_CURRENT_DECK_KEY, this._currentDeck);

      this._cards = await this._cardRepo.fetchAll();

      this._refreshDeckBar();
      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();
      this._renderReview();
    } catch (err) {
      console.error("Error cargando la app:", err);
    }
  }

  async _zombifyCard() {
    if (!this._editingCard) return;
    if (!confirm(`¿Zombificar "${this._editingCard.front}"? Pasará a considerarse dominada: desaparecerá del repaso, la lista y el histograma, aunque seguirá en Firestore.`)) return;

    const wasCurrentReviewCard = this._session.currentCard?.id === this._editingCard.id;

    this._editingCard.interval     = AUTO_DELETE_INTERVAL_MIN + 1;
    this._editingCard.lastReviewed = new Date();

    try {
      await this._cardRepo.update(this._editingCard);
      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();
      this._closeModal();
      this._renderCardList();
      // Si la tarjeta zombificada era la que se estaba repasando, la vista
      // de Repasar (que sigue detrás del modal) quedaría mostrando una
      // tarjeta ya zombi. Forzamos elegir una nueva.
      if (wasCurrentReviewCard) this._renderReview();
    } catch (err) {
      this._showFeedback(this.$editFeedback, "Error al zombificar.", "error");
      console.error(err);
    }
  }

  // ─── Helpers: tarjetas de la baraja activa ────────────────────────────
  // Todas las tarjetas de la baraja, incluidas las zombis. Se usa
  // únicamente para la comprobación de duplicados al añadir tarjetas.
  _cardsInCurrentDeck() {
    return this._cards.filter(c => c.deck === this._currentDeck);
  }

  // Tarjetas "vivas" de la baraja (excluye zombis). Es lo que se usa en
  // la sesión de repaso, los contadores, la lista de edición y el histograma.
  _activeCardsInCurrentDeck() {
    return this._cardsInCurrentDeck().filter(c => !c.zombie);
  }

  // Clave normalizada para detectar coincidencia total frontal+dorso.
  _cardKey(front, back) {
    return `${front.trim().toLowerCase()}|||${back.trim().toLowerCase()}`;
  }

  _getEvalMode(deckName) {
    const stored = localStorage.getItem(LS_EVAL_MODE_PREFIX + deckName);
    return stored === "self" ? "self" : "auto"; // default: auto
  }

  _setEvalMode(deckName, mode) {
    localStorage.setItem(LS_EVAL_MODE_PREFIX + deckName, mode);
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
    if (viewName === "review") this._renderReview();
    if (viewName === "histograma") this._renderHistogram();
  }

  _updateBadges() {
    const n = this._activeCardsInCurrentDeck().length;
    const label = n === 1 ? "1 tarjeta" : `${n} tarjetas`;
    this.$reviewCount.textContent    = label;
    this.$editCount.textContent      = label;
    this.$histogramCount.textContent = label;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DECK BAR + MODAL
  // ═══════════════════════════════════════════════════════════════════════
  _refreshDeckBar() {
    this.$deckBarName.textContent = this._currentDeck ?? "Baraja";
  }

  _openDeckModal() {
    this._renderDeckList();
    this.$deckNewName.value = "";
    this.$deckFeedback.classList.add("hidden");
    this.$deckModalOverlay.classList.remove("hidden");
  }

  _closeDeckModal() {
    this.$deckModalOverlay.classList.add("hidden");
  }

  _renderDeckList() {
    this.$deckList.innerHTML = "";

    this._decks.forEach(deck => {
      const count       = this._cards.filter(c => c.deck === deck.name).length;
      const zombieCount = this._cards.filter(c => c.deck === deck.name && c.zombie).length;
      const evalMode    = this._getEvalMode(deck.name);
      const isAuto      = evalMode === "auto";

      const item = document.createElement("div");
      item.className = "deck-list-item" + (deck.name === this._currentDeck ? " active" : "");
      item.innerHTML = `
        <span class="deck-list-item-name">${this._esc(deck.name)}</span>
        <span class="deck-list-item-count">${count}</span>
        <label class="toggle-wrap deck-eval-toggle" title="Evaluación automática">          <input type="checkbox" class="deck-eval-checkbox" ${isAuto ? "checked" : ""} />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
        <button class="deck-resurrect-btn" title="Resucitar zombis (${zombieCount})" ${zombieCount === 0 ? "disabled" : ""}>♻️</button>
        <button class="deck-delete-btn" title="Eliminar baraja">✕</button>
      `;

      item.querySelector(".deck-list-item-name").addEventListener("click", () => this._selectDeck(deck.name));
      item.querySelector(".deck-list-item-count").addEventListener("click", () => this._selectDeck(deck.name));

      item.querySelector(".deck-eval-checkbox").addEventListener("click", (e) => {
        e.stopPropagation();
      });
      item.querySelector(".deck-eval-checkbox").addEventListener("change", (e) => {
        this._setEvalMode(deck.name, e.target.checked ? "auto" : "self");
        if (deck.name === this._currentDeck) {
          // si estamos viendo Repasar ahora mismo, refresca para aplicar el nuevo modo
          const activeViewName = Object.entries(this.$views).find(([, el]) => !el.classList.contains("hidden"))?.[0];
          if (activeViewName === "review") this._renderReview();
        }
      });

      item.querySelector(".deck-resurrect-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        this._resurrectZombies(deck);
      });
      item.querySelector(".deck-delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        this._deleteDeck(deck);
      });

      this.$deckList.appendChild(item);
    });
  }

  async _resurrectZombies(deck) {
    const zombies = this._cards.filter(c => c.deck === deck.name && c.zombie);
    if (zombies.length === 0) return;

    const n = zombies.length;
    if (!confirm(`¿Resucitar ${n} tarjeta${n === 1 ? "" : "s"} dominada${n === 1 ? "" : "s"} de "${deck.name}"? Se les aplicará un "no me acuerdo" y volverán a repasarse.`)) return;

    try {
      for (const card of zombies) {
        card.interval     = Math.max(MIN_INTERVAL_MIN, card.interval * FAILURE_MULTIPLIER); // Como si hubiese fallado en un repaso
        card.lastReviewed = new Date();
        await this._cardRepo.update(card);
      }

      if (deck.name === this._currentDeck) {
        this._session.updateCards(this._activeCardsInCurrentDeck());
        this._updateBadges();
      }

      this._renderDeckList();
      this._showFeedback(this.$deckFeedback, `✓ ${n} tarjeta${n === 1 ? "" : "s"} resucitada${n === 1 ? "" : "s"}.`, "success");
    } catch (err) {
      this._showFeedback(this.$deckFeedback, "Error al resucitar zombis.", "error");
      console.error(err);
    }
  }

  _selectDeck(name) {
    this._currentDeck = name;
    localStorage.setItem(LS_CURRENT_DECK_KEY, name);
    this._refreshDeckBar();
    this._session.updateCards(this._activeCardsInCurrentDeck());
    this._updateBadges();
    this._closeDeckModal();

    // Refrescar la vista activa
    const activeViewName = Object.entries(this.$views).find(([, el]) => !el.classList.contains("hidden"))?.[0];
    if (activeViewName === "review") this._renderReview();
    if (activeViewName === "edit") this._renderCardList();
    if (activeViewName === "histograma") this._renderHistogram();
  }

  async _createDeck() {
    const name = this.$deckNewName.value.trim();

    if (!name) {
      this._showFeedback(this.$deckFeedback, "Escribe un nombre para la baraja.", "error");
      return;
    }
    if (this._decks.some(d => d.name.toLowerCase() === name.toLowerCase())) {
      this._showFeedback(this.$deckFeedback, "Ya existe una baraja con ese nombre.", "error");
      return;
    }

    try {
      const deck = await this._deckRepo.add(name);
      this._decks.push(deck);
      this.$deckNewName.value = "";
      this._renderDeckList();
      this._selectDeck(name);
      this._openDeckModal(); // volver a abrir tras seleccionar, para poder seguir gestionando
    } catch (err) {
      this._showFeedback(this.$deckFeedback, "Error al crear la baraja.", "error");
      console.error(err);
    }
  }

  async _deleteDeck(deck) {
    if (this._decks.length <= 1) {
      this._showFeedback(this.$deckFeedback, "No puedes eliminar la única baraja.", "error");
      return;
    }

    const count = this._cards.filter(c => c.deck === deck.name).length;
    const msg = count > 0
      ? `¿Eliminar "${deck.name}" y sus ${count} tarjeta${count === 1 ? "" : "s"}? Esta acción no se puede deshacer.`
      : `¿Eliminar la baraja "${deck.name}"?`;

    if (!confirm(msg)) return;

    try {
      const cardsToDelete = this._cards.filter(c => c.deck === deck.name);
      for (const card of cardsToDelete) {
        await this._cardRepo.remove(card.id);
      }
      await this._deckRepo.remove(deck.id);

      this._cards = this._cards.filter(c => c.deck !== deck.name);
      this._decks = this._decks.filter(d => d.id !== deck.id);

      if (this._currentDeck === deck.name) {
        this._currentDeck = this._decks[0].name;
        localStorage.setItem(LS_CURRENT_DECK_KEY, this._currentDeck);
        this._refreshDeckBar();
      }

      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();
      this._renderDeckList();
    } catch (err) {
      this._showFeedback(this.$deckFeedback, "Error al eliminar la baraja.", "error");
      console.error(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  VIEW: REVIEW
  // ═══════════════════════════════════════════════════════════════════════
  _renderReview() {
    this.$cardFlipper.classList.remove("flipped");
    this.$ratingArea.classList.add("hidden");
    this.$reviewLoading.classList.add("hidden");

    if (!this._session.hasCards) {
      this.$cardScene.classList.add("hidden");
      this.$reviewWaiting.classList.add("hidden");
      this.$reviewEmpty.classList.remove("hidden");
      this._renderProgressPie(null);
      return;
    }

    this.$reviewEmpty.classList.add("hidden");
    const card = this._session.pick();

    if (!card) {
      this.$cardScene.classList.add("hidden");
      this.$reviewWaiting.classList.remove("hidden");
      this._renderProgressPie(null);
      return;
    }

    this.$reviewWaiting.classList.add("hidden");
    this.$cardFrontText.textContent = card.front;
    this.$cardBackText.textContent  = card.back;
     this._renderProgressPie(card);

    // Colorea la tarjeta según la categoría que la ha originado
    this.$cardScene.classList.remove("card-ontime", "card-overdue", "card-new");
    this.$cardScene.classList.add(`card-${this._session.currentCategory}`);

    this.$cardScene.classList.remove("hidden");

    const mode = this._getEvalMode(this._currentDeck);
    this._evalEvaluated = false;

    if (mode === "auto") {
      this.$ratingArea.classList.add("hidden");
      this._renderEvalArea(card);
    } else {
      this.$evalArea.classList.add("hidden");
      // el flujo de flip + rating-area sigue exactamente igual que hasta ahora
    }
  }

  _renderEvalArea(card) {
    this.$cardFrontText.textContent = card.front;
    this.$evalInput.value = "";
    this.$evalInput.disabled = false;
    this.$evalInputWrap.classList.remove("eval-correct", "eval-partial", "eval-wrong");

    this.$evalSubmit.textContent = "✓";
    this.$evalSubmit.classList.remove("eval-submit-next", "eval-correct", "eval-partial", "eval-wrong");
    this.$evalSubmit.setAttribute("aria-label", "Evaluar");
    this.$evalSubmit.classList.remove("hidden");

    this.$evalArea.classList.remove("hidden");
    this.$evalInput.focus();
  }

  _evaluateInput() {
    const card = this._session.currentCard;
    if (!card) return;

    const typed = normalizeEvalText(this.$evalInput.value);
    if (!typed) return; // input vacío: no hace nada, según lo acordado

    const expected = normalizeEvalText(card.back);
    const distance = levenshteinDistance(typed, expected);
    const similarity = expected.length === 0 ? 1 : 1 - (distance / expected.length);

    let resultClass, resultKind;
    if (similarity >= EVAL_ACCEPT_THRESHOLD) {
      resultClass = "eval-correct"; resultKind = "success";
    } else if (similarity < EVAL_FAIL_THRESHOLD) {
      resultClass = "eval-wrong"; resultKind = "fail";
    } else {
      resultClass = "eval-partial"; resultKind = "repeat";
    }

    // Feedback visual: arriba se muestra la solución, abajo lo escrito
    this.$cardFrontText.textContent = card.back;
    this.$evalInputWrap.classList.add(resultClass);
    this.$evalSubmit.classList.add("eval-submit-next", resultClass);
    this.$evalInput.disabled = true;

    this.$evalSubmit.textContent = "→";
    this.$evalSubmit.classList.add("eval-submit-next");
    this.$evalSubmit.setAttribute("aria-label", "Siguiente tarjeta");

    this._evalEvaluated = true;
    this._evalPendingResult = resultKind;
  }

  async _advanceEvalReview() {
    if (this._evalEvaluated && this._evalPendingResult) {
      this.$evalArea.classList.add("hidden");
      this.$cardScene.classList.add("hidden");
      this.$reviewLoading.classList.remove("hidden");

      if (this._evalPendingResult === "repeat") {
        await this._repeatCard();
      } else {
        await this._rateCard(this._evalPendingResult === "success");
      }
      // _rateCard/_repeatCard ya llaman a _renderReview() al final
    } else {
      // no evaluado: se pasa de tarjeta sin tocarla
      this._renderReview();
    }
    this._evalPendingResult = null;
  }

_renderProgressPie(card) {
    if (!card) { this.$progressPie.innerHTML = ""; return; }

    const filled   = card.progressSlices;
    const size     = 34, cx = size / 2, cy = size / 2, r = size / 2 - 2;
    const gap      = 0.06; // radianes entre porciones
    const anglePer = (Math.PI * 2) / TOTAL_SLICES;

    let paths = "";
    for (let i = 0; i < TOTAL_SLICES; i++) {
      const a0 = -Math.PI / 2 + i * anglePer + gap / 2;
      const a1 = -Math.PI / 2 + (i + 1) * anglePer - gap / 2;
      const x1 = (cx + r * Math.cos(a0)).toFixed(2);
      const y1 = (cy + r * Math.sin(a0)).toFixed(2);
      const x2 = (cx + r * Math.cos(a1)).toFixed(2);
      const y2 = (cy + r * Math.sin(a1)).toFixed(2);
      const cls = i < filled ? "pie-slice filled" : "pie-slice";
      paths += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z" class="${cls}"></path>`;
  }

    this.$progressPie.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${paths}</svg>`;
  }

    

  _flipCard() {
    this.$cardFlipper.classList.add("flipped");
    setTimeout(() => this.$ratingArea.classList.remove("hidden"), 300);
  }

  _renderHistogram() {
    const cards = this._activeCardsInCurrentDeck();
    if (cards.length === 0) {
      this.$histogramEmpty.classList.remove("hidden");
      this.$histogramChart.innerHTML = "";
      return;
    }

    const horizonMinutes = Number(this.$histogramHorizon.value || 180);
    const bucketCount = 12;
    const bucketSize = Math.max(15, Math.round(horizonMinutes / bucketCount));
    const now = Date.now();
    const bucketLabels = [];
    const bucketCounts = Array(bucketCount).fill(0);

    for (let i = 0; i < bucketCount; i += 1) {
      const start = i * bucketSize;
      const end = (i + 1) * bucketSize;
      const startLabel = start === 0 ? "Ahora" : `${start}m`;
      const endLabel = end >= 60 ? `${Math.round(end / 60)}h` : `${end}m`;
      bucketLabels.push(`${startLabel}–${endLabel}`);
    }

    const horizonMs = horizonMinutes * 60 * 1000;
    cards.forEach(card => {
      const dueAt = card.dueAt ? card.dueAt.getTime() : card.createdAt.getTime();
      const delta = dueAt - now;
      if (delta >= 0 && delta < horizonMs) {
        const bucketIndex = Math.min(bucketCount - 1, Math.floor(delta / (bucketSize * 60 * 1000)));
        bucketCounts[bucketIndex] += 1;
      }
    });

    const hasAny = bucketCounts.some(c => c > 0);
    if (!hasAny) {
      this.$histogramEmpty.classList.remove("hidden");
      this.$histogramChart.innerHTML = "";
      return;
    }

    this.$histogramEmpty.classList.add("hidden");
    const maxCount = Math.max(...bucketCounts, 1);

    this.$histogramChart.innerHTML = bucketCounts.map((count, index) => {
      const pct = Math.round((count / maxCount) * 100);
      return `
        <div class="histogram-bar-row">
          <span class="histogram-bar-label">${this._esc(bucketLabels[index])}</span>
          <div class="histogram-bar-shell">
            <div class="histogram-bar-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="histogram-bar-value">${count}</span>
        </div>
      `;
    }).join("");
  }

async _rateCard(success) {
    const ratedCard = this._session.recordRating(success);

    this.$ratingArea.classList.add("hidden");
    this.$cardScene.classList.add("hidden");
    this.$reviewLoading.classList.remove("hidden");

    if (ratedCard) {
      try {
        await this._cardRepo.update(ratedCard);
      } catch (err) {
        console.error("Error persistiendo intervalo:", err);
        alert("No se pudo guardar el repaso. Comprueba tu conexión e inténtalo de nuevo.");
      }
      // Si la tarjeta ha entrado en estado zombi (dominada), sale de la
      // sesión de repaso y de los contadores, pero permanece en Firestore
      // para seguir contando en la comprobación de duplicados al añadir.
      if (ratedCard.zombie) {
        this._session.updateCards(this._activeCardsInCurrentDeck());
        this._updateBadges();
      }
    }

    this._renderReview();
  }

  async _repeatCard() {
    const card = this._session.recordRepeat();

    this.$ratingArea.classList.add("hidden");
    this.$cardScene.classList.add("hidden");
    this.$reviewLoading.classList.remove("hidden");

    if (card) {
      try {
        await this._cardRepo.update(card);
      } catch (err) {
        console.error("Error persistiendo repetición:", err);
        alert("No se pudo guardar el repaso. Comprueba tu conexión e inténtalo de nuevo.");
      }
    }

    this._renderReview();
  }

  _bindSwipeGesture() {
    const SWIPE_THRESHOLD  = 80;
    const TILT_FACTOR      = 20;
    const VSWIPE_THRESHOLD = 80;

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
          const mode = this._getEvalMode(this._currentDeck);
          if (mode === "auto") {
            if (dx > 0) this._advanceEvalReview(); // solo derecha avanza en modo auto
          } else {
            this._rateCard(dx > 0);
          }
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
    const inDeck  = this._activeCardsInCurrentDeck();
    const visible = filter ? inDeck.filter(c => c.matches(filter)) : inDeck;

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
  //  MODAL: Edit / Delete card
  // ═══════════════════════════════════════════════════════════════════════
  _editCurrentReviewCard() {
    const card = this._session.currentCard;
    if (!card) {
      alert("No hay ninguna tarjeta visible en Repasar para editar.");
      return;
    }
    this._openModal(card);
  }

  _openModal(card) {
    this._editingCard     = card;
    this.$editFront.value = card.front;
    this.$editBack.value  = card.back;
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
      await this._cardRepo.update(this._editingCard);
      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();

      // Si la tarjeta editada es la que se está mostrando en Repasar,
      // sincroniza el texto visible sin relanzar _renderReview (evita
      // que se voltee o se elija otra tarjeta de golpe).
      if (this._session.currentCard && this._session.currentCard.id === this._editingCard.id) {
        this.$cardFrontText.textContent = this._editingCard.front;
        this.$cardBackText.textContent  = this._editingCard.back;
      }

      this._closeModal();
      this._renderCardList();
    } catch (err) {
      this._showFeedback(this.$editFeedback, "Error al guardar. Inténtalo de nuevo.", "error");
      console.error(err);
    }
  }

  async _deleteCard() {
    if (!confirm(`¿Eliminar la tarjeta "${this._editingCard.front}"?`)) return;

    const wasCurrentReviewCard = this._session.currentCard?.id === this._editingCard.id;

    try {
      await this._cardRepo.remove(this._editingCard.id);
      this._cards = this._cards.filter(c => c.id !== this._editingCard.id);
      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();
      this._closeModal();
      this._renderCardList();
      // La tarjeta eliminada ya no es válida como tarjeta en curso: si era
      // la que se estaba repasando, hay que elegir otra.
      if (wasCurrentReviewCard) this._renderReview();
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

    this._setButtonLoading(this.$btnAddSave, true);
    try {
      const candidates = [{ front, back }];
      if (double) candidates.push({ front: back, back: front });

      const existingKeys = new Set(
        this._cardsInCurrentDeck().map(c => this._cardKey(c.front, c.back))
      );

      let addedCount = 0;
      let duplicateCount = 0;
      for (const cand of candidates) {
        const key = this._cardKey(cand.front, cand.back);
        if (existingKeys.has(key)) { duplicateCount++; continue; }

        const card = new Card("", cand.front, cand.back, this._currentDeck);
        await this._cardRepo.add(card);
        this._cards.push(card);
        existingKeys.add(key);
        addedCount++;
      }

      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();

      this.$addFront.value = "";
      this.$addBack.value  = "";

      let msg;
      let feedbackType;
      if (addedCount === 0) {
        msg = "Ninguna tarjeta añadida (ya existía).";
        feedbackType = "error";
      } else if (addedCount === candidates.length) {
        msg = addedCount === 2
          ? "✓ Dos tarjetas añadidas (frente→dorso y dorso→frente)."
          : "✓ Tarjeta añadida.";
        feedbackType = "success";
      } else {
        msg = "✓ 1 tarjeta añadida (la otra ya existía).";
        feedbackType = "success";
      }
      this._showFeedback(this.$addFeedback, msg, feedbackType);
    } catch (err) {
      this._showFeedback(this.$addFeedback, "Error al añadir la tarjeta.", "error");
      console.error(err);
    } finally {
      this._setButtonLoading(this.$btnAddSave, false);
    }
  }

  _switchAddTab(tabName) {
    this.$addTabBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    this.$addPanels.forEach(panel => panel.classList.toggle("hidden", panel.dataset.panel !== tabName));
  }

  async _addBatch() {
    const lines = this.$addBatchText.value
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const double = this.$addBatchDouble.checked;

    if (lines.length === 0) {
      this._showFeedback(this.$addBatchFeedback, "Pega al menos una línea con formato término;traducción.", "error");
      return;
    }

    const parsed  = [];
    const invalid = [];

    lines.forEach((line, idx) => {
      const parts = line.split(";");
      const front = (parts[0] ?? "").trim();
      const back  = (parts[1] ?? "").trim();

      if (parts.length < 2 || !front || !back) {
        invalid.push(idx + 1);
      } else {
        parsed.push({ front, back });
      }
    });

    if (parsed.length === 0) {
      this._showFeedback(this.$addBatchFeedback, "Ninguna línea tiene el formato correcto (término;traducción).", "error");
      return;
    }

    this._setButtonLoading(this.$btnAddBatchSave, true);
    try {
      const existingKeys = new Set(
        this._cardsInCurrentDeck().map(c => this._cardKey(c.front, c.back))
      );

      let count = 0;
      let duplicates = 0;

      for (const { front, back } of parsed) {
        const candidates = [{ front, back }];
        if (double) candidates.push({ front: back, back: front });

        for (const cand of candidates) {
          const key = this._cardKey(cand.front, cand.back);
          if (existingKeys.has(key)) {
            duplicates++;
            continue;
          }

          const card = new Card("", cand.front, cand.back, this._currentDeck);
          await this._cardRepo.add(card);
          this._cards.push(card);
          existingKeys.add(key);
          count++;
        }
      }

      this._session.updateCards(this._activeCardsInCurrentDeck());
      this._updateBadges();
      this.$addBatchText.value = "";

      let msg = count === 0
        ? "Ninguna tarjeta añadida."
        : `✓ ${count} tarjeta${count === 1 ? "" : "s"} añadida${count === 1 ? "" : "s"}.`;
      if (duplicates > 0) msg += ` Duplicadas ignoradas: ${duplicates}.`;
      if (invalid.length > 0) msg += ` Líneas ignoradas: ${invalid.join(", ")}.`;
      const feedbackType = (count === 0 || invalid.length > 0) ? "error" : "success";
      this._showFeedback(this.$addBatchFeedback, msg, feedbackType);
    } catch (err) {
      this._showFeedback(this.$addBatchFeedback, "Error al añadir el lote.", "error");
      console.error(err);
    } finally {
      this._setButtonLoading(this.$btnAddBatchSave, false);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  _setButtonLoading(btn, loading) {
    btn.disabled = loading;
    btn.classList.toggle("btn-loading", loading);
  }

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
const auth        = getAuth(firebaseApp);
const cardRepo    = new CardRepository(db);
const deckRepo    = new DeckRepository(db);
const app         = new App(cardRepo, deckRepo);

onAuthStateChanged(auth, (user) => {
  if (user) app.init();
});

signInAnonymously(auth).catch(err => console.error("Error de autenticación:", err));
