/**
 * @typedef {Object} SaleRecord
 * @property {'mercari'|'rakuma'|'paypay'} platform
 * @property {string} date        - YYYY/MM/DD
 * @property {string} title
 * @property {number} price       - 商品価格（税込）
 * @property {number} commission  - 販売手数料（税込）
 * @property {number} shipping    - 送料（税込）
 * @property {number} otherCost   - 他費用（税込）、なければ 0
 * @property {number} taxRate     - 0.10 など
 * @property {number} profit      - 販売利益（= 売掛金借方金額）
 */

/**
 * @typedef {Object} JournalSide
 * @property {string} account
 * @property {number} amount
 * @property {string} tax
 * @property {number} taxAmount
 */

/**
 * @typedef {Object} JournalEntry
 * @property {number} no
 * @property {string} date
 * @property {JournalSide} debit
 * @property {JournalSide|null} credit  - null = 借方のみの行
 * @property {string} note
 */

export const DEFAULT_ACCOUNTS = {
  sales:      '売上高',
  receivable: '売掛金',
  commission: '支払手数料',
  shipping:   '荷造運賃',
  otherCost:  '広告宣伝費',
};

/** 税込金額から消費税額を逆算（切り捨て） */
function calcTax(amount) {
  return Math.floor(amount / 11);
}

/** 売上税区分ラベル（freee と MFクラウドで書式が異なる） */
function salesTaxLabel(rate, saasType) {
  const pct = Math.round(rate * 100);
  return saasType === 'freee' ? `課税売上${pct}%` : `課税売上 ${pct}%`;
}

/** 仕入税区分ラベル */
function purchaseTaxLabel(saasType) {
  return saasType === 'freee' ? '課対仕入10%' : '課税仕入 10%';
}

/**
 * SaleRecord 1件 → JournalEntry[] に変換（複合仕訳）
 * @param {SaleRecord} record
 * @param {Object} accounts
 * @param {number} no
 * @param {'freee'|'moneyforward'} saasType
 * @returns {JournalEntry[]}
 */
function recordToEntries(record, accounts, no, saasType) {
  const acct = { ...DEFAULT_ACCOUNTS, ...accounts };
  const purchaseTax = purchaseTaxLabel(saasType);
  const entries = [];

  // 行1: 売掛金（借方）/ 売上高（貸方）
  entries.push({
    no,
    date: record.date,
    debit: {
      account:   acct.receivable,
      amount:    record.profit,
      tax:       '対象外',
      taxAmount: 0,
    },
    credit: {
      account:   acct.sales,
      amount:    record.price,
      tax:       salesTaxLabel(record.taxRate, saasType),
      taxAmount: calcTax(record.price),
    },
    note: `${record.title}（メルカリ）`,
  });

  // 行2: 支払手数料（借方のみ）
  if (record.commission > 0) {
    entries.push({
      no,
      date: record.date,
      debit: {
        account:   acct.commission,
        amount:    record.commission,
        tax:       purchaseTax,
        taxAmount: calcTax(record.commission),
      },
      credit: null,
      note: 'メルカリ販売手数料',
    });
  }

  // 行3: 荷造運賃（借方のみ）
  if (record.shipping > 0) {
    entries.push({
      no,
      date: record.date,
      debit: {
        account:   acct.shipping,
        amount:    record.shipping,
        tax:       purchaseTax,
        taxAmount: calcTax(record.shipping),
      },
      credit: null,
      note: 'メルカリ送料',
    });
  }

  // 行4: 広告宣伝費（借方のみ）← 他費用がある場合のみ
  if (record.otherCost > 0) {
    entries.push({
      no,
      date: record.date,
      debit: {
        account:   acct.otherCost,
        amount:    record.otherCost,
        tax:       purchaseTax,
        taxAmount: calcTax(record.otherCost),
      },
      credit: null,
      note: 'メルカリ他費用',
    });
  }

  return entries;
}

/**
 * SaleRecord[] → JournalEntry[][] に変換
 * @param {SaleRecord[]} records
 * @param {Object} accounts
 * @param {'freee'|'moneyforward'} saasType
 * @returns {JournalEntry[][]}
 */
export function toJournalGroups(records, accounts, saasType) {
  return records.map((record, i) =>
    recordToEntries(record, accounts, i + 1, saasType)
  );
}
