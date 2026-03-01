import { DEFAULT_ACCOUNTS } from '../lib/journal.js';

const FIELD_MAP = {
  'account-sales':       'sales',
  'account-receivable':  'receivable',
  'account-commission':  'commission',
  'account-shipping':    'shipping',
  'account-other-cost':  'otherCost',
};

async function loadSettings() {
  const data = await chrome.storage.sync.get(null);

  const saasType = data.saasType || 'freee';
  document.getElementById('saas-type').value = saasType;

  const accounts = { ...DEFAULT_ACCOUNTS, ...(data.accounts || {}) };
  for (const [fieldId, key] of Object.entries(FIELD_MAP)) {
    document.getElementById(fieldId).value = accounts[key] || DEFAULT_ACCOUNTS[key];
  }
}

async function saveSettings() {
  const saasType = document.getElementById('saas-type').value;

  const accounts = {};
  for (const [fieldId, key] of Object.entries(FIELD_MAP)) {
    const val = document.getElementById(fieldId).value.trim();
    accounts[key] = val || DEFAULT_ACCOUNTS[key];
  }

  await chrome.storage.sync.set({ saasType, accounts });

  const msg = document.getElementById('save-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2200);
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  document.getElementById('save-btn').addEventListener('click', saveSettings);
});
