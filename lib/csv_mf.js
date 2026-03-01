/**
 * マネーフォワードクラウド 仕訳CSV生成
 *
 * フォーマット: 27列
 * 文字コード: UTF-8（BOMなし）
 * 同一取引Noの複数行 → MFクラウドが複合仕訳として扱う
 * 貸方が null の行: 貸方金額・税額は 0、他は空
 */

/** CSV フィールドのエスケープ */
function esc(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const HEADER = [
  '取引No', '取引日',
  '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額',
  '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額',
  '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者',
].join(',');

/**
 * @param {import('./journal.js').JournalEntry} entry
 * @returns {string}
 */
function entryToRow(entry) {
  const { no, date, debit: dr, credit: cr, note } = entry;

  return [
    esc(no),               // 取引No
    esc(date),             // 取引日
    esc(dr.account),       // 借方勘定科目
    '',                    // 借方補助科目
    '',                    // 借方部門
    '',                    // 借方取引先
    esc(dr.tax),           // 借方税区分
    '',                    // 借方インボイス
    esc(dr.amount),        // 借方金額(円)
    esc(dr.taxAmount),     // 借方税額
    cr ? esc(cr.account) : '',    // 貸方勘定科目
    '',                           // 貸方補助科目
    '',                           // 貸方部門
    '',                           // 貸方取引先
    cr ? esc(cr.tax) : '',        // 貸方税区分
    '',                           // 貸方インボイス
    cr ? esc(cr.amount) : '0',    // 貸方金額(円) — null のとき 0
    cr ? esc(cr.taxAmount) : '0', // 貸方税額    — null のとき 0
    esc(note),             // 摘要
    '',                    // 仕訳メモ
    '',                    // タグ
    '',                    // MF仕訳タイプ
    '',                    // 決算整理仕訳
    '',                    // 作成日時
    '',                    // 作成者
    '',                    // 最終更新日時
    '',                    // 最終更新者
  ].join(',');
}

/**
 * @param {import('./journal.js').JournalEntry[][]} journalGroups
 * @returns {string}
 */
export function generateMfCsv(journalGroups) {
  const rows = [HEADER];
  for (const entries of journalGroups) {
    for (const entry of entries) {
      rows.push(entryToRow(entry));
    }
  }
  return rows.join('\r\n');
}
