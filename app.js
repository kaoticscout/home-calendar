/* ============================================================
   The Home Almanac — app.js
   ============================================================ */

const STORAGE_KEY = 'home-calendar-completions';
const TASKS_DATA_FILE = 'data.json';
const TASKS_STORAGE_KEY = 'home-calendar-tasks';
const EDIT_PASSWORD_KEY = 'home-calendar-edit-password';

let tasksApiBase = '/api/tasks';
let tasksApiRequiresPassword = false;

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const CATEGORY_CLASSES = {
  'Lawn & Garden':    'lawn',
  'Exterior':         'exterior',
  'HVAC':             'hvac',
  'Plumbing':         'plumbing',
  'Safety':           'safety',
  'Interior':         'interior',
  'Pest & Structure': 'pest',
  'Raspberries':      'raspberries',
  'Roses':            'roses',
  'Deck':             'deck',
  'Pickleball Court': 'pickleball',
  'Dogs & Pets':      'dogs',
  'Trees & Forest':   'pest',
};

// Meteorological seasons — 3 months each, Winter Y = Dec (Y−1) + Jan/Feb (Y)
const SEASONS = [
  { name: 'Winter', months: [12, 1, 2],  yearForMonth: (y, m) => (m === 12 ? y - 1 : y) },
  { name: 'Spring', months: [3, 4, 5],   yearForMonth: (y, m) => y },
  { name: 'Summer', months: [6, 7, 8],   yearForMonth: (y, m) => y },
  { name: 'Fall',   months: [9, 10, 11], yearForMonth: (y, m) => y },
];

// ── State ─────────────────────────────────────────────────────
let baseTasks             = [];
let allTasks              = [];
let taskCustomizations    = { deletedIds: [], modified: {}, added: [] };
let tasksApiAvailable     = false;
let completions           = {};
let currentSeason   = 0;    // index into SEASONS
let currentSeasonYear = new Date().getFullYear();
let currentView       = 'calendar'; // 'calendar' | 'list'

const CATEGORY_ORDER = [
  'Lawn & Garden',
  'Raspberries',
  'Roses',
  'Exterior',
  'Trees & Forest',
  'HVAC',
  'Deck',
  'Pickleball Court',
  'Plumbing',
  'Safety',
  'Interior',
  'Dogs & Pets',
];

const HANDWRITTEN_CHECK = `
  <span class="task-check" aria-hidden="true">
    <svg viewBox="0 0 22 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.5 9.8c1.4-0.6 2.2 2.8 3.8 4.2 1.8-3.2 4.8-6.8 10.2-10.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>`;

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  completions = loadCompletions();

  try {
    allTasks = await loadTasks();
    if (tasksApiAvailable) {
      await migrateLocalStorageTasksIfNeeded();
    }
  } catch (err) {
    document.getElementById('calendar-grid').innerHTML =
      `<p class="loading-message">Could not load tasks — ${err.message}</p>`;
    return;
  }

  initSeasonFromToday();
  renderAll();
  updateStats();
}

function initSeasonFromToday() {
  const today = new Date();
  const m = today.getMonth() + 1;
  const y = today.getFullYear();

  if (m >= 3 && m <= 5) {
    currentSeason = 1;
    currentSeasonYear = y;
  } else if (m >= 6 && m <= 8) {
    currentSeason = 2;
    currentSeasonYear = y;
  } else if (m >= 9 && m <= 11) {
    currentSeason = 3;
    currentSeasonYear = y;
  } else if (m === 12) {
    currentSeason = 0;
    currentSeasonYear = y + 1;
  } else {
    currentSeason = 0;
    currentSeasonYear = y;
  }
}

function getSeasonMonths() {
  const season = SEASONS[currentSeason];
  return season.months.map(month => ({
    month,
    year: season.yearForMonth(currentSeasonYear, month),
  }));
}

