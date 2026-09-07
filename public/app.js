/* Панель оператора: чаты, запросы менеджеру, оркестрация LLM, журнал интеграций. */
'use strict';

const state = {
  threads: [],
  messages: new Map(),          // threadId -> Message[]
  escalations: [],
  runs: [],
  runEvents: new Map(),         // runId -> RunEvent[]
  externalEvents: [],
  orchestrator: new Map(),      // threadId -> { buffered, bufferedTexts, activeRunId, debounceArmed }
  settings: {},
  llmProviders: [],
  health: null,
  tab: 'chats',
  activeThreadId: null,
  search: '',
  escFilter: 'open',
  extFilter: 'all',
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// ------------------------------------------------------------------ утилиты

function time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function dateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function ms(value) {
  if (value == null) return '';
  return value < 1000 ? `${value} мс` : `${(value / 1000).toFixed(1)} с`;
}
function threadById(id) {
  return state.threads.find((t) => t.id === id) || null;
}
function threadLabel(id) {
  const t = threadById(id);
  return t ? `${t.customer_name} · ${t.customer_chat_id}` : id?.slice(0, 8) || '—';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Требуется вход');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// setTimeout, а не requestAnimationFrame: в фоновой вкладке rAF не вызывается,
// и панель показывала бы устаревшие данные, пока оператор к ней не вернётся.
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    try {
      render();
    } catch (err) {
      console.error('ошибка отрисовки', err);
    }
  }, 16);
}

// -------------------------------------------------------------------- вход

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка входа');
    showApp();
    // ошибки загрузки данных — это уже не про пароль, показываем их баннером,
    // иначе непонятно, что именно не сработало
    boot().catch((err) => showBanner(`Не удалось загрузить данные: ${err.message}`));
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

/** Баннер с ошибкой поверх интерфейса */
function showBanner(message) {
  let bar = $('#banner');
  if (!bar) {
    bar = el('div', 'banner');
    bar.id = 'banner';
    const close = el('button', 'banner__close', '×');
    close.addEventListener('click', () => bar.remove());
    bar.append(el('span', 'banner__text'), close);
    $('#app').prepend(bar);
  }
  bar.querySelector('.banner__text').textContent = message;
}

$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// -------------------------------------------------------------- загрузка

async function boot() {
  const data = await api('/api/bootstrap');
  state.threads = data.threads;
  state.escalations = data.escalations;
  state.runs = data.runs;
  state.externalEvents = data.externalEvents;
  state.settings = data.settings;
  state.llmProviders = data.llmProviders || [];
  state.runEvents = new Map();
  for (const event of data.runEvents) {
    if (!state.runEvents.has(event.run_id)) state.runEvents.set(event.run_id, []);
    state.runEvents.get(event.run_id).push(event);
  }
  state.orchestrator = new Map(data.orchestrator.map((item) => [item.threadId, item]));
  if (!state.activeThreadId && state.threads.length) selectThread(state.threads[0].id);
  connectSocket();
  void loadHealth();
  scheduleRender();
}

async function loadHealth() {
  try {
    const data = await api('/api/integrations');
    state.health = data.checks;
    state.priceList = data.priceList;
  } catch (err) {
    state.health = { panel: { ok: false, detail: err.message } };
  }
  scheduleRender();
}

// ------------------------------------------------------------- WebSocket

let socket = null;
let reconnectTimer = null;

function setConn(cls, text) {
  const node = $('#conn');
  node.className = `conn ${cls}`;
  node.querySelector('span').textContent = text;
}

function connectSocket() {
  if (socket) socket.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => setConn('is-online', 'в эфире');
  socket.onclose = () => {
    setConn('is-offline', 'нет связи');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 3000);
  };
  socket.onerror = () => setConn('is-offline', 'ошибка сокета');
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    applyEvent(msg);
    scheduleRender();
  };
}

function upsert(list, item, key = 'id') {
  const index = list.findIndex((entry) => entry[key] === item[key]);
  if (index === -1) list.unshift(item);
  else list[index] = item;
}

