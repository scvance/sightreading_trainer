/* Sight-reading generator: independent RH/LH rhythms + exact measure filling + reliable red/green note coloring
   + SoundFont playback (real sampled instrument) + Restart Scroll.

   SoundFont playback uses soundfont-player (sampled instruments, not synth sine). :contentReference[oaicite:2]{index=2}
*/

let VF = null;

const KEY_INFO = {
  C: { accidentals: 0, prefer: "sharp" },
  G: { accidentals: 1, prefer: "sharp" },
  D: { accidentals: 2, prefer: "sharp" },
  A: { accidentals: 3, prefer: "sharp" },
  E: { accidentals: 4, prefer: "sharp" },
  B: { accidentals: 5, prefer: "sharp" },
  "F#": { accidentals: 6, prefer: "sharp" },
  "C#": { accidentals: 7, prefer: "sharp" },
  F: { accidentals: -1, prefer: "flat" },
  Bb: { accidentals: -2, prefer: "flat" },
  Eb: { accidentals: -3, prefer: "flat" },
  Ab: { accidentals: -4, prefer: "flat" },
  Db: { accidentals: -5, prefer: "flat" },
  Gb: { accidentals: -6, prefer: "flat" },
  Cb: { accidentals: -7, prefer: "flat" },
};

const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

const scoreEl = document.getElementById("score");
const midiStatusEl = document.getElementById("midi-status");
const bpmRange = document.getElementById("bpm-range");
const bpmValue = document.getElementById("bpm-value");
const keySelect = document.getElementById("key-select");
const windowSizeInput = document.getElementById("window-size");
const polyphonyInput = document.getElementById("polyphony");
const timeSigSelect = document.getElementById("timesig");
const trickyList = document.getElementById("tricky-list");
const correctCountEl = document.getElementById("correct-count");
const mistakeCountEl = document.getElementById("mistake-count");
const accuracyEl = document.getElementById("accuracy");
const regenerateBtn = document.getElementById("regenerate");
const toggleRunBtn = document.getElementById("toggle-run");
const diffButtons = document.querySelectorAll("#difficulty .chip");
const scoreWrapper = document.querySelector(".score-wrapper");
const midiSelect = document.getElementById("midi-select");
const midiConnectBtn = document.getElementById("midi-connect");
const staticClefsEl = document.getElementById("static-clefs");

let layout = { playheadX: 120, leadInPx: 120 };
const pxPerBeat = 90;

const INPUT_TIMING = {
  // User can play at most this many beats early. Earlier than this is ignored.
  earlyWindowBeats: 0.18,   // ~ a 16th-note early (tweak 0.10..0.30)
  // Keep your miss window separate (used in checkPlayheadMiss)
  lateWindowBeats: 0.12,
};


let state = {
  bpm: Number(bpmRange.value),
  key: "C",
  windowSize: Number(windowSizeInput.value),
  maxPoly: Number(polyphonyInput.value),
  timeSig: "4/4",
  difficulty: "easy",
  running: true,

  trebleSeq: [],
  bassSeq: [],
  targets: [],

  progressBeats: 0,
  tricky: new Map(),
  stats: { correct: 0, mistakes: 0 },

  midiInputs: [],
  midiAccess: null,
  midiInputId: null,

  keySig: new Map(),
  preferSharps: true,

  // id -> "mistake" | "correct"
  renderMarks: new Map(),
};

