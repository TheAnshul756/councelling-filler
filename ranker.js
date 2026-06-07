'use strict';

let allCsvRows  = [];   // full parsed ranks.csv
let pageChoices = [];   // raw choices from JoSAA page
let items       = [];   // current displayed+ordered list
let dragSrcIdx  = null;

// ─────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────

async function init() {
  // Restore stored options
  const stored = await chrome.storage.local.get(
    ['pageChoices', 'josaaTabId', 'autoAccept', 'clearExisting']
  );
  pageChoices = stored.pageChoices || [];
  if (stored.autoAccept    != null) document.getElementById('autoAccept').checked    = stored.autoAccept;
  if (stored.clearExisting != null) document.getElementById('clearExisting').checked = stored.clearExisting;

  document.getElementById('choiceCount').textContent =
    `${pageChoices.length} choice${pageChoices.length !== 1 ? 's' : ''} from page`;

  // Load ranks CSV
  setLoading('Loading rank data…');
  try {
    const text = await fetch(chrome.runtime.getURL('ranks.csv')).then(r => r.text());
    allCsvRows = parseCsv(text);
  } catch (err) {
    setLoading('Failed to load ranks.csv: ' + err.message);
    return;
  }

  hideLoading();
  applyFilters();

  document.getElementById('applyBtn').addEventListener('click', applyFilters);
  document.getElementById('confirmBtn').addEventListener('click', confirmAndFill);
  document.getElementById('copyBtn').addEventListener('click', copyList);
  document.getElementById('resetBtn').addEventListener('click', resetChoices);
}