function applyEvent(msg) {
  switch (msg.type) {
    case 'thread.updated': {
      upsert(state.threads, msg.thread);
      state.threads.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
      break;
    }
    case 'message.created': {
      const list = state.messages.get(msg.message.thread_id);
      if (list) {
        if (!list.some((m) => m.id === msg.message.id)) list.push(msg.message);
      }
      break;
    }
    case 'run.updated': {
      upsert(state.runs, msg.run);
      state.runs.sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at));
      if (state.runs.length > 100) state.runs.length = 100;
      break;
    }
    case 'run.event': {
      if (!state.runEvents.has(msg.event.run_id)) state.runEvents.set(msg.event.run_id, []);
      state.runEvents.get(msg.event.run_id).push(msg.event);
      break;
    }
    case 'escalation.updated': {
      upsert(state.escalations, msg.escalation);
      break;
    }
    case 'external.event': {
      state.externalEvents.unshift(msg.event);
      if (state.externalEvents.length > 300) state.externalEvents.length = 300;
      break;
    }
    case 'orchestrator.state': {
      const prev = state.orchestrator.get(msg.threadId) || {};
      state.orchestrator.set(msg.threadId, { ...prev, ...msg });
      break;
    }
    case 'hello': {
      state.orchestrator = new Map((msg.orchestrator || []).map((item) => [item.threadId, item]));
      break;
    }
  }
}

// ------------------------------------------------------------------ табы

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('is-active', view.dataset.view === state.tab));
    if (state.tab === 'errors') void loadHealth();
    scheduleRender();
  });
});

$('#thread-search').addEventListener('input', (event) => {
  state.search = event.target.value.toLowerCase();
  scheduleRender();
});

$('#esc-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  state.escFilter = chip.dataset.status;
  scheduleRender();
});

$('#ext-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  state.extFilter = chip.dataset.service;
  scheduleRender();
});

$('#refresh-price').addEventListener('click', async () => {
  await api('/api/price-list/refresh', { method: 'POST' }).catch(() => {});
  void loadHealth();
});

// ---------------------------------------------------------------- рендер

function render() {
  renderCounters();
  if (state.tab === 'chats') renderChats();
  if (state.tab === 'escalations') renderEscalations();
  if (state.tab === 'orchestration') renderOrchestration();
  if (state.tab === 'errors') renderErrors();
}

function renderCounters() {
  $('#c-chats').textContent = state.threads.length || '';
  const openEsc = state.escalations.filter((e) => e.status !== 'done').length;
  $('#c-esc').textContent = openEsc || '';
  const activeRuns = state.runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
  $('#c-runs').textContent = activeRuns || '';
  const errors = state.externalEvents.filter((e) => e.status === 'error').length;
  $('#c-err').textContent = errors || '';
}

// ------------------------------------------------------------------ чаты

function renderChats() {
  const list = $('#thread-list');
  list.textContent = '';
  const filtered = state.threads.filter((thread) => {
    if (!state.search) return true;
    return (
      thread.customer_name.toLowerCase().includes(state.search) ||
      thread.customer_chat_id.includes(state.search)
    );
  });

  if (!filtered.length) list.append(el('div', 'muted', 'Диалогов пока нет'));

  for (const thread of filtered) {
    const orch = state.orchestrator.get(thread.id);
    const button = el('button', `thread${thread.id === state.activeThreadId ? ' is-active' : ''}`);
    const top = el('div', 'thread__top');
    top.append(el('span', 'thread__name', thread.customer_name));
    if (orch && (orch.activeRunId || orch.buffered)) {
      top.append(el('span', 'badge live', orch.activeRunId ? 'LLM думает' : `в буфере ${orch.buffered}`));
    }
    top.append(el('span', `badge ${thread.mode}`, thread.mode === 'ai' ? 'AI' : 'Ручной'));
    button.append(top);
    button.append(el('div', 'thread__preview', thread.last_message_text || 'нет сообщений'));
    button.addEventListener('click', () => selectThread(thread.id));
    list.append(button);
  }

  renderChatPane();
}

async function selectThread(id) {
  state.activeThreadId = id;
  if (!state.messages.has(id)) {
    try {
      const data = await api(`/api/threads/${id}/messages`);
      state.messages.set(id, data.messages);
    } catch (err) {
      state.messages.set(id, []);
    }
  }
  scheduleRender();
}