function getSeasonLabel() {
  return `${SEASONS[currentSeason].name} — ${currentSeasonYear}`;
}

// ── LocalStorage helpers ───────────────────────────────────────
function loadCompletions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCompletions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(completions));
}

function getLastDone(taskId) {
  const records = completions[taskId];
  if (!records || records.length === 0) return null;
  // Return the most recent
  return records
    .map(r => r.doneDate)
    .sort()
    .at(-1);
}

function markDone(taskId, dateStr) {
  if (!completions[taskId]) completions[taskId] = [];
  const [y, m] = dateStr.split('-').map(Number);
  // Replace any existing record for the same year-month
  completions[taskId] = completions[taskId].filter(r => {
    const [ry, rm] = r.doneDate.split('-').map(Number);
    return !(ry === y && rm === m);
  });
  completions[taskId].push({ doneDate: dateStr });
  saveCompletions();
}

function clearDoneForMonth(taskId, year, month) {
  const records = completions[taskId];
  if (!records) return;

  const remaining = records.filter(r => {
    const [y, m] = r.doneDate.split('-').map(Number);
    return !(y === year && m === month);
  });

  if (remaining.length === 0) {
    delete completions[taskId];
  } else {
    completions[taskId] = remaining;
  }
  saveCompletions();
}

// ── Task persistence (data.json via API or static file) ─────────

function getTasksApiCandidates() {
  const candidates = [];
  const isLocal =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if (isLocal) candidates.push('/api/tasks');
  if (window.ALMANAC_CONFIG?.tasksApi) candidates.push(window.ALMANAC_CONFIG.tasksApi);
  if (!isLocal) candidates.push('/api/tasks');

  return [...new Set(candidates)];
}

async function resolveTasksApi() {
  for (const url of getTasksApiCandidates()) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) continue;

      tasksApiBase = url;
      tasksApiRequiresPassword =
        url !== '/api/tasks' &&
        window.ALMANAC_CONFIG?.requiresEditPassword !== false;
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function loadTasksFromFile() {
  const res = await fetch(TASKS_DATA_FILE);
  if (!res.ok) throw new Error('Failed to load data.json');
  const data = await res.json();
  return data.tasks;
}

async function loadTasks() {
  tasksApiAvailable = await resolveTasksApi();
  if (tasksApiAvailable) {
    baseTasks = await loadTasksFromServer();
    return baseTasks;
  }
  baseTasks = await loadTasksFromFile();
  taskCustomizations = loadTaskCustomizations();
  return mergeTaskCustomizations(baseTasks, taskCustomizations);
}

function loadTaskCustomizations() {
  try {
    const raw = JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY) || '{}');
    return {
      deletedIds: Array.isArray(raw.deletedIds) ? raw.deletedIds : [],
      modified: raw.modified && typeof raw.modified === 'object' ? raw.modified : {},
      added: Array.isArray(raw.added) ? raw.added : [],
    };
  } catch {
    return { deletedIds: [], modified: {}, added: [] };
  }
}

function saveTaskCustomizations() {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(taskCustomizations));
}

function mergeTaskCustomizations(tasks, custom) {
  const merged = tasks
    .filter(t => !custom.deletedIds.includes(t.id))
    .map(t => custom.modified[t.id] || t);
  return [...merged, ...custom.added];
}

function refreshAllTasks() {
  if (tasksApiAvailable) return;
  allTasks = mergeTaskCustomizations(baseTasks, taskCustomizations);
}

function isCustomAddedTask(taskId) {
  return taskCustomizations.added.some(t => t.id === taskId);
}

async function loadTasksFromServer() {
  const res = await fetch(tasksApiBase);
  if (!res.ok) throw new Error('Failed to load tasks from server');
  const data = await res.json();
  return data.tasks;
}

function getEditPassword() {
  let password = sessionStorage.getItem(EDIT_PASSWORD_KEY);
  if (password) return password;

  password = prompt('Enter the edit password to save changes:');
  if (password) sessionStorage.setItem(EDIT_PASSWORD_KEY, password);
  return password;
}

