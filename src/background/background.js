// lingoat background service worker
// central hub for all messages, api calls, and tab capture

const DBG = (...a) => console.log("[LinGOAT BG]", ...a);
const ERR = (...a) => console.error("[LinGOAT BG ERROR]", ...a);

DBG("service worker loaded");

// open welcome page on first install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/welcome.html") });
  }
});

// which tab were capturing audio from (null = not capturing)
let captureTabId = null;
let pageTitle = "";

// tabs where we found existing subtitles (so we skip audio capture)
let subtitleTabId = null;

// restore state from session storage in case service worker restarted
// runs everytime service worker starts up
chrome.storage.session?.get(["captureTabId", "pageTitle", "subtitleTabId"], (data) => {
  if (data.captureTabId) {
    captureTabId = data.captureTabId;
    pageTitle = data.pageTitle || "";
    DBG("restored capture state, tab:", captureTabId);
  }
  if (data.subtitleTabId) {
    subtitleTabId = data.subtitleTabId;
    DBG("restored subtitle tab:", subtitleTabId);
  }
});

function persistCaptureState() {
  chrome.storage.session?.set({ captureTabId, pageTitle, subtitleTabId }).catch(() => {});
}

function clearCaptureState() {
  captureTabId = null;
  pageTitle = "";
  // dont clear subtitleTabId here, subtitles still exist even after stopping capture
  chrome.storage.session?.remove(["captureTabId", "pageTitle"]).catch(() => {});
}

// main message router, everything flows through here
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  DBG("message received:", msg.type);

  // relay speech recognition results from offscreen doc to the captured tab
  if (msg.type === "SR_FINAL" || msg.type === "SR_INTERIM" || msg.type === "SR_STATUS") {
    if (captureTabId) chrome.tabs.sendMessage(captureTabId, msg).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  // content script found subtitles on the page, stop any audio capture for that tab
  if (msg.type === "SUBTITLE_SCRAPE_DETECTED") {
    const tabId = sender.tab?.id;
    if (tabId) {
      subtitleTabId = tabId;
      chrome.storage.session?.set({ subtitleTabId }).catch(() => {});
      // if were currently capturing this tabs audio, kill it
      if (captureTabId && captureTabId === tabId) {
        DBG("subtitles found on capture tab, stopping audio capture");
        stopTabCapture().catch(() => {});
        // let the content script know we stopped
        chrome.tabs.sendMessage(tabId, { type: "CAPTURE_STOPPED_SUBTITLES_FOUND" }).catch(() => {});
      }
    }
    sendResponse({ success: true, data: null });
    return true;
  }

  const handlers = {
    TRANSLATE_SEGMENT: () => translateSegment(msg.text, msg.sourceLang, msg.nativeLangs),
    LOOKUP_WORD: () => lookupWord(msg.word, msg.sourceLang, msg.nativeLang, msg.nativeLang2, msg.isPhrase),
    SAVE_VOCAB: () => saveVocab(msg.entry),
    GET_VOCAB: () => getVocab(),
    DELETE_VOCAB: () => deleteVocab(msg.word),
    STAR_VOCAB: () => starVocab(msg.word, msg.starred),
    SAVE_NOTE: () => saveNote(msg.note),
    GET_NOTES: () => getNotes(),
    DELETE_NOTE: () => deleteNote(msg.id),
    REORDER_VOCAB: () => reorderList("vocab", msg.fromIndex, msg.toIndex),
    REORDER_NOTES: () => reorderList("notes", msg.fromIndex, msg.toIndex),
    GET_SETTINGS: () => getSettings(),
    SAVE_SETTINGS: () => saveSettings(msg.settings),
    START_TAB_CAPTURE: () => startTabCapture(msg.tabId),
    STOP_TAB_CAPTURE: () => stopTabCapture(),
    GROQ_CHAT: () => groqChat(msg.systemPrompt, msg.messages),
    // returns capture state so popup can show the right button
    GET_CAPTURE_STATE: () => Promise.resolve({ capturing: captureTabId !== null, captureTabId, subtitleTabId }),
  };

  const handler = handlers[msg.type];
  if (!handler) { DBG("no handler for:", msg.type); return false; }

  handler()
    .then(data => { DBG("success:", msg.type); sendResponse({ success: true, data }); })
    .catch(err => { ERR("failed:", msg.type, err); sendResponse({ success: false, error: err.message }); });
  return true;
});