// ─────────────────────────────────────────────
//  CSV parser
// ─────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsv(text) {
  const lines = text.split('\n');
  let headers = null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!headers) { headers = fields.map(h => h.trim()); continue; }
    const row = {};
    headers.forEach((h, i) => { row[h] = (fields[i] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────────────────────────
//  Matching helpers
// ─────────────────────────────────────────────

function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns a similarity score: 1000 = exact, 500–999 = close, 0 = no match.
// Uses strict word-SET Jaccard (≥ 0.70) to prevent substring false-positives
// (e.g. "national" matching inside "international").
function matchScore(pageText, csvText) {
  const pg  = normalizeText(pageText);
  const csv = normalizeText(csvText);
  if (!pg || !csv) return 0;
  if (pg === csv)  return 1000;

  const pgWords  = new Set(pg.split(/\s+/).filter(w => w.length >= 4));
  const csvWords = new Set(csv.split(/\s+/).filter(w => w.length >= 4));
  if (!pgWords.size || !csvWords.size) return 0;

  let inter = 0;
  for (const w of pgWords) if (csvWords.has(w)) inter++;
  const union   = pgWords.size + csvWords.size - inter;
  const jaccard = inter / union;
  if (jaccard < 0.7) return 0;                     // strict threshold

  let score = Math.round(jaccard * 600);
  if (pg.includes(csv) || csv.includes(pg)) {
    score += Math.round(
      Math.min(pg.length, csv.length) / Math.max(pg.length, csv.length) * 400
    );
  }
  return score;
}

// Quota preference order for tie-breaking
const QUOTA_ORDER = ['AI', 'OS', 'HS', 'GO', 'JK', 'LA'];

// Search ALL quota pools simultaneously; return the globally best-scoring row.
// This prevents a weak AI-quota false-positive from blocking the correct OS-quota match.
function bestMatch(byQuota, preferredQuota, choice) {
  const quotaRank = q => {
    const order = [preferredQuota, ...QUOTA_ORDER.filter(x => x !== preferredQuota)];
    const idx = order.indexOf(q);
    return idx === -1 ? 99 : idx;
  };

  let best = null, bestScore = 0, bestQRank = 99;
  for (const [q, rows] of Object.entries(byQuota)) {
    for (const r of rows) {
      const instScore = matchScore(choice.institute, r.institute_name);
      if (instScore < 500) continue;               // reject cross-institute confusion
      const progScore = matchScore(choice.program, r.program_branch);
      if (progScore < 500) continue;               // reject cross-program confusion
      const total = instScore + progScore;
      const qRank = quotaRank(q);
      if (total > bestScore || (total === bestScore && qRank < bestQRank)) {
        bestScore = total; bestQRank = qRank;
        best = { row: r, quotaUsed: q, score: total };
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────
//  Apply filters + match + sort
// ─────────────────────────────────────────────

function applyFilters() {
  const btn      = document.getElementById('applyBtn');
  btn.disabled   = true;
  btn.textContent = 'Applying…';

  const rankTypeVal = document.getElementById('filterRankType').value;
  const [category, gender] = rankTypeVal.split('||');
  const quota = document.getElementById('filterQuota').value;

  // Group all CSV rows (same category+gender) by quota for bestMatch
  const byQuota = {};
  for (const r of allCsvRows) {
    if (r.category === category && r.gender === gender) {
      if (!byQuota[r.quota]) byQuota[r.quota] = [];
      byQuota[r.quota].push(r);
    }
  }

  items = pageChoices.map(choice => {
    const hit = bestMatch(byQuota, quota, choice);
    if (hit) {
      const { row: csvRow, quotaUsed, score } = hit;
      const cr = parseInt(csvRow.closing_rank);
      return {
        institute: choice.institute,
        program:   choice.program,
        openingRankDisplay: csvRow.opening_rank,
        closingRankDisplay: csvRow.closing_rank,
        closingRank: isNaN(cr) ? null : cr,
        found: true,
        quotaUsed,
        primaryQuota: quota,
        _rowKey: `${csvRow.institute_name}||${csvRow.program_branch}||${quotaUsed}`,
        _score:  score,
      };
    }
    return {
      institute: choice.institute,
      program:   choice.program,
      openingRankDisplay: 'N/A',
      closingRankDisplay: 'N/A',
      closingRank: null,
      found: false,
      quotaUsed: null,
      primaryQuota: quota,
    };
  });

  // Global dedup: when two choices map to the same CSV row, keep the higher-scoring one.
  // The lower-scoring match (e.g. "CSE (Data Science)" stealing the plain "CSE" row) is
  // reset to not-found so it shows as UNRANKED instead of creating a duplicate rank entry.
  {
    const takenRows = new Map(); // _rowKey → index
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.found) continue;
      if (takenRows.has(item._rowKey)) {
        const prevIdx = takenRows.get(item._rowKey);
        if (item._score > items[prevIdx]._score) {
          items[prevIdx] = { institute: items[prevIdx].institute, program: items[prevIdx].program,
            openingRankDisplay: 'N/A', closingRankDisplay: 'N/A', closingRank: null,
            found: false, quotaUsed: null, primaryQuota: quota };
          takenRows.set(item._rowKey, i);
        } else {
          items[i] = { institute: item.institute, program: item.program,
            openingRankDisplay: 'N/A', closingRankDisplay: 'N/A', closingRank: null,
            found: false, quotaUsed: null, primaryQuota: quota };
        }
      } else {
        takenRows.set(item._rowKey, i);
      }
    }
  }

  const matched = items.filter(i => i.found).length;

  // Sort: found entries by closing rank asc; not-found at end
  items.sort((a, b) => {
    if (!a.found && !b.found) return 0;
    if (!a.found) return 1;
    if (!b.found) return -1;
    if (a.closingRank === null && b.closingRank === null) return 0;
    if (a.closingRank === null) return 1;
    if (b.closingRank === null) return -1;
    return a.closingRank - b.closingRank;
  });

  document.getElementById('matchCount').textContent =
    `${matched} of ${pageChoices.length} matched`;

  renderTable();
  btn.disabled = false;
  btn.textContent = 'Apply';
}

// ─────────────────────────────────────────────
//  Render table
// ─────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById('rankBody');
  tbody.innerHTML = '';

  let dividerInserted = false;

  items.forEach((item, idx) => {
    // Insert red divider before the first unranked row
    if (!item.found && !dividerInserted) {
      dividerInserted = true;
      const divTr = document.createElement('tr');
      divTr.className = 'unranked-divider';
      divTr.draggable = false;
      divTr.innerHTML = `<td colspan="5">&#9660; Unranked — not found in rank data for this selection &nbsp;(drag to reorder among ranked)</td>`;
      tbody.appendChild(divTr);
    }

    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.idx = String(idx);
    if (!item.found) tr.classList.add('not-found');

    const notFoundTag  = item.found ? '' : '<span class="tag tag-notfound">UNRANKED</span>';
    const altQuotaTag  = (item.found && item.quotaUsed !== item.primaryQuota)
      ? `<span class="tag tag-altquota" title="No ${escHtml(item.primaryQuota)} data; showing ${escHtml(item.quotaUsed)} quota">${escHtml(item.quotaUsed)}</span>` : '';
    const orClass = !item.found ? ' na' : '';

    tr.innerHTML = `
      <td class="rank-num" title="Click to move to a specific rank">${idx + 1}</td>
      <td class="drag-handle" title="Drag to reorder">&#8942;</td>
      <td>
        <div class="inst-name">${escHtml(item.institute)}${notFoundTag}${altQuotaTag}</div>
        <div class="prog-name">${escHtml(item.program)}</div>
      </td>
      <td class="num-col${orClass}">${escHtml(item.openingRankDisplay)}</td>
      <td class="num-col${orClass}">${escHtml(item.closingRankDisplay)}</td>
      <td class="action-col">
        <button class="action-btn btn-bottom" title="Move to bottom">&#8659;</button>
        <button class="action-btn btn-remove" title="Remove">&#10005;</button>
      </td>
    `;

    tr.querySelector('.rank-num').addEventListener('click', function () {
      startRankEdit(this, idx);
    });
    tr.querySelector('.btn-bottom').addEventListener('click', () => moveToBottom(idx));
    tr.querySelector('.btn-remove').addEventListener('click', () => removeItem(idx));

    tr.addEventListener('dragstart', onDragStart);
    tr.addEventListener('dragenter', onDragEnter);
    tr.addEventListener('dragover',  onDragOver);
    tr.addEventListener('dragleave', onDragLeave);
    tr.addEventListener('drop',      onDrop);
    tr.addEventListener('dragend',   onDragEnd);

    tbody.appendChild(tr);
  });
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function removeItem(idx) {
  items.splice(idx, 1);
  renderTable();
}

function moveToBottom(idx) {
  const [item] = items.splice(idx, 1);
  items.push(item);
  renderTable();
}

// ─────────────────────────────────────────────
//  Inline rank editing (click rank number → type target rank → Enter)
// ─────────────────────────────────────────────

function startRankEdit(cell, fromIdx) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = String(items.length);
  input.value = String(fromIdx + 1);
  input.className = 'rank-input';

  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    const toIdx = parseInt(input.value) - 1;
    if (!isNaN(toIdx) && toIdx >= 0 && toIdx < items.length && toIdx !== fromIdx) {
      const [moved] = items.splice(fromIdx, 1);
      items.splice(toIdx, 0, moved);
    }
    renderTable();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { applied = true; renderTable(); }
  });
  input.addEventListener('blur', apply);
}

// ─────────────────────────────────────────────
//  Drag-and-drop
// ─────────────────────────────────────────────

function onDragStart(e) {
  dragSrcIdx = parseInt(this.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcIdx);
  setTimeout(() => this.classList.add('dragging'), 0);
}

function onDragEnter(e) {
  e.preventDefault();
  clearDragIndicators();
  const targetIdx = parseInt(this.dataset.idx);
  if (isNaN(targetIdx)) return;
  this.classList.add(targetIdx < dragSrcIdx ? 'drag-above' : 'drag-below');
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragLeave() {
  this.classList.remove('drag-above', 'drag-below');
}

function onDrop(e) {
  e.preventDefault();
  clearDragIndicators();
  const targetIdx = parseInt(this.dataset.idx);
  if (dragSrcIdx === null || isNaN(targetIdx) || dragSrcIdx === targetIdx) return;
  const moved = items.splice(dragSrcIdx, 1)[0];
  items.splice(targetIdx, 0, moved);
  renderTable();
}

function onDragEnd() {
  clearDragIndicators();
  document.querySelectorAll('tr.dragging').forEach(r => r.classList.remove('dragging'));
  dragSrcIdx = null;
}

function clearDragIndicators() {
  document.querySelectorAll('tr.drag-above, tr.drag-below').forEach(r => {
    r.classList.remove('drag-above', 'drag-below');
  });
}

// ─────────────────────────────────────────────
//  Copy list to clipboard
// ─────────────────────────────────────────────

function copyList() {
  const text = items.map(item => `${item.institute} | ${item.program}`).join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', false));
}

// ─────────────────────────────────────────────
//  Reset — remove all filled choices
// ─────────────────────────────────────────────

async function resetChoices() {
  const btn = document.getElementById('resetBtn');
  btn.disabled = true;
  btn.textContent = 'Resetting…';

  const stored = await chrome.storage.local.get(['josaaTabId']);
  let tabId = stored.josaaTabId;
  if (tabId) { try { await chrome.tabs.get(tabId); } catch { tabId = null; } }
  if (!tabId) {
    const nicTabs = await chrome.tabs.query({ url: '*://*.nic.in/*' });
    if (nicTabs.length) tabId = nicTabs[0].id;
  }

  if (!tabId) {
    showToast('JoSAA tab not found.', true);
    btn.disabled = false;
    btn.textContent = '✕ Reset All';
    return;
  }

  try {
    await chrome.tabs.update(tabId, { active: true });
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageResetFunction,
      world: 'MAIN',
    });
    const count = injected[0].result;
    showToast(`Removed ${count} filled choice${count !== 1 ? 's' : ''}.`, false);
  } catch (err) {
    showToast('Could not reset: ' + err.message, true);
  }

  btn.disabled = false;
  btn.textContent = '✕ Reset All';
}

// ─────────────────────────────────────────────
//  Confirm & Fill
// ─────────────────────────────────────────────

async function confirmAndFill() {
  const btn = document.getElementById('confirmBtn');
  btn.disabled = true;
  btn.textContent = 'Filling…';

  const autoAccept    = document.getElementById('autoAccept').checked;
  const clearExisting = document.getElementById('clearExisting').checked;
  const choices = items.map(item => ({ institute: item.institute, program: item.program }));

  // Find JoSAA tab
  const stored = await chrome.storage.local.get(['josaaTabId']);
  let tabId = stored.josaaTabId;

  // Verify tab is still open
  if (tabId) {
    try { await chrome.tabs.get(tabId); }
    catch { tabId = null; }
  }
  // Fallback: find any NIC.in tab
  if (!tabId) {
    const nicTabs = await chrome.tabs.query({ url: '*://*.nic.in/*' });
    if (nicTabs.length) tabId = nicTabs[0].id;
  }

  if (!tabId) {
    copyList();
    showToast('JoSAA tab not found — list copied to clipboard instead.', true);
    btn.disabled = false;
    btn.textContent = '▶ Confirm & Fill Choices';
    return;
  }

  try {
    await chrome.tabs.update(tabId, { active: true });

    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageFillerFunction,
      args: [choices, autoAccept, clearExisting],
      world: 'MAIN',
    });

    const results  = injected[0].result;
    const added    = results.filter(r => r.status === 'added').length;
    const skipped  = results.filter(r => r.status === 'already_filled').length;
    const notFound = results.filter(r => r.status === 'not_found').length;

    showToast(`Done! Added: ${added} | Skipped: ${skipped} | Not found: ${notFound}`, false);
    btn.textContent = `✓ Filled (${added} added)`;
  } catch (err) {
    showToast('Could not fill: ' + err.message, true);
    btn.disabled = false;
    btn.textContent = '▶ Confirm & Fill Choices';
  }
}

