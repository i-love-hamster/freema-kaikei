/**
 * freee 取引インポートCSV生成
 *
 * フォーマット: サンプルCSV（UTF-8 BOM付き）準拠・21列
 * 文字コード: UTF-8 BOM付き（freeeのサンプルに合わせる）
 */

/** CSV フィールドのエスケープ */
function esc(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ヘッダー行: サンプルCSVの第1行目をそのまま使用（変更禁止）
const HEADER = '収支区分,管理番号,発生日,決済期日,取引先コード,取引先,勘定科目,税区分,金額,税計算区分,税額,備考,品目,部門,メモタグ（複数指定可、カンマ区切り）,セグメント1,セグメント2,セグメント3,決済日,決済口座,決済金額';

/** 税込金額から消費税額を逆算（切り捨て） */
function calcTax(amount) {
  return Math.floor(amount / 11);
}

/**
 * 1行分のCSV行を生成（21列）
 * @param {'収入'|'支出'} type
 * @param {string} date        - YYYY/MM/DD
 * @param {string} account     - 勘定科目
 * @param {string} taxCode     - 税区分
 * @param {number} amount      - 金額（税込）
 * @param {number} taxAmount   - 税額
 * @param {string} note        - 備考
 */
function makeRow(type, date, account, taxCode, amount, taxAmount, note) {
  return [
    type,      // 収支区分
    '',        // 管理番号
    date,      // 発生日
    '',        // 決済期日
    '',        // 取引先コード
    '',        // 取引先
    account,   // 勘定科目
    taxCode,   // 税区分
    amount,    // 金額
    '内税',    // 税計算区分（メルカリの金額は全て税込）
    taxAmount, // 税額
    note,      // 備考
    '',        // 品目
    '',        // 部門
    '',        // メモタグ（複数指定可、カンマ区切り）
    '',        // セグメント1
    '',        // セグメント2
    '',        // セグメント3
    '',        // 決済日
    '',        // 決済口座
    '',        // 決済金額
  ].map(esc).join(',');
}

/**
 * @param {import('./journal.js').SaleRecord[]} records
 * @param {Object} accounts
 * @returns {string}
 */
export function generateFreeeCsv(records, accounts) {
  const rows = [HEADER];

  for (const r of records) {
    // 収入: 商品価格 → 売上高
    rows.push(makeRow(
      '収入', r.date,
      accounts.sales, '課税売上10%',
      r.price, calcTax(r.price),
      `${r.title}（メルカリ）`,
    ));

    // 2行目以降は収支区分を空白にすることで複合仕訳として取り込まれる
    // 費用行は金額・税額をマイナスにすることで支出扱いになる
    if (r.commission > 0) {
      rows.push(makeRow(
        '', r.date,
        accounts.commission, '課対仕入10%',
        -r.commission, -calcTax(r.commission),
        'メルカリ販売手数料',
      ));
    }

    if (r.shipping > 0) {
      rows.push(makeRow(
        '', r.date,
        accounts.shipping, '課対仕入10%',
        -r.shipping, -calcTax(r.shipping),
        'メルカリ送料',
      ));
    }

    if (r.otherCost > 0) {
      rows.push(makeRow(
        '', r.date,
        accounts.otherCost, '課対仕入10%',
        -r.otherCost, -calcTax(r.otherCost),
        'メルカリ他費用',
      ));
    }
  }

  // freeeサンプルがBOM付きのため、BOM（\uFEFF）を先頭に付与
  return '\uFEFF' + rows.join('\r\n');
}
