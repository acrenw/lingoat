// lingoat offscreen document
// handles tab audio recording and whisper transcription
// runs in a hidden page because chrome wont let service workers use mediarecorder
// we slice audio every 5 seconds and send each chunk to groq whisper // TODO: improve later

const LOG = (...a) => console.log("[LinGOAT Offscreen]", ...a);
const ERR = (...a) => console.error("[LinGOAT Offscreen ERROR]", ...a);

let mediaRecorder = null;
let audioCtx = null;
let stream = null;
let isRunning = false;
let groqApiKey = "";
let isoLang = "ja";
let mimeType = "";
let recordedChunks = [];
let sliceTimer = null;

// how often we cut and transcribe a chunk (every 5 seconds)
const SLICE_INTERVAL_MS = 5000;

// old vad (voice activity detection) approach that split on natural speech pauses
// keeping this commented out in case we want to bring it back later
//
// let analyser = null;
// let analyserData = null;
// let vadInterval = null;
// let speechDetected = false;
// let silenceStart = null;
// let recordStart = null;
// const SILENCE_THRESHOLD = 0.008;
// const SILENCE_DURATION = 200;
// const MAX_SEGMENT_MS = 15000;
// const MIN_SEGMENT_MS = 500;
//
// function getAudioLevel() {
//   if (!analyser || !analyserData) return 0;
//   analyser.getByteTimeDomainData(analyserData);
//   let sum = 0;
//   for (let i = 0; i < analyserData.length; i++) {
//     const v = (analyserData[i] - 128) / 128;
//     sum += v * v;
//   }
//   return Math.sqrt(sum / analyserData.length);
// }
//
// function startVAD() {
//   speechDetected = false;
//   silenceStart = null;
//   recordStart = Date.now();
//   vadInterval = setInterval(() => {
//     if (!isRunning || !mediaRecorder || mediaRecorder.state !== "recording") return;
//     const level = getAudioLevel();
//     const elapsed = Date.now() - recordStart;
//     if (elapsed >= MAX_SEGMENT_MS) {
//       if (mediaRecorder?.state === "recording") mediaRecorder.stop();
//       return;
//     }
//     if (level > SILENCE_THRESHOLD) {
//       speechDetected = true;
//       silenceStart = null;
//     } else if (speechDetected && elapsed >= MIN_SEGMENT_MS) {
//       if (!silenceStart) {
//         silenceStart = Date.now();
//       } else if (Date.now() - silenceStart >= SILENCE_DURATION) {
//         if (mediaRecorder?.state === "recording") mediaRecorder.stop();
//       }
//     }
//   }, 80);
// }
//
// function stopVAD() {
//   clearInterval(vadInterval);
//   vadInterval = null;
// }

// listen for commands from the background script
chrome.runtime.onMessage.addListener((message) => { // works with chrome.runtime.sendMessage
  if (message.target !== "offscreen") return; // filters
  if (message.type === "START_OFFSCREEN_CAPTURE") {
    LOG("start received, streamId:", message.streamId, "lang:", message.isoLang);
    groqApiKey = message.groqKey || "";
    isoLang = message.isoLang || "ja";
    startCapture(message.streamId);
  }
  if (message.type === "STOP_OFFSCREEN_CAPTURE") {
    LOG("stop received");
    stopCapture();
  }
});

async function startCapture(streamId) {
  // clean up any previous capture
  stopCapture();

  // grab the tabs audio as a media stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    LOG("got audio stream, tracks:", stream.getAudioTracks().length);
  } catch (e) {
    ERR("getUserMedia failed:", e.name, e.message);
    chrome.runtime.sendMessage({ type: "SR_STATUS", status: "error", error: "Tab capture failed: " + e.message });
    return;
  }

  // chrome mutes tab audio when you capture it, so pipe it back so the user can still hear
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
    LOG("audio piped back to tab");
  } catch (e) {
    ERR("audiocontext setup failed (non fatal):", e.message);
  }

  // pick a format the browser supports, prefer opus for speech
  mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find(m => MediaRecorder.isTypeSupported(m)) || "";

  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (e) {
    ERR("mediarecorder init failed:", e.message);
    chrome.runtime.sendMessage({ type: "SR_STATUS", status: "error", error: "MediaRecorder failed: " + e.message });
    return;
  }

  recordedChunks = [];
  isRunning = true;

  // collect audio data as it comes in
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  // when a 5 second slice finishes, send it to whisper
  mediaRecorder.onstop = async () => {
    const chunks = recordedChunks.splice(0);
    if (chunks.length === 0) {
      if (isRunning) startNextSlice();
      return;
    }
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    LOG("blob ready:", blob.size, "bytes");

    // tiny blobs are probably silence, skip em
    if (blob.size < 5000) {
      LOG("skipping tiny blob (probably silence):", blob.size);
      if (isRunning) startNextSlice();
      return;
    }

    chrome.runtime.sendMessage({ type: "SR_STATUS", status: "transcribing" });
    await transcribeChunk(blob);
    if (isRunning) startNextSlice();
  };

  mediaRecorder.onerror = (e) => ERR("mediarecorder error:", e.error);

  // start the first 5 second slice
  startNextSlice();
  LOG("recording started, translating every 5 seconds");
  chrome.runtime.sendMessage({ type: "SR_STATUS", status: "listening" });
}