// start recording audio from a tab using groq whisper for transcription
async function startTabCapture(tabId) {
  DBG("startTabCapture for tab:", tabId);
  if (!tabId) throw new Error("No tab ID provided");

  // stop any existing capture first
  if (captureTabId) {
    DBG("stopping existing capture on tab:", captureTabId);
    await stopTabCapture().catch(() => {});
  }

  captureTabId = tabId;

  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title || "";
  } catch (_) { pageTitle = ""; }

  // get a media stream id for the tabs audio
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({}, (id) => {
      if (chrome.runtime.lastError || !id)
        return reject(new Error(chrome.runtime.lastError?.message || "getMediaStreamId failed"));
      resolve(id);
    });
  });

  // spin up the offscreen document if it doesnt exist yet (it does the actual recording)
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => []);
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("src/offscreen/offscreen.html"),
      reasons: ["USER_MEDIA"],
      justification: "Tab audio capture via MediaRecorder + Groq Whisper transcription",
    });
    await new Promise(r => setTimeout(r, 400));
  }

  // get the language and api key from settings
  const settings = await getSettings();
  const isoLang = getIsoLangCode(settings.sourceLang);
  const groqKey = settings.groqApiKey || "";

  // tell the offscreen doc to start recording
  chrome.runtime.sendMessage({ target: "offscreen", type: "START_OFFSCREEN_CAPTURE", streamId, isoLang, groqKey });
  persistCaptureState();
  return { started: true };
}

async function stopTabCapture() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_OFFSCREEN_CAPTURE" }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  await chrome.offscreen.closeDocument().catch(() => {});
  clearCaptureState();
  return { stopped: true };
}

// maps language names to iso 639 codes for whisper
function getIsoLangCode(lang) {
  const m = {
    japanese: "ja", korean: "ko", chinese: "zh", "traditional chinese": "zh",
    spanish: "es", french: "fr", german: "de", italian: "it",
    portuguese: "pt", russian: "ru", arabic: "ar", hindi: "hi", english: "en",
    vietnamese: "vi",
  };
  return m[lang?.toLowerCase()] || "en";
}

// maps language names to google translate codes
function getLangCode(lang) {
  const map = {
    japanese: "ja", korean: "ko", chinese: "zh-CN", "traditional chinese": "zh-TW",
    english: "en", spanish: "es", french: "fr", german: "de", italian: "it",
    portuguese: "pt", russian: "ru", arabic: "ar", hindi: "hi", vietnamese: "vi",
    "chinese (simplified)": "zh-CN", "chinese (traditional)": "zh-TW",
  };
  return map[lang?.toLowerCase()] || lang?.slice(0, 2) || "en";
}

// maps language names to wiktionary section names
function getWiktionaryLang(lang) {
  const map = {
    japanese: "Japanese", korean: "Korean", chinese: "Chinese",
    spanish: "Spanish", french: "French", german: "German",
    italian: "Italian", portuguese: "Portuguese", russian: "Russian", arabic: "Arabic",
    vietnamese: "Vietnamese",
  };
  return map[lang?.toLowerCase()] || "English";
}

const CJK_LANGS = ["japanese", "chinese", "korean"];

// cache so we dont hit the translate api for the same text twice
const translateCache = new Map();

// full pipeline cache, stores complete translateSegment results (translations + word splits)
// prevents groq non-determinism from causing subtitle flashing when same cue is re-scraped
const segmentCache = new Map();
function segmentCacheSet(key, val) {
  segmentCache.set(key, val);
  if (segmentCache.size > 100) segmentCache.delete(segmentCache.keys().next().value);
}

