'use strict';

document.getElementById('fillBtn').addEventListener('click', runFiller);
document.getElementById('downloadBtn').addEventListener('click', runDownload);
document.getElementById('rankBtn').addEventListener('click', openRanker);
document.getElementById('rankFromListBtn').addEventListener('click', openRankerFromList);
document.getElementById('resetBtn').addEventListener('click', runReset);

// Show/hide "Rank Pasted List" button whenever textarea content changes
document.getElementById('choiceInput').addEventListener('input', syncRankFromListBtn);
function syncRankFromListBtn() {
  const raw   = document.getElementById('choiceInput').value.trim();
  const count = raw ? parseChoices(raw).length : 0;
  const btn   = document.getElementById('rankFromListBtn');
  if (count > 0) {
    btn.style.display = 'block';
    btn.textContent   = `⧻ Rank Pasted List (${count} entr${count === 1 ? 'y' : 'ies'})`;
  } else {
    btn.style.display = 'none';
  }
}

// ─────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────

function parseChoices(raw) {
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split('|').map(p => p.trim());
      return { institute: parts[0] || '', program: parts[1] || '' };
    })
    .filter(c => c.institute);
}

// ─────────────────────────────────────────────
//  Open Ranker — extract all choices from page
// ─────────────────────────────────────────────

async function openRanker() {
  const btn = document.getElementById('rankBtn');
  btn.disabled = true;
  btn.textContent = 'Reading page…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageExtractChoicesFunction,
    });

    const pageChoices = injected[0].result;

    if (!pageChoices || pageChoices.length === 0) {
      alert('No available choices found on the page.\nMake sure you are on the JoSAA Choice Filling page.');
      btn.disabled = false;
      btn.textContent = '⊹ Open Ranker';
      return;
    }

    await chrome.storage.local.set({
      pageChoices,
      josaaTabId:    tab.id,
      autoAccept:    document.getElementById('autoAccept').checked,
      clearExisting: document.getElementById('clearExisting').checked,
      rankerNote:    null,
      preserveOrder: false,
    });

    chrome.tabs.create({ url: chrome.runtime.getURL('ranker.html') });
  } catch (err) {
    alert('Error: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = '⊹ Open Ranker';
}

// ─────────────────────────────────────────────
//  Open Ranker — from pasted list only
// ─────────────────────────────────────────────

async function openRankerFromList() {
  const raw    = document.getElementById('choiceInput').value.trim();
  const pasted = parseChoices(raw);
  if (!pasted.length) { openRanker(); return; }

  const btn = document.getElementById('rankFromListBtn');
  btn.disabled = true;
  btn.textContent = 'Reading page…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageExtractChoicesFunction,
    });
    const allPageChoices = injected[0].result;
    if (!allPageChoices || !allPageChoices.length) {
      alert('No available choices found on the page.\nMake sure you are on the JoSAA Choice Filling page.');
      btn.disabled = false;
      syncRankFromListBtn();
      return;
    }

    // Match each pasted entry to its page choice (same Jaccard logic as pageFillerFunction)
    function normText(s) {
      return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function choiceMatch(userInput, pageText, pageCode) {
      const inp = normText(userInput), txt = normText(pageText);
      if (userInput.trim() === (pageCode || '').trim()) return true;
      if (txt.includes(inp)) return true;
      const iW = new Set(inp.split(/\s+/).filter(w => w.length >= 3));
      const tW = new Set(txt.split(/\s+/).filter(w => w.length >= 3));
      if (!iW.size || !tW.size) return false;
      let inter = 0;
      for (const w of iW) if (tW.has(w)) inter++;
      return inter / (iW.size + tW.size - inter) >= 0.90;
    }

    const seen       = new Set();
    const pageChoices = [];
    for (const paste of pasted) {
      for (const pg of allPageChoices) {
        const key = `${pg.instcd}||${pg.brcd}`;
        if (seen.has(key)) continue;
        if (choiceMatch(paste.institute, pg.institute, pg.instcd) &&
            choiceMatch(paste.program,   pg.program,   pg.brcd)) {
          pageChoices.push(pg);
          seen.add(key);
          break;
        }
      }
    }

    const unmatched = pasted.length - pageChoices.length;
    if (!pageChoices.length) {
      alert('None of the pasted entries matched any choice on the page.\nCheck that you are on the JoSAA Choice Filling page.');
      btn.disabled = false;
      syncRankFromListBtn();
      return;
    }

    await chrome.storage.local.set({
      pageChoices,
      josaaTabId:    tab.id,
      autoAccept:    document.getElementById('autoAccept').checked,
      clearExisting: document.getElementById('clearExisting').checked,
      rankerNote:    unmatched > 0
        ? `${unmatched} pasted entr${unmatched === 1 ? 'y' : 'ies'} not found on page and excluded`
        : null,
      preserveOrder: true,
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('ranker.html') });
  } catch (err) {
    alert('Error: ' + err.message);
  }

  btn.disabled = false;
  syncRankFromListBtn();
}

