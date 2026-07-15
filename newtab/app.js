/**
 * Horizon — A beautiful, AI-powered new tab page.
 * Cross-browser (Chrome + Firefox). Hermes integration for ambient intelligence.
 */

// ============================================================
// State
// ============================================================

const STORAGE_KEY = 'horizon:settings';

let state = {
  name: '',
  clockFormat: '12',
  showSeconds: false,
  tempUnit: 'imperial',
  photoCategory: 'nature',
  hermesEnabled: false,
  hermesUrl: 'http://localhost:8942',
  focus: '',
  focusDone: false,
  todos: [],
  links: [],
};

// ============================================================
// Storage
// ============================================================

async function loadState() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) {
      state = { ...state, ...data[STORAGE_KEY] };
    }
  } catch (e) {
    console.warn('Horizon: failed to load state', e);
  }
}

async function saveState() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (e) {
    console.warn('Horizon: failed to save state', e);
  }
}

// ============================================================
// Dom refs
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  clock: $('#clock'),
  greeting: $('#greeting'),
  focusInput: $('#focus-input'),
  focusDisplay: $('#focus-display'),
  focusArea: $('#focus-area'),
  background: $('#background'),
  weatherIcon: $('#weather-icon'),
  weatherTemp: $('#weather-temp'),
  weatherCity: $('#weather-city'),
  quoteText: $('#quote-text'),
  linksContainer: $('#links-container'),
  todoToggle: $('#todo-toggle'),
  todoCount: $('#todo-count'),
  todoPanel: $('#todo-panel'),
  todoInput: $('#todo-input'),
  todoList: $('#todo-list'),
  settingsPanel: $('#settings-panel'),
  settingsToggle: $('#settings-toggle'),
  commandInput: $('#command-input'),
  commandResults: $('#command-results'),
};

// ============================================================
// Clock
// ============================================================

function updateClock() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');

  if (state.clockFormat === '12') {
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    if (state.showSeconds) {
      const seconds = String(now.getSeconds()).padStart(2, '0');
      dom.clock.textContent = `${hours}:${minutes}:${seconds} ${ampm}`;
    } else {
      dom.clock.textContent = `${hours}:${minutes} ${ampm}`;
    }
  } else {
    hours = String(hours).padStart(2, '0');
    if (state.showSeconds) {
      const seconds = String(now.getSeconds()).padStart(2, '0');
      dom.clock.textContent = `${hours}:${minutes}:${seconds}`;
    } else {
      dom.clock.textContent = `${hours}:${minutes}`;
    }
  }
}

// ============================================================
// Greeting
// ============================================================

function updateGreeting() {
  const hour = new Date().getHours();
  let timeOfDay;
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else timeOfDay = 'evening';

  const name = state.name || '';
  dom.greeting.textContent = `Good ${timeOfDay}${name ? ', ' + name : ''}.`;
}

// ============================================================
// Focus
// ============================================================

function renderFocus() {
  if (state.focus) {
    dom.focusInput.style.display = 'none';
    dom.focusDisplay.style.display = 'flex';
    dom.focusDisplay.innerHTML = `
      <span class="check-mark" id="focus-check">${state.focusDone ? '✅' : '○'}</span>
      <span class="${state.focusDone ? 'done' : ''}">${escapeHtml(state.focus)}</span>
    `;
    dom.focusDisplay.onclick = () => {
      dom.focusInput.style.display = 'block';
      dom.focusDisplay.style.display = 'none';
      dom.focusInput.value = state.focus;
      dom.focusInput.focus();
    };
    const checkMark = $('#focus-check');
    if (checkMark) {
      checkMark.onclick = (e) => {
        e.stopPropagation();
        state.focusDone = !state.focusDone;
        saveState();
        renderFocus();
      };
    }
  } else {
    dom.focusInput.style.display = 'block';
    dom.focusDisplay.style.display = 'none';
    dom.focusInput.value = '';
  }
}

function handleFocusSubmit() {
  const value = dom.focusInput.value.trim();
  if (value) {
    state.focus = value;
    state.focusDone = false;
    saveState();
  }
  dom.focusInput.blur();
  renderFocus();
}

// ============================================================
// Background
// ============================================================

const UNSPLASH_COLLECTIONS = {
  nature: '317099',
  minimal: '327760',
  architecture: '3348849',
  travel: '181581',
};

// Fallback gradient so the page never shows a black void
const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
  'linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)',
  'linear-gradient(135deg, #0d1117, #161b22, #0d1117)',
];

function applyFallbackBackground() {
  const gradient = FALLBACK_GRADIENTS[Math.floor(Math.random() * FALLBACK_GRADIENTS.length)];
  dom.background.style.backgroundImage = gradient;
}