function clearEditPassword() {
  sessionStorage.removeItem(EDIT_PASSWORD_KEY);
}

async function apiRequest(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (tasksApiRequiresPassword && method !== 'GET') {
    const password = getEditPassword();
    if (!password) throw new Error('Edit password required');
    headers['X-Edit-Password'] = password;
  }

  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }

  if (res.status === 401 && tasksApiRequiresPassword) {
    clearEditPassword();
    throw new Error('Wrong edit password');
  }

  if (!res.ok) {
    throw new Error(payload.error || `Request failed (${res.status})`);
  }

  return payload;
}

function loadLegacyTaskCustomizations() {
  return loadTaskCustomizations();
}

function mergeLegacyCustomizations(baseTasks, custom) {
  return mergeTaskCustomizations(baseTasks, custom);
}

async function migrateLocalStorageTasksIfNeeded() {
  const custom = loadLegacyTaskCustomizations();
  const hasChanges =
    custom.deletedIds.length > 0 ||
    Object.keys(custom.modified).length > 0 ||
    custom.added.length > 0;

  if (!hasChanges) return;

  const merged = mergeLegacyCustomizations(allTasks, custom);
  const unchanged =
    merged.length === allTasks.length &&
    merged.every((task, i) => JSON.stringify(task) === JSON.stringify(allTasks[i]));

  if (unchanged) {
    localStorage.removeItem(TASKS_STORAGE_KEY);
    return;
  }

  for (const id of custom.deletedIds) {
    if (allTasks.some(t => t.id === id)) {
      const data = await apiRequest('DELETE', `${tasksApiBase}/${encodeURIComponent(id)}`);
      allTasks = data.tasks;
    }
  }

  for (const task of Object.values(custom.modified)) {
    if (allTasks.some(t => t.id === task.id)) {
      const data = await apiRequest('PUT', `${tasksApiBase}/${encodeURIComponent(task.id)}`, task);
      allTasks = data.tasks;
    }
  }

  for (const task of custom.added) {
    if (!allTasks.some(t => t.id === task.id)) {
      const data = await apiRequest('POST', tasksApiBase, task);
      allTasks = data.tasks;
    }
  }

  localStorage.removeItem(TASKS_STORAGE_KEY);
}

function generateTaskId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'task';
  return `custom-${slug}-${Date.now()}`;
}

async function saveTaskRecord(task) {
  if (tasksApiAvailable) {
    const data = await apiRequest('PUT', `${tasksApiBase}/${encodeURIComponent(task.id)}`, task);
    allTasks = data.tasks;
    return;
  }

  if (isCustomAddedTask(task.id)) {
    const idx = taskCustomizations.added.findIndex(t => t.id === task.id);
    if (idx >= 0) taskCustomizations.added[idx] = task;
  } else {
    taskCustomizations.modified[task.id] = task;
  }
  saveTaskCustomizations();
  refreshAllTasks();
}

async function addTaskRecord(task) {
  if (tasksApiAvailable) {
    const data = await apiRequest('POST', tasksApiBase, task);
    allTasks = data.tasks;
    return;
  }

  taskCustomizations.added.push(task);
  saveTaskCustomizations();
  refreshAllTasks();
}