// ─────────────────────────────────────────────
//  Loading state
// ─────────────────────────────────────────────

function setLoading(msg) {
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('mainContent').style.display = 'none';
}

function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';
}

// ─────────────────────────────────────────────
//  Toast
// ─────────────────────────────────────────────

function showToast(msg, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = isError ? 'error' : '';
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ─────────────────────────────────────────────
//  Injected into JoSAA page
// ─────────────────────────────────────────────

function pageFillerFunction(choices, autoAccept, clearExisting) {
  function normalizeText(s) {
    return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isMatch(userInput, pageText, pageCode) {
    const inp = normalizeText(userInput);
    const txt = normalizeText(pageText);
    if (userInput.trim() === (pageCode || '').trim()) return true;
    if (txt.includes(inp)) return true;
    const inpW = new Set(inp.split(/\s+/).filter(w => w.length >= 3));
    const txtW = new Set(txt.split(/\s+/).filter(w => w.length >= 3));
    if (!inpW.size || !txtW.size) return false;
    let inter = 0;
    for (const w of inpW) if (txtW.has(w)) inter++;
    return inter / (inpW.size + txtW.size - inter) >= 0.90;
  }

  const results = [];
  const origConfirm = window.confirm;
  const origAlert   = window.alert;
  let   observer    = null;

  if (autoAccept) {
    // Override native browser dialogs
    window.confirm = () => true;
    window.alert   = () => {};

    // Also auto-click DOM-based modals (jQuery UI, Bootstrap, ASP.NET panels)
    // Exclude the JoSAA choice tables so we don't click Add/Remove by mistake
    const autoClickModal = () => {
      const selectors = [
        '.modal.show .btn-primary', '.modal.show .btn-success',
        '.modal-footer .btn-primary', '.modal-footer .btn-ok',
        '[role="dialog"] .btn-primary', '[role="alertdialog"] .btn-primary',
        '.ui-dialog-buttonset button',
        'input[type="button"][value="OK"]', 'input[type="button"][value="Ok"]',
        'input[type="button"][value="Yes"]', 'input[type="button"][value="Continue"]',
        'input[type="submit"][value="OK"]',
        'button[id$="OK"]', 'button[id$="Ok"]', 'button[id$="Yes"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null &&
            !el.closest('#avlChoiceContainer') &&
            !el.closest('#filledChoiceContainer')) {
          el.click(); break;
        }
      }
    };
    observer = new MutationObserver(autoClickModal);
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'style'],
    });
    autoClickModal(); // handle any dialog already visible
  }

  try {
    if (clearExisting) {
      Array.from(document.querySelectorAll('#filledChoiceContainer input[type="button"]'))
        .filter(b => b.value === 'Remove')
        .forEach(b => b.click());
    }

    for (const { institute, program } of choices) {
      const cleanText = s => (s || '').replace(/\s+/g, ' ').trim();

      let alreadyFilled = false;
      for (const row of document.querySelectorAll('#filledChoiceContainer tr')) {
        const instnm = cleanText((row.querySelector('.instnm') || {}).textContent);
        const brnm   = cleanText((row.querySelector('.brnm')   || {}).textContent);
        const instcd = cleanText((row.querySelector('.instcd') || {}).textContent);
        const brcd   = cleanText((row.querySelector('.brcd')   || {}).textContent);
        if (!instnm) continue;
        if (isMatch(institute, instnm, instcd) && isMatch(program, brnm, brcd)) {
          results.push({ institute: instnm, program: brnm, status: 'already_filled' });
          alreadyFilled = true; break;
        }
      }
      if (alreadyFilled) continue;

      let found = false;
      for (const row of Array.from(document.querySelectorAll('#avlChoiceContainer tr'))) {
        const instnm = cleanText((row.querySelector('.instnm') || {}).textContent);
        const brnm   = cleanText((row.querySelector('.brnm')   || {}).textContent);
        const instcd = cleanText((row.querySelector('.instcd') || {}).textContent);
        const brcd   = cleanText((row.querySelector('.brcd')   || {}).textContent);
        if (!instnm) continue;
        if (isMatch(institute, instnm, instcd) && isMatch(program, brnm, brcd)) {
          const addBtn = Array.from(row.querySelectorAll('input[type="button"]')).find(b => b.value === 'Add');
          if (addBtn) {
            addBtn.click();
            results.push({ institute: instnm, program: brnm, status: 'added' });
            found = true; break;
          }
        }
      }
      if (!found) results.push({ institute, program, status: 'not_found' });
    }
  } finally {
    // Delay restoring so async AJAX responses (ASP.NET UpdatePanel) are still caught
    setTimeout(() => {
      window.confirm = origConfirm;
      window.alert   = origAlert;
      if (observer) { observer.disconnect(); observer = null; }
    }, autoAccept ? 15000 : 0);
  }
  return results;
}

