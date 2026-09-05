/* ============================================================
   HOME CASH — lógica do app
   Persistência: localStorage (chave HOMECASH_DB_KEY)
   ============================================================ */

(function () {
  'use strict';

  const HOMECASH_DB_KEY = 'homecash_db_v1';

  const MESES_PT = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

  const CATEGORIAS_RECEITA = ['Salário', 'PIX', 'Freelance', 'Ticket Alimentação', 'Outros'];
  const CATEGORIAS_DESPESA = ['Aluguel', 'Luz', 'Água', 'Internet', 'Mercado', 'Lazer', 'Saúde', 'Transporte', 'Ticket Alimentação', 'Outros'];

  /* ---------------- estado em memória ---------------- */
  let db = loadDB();
  let currentMonthKey = todayMonthKey();
  let extratoFiltro = 'todos';
  let editingTxnId = null;
  let editingItemId = null;
  let itemModalMode = 'add'; // 'add' | 'edit'
  let scannerInstance = null;
  let charts = { rd: null, cat: null };

  /* ================= util ================= */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayMonthKey() { return todayISO().slice(0, 7); }
  function monthKeyFromDate(dateStr) { return (dateStr || todayISO()).slice(0, 7); }

  function shiftMonthKey(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function monthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return MESES_PT[m - 1] + ' / ' + y;
  }

  function formatCurrency(value) {
    const v = Number(value) || 0;
    return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDateBR(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ================= persistência ================= */
  function loadDB() {
    try {
      const raw = localStorage.getItem(HOMECASH_DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignora dados corrompidos */ }
    return { transactions: [], savings: [], lists: [] };
  }
  function saveDB() {
    localStorage.setItem(HOMECASH_DB_KEY, JSON.stringify(db));
  }

  /* ================= cálculos financeiros ================= */
  function txnsOfMonth(monthKey) {
    return db.transactions.filter(t => t.monthKey === monthKey);
  }

  function monthSummary(monthKey) {
    const txns = txnsOfMonth(monthKey);
    const receitaCasa = txns.filter(t => t.type === 'receita' && !t.isTA).reduce((s, t) => s + t.value, 0);
    const despesaCasa = txns.filter(t => t.type === 'despesa' && !t.isTA).reduce((s, t) => s + t.value, 0);
    const taEntrada = txns.filter(t => t.type === 'receita' && t.isTA).reduce((s, t) => s + t.value, 0);
    const taSaida = txns.filter(t => t.type === 'despesa' && t.isTA).reduce((s, t) => s + t.value, 0);
    const poupancaTransferida = db.savings.filter(s => s.monthKey === monthKey).reduce((s, t) => s + t.value, 0);
    const saldoLivre = receitaCasa - despesaCasa - poupancaTransferida;
    return { receitaCasa, despesaCasa, taEntrada, taSaida, poupancaTransferida, saldoLivre };
  }

  function taSaldoTotal() {
    const entradas = db.transactions.filter(t => t.type === 'receita' && t.isTA).reduce((s, t) => s + t.value, 0);
    const saidas = db.transactions.filter(t => t.type === 'despesa' && t.isTA).reduce((s, t) => s + t.value, 0);
    return entradas - saidas;
  }

  function poupancaSaldoTotal() {
    return db.savings.reduce((s, t) => s + t.value, 0);
  }

  function despesasPorCategoria(monthKey) {
    const map = {};
    txnsOfMonth(monthKey).filter(t => t.type === 'despesa' && !t.isTA).forEach(t => {
      map[t.category] = (map[t.category] || 0) + t.value;
    });
    return map;
  }

  function allKnownMonthKeys() {
    const set = new Set([currentMonthKey, todayMonthKey()]);
    db.transactions.forEach(t => set.add(t.monthKey));
    db.savings.forEach(s => set.add(s.monthKey));
    db.lists.forEach(l => set.add(l.monthKey));
    return Array.from(set).sort();
  }

  /* ================= navegação de telas ================= */
  function switchScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    renderAll();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchScreen(btn.dataset.screen));
  });
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => switchScreen(btn.dataset.goto));
  });

  /* ================= modais genéricos ================= */
  function openModal(id) { document.getElementById(id).hidden = false; }
  function closeModal(id) { document.getElementById(id).hidden = true; }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const overlay = e.target.closest('.modal-overlay');
      if (overlay.id === 'modalScanner') stopScanner();
      overlay.hidden = true;
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.id === 'modalScanner') stopScanner();
        overlay.hidden = true;
      }
    });
  });

  /* ================= mês: navegação e seletor ================= */
  document.getElementById('btnMonthPrev').addEventListener('click', () => {
    currentMonthKey = shiftMonthKey(currentMonthKey, -1);
    renderAll();
  });
  document.getElementById('btnMonthNext').addEventListener('click', () => {
    currentMonthKey = shiftMonthKey(currentMonthKey, 1);
    renderAll();
  });
  document.getElementById('btnMonthLabel').addEventListener('click', () => {
    const ul = document.getElementById('listaMeses');
    ul.innerHTML = '';
    allKnownMonthKeys().slice().reverse().forEach(mk => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = monthLabel(mk) + (mk === todayMonthKey() ? ' · hoje' : '');
      b.addEventListener('click', () => {
        currentMonthKey = mk;
        closeModal('modalMes');
        renderAll();
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    openModal('modalMes');
  });

  /* ================= FORM: TRANSAÇÃO ================= */
  const segTipo = document.getElementById('segTipo');
  let tipoAtual = 'receita';

  segTipo.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tipoAtual = btn.dataset.tipo;
      segTipo.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b === btn));
      populateCategorias();
    });
  });

  function populateCategorias() {
    const sel = document.getElementById('fCategoria');
    const lista = tipoAtual === 'receita' ? CATEGORIAS_RECEITA : CATEGORIAS_DESPESA;
    sel.innerHTML = lista.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  document.getElementById('fCategoria').addEventListener('change', (e) => {
    if (e.target.value === 'Ticket Alimentação') {
      document.getElementById('fIsTA').checked = true;
    }
  });

  document.getElementById('btnAdd').addEventListener('click', () => openTransacaoModal());

  function openTransacaoModal(txn) {
    editingTxnId = txn ? txn.id : null;
    document.getElementById('modalTransacaoTitulo').textContent = txn ? 'Editar lançamento' : 'Novo lançamento';
    tipoAtual = txn ? txn.type : 'receita';
    segTipo.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.tipo === tipoAtual));
    populateCategorias();

    document.getElementById('fValor').value = txn ? txn.value : '';
    document.getElementById('fDescricao').value = txn ? txn.description : '';
    document.getElementById('fCategoria').value = txn ? txn.category : CATEGORIAS_RECEITA[0];
    document.getElementById('fData').value = txn ? txn.date : (currentMonthKey === todayMonthKey() ? todayISO() : currentMonthKey + '-01');
    document.getElementById('fIsTA').checked = txn ? !!txn.isTA : false;
    document.getElementById('btnExcluirTransacao').hidden = !txn;
    openModal('modalTransacao');
  }

  document.getElementById('formTransacao').addEventListener('submit', (e) => {
    e.preventDefault();
    const valor = parseFloat(document.getElementById('fValor').value);
    if (!valor || valor <= 0) { toast('Informe um valor válido.'); return; }
    const date = document.getElementById('fData').value || todayISO();

    const txn = {
      id: editingTxnId || uid(),
      monthKey: monthKeyFromDate(date),
      date,
      type: tipoAtual,
      isTA: document.getElementById('fIsTA').checked,
      category: document.getElementById('fCategoria').value,
      description: document.getElementById('fDescricao').value.trim() || document.getElementById('fCategoria').value,
      value: valor
    };

    if (editingTxnId) {
      const idx = db.transactions.findIndex(t => t.id === editingTxnId);
      if (idx >= 0) db.transactions[idx] = txn;
    } else {
      db.transactions.push(txn);
    }
    saveDB();
    closeModal('modalTransacao');
    toast('Lançamento salvo.');
    renderAll();
  });

  document.getElementById('btnExcluirTransacao').addEventListener('click', () => {
    if (!editingTxnId) return;
    if (!confirm('Excluir este lançamento?')) return;
    db.transactions = db.transactions.filter(t => t.id !== editingTxnId);
    saveDB();
    closeModal('modalTransacao');
    toast('Lançamento excluído.');
    renderAll();
  });

  /* ================= FORM: POUPANÇA ================= */
  document.getElementById('btnTransferirPoupanca').addEventListener('click', () => {
    document.getElementById('pValor').value = '';
    document.getElementById('pDescricao').value = '';
    openModal('modalPoupanca');
  });

  document.getElementById('formPoupanca').addEventListener('submit', (e) => {
    e.preventDefault();
    const valor = parseFloat(document.getElementById('pValor').value);
    if (!valor || valor <= 0) { toast('Informe um valor válido.'); return; }
    db.savings.push({
      id: uid(),
      monthKey: currentMonthKey,
      date: todayISO(),
      description: document.getElementById('pDescricao').value.trim() || 'Transferência para poupança',
      value: valor
    });
    saveDB();
    closeModal('modalPoupanca');
    toast('Valor transferido para a poupança.');
    renderAll();
  });

  /* ================= MERCADO: listas ================= */
  function activeListForMonth(monthKey) {
    const listas = db.lists.filter(l => l.monthKey === monthKey);
    return listas.find(l => l.status !== 'finalizada') || null;
  }

  document.getElementById('btnNovaLista').addEventListener('click', abrirModalNovaLista);
  document.querySelector('[data-action="nova-lista"]').addEventListener('click', abrirModalNovaLista);

  function abrirModalNovaLista() {
    document.getElementById('lNome').value = `Lista de Mercado - ${monthLabel(currentMonthKey)}`;
    openModal('modalNovaLista');
  }

  document.getElementById('formNovaLista').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = document.getElementById('lNome').value.trim();
    if (!nome) return;
    db.lists.push({
      id: uid(),
      monthKey: currentMonthKey,
      name: nome,
      status: 'montagem',
      items: [],
      totalValue: 0,
      finalizedDate: null
    });
    saveDB();
    closeModal('modalNovaLista');
    renderMercado();
  });

  document.getElementById('btnFinalizarLista').addEventListener('click', () => {
    const lista = activeListForMonth(currentMonthKey);
    if (!lista) return;
    if (lista.items.length === 0) { toast('Adicione ao menos um item antes de finalizar a lista.'); return; }
    lista.status = 'compra';
    saveDB();
    toast('Lista finalizada. Boas compras!');
    renderMercado();
  });

  document.getElementById('btnAddItem').addEventListener('click', () => abrirModalItem(null, 'montagem'));
  document.getElementById('btnAddItemCompra').addEventListener('click', () => abrirModalItem(null, 'compra'));

  function abrirModalItem(item, modo) {
    itemModalMode = item ? 'edit' : 'add';
    editingItemId = item ? item.id : null;
    document.getElementById('modalItemTitulo').textContent = item ? 'Editar item' : 'Adicionar item';
    document.getElementById('iId').value = item ? item.id : '';
    document.getElementById('iBarcode').value = item ? (item.barcode || '') : '';
    document.getElementById('iNome').value = item ? item.name : '';
    document.getElementById('iMarca').value = item ? (item.brand || '') : '';
    document.getElementById('iQtd').value = item ? item.qty : 1;
    document.getElementById('iPreco').value = item && item.unitPrice ? item.unitPrice : '';
    document.getElementById('campoPreco').hidden = modo !== 'compra';
    document.getElementById('btnExcluirItem').hidden = !item;
    openModal('modalItem');
  }

  document.getElementById('formItem').addEventListener('submit', (e) => {
    e.preventDefault();
    const lista = activeListForMonth(currentMonthKey);
    if (!lista) return;

    const nome = document.getElementById('iNome').value.trim();
    if (!nome) return;
    const qty = parseInt(document.getElementById('iQtd').value, 10) || 1;
    const precoStr = document.getElementById('iPreco').value;
    const unitPrice = precoStr ? parseFloat(precoStr) : 0;
    const barcode = document.getElementById('iBarcode').value || null;

    if (editingItemId) {
      const it = lista.items.find(i => i.id === editingItemId);
      if (it) {
        it.name = nome; it.brand = document.getElementById('iMarca').value.trim();
        it.qty = qty; it.unitPrice = unitPrice;
        if (barcode && !document.getElementById('campoPreco').hidden && unitPrice > 0) it.checked = true;
      }
    } else {
      lista.items.push({
        id: uid(), name: nome, brand: document.getElementById('iMarca').value.trim(),
        qty, unitPrice, checked: (!!barcode && unitPrice > 0), barcode
      });
    }
    saveDB();
    closeModal('modalItem');
    renderMercado();
  });

  document.getElementById('btnExcluirItem').addEventListener('click', () => {
    const lista = activeListForMonth(currentMonthKey);
    if (!lista || !editingItemId) return;
    lista.items = lista.items.filter(i => i.id !== editingItemId);
    saveDB();
    closeModal('modalItem');
    renderMercado();
  });

  document.getElementById('btnFinalizarCompra').addEventListener('click', () => {
    const lista = activeListForMonth(currentMonthKey);
    if (!lista) return;
    const total = lista.items.reduce((s, i) => s + i.qty * (i.unitPrice || 0), 0);
    if (total <= 0) { toast('Informe os preços dos itens antes de finalizar.'); return; }
    if (!confirm(`Finalizar compra no valor de ${formatCurrency(total)}? Isso será lançado como despesa em "Mercado".`)) return;

    lista.status = 'finalizada';
    lista.totalValue = total;
    lista.finalizedDate = todayISO();

    db.transactions.push({
      id: uid(),
      monthKey: lista.monthKey,
      date: todayISO(),
      type: 'despesa',
      isTA: false,
      category: 'Mercado',
      description: lista.name,
      value: total
    });

    saveDB();
    toast('Compra finalizada e lançada no extrato.');
    renderAll();
  });

  /* ---------- scanner de código de barras ---------- */
  document.getElementById('btnScanner').addEventListener('click', () => {
    openModal('modalScanner');
    startScanner();
  });

  function startScanner() {
    const statusEl = document.getElementById('scannerStatus');
    if (typeof Html5Qrcode === 'undefined') {
      statusEl.textContent = 'Leitor de código indisponível offline. Adicione o item manualmente.';
      return;
    }
    statusEl.textContent = 'Aponte a câmera para o código de barras do produto.';
    scannerInstance = new Html5Qrcode('readerScanner');
    scannerInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 140 } },
      (decodedText) => onBarcodeDetected(decodedText),
      () => {}
    ).catch(() => {
      statusEl.textContent = 'Não foi possível acessar a câmera. Verifique as permissões do navegador.';
    });
  }

  function stopScanner() {
    if (scannerInstance) {
      scannerInstance.stop().then(() => scannerInstance.clear()).catch(() => {});
      scannerInstance = null;
    }
  }

  async function onBarcodeDetected(codigo) {
    stopScanner();
    closeModal('modalScanner');
    toast('Código lido: ' + codigo);

    let nome = '', marca = '';
    try {
      const resp = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(codigo)}.json`);
      const data = await resp.json();
      if (data && data.status === 1 && data.product) {
        nome = data.product.product_name || data.product.generic_name || '';
        marca = data.product.brands || '';
      }
    } catch (e) { /* offline ou produto não encontrado — segue com preenchimento manual */ }

    itemModalMode = 'add';
    editingItemId = null;
    document.getElementById('modalItemTitulo').textContent = 'Item escaneado';
    document.getElementById('iId').value = '';
    document.getElementById('iBarcode').value = codigo;
    document.getElementById('iNome').value = nome || '';
    document.getElementById('iMarca').value = marca || '';
    document.getElementById('iQtd').value = 1;
    document.getElementById('iPreco').value = '';
    document.getElementById('campoPreco').hidden = false;
    document.getElementById('btnExcluirItem').hidden = true;
    if (!nome) toast('Produto não encontrado — preencha o nome manualmente.');
    openModal('modalItem');
  }

  /* ================= RENDER: helpers de item de transação ================= */
  function txnRow(t) {
    const li = document.createElement('li');
    li.className = 'txn-item';
    const dotClass = t.isTA ? 'ta' : t.type;
    li.innerHTML = `
      <span class="txn-dot ${dotClass}"></span>
      <span class="txn-main">
        <span class="txn-desc">${escapeHTML(t.description)}</span>
        <span class="txn-meta">${t.category}${t.isTA ? ' · TA' : ''} · ${formatDateBR(t.date)}</span>
      </span>
      <span class="txn-value ${t.type}">${t.type === 'receita' ? '+' : '–'} ${formatCurrency(t.value)}</span>
    `;
    li.addEventListener('click', () => openTransacaoModal(t));
    return li;
  }

  function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
  }

  /* ================= RENDER: dashboard ================= */
  function renderDashboard() {
    const s = monthSummary(currentMonthKey);
    document.getElementById('heroSaldoLivre').textContent = formatCurrency(s.saldoLivre);
    document.getElementById('heroReceita').textContent = '+ ' + formatCurrency(s.receitaCasa) + ' receitas';
    document.getElementById('heroDespesa').textContent = '– ' + formatCurrency(s.despesaCasa) + ' gastos';
    document.getElementById('statPoupanca').textContent = formatCurrency(poupancaSaldoTotal());
    document.getElementById('statTA').textContent = formatCurrency(taSaldoTotal());

    const recentes = txnsOfMonth(currentMonthKey).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const ul = document.getElementById('listaRecentes');
    ul.innerHTML = '';
    recentes.forEach(t => ul.appendChild(txnRow(t)));
    document.getElementById('vazioRecentes').hidden = recentes.length > 0;

    const prevKey = shiftMonthKey(currentMonthKey, -1);
    const atual = despesasPorCategoria(currentMonthKey);
    const anterior = despesasPorCategoria(prevKey);
    const categorias = new Set([...Object.keys(atual), ...Object.keys(anterior)]);
    const linhas = [];
    categorias.forEach(cat => {
      const a = atual[cat] || 0;
      const b = anterior[cat] || 0;
      if (a === 0 && b === 0) return;
      const delta = a - b;
      if (Math.abs(delta) < 0.01) return;
      linhas.push({ cat, a, b, delta });
    });
    linhas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    const ulComp = document.getElementById('listaComparativo');
    ulComp.innerHTML = '';
    linhas.slice(0, 6).forEach(l => {
      const li = document.createElement('li');
      li.className = 'compare-item';
      const cls = l.delta > 0 ? 'up' : 'down';
      const sinal = l.delta > 0 ? '+' : '–';
      li.innerHTML = `<span>${l.cat}</span><span class="delta ${cls}">${sinal} ${formatCurrency(Math.abs(l.delta))}</span>`;
      ulComp.appendChild(li);
    });
    document.getElementById('vazioComparativo').hidden = linhas.length > 0;
  }

  /* ================= RENDER: extrato ================= */
  document.querySelectorAll('#filtrosExtrato .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      extratoFiltro = chip.dataset.filter;
      document.querySelectorAll('#filtrosExtrato .filter-chip').forEach(c => c.classList.toggle('active', c === chip));
      renderExtrato();
    });
  });

  function renderExtrato() {
    let txns = txnsOfMonth(currentMonthKey).slice().sort((a, b) => b.date.localeCompare(a.date));
    if (extratoFiltro === 'receita') txns = txns.filter(t => t.type === 'receita' && !t.isTA);
    else if (extratoFiltro === 'despesa') txns = txns.filter(t => t.type === 'despesa' && !t.isTA);
    else if (extratoFiltro === 'ta') txns = txns.filter(t => t.isTA);

    const ul = document.getElementById('listaExtrato');
    ul.innerHTML = '';
    txns.forEach(t => ul.appendChild(txnRow(t)));
    document.getElementById('vazioExtrato').hidden = txns.length > 0;
  }

  /* ================= RENDER: mercado ================= */
  function renderMercado() {
    const lista = activeListForMonth(currentMonthKey);
    document.getElementById('mercadoSemLista').hidden = !!lista;
    document.getElementById('mercadoComLista').hidden = !lista;

    if (lista) {
      document.getElementById('listaNome').textContent = lista.name;
      document.getElementById('listaStatus').textContent = lista.status === 'montagem' ? 'em montagem' : 'comprando';
      const total = lista.items.reduce((s, i) => s + i.qty * (i.unitPrice || 0), 0);
      document.getElementById('listaTotal').textContent = formatCurrency(total);

      const emMontagem = lista.status === 'montagem';
      document.getElementById('acoesPreCompra').hidden = !emMontagem;
      document.getElementById('acoesCompra').hidden = emMontagem;
      document.getElementById('btnFinalizarCompra').hidden = emMontagem;

      const ul = document.getElementById('listaItens');
      ul.innerHTML = '';
      lista.items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'market-item' + (item.checked ? ' checked' : '');
        const subtotal = item.qty * (item.unitPrice || 0);
        li.innerHTML = `
          <span class="market-item-check ${item.checked ? 'on' : ''}">${item.checked ? '✓' : ''}</span>
          <span class="market-item-main">
            <span class="market-item-name">${escapeHTML(item.name)}</span>
            <span class="market-item-sub">${item.brand ? escapeHTML(item.brand) + ' · ' : ''}qtd ${item.qty}</span>
          </span>
          <span class="market-item-price">${item.unitPrice ? formatCurrency(subtotal) : (emMontagem ? '' : 'definir preço')}</span>
        `;
        li.querySelector('.market-item-check').addEventListener('click', (ev) => {
          ev.stopPropagation();
          item.checked = !item.checked;
          saveDB();
          renderMercado();
        });
        li.addEventListener('click', () => abrirModalItem(item, lista.status));
        ul.appendChild(li);
      });
    }

    const historico = db.lists.filter(l => l.status === 'finalizada').sort((a, b) => (b.finalizedDate || '').localeCompare(a.finalizedDate || ''));
    const ulHist = document.getElementById('listaHistoricoListas');
    ulHist.innerHTML = '';
    historico.forEach(l => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.innerHTML = `<span>${escapeHTML(l.name)}<br><span class="muted">${monthLabel(l.monthKey)} · ${l.items.length} itens</span></span><strong>${formatCurrency(l.totalValue)}</strong>`;
      ulHist.appendChild(li);
    });
    document.getElementById('vazioHistoricoListas').hidden = historico.length > 0;
  }

  /* ================= RENDER: relatórios ================= */
  function renderRelatorios() {
    const s = monthSummary(currentMonthKey);

    if (typeof Chart !== 'undefined') {
      if (charts.rd) charts.rd.destroy();
      const ctxRD = document.getElementById('chartReceitaDespesa').getContext('2d');
      charts.rd = new Chart(ctxRD, {
        type: 'bar',
        data: {
          labels: ['Receitas', 'Despesas'],
          datasets: [{ data: [s.receitaCasa, s.despesaCasa], backgroundColor: ['#2F9E7C', '#C65D3B'], borderRadius: 8 }]
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8B9198' }, grid: { display: false } },
            y: { ticks: { color: '#8B9198' }, grid: { color: '#2C343B' } }
          }
        }
      });

      const cats = despesasPorCategoria(currentMonthKey);
      const labels = Object.keys(cats);
      const valores = Object.values(cats);
      if (charts.cat) charts.cat.destroy();
      const ctxCat = document.getElementById('chartCategorias').getContext('2d');
      charts.cat = new Chart(ctxCat, {
        type: 'bar',
        data: { labels, datasets: [{ data: valores, backgroundColor: '#D6B25E', borderRadius: 8 }] },
        options: {
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8B9198' }, grid: { color: '#2C343B' } },
            y: { ticks: { color: '#8B9198' }, grid: { display: false } }
          }
        }
      });
    }

    document.getElementById('reportTA').innerHTML = `
      <div class="row"><span>Recebido no mês</span><strong>${formatCurrency(s.taEntrada)}</strong></div>
      <div class="row"><span>Gasto no mês</span><strong>${formatCurrency(s.taSaida)}</strong></div>
      <div class="row"><span>Saldo atual do Ticket Alimentação</span><strong>${formatCurrency(taSaldoTotal())}</strong></div>
    `;

    const meses = allKnownMonthKeys();
    const selA = document.getElementById('selMesA');
    const selB = document.getElementById('selMesB');
    const prevSelA = selA.value, prevSelB = selB.value;
    const opts = meses.map(mk => `<option value="${mk}">${monthLabel(mk)}</option>`).join('');
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    selA.value = prevSelA || shiftMonthKey(currentMonthKey, -1);
    selB.value = prevSelB || currentMonthKey;
    renderComparacaoMeses();
  }

  function renderComparacaoMeses() {
    const mkA = document.getElementById('selMesA').value;
    const mkB = document.getElementById('selMesB').value;
    if (!mkA || !mkB) return;
    const a = monthSummary(mkA);
    const b = monthSummary(mkB);
    const linhas = [
      ['Receitas', a.receitaCasa, b.receitaCasa],
      ['Despesas', a.despesaCasa, b.despesaCasa],
      ['Saldo livre', a.saldoLivre, b.saldoLivre],
      ['Gasto com TA', a.taSaida, b.taSaida],
      ['Transferido p/ poupança', a.poupancaTransferida, b.poupancaTransferida]
    ];
    const html = linhas.map(([label, va, vb]) => {
      const delta = vb - va;
      const cls = delta > 0 ? 'up' : (delta < 0 ? 'down' : '');
      const sinal = delta > 0 ? '+' : (delta < 0 ? '–' : '');
      return `<div class="compare-item"><span>${label}<br><span class="muted" style="color:var(--text-muted); font-size:11.5px;">${formatCurrency(va)} → ${formatCurrency(vb)}</span></span><span class="delta ${cls}">${sinal} ${formatCurrency(Math.abs(delta))}</span></div>`;
    }).join('');
    document.getElementById('resultadoComparacao').innerHTML = html;
  }

  document.getElementById('selMesA').addEventListener('change', renderComparacaoMeses);
  document.getElementById('selMesB').addEventListener('change', renderComparacaoMeses);

  /* ================= RENDER: poupança ================= */
  function renderPoupanca() {
    document.getElementById('poupancaSaldoTotal').textContent = formatCurrency(poupancaSaldoTotal());
    const registros = db.savings.slice().sort((a, b) => b.date.localeCompare(a.date));
    const ul = document.getElementById('listaPoupanca');
    ul.innerHTML = '';
    registros.forEach(r => {
      const li = document.createElement('li');
      li.className = 'txn-item';
      li.innerHTML = `
        <span class="txn-dot receita"></span>
        <span class="txn-main">
          <span class="txn-desc">${escapeHTML(r.description)}</span>
          <span class="txn-meta">${monthLabel(r.monthKey)} · ${formatDateBR(r.date)}</span>
        </span>
        <span class="txn-value receita">+ ${formatCurrency(r.value)}</span>
      `;
      li.addEventListener('click', () => {
        if (confirm('Remover esta transferência da poupança?')) {
          db.savings = db.savings.filter(s => s.id !== r.id);
          saveDB();
          renderAll();
        }
      });
      ul.appendChild(li);
    });
    document.getElementById('vazioPoupanca').hidden = registros.length > 0;
  }

  /* ================= RENDER geral ================= */
  function renderAll() {
    document.getElementById('btnMonthLabel').textContent = monthLabel(currentMonthKey);
    renderDashboard();
    renderExtrato();
    renderMercado();
    renderRelatorios();
    renderPoupanca();
  }

  /* ================= PWA: service worker ================= */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* segue sem SW */ });
    });
  }

  /* ================= inicialização ================= */
  populateCategorias();
  renderAll();

})();