async function fetchBackground() {
  const collection = UNSPLASH_COLLECTIONS[state.photoCategory] || UNSPLASH_COLLECTIONS.nature;

  // Use Unsplash's source API (no key needed)
  const sourceUrl = `https://source.unsplash.com/collection/${collection}/1920x1080`;

  const img = new Image();
  let loaded = false;

  img.onload = () => {
    loaded = true;
    dom.background.style.backgroundImage = `url(${sourceUrl})`;
  };

  img.onerror = () => {
    if (!loaded) applyFallbackBackground();
  };

  img.src = sourceUrl;

  // Timeout: if image doesn't load within 8 seconds, fall back
  setTimeout(() => {
    if (!loaded && !dom.background.style.backgroundImage) {
      applyFallbackBackground();
    }
  }, 8000);
}

// ============================================================
// Weather
// ============================================================

async function requestGeolocation() {
  // In extension context, request the permission first
  if (typeof chrome !== 'undefined' && chrome.permissions) {
    const granted = await chrome.permissions.request({ permissions: ['geolocation'] });
    if (!granted) throw new Error('Permission denied');
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout: 5000,
      maximumAge: 1800000,
    });
  });
}

async function fetchWeatherByCoords(latitude, longitude) {
  const units = state.tempUnit;
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';

  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=${tempUnit}&timezone=auto`
  );
  if (!response.ok) throw new Error('Weather API failed');
  const data = await response.json();

  if (data.current_weather) {
    const temp = Math.round(data.current_weather.temperature);
    const unit = units === 'imperial' ? '°F' : '°C';
    const code = data.current_weather.weathercode;

    dom.weatherTemp.textContent = `${temp}${unit}`;
    dom.weatherIcon.textContent = weatherCodeToEmoji(code);

    // Reverse geocode for city name
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10`
      );
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        const city = geoData.address?.city || geoData.address?.town || geoData.address?.county || '';
        dom.weatherCity.textContent = city;
      }
    } catch {
      dom.weatherCity.textContent = '';
    }
  }
}

async function fetchWeatherByIP() {
  // IP-based geolocation fallback — no user permission needed
  try {
    const ipRes = await fetch('https://api.open-meteo.com/v1/forecast?latitude=30.2672&longitude=-97.7431&current_weather=true&temperature_unit=fahrenheit&timezone=auto');
    if (!ipRes.ok) throw new Error('IP weather failed');
    const data = await ipRes.json();

    if (data.current_weather) {
      const units = state.tempUnit;
      const temp = units === 'imperial'
        ? Math.round(data.current_weather.temperature)
        : Math.round((data.current_weather.temperature - 32) * 5 / 9);
      const unit = units === 'imperial' ? '°F' : '°C';
      dom.weatherTemp.textContent = `${temp}${unit}`;
      dom.weatherIcon.textContent = weatherCodeToEmoji(data.current_weather.weathercode);
    }
  } catch {
    dom.weatherTemp.textContent = '--°';
    dom.weatherIcon.textContent = '🌤';
  }
  dom.weatherCity.textContent = '';
}

async function fetchWeather() {
  try {
    // Try browser geolocation first
    const position = await requestGeolocation();
    await fetchWeatherByCoords(position.coords.latitude, position.coords.longitude);
  } catch {
    // Fall back to a default location or IP-based
    await fetchWeatherByIP();
  }
}

function weatherCodeToEmoji(code) {
  if (code <= 1) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '☁️';
  if (code <= 57) return '🌧';
  if (code <= 67) return '🌨';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧';
  if (code <= 86) return '🌨';
  return '🌤';
}

// ============================================================
// Quote
// ============================================================

async function fetchQuote() {
  try {
    const response = await fetch('https://api.quotable.io/random?maxLength=120');
    const data = await response.json();
    dom.quoteText.textContent = `"${data.content}" — ${data.author}`;
  } catch {
    dom.quoteText.textContent = '"The best time to plant a tree was 20 years ago. The second best time is now."';
  }
}

// ============================================================
// To-do List
// ============================================================

function renderTodos() {
  dom.todoList.innerHTML = '';
  const incomplete = state.todos.filter(t => !t.done);
  dom.todoCount.textContent = incomplete.length || '';

  state.todos.forEach((todo, i) => {
    const li = document.createElement('li');
    if (todo.done) li.classList.add('completed');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.done;
    checkbox.onchange = () => {
      state.todos[i].done = checkbox.checked;
      saveState();
      renderTodos();
    };

    const span = document.createElement('span');
    span.textContent = todo.text;

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-todo';
    delBtn.textContent = '×';
    delBtn.onclick = () => {
      state.todos.splice(i, 1);
      saveState();
      renderTodos();
    };

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(delBtn);
    dom.todoList.appendChild(li);
  });
}