// record for 5 seconds then stop to trigger transcription, then loop
function startNextSlice() {
  if (!mediaRecorder || mediaRecorder.state === "recording") return;
  try {
    recordedChunks = [];
    mediaRecorder.start();
    sliceTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, SLICE_INTERVAL_MS);
  } catch (e) {
    ERR("startNextSlice error:", e.message);
  }
}

// send an audio chunk to groq whisper for transcription
async function transcribeChunk(blob) {
  if (!groqApiKey) {
    chrome.runtime.sendMessage({ type: "SR_STATUS", status: "error", error: "No Groq API key, add it in the extension popup" });
    return;
  }

  const formData = new FormData(); // send blob to groq via formData
  formData.append("file", blob, "audio.webm"); // filename "audio.webm" is just a label for the server
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("response_format", "verbose_json");
  formData.append("temperature", "0");
  // tell whisper what language to expect so it doesnt output english or romaji
  if (isoLang) formData.append("language", isoLang);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { // groqs whisper api endpoint
      method: "POST",
      headers: { "Authorization": "Bearer " + groqApiKey },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      ERR("groq error:", res.status, errText);
      chrome.runtime.sendMessage({ type: "SR_STATUS", status: "error", error: "Groq " + res.status + ": " + errText.slice(0, 80) });
      return;
    }

    const data = await res.json();
    const text = data.text?.trim();

    // whisper hallucinates when theres no speech, check confidence to catch it
    const segments = data.segments || [];
    const avgNoSpeech = segments.length
      ? segments.reduce((s, seg) => s + (seg.no_speech_prob || 0), 0) / segments.length : 0;
    const avgLogProb = segments.length
      ? segments.reduce((s, seg) => s + (seg.avg_logprob || 0), 0) / segments.length : 0;

    if (avgNoSpeech > 0.5 || avgLogProb < -0.8) {
      LOG("skipping hallucination (no_speech:", avgNoSpeech.toFixed(2), "logprob:", avgLogProb.toFixed(2), ")");
      chrome.runtime.sendMessage({ type: "SR_STATUS", status: "listening" });
      return;
    }

    // filter out common whisper hallucination phrases that pop up during silence
    // exact match phrases (compared via === or startsWith)
    // TODO: make better later
    const hallPhrases = [
      "thank you for watching", "thanks for watching", "thank you",
      "please subscribe", "like and subscribe", "see you next time",
      "subtitles by", "translated by", "amara.org",
      "thank you for watching netflix", "thanks for watching netflix",
      "ありがとうございました", "ありがとうございます",
      "ご視聴ありがとうございました", "チャンネル登録お願いします",
      "see you in the next video", "goodbye",
      "arigatou gozaimasu", "arigatou gozaimashita", "arigatou",
      "arigato gozaimasu", "arigato gozaimashita", "arigato",
      "gochisousama deshita", "otsukaresama deshita",
      "mata ne", "jaa ne", "oyasumi nasai",
      "chinese subtitles", "中文字幕", "中文翻译", "字幕由", "中文字幕由",
    ];
    // substring phrases, skip if the text contains any of these
    const hallSubstrings = [
      "thank you for watching", "thanks for watching",
      "arigatou gozaimas", "arigato gozaimas",
      "please subscribe", "like and subscribe",
      "chinese subtitles", "中文字幕",
    ];
    const lower = text ? text.toLowerCase().trim() : "";
    if (lower && (hallPhrases.some(p => lower === p || lower.startsWith(p)) || hallSubstrings.some(p => lower.includes(p)))) {
      LOG("skipping known hallucination phrase:", text);
      chrome.runtime.sendMessage({ type: "SR_STATUS", status: "listening" });
      return;
    }

    if (text) {
      // check if whisper detected a different language than expected
      const detectedLang = data.language || "";
      LOG("transcript:", text, "detected:", detectedLang, "expected:", isoLang);
      if (isoLang && detectedLang && detectedLang !== isoLang && detectedLang === "en") {
        LOG("skipping transcription in wrong language (detected:", detectedLang, "expected:", isoLang, ")");
        chrome.runtime.sendMessage({ type: "SR_STATUS", status: "listening" });
        return;
      }
      chrome.runtime.sendMessage({ type: "SR_FINAL", text });
    } else {
      chrome.runtime.sendMessage({ type: "SR_STATUS", status: "listening" });
    }
  } catch (e) {
    ERR("groq fetch error:", e.message);
    chrome.runtime.sendMessage({ type: "SR_STATUS", status: "error", error: "Network error: " + e.message });
  }
}

// stop everything and clean up
function stopCapture() {
  isRunning = false;
  clearTimeout(sliceTimer);
  sliceTimer = null;
  recordedChunks = [];

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;

  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }

  LOG("capture stopped");
}
