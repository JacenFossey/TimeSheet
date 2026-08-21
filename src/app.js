(() => {
  'use strict';

  const STEP = 15;
  const START = 4 * 60 + 30;
  const END = 22 * 60 + 30;
  const VIEW_COPY = {
    today: ['Today', 'Follow the plan, then record what happened.'],
    report: ['Weekly report', 'A concise view you can send without cleanup.'],
    settings: ['Settings', 'Keep categories and report delivery simple.'],
  };

  const SLOTS = [];
  for (let minutes = START; minutes < END; minutes += STEP) {
    SLOTS.push({ key: minutesToKey(minutes), minutes });
  }

  let currentDate = todayString();
  let weekAnchor = mondayOf(currentDate);
  let categories = [];
  let categoryMap = {};
  let standardConfig = null;
  let standardDraft = null;
  let activeStandardTemplate = null;
  let dayData = {};
  let editorBlocks = [];
  let correctionRange = null;
  let saveQueue = Promise.resolve();

  const $ = id => document.getElementById(id);

  function minutesToKey(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function keyToMinutes(key) {
    const [hour, minute] = key.split(':').map(Number);
    return hour * 60 + minute;
  }

  function timeLabel(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${hour12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  }

  function shortTime(minutes) {
    return timeLabel(minutes).replace(' ', '').toLowerCase();
  }

  function todayString() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function offsetDate(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function dateObject(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function mondayOf(dateString) {
    const date = dateObject(dateString);
    const day = date.getDay();
    return offsetDate(dateString, -(day === 0 ? 6 : day - 1));
  }

  function formatDate(dateString, options) {
    return dateObject(dateString).toLocaleDateString('en-CA', options);
  }

  function category(id) {
    return categoryMap[id] || { id: id || 'none', label: id || 'None', color: '#95a29b' };
  }

  function activeCategories() {
    return categories.filter(item => item.id !== 'none' && !item.archived);
  }

  function defaultTemplateName(templateId) {
    if (templateId === 'ontario') return 'Ontario day';
    if (templateId === 'montreal') return 'Montreal / Flex day';
    return templateId.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function normalizeStandardConfig(config) {
    const normalized = config && typeof config === 'object' ? config : {};
    normalized.templates = normalized.templates && typeof normalized.templates === 'object' ? normalized.templates : {};
    normalized.templateNames = normalized.templateNames && typeof normalized.templateNames === 'object' ? normalized.templateNames : {};
    Object.keys(normalized.templates).forEach(templateId => {
      if (!Array.isArray(normalized.templates[templateId])) normalized.templates[templateId] = [];
      if (!String(normalized.templateNames[templateId] || '').trim()) normalized.templateNames[templateId] = defaultTemplateName(templateId);
    });
    normalized.week = normalized.week && typeof normalized.week === 'object' ? normalized.week : {};
    const firstTemplate = Object.keys(normalized.templates)[0];
    ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(day => {
      if (!normalized.templates[normalized.week[day]]) normalized.week[day] = firstTemplate;
    });
    return normalized;
  }

  function templateName(config, templateId) {
    return config?.templateNames?.[templateId] || defaultTemplateName(templateId || 'standard_day');
  }

  function standardPlan(dateString) {
    const day = dateObject(dateString).getDay();
    if (day === 0 || day === 6) return [];
    const weekdayKeys = ['', 'mon', 'tue', 'wed', 'thu', 'fri'];
    const templateId = standardConfig?.week?.[weekdayKeys[day]] || (day === 3 ? 'montreal' : 'ontario');
    const blocks = standardConfig?.templates?.[templateId] || [];
    return blocks.map(block => ({
      start: keyToMinutes(block.start),
      end: keyToMinutes(block.end),
      cat: block.cat,
      text: block.text || '',
    }));
  }

  function themeFor(dateString) {
    const day = dateObject(dateString).getDay();
    if (day === 0 || day === 6) return 'Weekend';
    const weekdayKeys = ['', 'mon', 'tue', 'wed', 'thu', 'fri'];
    const templateId = standardConfig?.week?.[weekdayKeys[day]] || (day === 3 ? 'montreal' : 'ontario');
    return templateName(standardConfig, templateId);
  }

  function groupedBlocks(data, side) {
    const blocks = [];
    for (const slot of SLOTS) {
      const entry = data[slot.key]?.[side];
      if (!entry || (entry.cat === 'none' && !entry.text)) continue;
      const previous = blocks[blocks.length - 1];
      if (previous && previous.end === slot.minutes && previous.cat === entry.cat && previous.text === (entry.text || '')) {
        previous.end += STEP;
        previous.keys.push(slot.key);
      } else {
        blocks.push({ start: slot.minutes, end: slot.minutes + STEP, cat: entry.cat || 'none', text: entry.text || '', keys: [slot.key] });
      }
    }
    return blocks;
  }

  function fillRange(data, side, start, end, cat, text, onlyEmpty = false) {
    SLOTS.filter(slot => slot.minutes >= start && slot.minutes < end).forEach(slot => {
      data[slot.key] ||= {};
      const existing = data[slot.key][side];
      if (!onlyEmpty || !existing || (existing.cat === 'none' && !existing.text)) {
        data[slot.key][side] = { cat, text };
      }
    });
  }

  function clearSide(data, side) {
    Object.keys(data).forEach(key => {
      if (data[key] && typeof data[key] === 'object') delete data[key][side];
      if (data[key] && Object.keys(data[key]).length === 0) delete data[key];
    });
  }

  function clearRange(data, side, start, end) {
    SLOTS.filter(slot => slot.minutes >= start && slot.minutes < end).forEach(slot => {
      if (data[slot.key] && typeof data[slot.key] === 'object') delete data[slot.key][side];
      if (data[slot.key] && Object.keys(data[slot.key]).length === 0) delete data[slot.key];
    });
  }

  async function queuedSave(operation) {
    $('saveStatus').textContent = 'Saving…';
    saveQueue = saveQueue.catch(() => {}).then(operation);
    try {
      await saveQueue;
      $('saveStatus').textContent = 'Saved';
      window.setTimeout(() => { if ($('saveStatus').textContent === 'Saved') $('saveStatus').textContent = ''; }, 1400);
    } catch (error) {
      $('saveStatus').textContent = 'Save failed';
      throw error;
    }
  }

  function setStatus(id, message, isError = false) {
    const element = $(id);
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  function metric(value, label) {
    const item = document.createElement('div');
    item.className = 'metric';
    const number = document.createElement('div');
    number.className = 'metric-value';
    number.textContent = value;
    const caption = document.createElement('div');
    caption.className = 'metric-label';
    caption.textContent = label;
    item.append(number, caption);
    return item;
  }

  function activateView(view) {
    document.querySelectorAll('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    document.querySelectorAll('.view').forEach(panel => panel.classList.toggle('active', panel.id === `view-${view}`));
    $('pageHeading').textContent = VIEW_COPY[view][0];
    $('pageKicker').textContent = VIEW_COPY[view][1];
    $('content').scrollTop = 0;
    if (view === 'today') closePlanEditor();
    if (view === 'report') renderReport();
    if (view === 'settings') {
      renderStandardPlanSettings();
      renderCategorySettings();
    }
  }

  async function loadCurrentDay() {
    setStatus('dailyReportStatus', '');
    dayData = await window.ts.loadDay(currentDate);
    await renderDay();
  }

  function daySummary(data, dateString) {
    let plannedTotal = 0;
    let actualTotal = 0;
    let adherencePlanned = 0;
    let matched = 0;
    let unaccounted = 0;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    for (const slot of SLOTS) {
      const planned = data[slot.key]?.planned || { cat: 'none' };
      const actual = data[slot.key]?.actual || { cat: 'none' };
      const hasPlanned = planned.cat !== 'none' || planned.text;
      const hasActual = actual.cat !== 'none' || actual.text;
      const elapsed = dateString < todayString() || (dateString === todayString() && slot.minutes + STEP <= currentMinutes);
      if (hasPlanned) plannedTotal++;
      if (hasActual) actualTotal++;
      if (hasPlanned && elapsed) {
        adherencePlanned++;
        if (planned.cat === actual.cat) matched++;
      }
      if (hasPlanned && !hasActual && elapsed) unaccounted++;
    }
    return { plannedTotal, actualTotal, adherencePlanned, matched, unaccounted };
  }

  async function renderDay() {
    const blocks = groupedBlocks(dayData, 'planned');
    const summary = daySummary(dayData, currentDate);
    $('dateTitle').textContent = formatDate(currentDate, { weekday: 'long', month: 'short', day: 'numeric' });
    $('datePicker').value = currentDate;
    $('dayTheme').textContent = themeFor(currentDate);
    $('logOtherBtn').disabled = activeCategories().length === 0;
    const today = currentDate === todayString();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const currentBlock = today ? blocks.find(block => nowMinutes >= block.start && nowMinutes < block.end) : null;
    if (currentBlock) {
      $('heroEyebrow').textContent = 'Your focus now';
      $('heroTitle').textContent = category(currentBlock.cat).label;
      $('heroText').textContent = `${currentBlock.text || 'Stay with this block'} · until ${timeLabel(currentBlock.end)}`;
    } else if (!blocks.length) {
      $('heroEyebrow').textContent = today ? 'Start with a plan' : 'No plan yet';
      $('heroTitle').textContent = today ? 'Give the day a simple shape.' : 'This day is empty.';
      $('heroText').textContent = 'Use the standard plan, then change only what is genuinely different.';
    } else {
      $('heroEyebrow').textContent = today ? 'Between work blocks' : 'Day overview';
      $('heroTitle').textContent = today ? 'Check the next block.' : themeFor(currentDate);
      $('heroText').textContent = today ? 'Use the list below to see what is next or record completed work.' : 'Review the plan or record what actually happened.';
    }

    const metrics = $('dayMetrics');
    metrics.replaceChildren(
      metric(`${(summary.plannedTotal * .25).toFixed(1)}h`, 'Planned'),
      metric(`${(summary.actualTotal * .25).toFixed(1)}h`, 'Total logged'),
      metric(`${(summary.unaccounted * .25).toFixed(1)}h`, 'Unlogged so far'),
      metric(summary.adherencePlanned ? `${Math.round(summary.matched / summary.adherencePlanned * 100)}%` : '—', 'Matched the plan so far'),
    );

    const list = $('blockList');
    list.innerHTML = '';
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No work blocks yet</strong>Set up the week or create a plan for this day.';
      list.appendChild(empty);
      return;
    }

    blocks.forEach(block => {
      const actualEntries = block.keys
        .map(key => dayData[key]?.actual)
        .filter(actual => actual && (actual.cat !== 'none' || actual.text));
      const logged = actualEntries.length;
      const matches = block.keys.filter(key => dayData[key]?.actual?.cat === block.cat).length;
      const row = document.createElement('div');
      row.className = 'work-block';
      if (today && nowMinutes >= block.start && nowMinutes < block.end) row.classList.add('current');

      const time = document.createElement('div');
      time.className = 'block-time';
      time.textContent = `${shortTime(block.start)} – ${shortTime(block.end)}`;
      const copy = document.createElement('div');
      copy.className = 'block-copy';
      const cat = document.createElement('div');
      cat.className = 'block-cat';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = category(block.cat).color;
      const catText = document.createElement('span');
      catText.textContent = category(block.cat).label;
      cat.append(swatch, catText);
      const note = document.createElement('div');
      note.className = 'block-note';
      const actualDescriptions = [...new Set(actualEntries.map(actual => actual.text).filter(Boolean))];
      const actualCategories = [...new Set(actualEntries.map(actual => actual.cat).filter(id => id && id !== 'none'))];
      const actualDiffers = actualCategories.some(id => id !== block.cat) || actualDescriptions.some(text => text !== block.text);
      if (actualDiffers) {
        const categoryText = actualCategories.length === 1 ? category(actualCategories[0]).label : 'Mixed actual work';
        note.textContent = `Actual: ${categoryText}${actualDescriptions.length === 1 ? ` · ${actualDescriptions[0]}` : ''}`;
      } else {
        note.textContent = block.text || '—';
      }
      copy.append(cat, note);
      const actions = document.createElement('div');
      actions.className = 'block-actions';
      const logPlan = document.createElement('button');
      logPlan.className = `decision-btn yes${logged === block.keys.length && matches === logged ? ' selected' : ''}`;
      logPlan.textContent = '✓';
      logPlan.title = 'Yes — I worked as planned';
      logPlan.setAttribute('aria-label', 'Worked as planned');
      logPlan.addEventListener('click', () => logBlockAsPlanned(block));
      const change = document.createElement('button');
      change.className = `decision-btn no${logged && !(logged === block.keys.length && matches === logged) ? ' selected' : ''}`;
      change.textContent = '×';
      change.title = 'No — enter what I actually did';
      change.setAttribute('aria-label', 'Enter different work');
      change.addEventListener('click', () => openLogDialog(block));
      actions.append(logPlan, change);
      row.append(time, copy, actions);
      list.appendChild(row);
    });
  }

  async function logBlockAsPlanned(block) {
    clearRange(dayData, 'actual', block.start, block.end);
    fillRange(dayData, 'actual', block.start, block.end, block.cat, block.text);
    await queuedSave(() => window.ts.saveDay(currentDate, dayData));
    await loadCurrentDay();
  }

  async function setupWeek() {
    const monday = mondayOf(currentDate);
    $('setupWeekBtn').disabled = true;
    try {
      for (let index = 0; index < 5; index++) {
        const date = offsetDate(monday, index);
        const data = await window.ts.loadDay(date);
        standardPlan(date).forEach(block => fillRange(data, 'planned', block.start, block.end, block.cat, block.text, true));
        await queuedSave(() => window.ts.saveDay(date, data));
      }
      await loadCurrentDay();
    } finally {
      $('setupWeekBtn').disabled = false;
    }
  }

  function timeOptions(selected, includeEnd = false) {
    const fragment = document.createDocumentFragment();
    const final = includeEnd ? END : END - STEP;
    for (let minutes = START; minutes <= final; minutes += STEP) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = timeLabel(minutes);
      option.selected = minutes === selected;
      fragment.appendChild(option);
    }
    return fragment;
  }

  function categoryOptions(selected) {
    const fragment = document.createDocumentFragment();
    const choices = activeCategories();
    const selectedCategory = categories.find(item => item.id === selected);
    if (selectedCategory?.archived) choices.unshift(selectedCategory);
    choices.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.label}${item.archived ? ' (removed)' : ''}`;
      option.selected = item.id === selected;
      fragment.appendChild(option);
    });
    return fragment;
  }

  function openPlanEditor() {
    editorBlocks = groupedBlocks(dayData, 'planned').map(({ start, end, cat, text }) => ({ start, end, cat, text }));
    $('dayDashboard').hidden = true;
    $('planEditor').hidden = false;
    $('editorDate').textContent = `${formatDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric' })} · changes affect the plan only`;
    $('editorError').textContent = '';
    renderEditorRows();
    $('content').scrollTop = 0;
  }

  function closePlanEditor() {
    $('planEditor').hidden = true;
    $('dayDashboard').hidden = false;
  }

  function renderEditorRows() {
    const container = $('editorRows');
    container.innerHTML = '';
    if (!editorBlocks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No blocks. Add one or use the standard plan.';
      container.appendChild(empty);
      return;
    }
    editorBlocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'editor-row';
      const start = document.createElement('select');
      start.className = 'field';
      start.appendChild(timeOptions(block.start));
      start.addEventListener('change', () => { editorBlocks[index].start = Number(start.value); });
      const divider = document.createElement('span');
      divider.textContent = 'to';
      divider.style.textAlign = 'center';
      divider.style.color = 'var(--muted)';
      const end = document.createElement('select');
      end.className = 'field';
      end.appendChild(timeOptions(block.end, true));
      end.addEventListener('change', () => { editorBlocks[index].end = Number(end.value); });
      const cat = document.createElement('select');
      cat.className = 'field';
      cat.appendChild(categoryOptions(block.cat));
      cat.addEventListener('change', () => { editorBlocks[index].cat = cat.value; });
      const note = document.createElement('input');
      note.className = 'field';
      note.maxLength = 120;
      note.placeholder = 'What is this block for?';
      note.value = block.text;
      note.addEventListener('input', () => { editorBlocks[index].text = note.value; });
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = 'Remove block';
      remove.addEventListener('click', () => { editorBlocks.splice(index, 1); renderEditorRows(); });
      row.append(start, divider, end, cat, note, remove);
      container.appendChild(row);
    });
  }

  function addEditorBlock() {
    const firstCategory = activeCategories()[0];
    if (!firstCategory) {
      $('editorError').textContent = 'Add a category in Settings before creating a block.';
      return;
    }
    const lastEnd = editorBlocks.length ? Math.max(...editorBlocks.map(block => block.end)) : 480;
    const start = lastEnd < END - STEP ? lastEnd : 480;
    editorBlocks.push({ start, end: Math.min(start + 60, END), cat: firstCategory.id, text: '' });
    renderEditorRows();
  }

  function useStandardPlan() {
    editorBlocks = standardPlan(currentDate).map(block => ({ ...block }));
    renderEditorRows();
  }

  async function savePlan() {
    const sorted = [...editorBlocks].sort((a, b) => a.start - b.start);
    for (let index = 0; index < sorted.length; index++) {
      const block = sorted[index];
      if (block.start >= block.end) {
        $('editorError').textContent = 'Every block needs an end time after its start.';
        return;
      }
      if (index > 0 && block.start < sorted[index - 1].end) {
        $('editorError').textContent = 'Work blocks cannot overlap.';
        return;
      }
    }
    clearSide(dayData, 'planned');
    sorted.forEach(block => fillRange(dayData, 'planned', block.start, block.end, block.cat, block.text.trim()));
    await queuedSave(() => window.ts.saveDay(currentDate, dayData));
    closePlanEditor();
    await loadCurrentDay();
  }

  function openLogDialog(block = null) {
    if (!activeCategories().length && !block) return;
    const now = new Date();
    const rounded = Math.max(START, Math.floor((now.getHours() * 60 + now.getMinutes()) / STEP) * STEP);
    const start = block?.start ?? Math.max(START, rounded - 30);
    const end = block?.end ?? Math.min(END, rounded);
    const savedActuals = block
      ? block.keys.map(key => dayData[key]?.actual).filter(actual => actual && (actual.cat !== 'none' || actual.text))
      : [];
    const latestActual = savedActuals[savedActuals.length - 1];
    correctionRange = block && savedActuals.length ? { start: block.start, end: block.end } : null;
    const selectedCategory = latestActual?.cat || block?.cat || activeCategories()[0]?.id;
    $('logDialogTitle').textContent = 'What did you actually do?';
    $('logStart').replaceChildren(timeOptions(start));
    $('logEnd').replaceChildren(timeOptions(end, true));
    $('logCategory').replaceChildren(categoryOptions(selectedCategory));
    $('logNote').value = latestActual?.text ?? block?.text ?? '';
    $('logError').textContent = '';
    $('logDialog').showModal();
  }

  async function saveLoggedWork() {
    const start = Number($('logStart').value);
    const end = Number($('logEnd').value);
    if (start >= end) {
      $('logError').textContent = 'Choose an end time after the start time.';
      return;
    }
    if (correctionRange) {
      clearRange(dayData, 'actual', correctionRange.start, correctionRange.end);
    }
    fillRange(dayData, 'actual', start, end, $('logCategory').value, $('logNote').value.trim());
    correctionRange = null;
    await queuedSave(() => window.ts.saveDay(currentDate, dayData));
    $('logDialog').close();
    await loadCurrentDay();
  }

  async function openCorrectionForSlot(slotKey) {
    const start = keyToMinutes(slotKey);
    if (!Number.isFinite(start) || start < START || start >= END) return;
    currentDate = todayString();
    activateView('today');
    await loadCurrentDay();
    const planned = dayData[slotKey]?.planned || {};
    openLogDialog({
      start,
      end: start + STEP,
      cat: planned.cat || activeCategories()[0]?.id || 'none',
      text: planned.text || '',
      keys: [slotKey],
    });
  }

  async function renderReport() {
    const from = weekAnchor;
    const to = offsetDate(from, 6);
    $('weekLabel').textContent = `${formatDate(from, { month: 'short', day: 'numeric' })} – ${formatDate(to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const all = await window.ts.loadRange(from, to);
    const totals = { planned: 0, logged: 0, unaccounted: 0, adherencePlanned: 0, matched: 0 };
    const categoryCounts = {};
    const tbody = $('dailyReport');
    tbody.innerHTML = '';
    for (let index = 0; index < 7; index++) {
      const date = offsetDate(from, index);
      const data = all[date] || {};
      const summary = daySummary(data, date);
      totals.planned += summary.plannedTotal;
      totals.logged += summary.actualTotal;
      totals.unaccounted += summary.unaccounted;
      totals.adherencePlanned += summary.adherencePlanned;
      totals.matched += summary.matched;
      SLOTS.forEach(slot => {
        const actual = data[slot.key]?.actual;
        if (actual && actual.cat !== 'none') categoryCounts[actual.cat] = (categoryCounts[actual.cat] || 0) + 1;
      });
      const row = document.createElement('tr');
      const dayCell = document.createElement('td');
      const dayName = document.createElement('div');
      dayName.className = 'day-name';
      dayName.textContent = formatDate(date, { weekday: 'long' });
      const dayDate = document.createElement('div');
      dayDate.className = 'day-date';
      dayDate.textContent = formatDate(date, { month: 'short', day: 'numeric' });
      dayCell.append(dayName, dayDate);
      const values = [
        `${(summary.plannedTotal * .25).toFixed(1)}h`,
        `${(summary.actualTotal * .25).toFixed(1)}h`,
        `${(summary.unaccounted * .25).toFixed(1)}h`,
        summary.adherencePlanned ? `${Math.round(summary.matched / summary.adherencePlanned * 100)}%` : '—',
      ];
      row.appendChild(dayCell);
      values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); });
      tbody.appendChild(row);
    }
    $('reportMetrics').replaceChildren(
      metric(`${(totals.planned * .25).toFixed(1)}h`, 'Planned'),
      metric(`${(totals.logged * .25).toFixed(1)}h`, 'Total logged'),
      metric(`${(totals.unaccounted * .25).toFixed(1)}h`, 'Planned time unlogged'),
      metric(totals.adherencePlanned ? `${Math.round(totals.matched / totals.adherencePlanned * 100)}%` : '—', 'Matched the plan'),
    );
    $('unloggedNote').textContent = totals.unaccounted
      ? `${(totals.unaccounted * .25).toFixed(1)}h of elapsed planned time was unlogged. These gaps are excluded from actual totals and emailed reports.`
      : 'All elapsed planned time has been logged. Only actual entries are included in emailed reports.';
    const summary = $('categoryReport');
    summary.innerHTML = '';
    const sorted = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No work logged this week.';
      summary.appendChild(empty);
    } else {
      sorted.forEach(([id, count]) => {
        const row = document.createElement('div');
        row.className = 'category-summary-row';
        const name = document.createElement('div');
        name.className = 'category-name';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = category(id).color;
        const label = document.createElement('span');
        label.textContent = category(id).label;
        name.append(swatch, label);
        const hours = document.createElement('strong');
        hours.textContent = `${(count * .25).toFixed(1)}h`;
        row.append(name, hours);
        summary.appendChild(row);
      });
    }
  }

  async function emailWeek() {
    const button = $('emailWeekBtn');
    button.disabled = true;
    setStatus('reportStatus', 'Sending…');
    try {
      const result = await window.ts.sendWeeklyReport(weekAnchor, offsetDate(weekAnchor, 6));
      setStatus('reportStatus', result);
    } catch (error) {
      setStatus('reportStatus', String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function emailDailyReport() {
    const button = $('sendDailyReportBtn');
    button.disabled = true;
    setStatus('dailyReportStatus', 'Sending daily category breakdown…');
    try {
      const result = await window.ts.sendDailyReport(currentDate);
      setStatus('dailyReportStatus', result);
    } catch (error) {
      setStatus('dailyReportStatus', String(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function exportWeek() {
    setStatus('reportStatus', 'Choose where to save the report…');
    try {
      const result = await window.ts.exportData(weekAnchor, offsetDate(weekAnchor, 6));
      setStatus('reportStatus', result.cancelled ? '' : `Saved to ${result.filePath}`);
    } catch (error) {
      setStatus('reportStatus', String(error), true);
    }
  }

  function renderWeekAssignments() {
    const assignments = { weekMon: 'mon', weekTue: 'tue', weekWed: 'wed', weekThu: 'thu', weekFri: 'fri' };
    const templateIds = Object.keys(standardDraft.templates);
    Object.entries(assignments).forEach(([elementId, day]) => {
      const select = $(elementId);
      select.innerHTML = '';
      templateIds.forEach(templateId => {
        const option = document.createElement('option');
        option.value = templateId;
        option.textContent = templateName(standardDraft, templateId);
        option.selected = standardDraft.week[day] === templateId;
        select.appendChild(option);
      });
      select.onchange = () => { standardDraft.week[day] = select.value; };
    });
  }

  function renderStandardPlanSettings() {
    if (!standardDraft) return;
    const templateIds = Object.keys(standardDraft.templates);
    if (!standardDraft.templates[activeStandardTemplate]) activeStandardTemplate = templateIds[0] || null;

    const tabs = $('standardTemplateTabs');
    tabs.innerHTML = '';
    templateIds.forEach(templateId => {
      const tab = document.createElement('button');
      tab.className = `btn template-tab${activeStandardTemplate === templateId ? ' active' : ''}`;
      tab.textContent = templateName(standardDraft, templateId);
      tab.addEventListener('click', () => { activeStandardTemplate = templateId; renderStandardPlanSettings(); });
      tabs.appendChild(tab);
    });

    const name = $('standardTemplateName');
    name.disabled = !activeStandardTemplate;
    name.value = activeStandardTemplate ? templateName(standardDraft, activeStandardTemplate) : '';
    name.oninput = () => {
      if (!activeStandardTemplate) return;
      standardDraft.templateNames[activeStandardTemplate] = name.value;
      const activeTab = [...tabs.children].find((_, index) => templateIds[index] === activeStandardTemplate);
      if (activeTab) activeTab.textContent = name.value || 'Unnamed day';
      document.querySelectorAll('.week-template').forEach(select => {
        const option = [...select.options].find(item => item.value === activeStandardTemplate);
        if (option) option.textContent = name.value || 'Unnamed day';
      });
    };
    $('removeStandardTemplateBtn').disabled = templateIds.length <= 1;
    $('addStandardBlockBtn').disabled = !activeStandardTemplate;

    const blocks = activeStandardTemplate ? standardDraft.templates[activeStandardTemplate] : [];
    const container = $('standardTemplateRows');
    container.innerHTML = '';
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'This template has no blocks yet.';
      container.appendChild(empty);
    }
    blocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'editor-row';
      const start = document.createElement('select');
      start.className = 'field';
      start.appendChild(timeOptions(keyToMinutes(block.start)));
      start.addEventListener('change', () => { block.start = minutesToKey(Number(start.value)); });
      const divider = document.createElement('span');
      divider.textContent = 'to';
      divider.style.textAlign = 'center';
      divider.style.color = 'var(--muted)';
      const end = document.createElement('select');
      end.className = 'field';
      end.appendChild(timeOptions(keyToMinutes(block.end), true));
      end.addEventListener('change', () => { block.end = minutesToKey(Number(end.value)); });
      const cat = document.createElement('select');
      cat.className = 'field standard-cat-select';
      cat.appendChild(categoryOptions(block.cat));
      cat.addEventListener('change', () => { block.cat = cat.value; });
      const note = document.createElement('input');
      note.className = 'field';
      note.maxLength = 120;
      note.placeholder = 'What is this block for?';
      note.value = block.text;
      note.addEventListener('input', () => { block.text = note.value; });
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = 'Remove block';
      remove.addEventListener('click', () => { blocks.splice(index, 1); renderStandardPlanSettings(); });
      row.append(start, divider, end, cat, note, remove);
      container.appendChild(row);
    });

    renderWeekAssignments();
  }

  function newTemplateId() {
    let id = `day_${Date.now()}`;
    while (standardDraft.templates[id]) id += '_1';
    return id;
  }

  function addStandardTemplate(copyCurrent = false) {
    if (Object.keys(standardDraft.templates).length >= 20) {
      setStatus('standardPlanStatus', 'You can create up to 20 standard days.', true);
      return;
    }
    const templateId = newTemplateId();
    const source = copyCurrent && activeStandardTemplate ? standardDraft.templates[activeStandardTemplate] : [];
    standardDraft.templates[templateId] = structuredClone(source);
    standardDraft.templateNames[templateId] = copyCurrent
      ? `${templateName(standardDraft, activeStandardTemplate).slice(0, 35)} copy`
      : 'New standard day';
    activeStandardTemplate = templateId;
    renderStandardPlanSettings();
    $('standardTemplateName').select();
  }

  function removeStandardTemplate() {
    const templateIds = Object.keys(standardDraft.templates);
    if (!activeStandardTemplate || templateIds.length <= 1) return;
    const name = templateName(standardDraft, activeStandardTemplate);
    if (!window.confirm(`Remove “${name}”? Weekdays using it will be reassigned to another standard day.`)) return;
    delete standardDraft.templates[activeStandardTemplate];
    delete standardDraft.templateNames[activeStandardTemplate];
    const replacement = Object.keys(standardDraft.templates)[0];
    Object.keys(standardDraft.week).forEach(day => {
      if (standardDraft.week[day] === activeStandardTemplate) standardDraft.week[day] = replacement;
    });
    activeStandardTemplate = replacement;
    renderStandardPlanSettings();
    setStatus('standardPlanStatus', 'Standard day removed. Click Save standard week to keep this change.');
  }

  function addStandardBlock() {
    if (!activeStandardTemplate) return;
    const blocks = standardDraft.templates[activeStandardTemplate];
    const lastEnd = blocks.length ? Math.max(...blocks.map(block => keyToMinutes(block.end))) : 480;
    const start = lastEnd < END - STEP ? lastEnd : 480;
    blocks.push({
      start: minutesToKey(start),
      end: minutesToKey(Math.min(start + 60, END)),
      cat: categories.find(item => item.id !== 'none')?.id || 'other',
      text: '',
    });
    renderStandardPlanSettings();
  }

  function validateStandardTemplates() {
    const templateIds = Object.keys(standardDraft.templates);
    if (!templateIds.length) return 'Create at least one standard day.';
    if (templateIds.length > 20) return 'You can create up to 20 standard days.';
    for (const templateId of templateIds) {
      if (!String(standardDraft.templateNames[templateId] || '').trim()) return 'Every standard day needs a name.';
      const blocks = standardDraft.templates[templateId];
      blocks.sort((a, b) => keyToMinutes(a.start) - keyToMinutes(b.start));
      for (let index = 0; index < blocks.length; index++) {
        if (keyToMinutes(blocks[index].start) >= keyToMinutes(blocks[index].end)) return 'Every block needs an end time after its start.';
        if (index && keyToMinutes(blocks[index].start) < keyToMinutes(blocks[index - 1].end)) return 'Standard-plan blocks cannot overlap.';
      }
    }
    return '';
  }

  async function saveStandardWeek() {
    Object.keys(standardDraft.templateNames).forEach(templateId => {
      standardDraft.templateNames[templateId] = String(standardDraft.templateNames[templateId]).trim();
    });
    const validationError = validateStandardTemplates();
    if (validationError) {
      setStatus('standardPlanStatus', validationError, true);
      return;
    }
    try {
      await queuedSave(() => window.ts.saveStandardPlan(standardDraft));
      standardConfig = structuredClone(standardDraft);
      setStatus('standardPlanStatus', 'Standard week saved. New plans will use it.');
      renderStandardPlanSettings();
      await renderDay();
    } catch (error) {
      setStatus('standardPlanStatus', String(error), true);
    }
  }

  function refreshStandardCategoryChoices() {
    document.querySelectorAll('#standardTemplateRows .standard-cat-select').forEach(select => {
      const selected = select.value;
      select.replaceChildren(categoryOptions(selected));
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
    });
  }

  function archiveCategory(id) {
    const item = categories.find(candidate => candidate.id === id);
    if (!item) return;
    const affectedBlocks = Object.values(standardDraft.templates)
      .flatMap(blocks => blocks)
      .filter(block => block.cat === id).length;
    const consequence = affectedBlocks
      ? ` ${affectedBlocks} standard-plan block${affectedBlocks === 1 ? '' : 's'} using it will also be removed.`
      : '';
    if (!window.confirm(`Remove “${item.label}”? Historical reports will keep its name.${consequence}`)) return;
    item.archived = true;
    Object.keys(standardDraft.templates).forEach(templateId => {
      standardDraft.templates[templateId] = standardDraft.templates[templateId].filter(block => block.cat !== id);
    });
    renderCategorySettings();
    renderStandardPlanSettings();
    setStatus('categoryStatus', 'Category removed. Click Save changes to keep it.');
  }

  function renderCategorySettings() {
    const container = $('categoryRows');
    container.innerHTML = '';
    const active = activeCategories();
    if (!active.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No active categories</strong>Add one when you are ready to plan or log work.';
      container.appendChild(empty);
    }
    active.forEach((item, index) => {
      const actualIndex = categories.indexOf(item);
      const row = document.createElement('div');
      row.className = 'category-row';
      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'color-field';
      color.value = /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#64748b';
      color.title = 'Category colour';
      color.addEventListener('input', () => { categories[actualIndex].color = color.value; });
      const name = document.createElement('input');
      name.className = 'field';
      name.maxLength = 32;
      name.value = item.label;
      name.setAttribute('aria-label', `Name for category ${index + 1}`);
      name.addEventListener('input', () => {
        categories[actualIndex].label = name.value;
        refreshStandardCategoryChoices();
      });
      const payoff = document.createElement('select');
      payoff.className = 'field';
      [['', 'Neutral'], ['high', 'High value'], ['low', 'Low value']].forEach(([value, label]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = (item.payoff || '') === value; payoff.appendChild(option);
      });
      payoff.addEventListener('change', () => {
        if (payoff.value) categories[actualIndex].payoff = payoff.value;
        else delete categories[actualIndex].payoff;
      });
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = 'Remove category';
      remove.addEventListener('click', () => archiveCategory(item.id));
      row.append(color, name, payoff, remove);
      container.appendChild(row);
    });
  }

  function addCategory() {
    categories.push({ id: `custom_${Date.now()}`, label: 'New category', color: '#557a68' });
    renderCategorySettings();
    renderStandardPlanSettings();
    const inputs = document.querySelectorAll('#categoryRows input[type="text"]');
    inputs[inputs.length - 1]?.select();
  }

  async function saveCategories() {
    if (categories.some(item => item.id !== 'none' && !item.label.trim())) {
      setStatus('categoryStatus', 'Every category needs a name.', true);
      return;
    }
    categories.forEach(item => { item.label = item.label.trim(); });
    Object.keys(standardDraft.templateNames).forEach(templateId => {
      standardDraft.templateNames[templateId] = String(standardDraft.templateNames[templateId]).trim();
    });
    try {
      const validationError = validateStandardTemplates();
      if (validationError) {
        setStatus('categoryStatus', validationError, true);
        return;
      }
      await queuedSave(async () => {
        await window.ts.saveCategories(categories);
        await window.ts.saveStandardPlan(standardDraft);
      });
      categoryMap = Object.fromEntries(categories.map(item => [item.id, item]));
      standardConfig = structuredClone(standardDraft);
      setStatus('categoryStatus', 'Categories saved.');
      renderStandardPlanSettings();
      await renderDay();
    } catch (error) {
      setStatus('categoryStatus', String(error), true);
    }
  }

  async function loadEmailSettings() {
    const config = await window.ts.loadEmailSettings();
    $('emailFrom').value = config.from || '';
    $('emailTo').value = config.to || '';
    if (config.hasKey) $('emailKey').placeholder = 'Saved — leave blank to keep';
  }

  async function saveEmailSettings() {
    const from = $('emailFrom').value.trim();
    const to = $('emailTo').value.trim();
    if (!from || !to) {
      setStatus('emailStatus', 'From and Send to are required.', true);
      return;
    }
    try {
      await window.ts.saveEmailSettings(from, to, $('emailKey').value);
      $('emailKey').value = '';
      $('emailKey').placeholder = 'Saved — leave blank to keep';
      setStatus('emailStatus', 'Delivery settings saved.');
    } catch (error) {
      setStatus('emailStatus', String(error), true);
    }
  }

  function bindEvents() {
    document.querySelectorAll('.nav-btn').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));
    $('prevDay').addEventListener('click', () => { currentDate = offsetDate(currentDate, -1); loadCurrentDay(); });
    $('nextDay').addEventListener('click', () => { currentDate = offsetDate(currentDate, 1); loadCurrentDay(); });
    $('goToday').addEventListener('click', () => { currentDate = todayString(); loadCurrentDay(); });
    $('dateTitle').addEventListener('click', () => {
      $('datePicker').hidden = false;
      try { $('datePicker').showPicker(); } catch { $('datePicker').click(); }
    });
    $('datePicker').addEventListener('change', event => { if (event.target.value) { currentDate = event.target.value; loadCurrentDay(); } event.target.hidden = true; });
    $('setupWeekBtn').addEventListener('click', setupWeek);
    $('sendDailyReportBtn').addEventListener('click', emailDailyReport);
    $('editPlanBtn').addEventListener('click', openPlanEditor);
    $('closeEditor').addEventListener('click', closePlanEditor);
    $('cancelEditor').addEventListener('click', closePlanEditor);
    $('addBlockBtn').addEventListener('click', addEditorBlock);
    $('standardPlanBtn').addEventListener('click', useStandardPlan);
    $('savePlanBtn').addEventListener('click', savePlan);
    $('logOtherBtn').addEventListener('click', () => openLogDialog());
    $('cancelLog').addEventListener('click', () => { correctionRange = null; $('logDialog').close(); });
    $('saveLog').addEventListener('click', saveLoggedWork);
    $('prevWeek').addEventListener('click', () => { weekAnchor = offsetDate(weekAnchor, -7); renderReport(); });
    $('nextWeek').addEventListener('click', () => { weekAnchor = offsetDate(weekAnchor, 7); renderReport(); });
    $('thisWeekBtn').addEventListener('click', () => { weekAnchor = mondayOf(todayString()); renderReport(); });
    $('emailWeekBtn').addEventListener('click', emailWeek);
    $('exportWeekBtn').addEventListener('click', exportWeek);
    $('addStandardTemplateBtn').addEventListener('click', () => addStandardTemplate(false));
    $('duplicateStandardTemplateBtn').addEventListener('click', () => addStandardTemplate(true));
    $('removeStandardTemplateBtn').addEventListener('click', removeStandardTemplate);
    $('addStandardBlockBtn').addEventListener('click', addStandardBlock);
    $('saveStandardPlanBtn').addEventListener('click', saveStandardWeek);
    $('addCategoryBtn').addEventListener('click', addCategory);
    $('saveCategoriesBtn').addEventListener('click', saveCategories);
    $('saveEmailBtn').addEventListener('click', saveEmailSettings);
    $('checkUpdatesBtn').addEventListener('click', () => {
      setStatus('updateStatus', 'Checking…');
      window.ts.checkForUpdates();
    });
    window.ts.onUpdateStatus(message => setStatus('updateStatus', message));
    window.ts.onRefreshDay(() => loadCurrentDay());
    window.ts.onCorrectSlot(slotKey => openCorrectionForSlot(slotKey));
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('logDialog').open) { correctionRange = null; $('logDialog').close(); }
      else if (event.key === 'Escape' && !$('planEditor').hidden) closePlanEditor();
    });
  }

  async function init() {
    const loaded = await Promise.all([
      window.ts.loadCategories(),
      window.ts.loadStandardPlan(),
    ]);
    categories = loaded[0];
    standardConfig = normalizeStandardConfig(loaded[1]);
    standardDraft = structuredClone(standardConfig);
    activeStandardTemplate = Object.keys(standardDraft.templates)[0] || null;
    categoryMap = Object.fromEntries(categories.map(item => [item.id, item]));
    bindEvents();
    await Promise.all([loadCurrentDay(), loadEmailSettings()]);
  }

  init().catch(error => {
    $('saveStatus').textContent = `Could not start: ${String(error)}`;
  });
})();