function renderChatPane() {
  const pane = $('#chat-pane');
  const thread = threadById(state.activeThreadId);
  pane.textContent = '';
  if (!thread) {
    pane.append(el('div', 'empty', 'Выберите диалог слева'));
    return;
  }

  // шапка: имя, режим, переключатель
  const head = el('div', 'chat__head');
  const title = el('div', 'chat__title', thread.customer_name);
  head.append(title);
  head.append(el('span', 'muted mono', `chat ${thread.customer_chat_id}${thread.topic_id ? ` · topic ${thread.topic_id}` : ''}`));

  const orch = state.orchestrator.get(thread.id);
  if (orch && (orch.activeRunId || orch.buffered)) {
    head.append(el('span', 'badge live', orch.activeRunId ? 'идёт запрос к LLM' : `в буфере: ${orch.buffered}`));
  }

  const spacer = el('div');
  spacer.style.flex = '1';
  head.append(spacer);

  const sw = el('div', 'switch');
  for (const mode of ['ai', 'human']) {
    const btn = el('button', thread.mode === mode ? 'is-active' : '', mode === 'ai' ? 'AI' : 'Ручной');
    btn.dataset.mode = mode;
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/threads/${thread.id}/mode`, { method: 'POST', body: { mode } });
      } catch (err) {
        alert(`Не удалось переключить режим: ${err.message}`);
      }
    });
    sw.append(btn);
  }
  head.append(sw);
  pane.append(head);

  // лента сообщений
  const log = el('div', 'chat__log');
  const messages = state.messages.get(thread.id) || [];
  for (const message of messages) {
    const node = el('div', `msg ${message.role}`);
    node.append(el('div', null, message.text));
    const author =
      message.role === 'customer'
        ? message.meta?.source === 'voice'
          ? `клиент 🎤 голосовое${message.meta?.duration_sec ? ` ${message.meta.duration_sec} с` : ''}`
          : message.meta?.source === 'photo'
            ? 'клиент 🖼 фото'
            : 'клиент' :
      message.role === 'assistant' ? 'LLM' :
      message.role === 'manager' ? `менеджер${message.meta?.author ? ` (${message.meta.author})` : ''}` : 'система';
    node.append(el('div', 'msg__meta', `${author} · ${time(message.created_at)}`));
    log.append(node);
  }
  pane.append(log);

  // ответ менеджера
  const foot = el('div', 'chat__foot');
  const textarea = el('textarea');
  textarea.placeholder = 'Ответить клиенту от имени менеджера (диалог перейдёт в ручной режим)';
  const send = el('button', 'primary', 'Отправить');
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api(`/api/threads/${thread.id}/reply`, { method: 'POST', body: { text } });
      textarea.value = '';
    } catch (err) {
      alert(`Не удалось отправить: ${err.message}`);
    } finally {
      send.disabled = false;
    }
  };
  send.addEventListener('click', submit);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
  });
  foot.append(textarea, send);
  pane.append(foot);

  setTimeout(() => (log.scrollTop = log.scrollHeight), 0);
}

// ------------------------------------------------------------ эскалации

const REASON_LABELS = {
  deal_ready: 'Клиент готов оформить заказ',
  price_not_found: 'Цена не найдена в прайсе',
  not_in_stock: 'Позиции отсутствуют в наличии',
  ai_unavailable: 'LLM не ответила корректно',
  price_source_unavailable: 'Прайс недоступен',
  pipeline_error: 'Техническая ошибка обработки',
  manual: 'Ручной запрос',
};

function renderEscalations() {
  document.querySelectorAll('#esc-filters .chip').forEach((chip) =>
    chip.classList.toggle('is-active', chip.dataset.status === state.escFilter),
  );

  const list = $('#esc-list');
  list.textContent = '';
  const items = state.escalations.filter((item) => {
    if (state.escFilter === 'all') return true;
    if (state.escFilter === 'open') return item.status !== 'done';
    return item.status === state.escFilter;
  });

  if (!items.length) {
    list.append(el('div', 'muted', 'Запросов нет'));
    return;
  }

  for (const item of items) {
    const card = el(
      'div',
      `card ${item.status === 'new' ? 'is-new' : item.status === 'in_progress' ? 'is-progress' : 'is-done'}`,
    );
    const head = el('div', 'card__head');
    head.append(el('span', 'card__reason', REASON_LABELS[item.reason] || item.reason));
    head.append(el('span', 'badge', item.status === 'new' ? 'новый' : item.status === 'in_progress' ? 'в работе' : 'закрыт'));
    const spacer = el('div');
    spacer.style.flex = '1';
    head.append(spacer);
    head.append(el('span', 'muted mono', dateTime(item.created_at)));
    card.append(head);

    card.append(el('div', 'muted mono', threadLabel(item.thread_id)));
    card.append(el('div', 'card__body', item.summary || '—'));

    const incoming = item.context?.incoming;
    if (Array.isArray(incoming) && incoming.length) {
      card.append(el('div', 'card__ctx', 'Клиент: ' + incoming.join(' / ')));
    }
    if (item.context?.reply) {
      card.append(el('div', 'card__ctx', 'Ответ бота: ' + item.context.reply));
    }

    const actions = el('div', 'card__actions');
    const openChat = el('button', 'ghost', 'Открыть диалог');
    openChat.addEventListener('click', () => {
      document.querySelector('.tab[data-tab="chats"]').click();
      selectThread(item.thread_id);
    });
    actions.append(openChat);

    if (item.status !== 'in_progress') {
      const take = el('button', 'ghost', 'В работу');
      take.addEventListener('click', () => setEscalation(item.id, 'in_progress'));
      actions.append(take);
    }
    if (item.status !== 'done') {
      const done = el('button', 'ghost', 'Закрыть');
      done.addEventListener('click', () => setEscalation(item.id, 'done'));
      actions.append(done);
    } else {
      const reopen = el('button', 'ghost', 'Вернуть в работу');
      reopen.addEventListener('click', () => setEscalation(item.id, 'new'));
      actions.append(reopen);
    }
    card.append(actions);
    list.append(card);
  }
}

async function setEscalation(id, status) {
  try {
    await api(`/api/escalations/${id}/status`, { method: 'POST', body: { status } });
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------- оркестрация

const STAGE_LABELS = {
  queued: 'в очереди',
  debounce: 'склейка',
  context: 'контекст',
  llm_request: 'запрос в LLM',
  llm_response: 'ответ LLM',
  json_valid: 'JSON валиден',
  json_invalid: 'JSON невалиден → переспрос',
  compose: 'сборка ответа',
  persist: 'сохранение',
  deliver: 'отправка',
  done: 'готово',
  failed: 'ошибка',
  superseded: 'вытеснен',
};

const RUN_STATUS = {
  queued: 'в очереди',
  running: 'выполняется',
  done: 'завершён',
  failed: 'ошибка',
  superseded: 'вытеснен новым сообщением',
  cancelled: 'отменён',
};

function renderOrchestration() {
  const active = state.llmProviders.find((p) => p.active);
  $('#orch-settings').textContent =
    `окно склейки ${state.settings.debounceMs} мс · переспросов JSON до ${state.settings.maxJsonRetries} · ` +
    `провайдер ${active ? `${active.label} (${active.model})` : '—'}`;

  // живое состояние по чатам
  const live = $('#orch-live');
  live.textContent = '';
  const entries = [...state.orchestrator.values()].filter((item) => item.buffered || item.activeRunId);
  if (!entries.length) {
    live.append(el('div', 'muted', 'Сейчас активных обработок нет'));
  }
  for (const entry of entries) {
    const card = el('div', `live__card${entry.activeRunId ? '' : ' idle'}`);
    const head = el('div', 'card__head');
    head.append(el('span', 'card__reason', threadLabel(entry.threadId)));
    card.append(head);
    card.append(
      el(
        'div',
        'muted',
        entry.activeRunId
          ? `LLM обрабатывает прогон ${entry.activeRunId.slice(0, 8)}`
          : entry.debounceArmed
            ? 'ожидание окна склейки'
            : 'буфер',
      ),
    );
    card.append(el('div', null, `Сообщений в буфере: ${entry.buffered}`));
    if (entry.bufferedTexts?.length) {
      const bufs = el('div', 'live__bufs');
      entry.bufferedTexts.forEach((text, index) => bufs.append(el('div', 'live__buf', `${index + 1}. ${text}`)));
      card.append(bufs);
    }
    live.append(card);
  }

  // список прогонов
  const list = $('#run-list');
  list.textContent = '';
  if (!state.runs.length) {
    list.append(el('div', 'muted', 'Прогонов пока не было'));
    return;
  }

  for (const run of state.runs) {
    list.append(renderRun(run));
  }
}

function renderRun(run) {
  const node = el('div', `run status-${run.status}`);

  const head = el('div', 'run__head');
  head.append(el('span', 'run__title', threadLabel(run.thread_id)));
  head.append(el('span', 'badge', RUN_STATUS[run.status] || run.status));
  head.append(el('span', 'badge', `${run.batch_size} сообщ.`));
  if (run.attempts > 1) head.append(el('span', 'badge err', `попыток JSON: ${run.attempts}`));
  if (run.duration_ms != null) head.append(el('span', 'muted mono', ms(run.duration_ms)));
  const spacer = el('div');
  spacer.style.flex = '1';
  head.append(spacer);
  head.append(el('span', 'muted mono', `${dateTime(run.queued_at)} · ${run.id.slice(0, 8)}`));
  node.append(head);

  if (run.superseded_by) {
    node.append(el('div', 'muted', `→ заменён прогоном ${run.superseded_by.slice(0, 8)}`));
  }

  if (run.input_texts?.length) {
    const inputs = el('div', 'run__inputs');
    run.input_texts.forEach((text, index) =>
      inputs.append(el('div', 'run__input', `${run.input_texts.length > 1 ? `${index + 1}. ` : ''}${text}`)),
    );
    node.append(inputs);
  }

  // таймлайн этапов
  const events = [...(state.runEvents.get(run.id) || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (events.length) {
    const timeline = el('div', 'timeline');
    events.forEach((event, index) => {
      if (index) timeline.append(el('span', 'stage__arrow', '›'));
      const stage = el('span', `stage stage-${event.stage} level-${event.level}`);
      stage.append(el('b', null, STAGE_LABELS[event.stage] || event.stage));
      if (event.duration_ms != null) stage.append(el('span', 'ms', ms(event.duration_ms)));
      stage.title = `${time(event.created_at)} — ${event.message}`;
      timeline.append(stage);
    });
    node.append(timeline);

    const problems = events.filter((event) => event.level !== 'info');
    for (const problem of problems) {
      node.append(el('div', problem.level === 'error' ? 'run__error' : 'card__ctx', `${STAGE_LABELS[problem.stage] || problem.stage}: ${problem.message}`));
    }
  }

  if (run.reply) node.append(el('div', 'run__reply', run.reply));
  if (run.error_message) node.append(el('div', 'run__error', run.error_message));

  if (run.llm_raw || events.length) {
    const details = el('details', 'details');
    details.append(el('summary', null, 'Подробности прогона'));
    const pre = el('pre');
    pre.textContent = JSON.stringify(
      {
        status: run.status,
        lookup_status: run.lookup_status,
        matched_price_ids: run.matched_price_ids,
        escalate: run.escalate,
        parsed: run.parsed,
        llm_raw: run.llm_raw,
        events: events.map((e) => ({ stage: e.stage, level: e.level, message: e.message, payload: e.payload })),
      },
      null,
      2,
    );
    details.append(pre);
    node.append(details);
  }

  return node;
}

// -------------------------------------------------- интеграции и ошибки

const SERVICE_LABELS = {
  telegram: 'Telegram',
  gemini: 'LLM · Gemini',
  apibazaar: 'LLM · API Bazaar',
  price_list: 'Прайс-лист',
  supabase: 'Supabase',
  llm_gemini: 'LLM · Gemini',
  llm_apibazaar: 'LLM · API Bazaar',
  transcribe: 'Распознавание голосовых',
  vision: 'Распознавание фото',
};

const SERVICE_HINTS = {
  gemini: 'Google Gemini через generativelanguage.googleapis.com',
  apibazaar: 'OpenAI-совместимый эндпоинт из API_BAZAAR_URL',
};

function renderProviderSwitch() {
  const box = $('#provider-switch');
  box.textContent = '';
  box.append(el('div', 'provider__title', 'Провайдер LLM'));
  box.append(
    el(
      'div',
      'provider__hint',
      'Переключается на лету и сохраняется в базе. Уже идущие прогоны доработают на прежнем провайдере.',
    ),
  );

  const list = el('div', 'provider__list');
  for (const p of state.llmProviders) {
    const item = el('button', `provider__item${p.active ? ' is-active' : ''}`);
    const name = el('div', 'provider__name');
    name.append(el('span', null, p.label));
    if (p.active) name.append(el('span', 'badge live', 'активен'));
    item.append(name);
    item.append(el('div', 'provider__model', p.configured ? `Модель: ${p.model}` : 'Не настроен'));
    if (!p.configured) {
      item.append(el('div', 'provider__missing', `Не заданы: ${p.missing.join(', ')}`));
      item.disabled = true;
      item.title = 'Добавьте переменные в secret group Northflank и перезапустите сервис';
    } else if (!p.active) {
      item.addEventListener('click', () => switchProvider(p.id));
    }
    list.append(item);
  }
  box.append(list);
}

async function switchProvider(id) {
  try {
    const data = await api('/api/llm-provider', { method: 'POST', body: { provider: id } });
    state.llmProviders = data.providers;
    scheduleRender();
  } catch (err) {
    alert(`Не удалось переключить провайдера: ${err.message}`);
  }
}

function renderErrors() {
  renderProviderSwitch();
  document.querySelectorAll('#ext-filters .chip').forEach((chip) =>
    chip.classList.toggle('is-active', chip.dataset.service === state.extFilter),
  );

  const health = $('#health');
  health.textContent = '';
  if (!state.health) {
    health.append(el('div', 'muted', 'Проверка соединений…'));
  } else {
    for (const [name, check] of Object.entries(state.health)) {
      const item = el('div', `health__item ${check.ok ? 'is-ok' : 'is-err'}`);
      item.append(el('div', 'health__name', SERVICE_LABELS[name] || name));
      item.append(el('div', 'health__detail', check.detail));
      health.append(item);
    }
  }

  const list = $('#ext-list');
  list.textContent = '';
  const events = state.externalEvents.filter((event) => {
    if (state.extFilter === 'all') return true;
    if (state.extFilter === 'errors') return event.status === 'error';
    if (state.extFilter === 'llm') return event.service === 'gemini' || event.service === 'apibazaar';
    return event.service === state.extFilter;
  });

  if (!events.length) {
    list.append(el('div', 'muted', 'Событий нет'));
    return;
  }

  for (const event of events.slice(0, 200)) {
    const node = el('div', `event${event.status === 'error' ? ' is-error' : ''}`);
    node.append(el('div', 'event__svc', SERVICE_LABELS[event.service] || event.service));
    node.append(el('div', 'mono', event.operation));
    const message =
      event.status === 'error'
        ? event.error
        : `ok${event.http_status ? ` · HTTP ${event.http_status}` : ''}${event.attempt > 1 ? ` · попытка ${event.attempt}` : ''}`;
    const msgNode = el('div', 'event__msg', message || '');
    if (event.thread_id) msgNode.title = threadLabel(event.thread_id);
    node.append(msgNode);
    node.append(el('div', 'event__time', `${time(event.created_at)}${event.duration_ms != null ? ` · ${ms(event.duration_ms)}` : ''}`));
    list.append(node);
  }
}

// ------------------------------------------------------------------ старт

(async function start() {
  try {
    const session = await fetch('/api/session').then((r) => r.json());
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showApp();
    await boot();
  } catch (err) {
    if (String(err.message).includes('Требуется вход')) showLogin();
    else showBanner(`Не удалось загрузить данные: ${err.message}`);
  }
})();
