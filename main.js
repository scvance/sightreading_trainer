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

let state = {
  bpm: Number(bpmRange.value),
  key: "C",
  windowSize: Number(windowSizeInput.value),
  maxPoly: Number(polyphonyInput.value),
  timeSig: "4/4",
  difficulty: "easy",
  running: true,
  sequence: [],
  progressBeats: 0,
  tricky: new Map(),
  stats: { correct: 0, mistakes: 0 },
  midiInputs: [],
  midiAccess: null,
  midiInputId: null,
  keySig: new Map(),
};

async function ensureVexFlow() {
  if (VF) return true;
  if (window.Vex?.Flow) {
    VF = window.Vex.Flow;
    return true;
  }
  // Last resort: inject the bundled script if it was removed.
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

function initKeySelect() {
  Object.keys(KEY_INFO).forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    keySelect.appendChild(opt);
  });
  keySelect.value = state.key;
}

function midiToVex(midi, preferSharps) {
  const octave = Math.floor(midi / 12) - 1;
  const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  const name = names[midi % 12];
  const accidental = name.length > 1 ? name[1] : null;
  const key = `${name[0].toLowerCase()}${accidental ? accidental.toLowerCase() : ""}/${octave}`;
  return { key, accidental };
}

function buildScale(key) {
  const rootName = key.replace("b", "b").replace("#", "#");
  // Prefer flats for C and flat keys; sharps only for positive accidental keys.
  const preferSharps = KEY_INFO[key].accidentals > 0;
  const names = preferSharps ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  const rootIndex = names.findIndex((n) => n === rootName);
  const pcs = new Set(MAJOR_SCALE.map((step) => (rootIndex + step + 12) % 12));
  return { pcs, preferSharps };
}

function keySignatureAccidentals(key) {
  const count = KEY_INFO[key]?.accidentals || 0;
  const sharps = ["F", "C", "G", "D", "A", "E", "B"];
  const flats = ["B", "E", "A", "D", "G", "C", "F"];
  const map = new Map();
  if (count > 0) {
    sharps.slice(0, count).forEach((l) => map.set(l, "#"));
  } else if (count < 0) {
    flats.slice(0, Math.abs(count)).forEach((l) => map.set(l, "b"));
  }
  return map;
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
  // Slide to nearest in-scale pitch.
  let tries = 0;
  while (!scale.pcs.has(candidate % 12) && tries < 12) {
    candidate += Math.sign(Math.random() - 0.5) || 1;
    if (candidate < low) candidate = low;
    if (candidate > high) candidate = high;
    tries++;
  }
  return Math.min(Math.max(candidate, low), high);
}

function generateSequence(count, { key, maxPoly, difficulty }) {
  const scale = buildScale(key);
  const events = [];
  let treblePrev = 72; // C5
  let bassPrev = 48; // C3
  const durPool = difficulty === "hard" ? [0.5, 0.5, 1, 1, 1.5, 2] : difficulty === "medium" ? [0.5, 1, 1, 1, 2] : [1, 1, 1, 2];
  const spice = difficulty === "hard" ? 0.45 : difficulty === "medium" ? 0.3 : 0.18;

  for (let i = 0; i < count; i++) {
    const chordSize = Math.max(1, Math.round(Math.random() * (maxPoly - 1)) + 1);
    const midis = [];
    for (let j = 0; j < chordSize; j++) {
      const clef = Math.random() > 0.5 ? "treble" : "bass";
      if (clef === "treble") {
        treblePrev = pickPitch(treblePrev, [60, 88], scale, spice);
        midis.push(treblePrev);
      } else {
        bassPrev = pickPitch(bassPrev, [36, 60], scale, spice);
        midis.push(bassPrev);
      }
    }
    const uniqueMidis = [...new Set(midis)].sort((a, b) => a - b);
    const beats = durPool[Math.floor(Math.random() * durPool.length)];
    events.push({ id: `ev-${i}-${Date.now()}`, midis: uniqueMidis, beats, hits: new Set(), mistakeFlag: false, waiting: false });
  }

  let cumulative = 0;
  const leadInBeats = (layout.leadInPx - layout.playheadX) / pxPerBeat;
  events.forEach((ev) => {
    ev.offsetBeats = cumulative + leadInBeats;
    ev.offsetPx = layout.leadInPx + cumulative * pxPerBeat;
    ev.vex = ev.beats >= 2 ? "h" : ev.beats === 0.5 ? "8" : "q";
    cumulative += ev.beats;
  });

  return { events, preferSharps: scale.preferSharps };
}

