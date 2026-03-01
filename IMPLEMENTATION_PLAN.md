# 実装プラン

## 前提・技術選定

- **Chrome Extension Manifest V3**
- **純粋な JavaScript（フレームワークなし）**（依存なし、拡張機能として配布しやすい）
- **ページネーション取得方式: 案A（Fetch API）**
  - service workerが `fetch()` でメルカリページを直接取得
  - `host_permissions` に `https://jp.mercari.com/*` を追加することでCORSを回避
  - `credentials: 'include'` でブラウザのCookieを自動送信（ログイン状態を利用）
  - **案Aが失敗した場合の代替: 案B**
    - `chrome.tabs.create({ url, active: false })` で非表示タブを開き content script で読み取る
    - 確実にCookie・ログイン状態が使えるが、タブが一瞬表示される可能性がある
    - 案A失敗の判定条件: fetchレスポンスのHTMLにtable/tbodyが存在しない、またはリダイレクトされた場合

---

## ファイル構成

```
freemarket-csv-extension/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
├── background/
│   └── service_worker.js
└── lib/
    ├── mercari_parser.js   // HTML文字列 → SaleRecord[]
    ├── journal.js          // SaleRecord[] → JournalEntry[][]
    ├── csv_freee.js        // JournalEntry[][] → freee CSV文字列
    └── csv_mf.js           // JournalEntry[][] → MFクラウド CSV文字列
```

---

## 実装ステップ（実施順）

### Step 1: プロジェクト雛形・manifest.json

**manifest.json の要点:**
```json
{
  "manifest_version": 3,
  "name": "フリマ会計CSV",
  "version": "1.0.0",
  "permissions": ["storage", "downloads"],
  "host_permissions": ["https://jp.mercari.com/*"],
  "background": {
    "service_worker": "background/service_worker.js",
    "type": "module"
  },
  "action": { "default_popup": "popup/popup.html" },
  "options_page": "options/options.html"
}
```

- `host_permissions` に `https://jp.mercari.com/*` を追加することで、service workerからのfetchがCORSエラーにならない
- `permissions: ["storage"]` で `chrome.storage.sync` が使える
- `permissions: ["downloads"]` で `chrome.downloads.download()` によるCSVファイル保存が使える

---

### Step 2: lib/mercari_parser.js

**HTMLパース戦略:**

メルカリのCSSクラス名はビルドごとにハッシュ化されて変わるため、**クラス名に依存しない**方法で抽出する。

- テーブルの `<tbody> > <tr>` から行を取得
- 各行の `<td>` を列インデックスで参照（0始まり）
- 商品タイトルのみ `a[data-testid="sold-item-link"] span` を使用（`data-testid` は安定）

**列インデックスと対応:**
| インデックス | データ | パース方法 |
|---|---|---|
| 0 | 商品タイトル | `a[data-testid="sold-item-link"] span` の textContent |
| 1 | 商品価格 | textContent から `¥` `.` `,` を除去して parseInt |
| 2 | 販売手数料 | 同上。`---` なら 0 |
| 3 | 送料 | 同上。`---` なら 0 |
| 4 | 他費用 | 同上。`---` なら 0 |
| 5 | 税率 | `"10%"` → `parseFloat / 100` = `0.10` |
| 6 | 販売利益 | 同上（金額パース） |
| 7 | 寄付 | スキップ |
| 8 | 購入完了日 | textContent そのまま `"YYYY/MM/DD"` |

**出力型 `SaleRecord`:**
```javascript
{
  platform: 'mercari',  // 将来の拡張用
  date: 'YYYY/MM/DD',
  title: '商品名',
  price: 1350,          // 商品価格（税込）
  commission: 135,      // 販売手数料（税込）
  shipping: 210,        // 送料（税込）
  otherCost: 0,         // 他費用（税込）。0 = 計上しない
  taxRate: 0.10,
  profit: 1005,         // 販売利益（= 売掛金借方金額）
}
```

---

### Step 3: background/service_worker.js

**Fetch APIによるページネーション自動読み込み:**

