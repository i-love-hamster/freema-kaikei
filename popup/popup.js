import { toJournalGroups, DEFAULT_ACCOUNTS } from '../lib/journal.js';
import { generateFreeeCsv }                from '../lib/csv_freee.js';
import { generateMfCsv }                   from '../lib/csv_mf.js';
import { parseMercariPage }                from '../lib/mercari_parser.js';

// ---- 状態 ----
let allRecords   = [];   // 読み込んだ全取引
let shownRecords = [];   // 月フィルター後の表示中取引
let currentMonth = 'all';
let settings = {
  saasType: 'freee',
  accounts: { ...DEFAULT_ACCOUNTS },
};

// ---- DOM refs ----
const saasButtons       = document.querySelectorAll('.saas-btn');
const yearSelect        = document.getElementById('year-select');
const fetchBtn          = document.getElementById('fetch-btn');
const statusEl          = document.getElementById('status');
const filterSection     = document.getElementById('filter-section');
const listSection       = document.getElementById('list-section');
const exportSection     = document.getElementById('export-section');
const transactionList   = document.getElementById('transaction-list');
const selectedCountEl   = document.getElementById('selected-count');
const settingsBtn       = document.getElementById('settings-btn');
const selectAllBtn      = document.getElementById('select-all-btn');
const deselectAllBtn    = document.getElementById('deselect-all-btn');
const exportBtn         = document.getElementById('export-btn');

// ---- 初期化 ----
async function init() {
  // 設定を読み込む
  const data = await chrome.storage.sync.get(null);
  if (data.saasType) settings.saasType = data.saasType;
  if (data.accounts) settings.accounts = { ...DEFAULT_ACCOUNTS, ...data.accounts };

  updateSaasButtons();

  // 年セレクトを生成（現在年から5年前まで）
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 5; y--) {
    const opt = document.createElement('option');
    opt.value     = y;
    opt.textContent = `${y}年`;
    yearSelect.appendChild(opt);
  }
}

function updateSaasButtons() {
  saasButtons.forEach(btn =>
    btn.classList.toggle('active', btn.dataset.saas === settings.saasType)
  );
}

// ---- SaaS 切り替え ----
saasButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    settings.saasType = btn.dataset.saas;
    updateSaasButtons();
    await chrome.storage.sync.set({ saasType: settings.saasType });
  });
});

// ---- 設定ページを開く ----
settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---- データ読み込み ----
fetchBtn.addEventListener('click', async () => {
  const year = parseInt(yearSelect.value, 10);
  if (!year) return;

  // UI リセット
  allRecords   = [];
  shownRecords = [];
  hideResults();
  currentMonth = 'all';
  document.querySelectorAll('.month-btn')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.month === 'all'));

  fetchBtn.disabled = true;
  showStatus('loading', `${year}年のデータを読み込み中...`);

  // service worker からの進捗通知を受け取る
  const onProgress = (msg) => {
    if (msg.action === 'FETCH_PROGRESS') {
      showStatus('loading', `ページ ${msg.pageCount} 読み込み中...`);
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'FETCH_MERCARI_SALES',
      year,
    });

    console.log('[popup] response from service worker:', response);

    if (response.error) {
      if (response.debug) {
        console.warn('[popup] debug info:', response.debug);
      }
      const detail = response.debug
        ? `responseUrl=${response.debug.responseUrl}` + (response.debug.htmlSnippet ? ` | HTML先頭: ${response.debug.htmlSnippet}` : '')
        : response.message;
      showStatus('error', errorMessage(response.error, detail));
      return;
    }

    // HTMLのパースはpopup側で行う（service workerはDOMParserが使えないため）
    allRecords = [];
    for (const [i, html] of response.htmlPages.entries()) {
      const records = parseMercariPage(html);
      console.log(`[popup] parseMercariPage page=${i + 1}:`, records === null ? 'null' : `${records.length} records`);
      if (records === null) {
        if (allRecords.length === 0) {
          const snippet = html.substring(0, 300).replace(/\s+/g, ' ');
          console.warn('[popup] parseMercariPage returned null on page 1. HTML snippet:', snippet);
          showStatus('error', errorMessage('NOT_LOGGED_IN', `HTML先頭: ${snippet}`));
          return;
        }
        break;
      }
      allRecords.push(...records);
    }

    if (allRecords.length === 0) {
      showStatus('success', `${year}年の販売履歴は 0 件です`);
      return;
    }

    showStatus('success', `${allRecords.length}件を読み込みました`);
    applyMonthFilter();
    filterSection.classList.remove('hidden');
    listSection.classList.remove('hidden');
    exportSection.classList.remove('hidden');

  } catch (err) {
    showStatus('error', `エラーが発生しました: ${err.message}`);
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    fetchBtn.disabled = false;
  }
});

