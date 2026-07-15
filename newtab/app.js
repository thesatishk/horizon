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
  photoSource: 'lorem',  // 'lorem' | 'unsplash' | 'local'
  photoCategory: 'nature',
  unsplashKey: '',
  localFolderName: '',
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
    // Verify save succeeded
    const verify = await chrome.storage.local.get(STORAGE_KEY);
    if (!verify[STORAGE_KEY]) {
      console.warn('Horizon: save verification failed, retrying...');
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    }
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

async function handleFocusSubmit() {
  const value = dom.focusInput.value.trim();
  if (value) {
    state.focus = value;
    state.focusDone = false;
    await saveState();
    // Sync to Hermes memory
    if (state.hermesEnabled && window.HorizonHermes) {
      window.HorizonHermes.setFocus(value);
    }
  }
  dom.focusInput.blur();
  renderFocus();
}

// ============================================================
// Local Folder Photos
// ============================================================

const LOCAL_DB = 'horizon-images';
const LOCAL_STORE = 'images';

function openImagesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE)) {
        db.createObjectStore(LOCAL_STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeImagesInDB(files, folderName) {
  const db = await openImagesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_STORE, 'readwrite');
    const store = tx.objectStore(LOCAL_STORE);
    
    // Clear old images
    store.clear();
    
    // Store new ones
    for (const file of files) {
      store.put({ name: file.name, data: file, folder: folderName });
    }
    
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function chooseLocalFolder() {
  try {
    const files = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.accept = 'image/*';
      input.onchange = () => {
        const imageFiles = Array.from(input.files || []).filter(f =>
          /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f.name)
        );
        resolve(imageFiles);
      };
      setTimeout(() => resolve([]), 120000);
      input.click();
    });

    if (files.length === 0) return false;

    const folderName = (files[0].webkitRelativePath || '').split('/')[0] || 'Wallpapers';
    await storeImagesInDB(files, folderName);
    
    state.localFolderName = `${folderName} (${files.length})`;
    saveState();
    return true;
  } catch {
    return false;
  }
}