```javascript
// メッセージリスナー
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'FETCH_MERCARI_SALES') {
    fetchAllPages(msg.year).then(sendResponse);
    return true; // 非同期レスポンスを使うため必須
  }
});

async function fetchAllPages(year) {
  const allRecords = [];
  let page = 1;

  while (true) {
    const url = `https://jp.mercari.com/mypage/listings/sold?year=${year}&page=${page}`;
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();

    // HTMLをパース（DOMParserはservice workerでも使用可能）
    const records = parseMercariPage(html); // lib/mercari_parser.js の処理

    // 案A失敗の検知: ログインページにリダイレクトされた or テーブルが空
    if (records === null) {
      return { error: 'NOT_LOGGED_IN' };
    }

    allRecords.push(...records);

    // 20件未満 = 最終ページ
    if (records.length < 20) break;
    page++;

    // レート制限対策: 500ms待機
    await new Promise(r => setTimeout(r, 500));
  }

  return { records: allRecords };
}
```

**service workerでのHTMLパース:**
- MV3のservice workerでは `DOMParser` が利用可能（Chromeの拡張機能context）
- `const doc = new DOMParser().parseFromString(html, 'text/html');` で通常どおり使える

**ログイン検知の方法:**
- パースした `records` が空配列 AND ページ1 → ログインページへのリダイレクトと判断
- `res.url` が `jp.mercari.com/login` 等に変わっていればリダイレクト検知

---

### Step 4: lib/journal.js

**SaleRecord + 設定 → 仕訳行の配列（複合仕訳）:**

```javascript
// 1件の取引を複数行の仕訳に変換
function toJournalEntries(record, accounts, sequenceNo) {
  const taxAmount = (amount) => Math.floor(amount / 11);
  const taxLabel = (rate) => `課税売上 ${Math.round(rate * 100)}%`; // "課税売上 10%"

  const entries = [];

  // 行1: 売掛金 / 売上高
  entries.push({
    no: sequenceNo,
    date: record.date,
    debit:  { account: accounts.receivable, amount: record.profit,     tax: '対象外',           taxAmount: 0 },
    credit: { account: accounts.sales,      amount: record.price,      tax: taxLabel(record.taxRate), taxAmount: taxAmount(record.price) },
    note: `${record.title}（メルカリ）`,
  });

  // 行2: 支払手数料 / (空)
  if (record.commission > 0) {
    entries.push({
      no: sequenceNo,
      date: record.date,
      debit:  { account: accounts.commission, amount: record.commission, tax: '課税仕入 10%', taxAmount: taxAmount(record.commission) },
      credit: null,
      note: 'メルカリ販売手数料',
    });
  }

  // 行3: 荷造運賃 / (空)
  if (record.shipping > 0) {
    entries.push({
      no: sequenceNo,
      date: record.date,
      debit:  { account: accounts.shipping, amount: record.shipping, tax: '課税仕入 10%', taxAmount: taxAmount(record.shipping) },
      credit: null,
      note: 'メルカリ送料',
    });
  }

  // 行4: 広告宣伝費 / (空)  ← 他費用がある場合のみ
  if (record.otherCost > 0) {
    entries.push({
      no: sequenceNo,
      date: record.date,
      debit:  { account: accounts.otherCost, amount: record.otherCost, tax: '課税仕入 10%', taxAmount: taxAmount(record.otherCost) },
      credit: null,
      note: 'メルカリ他費用',
    });
  }

  return entries;
}
```

---

### Step 5: lib/csv_freee.js

**freee仕訳インポートCSV生成:**

- 1行目: `[表題行],...` ヘッダー
- 2行目以降: `[明細行],...`
- 同一伝票番号の行が複合仕訳として扱われる
- 貸方が空の行は貸方側フィールドを全空白
- 文字コード: UTF-8（BOMなし）

**税区分の変換（journal.js → freee形式）:**
| journal.js | freee CSV |
|---|---|
| `課税売上 10%` | `課税売上10%` |
| `課税仕入 10%` | `課対仕入10%` |
| `対象外` | `対象外` |

---

### Step 6: lib/csv_mf.js

**マネーフォワードクラウド仕訳CSV生成:**

- ヘッダー: `取引No,取引日,...`
- 同一取引Noの行が複合仕訳として扱われる
- 貸方が空の行は貸方金額を `0`、その他を空
- 文字コード: UTF-8（BOMなし）

**税区分の変換（journal.js → MFクラウド形式）:**
| journal.js | MFクラウド CSV |
|---|---|
| `課税売上 10%` | `課税売上 10%` |
| `課税仕入 10%` | `課税仕入 10%` |
| `対象外` | `対象外` |

---

### Step 7: options/ (設定画面)

**UI要素:**
- 会計SaaS選択: `<select>` で freee / マネーフォワードクラウド
- 勘定科目設定: 5項目の `<input type="text">`
  - 売上勘定科目（貸方）: デフォルト `売上高`
  - 未収金勘定科目（借方）: デフォルト `売掛金`
  - 手数料勘定科目（借方）: デフォルト `支払手数料`
  - 送料勘定科目（借方）: デフォルト `荷造運賃`
  - 他費用勘定科目（借方）: デフォルト `広告宣伝費`
- 保存ボタン → `chrome.storage.sync.set()`
- 読み込み: ページ開時に `chrome.storage.sync.get()` でフィールドを初期化

**保存するデータ構造 (`chrome.storage.sync`):**
```json
{
  "saasType": "freee",
  "accounts": {
    "sales":      "売上高",
    "receivable": "売掛金",
    "commission": "支払手数料",
    "shipping":   "荷造運賃",
    "otherCost":  "広告宣伝費"
  }
}
```

---

### Step 8: popup/ (メインUI)

**UIフロー:**

```
[年選択 (必須)] [読み込むボタン]
     ↓ クリック
