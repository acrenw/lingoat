// lingoat popup script
// handles the settings form and the capture button

let capturing = false;

// shorthand for sending messages to the background script
function msg(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.success) resolve(res.data);
      else reject(new Error(res?.error || "Unknown"));
    });
  });
}

// ask the active content tab whether the video has subtitle tracks available
async function checkTabSubtitles(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: "CHECK_SUBTITLE_AVAILABILITY" }, res => {
      // if content script isn't running or responds with an error, treat as unknown
      if (chrome.runtime.lastError) return resolve(undefined);
      resolve(res?.hasSubtitles);
    });
  });
}

// update button text / class to reflect capturing vs idle
async function updateCaptureBtn(isCapturing) {
  capturing = isCapturing;
  const btn = document.getElementById("captureBtn");
  if (!btn) return;
  btn.textContent = isCapturing ? "⏹ Stop Capture" : "🎙 Start Capture";
  btn.style.background = "";
  btn.style.borderStyle = "";
  btn.style.color = "";
  btn.style.borderColor = "";
  btn.disabled = false;
  btn.classList.toggle("capturing", isCapturing);
  btn.classList.remove("subtitles-active");
}

// three-state mode UI:
//   ignoreCC=true              → always audio: show Start Capture + audio note
//   ignoreCC=false, hasCC=true → CC mode: hide Start Capture, show CC note
//   ignoreCC=false, hasCC=false→ no CC found, fallback audio: show Start Capture + audio note
//   ignoreCC=false, hasCC=undefined → still checking: optimistically show CC note (no button)
function applyModeUI(ignoreCC, hasCC) {
  const useAudio = ignoreCC || hasCC === false;
  document.getElementById("captureBtn").style.display    = useAudio ? "" : "none";
  document.getElementById("ccModeNote").style.display    = (!ignoreCC && hasCC !== false) ? "block" : "none";
  document.getElementById("audioModeNote").style.display = useAudio ? "block" : "none";
}

function applyDarkMode(isDark) {
  document.body.classList.toggle("dark", isDark);
}

// load settings into the form and determine the correct button/mode state
async function load() {
  const settings = await msg("GET_SETTINGS");
  document.getElementById("sourceLang").value = settings.sourceLang || "japanese";
  document.getElementById("nativeLang1").value = settings.nativeLangs?.[0] || "english";
  document.getElementById("nativeLang2").value = settings.nativeLangs?.[1] || "";
  const subtitleSize = document.getElementById("subtitleSize");
  subtitleSize.value = settings.subtitleSize || 18;
  document.getElementById("subtitleSizeVal").textContent = subtitleSize.value + "px";
  const subtitleOpacity = document.getElementById("subtitleOpacity");
  subtitleOpacity.value = Math.round((settings.subtitleOpacity || 0.85) * 100);
  document.getElementById("subtitleOpacityVal").textContent = subtitleOpacity.value + "%";
  document.getElementById("translationOnTop").checked = !!settings.translationOnTop;
  document.getElementById("autoStart").checked = settings.autoStart !== false;
  document.getElementById("ignorePageCC").checked = !!settings.ignorePageCC;
  if (settings.groqApiKey) document.getElementById("groqApiKey").value = settings.groqApiKey;
  const darkMode = document.getElementById("darkMode");
  darkMode.checked = !!settings.darkMode;
  applyDarkMode(!!settings.darkMode);

  const ignoreCC = !!settings.ignorePageCC;

  // show initial state before subtitle check resolves
  applyModeUI(ignoreCC, undefined);

  // get active tab and capture state in parallel
  const [[tab], captureState] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    msg("GET_CAPTURE_STATE").catch(() => null),
  ]);

  // set the capture button text (capturing / idle)
  if (captureState) {
    const { capturing: isCapturing, captureTabId } = captureState;
    updateCaptureBtn(isCapturing);
    if (isCapturing && captureTabId && tab?.id && tab.id !== captureTabId) {
      const status = document.getElementById("saveStatus");
      if (status) {
        status.textContent = "⚠ Capturing another tab, stop first or it will auto-switch";
        status.style.color = "#f59e0b";
      }
    }
  }

  // determine actual subtitle availability and update mode UI
  if (tab?.id) {
    const hasCC = ignoreCC ? undefined : await checkTabSubtitles(tab.id);
    applyModeUI(ignoreCC, hasCC);
  }
}

// live update the font size label as you drag the slider
document.getElementById("subtitleSize").addEventListener("input", e => {
  document.getElementById("subtitleSizeVal").textContent = e.target.value + "px";
});

// live update the opacity label as you drag the slider
document.getElementById("subtitleOpacity").addEventListener("input", e => {
  document.getElementById("subtitleOpacityVal").textContent = e.target.value + "%";
});

// toggle dark mode on the popup itself
document.getElementById("darkMode").addEventListener("change", e => {
  applyDarkMode(e.target.checked);
});

// switch between CC / audio UI when the toggle changes — re-check subtitle availability
document.getElementById("ignorePageCC").addEventListener("change", async e => {
  const ignoreCC = e.target.checked;
  applyModeUI(ignoreCC, undefined); // show initial state immediately
  if (!ignoreCC) {
    // auto mode: check if current tab has subtitles
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const hasCC = await checkTabSubtitles(tab.id);
      applyModeUI(ignoreCC, hasCC);
    }
  }
});

// capture button click handler
document.getElementById("captureBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (!capturing) {
    const key = document.getElementById("groqApiKey").value.trim();
    if (!key) {
      alert("Please enter your Groq API key first.\n\nGet a free key at console.groq.com → API Keys.");
      return;
    }
    // save the key so background can use it
    const currentSettings = await msg("GET_SETTINGS");
    await msg("SAVE_SETTINGS", { settings: { ...currentSettings, groqApiKey: key } });

    const res = await chrome.runtime.sendMessage({ type: "START_TAB_CAPTURE", tabId: tab.id }).catch(() => null);
    if (res?.success) {
      updateCaptureBtn(true);
    } else {
      alert("Capture failed: " + (res?.error || "unknown error"));
    }
  } else {
    await chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => null);
    updateCaptureBtn(false);
  }
});

// open the welcome page in a new tab
document.getElementById("welcomeLink").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/welcome.html") });
});

// show/hide the subtitle bar on the current page
document.getElementById("showBarBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SUBTITLE_BAR" }).catch(() => {});
  window.close();
});

// save all settings
document.getElementById("saveBtn").addEventListener("click", async () => {
  const settings = {
    sourceLang: document.getElementById("sourceLang").value,
    nativeLangs: [document.getElementById("nativeLang1").value, document.getElementById("nativeLang2").value],
    subtitleSize: parseInt(document.getElementById("subtitleSize").value),
    subtitleOpacity: parseInt(document.getElementById("subtitleOpacity").value) / 100,
    translationOnTop: document.getElementById("translationOnTop").checked,
    autoStart: document.getElementById("autoStart").checked,
    ignorePageCC: document.getElementById("ignorePageCC").checked,
    groqApiKey: document.getElementById("groqApiKey").value.trim(),
    darkMode: document.getElementById("darkMode").checked,
  };
  await msg("SAVE_SETTINGS", { settings });
  // tell the content script to refresh with new settings
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" }).catch(() => {});
  const status = document.getElementById("saveStatus");
  status.textContent = "✓ Saved!";
  setTimeout(() => status.textContent = "", 2000);
});

// kickstart
load();