// main translation pipeline: free translate + groq enrichment running in parallel
async function translateSegment(text, sourceLang, nativeLangs) {
  if (!text?.trim()) throw new Error("Empty text");

  // check full pipeline cache first, same text always returns identical result (no groq randomness)
  const cacheKey = `${text}|${sourceLang}|${nativeLangs.join(",")}`;
  if (segmentCache.has(cacheKey)) {
    DBG("segment cache hit:", text.slice(0, 30));
    return segmentCache.get(cacheKey);
  }

  const [lang1, lang2] = nativeLangs;
  const srcCode = getLangCode(sourceLang);
  const settings = await getSettings();
  const groqKey = settings.groqApiKey || "";

  // fire off free translation and groq enrichment at the same time
  // groq gives us word splitting + furigana + a better translation
  const [[trans1Raw, trans2Raw], groqResult] = await Promise.all([
    Promise.all([
      freeTranslate(text, srcCode, getLangCode(lang1)),
      lang2 ? freeTranslate(text, srcCode, getLangCode(lang2)) : Promise.resolve(null),
    ]),
    groqKey ? callGroqEnrich(text, sourceLang, lang1, lang2, groqKey) : Promise.resolve(null),
  ]);

  // prefer groq translation if available, fall back to free translate
  const translation_1 = groqResult?.translation_1 || trans1Raw;
  const translation_2 = groqResult?.translation_2 || trans2Raw;
  const words = groqResult?.words?.length
    ? groqResult.words
    : tokenize(text, sourceLang).map(w => ({ word: w, reading: null, meaning_1: "", meaning_2: null, pos: "" }));

  const result = { original: text, romanization: null, translation_1, translation_2, words };
  segmentCacheSet(cacheKey, result);
  return result;
}