function noteToKeys(midis, preferSharps) {
  return midis.map((m) => midiToVex(m, preferSharps));
}

function renderSequence(seq, key) {
  if (!VF) return;
  scoreEl.innerHTML = "";
  const [num, den] = state.timeSig.split("/").map(Number);
  const beatsPerMeasure = num * (4 / den);
  const leadInBeats = (layout.leadInPx - layout.playheadX) / pxPerBeat;
  const last = seq[seq.length - 1];
  const minWidth = scoreWrapper?.clientWidth || 800;
  const totalWidth = last ? last.offsetPx + 260 : minWidth;
  scoreEl.style.width = `${Math.max(totalWidth, minWidth)}px`;
  scoreEl.style.height = "100%";
  let currentMeasure = -1;
  seq.forEach((ev, idx) => {
    const group = document.createElement("div");
    group.className = "note-group";
    group.dataset.id = ev.id;
    group.style.position = "absolute";
    group.style.left = `${ev.offsetPx}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const width = 190;
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
    treble.setContext(ctx).draw();
    bass.setContext(ctx).draw();

    // measure number overlay
    const measureIdx = Math.floor((ev.offsetBeats - leadInBeats + 1e-6) / beatsPerMeasure) + 1;
    if (measureIdx !== currentMeasure) {
      currentMeasure = measureIdx;
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", "4");
      txt.setAttribute("y", "14");
      txt.setAttribute("fill", "#9ca3af");
      txt.setAttribute("font-size", "11");
      txt.textContent = `M${measureIdx}`;
      svg.appendChild(txt);
    }

    const trebleKeys = noteToKeys(ev.midis.filter((m) => m >= 60), state.preferSharps);
    const bassKeys = noteToKeys(ev.midis.filter((m) => m < 60), state.preferSharps);

    const trebleNote = trebleKeys.length
      ? new VF.StaveNote({ clef: "treble", keys: trebleKeys.map((k) => k.key), duration: ev.vex })
      : new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: `${ev.vex}r` });
    const bassNote = bassKeys.length
      ? new VF.StaveNote({ clef: "bass", keys: bassKeys.map((k) => k.key), duration: ev.vex })
      : new VF.StaveNote({ clef: "bass", keys: ["d/3"], duration: `${ev.vex}r` });

    const keySig = state.keySig;
    trebleKeys.forEach((k, idx) => {
      const letter = k.key[0].toUpperCase();
      if (k.accidental && keySig.get(letter) !== k.accidental) {
        trebleNote.addModifier(new VF.Accidental(k.accidental), idx);
      }
    });
    bassKeys.forEach((k, idx) => {
      const letter = k.key[0].toUpperCase();
      if (k.accidental && keySig.get(letter) !== k.accidental) {
        bassNote.addModifier(new VF.Accidental(k.accidental), idx);
      }
    });

    const trebleVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(false);
    trebleVoice.addTickables([trebleNote]);
    new VF.Formatter().joinVoices([trebleVoice]).format([trebleVoice], width - 60);
    trebleVoice.draw(ctx, treble);

    const bassVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(false);
    bassVoice.addTickables([bassNote]);
    new VF.Formatter().joinVoices([bassVoice]).format([bassVoice], width - 60);
    bassVoice.draw(ctx, bass);
  });
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
      const textKey = midiToVex(midi, state.preferSharps).key.replace("/", "");
      li.textContent = `${textKey} — ${count} misses`;
      trickyList.appendChild(li);
    });
  }
}

function markCorrect(ev) {
  if (ev.completed) return;
  ev.completed = true;
  ev.waiting = false;
  state.stats.correct += 1;
  const node = scoreEl.querySelector(`[data-id="${ev.id}"]`);
  node?.classList.remove("mistake");
  node?.classList.add("correct");
  updateStats();
}

function markMistake(ev, midi) {
  if (!ev.mistakeFlag) {
    state.stats.mistakes += 1;
    ev.mistakeFlag = true;
  }
  state.tricky.set(midi, (state.tricky.get(midi) || 0) + 1);
  const node = scoreEl.querySelector(`[data-id="${ev.id}"]`);
  node?.classList.add("mistake");
  updateStats();
  // Pause at this note's position so the next note doesn't instantly flag.
  state.progressBeats = Math.min(state.progressBeats, ev.offsetBeats);
  const translate = -state.progressBeats * pxPerBeat;
  scoreEl.style.transform = `translateX(${translate}px)`;
}

function currentTarget() {
  return state.sequence.find((ev) => !ev.completed);
}

function checkPlayheadMiss() {
  const ev = currentTarget();
  if (!ev) return;
  const lateWindow = 0.1; // beats after playhead
  if (!ev.waiting && state.progressBeats >= ev.offsetBeats + lateWindow && ev.hits.size < ev.midis.length) {
    ev.waiting = true;
    markMistake(ev, ev.midis[0]);
    state.running = false;
  }
}

function highlightCurrent() {
  const groups = scoreEl.querySelectorAll(".note-group");
  groups.forEach((g) => g.classList.remove("active"));
  const ev = currentTarget();
  if (!ev) return;
  const lead = 0.25; // beats before playhead to cue readiness
  if (state.progressBeats >= ev.offsetBeats - lead) {
    scoreEl.querySelector(`[data-id="${ev.id}"]`)?.classList.add("active");
  }
}

function handleMidiMessage(msg) {
  const [status, pitch, velocity] = msg.data;
  const type = status & 0xf0;
  if (type !== 0x90 || velocity === 0) return; // note on only
  const ev = currentTarget();
  if (!ev) return;
  if (ev.midis.includes(pitch)) {
    ev.hits.add(pitch);
    if (ev.hits.size >= ev.midis.length) {
      ev.mistakeFlag = false;
      markCorrect(ev);
      // resume scrolling if user isn't paused
      if (!userPaused) state.running = true;
    }
  } else {
    markMistake(ev, pitch);
    state.running = false;
  }
}

function connectMidiInput(id) {
  state.midiInputId = id;
  state.midiInputs.forEach((inp) => (inp.onmidimessage = null));
  let target = null;
  if (!id || id === "auto") {
    target = state.midiInputs[0];
  } else {
    target = state.midiInputs.find((i) => i.id === id);
  }
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
  if (state.midiInputId && state.midiInputs.find((i) => i.id === state.midiInputId)) {
    midiSelect.value = state.midiInputId;
  } else {
    midiSelect.value = "auto";
  }
  connectMidiInput(midiSelect.value);
  console.info("MIDI inputs detected:", state.midiInputs.map((i) => i.name));
}

async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    midiStatusEl.textContent = "MIDI unsupported in this browser";
    midiStatusEl.classList.add("warn");
    midiSelect.innerHTML = '<option>No MIDI support</option>';
    midiSelect.disabled = true;
    return;
  }
  const isSecure = window.isSecureContext || ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!isSecure) {
    midiStatusEl.textContent = "MIDI blocked: use https or localhost";
    midiStatusEl.classList.add("warn");
    midiSelect.innerHTML = '<option>Requires https/localhost</option>';
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
      console.warn("No MIDI devices detected. If using Chrome, check chrome://settings/content/midiDevices and ensure access is allowed.");
    }
  } catch (e) {
    if (e && e.name === "NotAllowedError") {
      midiStatusEl.textContent = "MIDI blocked: allow in site settings/padlock";
    } else {
      midiStatusEl.textContent = "MIDI: permission denied";
    }
    midiStatusEl.classList.add("warn");
    console.error("MIDI access error:", e);
  }
}

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
    checkPlayheadMiss();
    highlightCurrent();
  }
  requestAnimationFrame(tick);
}

function regenerate() {
  if (!VF) return;
  refreshLayout();
  state.progressBeats = 0;
  state.stats = { correct: 0, mistakes: 0 };
  state.tricky = new Map();
  updateStats();
  const { events, preferSharps } = generateSequence(state.windowSize, {
    key: state.key,
    maxPoly: state.maxPoly,
    difficulty: state.difficulty,
  });
  state.sequence = events;
  state.preferSharps = preferSharps;
  state.keySig = keySignatureAccidentals(state.key);
  renderStaticClefs(state.key);
  renderSequence(events, state.key);
  scoreEl.querySelectorAll(".note-group").forEach((g) => g.classList.remove("active"));
  scoreEl.style.transform = `translateX(0px)`;
  lastFrame = performance.now();
  state.running = true;
}

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
    state.windowSize = Math.min(32, Math.max(4, Number(windowSizeInput.value)));
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

  regenerateBtn.addEventListener("click", regenerate);

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