async function getLocalImageUrl() {
  try {
    const db = await openImagesDB();
    return new Promise((resolve) => {
      const tx = db.transaction(LOCAL_STORE, 'readonly');
      const store = tx.objectStore(LOCAL_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const images = req.result;
        if (images.length === 0) return resolve(null);
        const random = images[Math.floor(Math.random() * images.length)];
        resolve(URL.createObjectURL(random.data));
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ============================================================
// Background
// ============================================================

// Curated keywords that produce Momentum-style dramatic photography
const PHOTO_KEYWORDS = {
  nature: 'mountain,sunset',
  water: 'ocean,waves',
  architecture: 'architecture,modern',
  city: 'city,night',
};

// Rotating keywords for variety within each category
const KEYWORD_POOLS = {
  nature: ['mountain sunrise', 'alpine lake', 'dramatic sky', 'sunset landscape', 'golden hour nature', 'foggy forest', 'aurora night', 'canyon vista'],
  water: ['ocean waves', 'tropical beach', 'aerial coastline', 'calm lake', 'crystal water', 'island paradise'],
  architecture: ['modern building', 'city skyline', 'glass architecture', 'bridges night', 'urban geometry', 'historic castle'],
  city: ['city night', 'tokyo streets', 'aerial city', 'urban sunset', 'city lights', 'skyline dusk'],
};

function getPhotoUrl(category) {
  // Pick a random keyword from the pool for variety
  const pool = KEYWORD_POOLS[category] || KEYWORD_POOLS.nature;
  const keyword = pool[Math.floor(Math.random() * pool.length)];
  // LoremFlickr supports multi-word keywords with commas
  const query = keyword.replace(/\s+/g, ',');
  return `https://loremflickr.com/1920/1080/${query}?random=${Date.now()}`;
}

// Unsplash API (optional — enter key in settings for premium photos)
const UNSPLASH_SEARCHES = {
  nature: 'dramatic landscape nature',
  water: 'ocean waves aerial',
  architecture: 'modern architecture dramatic',
  city: 'city skyline night',
};

async function fetchFromUnsplash(category) {
  const accessKey = state.unsplashKey;
  if (!accessKey) return null;

  const query = UNSPLASH_SEARCHES[category] || UNSPLASH_SEARCHES.nature;
  try {
    const resp = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&w=1920&h=1080`,
      { headers: { Authorization: `Client-ID ${accessKey}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.urls?.raw + '&w=1920&h=1080&fit=crop' || data.urls?.full;
  } catch {
    return null;
  }
}

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
  const category = state.photoCategory || 'nature';
  let resolved = false;

  const resolve = (url) => {
    if (resolved) return;
    resolved = true;
    dom.background.style.backgroundImage = `url(${url})`;
  };

  // Local folder takes priority
  if (state.photoSource === 'local') {
    const localUrl = await getLocalImageUrl();
    if (localUrl) {
      resolve(localUrl);
      return;
    }
    applyFallbackBackground();
    return;
  }

  // Try Unsplash API first (if key is configured)
  if (state.unsplashKey) {
    const unsplashUrl = await fetchFromUnsplash(category);
    if (unsplashUrl) {
      const img = new Image();
      img.onload = () => resolve(unsplashUrl);
      img.onerror = () => {}; // fall through
      img.src = unsplashUrl;
    }
  }

  // LoremFlickr with curated keywords
  if (!resolved) {
    const imageUrl = getPhotoUrl(category);
    const img = new Image();
    img.onload = () => resolve(imageUrl);
    img.onerror = () => {
      // Try Picsum as fallback
      const fallbackImg = new Image();
      fallbackImg.onload = () => resolve(`https://picsum.photos/1920/1080?random=${Date.now()}`);
      fallbackImg.onerror = () => applyFallbackBackground();
      fallbackImg.src = `https://picsum.photos/1920/1080?random=${Date.now()}`;
    };
    img.src = imageUrl;
  }

  setTimeout(() => {
    if (!resolved) applyFallbackBackground();
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

    // Reverse geocode for city name (BigDataCloud — CORS-friendly, free)
    try {
      const geoRes = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
      );
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        const city = geoData.city || geoData.locality || '';
        dom.weatherCity.textContent = city;
      }
    } catch {
      dom.weatherCity.textContent = '';
    }
  }
}

async function fetchWeatherByFallback() {
  // Austin, TX fallback when geolocation is denied
  const lat = 30.2672;
  const lon = -97.7431;
  await fetchWeatherByCoords(lat, lon);
}

async function fetchWeather() {
  try {
    // Try browser geolocation first
    const position = await requestGeolocation();
    await fetchWeatherByCoords(position.coords.latitude, position.coords.longitude);
  } catch {
    // Fall back to Austin, TX
    await fetchWeatherByFallback();
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

const QUOTES = [
  // Mark Twain
  '"The secret of getting ahead is getting started." — Mark Twain',
  '"Twenty years from now you will be more disappointed by the things you didn\'t do than by the ones you did." — Mark Twain',
  '"Continuous improvement is better than delayed perfection." — Mark Twain',
  '"The two most important days in your life are the day you are born and the day you find out why." — Mark Twain',

  // Alan Watts
  '"The only way to make sense out of change is to plunge into it, move with it, and join the dance." — Alan Watts',
  '"You are the universe experiencing itself." — Alan Watts',
  '"Muddy water is best cleared by leaving it alone." — Alan Watts',
  '"This is the real secret of life — to be completely engaged with what you are doing in the here and now." — Alan Watts',

  // Jiddu Krishnamurti
  '"It is no measure of health to be well adjusted to a profoundly sick society." — Jiddu Krishnamurti',
  '"The ability to observe without evaluating is the highest form of intelligence." — Jiddu Krishnamurti',
  '"In oneself lies the whole world and if you know how to look and learn, the door is there and the key is in your hand." — Jiddu Krishnamurti',

  // William James
  '"Act as if what you do makes a difference. It does." — William James',
  '"The greatest weapon against stress is our ability to choose one thought over another." — William James',
  '"The art of being wise is the art of knowing what to overlook." — William James',

  // Henry David Thoreau
  '"Go confidently in the direction of your dreams. Live the life you have imagined." — Henry David Thoreau',
  '"It\'s not what you look at that matters, it\'s what you see." — Henry David Thoreau',
  '"The price of anything is the amount of life you exchange for it." — Henry David Thoreau',
  '"Simplify, simplify." — Henry David Thoreau',

  // Ralph Waldo Emerson
  '"What lies behind us and what lies before us are tiny matters compared to what lies within us." — Ralph Waldo Emerson',
  '"To be yourself in a world that is constantly trying to make you something else is the greatest accomplishment." — Ralph Waldo Emerson',

  // Marcus Aurelius
  '"You have power over your mind — not outside events. Realize this, and you will find strength." — Marcus Aurelius',
  '"The happiness of your life depends upon the quality of your thoughts." — Marcus Aurelius',

  // Rumi
  '"Yesterday I was clever, so I wanted to change the world. Today I am wise, so I am changing myself." — Rumi',
  '"What you seek is seeking you." — Rumi',

  // Carl Jung
  '"Who looks outside, dreams; who looks inside, awakes." — Carl Jung',
  '"I am not what happened to me, I am what I choose to become." — Carl Jung',

  // Seneca
  '"We suffer more often in imagination than in reality." — Seneca',
  '"It is not that we have a short time to live, but that we waste a lot of it." — Seneca',

  // John Muir
  '"The mountains are calling and I must go." — John Muir',
  '"In every walk with nature one receives far more than he seeks." — John Muir',

  // Thich Nhat Hanh
  '"The present moment is filled with joy and happiness. If you are attentive, you will see it." — Thich Nhat Hanh',
];

function getRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

async function fetchQuote() {
  // Show a local quote immediately
  dom.quoteText.textContent = getRandomQuote();

  // Try to refresh from API in the background
  try {
    const response = await fetch('https://api.quotable.io/random?maxLength=120');
    if (response.ok) {
      const data = await response.json();
      dom.quoteText.textContent = `"${data.content}" — ${data.author}`;
    }
  } catch {
    // Keep the local quote — already set
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
  $('#setting-photo-source').value = state.photoSource;
  $('#setting-local-folder').value = state.localFolderName || '';
  $('#setting-photo-category').value = state.photoCategory;
  $('#setting-unsplash-key').value = state.unsplashKey || '';
  $('#setting-hermes').checked = state.hermesEnabled;
  $('#setting-hermes-url').value = state.hermesUrl;
  $('#hermes-url-label').style.display = state.hermesEnabled ? 'flex' : 'none';
}

function bindSettings() {
  $('#setting-name').oninput = (e) => { state.name = e.target.value.trim(); saveState(); updateGreeting(); };
  $('#setting-clock-format').onchange = (e) => { state.clockFormat = e.target.value; saveState(); updateClock(); };
  $('#setting-show-seconds').onchange = (e) => { state.showSeconds = e.target.checked; saveState(); };
  $('#setting-unit').onchange = (e) => { state.tempUnit = e.target.value; saveState(); fetchWeather(); };
  $('#setting-photo-source').onchange = (e) => {
    state.photoSource = e.target.value;
    saveState();
    fetchBackground();
  };
  $('#btn-choose-folder').onclick = async () => {
    const ok = await chooseLocalFolder();
    if (ok) {
      $('#setting-local-folder').value = state.localFolderName;
      fetchBackground();
    }
  };
  $('#setting-photo-category').onchange = (e) => { state.photoCategory = e.target.value; saveState(); fetchBackground(); };
  $('#setting-unsplash-key').oninput = (e) => { state.unsplashKey = e.target.value.trim(); saveState(); };
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
  // Dismiss briefing card if visible
  const briefing = document.getElementById('briefing');
  if (briefing) briefing.classList.add('hidden');
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
      if (state.hermesEnabled && window.HorizonHermes) {
        window.HorizonHermes.setFocus(focusText);
      }
      renderFocus();
      hideCommandBar();
    }
    return;
  }

  // If Hermes is enabled, query Hermes
  if (state.hermesEnabled && window.HorizonHermes) {
    dom.commandResults.innerHTML = '<div class="result-item"><div class="result-title">Thinking...</div></div>';
    dom.commandResults.classList.remove('hidden');
    
    try {
      const results = await window.HorizonHermes.query(query);
      if (results && results.length > 0) {
        renderCommandResults(results);
        return;
      }
    } catch {
      // Fall through to web search
    }
  }

  // Fallback: web search
  dom.commandResults.innerHTML = `
    <div class="result-item" style="cursor:pointer" onclick="window.location.href='https://www.google.com/search?q=${encodeURIComponent(query)}'">
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

    const action = r.action || 'search_web';
    const icon = { open_file: '📄', open_url: '🔗', compose_email: '✉️', view_calendar: '📅', copy_text: '📋', search_web: '🔍' }[action] || '→';

    let actionHandler;
    switch (action) {
      case 'open_file':
        actionHandler = () => {
          // Copy path to clipboard (browser can't open local files directly)
          navigator.clipboard.writeText(r.file_path || r.url || '').then(() => {
            div.querySelector('.result-detail').textContent = 'Path copied! Opening in Finder…';
          });
        };
        break;
      case 'open_url':
        actionHandler = () => { if (r.url) window.location.href = r.url; };
        break;
      case 'compose_email':
        actionHandler = () => {
          const to = r.email_to || '';
          const subject = r.email_subject || '';
          window.location.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}`;
        };
        break;
      case 'copy_text':
        actionHandler = () => {
          navigator.clipboard.writeText(r.copy_value || r.detail || '').then(() => {
            div.querySelector('.result-detail').textContent = 'Copied!';
          });
        };
        break;
      default:
        actionHandler = () => {
          if (r.url) window.location.href = r.url;
        };
    }

    div.innerHTML = `
      <div class="result-title">${icon} ${escapeHtml(r.title)}</div>
      <div class="result-detail">${escapeHtml(r.detail)}</div>
    `;
    div.onclick = actionHandler;
    dom.commandResults.appendChild(div);
  });
  dom.commandResults.classList.remove('hidden');
}

