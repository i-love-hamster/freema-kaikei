/**
 * Service Worker — 現在アクティブなタブからメルカリ販売履歴を取得
 *
 * ユーザーが手動でメルカリの販売履歴ページを開いた状態で呼び出す。
 * タブの新規作成は行わず、scripting API で既存タブの DOM を読む。
 */

// アイコンクリック時にサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'FETCH_ACTIVE_TAB') {
    fetchFromActiveTab(sendResponse);
    return true; // 非同期レスポンスを使用
  }
});

async function fetchFromActiveTab(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      sendResponse({ error: 'NO_ACTIVE_TAB' });
      return;
    }

    if (!tab.url?.includes('jp.mercari.com/mypage/listings/sold')) {
      sendResponse({ error: 'WRONG_PAGE' });
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });

    const html = results?.[0]?.result ?? null;
    if (html === null) {
      sendResponse({ error: 'FETCH_FAILED', message: 'HTMLの取得に失敗しました' });
      return;
    }

    sendResponse({ html });
  } catch (e) {
    sendResponse({ error: 'FETCH_FAILED', message: e.message });
  }
}
