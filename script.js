/* ==========================================================
   Finora – script.js
   Sections: 1 Setup  2 Helpers  3 Storage  4 Theme  5 Rendering
             6 Modal & form  7 Budget  8 Events  9 Start
   One source of truth: state.transactions. Every change saves it,
   then calls renderAll() so the whole UI stays in sync.
   ========================================================== */
(function () {
  'use strict';

  /* ---------- 1. SETUP ---------- */
  const KEYS = {
    transactions: 'finora.transactions',
    budget: 'finora.budget',
    theme: 'finora.theme'
  };
  const DEFAULT_BUDGET = 20000;
  const CHART_COLORS = ['#6d3fd6', '#0ea5e9', '#f59e0b', '#ef4444', '#10b981', '#ec4899',
                        '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#84cc16'];

  const state = {
    transactions: [],
    budget: DEFAULT_BUDGET,
    filter: 'all',      // all | income | expense
    search: '',
    sort: 'newest',     // newest | oldest
    month: '',          // "YYYY-MM" shown in the budget section
    editingId: null,
    pendingDeleteId: null
  };

  // Shortcut for document.getElementById
  const $ = (id) => document.getElementById(id);
  let chart = null;
  let toastTimer = null;

  /* ---------- 2. HELPERS ---------- */
  const rupee0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const rupee2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Indian numbering (₹1,00,000). Shows paise only when needed.
  function formatINR(value) {
    return Number.isInteger(value) ? rupee0.format(value) : rupee2.format(value);
  }

  // Dates are stored as "YYYY-MM-DD" and parsed as local time to avoid timezone shifts.
  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function todayISO() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }

  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function isValidDateString(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
  }

  // Create an element with optional class and text (textContent is safe against HTML injection).
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconSvg(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2500);
  }

  /* ---------- 3. STORAGE ---------- */
  function readStorage(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      showToast('Could not save data. Browser storage may be full or blocked.');
      return false;
    }
  }

  // Keep only well-formed transactions so corrupted saved data can't break the app.
  function loadTransactions() {
    const saved = readStorage(KEYS.transactions);
    if (!Array.isArray(saved)) return [];
    return saved.filter((t) =>
      t && typeof t.id === 'string' && typeof t.name === 'string' &&
      typeof t.amount === 'number' && isFinite(t.amount) && t.amount > 0 &&
      (t.type === 'income' || t.type === 'expense') &&
      typeof t.category === 'string' && isValidDateString(t.date)
    );
  }

  function loadBudget() {
    const saved = readStorage(KEYS.budget);
    return typeof saved === 'number' && isFinite(saved) && saved > 0 ? saved : DEFAULT_BUDGET;
  }

  function saveTransactions() { return writeStorage(KEYS.transactions, state.transactions); }

  /* ---------- 4. THEME ---------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const dark = theme === 'dark';
    $('theme-icon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    $('theme-toggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    writeStorage(KEYS.theme, next);
    renderAnalytics(); // chart colors depend on the theme
  }

  /* ---------- 5. RENDERING ---------- */
  function renderAll() {
    renderSummary();
    renderTable();
    renderAnalytics();
    renderBudget();
  }

  function sumByType(type) {
    return state.transactions.filter((t) => t.type === type).reduce((sum, t) => sum + t.amount, 0);
  }

  function renderSummary() {
    const income = sumByType('income');
    const expense = sumByType('expense');
    $('card-income').textContent = formatINR(income);
    $('card-expense').textContent = formatINR(expense);
    $('card-balance').textContent = formatINR(income - expense);
    $('card-count').textContent = String(state.transactions.length);
  }

  // Applies search + type filter + sort together
  function getVisibleTransactions() {
    const term = state.search.trim().toLowerCase();
    return state.transactions
      .filter((t) => state.filter === 'all' || t.type === state.filter)
      .filter((t) => !term || t.name.toLowerCase().includes(term) || t.category.toLowerCase().includes(term))
      .sort((a, b) => {
        const diff = a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0);
        return state.sort === 'newest' ? -diff : diff;
      });
  }

  function renderTable() {
    const body = $('transactions-body');
    body.replaceChildren();
    const visible = getVisibleTransactions();
    const hasAny = state.transactions.length > 0;

    $('empty-state').hidden = hasAny;
    $('no-results').hidden = !hasAny || visible.length > 0;
    $('table-wrap').hidden = visible.length === 0;

    visible.forEach((t) => {
      const row = el('tr');

      const nameCell = el('td');
      nameCell.appendChild(el('span', 'tx-name', t.name));
      if (t.notes) nameCell.appendChild(el('span', 'tx-notes', t.notes));

      const amountCell = el('td', 'num');
      amountCell.appendChild(el('span', t.type === 'income' ? 'amount-income' : 'amount-expense',
        (t.type === 'income' ? '+' : '−') + formatINR(t.amount)));

      const typeCell = el('td');
      typeCell.appendChild(el('span', 'badge badge-' + t.type, t.type === 'income' ? 'Income' : 'Expense'));

      const actions = el('td', 'num');
      actions.appendChild(actionButton('edit', 'icon-btn', 'Edit ' + t.name, t.id, 'edit'));
      actions.appendChild(actionButton('delete', 'icon-btn danger', 'Delete ' + t.name, t.id, 'trash'));

      row.append(nameCell, el('td', '', t.category), el('td', '', formatDate(t.date)), amountCell, typeCell, actions);
      body.appendChild(row);
    });
  }

  function actionButton(action, className, label, id, icon) {
    const btn = el('button', className);
    btn.type = 'button';
    btn.dataset.action = action;
    btn.dataset.id = id;
    btn.setAttribute('aria-label', label);
    btn.appendChild(iconSvg(icon));
    return btn;
  }

  function getCategoryTotals() {
    const totals = {};
    state.transactions.filter((t) => t.type === 'expense').forEach((t) => {
      totals[t.category] = (totals[t.category] || 0) + t.amount;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }

  function renderAnalytics() {
    const entries = getCategoryTotals();
    const total = entries.reduce((sum, e) => sum + e[1], 0);
    const hasData = entries.length > 0;
    $('analytics-content').hidden = !hasData;
    $('analytics-empty').hidden = hasData;

    const list = $('category-list');
    list.replaceChildren();
    entries.forEach(([category, amount], i) => {
      const percent = (amount / total) * 100;
      const color = CHART_COLORS[i % CHART_COLORS.length];

      const item = el('li');
      const top = el('div', 'category-row-top');
      const name = el('span', 'category-name');
      const swatch = el('span', 'swatch');
      swatch.style.background = color;
      name.append(swatch, document.createTextNode(category));
      top.append(name, el('span', '', `${formatINR(amount)} · ${percent.toFixed(1)}%`));

      const track = el('div', 'mini-track');
      const fill = el('div', 'mini-fill');
      fill.style.width = percent + '%';
      fill.style.background = color;
      track.appendChild(fill);
      item.append(top, track);
      list.appendChild(item);
    });

    drawChart(entries);
  }

  function drawChart(entries) {
    if (chart) { chart.destroy(); chart = null; }
    if (typeof Chart === 'undefined') {       // CDN failed to load
      $('chart-error').hidden = false;
      $('category-chart').parentElement.hidden = true;
      return;
    }
    $('chart-error').hidden = true;
    $('category-chart').parentElement.hidden = false;
    if (entries.length === 0) return;

    const styles = getComputedStyle(document.documentElement);
    chart = new Chart($('category-chart'), {
      type: 'doughnut',
      data: {
        labels: entries.map((e) => e[0]),
        datasets: [{
          data: entries.map((e) => e[1]),
          backgroundColor: entries.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          borderColor: styles.getPropertyValue('--surface').trim(),
          borderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${formatINR(ctx.parsed)}` } }
        }
      }
    });
  }

  /* ---------- 6. MODAL & FORM ---------- */
  const fields = ['name', 'amount', 'type', 'category', 'date'];

  function clearErrors() {
    fields.forEach((f) => {
      $('error-' + f).textContent = '';
      $('field-' + f).removeAttribute('aria-invalid');
    });
  }

  function openModal(transaction) {
    clearErrors();
    state.editingId = transaction ? transaction.id : null;
    $('modal-title').textContent = transaction ? 'Edit transaction' : 'Add transaction';
    $('save-btn').textContent = transaction ? 'Save changes' : 'Save transaction';
    $('field-name').value = transaction ? transaction.name : '';
    $('field-amount').value = transaction ? transaction.amount : '';
    $('field-type').value = transaction ? transaction.type : 'expense';
    $('field-category').value = transaction ? transaction.category : '';
    $('field-date').value = transaction ? transaction.date : todayISO();
    $('field-notes').value = transaction && transaction.notes ? transaction.notes : '';
    $('transaction-modal').showModal();
    $('field-name').focus();
  }

  function closeModal() { $('transaction-modal').close(); }

  // Returns { values } when valid, or { errors } listing messages by field.
  function validateForm() {
    const values = {
      name: $('field-name').value.trim(),
      amount: parseFloat($('field-amount').value),
      type: $('field-type').value,
      category: $('field-category').value,
      date: $('field-date').value,
      notes: $('field-notes').value.trim()
    };
    const errors = {};
    if (!values.name) errors.name = 'Enter a transaction name.';
    if (!isFinite(values.amount) || values.amount <= 0) errors.amount = 'Enter an amount greater than 0.';
    if (values.type !== 'income' && values.type !== 'expense') errors.type = 'Choose income or expense.';
    if (!values.category) errors.category = 'Select a category.';
    if (!isValidDateString(values.date)) errors.date = 'Choose a valid date.';
    return Object.keys(errors).length ? { errors } : { values };
  }

  function handleFormSubmit(event) {
    event.preventDefault();
    clearErrors();
    const result = validateForm();

    if (result.errors) {
      let firstInvalid = null;
      fields.forEach((f) => {
        if (result.errors[f]) {
          $('error-' + f).textContent = result.errors[f];
          $('field-' + f).setAttribute('aria-invalid', 'true');
          firstInvalid = firstInvalid || $('field-' + f);
        }
      });
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const v = result.values;
    const data = {
      name: v.name,
      amount: Math.round(v.amount * 100) / 100,
      type: v.type, category: v.category, date: v.date, notes: v.notes
    };

    if (state.editingId) {
      const index = state.transactions.findIndex((t) => t.id === state.editingId);
      if (index !== -1) state.transactions[index] = Object.assign({}, state.transactions[index], data);
      showToast('Transaction updated');
    } else {
      state.transactions.push(Object.assign({ id: generateId(), createdAt: Date.now() }, data));
      showToast('Transaction added');
    }
    saveTransactions();
    renderAll();
    closeModal();
  }

  function askToDelete(id) {
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    state.pendingDeleteId = id;
    $('confirm-text').textContent = `"${tx.name}" (${formatINR(tx.amount)}) will be removed. This cannot be undone.`;
    $('confirm-dialog').showModal();
  }

  function confirmDelete() {
    state.transactions = state.transactions.filter((t) => t.id !== state.pendingDeleteId);
    state.pendingDeleteId = null;
    saveTransactions();
    renderAll();
    $('confirm-dialog').close();
    showToast('Transaction deleted');
  }

  /* ---------- 7. BUDGET ---------- */
  function currentMonthISO() { return todayISO().slice(0, 7); }

  function renderBudget() {
    // Only expenses whose date falls in the selected month count
    const spent = state.transactions
      .filter((t) => t.type === 'expense' && t.date.startsWith(state.month))
      .reduce((sum, t) => sum + t.amount, 0);
    const remaining = state.budget - spent;
    const percent = (spent / state.budget) * 100;
    const card = $('budget-card');

    $('budget-spent').textContent = formatINR(spent);
    $('budget-remaining').textContent = formatINR(remaining);
    $('budget-percent').textContent = percent.toFixed(1) + '%';
    $('budget-bar').style.width = Math.min(percent, 100) + '%';
    $('budget-progress').setAttribute('aria-valuenow', String(Math.min(Math.round(percent), 100)));
    $('budget-input').value = state.budget;

    card.classList.toggle('is-over', spent > state.budget);
    card.classList.toggle('is-warning', spent <= state.budget && percent >= 80);

    const status = $('budget-status');
    if (spent > state.budget) status.textContent = `You are ${formatINR(spent - state.budget)} over your budget this month.`;
    else if (percent >= 80) status.textContent = 'You have used over 80% of this month\'s budget.';
    else if (spent === 0) status.textContent = 'No expenses recorded for this month yet.';
    else status.textContent = 'You are within budget.';
  }

  function handleBudgetSubmit(event) {
    event.preventDefault();
    const value = parseFloat($('budget-input').value);
    const error = $('budget-error');
    if (!isFinite(value) || value <= 0) {
      error.textContent = 'Enter a budget greater than 0.';
      $('budget-input').setAttribute('aria-invalid', 'true');
      return;
    }
    error.textContent = '';
    $('budget-input').removeAttribute('aria-invalid');
    state.budget = Math.round(value);
    if (writeStorage(KEYS.budget, state.budget)) showToast('Budget saved');
    renderBudget();
  }

  /* ---------- 8. EVENTS (each attached once) ---------- */
  function setupNavHighlight() {
    const links = document.querySelectorAll('.nav .nav-link');
    const setActive = (id) => links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === '#' + id));
    links.forEach((a) => a.addEventListener('click', () => setActive(a.getAttribute('href').slice(1))));

    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-35% 0px -55% 0px' });
    ['dashboard', 'transactions', 'analytics', 'budget'].forEach((id) => observer.observe($(id)));
  }

  function setupEvents() {
    $('theme-toggle').addEventListener('click', toggleTheme);
    $('open-add-modal').addEventListener('click', () => openModal(null));
    $('empty-add-btn').addEventListener('click', () => openModal(null));

    $('transaction-form').addEventListener('submit', handleFormSubmit);
    $('cancel-btn').addEventListener('click', closeModal);
    $('close-modal-btn').addEventListener('click', closeModal);
    // Clicking the dimmed backdrop closes the dialogs
    ['transaction-modal', 'confirm-dialog'].forEach((id) => {
      $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
    });

    $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
    $('confirm-delete').addEventListener('click', confirmDelete);

    // One listener on the table body handles every Edit/Delete button (event delegation)
    $('transactions-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'delete') askToDelete(btn.dataset.id);
      else openModal(state.transactions.find((t) => t.id === btn.dataset.id) || null);
    });

    $('search-input').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
    $('sort-order').addEventListener('change', (e) => { state.sort = e.target.value; renderTable(); });
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        renderTable();
      });
    });

    $('budget-form').addEventListener('submit', handleBudgetSubmit);
    $('budget-month').addEventListener('change', (e) => {
      state.month = e.target.value || currentMonthISO();
      e.target.value = state.month;
      renderBudget();
    });

    setupNavHighlight();
  }

  /* ---------- 9. START ---------- */
  function init() {
    applyTheme(readStorage(KEYS.theme) === 'dark' ? 'dark' : 'light');
    state.transactions = loadTransactions();
    state.budget = loadBudget();
    state.month = currentMonthISO();
    $('budget-month').value = state.month;

    const hour = new Date().getHours();
    $('welcome-text').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const now = new Date();
    $('current-date').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('current-date').setAttribute('datetime', todayISO());

    setupEvents();
    renderAll();
  }

  init();
})();