// ─────────────────────────────────────────────
//  Reset — remove all filled choices
// ─────────────────────────────────────────────

async function runReset() {
  const btn = document.getElementById('resetBtn');
  btn.disabled = true;
  btn.textContent = 'Resetting…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageResetFunction,
      world: 'MAIN',
    });
    const count = injected[0].result;
    displayResults([{ institute: `Removed ${count} filled choice${count !== 1 ? 's' : ''}`, program: '', status: 'added' }]);
  } catch (err) {
    alert('Error: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = '✕ Reset All';
}

// ─────────────────────────────────────────────
//  Fill Choices (manual)
// ─────────────────────────────────────────────

async function runFiller() {
  const raw = document.getElementById('choiceInput').value.trim();
  const autoAccept    = document.getElementById('autoAccept').checked;
  const clearExisting = document.getElementById('clearExisting').checked;
  if (!raw) return;

  const choices = parseChoices(raw);
  if (!choices.length) return;

  const btn = document.getElementById('fillBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';

  let results;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFillerFunction,
      args: [choices, autoAccept, clearExisting],
      world: 'MAIN',
    });
    results = injected[0].result;
  } catch (err) {
    results = [{ institute: 'Error', program: err.message, status: 'not_found' }];
  }

  btn.disabled = false;
  btn.textContent = '▶ Fill Choices';
  displayResults(results);
}

function displayResults(results) {
  const logArea = document.getElementById('logArea');
  const summary = document.getElementById('summary');
  const logList = document.getElementById('logList');

  logArea.style.display = 'block';
  logList.innerHTML = '';

  const counts = { added: 0, already_filled: 0, not_found: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  summary.textContent =
    `Added: ${counts.added}  |  Already filled: ${counts.already_filled}  |  Not found: ${counts.not_found}`;

  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const badge = document.createElement('span');
    badge.className = 'badge';
    if (r.status === 'added')          { badge.classList.add('badge-added');    badge.textContent = 'ADDED'; }
    else if (r.status === 'already_filled') { badge.classList.add('badge-skip'); badge.textContent = 'SKIP'; }
    else                               { badge.classList.add('badge-notfound'); badge.textContent = 'NOT FOUND'; }
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = `${r.institute} — ${r.program}`;
    row.appendChild(badge);
    row.appendChild(text);
    logList.appendChild(row);
  }
}

// ─────────────────────────────────────────────
//  Download available choices as CSV
// ─────────────────────────────────────────────