function addTodo(text) {
  if (!text.trim()) return;
  state.todos.push({ text: text.trim(), done: false });
  saveState();
  renderTodos();
  dom.todoInput.value = '';
}

// ============================================================
// Quick Links
// ============================================================

function renderLinks() {
  dom.linksContainer.innerHTML = '';
  
  state.links.forEach((link, i) => {
    const tile = document.createElement('a');
    tile.className = 'link-tile';
    tile.href = link.url;
    tile.title = link.title;
    
    if (link.favicon) {
      const img = document.createElement('img');
      img.src = link.favicon;
      img.alt = link.title;
      img.onerror = () => { tile.textContent = link.title.charAt(0).toUpperCase(); };
      tile.appendChild(img);
    } else {
      tile.textContent = link.title.charAt(0).toUpperCase();
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-link';
    delBtn.textContent = '×';
    delBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.links.splice(i, 1);
      saveState();
      renderLinks();
    };
    tile.appendChild(delBtn);
    dom.linksContainer.appendChild(tile);
  });
}

function showAddLinkModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Add Quick Link</h3>
      <label>
        <span>Title</span>
        <input type="text" id="link-title" placeholder="e.g. GitHub" autofocus>
      </label>
      <label>
        <span>URL</span>
        <input type="text" id="link-url" placeholder="https://...">
      </label>
      <div class="modal-actions">
        <button class="btn-secondary" id="link-cancel">Cancel</button>
        <button class="btn-primary" id="link-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleInput = overlay.querySelector('#link-title');
  const urlInput = overlay.querySelector('#link-url');

  overlay.querySelector('#link-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#link-save').onclick = () => {
    const title = titleInput.value.trim();
    let url = urlInput.value.trim();
    if (!title || !url) return;
    if (!url.startsWith('http')) url = 'https://' + url;

    state.links.push({
      title,
      url,
      favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    });
    saveState();
    renderLinks();
    overlay.remove();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ============================================================
// Settings
// ============================================================

function updateSettingsForm() {
  $('#setting-name').value = state.name;
  $('#setting-clock-format').value = state.clockFormat;
  $('#setting-show-seconds').checked = state.showSeconds;
  $('#setting-unit').value = state.tempUnit;
  $('#setting-photo-category').value = state.photoCategory;
  $('#setting-hermes').checked = state.hermesEnabled;
  $('#setting-hermes-url').value = state.hermesUrl;
  $('#hermes-url-label').style.display = state.hermesEnabled ? 'flex' : 'none';
}

function bindSettings() {
  $('#setting-name').oninput = (e) => { state.name = e.target.value.trim(); saveState(); updateGreeting(); };
  $('#setting-clock-format').onchange = (e) => { state.clockFormat = e.target.value; saveState(); updateClock(); };
  $('#setting-show-seconds').onchange = (e) => { state.showSeconds = e.target.checked; saveState(); };
  $('#setting-unit').onchange = (e) => { state.tempUnit = e.target.value; saveState(); fetchWeather(); };
  $('#setting-photo-category').onchange = (e) => { state.photoCategory = e.target.value; saveState(); fetchBackground(); };
  $('#setting-hermes').onchange = (e) => {
    state.hermesEnabled = e.target.checked;
    $('#hermes-url-label').style.display = e.target.checked ? 'flex' : 'none';
    saveState();
  };
  $('#setting-hermes-url').oninput = (e) => { state.hermesUrl = e.target.value.trim(); saveState(); };
}

// ============================================================
// Command Bar (Hermes)
// ============================================================

let commandDebounce;

function showCommandBar() {
  dom.commandInput.classList.add('visible');
  dom.commandInput.focus();
}

function hideCommandBar() {
  dom.commandInput.classList.remove('visible');
  dom.commandInput.value = '';
  dom.commandResults.classList.add('hidden');
  dom.commandResults.innerHTML = '';
}

async function handleCommand(query) {
  if (!query.trim()) {
    dom.commandResults.classList.add('hidden');
    return;
  }

  // Check for focus setting
  if (query.toLowerCase().startsWith('focus:')) {
    const focusText = query.slice(6).trim();
    if (focusText) {
      state.focus = focusText;
      state.focusDone = false;
      saveState();
      renderFocus();
      hideCommandBar();
    }
    return;
  }

  // If Hermes is enabled, try the Hermes API
  if (state.hermesEnabled && window.HorizonHermes) {
    try {
      const results = await window.HorizonHermes.query(query);
      if (results && results.length > 0) {
        renderCommandResults(results);
        return;
      }
    } catch {
      // Fall through to local search
    }
  }

  // Fallback: web search
  dom.commandResults.innerHTML = `
    <div class="result-item" onclick="window.location.href='https://www.google.com/search?q=${encodeURIComponent(query)}'">
      <div class="result-title">🔍 Search Google for "${escapeHtml(query)}"</div>
    </div>
  `;
  dom.commandResults.classList.remove('hidden');
}

function renderCommandResults(results) {
  dom.commandResults.innerHTML = '';
  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = `
      <div class="result-title">${escapeHtml(r.title || r.summary)}</div>
      ${r.detail ? `<div class="result-detail">${escapeHtml(r.detail)}</div>` : ''}
    `;
    if (r.action === 'open') {
      div.onclick = () => window.location.href = r.url;
    } else if (r.url) {
      div.onclick = () => window.location.href = r.url;
    }
    dom.commandResults.appendChild(div);
  });
  dom.commandResults.classList.remove('hidden');
}

