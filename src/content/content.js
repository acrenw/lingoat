// lingoat content script
// injects the subtitle bar, handles word clicks, drag to select, and listens for transcriptions
// does NOT do any audio capture, thats handled by offscreen doc + background worker

(function () {
  if (window.__lingoatLoaded) return;
  window.__lingoatLoaded = true;

  // all the state we track throughout the session
  let settings = null;
  let currentSegment = null;
  let activeNativeLang = 0;
  let subtitleBar = null;
  let subtitleVisible = true;
  let wordPopup = null;
  let notesPanel = null;
  let chatPanel = null;
  let vocabList = [];
  let notesList = [];
  let notesTab = "vocab";
  let vocabDetailItem = null;
  let vocabDetailLang = 0;
  let noteDetailItem  = null;
  let userClosedBar   = false;
  let chatHistory = [];
  let chatContext = null;
  let chatVoiceActive = false;
  let chatRecognition = null;
  let lastScrapedText = "";
  let wordsRendered = false;
  let popupCloseHandler = null;
  let subtitlePollTimer = null;
  let lastScrapeTime = 0;
  let prevIgnorePageCC = null; // tracks previous ignorePageCC so we can detect mode switches

  // ref to the document level mouseup handler for drag to select
  // we keep this so we can remove it before adding a new one (prevents stacking)
  let docMouseUpHandler = null;

  // debounce timer so we dont spam translate on rapid dom changes
  let scrapeDebounceTimer = null;

  // debounce timer for tryEnableSubtitles — coalesces rapid addtrack/loadedmetadata calls
  let enableSubtitleDebounceTimer = null;

  // audio capture coalescing, accumulate whisper chunks and translate on speech pause
  let captureBuffer = "";
  let captureCoalesceTimer = null;

  async function init() {
    // load the handwriting font for the notebook aesthetic
    if (!document.querySelector('link[href*="Patrick+Hand"]')) {
      const fontLink = document.createElement("link");
      fontLink.rel = "stylesheet";
      fontLink.href = "https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap";
      document.head.appendChild(fontLink);
    }

    try {
      settings = await msg("GET_SETTINGS");
      vocabList = await msg("GET_VOCAB");
      notesList = await msg("GET_NOTES");
    } catch (e) {
      settings = { sourceLang: "japanese", nativeLangs: ["english", ""], subtitleSize: 18 };
    }
    prevIgnorePageCC = !!settings?.ignorePageCC;
    injectSubtitleBar();
    injectNotesPanel();
    injectChatPanel();
    applyDarkMode();
    observeVideos();
    observePageSubtitles();
  }

  // toggle dark mode on all the injected ui panels
  function applyDarkMode() {
    const isDark = !!settings?.darkMode;
    [subtitleBar, wordPopup, notesPanel, chatPanel].forEach(el => {
      if (el) el.classList.toggle("lg-dark", isDark);
    });
  }

  // shorthand for sending messages to the background script (same as popup.js)
  function msg(type, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...data }, res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.success) resolve(res.data);
        else reject(new Error(res?.error || "Unknown"));
      });
    });
  }

  // apply settings changes to the live subtitle bar without reinitializing
  function applySettingsToBar() {
    if (!subtitleBar) return;
    subtitleBar.style.setProperty("--lg-font-size", (settings?.subtitleSize || 18) + "px");
    subtitleBar.style.setProperty("--lg-bg-opacity", settings?.subtitleOpacity ?? 0.85);

    // rebuild language toggle pills so second language change takes effect immediately
    const barLeft = subtitleBar.querySelector(".lg-bar-left");
    if (barLeft) {
      const [l1, l2] = settings?.nativeLangs || ["english", ""];
      const pill0 = subtitleBar.querySelector("#lg-lang-0");
      const pill1 = subtitleBar.querySelector("#lg-lang-1");
      if (pill0) pill0.textContent = capitalize(l1);
      if (l2) {
        if (pill1) {
          pill1.textContent = capitalize(l2);
        } else {
          const btn = document.createElement("button");
          btn.className = "lg-pill";
          btn.id = "lg-lang-1";
          btn.textContent = capitalize(l2);
          btn.addEventListener("click", () => setActiveLang(1));
          barLeft.appendChild(btn);
        }
      } else {
        if (pill1) pill1.remove();
        if (activeNativeLang === 1) activeNativeLang = 0;
      }
    }

    // re-render current subtitles to pick up translationOnTop and language changes
    if (currentSegment) renderSubtitles(currentSegment);
    // update idle status message if mode changed and no subtitles are showing
    const origEl = document.getElementById("lg-original");
    if (!origEl?.textContent.trim()) setSubtitleStatus(idleStatus());

    const nowIgnoreCC = !!settings?.ignorePageCC;
    if (!nowIgnoreCC) {
      // in CC mode: ensure subtitles are enabled for scraping
      if (prevIgnorePageCC === true) {
        // just switched from audio → CC: clear dedup so first CC line isn't skipped
        lastScrapedText = "";
      }
      tryEnableSubtitles();
    }
    prevIgnorePageCC = nowIgnoreCC;
  }

  // listen for messages coming from background and popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // popup asks: does this tab's video have subtitle tracks available?
    if (message.type === "CHECK_SUBTITLE_AVAILABILITY") {
      sendResponse({ hasSubtitles: checkSubtitleAvailability() });
      return;
    }
    if (message.type === "SETTINGS_UPDATED") {
      // reload settings and apply live without full reinit
      msg("GET_SETTINGS").then(s => {
        settings = s;
        applyDarkMode();
        applySettingsToBar();
      }).catch(() => {});
      return;
    }
    if (message.type === "TOGGLE_SUBTITLE_BAR") toggleSubtitleBar(true);

    // interim text while whisper is still processing
    if (message.type === "SR_INTERIM") {
      showInterim(message.text);
    }

    // final transcription from whisper, coalesce chunks to reduce churn
    // accumulate text and only translate after 2 seconds of no new chunks (speech pause)
    if (message.type === "SR_FINAL") {
      const newText = message.text?.trim();
      if (!newText) return;

      // if the new chunk clearly doesn't continue the buffer (different sentence start),
      // flush the old buffer immediately and start fresh
      if (captureBuffer && newText.length > 5 && captureBuffer.length > 5) {
        const bufStart = captureBuffer.slice(0, 5);
        const newStart = newText.slice(0, 5);
        if (bufStart !== newStart && !newText.startsWith(captureBuffer.slice(0, 3))) {
          // different sentence, translate what we have, then start new buffer
          const toTranslate = captureBuffer;
          captureBuffer = "";
          clearTimeout(captureCoalesceTimer);
          processTranscript(toTranslate, "tab-capture");
        }
      }

      captureBuffer = captureBuffer ? captureBuffer + " " + newText : newText;
      clearTimeout(captureCoalesceTimer);
      captureCoalesceTimer = setTimeout(() => {
        if (captureBuffer) {
          processTranscript(captureBuffer, "tab-capture");
          captureBuffer = "";
        }
      }, 2000);
    }

    if (message.type === "SR_STATUS") {
      if (message.status === "listening") setSubtitleStatus("🎙 listening...");
      else if (message.status === "transcribing") setSubtitleStatus("✍️ transcribing...");
      else if (message.status === "error") setSubtitleStatus("⚠ " + message.error);
    }

    // background killed audio capture because this page already has subtitles
    if (message.type === "CAPTURE_STOPPED_SUBTITLES_FOUND") {
      setSubtitleStatus("📺 using page subtitles");
    }
  });

  // attach play/pause/end listeners to video elements and auto-show the subtitle bar
  function observeVideos() {
    const attach = el => {
      if (el.__lgAttached) return;
      el.__lgAttached = true;

      // retry subtitle enablement when tracks become available (they often aren't loaded at document_idle)
      if (el.tagName === "VIDEO") {
        el.addEventListener("loadedmetadata", tryEnableSubtitles);
        if (el.textTracks) el.textTracks.addEventListener("addtrack", tryEnableSubtitles);
        tryEnableSubtitles();
      }

      // only auto-show bar for <video> elements (not background audio), respecting settings
      if (el.tagName === "VIDEO" && subtitleBar && !userClosedBar && settings?.autoStart !== false) {
        toggleSubtitleBar(true);
      }

      // update status based on current play state when attaching
      if (!el.paused && !el.ended) {
        const origEl = document.getElementById("lg-original");
        if (!origEl?.textContent.trim()) setSubtitleStatus(idleStatus());
      }

      el.addEventListener("play", () => {
        const origEl = document.getElementById("lg-original");
        if (!origEl?.textContent.trim()) setSubtitleStatus(idleStatus());
      });
      el.addEventListener("pause", () => setSubtitleStatus("⏸ paused"));
      el.addEventListener("ended", () => setSubtitleStatus(idleStatus()));
    };
    document.querySelectorAll("video, audio").forEach(attach);
    // also watch for new video elements added to the page dynamically
    new MutationObserver(() => document.querySelectorAll("video, audio").forEach(attach))
      .observe(document.body, { childList: true, subtree: true });
  }

  // shared subtitle text handler, both mutation observer and texttrack feed into this
  // handles dedup, debounce, and clearing
  let clearSubtitleTimer = null;

  function onNewSubtitleText(text) {
    // when user wants audio capture instead of CC, ignore scraped subtitles entirely
    if (settings?.ignorePageCC) return;

    // new text arrived, cancel any pending clear
    if (clearSubtitleTimer) { clearTimeout(clearSubtitleTimer); clearSubtitleTimer = null; }

    if (!text || !text.trim()) {
      // subtitle element was cleared (speaker stopped), clear display after 500ms
      // delay prevents flashing during brief youtube dom empty then refill gaps
      if (lastScrapedText) {
        clearSubtitleTimer = setTimeout(() => {
          const origEl = document.getElementById("lg-original");
          const transEl = document.getElementById("lg-trans");
          if (origEl) origEl.textContent = "";
          if (transEl) transEl.textContent = "";
          currentSegment = null;
          lastScrapedText = "";
          wordsRendered = false;
          setSubtitleStatus("📺 using page subtitles");
        }, 500);
      }
      return;
    }

    if (text === lastScrapedText) return; // exact same text, skip
    lastScrapedText = text;

    // debounce, wait 300ms for rapid mutations to settle before translating
    clearTimeout(scrapeDebounceTimer);
    scrapeDebounceTimer = setTimeout(() => processTranscript(text, "scrape"), 300);
  }

  // watch for subtitle elements on the page (youtube cc, netflix, crunchyroll, etc)
  function observePageSubtitles() {
    // these are the dom containers where various streaming sites put their subtitle text
    const containerSelectors = [
      ".ytp-caption-window-container",
      ".ytp-caption-window-bottom",
      ".captions-text",
      ".player-timedtext-text-container",
      "[data-testid='player-overlay-content-cues']",
      ".vjs-text-track-display",
    ];

    const findTargets = () =>
      containerSelectors.map(s => document.querySelector(s)).filter(Boolean);

    // fires whenever the subtitle dom changes
    const onSubtitleChange = () => {
      const text = scrapePageSubtitles();
      onNewSubtitleText(text);
    };

    // attach mutation observers to any subtitle containers we find
    const tryAttach = () => {
      for (const target of findTargets()) {
        if (target.__lgObserved) continue;
        target.__lgObserved = true;
        new MutationObserver(onSubtitleChange)
          .observe(target, { childList: true, subtree: true, characterData: true });
      }
    };

    tryAttach();
    // keep checking for new containers in case they load late
    new MutationObserver(tryAttach).observe(document.body, { childList: true, subtree: true });

    // texttracks dont fire dom mutations so we poll for those separately
    observeTextTracks();

    // try to auto enable subtitles if theyre off
    tryEnableSubtitles();
  }

  // enable subtitles for scraping — called at init and whenever settings switch to CC mode
  // uses "hidden" mode for html5 texttracks so cue events fire without showing native CC overlay
  // also auto-clicks the youtube CC button so youtube populates its own DOM caption elements
  // debounced because addtrack/loadedmetadata events can fire many times in rapid succession
  function tryEnableSubtitles() {
    clearTimeout(enableSubtitleDebounceTimer);
    enableSubtitleDebounceTimer = setTimeout(_doTryEnableSubtitles, 80);
  }

  function _doTryEnableSubtitles() {
    if (settings?.ignorePageCC) return; // user explicitly chose audio capture, leave CC alone

    // click youtube's CC button if it's currently off
    const tryYT = () => {
      const ccBtn = document.querySelector(".ytp-subtitles-button");
      if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
        ccBtn.click();
      }
    };
    tryYT();
    setTimeout(tryYT, 2000);
    setTimeout(tryYT, 5000);

    // enable html5 texttracks silently ("hidden" loads cue data + fires cuechange without native overlay)
    const video = document.querySelector("video");
    if (video) {
      const srcLangCode = getSpeechLangCode(settings?.sourceLang || "japanese").split("-")[0];
      let bestTrack = null;
      for (const track of video.textTracks) {
        if (track.kind === "subtitles" || track.kind === "captions") {
          if (track.mode === "disabled") {
            if (track.language && track.language.startsWith(srcLangCode)) {
              bestTrack = track;
              break;
            }
            if (!bestTrack) bestTrack = track;
          }
        }
      }
      if (bestTrack) {
        bestTrack.mode = "hidden"; // silent: cues load and cuechange fires, no native overlay
      }
    }
  }

  // poll for html5 texttracks since they dont trigger mutation observers
  // watches both "showing" and "hidden" tracks (hidden = loaded silently for lingoat scraping)
  function observeTextTracks() {
    const poll = () => {
      const video = document.querySelector("video");
      if (!video) return;
      for (const track of video.textTracks) {
        if ((track.mode === "showing" || track.mode === "hidden") && !track.__lgObserved) {
          track.__lgObserved = true;
          track.addEventListener("cuechange", () => {
            if (!track.activeCues?.length) {
              onNewSubtitleText(null);
              return;
            }
            const text = Array.from(track.activeCues)
              .map(c => c.text.replace(/<[^>]+>/g, "").trim())
              .filter(Boolean).join(" ");
            onNewSubtitleText(text);
          });
        }
      }
    };
    subtitlePollTimer = setInterval(poll, 2000);
    poll();
  }

  // check whether this page's video has subtitle tracks available (even if CC is off by user)
  // used by popup to decide whether to show Start Capture or CC mode note
  function checkSubtitleAvailability() {
    // check html5 texttracks — works for youtube, vimeo, etc even before user turns on CC
    const video = document.querySelector("video");
    if (video?.textTracks) {
      for (const track of video.textTracks) {
        if (track.kind === "subtitles" || track.kind === "captions") return true;
      }
    }
    // check known dom containers that streaming sites pre-inject (they exist even when CC is off)
    return [
      ".ytp-caption-window-container", ".captions-text",
      ".player-timedtext-text-container", "[data-testid='player-overlay-content-cues']",
      ".vjs-text-track-display", ".current-cue",
    ].some(s => !!document.querySelector(s));
  }

  // pull subtitle text from whatever streaming site we're on
  function scrapePageSubtitles() {
    // youtube
    const ytSegments = document.querySelectorAll(".ytp-caption-segment");
    if (ytSegments.length) {
      const text = Array.from(ytSegments).map(s => s.textContent.trim()).filter(Boolean).join(" ");
      // filter out youtube metadata junk like "[Music]" or track labels
      if (isMetadataText(text)) return null;
      return text;
    }

    // crunchyroll
    const crSub = document.querySelector(".current-cue");
    if (crSub) return crSub.textContent.trim();

    // netflix
    const nfSpans = document.querySelectorAll(".player-timedtext-text-container span");
    if (nfSpans.length) return Array.from(nfSpans).map(s => s.textContent.trim()).filter(Boolean).join(" ");

    // disney+
    const dpSub = document.querySelector("[data-testid='player-overlay-content-cues']");
    if (dpSub) return dpSub.textContent.trim();

    // generic video.js players
    const vjsSub = document.querySelector(".vjs-text-track-display");
    if (vjsSub?.textContent?.trim()) return vjsSub.textContent.trim();

    // html5 texttrack fallback
    const video = document.querySelector("video");
    if (video) {
      for (const track of video.textTracks) {
        if (track.mode === "showing" && track.activeCues?.length) {
          return Array.from(track.activeCues)
            .map(c => c.text.replace(/<[^>]+>/g, "").trim())
            .filter(Boolean).join(" ");
        }
      }
    }
    return null;
  }

  // filter out youtube metadata text that isnt actual subtitles
  // stuff like "[Music]", "[Applause]", track labels, etc
  function isMetadataText(text) {
    if (!text) return true;
    const t = text.trim().toLowerCase();
    // bracketed annotations
    if (/^\[.*\]$/.test(t)) return true;
    // common youtube auto generated labels
    const junk = [
      "music", "[music]", "[applause]", "[laughter]",
      "[音楽]", "[拍手]", "[笑]",
      "auto-generated", "auto generated",
      "subtitles by", "translated by",
    ];
    if (junk.some(j => t === j || t.startsWith(j))) return true;
    return false;
  }

  // checks if text looks like its in the wrong script for the source language
  // eg if source is japanese but whisper output english or romaji
  function looksLikeWrongScript(text, sourceLang) {
    if (!text || !sourceLang) return false;
    const lang = sourceLang.toLowerCase();
    const isCJK = ["japanese", "chinese", "korean"].includes(lang);
    if (!isCJK) return false;

    // count how many characters are cjk (chinese, japanese, korean) vs ascii
    let cjkCount = 0;
    let asciiCount = 0;
    for (const ch of text) {
      if (/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/.test(ch)) cjkCount++;
      else if (/[a-zA-Z]/.test(ch)) asciiCount++;
    }
    const total = cjkCount + asciiCount;
    if (total === 0) return false;
    // if more than 50% of meaningful characters are ascii, its probably wrong
    // (whisper sometimes outputs romaji or english for cjk languages)
    return asciiCount / total > 0.5;
  }

  // take a piece of text (from audio capture or scraped subtitles) and translate it
  async function processTranscript(text, source) {
    if (!text?.trim()) return;

    // for audio capture, check if whisper gave us the wrong language
    if (source === "tab-capture") {
      if (looksLikeWrongScript(text, settings?.sourceLang)) {
        console.log("[LinGOAT] skipping bad transcription (wrong script):", text);
        setSubtitleStatus("🎙 listening...");
        return;
      }
    }

    if (source === "scrape") {
      lastScrapeTime = Date.now();
      // tell background this tab has subtitles so it stops audio capture
      // (skipped when ignorePageCC is on so audio capture keeps running)
      if (!settings?.ignorePageCC) {
        chrome.runtime.sendMessage({ type: "SUBTITLE_SCRAPE_DETECTED" }).catch(() => {});
      }
      // DON'T show original text early, keep displaying previous subtitle until
      // translation is ready, then renderSubtitles() updates both lines atomically, this prevents the flash
    }

    setSubtitleStatus("🔄 translating...");
    if (source !== "scrape") wordsRendered = false;

    try {
      const segment = await msg("TRANSLATE_SEGMENT", {
        text: text.trim(),
        sourceLang: settings.sourceLang,
        nativeLangs: settings.nativeLangs,
      });

      // for scraped subtitles, always preserve the exact original text
      // groq sometimes rewrites or translates words in its splitting
      if (source === "scrape") {
        segment.original = text.trim();

        // check if groqs word splitting actually matches the original text
        // if it doesnt (eg groq translated the words), fall back to simple tokenization
        if (segment.words?.length) {
          const isJaCjk = ["japanese","chinese","korean"].includes(settings?.sourceLang?.toLowerCase());
          const reassembled = segment.words.map(w => w.word).join(isJaCjk ? "" : " ");
          const originalNorm = text.trim().replace(/\s+/g, "");
          const reassembledNorm = reassembled.replace(/\s+/g, "");

          if (reassembledNorm !== originalNorm && !originalNorm.includes(reassembledNorm) && !reassembledNorm.includes(originalNorm)) {
            // groq gave us bad words, tokenize from the original text instead
            const rawTokens = tokenizeForDisplay(text.trim(), settings.sourceLang);
            segment.words = rawTokens.map(w => ({ word: w, reading: null, meaning_1: "", meaning_2: null, pos: "" }));
          }

          // extra check: for cjk languages, if any individual word looks like its in the wrong script
          // replace just that word with null reading (keep the word from original)
          if (isJaCjk) {
            for (const w of segment.words) {
              if (looksLikeWrongScript(w.word, settings.sourceLang)) {
                // this word got translated, reset it
                w.word = ""; // will be filtered out
              }
            }
            segment.words = segment.words.filter(w => w.word);
            // if we filtered out too many words, redo from scratch
            if (segment.words.length === 0) {
              const rawTokens = tokenizeForDisplay(text.trim(), settings.sourceLang);
              segment.words = rawTokens.map(w => ({ word: w, reading: null, meaning_1: "", meaning_2: null, pos: "" }));
            }
          }
        }
      }

      currentSegment = segment;
      renderSubtitles(segment);
      setSubtitleStatus(source === "scrape" ? "📺 using page subtitles" : "🎙 listening...");
    } catch (e) {
      setSubtitleStatus("⚠ " + e.message);
    }
  }

  // basic tokenizer for when groq gives us bad results
  // splits cjk chars individually, keeps kana runs together, splits others by spaces
  function tokenizeForDisplay(text, lang) {
    const l = lang?.toLowerCase();
    if (l === "japanese" || l === "chinese") {
      const tokens = []; let buf = "";
      for (const ch of text) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(ch)) {
          if (buf) { tokens.push(buf); buf = ""; }
          tokens.push(ch);
        } else if (ch === " " || ch === "\u3000") {
          if (buf) { tokens.push(buf); buf = ""; }
        } else {
          buf += ch;
        }
      }
      if (buf) tokens.push(buf);
      return tokens.filter(Boolean);
    }
    if (l === "korean") return text.split(/\s+/).filter(Boolean);
    return text.match(/\S+/g) || [];
  }

  // show interim text while whisper is still processing (before translation)
  // only if no stable subtitle is currently displayed, to prevent overwriting good content
  function showInterim(text) {
    if (wordsRendered || currentSegment) return;
    const swapped = !!settings?.translationOnTop;
    const el = document.getElementById(swapped ? "lg-trans" : "lg-original");
    if (el) el.textContent = text;
  }

  // build the subtitle bar and stick it on the page
  function injectSubtitleBar() {
    if (document.getElementById("lg-subtitle-bar")) return;
    const bar = document.createElement("div");
    bar.id = "lg-subtitle-bar";
    bar.style.position = "fixed";
    bar.style.bottom = "80px";
    bar.style.left = "50%";
    bar.style.transform = "translateX(-50%)";
    bar.style.zIndex = "2147483647";
    bar.style.setProperty("--lg-font-size", (settings?.subtitleSize || 18) + "px");
    // set fixed default size, 50vw wide, fixed height so it never auto resizes
    bar.style.width = "50vw";
    bar.style.height = "140px";
    bar.style.maxWidth = "none";
    bar.style.setProperty("--lg-bg-opacity", settings?.subtitleOpacity ?? 0.85);

    const [l1, l2] = settings?.nativeLangs || ["english", ""];
    bar.innerHTML = `
      <div class="lg-bar-controls">
        <div class="lg-bar-left">
          <button class="lg-pill active" id="lg-lang-0">${capitalize(l1)}</button>
          ${l2 ? `<button class="lg-pill" id="lg-lang-1">${capitalize(l2)}</button>` : ""}
        </div>
        <div class="lg-bar-right">
          <span class="lg-status-badge" id="lg-status-badge" title="Status">▶</span>
          <button class="lg-pill lg-pill-lg" id="lg-chat-btn">💬 AI Tutor</button>
          <button class="lg-pill lg-pill-lg" id="lg-notes-btn">📓 Notes</button>
          <button class="lg-bar-icon-btn" id="lg-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="lg-subtitle-content">
        <div class="lg-status" id="lg-status">${settings?.ignorePageCC ? "⏳ click Start Capture to begin" : "▶ play a video to start"}</div>
        <div class="lg-line-original" id="lg-original"></div>
        <div class="lg-line-trans" id="lg-trans"></div>
      </div>
      <div class="lg-overflow-indicator" id="lg-overflow-indicator" title="Text is cut off — drag ⠿ to resize">↑ more</div>
      <div class="lg-resize-handle" id="lg-resize-handle" title="Drag to resize">⠿</div>
    `;

    // start hidden — shown only when a video is detected or user manually shows it
    bar.style.display = "none";
    subtitleVisible = false;

    document.body.appendChild(bar);
    subtitleBar = bar;

    makeDraggable(bar, ".lg-bar-controls");
    makeResizable(bar, "#lg-resize-handle");

    // update overflow indicator whenever the bar or its content changes size
    const resizeObs = new ResizeObserver(() => updateOverflowIndicator());
    resizeObs.observe(bar);
    const contentEl = bar.querySelector(".lg-subtitle-content");
    if (contentEl) resizeObs.observe(contentEl);

    // language toggle buttons
    bar.querySelector("#lg-lang-0")?.addEventListener("click", () => setActiveLang(0));
    bar.querySelector("#lg-lang-1")?.addEventListener("click", () => setActiveLang(1));
    bar.querySelector("#lg-chat-btn")?.addEventListener("click", toggleChatPanel);
    bar.querySelector("#lg-notes-btn")?.addEventListener("click", toggleNotesPanel);
    bar.querySelector("#lg-close-btn").addEventListener("click", () => {
      bar.style.display = "none";
      subtitleVisible = false;
      userClosedBar = true;
    });
  }

  function toggleSubtitleBar(forceShow) {
    if (!subtitleBar) { injectSubtitleBar(); return; }
    if (forceShow || !subtitleVisible) {
      subtitleBar.style.display = "";
      subtitleVisible = true;
      userClosedBar = false; // manual show resets user preference
      requestAnimationFrame(updateOverflowIndicator);
    } else {
      subtitleBar.style.display = "none";
      subtitleVisible = false;
    }
  }

  // switch which native language translation is shown
  function setActiveLang(idx) {
    activeNativeLang = idx;
    document.getElementById("lg-lang-0")?.classList.toggle("active", idx === 0);
    document.getElementById("lg-lang-1")?.classList.toggle("active", idx === 1);
    if (currentSegment) renderSubtitles(currentSegment);
  }

  // used by drag to select
  let dragSelectStart = null;

  // render the subtitle words with furigana and set up click/drag interactions
  function renderSubtitles(seg) {
    const origEl = document.getElementById("lg-original");
    const transEl = document.getElementById("lg-trans");
    if (!origEl) return;

    const isJaCjk = ["japanese","chinese","korean"].includes(settings?.sourceLang?.toLowerCase());
    const swapped = !!settings?.translationOnTop;

    // build the target language words html
    let wordsHtml = "";
    if (seg.words?.length) {
      wordsHtml = seg.words.map((w, i) => {
        const wordHtml = escHtml(w.word);
        const reading = w.reading || null;
        let inner;
        if (isJaCjk) {
          const hasReading = reading && reading !== w.word;
          inner = `<ruby>${wordHtml}<rt>${hasReading ? escHtml(reading) : ""}</rt></ruby>`;
        } else {
          inner = wordHtml;
        }
        return `<span class="lg-word" data-i="${i}">${inner}</span>`;
      }).join(isJaCjk ? "" : " ");
    }

    // translation text
    const transText = activeNativeLang === 0
      ? seg.translation_1 || ""
      : seg.translation_2 || seg.translation_1 || "";

    // apply swapped styling classes
    origEl.classList.toggle("lg-swapped-main", swapped);
    transEl?.classList.toggle("lg-swapped-sub", swapped);

    if (swapped) {
      // top (lg-original) = translation, bottom (lg-trans) = target language words // TODO: translation sometimes not really wokring
      origEl.textContent = transText;
      if (wordsHtml) {
        transEl.innerHTML = wordsHtml;
        wordsRendered = true;
        attachWordInteractions(transEl, seg);
      } else {
        transEl.textContent = seg.original || "";
        wordsRendered = false;
      }
    } else {
      // top (lg-original) = target language words, bottom (lg-trans) = translation
      if (wordsHtml) {
        origEl.innerHTML = wordsHtml;
        wordsRendered = true;
        attachWordInteractions(origEl, seg);
      } else {
        origEl.textContent = seg.original || "";
        wordsRendered = false;
      }
      if (transEl) transEl.textContent = transText;
    }

    // hide status while subtitles are visible
    const statusEl = document.getElementById("lg-status");
    const hasContent = origEl?.textContent.trim() || transEl?.textContent?.trim();
    if (statusEl && hasContent) statusEl.style.display = "none";

    requestAnimationFrame(updateOverflowIndicator);
  }

  function updateOverflowIndicator() {
    const indicator = document.getElementById("lg-overflow-indicator");
    if (!indicator) return;
    // can't measure when hidden — all dimensions are zero
    if (!subtitleBar || subtitleBar.style.display === "none") return;
    const origEl = document.getElementById("lg-original");
    if (!origEl) return;
    // flex shrinks #lg-original's clientHeight to fit the container, but
    // scrollHeight still reflects the full intrinsic text height — so
    // scrollHeight > clientHeight means text is being clipped inside the element.
    // show the indicator once more than ~20% of the text height is hidden
    const hidden = origEl.scrollHeight - origEl.clientHeight;
    const threshold = Math.max(4, origEl.scrollHeight * 0.2);
    indicator.classList.toggle("lg-overflow-visible", hidden > threshold);
  }

  // set up mousedown/mouseover/mouseup so user can click or drag to select words
  function attachWordInteractions(origEl, seg) {
    let mouseDownIndex = null;
    let lastHoverIdx = null;

    // on mousedown, record which word they started on
    origEl.addEventListener("mousedown", e => {
      const wordEl = e.target.closest(".lg-word");
      if (!wordEl) return;
      mouseDownIndex = +wordEl.dataset.i;
      lastHoverIdx = mouseDownIndex;
      dragSelectStart = mouseDownIndex;
      // clear any previous highlight
      origEl.querySelectorAll(".lg-word.lg-selected").forEach(el => el.classList.remove("lg-selected"));
    });

    // highlight words as user drags over them
    origEl.addEventListener("mouseover", e => {
      if (dragSelectStart === null) return;
      const wordEl = e.target.closest(".lg-word");
      if (!wordEl) return;
      lastHoverIdx = +wordEl.dataset.i;
      const lo = Math.min(dragSelectStart, lastHoverIdx);
      const hi = Math.max(dragSelectStart, lastHoverIdx);
      origEl.querySelectorAll(".lg-word").forEach(el => {
        const i = +el.dataset.i;
        el.classList.toggle("lg-selected", i >= lo && i <= hi);
      });
    });

    // remove old mouseup handler so they dont stack up
    if (docMouseUpHandler) document.removeEventListener("mouseup", docMouseUpHandler);

    docMouseUpHandler = e => {
      if (dragSelectStart === null) return;
      const wordEl = e.target.closest?.(".lg-word");
      const upIdx = wordEl ? +wordEl.dataset.i : lastHoverIdx;
      if (upIdx === null || upIdx === undefined) { dragSelectStart = null; return; }

      if (dragSelectStart !== upIdx) {
        // multi word drag selection
        // read directly from the dom so we always get exactly whats highlighted
        const selectedEls = [...origEl.querySelectorAll(".lg-word.lg-selected")];
        const isJaCjk = ["japanese","chinese","korean"].includes(settings?.sourceLang?.toLowerCase());

        // pull the actual text from each highlighted word element
        const selectedTexts = selectedEls.map(el => {
          const rubyEl = el.querySelector("ruby");
          if (rubyEl) {
            // for cjk with ruby, get just the base text not the reading
            const rtEl = el.querySelector("rt");
            const rtText = rtEl?.textContent || "";
            let base = rubyEl.textContent;
            if (rtText) base = base.replace(rtText, "");
            return base.trim();
          }
          return el.textContent.trim();
        }).filter(Boolean);

        // join em together as a phrase
        const phrase = selectedTexts.join(isJaCjk ? "" : " ");

        dragSelectStart = null;
        lastHoverIdx = null;

        if (phrase) {
          // look up the whole phrase, not individual words
          openWordPopup({ word: phrase, reading: null, isPhrase: true }, e);
        }
      } else {
        // single word click
        dragSelectStart = null;
        lastHoverIdx = null;
        origEl.querySelectorAll(".lg-word.lg-selected").forEach(el => el.classList.remove("lg-selected"));
        if (wordEl && seg.words[upIdx]) {
          openWordPopup(seg.words[upIdx], e);
        }
      }
    };
    document.addEventListener("mouseup", docMouseUpHandler);
  }

  // returns the appropriate idle message depending on mode
  function idleStatus() {
    return settings?.ignorePageCC ? "⏳ click Start Capture to begin" : "▶ play a video to start";
  }

  function setSubtitleStatus(t) {
    // always update the badge emoji in the controls row
    const badge = document.getElementById("lg-status-badge");
    if (badge) badge.textContent = t.split(" ")[0]; // just the emoji/icon part
    // full status text only shows in the content area when there's no subtitle yet
    const el = document.getElementById("lg-status");
    if (!el) return;
    const origEl = document.getElementById("lg-original");
    const hasSubtitles = origEl && origEl.textContent.trim().length > 0;
    if (hasSubtitles) {
      el.style.display = "none";
    } else {
      el.style.display = "";
      el.textContent = t;
    }
  }

  // open the definition popup when user clicks or drags on words
  async function openWordPopup(wordObj, event) {
    closeWordPopup();
    const popup = document.createElement("div");
    popup.id = "lg-word-popup";
    popup.innerHTML = `<div class="lg-popup-loading"><div class="lg-spinner"></div><br>Looking up "${escHtml(wordObj.word)}"…</div>`;
    if (settings?.darkMode) popup.classList.add("lg-dark");
    document.body.appendChild(popup);
    wordPopup = popup;
    positionPopup(popup, event);
    makeDraggable(popup, ".lg-popup-header");
    popup.addEventListener("click", e => e.stopPropagation());

    // close popup when clicking outside
    setTimeout(() => {
      popupCloseHandler = function(e) {
        if (wordPopup?.contains(e.target)) return;
        if (subtitleBar?.contains(e.target)) return;
        closeWordPopup();
      };
      document.addEventListener("click", popupCloseHandler);
    }, 100);

    try {
      const nativeLang = settings.nativeLangs[0] || "english";
      const nativeLang2 = settings.nativeLangs[1] || "";
      const isPhrase = !!wordObj.isPhrase || !!wordObj._selectedWords;
      const detail = await msg("LOOKUP_WORD", {
        word: wordObj.word,
        sourceLang: settings.sourceLang,
        nativeLang,
        nativeLang2,
        isPhrase,
      });
      // mark it as a phrase so the popup knows not to show breakdown stuff
      if (isPhrase) detail._isPhrase = true;
      renderWordPopup(popup, detail);
    } catch (e) {
      popup.innerHTML = `<div class="lg-popup-loading">⚠ ${escHtml(e.message)}</div>`;
    }
  }

  // build the word definition popup content
  function renderWordPopup(popup, detail) {
    const [l1, l2] = settings?.nativeLangs || ["english", ""];
    let curLang = activeNativeLang;
    const isInVocab = vocabList.some(v => v.word === detail.word);
    const getDef = () => curLang === 0 ? detail.definition_1 : (detail.definition_2 || detail.definition_1);
    const isPhrase = !!detail._isPhrase;

    const render = () => { // mv3 content scripts can't load separate html, so do js dom building
      popup.innerHTML = `
        <div class="lg-popup-header">
          <div>
            <div class="lg-popup-word">
              ${escHtml(detail.word)}
              <button class="lg-speak-btn" id="lg-speak-word" title="Hear pronunciation">🔊</button>
            </div>
            ${detail.reading && !isPhrase ? `<div class="lg-popup-reading">${escHtml(detail.reading)}</div>` : ""}
            ${detail.pos && !isPhrase ? `<span class="lg-popup-pos">${escHtml(detail.pos)}</span>` : ""}
          </div>
          <button class="lg-popup-close" id="lg-popup-close">✕</button>
        </div>
        ${l2 ? `
        <div class="lg-popup-lang-tabs">
          <button class="lg-lang-tab ${curLang===0?"active":""}" data-l="0">${capitalize(l1)}</button>
          <button class="lg-lang-tab ${curLang===1?"active":""}" data-l="1">${capitalize(l2)}</button>
        </div>` : ""}
        ${detail.jlpt_level && !isPhrase ? `<div class="lg-jlpt">${escHtml(detail.jlpt_level)}</div>` : ""}
        <div class="lg-popup-def">${formatDef(getDef())}</div>
        ${detail.examples?.length && !isPhrase ? `
        <div class="lg-examples">
          <div class="lg-examples-title">Examples</div>
          ${detail.examples.map(ex => `
            <div class="lg-example">
              <div class="lg-ex-sentence">${escHtml(ex.sentence)}</div>
              ${ex.romanization ? `<div class="lg-ex-roman">${escHtml(ex.romanization)}</div>` : ""}
              <div class="lg-ex-trans">${escHtml(ex.translation_1 || "")}</div>
            </div>`).join("")}
        </div>` : ""}
        ${detail.notes && !isPhrase ? `<div class="lg-popup-notes">${escHtml(detail.notes)}</div>` : ""}
        <div class="lg-popup-actions">
          <button class="lg-btn-save ${isInVocab?"saved":""}" id="lg-save-btn">
            ${isInVocab ? "✓ Saved" : "+ Add to Notes"}
          </button>
          <button class="lg-btn-ai" id="lg-ask-ai-btn">💬 Ask AI</button>
        </div>
      `;

      popup.querySelector("#lg-popup-close")?.addEventListener("click", closeWordPopup);
      popup.querySelector("#lg-speak-word")?.addEventListener("click", e => {
        e.stopPropagation();
        speakText(detail.word, settings.sourceLang);
      });
      popup.querySelectorAll(".lg-lang-tab").forEach(t => {
        t.addEventListener("click", () => { curLang = +t.dataset.l; render(); });
      });
      popup.querySelector("#lg-save-btn")?.addEventListener("click", async () => {
        const vmeta = getVideoMeta();
        await msg("SAVE_VOCAB", { entry: { ...detail, lang: settings.sourceLang, ...vmeta } });
        vocabList = await msg("GET_VOCAB");
        renderNotesPanel();
        const btn = popup.querySelector("#lg-save-btn");
        if (btn) { btn.textContent = "✓ Saved"; btn.classList.add("saved"); }
      });
      popup.querySelector("#lg-ask-ai-btn")?.addEventListener("click", () => {
        closeWordPopup();
        openChatWithContext("word", detail);
      });
    };
    render();
  }

  function closeWordPopup() {
    wordPopup?.remove();
    wordPopup = null;
    if (popupCloseHandler) {
      document.removeEventListener("click", popupCloseHandler);
      popupCloseHandler = null;
    }
  }

  // position the popup near where the user clicked
  function positionPopup(popup, e) {
    popup.style.left = Math.min(e.clientX, window.innerWidth - 340) + "px";
    popup.style.top = Math.max(e.clientY - 320, 10) + "px";
  }

  // chat panel for the ai tutor
  function injectChatPanel() {
    if (document.getElementById("lg-chat-panel")) return;
    const panel = document.createElement("div");
    panel.id = "lg-chat-panel";
    panel.style.display = "none";
    document.body.appendChild(panel);
    chatPanel = panel;
    makeDraggable(panel, ".lg-chat-header");
    renderChatPanel();
  }

  function toggleChatPanel() {
    if (!chatPanel) return;
    const open = chatPanel.style.display !== "none";
    chatPanel.style.display = open ? "none" : "flex";
    if (!open) renderChatPanel();
  }

  // open chat with some context already set (eg user asked about a specific word)
  function openChatWithContext(type, data) {
    chatContext = { type, data };
    chatHistory = [];
    chatPanel.style.display = "flex";
    let sysMsg = "";
    if (type === "word") sysMsg = `💬 Asking about <strong>${escHtml(data.word)}</strong>`;
    else if (type === "grammar") sysMsg = `📖 Grammar: <em>${escHtml(data.sentence)}</em>`;
    else if (type === "practice") sysMsg = `🗣 Conversation practice in ${capitalize(settings.sourceLang)}`;
    renderChatPanel(sysMsg);
    if (type === "word") {
      const q = `Explain the ${settings.sourceLang} word "${data.word}"${data.reading ? ` (${data.reading})` : ""}. Cover its meaning, nuance, common uses, and any tips for a learner. Definition so far: ${data.definition_1 || "unknown"}.`;
      sendChatMessage(q, true);
    }
  }

  // build the chat panel html
  function renderChatPanel(sysMsg = "") {
    if (!chatPanel) return;
    chatPanel.innerHTML = `
      <div class="lg-chat-header">
        <div class="lg-chat-title">
          💬 AI Tutor
          <span class="lg-ai-badge" id="lg-ai-badge">AI Tutor ✓</span>
        </div>
        <div class="lg-chat-header-actions">
          <button class="lg-icon-btn" id="lg-chat-close">✕</button>
        </div>
      </div>
      <div class="lg-chat-messages" id="lg-chat-msgs">
        ${sysMsg ? `<div class="lg-chat-sys">${sysMsg}</div>` : ""}
        ${chatHistory.map(renderBubble).join("")}
        ${!sysMsg && !chatHistory.length ? `
          <div class="lg-chat-empty">
            <div style="font-size:32px;margin-bottom:12px">🐐</div>
            <div style="margin-bottom:12px">Your AI language tutor</div>
            <button class="lg-suggestion" data-p="practice">🗣 Practice conversation</button>
            <button class="lg-suggestion" data-p="grammar">📖 Explain current subtitle</button>
            <button class="lg-suggestion" data-p="tips">💡 Learning tips</button>
          </div>` : ""}
      </div>
      <div class="lg-chat-input-row">
        <button class="lg-voice-btn ${chatVoiceActive?"active":""}" id="lg-chat-voice">🎤</button>
        <input class="lg-chat-input" id="lg-chat-input" type="text"
          placeholder="Ask anything, or type in ${capitalize(settings?.sourceLang || "target language")} to practice…" />
        <button class="lg-send-btn" id="lg-chat-send">↑</button>
      </div>
    `;

    // set badge based on whether a groq api key is configured
    const hasKey = !!(settings?.groqApiKey?.trim());
    updateAiBadge(hasKey ? false : "no-key");

    // wire up all the chat panel buttons
    chatPanel.querySelector("#lg-chat-close").addEventListener("click", () => chatPanel.style.display = "none");
    chatPanel.querySelectorAll(".lg-suggestion").forEach(btn => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.p;
        if (p === "practice") {
          chatContext = { type: "practice" }; chatHistory = []; renderChatPanel();
          sendChatMessage(`Let's practice ${settings.sourceLang}. Start a simple conversation with me in ${settings.sourceLang}. Keep sentences short and correct my mistakes gently.`, true);
        } else if (p === "grammar") {
          const sentence = currentSegment?.original || "No subtitle yet";
          chatContext = { type: "grammar", data: { sentence } }; chatHistory = []; renderChatPanel();
          sendChatMessage(`Break down the grammar of this ${settings.sourceLang} sentence: "${sentence}". Explain each part, particles, conjugations, and how to remember this pattern.`, true);
        } else {
          sendChatMessage(`Give me 5 practical tips for learning ${settings.sourceLang} through watching videos. Be specific and actionable.`, true);
        }
      });
    });

    // send button and enter key
    const input = chatPanel.querySelector("#lg-chat-input");
    chatPanel.querySelector("#lg-chat-send").addEventListener("click", () => {
      const t = input.value.trim(); if (!t) return;
      input.value = ""; sendChatMessage(t, false);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        const t = input.value.trim(); if (!t) return;
        input.value = ""; sendChatMessage(t, false); e.preventDefault();
      }
    });
    chatPanel.querySelector("#lg-chat-voice").addEventListener("click", toggleChatVoice);
    scrollChat();
  }

  // render a single chat bubble
  function renderBubble(m) {
    const cls = m.role === "user" ? "lg-bubble-user" : "lg-bubble-ai";
    const html = m.content.replace(/\n/g,"<br>").replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>");
    return `<div class="lg-bubble ${cls}">${html}</div>`;
  }

  // send a message to the ai tutor and show the response
  async function sendChatMessage(text, isSystem) {
    // always add to history so follow up messages have full context
    chatHistory.push({ role: "user", content: text });
    if (!isSystem) {
      appendBubble({ role: "user", content: text });
    }
    const thinking = appendThinking();
    try {
      const reply = await getAIReply(text);
      thinking.remove();
      chatHistory.push({ role: "assistant", content: reply });
      appendBubble({ role: "assistant", content: reply });
      // if voice mode is on, read the reply out loud
      if (chatVoiceActive) speakText(reply, settings?.sourceLang || "en");
      // reset badge to green on successful response
      updateAiBadge(false);
    } catch (e) {
      thinking.remove();
      const isNoKey = /no groq api key|api key/i.test(e.message);
      const isRateLimit = /429|rate.?limit|too many|quota|token/i.test(e.message);
      const isInvalidKey = /401|unauthorized|invalid.*key|authentication/i.test(e.message);
      if (isNoKey || isInvalidKey) updateAiBadge("no-key");
      else if (isRateLimit) updateAiBadge("rate-limit");
      appendBubble({ role: "assistant", content: "⚠ " + e.message });
    }
  }

  // update the ai badge: false = available (green), "no-key" = no api key (red), "rate-limit" = out of tokens (red)
  function updateAiBadge(reason) {
    const badge = document.getElementById("lg-ai-badge");
    if (!badge) return;
    if (reason === "no-key") {
      badge.textContent = "AI Tutor ✕ — no API key";
      badge.style.background = "rgba(239,68,68,0.15)";
      badge.style.color = "#ef4444";
    } else if (reason === "rate-limit") {
      badge.textContent = "AI Tutor ✕ — out of tokens for the day";
      badge.style.background = "rgba(239,68,68,0.15)";
      badge.style.color = "#ef4444";
    } else {
      badge.textContent = "AI Tutor ✓";
      badge.style.background = "rgba(74,222,128,0.15)";
      badge.style.color = "#4ade80";
    }
  }

  function appendBubble(m) {
    const c = document.getElementById("lg-chat-msgs");
    if (!c) return;
    c.querySelector(".lg-chat-empty")?.remove();
    const el = document.createElement("div");
    el.innerHTML = renderBubble(m);
    c.appendChild(el.firstElementChild);
    scrollChat();
  }

  // show the "thinking..." animation while waiting for ai response
  function appendThinking() {
    const c = document.getElementById("lg-chat-msgs");
    if (!c) return { remove: () => {} };
    const el = document.createElement("div");
    el.className = "lg-bubble lg-bubble-ai lg-thinking";
    el.innerHTML = `<span class="lg-thinking-text">Thinking</span>`;
    c.appendChild(el);
    scrollChat();
    return el;
  }

  function scrollChat() {
    const c = document.getElementById("lg-chat-msgs");
    if (c) c.scrollTop = c.scrollHeight;
  }

  // build the system prompt for the ai tutor based on current context
  async function getAIReply(text) {
    const messages = chatHistory.slice(-10).map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
    if (!messages.length) messages.push({ role: "user", content: text });
    try {
      return await msg("GROQ_CHAT", { systemPrompt: buildSystemPrompt(), messages });
    } catch(e) {
      return `⚠ Couldn't reach AI tutor (${e.message}). Check your internet and try again.`;
    }
  }

  function buildSystemPrompt() {
    const lang = capitalize(settings?.sourceLang || "Japanese");
    const native = capitalize(settings?.nativeLangs?.[0] || "English");
    let base = `You are a friendly expert ${lang} tutor helping a ${native} speaker learn through immersion watching. IMPORTANT: Keep responses SHORT — use 1-3 sentences max, never paragraphs. Be direct and conversational. When showing ${lang}, include romanization and ${native} translation. Do not over-explain.`;
    if (chatContext?.type === "word") base += ` Context: user asked about "${chatContext.data?.word}" (${chatContext.data?.reading || "-"}).`;
    if (chatContext?.type === "grammar") base += ` Context: analyzing grammar of "${chatContext.data?.sentence}".`;
    if (chatContext?.type === "practice") base += ` Context: conversation practice. Reply in ${lang} with ${native} in parentheses. Correct mistakes gently. Keep it short.`;
    return base;
  }

  // voice input for the chat using browser speech recognition
  function toggleChatVoice() {
    chatVoiceActive = !chatVoiceActive;
    document.getElementById("lg-chat-voice")?.classList.toggle("active", chatVoiceActive);
    if (chatVoiceActive) startChatVoice();
    else { stopChatVoice(); window.speechSynthesis?.cancel(); }
  }

  function startChatVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    chatRecognition = new SR();
    chatRecognition.continuous = false;
    chatRecognition.lang = getSpeechLangCode(settings?.sourceLang || "japanese");
    chatRecognition.onresult = e => {
      const text = e.results[0][0].transcript;
      const input = document.getElementById("lg-chat-input");
      if (input) input.value = text;
      setTimeout(() => {
        const t = input?.value.trim();
        if (t) { if (input) input.value = ""; sendChatMessage(t, false); }
        if (chatVoiceActive) startChatVoice();
      }, 500);
    };
    chatRecognition.onerror = () => { if (chatVoiceActive) setTimeout(startChatVoice, 1000); };
    chatRecognition.onend = () => { if (chatVoiceActive) setTimeout(startChatVoice, 300); };
    try { chatRecognition.start(); } catch(e){}
  }

  function stopChatVoice() {
    if (chatRecognition) { try { chatRecognition.stop(); } catch(e){} chatRecognition = null; }
  }

  // get current video info for attaching to notes/vocab
  function getVideoMeta() {
    const video = document.querySelector("video");
    const timestamp = video ? Math.floor(video.currentTime) : 0;
    const url = window.location.href;
    // build a timestamped url if possible
    let linkedUrl = url;
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtube")) {
        u.searchParams.set("t", timestamp + "s");
        linkedUrl = u.toString();
      } else if (u.hostname.includes("netflix") || u.hostname.includes("crunchyroll") || u.hostname.includes("disneyplus")) {
        // these dont support timestamp urls, just use base url
        linkedUrl = url;
      }
    } catch (_) {}
    const pageTitle = document.title || "";
    // format timestamp as mm:ss or hh:mm:ss
    const h = Math.floor(timestamp / 3600);
    const m = Math.floor((timestamp % 3600) / 60);
    const s = timestamp % 60;
    const timeStr = h > 0
      ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
      : `${m}:${String(s).padStart(2,"0")}`;
    return { videoTitle: pageTitle, timestamp: timeStr, url: linkedUrl };
  }

  // text to speech for pronunciation
  function speakText(text, lang) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const cleaned = text.replace(/\(.*?\)/g,"").replace(/\*\*/g,"").trim();
    const utt = new SpeechSynthesisUtterance(cleaned);
    utt.lang = getSpeechLangCode(lang);
    utt.rate = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const nv = voices.find(v => v.lang.startsWith(utt.lang.split("-")[0]) && !v.lang.startsWith("en"));
    if (nv) utt.voice = nv;
    window.speechSynthesis.speak(utt);
  }

  // notes panel (vocab list + freeform notes)
  function injectNotesPanel() {
    if (document.getElementById("lg-notes-panel")) return;
    const panel = document.createElement("div");
    panel.id = "lg-notes-panel";
    panel.style.display = "none";
    document.body.appendChild(panel);
    notesPanel = panel;
    makeDraggable(panel, ".lg-notes-header");
    renderNotesPanel();
  }

  function toggleNotesPanel() {
    if (!notesPanel) return;
    const open = notesPanel.style.display !== "none";
    notesPanel.style.display = open ? "none" : "flex";
    if (!open) renderNotesPanel();
  }

  // rebuild the notes panel html
  function renderNotesPanel() {
    if (!notesPanel) return;
    const [l1, l2] = settings?.nativeLangs || ["english", ""];
    notesPanel.innerHTML = `
      <div class="lg-notes-header">
        <div class="lg-notes-title">📓 Notes</div>
        <div class="lg-notes-header-btns">
          <button class="lg-icon-btn" id="lg-notes-close">✕</button>
        </div>
      </div>
      <div class="lg-notes-tabs">
        <button class="lg-tab ${notesTab==="vocab"?"active":""}" data-tab="vocab">Vocab (${vocabList.length})</button>
        <button class="lg-tab ${notesTab==="notes"?"active":""}" data-tab="notes">Notes (${notesList.length})</button>
      </div>
      <div class="lg-notes-body" id="lg-notes-body">${renderNotesBody(l1, l2)}</div>
      ${notesTab === "notes" ? `
      <div class="lg-note-input-area">
        <textarea class="lg-note-textarea" id="lg-note-input" placeholder="Add a note…"></textarea>
        <button class="lg-note-save-btn" id="lg-note-save">Save</button>
      </div>` : ""}
    `;
    notesPanel.querySelectorAll(".lg-tab").forEach(t => {
      t.addEventListener("click", () => { notesTab = t.dataset.tab; vocabDetailItem = null; noteDetailItem = null; renderNotesPanel(); });
    });
    notesPanel.querySelector("#lg-notes-close")?.addEventListener("click", () => notesPanel.style.display = "none");
    notesPanel.querySelector("#lg-note-save")?.addEventListener("click", async () => {
      const input = document.getElementById("lg-note-input");
      if (!input?.value.trim()) return;
      const vmeta = getVideoMeta();
      const editId = input.dataset.editId || null;
      await msg("SAVE_NOTE", { note: { text: input.value.trim(), id: editId, ...vmeta } });
      notesList = await msg("GET_NOTES");
      renderNotesPanel();
    });
  }

  // render either vocab list or notes list depending on which tab is active
  function renderNotesBody(l1, l2) {
    if (notesTab === "vocab") {
      if (vocabDetailItem) return renderVocabDetail(vocabDetailItem);
      if (!vocabList.length) return `<div class="lg-empty">No vocabulary yet.<br>Click words in subtitles to add them. ✨</div>`;
      return vocabList.map((v, i) => `
        <div class="lg-vocab-item lg-draggable" data-word="${escHtml(v.word)}" data-idx="${i}" data-drag-type="vocab">
          <div class="lg-drag-handle" title="Drag to reorder">⠿</div>
          <div style="flex:1;min-width:0">
            <div class="lg-vocab-word">${escHtml(v.word)}</div>
            ${v.reading ? `<div class="lg-vocab-reading">${escHtml(v.reading)}</div>` : ""}
            <div class="lg-vocab-def">${escHtml(v.definition_1 || "")}</div>
            ${v.videoTitle ? `<div class="lg-note-source">${v.url ? `<a href="${escHtml(v.url)}" target="_blank" class="lg-note-link">` : ""}${escHtml(v.videoTitle.slice(0,40))}${v.timestamp ? ` · ${escHtml(v.timestamp)}` : ""}${v.url ? `</a>` : ""}</div>` : ""}
          </div>
          <button class="lg-star ${v.starred?"starred":""}" data-word="${escHtml(v.word)}">★</button>
          <button class="lg-del-vocab" data-word="${escHtml(v.word)}">🗑</button>
        </div>`).join("");
    }
    // notes tab
    if (noteDetailItem) return renderNoteDetail(noteDetailItem);
    if (!notesList.length) return `<div class="lg-empty">No notes yet.</div>`;
    return notesList.map((n, i) => `
      <div class="lg-note-item lg-draggable" data-idx="${i}" data-id="${escHtml(n.id)}" data-drag-type="notes" style="cursor:pointer">
        <div class="lg-note-item-body">
          <div class="lg-drag-handle" title="Drag to reorder">⠿</div>
          <div style="flex:1;min-width:0">
            <div class="lg-note-text">${formatNote(n.text)}</div>
            <div class="lg-note-meta">
              <span>${new Date(n.updatedAt || n.createdAt).toLocaleDateString()}</span>
              ${n.videoTitle ? `<span class="lg-note-source">${n.url ? `<a href="${escHtml(n.url)}" target="_blank" class="lg-note-link">` : ""}${escHtml(n.videoTitle.slice(0,30))}${n.timestamp ? ` · ${escHtml(n.timestamp)}` : ""}${n.url ? `</a>` : ""}</span>` : ""}
            </div>
          </div>
          <div class="lg-note-actions">
            <button class="lg-edit-note" data-id="${escHtml(n.id)}">✎</button>
            <button class="lg-del-note" data-id="${escHtml(n.id)}">🗑</button>
          </div>
        </div>
      </div>`).join("");
  }

  // detail view for a single freeform note (click to expand like vocab)
  function renderNoteDetail(item) {
    return `
      <div style="padding:4px">
        <button class="lg-back-btn" id="lg-note-detail-back">← Back</button>
        <div style="font-size:14px;color:var(--ink);margin-top:10px;line-height:1.6;white-space:pre-wrap">${escHtml(item.text)}</div>
        <div class="lg-note-meta" style="margin-top:10px">
          <span>${new Date(item.updatedAt || item.createdAt).toLocaleDateString()}</span>
          ${item.videoTitle ? `<span class="lg-note-source">${item.url ? `<a href="${escHtml(item.url)}" target="_blank" class="lg-note-link">` : ""}📺 ${escHtml(item.videoTitle.slice(0,40))}${item.timestamp ? ` · ${escHtml(item.timestamp)}` : ""}${item.url ? `</a>` : ""}</span>` : ""}
        </div>
        <button class="lg-btn-edit-detail" style="margin-top:12px;width:100%;padding:8px;border-radius:8px;border:1px solid rgba(212,101,46,0.3);background:rgba(212,101,46,0.06);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit" data-note-id="${escHtml(item.id)}">✎ Edit this note</button>
      </div>`;
  }

  // detail view for a single vocab word
  function renderVocabDetail(item) {
    const def = vocabDetailLang === 0 ? item.definition_1 : (item.definition_2 || item.definition_1);
    return `
      <div style="padding:4px">
        <button class="lg-back-btn" id="lg-vocab-back">← Back</button>
        <div class="lg-vocab-word" style="font-size:26px;margin:8px 0 2px">${escHtml(item.word)}</div>
        ${item.reading ? `<div class="lg-vocab-reading">${escHtml(item.reading)}</div>` : ""}
        ${item.pos ? `<span class="lg-popup-pos">${escHtml(item.pos)}</span>` : ""}
        ${item.jlpt_level ? `<div class="lg-jlpt" style="margin-top:6px">${escHtml(item.jlpt_level)}</div>` : ""}
        <div style="font-size:14px;color:var(--ink);margin-top:10px;line-height:1.5">${formatDef(def || "")}</div>
        ${item.videoTitle ? `<div class="lg-note-source" style="margin-top:8px">${item.url ? `<a href="${escHtml(item.url)}" target="_blank" class="lg-note-link">` : ""}📺 ${escHtml(item.videoTitle.slice(0,40))}${item.timestamp ? ` · ${escHtml(item.timestamp)}` : ""}${item.url ? `</a>` : ""}</div>` : ""}
        <button class="lg-btn-ai" style="margin-top:12px;width:100%;padding:8px" data-vocab-word="${escHtml(item.word)}">💬 Ask AI about this word</button>
      </div>`;
  }

  // drag to reorder for notes and vocab (notion style)
  let dragState = null;

  document.addEventListener("mousedown", e => {
    const handle = e.target.closest(".lg-drag-handle");
    if (!handle) return;
    const item = handle.closest(".lg-draggable");
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = item.getBoundingClientRect();
    const parentRect = item.parentElement.getBoundingClientRect();

    // create a visual clone that follows the mouse
    const clone = item.cloneNode(true);
    clone.classList.add("lg-drag-clone");
    clone.style.position = "fixed";
    clone.style.width = rect.width + "px";
    clone.style.left = rect.left + "px";
    clone.style.top = rect.top + "px";
    clone.style.zIndex = "2147483647";
    clone.style.pointerEvents = "none";
    // explicitly set font so the clone retains the notebook font outside the panel context
    clone.style.fontFamily = '"Patrick Hand", "Noto Sans", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", system-ui, sans-serif';
    clone.style.color = "var(--ink, #3a3226)";
    document.body.appendChild(clone);

    // create a placeholder where the item was
    const placeholder = document.createElement("div");
    placeholder.className = "lg-drag-placeholder";
    placeholder.style.height = rect.height + "px";
    item.parentElement.insertBefore(placeholder, item);

    item.classList.add("lg-drag-source");

    dragState = {
      el: item,
      clone,
      placeholder,
      type: item.dataset.dragType,
      fromIdx: parseInt(item.dataset.idx),
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      container: item.parentElement,
    };
  });

  document.addEventListener("mousemove", e => {
    if (!dragState) return;
    e.preventDefault();
    const { clone, placeholder, container, offsetY } = dragState;

    // move the clone with the cursor
    clone.style.top = (e.clientY - offsetY) + "px";

    // figure out which item we're hovering over and move the placeholder there
    const items = [...container.querySelectorAll(".lg-draggable:not(.lg-drag-source)")];
    let inserted = false;
    for (const sibling of items) {
      const sibRect = sibling.getBoundingClientRect();
      const midY = sibRect.top + sibRect.height / 2;
      if (e.clientY < midY) {
        container.insertBefore(placeholder, sibling);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      // past all items, put placeholder at the end
      const lastItem = items[items.length - 1];
      if (lastItem) lastItem.after(placeholder);
    }
  });

  document.addEventListener("mouseup", async e => {
    if (!dragState) return;
    const { el, clone, placeholder, type, fromIdx, container } = dragState;

    // figure out where the placeholder ended up
    const allChildren = [...container.children].filter(c => !c.classList.contains("lg-drag-source"));
    const toIdx = allChildren.indexOf(placeholder);

    // clean up
    clone.remove();
    placeholder.remove();
    el.classList.remove("lg-drag-source");
    dragState = null;

    if (toIdx < 0 || toIdx === fromIdx) return;

    // persist the reorder
    const msgType = type === "vocab" ? "REORDER_VOCAB" : "REORDER_NOTES";
    await msg(msgType, { fromIndex: fromIdx, toIndex: toIdx });
    if (type === "vocab") vocabList = await msg("GET_VOCAB");
    else notesList = await msg("GET_NOTES");
    renderNotesPanel();
  });

  // handle clicks inside the notes panel (stars, deletes, vocab detail)
  document.addEventListener("click", async e => {
    const body = document.getElementById("lg-notes-body");
    if (!body) return;

    if (e.target.id === "lg-vocab-back") { vocabDetailItem = null; vocabDetailLang = 0; renderNotesPanel(); return; }
    if (e.target.id === "lg-note-detail-back") { noteDetailItem = null; renderNotesPanel(); return; }
    if (e.target.classList.contains("lg-star")) {
      e.stopPropagation();
      const item = vocabList.find(v => v.word === e.target.dataset.word);
      if (item) { await msg("STAR_VOCAB", { word: item.word, starred: !item.starred }); vocabList = await msg("GET_VOCAB"); renderNotesPanel(); }
      return;
    }
    if (e.target.classList.contains("lg-del-vocab")) {
      e.stopPropagation();
      await msg("DELETE_VOCAB", { word: e.target.dataset.word });
      vocabList = await msg("GET_VOCAB"); renderNotesPanel(); return;
    }
    const vocabItem = e.target.closest(".lg-vocab-item");
    if (vocabItem && body.contains(vocabItem)) {
      vocabDetailItem = vocabList.find(v => v.word === vocabItem.dataset.word);
      vocabDetailLang = activeNativeLang; renderNotesPanel(); return;
    }
    if (e.target.classList.contains("lg-edit-note")) {
      const note = notesList.find(n => n.id === e.target.dataset.id);
      if (note) {
        noteDetailItem = null;
        notesTab = "notes";
        renderNotesPanel();
        const input = document.getElementById("lg-note-input");
        if (input) {
          input.value = note.text;
          input.focus();
          input.dataset.editId = note.id;
        }
      }
      return;
    }
    // "Edit this note" button from inside the note detail view
    if (e.target.classList.contains("lg-btn-edit-detail")) {
      const note = notesList.find(n => n.id === e.target.dataset.noteId);
      if (note) {
        noteDetailItem = null;
        notesTab = "notes";
        renderNotesPanel();
        const input = document.getElementById("lg-note-input");
        if (input) { input.value = note.text; input.focus(); input.dataset.editId = note.id; }
      }
      return;
    }
    if (e.target.classList.contains("lg-del-note")) {
      await msg("DELETE_NOTE", { id: e.target.dataset.id });
      noteDetailItem = null;
      notesList = await msg("GET_NOTES"); renderNotesPanel(); return;
    }
    // clicking a note item opens its detail view (unless clicking a button or drag handle)
    const noteItem = e.target.closest(".lg-note-item");
    if (noteItem && body.contains(noteItem) && !e.target.closest(".lg-note-actions") && !e.target.closest(".lg-drag-handle")) {
      const note = notesList.find(n => n.id === noteItem.dataset.id);
      if (note) { noteDetailItem = note; renderNotesPanel(); }
      return;
    }
    if (e.target.dataset.vocabWord) {
      const item = vocabList.find(v => v.word === e.target.dataset.vocabWord);
      if (item) { notesPanel.style.display = "none"; openChatWithContext("word", item); }
    }
  });

  // make any element draggable by holding its handle area
  function makeDraggable(el, sel) {
    let drag = false, sx, sy, ox, oy;
    el.addEventListener("mousedown", e => {
      if (sel && !e.target.closest(sel)) return;
      if (["BUTTON","INPUT","TEXTAREA"].includes(e.target.tagName)) return;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.position = "fixed"; el.style.left = ox + "px"; el.style.top = oy + "px";
      el.style.bottom = "auto"; el.style.right = "auto"; el.style.transform = "none";
      drag = true; sx = e.clientX; sy = e.clientY; e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  // let user resize the subtitle bar width and height by dragging the corner handle
  function makeResizable(el, handleSel) {
    const handle = el.querySelector(handleSel);
    if (!handle) return;
    let resizing = false, startX, startY, startW, startH;
    handle.addEventListener("mousedown", e => {
      e.stopPropagation(); e.preventDefault();
      const rect = el.getBoundingClientRect();
      resizing = true; startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      document.body.style.cursor = "nwse-resize"; document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", e => {
      if (!resizing) return;
      const newW = Math.max(280, Math.min(window.innerWidth * 0.9, startW + (e.clientX - startX)));
      const newH = Math.max(100, Math.min(window.innerHeight * 0.8, startH + (e.clientY - startY)));
      el.style.width = newW + "px"; el.style.maxWidth = "none";
      el.style.height = newH + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false; document.body.style.cursor = ""; document.body.style.userSelect = "";
    });
  }

  // language code mapping for browser speech api
  function getSpeechLangCode(lang) {
    const m = {
      japanese: "ja-JP", korean: "ko-KR", chinese: "zh-CN",
      "traditional chinese": "zh-TW", spanish: "es-ES", french: "fr-FR",
      german: "de-DE", italian: "it-IT", portuguese: "pt-BR",
      russian: "ru-RU", arabic: "ar-SA", vietnamese: "vi-VN",
    };
    return m[lang?.toLowerCase()] || "en-US";
  }

  function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }


  // escape html to prevent xss when inserting user text into the dom
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // format a definition string so each semicolon-separated entry starts on its own line
  function formatDef(s) {
    if (!s) return "";
    return s.split(";")
      .map(p => p.trim())
      .filter(Boolean)
      .map(escHtml)
      .join(";<br>");
  }

  // format note text preserving line breaks
  function formatNote(s) {
    return escHtml(s || "").replace(/\n/g, "<br>");
  }

  // start everything
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