async function runDownload() {
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Extracting…';

  let data;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageExtractTableFunction,
    });
    data = injected[0].result;
  } catch (err) {
    alert('Error: ' + err.message);
    btn.disabled = false; btn.textContent = '↓ Download CSV';
    return;
  }

  if (!data || !data.rows.length) {
    alert('No available choices found on the page.');
    btn.disabled = false; btn.textContent = '↓ Download CSV';
    return;
  }

  const cell = v => {
    const s = String(v == null ? '' : v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [data.headers, ...data.rows].map(r => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'josaa_available_choices.csv'; a.click();
  URL.revokeObjectURL(url);

  btn.disabled = false; btn.textContent = '↓ Download CSV';
}

// ─────────────────────────────────────────────
//  Injected into page context
// ─────────────────────────────────────────────

// Extracts institute+program pairs from the available choices table
function pageExtractChoicesFunction() {
  const choices = [];
  for (const row of document.querySelectorAll('#avlChoiceContainer tr')) {
    const instnm = (row.querySelector('.instnm') || {}).textContent || '';
    const brnm   = (row.querySelector('.brnm')   || {}).textContent || '';
    const instcd = (row.querySelector('.instcd') || {}).textContent || '';
    const brcd   = (row.querySelector('.brcd')   || {}).textContent || '';
    if (!instnm.trim()) continue;
    choices.push({
      institute: instnm.replace(/\s+/g, ' ').trim(),
      program:   brnm.replace(/\s+/g, ' ').trim(),
      instcd:    instcd.trim(),
      brcd:      brcd.trim(),
    });
  }
  return choices;
}

// Extracts full table data for CSV download
function pageExtractTableFunction() {
  const container = document.getElementById('avlChoiceContainer');
  if (!container) return { headers: [], rows: [] };

  const thEls = Array.from(container.querySelectorAll('th'));
  let headers = thEls.map(th => th.textContent.trim()).filter(h => h);
  if (!headers.length) {
    headers = ['Inst Code', 'Institute Name', 'Program Code', 'Program Name',
               'Quota', 'Seat Type', 'Gender', 'Opening Rank', 'Closing Rank'];
  }

  const rows = [];
  for (const tr of Array.from(container.querySelectorAll('tr')).filter(r => !r.querySelector('th'))) {
    const tds = Array.from(tr.querySelectorAll('td'));
    if (!tds.length) continue;

    const byClass = {
      instcd:   (tr.querySelector('.instcd')  || {}).textContent,
      instnm:   (tr.querySelector('.instnm')  || {}).textContent,
      brcd:     (tr.querySelector('.brcd')    || {}).textContent,
      brnm:     (tr.querySelector('.brnm')    || {}).textContent,
      quota:    (tr.querySelector('.quota')   || {}).textContent,
      seattype: (tr.querySelector('.seattype') || tr.querySelector('.styp') || {}).textContent,
      gender:   (tr.querySelector('.gender')  || tr.querySelector('.gndr') || {}).textContent,
      oprank:   (tr.querySelector('.oprank')  || tr.querySelector('.openrank')  || {}).textContent,
      clrank:   (tr.querySelector('.clrank')  || tr.querySelector('.closerank') || {}).textContent,
    };

    let row;
    if ((byClass.instnm || '').trim()) {
      row = [byClass.instcd, byClass.instnm, byClass.brcd, byClass.brnm,
             byClass.quota, byClass.seattype, byClass.gender, byClass.oprank, byClass.clrank]
        .map(v => (v || '').trim());
    } else {
      row = tds.filter(td => !td.querySelector('input[type="button"]')).map(td => td.textContent.trim());
    }
    while (row.length < headers.length) row.push('');
    row = row.slice(0, headers.length);
    if (row.every(v => !v)) continue;
    rows.push(row);
  }
  return { headers, rows };
}

// Fills choices on the JoSAA page
function pageFillerFunction(choices, autoAccept, clearExisting) {
  function normalizeText(s) {
    return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isMatch(userInput, pageText, pageCode) {
    const inp = normalizeText(userInput);
    const txt = normalizeText(pageText);
    if (userInput.trim() === (pageCode || '').trim()) return true;
    if (txt.includes(inp)) return true;
    // Jaccard on ≥3-char words, threshold 0.90.
    // ≥3 (not 4) so short discriminators like "mba" count against "m.tech".
    // 0.90 (not 0.85) so CSE vs CSE(DataSci) and ECE vs ECE(Avionics) don't collide
    // (their Jaccard is 6/7 ≈ 0.857 with 1 extra specialization word).
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

// Removes all filled choices from the JoSAA page
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
