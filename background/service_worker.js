/**
 * Service Worker — メルカリ販売履歴の全ページ取得
 *
 * 案B: chrome.tabs.create で背景タブを開き、JS描画後のDOMをscripting APIで取得
 * メルカリはNext.js SPAのため、fetch()では描画前のHTMLシェルしか取れない。
 */

const PAGE_SIZE    = 20;
const FETCH_DELAY  = 800;  // ms（レート制限対策）
const RENDER_WAIT  = 8000; // ms（JS描画を待つ最大時間）
const POLL_INTERVAL = 300; // ms（DOM出現確認の間隔）

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'FETCH_MERCARI_SALES') {
    fetchAllPages(msg.year, sendResponse);
    return true; // 非同期レスポンスを使用
  }
});

async function fetchAllPages(year, sendResponse) {
  const htmlPages = [];
  let page = 1;

  console.log(`[SW] fetchAllPages start: year=${year}`);

  try {
    while (true) {
      const url = `https://jp.mercari.com/mypage/listings/sold?year=${year}&page=${page}`;
      console.log(`[SW] opening tab: page=${page} url=${url}`);

      let html;
      try {
        html = await fetchViaTab(url);
      } catch (e) {
        console.error(`[SW] fetchViaTab error on page ${page}:`, e.message);
        sendResponse({ error: 'FETCH_FAILED', message: e.message });
        return;
      }

      if (html === null) {
        // タイムアウト or ログインページ（テーブルが現れなかった）
        if (page === 1) {
          sendResponse({ error: 'NOT_LOGGED_IN' });
        } else {
          // 途中ページでテーブルが消えたら終端とみなす
          break;
        }
        return;
      }

      const rowCount = (html.match(/data-testid="sold-item-link"/g) || []).length;
      console.log(`[SW] page=${page} rowCount=${rowCount} htmlLength=${html.length}`);

      htmlPages.push(html);

      // 進捗をポップアップへ通知（ポップアップが閉じていてもエラーにしない）
      chrome.runtime.sendMessage({
        action: 'FETCH_PROGRESS',
        page,
        pageCount: htmlPages.length,
      }).catch(() => {});

      if (rowCount < PAGE_SIZE) break; // 最終ページ

      page++;
      await sleep(FETCH_DELAY);
    }

    console.log(`[SW] done: totalPages=${htmlPages.length}`);
    sendResponse({ htmlPages });
  } catch (err) {
    console.error('[SW] unexpected error:', err);
    sendResponse({ error: 'UNEXPECTED', message: err.message });
  }
}

/**
 * 背景タブを開き、JS描画後のHTML文字列を返す。
 * テーブルが RENDER_WAIT ms 以内に現れなければ null を返す。
 */
async function fetchViaTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

  try {
    // タブのロード完了を待つ
    await waitForTabComplete(tabId);
    console.log(`[SW] tab loaded: tabId=${tabId}`);

    // JS描画完了（table tbody の出現）を待ってからHTML取得
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (renderWait, pollInterval) => {
        return new Promise((resolve) => {
          let elapsed = 0;
          const check = () => {
            const tbody = document.querySelector('table tbody');
            if (tbody !== null) {
              resolve(document.documentElement.outerHTML);
            } else if (elapsed >= renderWait) {
              // タイムアウト: ログインページ or 販売履歴なし
              resolve(null);
            } else {
              elapsed += pollInterval;
              setTimeout(check, pollInterval);
            }
          };
          check();
        });
      },
      args: [RENDER_WAIT, POLL_INTERVAL],
    });

    return results?.[0]?.result ?? null;
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * タブが status='complete' になるまで待つ
 */
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('タブのロードがタイムアウトしました'));
    }, 30000);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    // すでに complete の場合（create直後に完了している場合）
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