// ask groq to split the text into words with readings and translate it
async function callGroqEnrich(text, sourceLang, lang1, lang2, groqKey) {
  const isCJK = CJK_LANGS.includes(sourceLang?.toLowerCase());
  const titleCtx = pageTitle ? `The video title is: "${pageTitle}". Use this to correctly identify character names and proper nouns.` : "";

  // cjk languages need special word splitting rules
  const wordInstructions = isCJK
    ? `Split into meaningful linguistic units (keep compound verbs/expressions as single words, e.g. "していた" stays together). For Japanese: the "reading" field MUST be hiragana only (e.g. "たべる" not "taberu") for any word containing kanji; null for pure kana words. For Chinese: use pinyin with tone marks. For Korean: use the word itself as reading (null if unchanged).`
    : `Split by whitespace into individual words.`;

  const prompt = `You are a subtitle processor. ${titleCtx}
    Subtitle text (${sourceLang}): "${text}"

    Return ONLY a JSON object with these exact fields:
    {
      "translation_1": "<natural, accurate translation into ${lang1} — output ONLY ${lang1} text here, never ${sourceLang}>",
      ${lang2 ? `"translation_2": "<natural, accurate translation into ${lang2} — output ONLY ${lang2} text here, never ${sourceLang}>",` : ""}
      "words": [{"word": "<${sourceLang} word, never translated>", "reading": "<hiragana for Japanese / pinyin for Chinese / null if not needed>"}]
    }

    Word splitting rules: ${wordInstructions}
    Translation rules: Natural, fluent — not word-for-word. Fix character/place names using the video title if relevant.
    CRITICAL: "translation_1" must be written entirely in ${lang1}. Do NOT output ${sourceLang} text in any translation field. The "words" array must contain the original ${sourceLang} tokens only.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) { DBG("callGroqEnrich non-ok:", res.status); return null; }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.words?.length) return null;
    return {
      translation_1: parsed.translation_1 || null,
      translation_2: parsed.translation_2 || null,
      words: parsed.words
        .map(w => {
          let reading = w.reading || null;
          // for japanese, throw away romaji readings (we only want hiragana/katakana)
          if (sourceLang?.toLowerCase() === "japanese" && reading && /[a-zA-Zāīūēōàèìòùáéíóú]/.test(reading)) {
            reading = null;
          }
          return { word: String(w.word || ""), reading, meaning_1: "", meaning_2: null, pos: "" };
        })
        .filter(w => w.word),
    };
  } catch (e) {
    DBG("callGroqEnrich failed:", e.message);
    return null;
  }
}

// free translation using google translate, falls back to mymemory
async function freeTranslate(text, fromCode, toCode) {
  const key = `${fromCode}|${toCode}|${text}`;
  if (translateCache.has(key)) return translateCache.get(key);
  if (fromCode === toCode) return text;
  let result = text;

  // try google translate first
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromCode}&tl=${toCode}&dt=t&q=${encodeURIComponent(text)}`);
    if (res.ok) {
      const d = await res.json();
      const t = d[0]?.map(x => x[0]).filter(Boolean).join("");
      if (t) { result = t; cacheSet(key, result); return result; }
    }
  } catch (_) {}

  // fall back to mymemory
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromCode}|${toCode}`);
    if (res.ok) {
      const d = await res.json();
      if (d.responseStatus === 200 && d.responseData?.translatedText) result = d.responseData.translatedText;
    }
  } catch (_) {}

  cacheSet(key, result);
  return result;
}

function cacheSet(key, val) {
  translateCache.set(key, val);
  // keep cache from growing forever
  if (translateCache.size > 200) translateCache.delete(translateCache.keys().next().value);
}

// look up a word in the dictionary (jisho for japanese, wiktionary for others)
// for phrases (multi word selections), just translate the whole thing
async function lookupWord(word, sourceLang, nativeLang, nativeLang2, isPhrase) {
  const lang = sourceLang?.toLowerCase();
  let result = null;

  // phrases just get translated, no dictionary lookup
  if (isPhrase) {
    const [trans1, trans2] = await Promise.all([
      freeTranslate(word, getLangCode(lang), getLangCode(nativeLang)),
      nativeLang2 && nativeLang2 !== nativeLang
        ? freeTranslate(word, getLangCode(lang), getLangCode(nativeLang2))
        : Promise.resolve(null),
    ]);
    return { word, reading: null, pos: "phrase", definition_1: trans1, definition_2: trans2, examples: [], notes: "", jlpt_level: null };
  }

  // try jisho first for japanese
  if (lang === "japanese") result = await lookupJisho(word, nativeLang);
  // then wiktionary for any language
  if (!result) result = await lookupWiktionary(word, lang, nativeLang);
  // last resort: just translate the word
  if (!result) {
    const translation = await freeTranslate(word, getLangCode(lang), getLangCode(nativeLang));
    result = { word, reading: null, pos: "", definition_1: translation, definition_2: null, examples: [], notes: "", jlpt_level: null };
  }

  // if user has a second native language, get the definition in that too
  if (nativeLang2 && nativeLang2 !== nativeLang) {
    try {
      let def2 = null;
      if (lang === "japanese") { const r2 = await lookupJisho(word, nativeLang2); def2 = r2?.definition_1 || null; }
      if (!def2) { const r2 = await lookupWiktionary(word, lang, nativeLang2); def2 = r2?.definition_1 || null; }
      if (!def2) def2 = await freeTranslate(result.definition_1 || word, getLangCode(nativeLang), getLangCode(nativeLang2));
      result.definition_2 = def2;
    } catch (_) {}
  }
  return result;
}

// jisho.org api for japanese words
async function lookupJisho(word, nativeLang) {
  try {
    const res = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data.data?.[0];
    if (!entry) return null;
    const japanese = entry.japanese?.[0] || {};
    const sense = entry.senses?.[0] || {};
    const englishDef = sense.english_definitions?.join("; ") || "";
    const nativeCode = getLangCode(nativeLang);
    // if user isnt english, translate the english definition to their language
    const def1 = nativeCode !== "en" ? await freeTranslate(englishDef, "en", nativeCode) : englishDef;
    return {
      word, reading: japanese.reading || null,
      pos: sense.parts_of_speech?.join(", ") || "",
      definition_1: def1, definition_2: null, examples: [],
      notes: sense.tags?.join(", ") || "",
      jlpt_level: entry.jlpt?.[0]?.toUpperCase() || null,
    };
  } catch (_) { return null; }
}

// wiktionary api for non japanese words (or as fallback)
async function lookupWiktionary(word, lang, nativeLang) {
  try {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const wikiLang = getWiktionaryLang(lang);
    // find the section that matches our source language
    const langKey = Object.keys(data).find(k =>
      k.toLowerCase().includes(wikiLang.toLowerCase()) || k.toLowerCase().includes(lang.toLowerCase())
    ) || Object.keys(data)[0];
    if (!langKey || !data[langKey]?.length) return null;
    const entry = data[langKey][0];
    const def = entry.definitions?.[0];
    if (!def) return null;
    const rawDef = (def.definition || "").replace(/<[^>]+>/g, "").trim();
    const nativeCode = getLangCode(nativeLang);
    const def1 = (nativeCode !== "en" && rawDef) ? await freeTranslate(rawDef, "en", nativeCode) : rawDef;
    return {
      word, reading: null, pos: entry.partOfSpeech || "",
      definition_1: def1, definition_2: null,
      examples: (def.examples || []).slice(0, 2).map(ex => ({
        sentence: ex.replace(/<[^>]+>/g, "").trim(),
        romanization: null, translation_1: "", translation_2: null,
      })),
      notes: "", jlpt_level: null,
    };
  } catch (_) { return null; }
}

// simple tokenizer for when groq isnt available
// splits cjk char by char, others by spaces
function tokenize(text, lang) {
  const l = lang?.toLowerCase();
  if (l === "japanese" || l === "chinese") {
    const tokens = []; let buf = "";
    for (const ch of text) {
      if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) { if (buf) { tokens.push(buf); buf = ""; } tokens.push(ch); }
      else if (ch === " " || ch === "\u3000") { if (buf) { tokens.push(buf); buf = ""; } }
      else { buf += ch; }
    }
    if (buf) tokens.push(buf);
    return tokens.filter(Boolean);
  }
  if (l === "korean") return text.split(/\s+/).filter(Boolean);
  return text.match(/\S+/g) || [];
}

// storage helpers for vocab, notes, and settings
async function saveVocab(entry) {
  const vocab = await getVocab();
  const idx = vocab.findIndex(v => v.word === entry.word);
  if (idx >= 0) vocab[idx] = { ...vocab[idx], ...entry, updatedAt: Date.now() };
  else vocab.unshift({ ...entry, addedAt: Date.now(), starred: false });
  await chrome.storage.local.set({ vocab });
}
async function getVocab() { const { vocab = [] } = await chrome.storage.local.get("vocab"); return vocab; }
async function deleteVocab(w) { await chrome.storage.local.set({ vocab: (await getVocab()).filter(v => v.word !== w) }); }
async function starVocab(word, starred) {
  const vocab = await getVocab();
  const item = vocab.find(v => v.word === word);
  if (item) item.starred = starred;
  await chrome.storage.local.set({ vocab });
}
async function saveNote(note) {
  const notes = await getNotes();
  const id = note.id || Date.now().toString();
  const idx = notes.findIndex(n => n.id === id);
  if (idx >= 0) notes[idx] = { ...note, id, updatedAt: Date.now() };
  else notes.unshift({ ...note, id, createdAt: Date.now() });
  await chrome.storage.local.set({ notes });
}
async function getNotes() { const { notes = [] } = await chrome.storage.local.get("notes"); return notes; }
async function deleteNote(id) { await chrome.storage.local.set({ notes: (await getNotes()).filter(n => n.id !== id) }); }
async function reorderList(key, fromIndex, toIndex) {
  const data = await chrome.storage.local.get(key);
  const list = data[key] || [];
  if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return;
  const [item] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, item);
  await chrome.storage.local.set({ [key]: list });
}
async function getSettings() { const { settings } = await chrome.storage.local.get("settings"); return settings || defaultSettings(); }
async function saveSettings(s) { await chrome.storage.local.set({ settings: s }); }
function defaultSettings() {
  return { sourceLang: "japanese", nativeLangs: ["english", ""], subtitleSize: 18, subtitleOpacity: 0.85, autoStart: true, ignorePageCC: false, groqApiKey: "" };
}

// send a message to groqs chat api for the ai tutor
async function groqChat(systemPrompt, messages) {
  const settings = await getSettings();
  const groqKey = settings.groqApiKey || "";
  if (!groqKey) throw new Error("No Groq API key set, add it in the extension popup");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.7,
      max_tokens: 200,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => String(res.status));
    throw new Error("Groq chat error " + res.status + ": " + txt.slice(0, 120));
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Empty response from Groq");
  return reply;
}

DBG("service worker ready");