async function deleteTaskRecord(taskId) {
  if (tasksApiAvailable) {
    const data = await apiRequest('DELETE', `${tasksApiBase}/${encodeURIComponent(taskId)}`);
    allTasks = data.tasks;
    delete completions[taskId];
    saveCompletions();
    return;
  }

  if (isCustomAddedTask(taskId)) {
    taskCustomizations.added = taskCustomizations.added.filter(t => t.id !== taskId);
  } else {
    if (!taskCustomizations.deletedIds.includes(taskId)) {
      taskCustomizations.deletedIds.push(taskId);
    }
    delete taskCustomizations.modified[taskId];
  }
  delete completions[taskId];
  saveTaskCustomizations();
  saveCompletions();
  refreshAllTasks();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Schedule logic ─────────────────────────────────────────────

/**
 * Returns an array of 1-based month numbers (1–12) where
 * this task is due in the given year.
 */
function getDueMonthsForYear(task, year) {
  const schedule = task.schedule;

  if (schedule.type === 'months-of-year') {
    return schedule.months;
  }

  if (schedule.type === 'every-n-years') {
    const defaultMonth = schedule.defaultMonth || 6;
    const months = new Set();
    const lastDone = getLastDone(task.id);

    if (!lastDone) {
      months.add(defaultMonth);
    } else {
      const [doneY, doneM] = lastDone.split('-').map(Number);
      const nextDueYear = doneY + schedule.years;
      if (year >= nextDueYear) {
        months.add(doneM);
      }
    }

    // Keep tasks visible in any month they were completed this year
    (completions[task.id] || []).forEach(r => {
      const [y, m] = r.doneDate.split('-').map(Number);
      if (y === year) months.add(m);
    });

    return [...months].sort((a, b) => a - b);
  }

  if (schedule.type === 'every-n-months') {
    const interval = schedule.months;
    const result = [];
    for (let m = schedule.defaultMonth || 1; m <= 12; m += interval) {
      result.push(m);
    }
    return result;
  }

  return [];
}

/**
 * For a task with an interval schedule, determine if it is
 * "overdue" — i.e. the computed next due date is already past.
 */
function isOverdue(task) {
  const schedule = task.schedule;
  const today = new Date();

  if (schedule.type === 'every-n-years') {
    const lastDone = getLastDone(task.id);
    if (!lastDone) return false; // never done — just pending
    const doneDate = new Date(lastDone);
    const nextDue  = new Date(doneDate);
    nextDue.setFullYear(nextDue.getFullYear() + schedule.years);
    return nextDue < today;
  }

  if (schedule.type === 'every-n-months') {
    const lastDone = getLastDone(task.id);
    if (!lastDone) return false;
    const doneDate = new Date(lastDone);
    const nextDue  = new Date(doneDate);
    nextDue.setMonth(nextDue.getMonth() + schedule.months);
    return nextDue < today;
  }

  return false;
}

/**
 * Is this task done for the given month/year?
 * For fixed-month tasks: any completion in that year-month counts.
 * For interval tasks: a completion after the computed due date counts.
 */
function isDoneForMonth(task, year, month) {
  const records = completions[task.id];
  if (!records || records.length === 0) return false;

  const schedule = task.schedule;

  if (schedule.type === 'months-of-year') {
    return records.some(r => {
      const [y, m] = r.doneDate.split('-').map(Number);
      return y === year && m === month;
    });
  }

  if (schedule.type === 'every-n-years') {
    return records.some(r => {
      const [y] = r.doneDate.split('-').map(Number);
      return y === year;
    });
  }

  if (schedule.type === 'every-n-months') {
    return records.some(r => {
      const [y, m] = r.doneDate.split('-').map(Number);
      return y === year && m === month;
    });
  }

  return false;
}

function formatMonthList(monthNums) {
  const names = monthNums.map(m => MONTH_NAMES[m - 1]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function formatSchedule(task) {
  const schedule = task.schedule;

  if (schedule.type === 'months-of-year') {
    return `${formatMonthList(schedule.months)}, yearly`;
  }

  if (schedule.type === 'every-n-years') {
    const month = MONTH_NAMES[(schedule.defaultMonth || 6) - 1];
    const years = schedule.years;
    return `Every ${years} year${years === 1 ? '' : 's'} · ${month}`;
  }

  if (schedule.type === 'every-n-months') {
    const n = schedule.months;
    return `Every ${n} month${n === 1 ? '' : 's'}`;
  }

  return '';
}

// ── Rendering ─────────────────────────────────────────────────

function renderAll() {
  updateViewMode();
  if (currentView === 'calendar') {
    renderSeasonDisplay();
    renderGrid();
  } else {
    renderListView();
  }
  updateStats();
  updateViewToggleLabel();
}

function updateViewMode() {
  const wrapper = document.querySelector('.page-wrapper');
  const seasonDisplay = document.getElementById('year-display');
  const calendarGrid = document.getElementById('calendar-grid');
  const listView = document.getElementById('list-view');
  const prevBtn = document.getElementById('prev-year');
  const nextBtn = document.getElementById('next-year');

  const isList = currentView === 'list';
  wrapper?.classList.toggle('view-list', isList);

  if (seasonDisplay) seasonDisplay.hidden = isList;
  if (calendarGrid) calendarGrid.hidden = isList;
  if (listView) listView.hidden = !isList;
  if (prevBtn) prevBtn.hidden = isList;
  if (nextBtn) nextBtn.hidden = isList;
}

function updateViewToggleLabel() {
  const btn = document.getElementById('view-toggle');
  if (!btn) return;
  btn.textContent = currentView === 'calendar' ? 'Full task list' : 'Back to calendar';
}

function renderListView() {
  const container = document.getElementById('list-view');
  if (!container) return;

  container.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'task-list-toolbar';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'task-list-add-btn';
  addBtn.textContent = '+ Add task';
  addBtn.addEventListener('click', () => openTaskEditor('add'));
  toolbar.appendChild(addBtn);
  container.appendChild(toolbar);

  if (!tasksApiAvailable) {
    const note = document.createElement('p');
    note.className = 'task-list-readonly-note';
    note.textContent = 'Task edits on this site are saved in your browser on this device.';
    container.appendChild(note);
  } else if (tasksApiRequiresPassword) {
    const note = document.createElement('p');
    note.className = 'task-list-readonly-note';
    note.textContent = 'Task edits are shared with everyone. You\u2019ll be prompted for the edit password when saving.';
    container.appendChild(note);
  }

  const byCategory = {};
  allTasks.forEach(task => {
    if (!byCategory[task.category]) byCategory[task.category] = [];
    byCategory[task.category].push(task);
  });

  const categoriesWithTasks = CATEGORY_ORDER.filter(c => byCategory[c]?.length);
  const extraCategories = Object.keys(byCategory)
    .filter(c => !CATEGORY_ORDER.includes(c))
    .sort();

  [...categoriesWithTasks, ...extraCategories].forEach(category => {
    const tasks = byCategory[category];
    if (!tasks || tasks.length === 0) return;

    tasks.sort((a, b) => a.name.localeCompare(b.name));

    const section = document.createElement('section');
    section.className = 'task-list-section';

    const catKey = CATEGORY_CLASSES[category] || 'interior';
    const heading = document.createElement('h2');
    heading.className = 'task-list-category';
    heading.innerHTML = `
      <span class="task-list-category-dot dot-${catKey}"></span>
      ${escapeHtml(category)}
    `;
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'task-list-catalog';

    tasks.forEach(task => {
      const li = document.createElement('li');
      li.className = 'task-list-row';
      li.innerHTML = `
        <span class="task-list-row-dot dot-${catKey}"></span>
        <span class="task-list-row-name">${escapeHtml(task.name)}</span>
        <span class="task-list-row-freq">${escapeHtml(formatSchedule(task))}</span>
        <span class="task-list-row-actions">
          <button type="button" class="task-list-action task-list-action--edit" aria-label="Edit ${escapeHtml(task.name)}">Edit</button>
          <button type="button" class="task-list-action task-list-action--delete" aria-label="Delete ${escapeHtml(task.name)}">Delete</button>
        </span>
      `;

      li.querySelector('.task-list-action--edit').addEventListener('click', () => {
        openTaskEditor('edit', task);
      });
      li.querySelector('.task-list-action--delete').addEventListener('click', () => {
        deleteTaskWithConfirm(task);
      });

      list.appendChild(li);
    });

    section.appendChild(list);
    container.appendChild(section);
  });
}

function renderSeasonDisplay() {
  document.getElementById('year-display').textContent = getSeasonLabel();
}

function renderGrid() {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const today = new Date();
  const todayYear  = today.getFullYear();
  const todayMonth = today.getMonth() + 1;

  getSeasonMonths().forEach(({ month, year }) => {
    grid.appendChild(buildMonthCard(month, year, todayYear, todayMonth));
  });
}

function buildMonthCard(month, year, todayYear, todayMonth) {
  const isCurrentMonth = (year === todayYear && month === todayMonth);

  const dueTasks = allTasks.filter(task => {
    const dueMonths = getDueMonthsForYear(task, year);
    return dueMonths.includes(month);
  });

  const card = document.createElement('div');
  card.className = 'month-card' + (isCurrentMonth ? ' current-month' : '');
  card.dataset.month = month;
  card.dataset.year = year;

  card.innerHTML = `
    <div class="month-name">${MONTH_NAMES[month - 1]}</div>
    <div class="month-card-divider">
      <svg class="botanical-icon" viewBox="0 0 48 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M0 6 Q6 1 12 6 Q18 11 24 6 Q30 1 36 6 Q42 11 48 6" stroke="currentColor" stroke-width="1.2" fill="none" opacity="0.6"/>
        <ellipse cx="12" cy="3" rx="3" ry="2" fill="currentColor" opacity="0.35" transform="rotate(-20 12 3)"/>
        <ellipse cx="36" cy="9" rx="3" ry="2" fill="currentColor" opacity="0.35" transform="rotate(20 36 9)"/>
      </svg>
    </div>
  `;

  if (dueTasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'month-empty';
    empty.textContent = 'restful month';
    card.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'task-list';

    dueTasks.forEach(task => {
      const done    = isDoneForMonth(task, year, month);
      const overdue = !done && isOverdue(task);
      const isNow   = !done && isCurrentMonth;

      const li = document.createElement('li');
      li.className = 'task-item';

      const catKey = CATEGORY_CLASSES[task.category] || 'interior';
      let chipClass = 'task-chip';
      if (done)   chipClass += ' done';
      else if (overdue) chipClass += ' overdue';
      else if (isNow)   chipClass += ' due-now';

      const btn = document.createElement('button');
      btn.className = chipClass;
      btn.dataset.taskId = task.id;
      btn.dataset.month  = month;
      btn.dataset.year   = year;
      btn.setAttribute('aria-label', done ? `${task.name} — completed, click to unmark` : `${task.name} — click to log`);
      btn.innerHTML = done
        ? `${HANDWRITTEN_CHECK}<span class="task-chip-label">${task.name}</span>`
        : `<span class="task-dot dot-${catKey}"></span><span class="task-chip-label">${task.name}</span>`;
      btn.addEventListener('click', () => {
        toggleTaskCompletion(task, month, year);
      });

      li.appendChild(btn);
      list.appendChild(li);
    });

    card.appendChild(list);

    const doneCount = dueTasks.filter(t => isDoneForMonth(t, year, month)).length;
    const count = document.createElement('p');
    count.className = 'month-task-count';
    count.textContent = doneCount === dueTasks.length
      ? '✓ all done'
      : `${doneCount} of ${dueTasks.length} done`;
    card.appendChild(count);
  }

  return card;
}

function todayDateStr() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/** Date stored when marking done from a specific month card */
function completionDateForMonth(year, month) {
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;

  if (year === todayYear && month === todayMonth) {
    return todayDateStr();
  }

  const lastDay = new Date(year, month, 0).getDate();
  const day = Math.min(today.getDate(), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toggleTaskCompletion(task, month, year) {
  if (isDoneForMonth(task, year, month)) {
    clearDoneForMonth(task.id, year, month);
  } else {
    markDone(task.id, completionDateForMonth(year, month));
  }
  renderGrid();
  updateStats();
}

// ── Stats ─────────────────────────────────────────────────────

function updateStats() {
  const today = new Date();
  const todayYear  = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const statsYear  = todayYear;

  let totalDue = 0;
  let totalDone = 0;
  let overdueCount = 0;

  for (let month = 1; month <= 12; month++) {
    allTasks.forEach(task => {
      const dueMonths = getDueMonthsForYear(task, statsYear);
      if (!dueMonths.includes(month)) return;
      totalDue++;
      if (isDoneForMonth(task, statsYear, month)) {
        totalDone++;
      } else if (statsYear < todayYear || (statsYear === todayYear && month < todayMonth)) {
        if (isOverdue(task) || task.schedule.type === 'months-of-year') {
          overdueCount++;
        }
      }
    });
  }

  const el = document.getElementById('stats-bar');
  if (!el) return;

  el.innerHTML = `
    <div class="stat-item">
      <span class="stat-number">${totalDue}</span>
      <span class="stat-label">Tasks This Year</span>
    </div>
    <div class="stat-item">
      <span class="stat-number">${totalDone}</span>
      <span class="stat-label">Completed</span>
    </div>
    <div class="stat-item">
      <span class="stat-number" style="color: var(--terracotta)">${overdueCount}</span>
      <span class="stat-label">Past Due</span>
    </div>
  `;
}

// ── Season navigation ────────────────────────────────────────────

function goPrevSeason() {
  if (currentSeason === 0) {
    currentSeason = 3;
    currentSeasonYear--;
  } else {
    currentSeason--;
  }
}

function goNextSeason() {
  if (currentSeason === 3) {
    currentSeason = 0;
    currentSeasonYear++;
  } else {
    currentSeason++;
  }
}

document.getElementById('prev-year').addEventListener('click', () => {
  goPrevSeason();
  renderAll();
});

document.getElementById('next-year').addEventListener('click', () => {
  goNextSeason();
  renderAll();
});

document.getElementById('view-toggle').addEventListener('click', () => {
  currentView = currentView === 'calendar' ? 'list' : 'calendar';
  renderAll();
});

// ── Task editor modal ───────────────────────────────────────────

let editorMode = 'add';
let editorTaskId = null;

function openTaskEditor(mode, task = null) {
  editorMode = mode;
  editorTaskId = task?.id ?? null;

  const overlay = document.getElementById('task-editor');
  const title = document.getElementById('task-editor-title');
  const form = document.getElementById('task-editor-form');
  const deleteBtn = document.getElementById('task-editor-delete');

  title.textContent = mode === 'add' ? 'Add task' : 'Edit task';
  deleteBtn.hidden = mode !== 'edit';

  form.elements.name.value = task?.name ?? '';
  form.elements.category.value = task?.category ?? CATEGORY_ORDER[0];

  const scheduleType = task?.schedule?.type ?? 'months-of-year';
  form.elements.scheduleType.value = scheduleType;

  resetMonthCheckboxes(form);
  if (task?.schedule?.type === 'months-of-year') {
    task.schedule.months.forEach(m => {
      const cb = form.querySelector(`input[name="month-${m}"]`);
      if (cb) cb.checked = true;
    });
  } else if (mode === 'add') {
    const june = form.querySelector('input[name="month-6"]');
    if (june) june.checked = true;
  }

  form.elements.intervalYears.value = task?.schedule?.years ?? 2;
  form.elements.intervalMonths.value = task?.schedule?.months ?? 3;
  form.elements.defaultMonthYears.value = String(task?.schedule?.defaultMonth ?? 6);
  form.elements.defaultMonthInterval.value = String(task?.schedule?.defaultMonth ?? 1);

  updateScheduleFields(form);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  form.elements.name.focus();
}

function closeTaskEditor() {
  const overlay = document.getElementById('task-editor');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  editorMode = 'add';
  editorTaskId = null;
}

function resetMonthCheckboxes(form) {
  for (let m = 1; m <= 12; m++) {
    const cb = form.querySelector(`input[name="month-${m}"]`);
    if (cb) cb.checked = false;
  }
}

function updateScheduleFields(form) {
  const type = form.elements.scheduleType.value;
  form.querySelector('[data-schedule="months-of-year"]').hidden = type !== 'months-of-year';
  form.querySelector('[data-schedule="every-n-years"]').hidden = type !== 'every-n-years';
  form.querySelector('[data-schedule="every-n-months"]').hidden = type !== 'every-n-months';
}

function buildScheduleFromForm(form) {
  const type = form.elements.scheduleType.value;

  if (type === 'months-of-year') {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      if (form.querySelector(`input[name="month-${m}"]`)?.checked) {
        months.push(m);
      }
    }
    return { type, months: months.sort((a, b) => a - b) };
  }

  if (type === 'every-n-years') {
    return {
      type,
      years: Math.max(1, parseInt(form.elements.intervalYears.value, 10) || 1),
      defaultMonth: parseInt(form.elements.defaultMonthYears.value, 10) || 6,
    };
  }

  if (type === 'every-n-months') {
    return {
      type,
      months: Math.max(1, parseInt(form.elements.intervalMonths.value, 10) || 1),
      defaultMonth: parseInt(form.elements.defaultMonthInterval.value, 10) || 1,
    };
  }

  return { type: 'months-of-year', months: [6] };
}

async function handleTaskEditorSubmit(event) {
  event.preventDefault();
  const form = event.target;

  const name = form.elements.name.value.trim();
  if (!name) {
    form.elements.name.focus();
    return;
  }

  const category = form.elements.category.value;
  const schedule = buildScheduleFromForm(form);

  if (schedule.type === 'months-of-year' && schedule.months.length === 0) {
    alert('Pick at least one month for this task.');
    return;
  }

  const notes = editorMode === 'edit'
    ? (allTasks.find(t => t.id === editorTaskId)?.notes ?? '')
    : '';

  const submitBtn = form.querySelector('[type="submit"]');
  submitBtn.disabled = true;

  try {
    if (editorMode === 'add') {
      await addTaskRecord({
        id: generateTaskId(name),
        name,
        category,
        schedule,
        notes,
      });
    } else {
      await saveTaskRecord({
        id: editorTaskId,
        name,
        category,
        schedule,
        notes,
      });
    }

    closeTaskEditor();
    renderAll();
  } catch (err) {
    alert(`Could not save task: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteTaskWithConfirm(task) {
  if (!confirm(`Remove “${task.name}” from your almanac?`)) return;

  try {
    await deleteTaskRecord(task.id);
    renderAll();
  } catch (err) {
    alert(`Could not delete task: ${err.message}`);
  }
}

function initTaskEditor() {
  const overlay = document.getElementById('task-editor');
  const form = document.getElementById('task-editor-form');
  if (!overlay || !form) return;

  form.addEventListener('submit', handleTaskEditorSubmit);
  form.elements.scheduleType.addEventListener('change', () => updateScheduleFields(form));

  overlay.querySelector('.task-editor-backdrop').addEventListener('click', closeTaskEditor);
  document.getElementById('task-editor-cancel').addEventListener('click', closeTaskEditor);
  document.getElementById('task-editor-delete').addEventListener('click', async () => {
    const task = allTasks.find(t => t.id === editorTaskId);
    if (task) {
      closeTaskEditor();
      await deleteTaskWithConfirm(task);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeTaskEditor();
  });
}

initTaskEditor();

// ── Start ─────────────────────────────────────────────────────
init();