function errorMessage(code, detail) {
  const map = {
    NOT_LOGGED_IN: 'メルカリにログインされていないか、ページが読み取れませんでした',
    FETCH_FAILED:  'ページの取得に失敗しました（ログイン状態を確認してください）',
    HTTP_ERROR:    'HTTPエラーが発生しました',
    UNEXPECTED:    '予期しないエラーが発生しました',
  };
  const base = map[code] || `エラー: ${code}`;
  return detail ? `${base}（${detail}）` : base;
}

function showStatus(type, msg) {
  statusEl.className  = `status ${type}`;
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function hideResults() {
  filterSection.classList.add('hidden');
  listSection.classList.add('hidden');
  exportSection.classList.add('hidden');
  transactionList.innerHTML = '';
}

// ---- 月フィルター ----
document.querySelectorAll('.month-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMonth = btn.dataset.month;
    document.querySelectorAll('.month-btn')
      .forEach(b => b.classList.toggle('active', b.dataset.month === currentMonth));
    applyMonthFilter();
  });
});

function applyMonthFilter() {
  if (currentMonth === 'all') {
    shownRecords = allRecords;
  } else {
    const m = currentMonth.padStart(2, '0'); // "2" → "02"
    shownRecords = allRecords.filter(r => r.date.split('/')[1] === m);
  }
  renderList(shownRecords);
}

// ---- 取引一覧レンダリング ----
function renderList(records) {
  transactionList.innerHTML = '';

  records.forEach((record, i) => {
    const item = document.createElement('div');
    item.className    = 'tx-item checked';
    item.dataset.index = i;

    const checkbox = document.createElement('input');
    checkbox.type      = 'checkbox';
    checkbox.className = 'tx-checkbox';
    checkbox.checked   = true;

    const dateEl  = document.createElement('span');
    dateEl.className   = 'tx-date';
    dateEl.textContent = record.date.slice(5); // "YYYY/MM/DD" → "MM/DD"

    const titleEl = document.createElement('span');
    titleEl.className   = 'tx-title';
    titleEl.textContent = record.title;
    titleEl.title       = record.title; // tooltip でフル表示

    const priceEl = document.createElement('span');
    priceEl.className   = 'tx-price';
    priceEl.textContent = `¥${record.price.toLocaleString()}`;

    // 行クリックでチェックをトグル（チェックボックス直接クリックは除外）
    item.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      item.classList.toggle('checked', checkbox.checked);
      updateCount();
    });

    checkbox.addEventListener('change', () => {
      item.classList.toggle('checked', checkbox.checked);
      updateCount();
    });

    item.append(checkbox, dateEl, titleEl, priceEl);
    transactionList.appendChild(item);
  });

  updateCount();
}

function updateCount() {
  const checked = transactionList.querySelectorAll('.tx-checkbox:checked').length;
  selectedCountEl.textContent = `${checked}件選択中`;
}

// ---- 全選択 / 全解除 ----
selectAllBtn.addEventListener('click', () => {
  transactionList.querySelectorAll('.tx-item').forEach(item => {
    item.querySelector('.tx-checkbox').checked = true;
    item.classList.add('checked');
  });
  updateCount();
});

deselectAllBtn.addEventListener('click', () => {
  transactionList.querySelectorAll('.tx-item').forEach(item => {
    item.querySelector('.tx-checkbox').checked = false;
    item.classList.remove('checked');
  });
  updateCount();
});

// ---- CSV エクスポート ----
exportBtn.addEventListener('click', async () => {
  // チェック済み取引を収集
  const items = transactionList.querySelectorAll('.tx-item');
  const selectedRecords = shownRecords.filter((_, i) => {
    const item = items[i];
    return item && item.querySelector('.tx-checkbox').checked;
  });

  if (selectedRecords.length === 0) {
    alert('エクスポートする取引を選択してください');
    return;
  }

  // 設定を最新に更新（options で変更されている場合を考慮）
  const data = await chrome.storage.sync.get(null);
  if (data.saasType) settings.saasType = data.saasType;
  if (data.accounts) settings.accounts = { ...DEFAULT_ACCOUNTS, ...data.accounts };

  let csvContent;
  if (settings.saasType === 'freee') {
    csvContent = generateFreeeCsv(selectedRecords, settings.accounts);
  } else {
    const journalGroups = toJournalGroups(selectedRecords, settings.accounts, settings.saasType);
    csvContent = generateMfCsv(journalGroups);
  }

  const filename = buildFilename(settings.saasType, selectedRecords);
  downloadCsv(csvContent, filename);
});

/**
 * ファイル名を決定する
 * - 単一月: mercari_freee_202602.csv
 * - 複数月: mercari_freee_2026.csv
 */
function buildFilename(saasType, records) {
  const suffix    = saasType === 'freee' ? 'freee' : 'mf';
  const yearMonths = [...new Set(
    records.map(r => r.date.slice(0, 7).replace('/', '')) // "2026/02" → "202602"
  )];
  const datePart = yearMonths.length === 1
    ? yearMonths[0]
    : records[0].date.slice(0, 4);
  return `mercari_${suffix}_${datePart}.csv`;
}

/** UTF-8 CSV をダウンロード（BOMなし） */
function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- 起動 ----
init();