async function ensureVexFlow() {
  if (VF) return true;
  if (window.Vex?.Flow) {
    VF = window.Vex.Flow;
    return true;
  }
  return await new Promise((resolve) => {
    const existing = document.querySelector('script[src$="vendor-vexflow.js"]');
    if (existing) {
      existing.addEventListener("load", () => {
        VF = window.Vex?.Flow || null;
        resolve(!!VF);
      });
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = "./vendor-vexflow.js";
    script.onload = () => {
      VF = window.Vex?.Flow || null;
      resolve(!!VF);
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

/* ------------------------- SoundFont playback (sampled instrument) ------------------------- */

const playback = {
  ctx: null,
  sf: null, // soundfont function
  instrument: null,
  instrumentName: "acoustic_grand_piano",
  isPlaying: false,
  activeNodes: [],
  stopTimer: null,
  playBtn: null,
  restartBtn: null,
  instrumentSelect: null,
  statusEl: null,
};

function getThemeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function ensureAudioContext() {
  if (playback.ctx) return playback.ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  playback.ctx = new Ctx();
  return playback.ctx;
}

async function ensureSoundfontPlayer() {
  // soundfont-player dist sets window.Soundfont in the UMD browser build. :contentReference[oaicite:2]{index=2}
  if (playback.sf) return playback.sf;

  const have = () =>
    (typeof window.Soundfont === "function" || typeof window.Soundfont === "object") &&
    typeof window.Soundfont?.instrument === "function";

  if (have()) {
    playback.sf = window.Soundfont;
    return playback.sf;
  }

  // Use UNPKG "View Raw" URL (works as a normal <script src="..."> in browsers).
  const src = "https://unpkg.com/soundfont-player@0.12.0/dist/soundfont-player.min.js";

  await new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (have()) return resolve();
      existing.addEventListener("load", resolve);
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  if (!have()) {
    throw new Error("soundfont-player loaded, but window.Soundfont.instrument is missing");
  }

  playback.sf = window.Soundfont;
  return playback.sf;
}

async function loadInstrument(name) {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  const Soundfont = await ensureSoundfontPlayer();

  // README usage: Soundfont.instrument(ac, 'clavinet', { soundfont: 'FluidR3_GM' }) :contentReference[oaicite:3]{index=3}
  // Default in the library is MusyngKite (higher quality). :contentReference[oaicite:4]{index=4}
  const inst = await Soundfont.instrument(ctx, name, {
    soundfont: "MusyngKite",
    format: "mp3",
    // Optional perf knob: only decode common piano range (keeps load quick)
    // notes: Array.from({ length: 61 }, (_, i) => 36 + i), // MIDI 36..96
  });

  playback.instrument = inst;
  playback.instrumentName = name;

  return inst;
}


function midiToSoundfontNoteName(midi, preferSharps = true) {
  const octave = Math.floor(midi / 12) - 1;
  const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  const name = names[midi % 12];
  return `${name}${octave}`; // e.g., C#4
}

function playNoteSafe(inst, noteName, whenSec, durSec, gain = 0.75) {
  try {
    // Documented form: play(note, time, { duration }) :contentReference[oaicite:6]{index=6}
    return inst.play(noteName, whenSec, { duration: durSec, gain });
  } catch (e) {
    console.warn("instrument.play failed for", noteName, e);
    return null;
  }
}

function stopPlayback() {
  if (playback.stopTimer) {
    clearTimeout(playback.stopTimer);
    playback.stopTimer = null;
  }
  playback.activeNodes.forEach((n) => {
    try {
      if (n && typeof n.stop === "function") n.stop(0);
    } catch {}
  });
  playback.activeNodes = [];
  playback.isPlaying = false;
  if (playback.playBtn) playback.playBtn.textContent = "Play";
}

function computePlaybackEvents() {
  // Use per-hand events for realistic independent rhythms.
  const events = [];
  const add = (seq) => {
    seq.forEach((ev) => {
      if (!ev.midis || ev.midis.length === 0) return; // rests are silent
      events.push({
        startBeats: ticksToBeats(ev.startTick),
        durBeats: ev.beats,
        midis: ev.midis,
      });
    });
  };
  add(state.trebleSeq);
  add(state.bassSeq);
  events.sort((a, b) => a.startBeats - b.startBeats);
  return events;
}

async function startPlaybackFromBeginning() {
  // Always restart to keep scroll + audio aligned.
  restartScrollAndExercise(/*preserveStats=*/false);

  if (playback.isPlaying) {
    stopPlayback();
    return;
  }

  const desiredInst = playback.instrumentSelect?.value || playback.instrumentName;
  if (!playback.instrument || playback.instrumentName !== desiredInst) {
    await loadInstrument(desiredInst);
  }

  const inst = playback.instrument;
  if (!inst) return;

  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  const secondsPerBeat = 60 / Math.max(1, state.bpm);
  const baseTime = ctx.currentTime + 0.12;

  // Ensure scroll runs during playback.
  userPaused = false;
  if (toggleRunBtn) toggleRunBtn.textContent = "Pause";
  state.running = true;

  const events = computePlaybackEvents();
  if (!events.length) {
    return;
  }

  // Schedule notes
  playback.activeNodes = [];
  events.forEach((ev) => {
    const when = baseTime + ev.startBeats * secondsPerBeat;
    // slightly shorten for a cleaner articulation
    const durSec = Math.max(0.05, ev.durBeats * secondsPerBeat * 0.92);

    ev.midis.forEach((m) => {
      const nn = midiToSoundfontNoteName(m, state.preferSharps);
      const node = playNoteSafe(inst, nn, when, durSec, 0.75);
      if (node) playback.activeNodes.push(node);
    });
  });

  const last = events[events.length - 1];
  const totalDur = (last.startBeats + last.durBeats) * secondsPerBeat + 0.3;

  playback.isPlaying = true;
  if (playback.playBtn) playback.playBtn.textContent = "Stop";

  playback.stopTimer = setTimeout(() => {
    stopPlayback();
  }, Math.ceil(totalDur * 1000));
}

function ensurePlaybackControlsUI() {
  if (document.getElementById("playback-controls")) return;

  const parent = regenerateBtn?.parentElement || document.body;

  const wrap = document.createElement("div");
  wrap.id = "playback-controls";
  wrap.style.display = "flex";
  wrap.style.gap = "10px";
  wrap.style.alignItems = "center";
  wrap.style.flexWrap = "wrap";

  // Play
  const playBtn = document.createElement("button");
  playBtn.id = "play-btn";
  playBtn.className = "chip";
  playBtn.textContent = "Play";
  playBtn.addEventListener("click", () => {
    startPlaybackFromBeginning().catch((e) => {
      console.error(e);
    });
  });

  // Restart scroll (no audio)
  const restartBtn = document.createElement("button");
  restartBtn.id = "restart-scroll";
  restartBtn.className = "chip";
  restartBtn.textContent = "Restart Scroll";
  restartBtn.addEventListener("click", () => {
    stopPlayback();
    restartScrollAndExercise(/*preserveStats=*/false);
  });

  // Instrument select (includes voice-like option)
  const sel = document.createElement("select");
  sel.id = "instrument-select";
  sel.style.padding = "8px 10px";
  sel.style.borderRadius = "10px";
  sel.style.border = "1px solid rgba(255,255,255,0.12)";
  sel.style.background = "rgba(255,255,255,0.06)";
  sel.style.color = "inherit";

  const options = [
    { label: "Piano (Acoustic)", value: "acoustic_grand_piano" },
    { label: "Choir Aahs (Voice-like)", value: "choir_aahs" },
    { label: "Violin", value: "violin" },
    { label: "Cello", value: "cello" },
    { label: "Flute", value: "flute" },
  ];
  options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  sel.value = playback.instrumentName;
  sel.addEventListener("change", () => {
    // lazy load next time Play is pressed
    playback.instrument = null;
  });

  // Status
  const status = document.createElement("span");
  status.id = "playback-status";
  status.textContent = "Audio: ready";
  status.style.fontSize = "12px";
  status.style.color = "#9ca3af";

  wrap.appendChild(playBtn);
  wrap.appendChild(restartBtn);
  wrap.appendChild(sel);
  wrap.appendChild(status);

  // Insert near regenerate button
  parent.insertBefore(wrap, regenerateBtn);

  playback.playBtn = playBtn;
  playback.restartBtn = restartBtn;
  playback.instrumentSelect = sel;
  playback.statusEl = status;
}

/* ------------------------- UI init ------------------------- */

function initKeySelect() {
  Object.keys(KEY_INFO).forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    keySelect.appendChild(opt);
  });
  keySelect.value = state.key;
}

/* ------------------------- Vex / scoring / generation ------------------------- */

function buildScale(key) {
  const rootName = key.replace("b", "b").replace("#", "#");
  const preferSharps = KEY_INFO[key].accidentals > 0;
  const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  const rootIndex = names.findIndex((n) => n === rootName);
  const pcs = new Set(MAJOR_SCALE.map((step) => (rootIndex + step + 12) % 12));
  return { pcs, preferSharps };
}

function pickPitch(prev, range, scale, spice = 0.2) {
  const [low, high] = range;
  const stepChoices = [-4, -3, -2, -1, 1, 2, 3, 4];
  const leapChoices = [-7, -5, 5, 7, 9];
  let candidate = prev;

  const useLeap = Math.random() < spice;
  const pool = useLeap ? leapChoices : stepChoices;
  candidate += pool[Math.floor(Math.random() * pool.length)];
  if (candidate < low || candidate > high) candidate = prev;

  let tries = 0;
  while (!scale.pcs.has(candidate % 12) && tries < 12) {
    candidate += Math.sign(Math.random() - 0.5) || 1;
    if (candidate < low) candidate = low;
    if (candidate > high) candidate = high;
    tries++;
  }
  return Math.min(Math.max(candidate, low), high);
}

function pickChord(prev, range, scale, spice, chordSize) {
  const root = pickPitch(prev, range, scale, spice);
  const notes = [root];
  const intervals = [3, 4, 7, 10, 12];

  for (let i = 1; i < chordSize; i++) {
    const intv = intervals[Math.floor(Math.random() * intervals.length)];
    let n = root + (Math.random() < 0.5 ? -intv : intv);
    n = Math.min(Math.max(n, range[0]), range[1]);

    let tries = 0;
    while (!scale.pcs.has(n % 12) && tries++ < 24) {
      n += Math.sign(root - n) || 1;
      if (n < range[0]) n = range[0];
      if (n > range[1]) n = range[1];
    }
    notes.push(n);
  }

  const midis = [...new Set(notes)].sort((a, b) => a - b);
  return { midis, nextPrev: root };
}

function chooseChordSize(maxPoly, difficulty) {
  const maxHandPoly = Math.min(maxPoly, difficulty === "hard" ? 4 : 3);
  if (maxHandPoly <= 1) return 1;

  const r = Math.random();
  if (difficulty === "easy") return r < 0.15 ? 2 : 1;
  if (difficulty === "medium") {
    if (r < 0.25) return 2;
    if (r < 0.32) return Math.min(3, maxHandPoly);
    return 1;
  }
  if (r < 0.30) return 2;
  if (r < 0.48) return Math.min(3, maxHandPoly);
  if (r < 0.56) return Math.min(4, maxHandPoly);
  return 1;
}

const TICK = 0.25; // beats per tick
const DUR_TICKS = [16, 12, 8, 6, 4, 3, 2, 1];

function beatsToTicks(beats) {
  return Math.max(1, Math.round(beats / TICK));
}
function ticksToBeats(ticks) {
  return ticks * TICK;
}

function durationPoolsForDifficultyTicks(difficulty) {
  if (difficulty === "hard") {
    return {
      treble: [8, 6, 4, 3, 2, 1],
      bass: [12, 8, 6, 4, 3, 2, 1],
      spice: 0.45,
      restChanceTreble: 0.06,
      restChanceBass: 0.10,
    };
  }
  if (difficulty === "medium") {
    return {
      treble: [8, 6, 4, 3, 2],
      bass: [12, 8, 6, 4, 3, 2],
      spice: 0.30,
      restChanceTreble: 0.05,
      restChanceBass: 0.08,
    };
  }
  return {
    treble: [8, 6, 4, 2],
    bass: [12, 8, 6, 4, 2],
    spice: 0.18,
    restChanceTreble: 0.04,
    restChanceBass: 0.06,
  };
}

function fillMeasureTicks(measureTicks, poolTicks) {
  const pool = [...new Set(poolTicks)].filter((t) => t > 0).sort((a, b) => a - b);
  const memo = new Map();

  function canFill(rem) {
    if (rem === 0) return true;
    if (rem < 0) return false;
    if (memo.has(rem)) return memo.get(rem);
    const ok = pool.some((t) => t <= rem && canFill(rem - t));
    memo.set(rem, ok);
    return ok;
  }

  if (!canFill(measureTicks)) return fillMeasureTicks(measureTicks, DUR_TICKS);

  const out = [];
  let rem = measureTicks;
  let guard = 0;

  while (rem > 0 && guard++ < 512) {
    const options = pool.filter((t) => t <= rem && canFill(rem - t));
    const pick = options[Math.floor(Math.random() * options.length)];
    out.push(pick);
    rem -= pick;
  }
  return out;
}

function ticksToDuration(ticks) {
  switch (ticks) {
    case 16: return { dur: "w", dots: 0 };
    case 12: return { dur: "h", dots: 1 };
    case 8:  return { dur: "h", dots: 0 };
    case 6:  return { dur: "q", dots: 1 };
    case 4:  return { dur: "q", dots: 0 };
    case 3:  return { dur: "8", dots: 1 };
    case 2:  return { dur: "8", dots: 0 };
    case 1:  return { dur: "16", dots: 0 };
    default: return null;
  }
}

function upsertTarget(targetsByTick, startTick, leadInBeats) {
  let t = targetsByTick.get(startTick);
  if (!t) {
    const id = `g-${startTick}`;
    t = {
      id,
      startTick,
      offsetBeats: ticksToBeats(startTick) + leadInBeats,
      midis: [],
      hits: new Set(),
      mistakeFlag: false,
      waiting: false,
      completed: false,
    };
    targetsByTick.set(startTick, t);
  }
  return t;
}

function addMidisToTarget(target, midis) {
  target.midis = [...new Set([...target.midis, ...midis])].sort((a, b) => a - b);
}

// ===================== MUSICAL RULE-BASED GENERATOR (ADD THIS BLOCK) =====================

function harmonyIntentFromMaxPoly(maxPoly) {
  // maxPoly=1 => 0 (mostly single notes)
  // maxPoly=7 => 1 (much thicker texture)
  return clamp((maxPoly - 1) / 6, 0, 1);
}

function chooseHandNoteCount(maxHandNotes, intent, difficulty, strongOrMedium) {
  if (maxHandNotes <= 1) return 1;

  const diffBoost =
    difficulty === "hard" ? 0.15 :
    difficulty === "medium" ? 0.08 : 0.0;

  const base = strongOrMedium ? 0.35 : 0.18;
  const pChord = clamp(base + diffBoost + 0.55 * intent, 0, 0.92);

  if (Math.random() > pChord) return 1;

  // Choose 2..maxHandNotes with more weight on larger chords when intent is high
  const alpha = 0.35 + 1.6 * intent; // 0.35..1.95
  const weights = [];
  for (let k = 2; k <= maxHandNotes; k++) {
    weights.push({ w: Math.exp(alpha * (k - 2)), v: k });
  }
  return weightedChoice(weights);
}

function enrichWithChordTones({ baseNotes, chordPcs, prevVoicing, range, maxHandNotes, wantCount }) {
  if (!baseNotes.length) return [];

  const want = clamp(wantCount, 1, maxHandNotes);
  if (want <= baseNotes.length) return finalizeHandNotes(baseNotes, range, maxHandNotes, MAX_HAND_SPAN_SEMITONES);

  const chordNotes = voiceChordForHand({
    chordPcs,
    prevVoicing: prevVoicing?.length ? prevVoicing : baseNotes,
    range,
    maxNotes: want,
    preferClosed: true,
  });

  const merged = [...chordNotes, ...baseNotes];
  return finalizeHandNotes(merged, range, maxHandNotes, MAX_HAND_SPAN_SEMITONES);
}


// --- constraints ---
const MAX_HAND_NOTES = 5;            // <= 5 notes in one hand
const MAX_HAND_SPAN_SEMITONES = 14;  // <= 9th (14 semitones)

// Ranges (tweak if you want)
const TREBLE_RANGE = [60, 88]; // C4..E6
const BASS_RANGE   = [36, 64]; // C2..E4 (a bit higher to allow 9th spans safely)

// --- helpers ---
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function weightedChoice(items) {
  // items: [{w:number, v:any}, ...]
  const sum = items.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * sum;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

function parseTimeSig(ts) {
  const [n, d] = ts.split("/").map(Number);
  const beatsPerMeasure = n * (4 / d);
  return { n, d, beatsPerMeasure };
}

function tonicPcFromKey(key) {
  const preferSharps = (KEY_INFO[key]?.accidentals || 0) > 0;
  const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  const idx = names.indexOf(key);
  // fallback for "C" etc if weird
  return idx >= 0 ? idx : NOTE_NAMES_SHARP.indexOf(key);
}

function scalePcsForKey(key) {
  const tonicPc = tonicPcFromKey(key);
  return MAJOR_SCALE.map((step) => (tonicPc + step) % 12); // degree 1..7 in order
}

function chordPcsForDegree(deg, scalePcs, seventh = false) {
  // deg: 1..7
  const i = (deg - 1) % 7;
  const pcs = [
    scalePcs[i],
    scalePcs[(i + 2) % 7],
    scalePcs[(i + 4) % 7],
  ];
  if (seventh) pcs.push(scalePcs[(i + 6) % 7]);
  return pcs;
}

function nearestMidiWithPc(targetMidi, pc) {
  // pc in [0..11]
  return pc + 12 * Math.round((targetMidi - pc) / 12);
}

function clampMidiToRange(m, range) {
  let x = m;
  while (x < range[0]) x += 12;
  while (x > range[1]) x -= 12;
  return clamp(x, range[0], range[1]);
}

function reduceSpanByOctaves(notes, range, maxSpan) {
  // try octave folding before dropping notes
  let n = notes.slice().sort((a, b) => a - b);
  let guard = 0;
  while (n.length >= 2 && (n[n.length - 1] - n[0]) > maxSpan && guard++ < 32) {
    const low = n[0], high = n[n.length - 1];
    // try pulling high down
    if (high - 12 >= low && high - 12 >= range[0]) {
      n[n.length - 1] = high - 12;
      n.sort((a, b) => a - b);
      continue;
    }
    // try pushing low up
    if (low + 12 <= high && low + 12 <= range[1]) {
      n[0] = low + 12;
      n.sort((a, b) => a - b);
      continue;
    }
    break;
  }
  return n;
}

function finalizeHandNotes(midis, range, maxNotes, maxSpan) {
  let notes = [...new Set(midis)].map((m) => clampMidiToRange(m, range)).sort((a, b) => a - b);

  // cap count
  while (notes.length > maxNotes) {
    // drop farthest from center
    const center = (notes[0] + notes[notes.length - 1]) / 2;
    const d0 = Math.abs(notes[0] - center);
    const d1 = Math.abs(notes[notes.length - 1] - center);
    if (d1 >= d0) notes.pop();
    else notes.shift();
  }

  // reduce span by octaves, then drop if still too wide
  notes = reduceSpanByOctaves(notes, range, maxSpan);
  while (notes.length >= 2 && (notes[notes.length - 1] - notes[0]) > maxSpan) {
    // drop farthest from center
    const center = (notes[0] + notes[notes.length - 1]) / 2;
    const d0 = Math.abs(notes[0] - center);
    const d1 = Math.abs(notes[notes.length - 1] - center);
    if (d1 >= d0) notes.pop();
    else notes.shift();
  }

  return notes;
}

function nearestMidiInPcs(targetMidi, pcs, range) {
  let best = null;
  let bestDist = 1e9;
  for (const pc of pcs) {
    let m = nearestMidiWithPc(targetMidi, pc);
    m = clampMidiToRange(m, range);
    const dist = Math.abs(m - targetMidi);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
    // also check +/- octave variants (sometimes clamp pushes too far)
    for (const off of [-12, 12]) {
      const mm = clampMidiToRange(m + off, range);
      const dd = Math.abs(mm - targetMidi);
      if (dd < bestDist) {
        bestDist = dd;
        best = mm;
      }
    }
  }
  return best ?? clampMidiToRange(targetMidi, range);
}

function isStrongOffsetTicks(offsetTicks, measureTicks, timeSig) {
  // simple musical accent grid by common meters
  if (timeSig === "4/4") return offsetTicks === 0 || offsetTicks === 8;
  if (timeSig === "3/4") return offsetTicks === 0;
  if (timeSig === "6/8") return offsetTicks === 0 || offsetTicks === 6;
  // fallback: start of measure is strong
  return offsetTicks === 0;
}

function isMediumOffsetTicks(offsetTicks, measureTicks, timeSig) {
  if (timeSig === "4/4") return offsetTicks === 4 || offsetTicks === 12;
  if (timeSig === "3/4") return offsetTicks === 4 || offsetTicks === 8;
  if (timeSig === "6/8") return offsetTicks === 3 || offsetTicks === 9;
  return false;
}

// --- rhythm templates (tick sums must match measureTicks) ---
function rhythmPatternsFor(timeSig, hand, difficulty) {
  // NOTE: tick grid uses 1=16th, 2=8th, 3=dotted 8th, 4=quarter, 6=dotted quarter, 8=half, 12=dotted half, 16=whole
  const D = difficulty;

  const COMMON_44_T = [
    [4,4,4,4],
    [8,4,4],
    [4,4,8],
    [2,2,2,2,4,4],
    [4,2,2,4,4],
    [3,1,4,4,4],
    [2,2,2,2,2,2,2,2],
    [1,1,2,4,4,4], // 16th pickup burst
  ];
  const COMMON_34_T = [
    [4,4,4],
    [6,6],
    [4,2,2,4],
    [2,2,2,2,2,2],
    [3,1,4,4],
  ];
  const COMMON_68_T = [
    [2,2,2,2,2,2], // eighths
    [3,3,3,3],     // dotted eighths
    [6,6],         // dotted quarters
  ];

  let base = [];
  if (timeSig === "4/4") base = COMMON_44_T;
  else if (timeSig === "3/4") base = COMMON_34_T;
  else if (timeSig === "6/8") base = COMMON_68_T;
  else base = COMMON_44_T;

  // Hand flavor: bass generally simpler / longer, treble more active on harder
  if (hand === "bass") {
    const bassBias = [];
    base.forEach((p) => {
      // keep simpler patterns more often
      const w =
        (p.length <= 3 ? 4 : 1) *
        (D === "easy" ? 2 : D === "medium" ? 1.5 : 1.0);
      bassBias.push({ w, v: p });
    });
    return bassBias;
  }

  // treble
  const trebleBias = [];
  base.forEach((p) => {
    const has16th = p.includes(1);
    const w =
      (D === "easy" ? (p.length <= 4 && !has16th ? 3 : 1) :
       D === "medium" ? (p.length <= 6 ? 2 : 1) :
       (has16th ? 2.5 : 1.5));
    trebleBias.push({ w, v: p });
  });
  return trebleBias;
}

function pickRhythmPatternExact(measureTicks, timeSig, hand, difficulty) {
  const patterns = rhythmPatternsFor(timeSig, hand, difficulty);
  // choose a pattern whose sum == measureTicks
  const candidates = patterns.filter((x) => x.v.reduce((s, t) => s + t, 0) === measureTicks);
  if (candidates.length) return weightedChoice(candidates);

  // fallback to your DP filler if templates don't match
  const pool = difficulty === "hard" ? [8,6,4,3,2,1] : difficulty === "medium" ? [8,6,4,3,2] : [8,6,4,2];
  return fillMeasureTicks(measureTicks, pool);
}

// --- harmony templates (degrees in major key) ---
const PROG_TEMPLATES_4 = [
  { w: 4, v: [1, 5, 6, 4] }, // pop
  { w: 3, v: [1, 6, 4, 5] }, // pop variant
  { w: 3, v: [1, 4, 5, 1] }, // classical cadence
  { w: 2, v: [6, 4, 1, 5] }, // minor-feel start
  { w: 2, v: [1, 2, 5, 1] }, // ii–V–I
  { w: 2, v: [1, 3, 6, 2] }, // circle-ish (resolves next phrase)
];

const CADENCE_ENDINGS = [
  { w: 5, v: [2, 5, 1, 1] },
  { w: 4, v: [4, 5, 1, 1] },
  { w: 3, v: [6, 2, 5, 1] },
];

// Build a degree plan of length >= measuresNeeded.
// It creates phrase chunks (4 bars) with a cadence-y ending.
function buildDegreePlan(measuresNeeded) {
  const degrees = [];
  while (degrees.length < measuresNeeded) {
    const remaining = measuresNeeded - degrees.length;
    const chunk = remaining >= 4 ? 4 : remaining;

    if (chunk < 4) {
      // pad with a simple ending
      for (let i = 0; i < chunk; i++) degrees.push(1);
      break;
    }

    // choose either a normal 4-bar template or a cadence ending template
    const useCadence = degrees.length > 0 && Math.random() < 0.45;
    const base = useCadence ? weightedChoice(CADENCE_ENDINGS) : weightedChoice(PROG_TEMPLATES_4);

    degrees.push(...base);
  }
  return degrees;
}

// Build 1–2 harmony slots inside a measure for extra musical motion.
function harmonySlotsForMeasure(measureTicks, degreeThis, degreeNext, difficulty) {
  const slots = [{ tick: 0, deg: degreeThis, seventh: false }];

  // Add a mid-measure passing harmony more often on medium/hard
  const allowTwo = difficulty !== "easy" && Math.random() < (difficulty === "hard" ? 0.55 : 0.35);
  if (allowTwo) {
    const mid = Math.floor(measureTicks / 2); // 8 in 4/4, 6 in 3/4 or 6/8
    // passing choices: ii or V toward the next, or IV as a plagal motion
    const passDeg = weightedChoice([
      { w: 4, v: 5 }, // dominant
      { w: 3, v: 2 }, // predominant
      { w: 2, v: 4 }, // subdominant
      { w: 1, v: degreeNext || 5 },
    ]);
    slots.push({
      tick: mid,
      deg: passDeg,
      seventh: passDeg === 5 && Math.random() < 0.65,
    });
  }

  // mark V as 7th sometimes for color
  if (degreeThis === 5 && difficulty !== "easy" && Math.random() < 0.45) {
    slots[0].seventh = true;
  }
  return slots.sort((a, b) => a.tick - b.tick);
}

function chordForOffset(offsetTicks, slots, scalePcs) {
  let chosen = slots[0];
  for (const s of slots) {
    if (s.tick <= offsetTicks) chosen = s;
  }
  return chordPcsForDegree(chosen.deg, scalePcs, chosen.seventh);
}

// --- melodic rules ---
function chooseMelodyMidi({
  prevMidi,
  chordPcs,
  scalePcs,
  range,
  strong,
  medium,
  difficulty,
  contourBias, // -1 down, 0 neutral, +1 up
}) {
  const targetBase =
    prevMidi == null ? Math.round((range[0] + range[1]) / 2) : prevMidi;

  // prefer stepwise motion; allow occasional leaps that resolve
  const stepWeights = difficulty === "easy"
    ? [{ w: 8, v: 1 }, { w: 8, v: 2 }, { w: 2, v: 3 }, { w: 1, v: 5 }]
    : difficulty === "medium"
    ? [{ w: 7, v: 1 }, { w: 7, v: 2 }, { w: 3, v: 3 }, { w: 2, v: 5 }, { w: 1, v: 7 }]
    : [{ w: 6, v: 1 }, { w: 6, v: 2 }, { w: 4, v: 3 }, { w: 3, v: 5 }, { w: 2, v: 7 }];

  const step = weightedChoice(stepWeights);
  const dir =
    contourBias === 0
      ? weightedChoice([{ w: 1, v: -1 }, { w: 1, v: 1 }])
      : (Math.random() < 0.7 ? contourBias : -contourBias);

  let target = targetBase + dir * step;

  // strong beats should land on chord tones more often
  const pcs = strong ? chordPcs : (medium ? (Math.random() < 0.6 ? chordPcs : scalePcs) : scalePcs);

  const m = nearestMidiInPcs(target, pcs, range);
  return clampMidiToRange(m, range);
}

// --- voicing rules ---
function voiceChordForHand({
  chordPcs,
  prevVoicing,
  range,
  maxNotes,
  preferClosed = true,
}) {
  const center = prevVoicing?.length
    ? Math.round(prevVoicing.reduce((s, x) => s + x, 0) / prevVoicing.length)
    : Math.round((range[0] + range[1]) / 2);

  const desiredCount = clamp(maxNotes, 1, MAX_HAND_NOTES);

  // pick a subset of chord pcs (favor 3rd/7th for color in dense chords)
  const pcsOrder = chordPcs.slice();
  const pcsPicked = shuffle(pcsOrder).slice(0, clamp(desiredCount, 1, pcsOrder.length));

  // initial placement near center
  let notes = pcsPicked.map((pc) => clampMidiToRange(nearestMidiWithPc(center, pc), range));

  // if we want more notes than unique pcs (e.g. triad but asked 4),
  // double root or fifth (still within span constraints)
  while (notes.length < desiredCount) {
    const pc = choice([chordPcs[0], chordPcs[2] ?? chordPcs[0]]);
    notes.push(clampMidiToRange(nearestMidiWithPc(center + (preferClosed ? 4 : 8), pc), range));
  }

  notes = finalizeHandNotes(notes, range, MAX_HAND_NOTES, MAX_HAND_SPAN_SEMITONES);

  // if we ended up with 0 (extreme ranges), fallback to one safe note
  if (!notes.length) {
    notes = [clampMidiToRange(nearestMidiWithPc(center, chordPcs[0]), range)];
  }

  // cap to requested maxNotes (and also slider)
  const hardCap = Math.min(MAX_HAND_NOTES, maxNotes);
  while (notes.length > hardCap) notes.pop();

  return notes;
}

// --- hand-style per measure ---
function pickTrebleStyle(difficulty, intent) {
  // As intent increases, favor chordal textures more often.
  const chordBias = intent; // 0..1
  return weightedChoice([
    { w: (difficulty === "easy" ? 7 : 4) * (1.0 - 0.55 * chordBias), v: "melody" },
    { w: (difficulty === "easy" ? 2 : 3) * (1.0 + 0.90 * chordBias), v: "melody+dyads" },
    { w: (difficulty === "easy" ? 1 : 3) * (1.0 + 0.50 * chordBias), v: "arpeggio" },
    { w: (difficulty === "hard" ? 2 : 0.8) * (0.6 + 2.0 * chordBias), v: "melody+chords" },
  ]);
}

function pickBassStyle(difficulty, intent) {
  const chordBias = intent;
  return weightedChoice([
    { w: (difficulty === "easy" ? 6 : 3) * (1.0 - 0.35 * chordBias), v: "root" },
    { w: (difficulty === "easy" ? 2 : 3) * (1.0 + 0.40 * chordBias), v: "octaves" },
    { w: (difficulty === "easy" ? 2 : 3) * (1.0 + 0.75 * chordBias), v: "broken" },
    { w: (difficulty === "hard" ? 2 : 1) * (1.0 + 0.35 * chordBias), v: "walking" },
  ]);
}

function bassMidiForRole(chordPcs, prevMidi, range, roleIndex) {
  // roleIndex cycles through [root, fifth, third, root] for motion
  const pcRoot = chordPcs[0];
  const pcThird = chordPcs[1] ?? chordPcs[0];
  const pcFifth = chordPcs[2] ?? chordPcs[0];
  const rolePc = [pcRoot, pcFifth, pcThird, pcRoot][roleIndex % 4];

  const target = prevMidi == null ? Math.round((range[0] + range[1]) / 2) : prevMidi;
  const m = clampMidiToRange(nearestMidiWithPc(target, rolePc), range);
  return m;
}

// ===================== MUSICAL RULE-BASED GENERATOR (REPLACE generatePiece WITH THIS) =====================

function generatePiece(targetCount, { key, maxPoly, difficulty }) {
  const { beatsPerMeasure } = parseTimeSig(state.timeSig);
  const measureTicks = beatsToTicks(beatsPerMeasure);

  const scalePcs = scalePcsForKey(key);

  // HARD CAP per hand is still 5
  const maxHandNotes = clamp(Math.min(MAX_HAND_NOTES, maxPoly), 1, MAX_HAND_NOTES);

  // If slider is > 5, treat the extra as "more harmony intent" (still capped at 5 notes/hand)
  const intent = harmonyIntentFromMaxPoly(maxPoly);

  const trebleSeq = [];
  const bassSeq = [];
  const targetsByTick = new Map();

  const leadInBeats = (layout.leadInPx - layout.playheadX) / pxPerBeat;

  let treblePrev = 72;
  let bassPrev = 48;
  let treblePrevChord = [];
  let bassPrevChord = [];
  let contour = weightedChoice([{ w: 1, v: -1 }, { w: 2, v: 0 }, { w: 1, v: 1 }]);

  let measuresPlanned = 8;
  let degreePlan = buildDegreePlan(measuresPlanned);

  const ensurePlan = (needMeasures) => {
    while (degreePlan.length < needMeasures) {
      degreePlan.push(...buildDegreePlan(8));
    }
  };

  let globalTick = 0;
  let measureIndex = 0;

  while (targetsByTick.size < targetCount) {
    ensurePlan(measureIndex + 8);

    const degThis = degreePlan[measureIndex] ?? 1;
    const degNext = degreePlan[measureIndex + 1] ?? 1;

    const slots = harmonySlotsForMeasure(measureTicks, degThis, degNext, difficulty);

    const treblePattern = pickRhythmPatternExact(measureTicks, state.timeSig, "treble", difficulty);
    const bassPattern   = pickRhythmPatternExact(measureTicks, state.timeSig, "bass", difficulty);

    const trebleStyle = pickTrebleStyle(difficulty, intent);
    const bassStyle   = pickBassStyle(difficulty, intent);

    if (measureIndex % 4 === 3 && Math.random() < 0.6) contour = -contour || -1;

    // ---------- TREBLE ----------
    {
      let tickInMeasure = 0;
      let arpIndex = 0;

      for (let i = 0; i < treblePattern.length; i++) {
        const ticks = treblePattern[i];
        const startTick = globalTick + tickInMeasure;
        const beats = ticksToBeats(ticks);

        const offset = tickInMeasure;
        const strong = isStrongOffsetTicks(offset, measureTicks, state.timeSig);
        const medium = isMediumOffsetTicks(offset, measureTicks, state.timeSig);
        const strongOrMedium = strong || medium;

        const chordPcs = chordForOffset(offset, slots, scalePcs);

        const restChance =
          (difficulty === "easy" ? 0.04 :
           difficulty === "medium" ? 0.06 : 0.10);

        let midis = [];

        if (Math.random() < restChance && !strong) {
          midis = [];
        } else if (trebleStyle === "arpeggio") {
          const pc = chordPcs[(arpIndex++) % chordPcs.length];
          const target = treblePrev + (contour === 0 ? 0 : contour * (Math.random() < 0.7 ? 1 : 2));
          const m = clampMidiToRange(nearestMidiWithPc(target, pc), TREBLE_RANGE);
          treblePrev = m;

          // If user allows more harmony, occasionally turn arpeggio hits into dyads/triads
          const want = chooseHandNoteCount(maxHandNotes, intent, difficulty, strongOrMedium);
          midis = enrichWithChordTones({
            baseNotes: [m],
            chordPcs,
            prevVoicing: treblePrevChord.length ? treblePrevChord : [m],
            range: TREBLE_RANGE,
            maxHandNotes,
            wantCount: want,
          });
          treblePrevChord = midis.length > 1 ? midis.slice() : treblePrevChord;
        } else {
          // melody note
          const m = chooseMelodyMidi({
            prevMidi: treblePrev,
            chordPcs,
            scalePcs,
            range: TREBLE_RANGE,
            strong,
            medium,
            difficulty,
            contourBias: contour,
          });
          treblePrev = m;

          // Decide how thick this onset should be (scales with maxPoly intent)
          const want = chooseHandNoteCount(maxHandNotes, intent, difficulty, strongOrMedium);

          if (trebleStyle === "melody+chords") {
            // chordal texture more often when intent is high
            const boostedWant = Math.max(2, want);
            midis = enrichWithChordTones({
              baseNotes: [m],
              chordPcs,
              prevVoicing: treblePrevChord.length ? treblePrevChord : [m],
              range: TREBLE_RANGE,
              maxHandNotes,
              wantCount: boostedWant,
            });
            treblePrevChord = midis.slice();
          } else if (trebleStyle === "melody+dyads") {
            // at least 2 when possible
            const boostedWant = Math.max(2, Math.min(3, want));
            midis = enrichWithChordTones({
              baseNotes: [m],
              chordPcs,
              prevVoicing: treblePrevChord.length ? treblePrevChord : [m],
              range: TREBLE_RANGE,
              maxHandNotes,
              wantCount: boostedWant,
            });
            treblePrevChord = midis.length > 1 ? midis.slice() : treblePrevChord;
          } else {
            // even in "melody" style, allow thicker harmony as intent increases (but not always)
            midis = enrichWithChordTones({
              baseNotes: [m],
              chordPcs,
              prevVoicing: treblePrevChord.length ? treblePrevChord : [m],
              range: TREBLE_RANGE,
              maxHandNotes,
              wantCount: want,
            });
            treblePrevChord = midis.length > 1 ? midis.slice() : treblePrevChord;
          }
        }

        trebleSeq.push({
          id: `g-${startTick}`,
          startTick,
          offsetBeats: ticksToBeats(startTick) + leadInBeats,
          offsetPx: layout.leadInPx + ticksToBeats(startTick) * pxPerBeat,
          beats,
          midis,
        });

        if (midis.length) {
          let t = targetsByTick.get(startTick);
          if (!t) {
            t = {
              id: `g-${startTick}`,
              startTick,
              offsetBeats: ticksToBeats(startTick) + leadInBeats,
              midis: [],
              hits: new Set(),
              mistakeFlag: false,
              waiting: false,
              completed: false,
            };
            targetsByTick.set(startTick, t);
          }
          t.midis = [...new Set([...t.midis, ...midis])].sort((a, b) => a - b);
        }

        tickInMeasure += ticks;
      }
    }

    // ---------- BASS ----------
    {
      let tickInMeasure = 0;
      let roleIndex = 0;

      for (let i = 0; i < bassPattern.length; i++) {
        const ticks = bassPattern[i];
        const startTick = globalTick + tickInMeasure;
        const beats = ticksToBeats(ticks);

        const offset = tickInMeasure;
        const strong = isStrongOffsetTicks(offset, measureTicks, state.timeSig);
        const medium = isMediumOffsetTicks(offset, measureTicks, state.timeSig);
        const strongOrMedium = strong || medium;

        const chordPcs = chordForOffset(offset, slots, scalePcs);

        const restChance =
          (difficulty === "easy" ? 0.02 :
           difficulty === "medium" ? 0.04 : 0.07);

        let midis = [];

        if (Math.random() < restChance && !strong) {
          midis = [];
        } else if (bassStyle === "walking" && difficulty === "hard") {
          const target = bassPrev + (Math.random() < 0.6 ? (Math.random() < 0.5 ? 1 : -1) : (Math.random() < 0.5 ? 2 : -2));
          const m = nearestMidiInPcs(target, scalePcs, BASS_RANGE);
          bassPrev = m;

          const want = chooseHandNoteCount(Math.min(maxHandNotes, 3), intent, difficulty, strongOrMedium);
          midis = enrichWithChordTones({
            baseNotes: [m],
            chordPcs,
            prevVoicing: bassPrevChord.length ? bassPrevChord : [m],
            range: BASS_RANGE,
            maxHandNotes: Math.min(maxHandNotes, 3), // keep LH denser but still realistic
            wantCount: want,
          });
          bassPrevChord = midis.length > 1 ? midis.slice() : bassPrevChord;
        } else {
          // core bass note
          const role = strong ? 0 : (medium ? 1 : 2);
          const m = bassMidiForRole(chordPcs, bassPrev, BASS_RANGE, roleIndex + role);
          roleIndex++;
          bassPrev = m;

          // decide thickness: allow more dyads/triads when intent is high
          const want = chooseHandNoteCount(Math.min(maxHandNotes, 4), intent, difficulty, strongOrMedium);

          if (bassStyle === "octaves" && strong && want >= 2) {
            const octave = clampMidiToRange(m + 12, BASS_RANGE);
            midis = finalizeHandNotes([m, octave], BASS_RANGE, 2, MAX_HAND_SPAN_SEMITONES);
            // maybe add a third chord tone if intent is high
            if (intent > 0.55 && maxHandNotes >= 3 && Math.random() < 0.35) {
              midis = enrichWithChordTones({
                baseNotes: midis,
                chordPcs,
                prevVoicing: bassPrevChord.length ? bassPrevChord : midis,
                range: BASS_RANGE,
                maxHandNotes: Math.min(maxHandNotes, 3),
                wantCount: 3,
              });
            }
            bassPrevChord = midis.slice();
          } else if (bassStyle === "broken") {
            // broken chord tones, but thicken occasionally
            if (strongOrMedium && want >= 2) {
              midis = enrichWithChordTones({
                baseNotes: [m],
                chordPcs,
                prevVoicing: bassPrevChord.length ? bassPrevChord : [m],
                range: BASS_RANGE,
                maxHandNotes: Math.min(maxHandNotes, 3),
                wantCount: Math.min(3, want),
              });
              bassPrevChord = midis.length > 1 ? midis.slice() : bassPrevChord;
            } else {
              midis = [m];
            }
          } else {
            // root style: add chord tones more often when intent is high
            midis = enrichWithChordTones({
              baseNotes: [m],
              chordPcs,
              prevVoicing: bassPrevChord.length ? bassPrevChord : [m],
              range: BASS_RANGE,
              maxHandNotes: Math.min(maxHandNotes, 3),
              wantCount: Math.min(3, want),
            });
            bassPrevChord = midis.length > 1 ? midis.slice() : bassPrevChord;
          }
        }

        bassSeq.push({
          id: `g-${startTick}`,
          startTick,
          offsetBeats: ticksToBeats(startTick) + leadInBeats,
          offsetPx: layout.leadInPx + ticksToBeats(startTick) * pxPerBeat,
          beats,
          midis,
        });

        if (midis.length) {
          let t = targetsByTick.get(startTick);
          if (!t) {
            t = {
              id: `g-${startTick}`,
              startTick,
              offsetBeats: ticksToBeats(startTick) + leadInBeats,
              midis: [],
              hits: new Set(),
              mistakeFlag: false,
              waiting: false,
              completed: false,
            };
            targetsByTick.set(startTick, t);
          }
          t.midis = [...new Set([...t.midis, ...midis])].sort((a, b) => a - b);
        }

        tickInMeasure += ticks;
      }
    }

    globalTick += measureTicks;
    measureIndex += 1;

    if (measureIndex > 64 && targetsByTick.size >= targetCount) break;
  }

  const targets = [...targetsByTick.values()]
    .sort((a, b) => a.startTick - b.startTick)
    .slice(0, targetCount);

  const lastTick = targets.length ? targets[targets.length - 1].startTick : 0;
  const lastMeasureEnd = (Math.floor(lastTick / measureTicks) + 1) * measureTicks;
  const keepUntil = lastMeasureEnd;

  const tSeq = trebleSeq.filter((e) => e.startTick < keepUntil);
  const bSeq = bassSeq.filter((e) => e.startTick < keepUntil);

  return { trebleSeq: tSeq, bassSeq: bSeq, targets, preferSharps: (KEY_INFO[key]?.accidentals || 0) > 0 };
}

/* ------------------------- VexFlow coloring (setStyle before draw) ------------------------- */

function applyMarkToVfNote(vfNote, id) {
  const mark = state.renderMarks.get(id);
  if (!mark) return;

  const color =
    mark === "mistake"
      ? getThemeColor("--danger", "#e11d48")
      : getThemeColor("--success", "#16a34a");

  const style = { fillStyle: color, strokeStyle: color };

  // VexFlow docs: setStyle sets all noteheads + stem; setKeyStyle colors heads individually. :contentReference[oaicite:7]{index=7}
  if (typeof vfNote.setStyle === "function") vfNote.setStyle(style);
  if (typeof vfNote.setStemStyle === "function") vfNote.setStemStyle(style);
  if (typeof vfNote.setFlagStyle === "function") vfNote.setFlagStyle(style);
  if (typeof vfNote.setKeyStyle === "function" && Array.isArray(vfNote.keys)) {
    for (let i = 0; i < vfNote.keys.length; i++) vfNote.setKeyStyle(i, style);
  }
}

function rerenderPreserveScroll() {
  const prevTransform = scoreEl.style.transform;
  renderStaticClefs(state.key);
  renderSequence(state.trebleSeq, state.bassSeq, state.key);
  scoreEl.style.transform = prevTransform;
}

/* ------------------------- Rendering ------------------------- */

function noteToKeys(midis, preferSharps) {
  return midis.map((m) => {
    const octave = Math.floor(m / 12) - 1;
    const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
    const name = names[m % 12];
    const accidental = name.length > 1 ? name[1] : null;
    const key = `${name[0].toLowerCase()}${accidental ? accidental.toLowerCase() : ""}/${octave}`;
    return { key, accidental };
  });
}

function splitTicks(remTicks) {
  const out = [];
  let r = remTicks;
  for (const t of DUR_TICKS) {
    while (r >= t) {
      out.push(t);
      r -= t;
    }
  }
  return out;
}

function attachDotsForDisplay(note, dots) {
  if (!dots) return;
  if (VF.Dot?.buildAndAttach) {
    for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([note]);
  } else if (VF.Dot) {
    for (let i = 0; i < dots; i++) note.addModifier(new VF.Dot(), 0);
  }
}

function makeStaveNote({ clef, keys, dur, dots, stem_direction, isRest }) {
  const base = { clef, keys, duration: dur, dots: dots || 0, stem_direction };
  let n = null;

  if (isRest) {
    try {
      n = new VF.StaveNote({ ...base, type: "r" });
    } catch {
      n = new VF.StaveNote({ ...base, duration: `${dur}r` });
    }
  } else {
    n = new VF.StaveNote(base);
  }

  attachDotsForDisplay(n, dots || 0);
  return n;
}

function renderSequence(trebleSeq, bassSeq, key) {
  if (!VF) return;
  scoreEl.innerHTML = "";

  const [num, den] = state.timeSig.split("/").map(Number);
  const beatsPerMeasure = num * (4 / den);
  const measureTicks = beatsToTicks(beatsPerMeasure);

  const beamGroups = VF?.Beam?.getDefaultBeamGroups
    ? VF.Beam.getDefaultBeamGroups(state.timeSig)
    : null;

  const STEM_UP = VF.Stem?.UP ?? 1;
  const STEM_DOWN = VF.Stem?.DOWN ?? -1;

  const allSeq = [...trebleSeq, ...bassSeq];
  const maxStartTick = allSeq.reduce((acc, ev) => Math.max(acc, ev.startTick), 0);
  const measureCount = Math.floor(maxStartTick / measureTicks) + 1;

  const measureWidth = Math.max(200, Math.ceil(beatsPerMeasure * pxPerBeat) + 40);
  const minWidth = scoreWrapper?.clientWidth || 800;
  const totalWidth = layout.leadInPx + (measureCount + 1) * measureWidth;

  scoreEl.style.width = `${Math.max(totalWidth, minWidth)}px`;
  scoreEl.style.height = "100%";

  const trebleByMeasure = Array.from({ length: measureCount }, () => []);
  const bassByMeasure = Array.from({ length: measureCount }, () => []);

  trebleSeq.forEach((ev) => trebleByMeasure[Math.floor(ev.startTick / measureTicks)]?.push(ev));
  bassSeq.forEach((ev) => bassByMeasure[Math.floor(ev.startTick / measureTicks)]?.push(ev));

  for (let i = 0; i < measureCount; i++) {
    trebleByMeasure[i].sort((a, b) => a.startTick - b.startTick);
    bassByMeasure[i].sort((a, b) => a.startTick - b.startTick);
  }

  for (let m = 0; m < measureCount; m++) {
    const group = document.createElement("div");
    group.style.position = "absolute";
    group.style.left = "0px";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const width = measureWidth;
    const height = 260;
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);

    group.appendChild(svg);
    scoreEl.appendChild(group);

    const renderer = new VF.Renderer(svg, VF.Renderer.Backends.SVG);
    renderer.resize(width, height);
    const ctx = renderer.getContext();
    ctx.setFont("Inter", 12, "");

    const treble = new VF.Stave(0, 24, width);
    const bass = new VF.Stave(0, 130, width);

    const barNone = VF.Barline?.type?.NONE ?? VF.Barline.type.NONE;
    const barSingle = VF.Barline?.type?.SINGLE ?? VF.Barline.type.SINGLE;

    treble.setBegBarType(barSingle);
    treble.setEndBarType(barNone);
    bass.setBegBarType(barSingle);
    bass.setEndBarType(barNone);

    treble.setContext(ctx).draw();
    bass.setContext(ctx).draw();

        // Align beat 0 (first tick context) to the playhead by compensating for VexFlow's internal noteStartX.
    // This fixes the “note is not on the line when it should be” drift.
    const noteStartX = typeof treble.getNoteStartX === "function" ? treble.getNoteStartX() : 0;
    group.style.left = `${layout.leadInPx + m * measureWidth - noteStartX}px`;

    const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt.setAttribute("x", "4");
    txt.setAttribute("y", "14");
    txt.setAttribute("fill", "#9ca3af");
    txt.setAttribute("font-size", "11");
    txt.textContent = `M${m + 1}`;
    svg.appendChild(txt);

    const keySig = state.keySig;

    function ensureMeasureFill(arr, restIdPrefix) {
      let sumTicks = 0;
      for (const ev of arr) sumTicks += beatsToTicks(ev.beats);
      if (sumTicks >= measureTicks) return;

      const extra = splitTicks(measureTicks - sumTicks);
      let cursorTick = m * measureTicks + sumTicks;
      for (const t of extra) {
        arr.push({
          id: `${restIdPrefix}-${m}-${Math.random().toString(16).slice(2)}`,
          startTick: cursorTick,
          beats: ticksToBeats(t),
          midis: [],
        });
        cursorTick += t;
      }
      arr.sort((a, b) => a.startTick - b.startTick);
    }

    ensureMeasureFill(trebleByMeasure[m], "fill-t");
    ensureMeasureFill(bassByMeasure[m], "fill-b");

    const trebleNotes = [];
    const bassNotes = [];

    trebleByMeasure[m].forEach((ev) => {
      const ticks = beatsToTicks(ev.beats);
      const dur = ticksToDuration(ticks);
      if (!dur) return;

      const keys = noteToKeys(ev.midis, state.preferSharps);
      const note = keys.length
        ? makeStaveNote({
            clef: "treble",
            keys: keys.map((k) => k.key),
            dur: dur.dur,
            dots: dur.dots,
            stem_direction: STEM_UP,
            isRest: false,
          })
        : makeStaveNote({
            clef: "treble",
            keys: ["b/4"],
            dur: dur.dur,
            dots: dur.dots,
            stem_direction: STEM_UP,
            isRest: true,
          });

      applyMarkToVfNote(note, ev.id);

      keys.forEach((k, idx) => {
        const letter = k.key[0].toUpperCase();
        if (k.accidental && keySig.get(letter) !== k.accidental) {
          note.addModifier(new VF.Accidental(k.accidental), idx);
        }
      });

      trebleNotes.push({ note, ev });
    });

    bassByMeasure[m].forEach((ev) => {
      const ticks = beatsToTicks(ev.beats);
      const dur = ticksToDuration(ticks);
      if (!dur) return;

      const keys = noteToKeys(ev.midis, state.preferSharps);
      const note = keys.length
        ? makeStaveNote({
            clef: "bass",
            keys: keys.map((k) => k.key),
            dur: dur.dur,
            dots: dur.dots,
            stem_direction: STEM_DOWN,
            isRest: false,
          })
        : makeStaveNote({
            clef: "bass",
            keys: ["d/3"],
            dur: dur.dur,
            dots: dur.dots,
            stem_direction: STEM_DOWN,
            isRest: true,
          });

      applyMarkToVfNote(note, ev.id);

      keys.forEach((k, idx) => {
        const letter = k.key[0].toUpperCase();
        if (k.accidental && keySig.get(letter) !== k.accidental) {
          note.addModifier(new VF.Accidental(k.accidental), idx);
        }
      });

      bassNotes.push({ note, ev });
    });

    const trebleVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(true);
    trebleVoice.addTickables(trebleNotes.map((n) => n.note));
    const bassVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(true);
    bassVoice.addTickables(bassNotes.map((n) => n.note));

    const formatter = new VF.Formatter();
    formatter.joinVoices([trebleVoice]);
    formatter.joinVoices([bassVoice]);
    formatter.format([trebleVoice, bassVoice], width - 40);

    let trebleBeams = [];
    let bassBeams = [];
    if (VF.Beam?.generateBeams) {
      trebleBeams = VF.Beam.generateBeams(trebleVoice.getTickables(), {
        groups: beamGroups || undefined,
        stem_direction: STEM_UP,
        beam_rests: false,
        beam_middle_only: false,
        maintain_stem_directions: true,
      });
      bassBeams = VF.Beam.generateBeams(bassVoice.getTickables(), {
        groups: beamGroups || undefined,
        stem_direction: STEM_DOWN,
        beam_rests: false,
        beam_middle_only: false,
        maintain_stem_directions: true,
      });
    }

    trebleVoice.draw(ctx, treble);
    bassVoice.draw(ctx, bass);
    trebleBeams.forEach((b) => b.setContext(ctx).draw());
    bassBeams.forEach((b) => b.setContext(ctx).draw());

    // Optional: tag for "active" CSS (not required for red/green)
    function tagNoteEl(note, ev) {
      const el = note?.attrs?.el;
      if (!el) return;
      el.setAttribute("data-id", ev.id);
      el.classList.add("note-group");
    }
    trebleNotes.forEach(({ note, ev }) => tagNoteEl(note, ev));
    bassNotes.forEach(({ note, ev }) => tagNoteEl(note, ev));
  }
}

function renderStaticClefs(key) {
  if (!VF || !staticClefsEl) return;
  staticClefsEl.innerHTML = "";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const width = 150;
  const height = 260;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  staticClefsEl.appendChild(svg);

  const renderer = new VF.Renderer(svg, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  ctx.setFont("Inter", 12, "");

  const treble = new VF.Stave(0, 24, width);
  treble.addClef("treble").addKeySignature(key).addTimeSignature(state.timeSig);
  treble.setContext(ctx).draw();

  const bass = new VF.Stave(0, 130, width);
  bass.addClef("bass").addKeySignature(key).addTimeSignature(state.timeSig);
  bass.setContext(ctx).draw();

}

/* ------------------------- Stats + grading ------------------------- */

function updateStats() {
  correctCountEl.textContent = state.stats.correct;
  mistakeCountEl.textContent = state.stats.mistakes;
  const total = state.stats.correct + state.stats.mistakes;
  const accuracy = total === 0 ? 0 : Math.round((state.stats.correct / total) * 100);
  accuracyEl.textContent = `${accuracy}%`;

  const sorted = [...state.tricky.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  trickyList.innerHTML = "";
  if (!sorted.length) {
    const li = document.createElement("li");
    li.textContent = "No tricky notes yet.";
    trickyList.appendChild(li);
  } else {
    sorted.forEach(([midi, count]) => {
      const li = document.createElement("li");
      const octave = Math.floor(midi / 12) - 1;
      const names = state.preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
      const name = names[midi % 12];
      li.textContent = `${name}${octave} — ${count} misses`;
      trickyList.appendChild(li);
    });
  }
}

function currentTarget() {
  return state.targets.find((ev) => !ev.completed);
}

function markCorrect(ev) {
  if (ev.completed) return;
  ev.completed = true;
  ev.waiting = false;
  state.stats.correct += 1;

  state.renderMarks.set(ev.id, "correct");
  rerenderPreserveScroll();

  updateStats();
}

function markMistake(ev, midi) {
  if (!ev.mistakeFlag) {
    state.stats.mistakes += 1;
    ev.mistakeFlag = true;
  }
  state.tricky.set(midi, (state.tricky.get(midi) || 0) + 1);

  state.renderMarks.set(ev.id, "mistake");
  rerenderPreserveScroll();

  updateStats();

  // Pause at this onset so the next target doesn't instantly flag.
  state.progressBeats = Math.min(state.progressBeats, ev.offsetBeats);
  const translate = -state.progressBeats * pxPerBeat;
  scoreEl.style.transform = `translateX(${translate}px)`;
}

function checkPlayheadMiss() {
  const ev = currentTarget();
  if (!ev) return;

  const lateWindow = INPUT_TIMING.lateWindowBeats;
  if (!ev.waiting && state.progressBeats >= ev.offsetBeats + lateWindow && ev.hits.size < ev.midis.length) {
    ev.waiting = true;
    const missing = ev.midis.find((m) => !ev.hits.has(m)) ?? ev.midis[0];
    markMistake(ev, missing);
    state.running = false;
  }
}

function highlightCurrent() {
  const groups = scoreEl.querySelectorAll(".note-group");
  groups.forEach((g) => g.classList.remove("active"));
  const ev = currentTarget();
  if (!ev) return;

  const lead = 0.25;
  if (state.progressBeats >= ev.offsetBeats - lead) {
    scoreEl.querySelectorAll(`[data-id="${ev.id}"]`).forEach((n) => n.classList.add("active"));
  }
}

function handleMidiMessage(msg) {
  const [status, pitch, velocity] = msg.data;
  const type = status & 0xf0;
  if (type !== 0x90 || velocity === 0) return;

  const ev = currentTarget();
  if (!ev) return;

  const nowBeats = state.progressBeats;
  const earliestAllowed = ev.offsetBeats - INPUT_TIMING.earlyWindowBeats;

  // Too early for the current target: ignore input so you can't “race ahead”.
  if (nowBeats < earliestAllowed) {
    return;
  }


  if (ev.midis.includes(pitch)) {
    ev.hits.add(pitch);
    if (ev.hits.size >= ev.midis.length) {
      ev.mistakeFlag = false;
      markCorrect(ev);
      if (!userPaused) state.running = true;
    }
  } else {
    markMistake(ev, pitch);
    state.running = false;
  }
}

/* ------------------------- MIDI ------------------------- */

function connectMidiInput(id) {
  state.midiInputId = id;
  state.midiInputs.forEach((inp) => (inp.onmidimessage = null));
  let target = null;
  if (!id || id === "auto") target = state.midiInputs[0];
  else target = state.midiInputs.find((i) => i.id === id);

  if (target) {
    target.onmidimessage = handleMidiMessage;
    midiStatusEl.textContent = `MIDI: ${target.name}`;
    midiStatusEl.classList.remove("warn");
  } else {
    midiStatusEl.textContent = "MIDI: no devices detected";
    midiStatusEl.classList.add("warn");
  }
}

function refreshMidiInputs(access) {
  state.midiAccess = access;
  state.midiInputs = [];
  access.inputs.forEach((i) => state.midiInputs.push(i));

  midiSelect.innerHTML = "";
  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = state.midiInputs.length ? "Auto (first available)" : "No devices";
  midiSelect.appendChild(autoOpt);
  midiSelect.disabled = state.midiInputs.length === 0;

  state.midiInputs.forEach((i) => {
    const opt = document.createElement("option");
    opt.value = i.id;
    opt.textContent = i.name;
    midiSelect.appendChild(opt);
  });

  midiSelect.value =
    state.midiInputId && state.midiInputs.find((i) => i.id === state.midiInputId)
      ? state.midiInputId
      : "auto";

  connectMidiInput(midiSelect.value);
}

async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    midiStatusEl.textContent = "MIDI unsupported in this browser";
    midiStatusEl.classList.add("warn");
    midiSelect.innerHTML = "<option>No MIDI support</option>";
    midiSelect.disabled = true;
    return;
  }
  const isSecure = window.isSecureContext || ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!isSecure) {
    midiStatusEl.textContent = "MIDI blocked: use https or localhost";
    midiStatusEl.classList.add("warn");
    midiSelect.innerHTML = "<option>Requires https/localhost</option>";
    midiSelect.disabled = true;
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    refreshMidiInputs(access);
    access.onstatechange = () => refreshMidiInputs(access);
    if (!state.midiInputs.length) {
      midiStatusEl.textContent = "MIDI: no devices detected";
      midiStatusEl.classList.add("warn");
    }
  } catch (e) {
    midiStatusEl.textContent = "MIDI: permission denied";
    midiStatusEl.classList.add("warn");
  }
}

/* ------------------------- Clock / scroll ------------------------- */

let lastFrame = performance.now();
let userPaused = false;

function refreshLayout() {
  const width = Math.round(staticClefsEl?.getBoundingClientRect().width || 120);
  layout.playheadX = width;
  layout.leadInPx = width;
  document.documentElement.style.setProperty("--playhead-left", `${layout.playheadX}px`);
}

function tick(now) {
  const delta = (now - lastFrame) / 1000;
  lastFrame = now;
  if (state.running && !userPaused) {
    state.progressBeats += (state.bpm / 60) * delta;
    const translate = -state.progressBeats * pxPerBeat;
    scoreEl.style.transform = `translateX(${translate}px)`;
    if (!playback.isPlaying) {
      checkPlayheadMiss();
    }
    highlightCurrent();
  }
  requestAnimationFrame(tick);
}

/* ------------------------- Restart scroll / replay ------------------------- */

function restartScrollAndExercise(preserveStats = false) {
  state.progressBeats = 0;
  scoreEl.style.transform = `translateX(0px)`;
  lastFrame = performance.now();

  state.targets.forEach((t) => {
    t.completed = false;
    t.waiting = false;
    t.mistakeFlag = false;
    t.hits = new Set();
  });

  if (!preserveStats) {
    state.stats = { correct: 0, mistakes: 0 };
    state.tricky = new Map();
    updateStats();
  }

  state.renderMarks = new Map();
  renderStaticClefs(state.key);
  renderSequence(state.trebleSeq, state.bassSeq, state.key);

  state.running = true;
  userPaused = false;
  if (toggleRunBtn) toggleRunBtn.textContent = "Pause";
}

/* ------------------------- Regenerate ------------------------- */

function keySignatureAccidentals(key) {
  const count = KEY_INFO[key]?.accidentals || 0;
  const sharps = ["F", "C", "G", "D", "A", "E", "B"];
  const flats  = ["B", "E", "A", "D", "G", "C", "F"];

  const map = new Map();
  if (count > 0) {
    sharps.slice(0, count).forEach((l) => map.set(l, "#"));
  } else if (count < 0) {
    flats.slice(0, Math.abs(count)).forEach((l) => map.set(l, "b"));
  }
  return map;
}


function regenerate() {
  if (!VF) return;

  refreshLayout();

  state.progressBeats = 0;
  state.stats = { correct: 0, mistakes: 0 };
  state.tricky = new Map();
  state.renderMarks = new Map();
  updateStats();

  const { trebleSeq, bassSeq, targets, preferSharps } = generatePiece(state.windowSize, {
    key: state.key,
    maxPoly: state.maxPoly,
    difficulty: state.difficulty,
  });

  state.trebleSeq = trebleSeq;
  state.bassSeq = bassSeq;
  state.targets = targets;

  state.preferSharps = preferSharps;
  state.keySig = keySignatureAccidentals(state.key);

  renderStaticClefs(state.key);
  renderSequence(state.trebleSeq, state.bassSeq, state.key);

  scoreEl.style.transform = `translateX(0px)`;
  lastFrame = performance.now();
  state.running = true;
}

/* ------------------------- Controls ------------------------- */

function bindControls() {
  bpmRange.addEventListener("input", () => {
    state.bpm = Number(bpmRange.value);
    bpmValue.textContent = state.bpm;
  });

  keySelect.addEventListener("change", () => {
    state.key = keySelect.value;
    renderStaticClefs(state.key);
    regenerate();
  });

  windowSizeInput.addEventListener("change", () => {
    state.windowSize = Math.min(256, Math.max(4, Number(windowSizeInput.value))); // allow longer if you want
    windowSizeInput.value = state.windowSize;
    regenerate();
  });

  polyphonyInput.addEventListener("change", () => {
    state.maxPoly = Math.min(10, Math.max(1, Number(polyphonyInput.value)));
    polyphonyInput.value = state.maxPoly;
    regenerate();
  });

  timeSigSelect.addEventListener("change", () => {
    state.timeSig = timeSigSelect.value;
    renderStaticClefs(state.key);
    regenerate();
  });

  midiSelect.addEventListener("change", () => {
    connectMidiInput(midiSelect.value);
  });

  regenerateBtn.addEventListener("click", () => {
    stopPlayback();
    regenerate();
  });

  toggleRunBtn.addEventListener("click", () => {
    userPaused = !userPaused;
    toggleRunBtn.textContent = userPaused ? "Resume" : "Pause";
    if (!userPaused) state.running = true;
  });

  diffButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      diffButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.difficulty = btn.dataset.diff;
      stopPlayback();
      regenerate();
    });
  });

  midiConnectBtn.addEventListener("click", () => {
    initMIDI();
  });
}

function startClock() {
  const clockEl = document.getElementById("clock");
  setInterval(() => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    clockEl.textContent = `${hh}:${mm}`;
  }, 1000);
}

async function init() {
  refreshLayout();
  initKeySelect();
  ensurePlaybackControlsUI();
  bindControls();
  timeSigSelect.value = state.timeSig;

  const ok = await ensureVexFlow();
  if (ok) {
    regenerate();
    initMIDI();
  } else {
    scoreEl.innerHTML = '<div class="placeholder">Unable to load notation engine.</div>';
  }

  startClock();
  requestAnimationFrame(tick);
}

init();