[読み込み中... ページN/N]
     ↓ 完了
[月フィルター: 全 | 1月 2月 ... 12月]
     ↓ 月を選択
[取引一覧テーブル（チェックボックス付き）]
  ✓ 2026/02/28  パーフェクトワン...   ¥1,350
  ✓ 2026/02/27  パーフェクトワン...   ¥1,400
  ...
[N件選択中]  [CSVエクスポートボタン]
```

**popup.js の主要ロジック:**

1. **初期化**: `chrome.storage.sync.get()` → saasType を読んでセレクトを復元
2. **読み込み**: service workerに `FETCH_MERCARI_SALES` メッセージを送信
3. **エラーハンドリング**:
   - `NOT_LOGGED_IN`: 「メルカリにログインしてください」を表示
   - 空データ: 「該当年の販売履歴がありません」を表示
4. **月フィルター**: ボタンクリックで月一致行をチェック
5. **チェック管理**: 全選択 / 全解除ボタンも提供
6. **エクスポート**: チェック済み取引 → journal.js → csv_freee.js or csv_mf.js → `chrome.downloads.download()`

**ファイル名の決定:**
- 選択月が1種類: `mercari_freee_202602.csv`
- 選択月が複数/全部: `mercari_freee_2026.csv`

---

## 実装の注意点

### メルカリHTMLのパース時の注意

1. **商品タイトルの取得**: `a[data-testid="sold-item-link"] span` を使う。`alt` テキスト（サムネイル説明）と混在しているため、`td.textContent` をそのまま使ってはいけない。

2. **金額パース**: `¥` + 数字が別々の `<span>` に分かれているが、`td.textContent` を取得して `¥` を除去するだけでOK（スペースや改行はtrimする）。

3. **`---` の処理**: 他費用・寄付が `---` の場合は `0` として扱う。

4. **仕訳バランス確認**:
   - `profit = price - commission - shipping - otherCost` がメルカリHTMLのデータから検証できる
   - パース後にこの等式を検証してデータ異常を検知する

### CSVの文字コード

- freee / MFクラウドともにUTF-8（BOMなし）で問題なし
- `chrome.downloads.download()` はUTF-8 Blobをそのまま渡せる

### service workerのライフサイクル

- MV3のservice workerは非活動時にアンロードされる
- 全ページのfetch中はメッセージ応答で生存が保たれるが、念のため `chrome.runtime.connect()` を使ったlong-lived connectionも検討
- ただし、通常の販売履歴取得（1年分 = 数十ページ程度）は十分に短時間で完了するため、まずはシンプルな `sendMessage/sendResponse` で実装

---

## 実装順序サマリー

| # | ファイル | 内容 | 依存 |
|---|---|---|---|
| 1 | `manifest.json` | 拡張機能の基本設定 | なし |
| 2 | `lib/mercari_parser.js` | HTML → SaleRecord[] | なし |
| 3 | `background/service_worker.js` | fetch + pagination | mercari_parser.js |
| 4 | `lib/journal.js` | SaleRecord[] → JournalEntry[][] | なし |
| 5 | `lib/csv_freee.js` | JournalEntry[][] → CSV文字列 | journal.js |
| 6 | `lib/csv_mf.js` | JournalEntry[][] → CSV文字列 | journal.js |
| 7 | `options/` | 設定UI | storage API |
| 8 | `popup/` | メインUI（全体を繋げる） | 上記すべて |

---

## リスクと対処

| リスク | 対処 |
|---|---|
| Fetch APIでCORSエラー | 案Bに切り替え（`chrome.tabs`でタブを開いてcontent scriptで読む） |
| メルカリのHTML構造変更 | `data-testid="sold-item-link"` と列インデックスベースのため比較的安定。変更時はparser.jsのみ修正 |
| service workerがタイムアウト | 取得件数が多い場合は分割fetchやlong-lived connectionを検討 |
| ログイン切れ | fetchレスポンスを検査してユーザーに通知 |
