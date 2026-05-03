// apply dark mode when the page loads
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get("settings", ({ settings }) => {
    if (settings?.darkMode) document.body.classList.add("dark");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      const isDark = !!changes.settings.newValue?.darkMode;
      document.body.classList.toggle("dark", isDark);
    }
  });
}

document.querySelectorAll('.deco').forEach(img => {
  const filename = img.src.split('/').pop();
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    img.src = chrome.runtime.getURL(`icons/${filename}`);
  } else {
    img.src = `../../icons/${filename}`;
  }
});