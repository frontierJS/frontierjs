// The tab a dock, options page or pier was opened over — the `tab` every page
// mounts with, whether its entry is generated or written with defineDock.
// Null outside an extension page, where there is no chrome.tabs.

export async function getActiveTab() {
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] ?? null))
    })
  }
  return null
}