// ============================================================
// Hermes Bridge — check for updates from Hermes cron
// ============================================================

async function checkHermesBriefing() {
  if (!state.hermesEnabled || !window.HorizonHermes) return;

  try {
    const briefing = await window.HorizonHermes.getBriefing();
    if (briefing) {
      if (briefing.focus && !state.focus) {
        state.focus = briefing.focus;
        saveState();
        renderFocus();
      }
      if (briefing.quote) {
        dom.quoteText.textContent = briefing.quote;
      }
    }
  } catch {
    // Hermes not available — that's fine
  }
}

// ============================================================
// Utils
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Keyboard shortcuts
// ============================================================

function handleKeyboard(e) {
  // Cmd/Ctrl + K — open command bar
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    showCommandBar();
    return;
  }

  // Escape — close panels/command bar
  if (e.key === 'Escape') {
    if (!dom.commandResults.classList.contains('hidden')) {
      hideCommandBar();
    } else if (!dom.todoPanel.classList.contains('hidden')) {
      dom.todoPanel.classList.add('hidden');
    } else if (!dom.settingsPanel.classList.contains('hidden')) {
      dom.settingsPanel.classList.add('hidden');
    }
    return;
  }

  // Just start typing — focus the command bar (if not in an input)
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      showCommandBar();
      dom.commandInput.value = e.key;
    }
  }
}

// ============================================================
// Initialisation
// ============================================================

async function init() {
  await loadState();

  // Set up event listeners
  dom.focusInput.onkeydown = (e) => { if (e.key === 'Enter') handleFocusSubmit(); };
  dom.focusInput.onblur = () => {
    if (dom.focusInput.value.trim()) {
      handleFocusSubmit();
    } else {
      // If empty and no existing focus, just keep showing input
      if (!state.focus) {
        dom.focusInput.style.display = 'block';
        dom.focusDisplay.style.display = 'none';
      } else {
        renderFocus();
      }
    }
  };

  dom.todoToggle.onclick = () => dom.todoPanel.classList.toggle('hidden');
  $('#todo-close').onclick = () => dom.todoPanel.classList.add('hidden');
  dom.todoInput.onkeydown = (e) => { if (e.key === 'Enter') addTodo(dom.todoInput.value); };

  dom.settingsToggle.onclick = () => {
    dom.settingsPanel.classList.toggle('hidden');
    if (!dom.settingsPanel.classList.contains('hidden')) {
      updateSettingsForm();
    }
  };
  $('#settings-close').onclick = () => dom.settingsPanel.classList.add('hidden');

  $('#add-link-btn').onclick = showAddLinkModal;

  dom.commandInput.oninput = () => {
    clearTimeout(commandDebounce);
    commandDebounce = setTimeout(() => handleCommand(dom.commandInput.value), 300);
  };
  dom.commandInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const query = dom.commandInput.value.trim();
      if (query) {
        window.location.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }
      hideCommandBar();
    }
  };

  document.addEventListener('keydown', handleKeyboard);

  // Initial render
  updateClock();
  updateGreeting();
  renderFocus();
  renderTodos();
  renderLinks();

  // Fetch data
  fetchBackground();
  fetchWeather();
  fetchQuote();

  // Periodic updates
  setInterval(updateClock, state.showSeconds ? 1000 : 10000);
  setInterval(updateGreeting, 60000);
  setInterval(fetchBackground, 3600000); // hourly
  setInterval(fetchWeather, 1800000);    // 30 min
  setInterval(fetchQuote, 3600000);      // hourly

  // Hermes briefing check
  if (state.hermesEnabled) {
    setTimeout(checkHermesBriefing, 2000);
    setInterval(checkHermesBriefing, 300000); // every 5 min
  }
}

init();