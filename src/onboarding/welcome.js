// apply dark mode when the page loads
chrome.storage.local.get("settings", ({ settings }) => {
  if (settings?.darkMode) document.body.classList.add("dark");
});

// listen for dark mode changes in real time (if user toggles it in the popup while this page is open)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const isDark = !!changes.settings.newValue?.darkMode;
    document.body.classList.toggle("dark", isDark); 
  }
});

document.querySelectorAll('.deco').forEach(img => {
  const filename = img.src.split('/').pop();
  const resolvedURL = chrome.runtime.getURL(`icons/${filename}`);
  console.log(`[LinGOAT] deco src: ${img.src} -> resolved: ${resolvedURL}`);
  img.src = resolvedURL;
});