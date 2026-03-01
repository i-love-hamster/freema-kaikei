/**
 * メルカリ販売履歴ページのHTMLをパースして SaleRecord[] を返す
 *
 * 列インデックス（0始まり）:
 *   0: 商品タイトル
 *   1: 商品価格
 *   2: 販売手数料（税込）
 *   3: 送料（税込）
 *   4: 他費用（税込）
 *   5: 税率
 *   6: 販売利益
 *   7: 寄付（スキップ）
 *   8: 購入完了日
 *
 * @param {string} html
 * @returns {import('./journal.js').SaleRecord[] | null}
 *   null = テーブルが見つからない（未ログイン or HTML構造変更）
 */
export function parseMercariPage(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('table tbody tr');

  if (rows.length === 0) return null;

  const records = [];

  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 9) continue;

    // 商品タイトル: data-testid 属性は比較的安定
    const titleEl = cells[0].querySelector('a[data-testid="sold-item-link"] span');
    const title = titleEl ? titleEl.textContent.trim() : '(タイトル不明)';

    // 金額セルをパース: "¥1,350" → 1350、"---" → 0
    const parseAmount = (cell) => {
      const text = cell.textContent.replace(/\s/g, '');
      if (text === '---' || text === '') return 0;
      return parseInt(text.replace(/[¥,]/g, ''), 10) || 0;
    };

    // 税率: "10%" → 0.10
    const taxRateText = cells[5].textContent.trim();
    const taxRateNum = parseFloat(taxRateText);
    const taxRate = isNaN(taxRateNum) ? 0.10 : taxRateNum / 100;

    const price      = parseAmount(cells[1]);
    const commission = parseAmount(cells[2]);
    const shipping   = parseAmount(cells[3]);
    const otherCost  = parseAmount(cells[4]);
    const profit     = parseAmount(cells[6]);
    const date       = cells[8].textContent.trim(); // YYYY/MM/DD

    records.push({
      platform: 'mercari',
      date,
      title,
      price,
      commission,
      shipping,
      otherCost,
      taxRate,
      profit,
    });
  }

  return records;
}