// ============================================================
// Hermes Briefing
// ============================================================

async function checkHermesBriefing() {
  if (!state.hermesEnabled || !window.HorizonHermes) return;

  try {
    const briefing = await window.HorizonHermes.getBriefing();
    if (briefing && briefing.focus_suggestion) {
      showBriefing(briefing);
    }
  } catch {
    // Hermes bridge not available — that's fine
  }
}

function showBriefing(briefing) {
  const widget = document.getElementById('briefing');
  if (!widget) return;

  document.getElementById('briefing-greeting').textContent = briefing.calendar_summary || '';
  document.getElementById('briefing-focus').textContent = briefing.focus_suggestion || '';
  document.getElementById('briefing-calendar').textContent = briefing.weather_note || '';
  document.getElementById('briefing-note').textContent = briefing.quick_note || '';
  document.getElementById('briefing-dismiss').onclick = () => widget.classList.add('hidden');
  
  widget.classList.remove('hidden');
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
  // Cmd/Ctrl + K — disabled (Hermes bridge WIP)
  /* if ((e.metaKey || e.ctrlKey) && e.key === 'k') { ... } */

  // Right arrow — next background photo (when not in an input)
  if (e.key === 'ArrowRight' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    fetchBackground();
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

  // Just start typing — disabled (Hermes bridge WIP)
  /*
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      showCommandBar();
      dom.commandInput.value = e.key;
    }
  }
  */
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

  // Background refresh
  const bgRefresh = $('#bg-refresh');
  if (bgRefresh) bgRefresh.onclick = fetchBackground;

  dom.commandInput.oninput = () => {
    clearTimeout(commandDebounce);
    commandDebounce = setTimeout(() => handleCommand(dom.commandInput.value), 300);
  };
  dom.commandInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommand(dom.commandInput.value);
    }
  };

  document.addEventListener('keydown', handleKeyboard);

  // Bind all settings handlers
  bindSettings();

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