// ─────────────────────────────────────────────
//  Injected into JoSAA page — removes all filled choices
// ─────────────────────────────────────────────

function pageResetFunction() {
  const origConfirm = window.confirm;
  const origAlert   = window.alert;
  window.confirm = () => true;
  window.alert   = () => {};

  const autoClickModal = () => {
    const selectors = [
      '.modal.show .btn-primary', '.modal.show .btn-success',
      '.modal-footer .btn-primary',
      '[role="dialog"] .btn-primary', '[role="alertdialog"] .btn-primary',
      '.ui-dialog-buttonset button',
      'input[type="button"][value="OK"]', 'input[type="button"][value="Ok"]',
      'input[type="button"][value="Yes"]', 'input[type="button"][value="Continue"]',
      'input[type="submit"][value="OK"]',
      'button[id$="OK"]', 'button[id$="Ok"]', 'button[id$="Yes"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null &&
          !el.closest('#avlChoiceContainer') &&
          !el.closest('#filledChoiceContainer')) {
        el.click(); break;
      }
    }
  };
  const observer = new MutationObserver(autoClickModal);
  observer.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style'],
  });
  autoClickModal();

  const removeBtns = Array.from(
    document.querySelectorAll('#filledChoiceContainer input[type="button"]')
  ).filter(b => b.value === 'Remove');
  removeBtns.forEach(b => b.click());
  const count = removeBtns.length;

  setTimeout(() => {
    window.confirm = origConfirm;
    window.alert   = origAlert;
    observer.disconnect();
  }, 15000);

  return count;
}

// ─────────────────────────────────────────────

init();
