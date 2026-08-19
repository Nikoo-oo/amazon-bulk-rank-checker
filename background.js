// 点击工具栏图标：打开（或聚焦）批量查询页面
chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    const hit = tabs.find(t => t.url && t.url.includes("popup.html"));
    if (hit) {
      chrome.tabs.update(hit.id, { active: true });
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: true });
    }
  });
});
