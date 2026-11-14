import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findPreset, parseStrengthHints, parseUsageTipsRange, presetKey } from "./strength_parser.js";

/*
 * LoRA Slider (LoraManager) — front-end widget.
 *
 * A self-contained DOM widget that renders one bipolar strength slider per LoRA.
 * It integrates with ComfyUI-Lora-Manager ONLY through LM's public HTTP routes
 * (/api/lm/loras/...) and shared ComfyUI types — it never imports LM code.
 *
 * Per-row state (serialized into the widget value):
 *   { name, modelName, displayName, filePath, value, min, max, step,
 *     lowLabel, highLabel, active, locked, triggerWords }
 *   - name: LM-style relative path WITHOUT extension ("folder/file"); this is what
 *           goes into the LORA_STACK and is re-resolved by LM's Lora Loader.
 */

const NODE_CLASS = "LoRA Slider (LoraManager)";

// Inject the stylesheet (ComfyUI does not auto-load CSS from WEB_DIRECTORY).
(function injectStyles() {
  try {
    const href = new URL("./lora_slider.css", import.meta.url).href;
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  } catch (e) {
    console.warn("[LoraSlider] failed to inject styles", e);
  }
})();

const DEFAULTS = Object.freeze({
  min: -3.0,
  max: 3.0,
  step: 0.05,
  value: 0.0,
  lowLabel: "Low",
  highLabel: "High",
  active: true,
  locked: false,
});

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function chainCallback(object, property, callback) {
  const original = object[property];
  object[property] = function () {
    const r = original ? original.apply(this, arguments) : undefined;
    callback.apply(this, arguments);
    return r;
  };
}

function stripExtension(path) {
  return String(path).replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
}

// Build the LM "folder/file" (no extension) name from a list-card entry.
function nameFromCard(card) {
  const fileName = stripExtension(card.file_name || card.fileName || "");
  const folder = card.folder || "";
  return folder ? `${folder}/${fileName}` : fileName;
}

function snapToStep(value, min, step) {
  if (!step || step <= 0) return value;
  const snapped = Math.round((value - min) / step) * step + min;
  // Avoid floating point noise like 1.0500000000000003.
  return parseFloat(snapped.toFixed(4));
}

function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.max(lo, Math.min(hi, value));
}

function randomInRange(min, max, step) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const raw = lo + Math.random() * (hi - lo);
  return clamp(snapToStep(raw, lo, step), lo, hi);
}

async function lmFetchJson(url, options) {
  try {
    const res = await api.fetchApi(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("[LoraSlider] LM request failed:", url, e);
    return null;
  }
}

// Process items through an async worker with a hard concurrency cap, so we never
// fire hundreds of simultaneous requests at LoRA Manager's server (which would make
// its UI hang). Resolves when all items are done.
const AUTOFILL_CONCURRENCY = 3;
// Above this many newly-added rows we skip auto-fill entirely (and say so), to avoid
// generating a large request volume for very large imports.
const AUTOFILL_MAX_ROWS = 400;

function runWithConcurrency(items, worker, concurrency, onProgress) {
  return new Promise((resolve) => {
    const total = items.length;
    if (!total) {
      resolve();
      return;
    }
    let index = 0;
    let active = 0;
    let done = 0;
    const pump = () => {
      while (active < concurrency && index < total) {
        const item = items[index++];
        active++;
        Promise.resolve()
          .then(() => worker(item))
          .catch(() => {})
          .then(() => {
            active--;
            done++;
            if (onProgress) onProgress(done, total);
            if (done === total) resolve();
            else pump();
          });
      }
    };
    pump();
  });
}

function normalizeRow(raw) {
  const row = Object.assign({}, raw);
  row.name = row.name || "";
  row.modelName = row.modelName || (row.name ? row.name.split("/").pop() : "");
  row.displayName = row.displayName != null ? String(row.displayName) : "";
  row.filePath = row.filePath || "";
  row.min = Number.isFinite(+row.min) ? +row.min : DEFAULTS.min;
  row.max = Number.isFinite(+row.max) ? +row.max : DEFAULTS.max;
  row.step = Number.isFinite(+row.step) && +row.step > 0 ? +row.step : DEFAULTS.step;
  row.value = Number.isFinite(+row.value) ? clamp(+row.value, row.min, row.max) : DEFAULTS.value;
  row.lowLabel = row.lowLabel != null ? String(row.lowLabel) : DEFAULTS.lowLabel;
  row.highLabel = row.highLabel != null ? String(row.highLabel) : DEFAULTS.highLabel;
  row.active = row.active !== false;
  row.locked = row.locked === true;
  row.triggerWords = row.triggerWords || "";
  return row;
}

// ---------------------------------------------------------------------------
// LM metadata auto-fill (best effort)
// ---------------------------------------------------------------------------

// Find a LoRA's LM list card (file_path, usage_tips, ...) via LM's listing route.
async function resolveCard(name) {
  const leaf = name.split("/").pop();
  const data = await lmFetchJson(
    `/api/lm/loras/list?page=1&page_size=100&search=${encodeURIComponent(leaf)}`
  );
  const items = (data && (data.items || data.data || data.loras)) || [];
  for (const card of items) {
    if (nameFromCard(card) === name || stripExtension(card.file_name || "") === leaf) {
      return card;
    }
  }
  return null;
}

// Slider presets live in ComfyUI's own user data folder (user/default/), read and
// written through ComfyUI's /userdata route. Nothing is stored in LoRA Manager.
const PRESETS_FILE = "lora_slider_presets.json";

// Throws on anything but "ok" or "file does not exist yet", so a failed read can
// never be mistaken for an empty file and then saved over the real one.
async function readPresets() {
  const res = await api.fetchApi(`/userdata/${PRESETS_FILE}`);
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  return data;
}

async function savePreset(row) {
  const presets = await readPresets(); // re-read: the file may have been edited outside ComfyUI
  const preset = { min: row.min, max: row.max, step: row.step, lowLabel: row.lowLabel, highLabel: row.highLabel };
  if (row.displayName) preset.displayName = row.displayName;
  presets[presetKey(row.name)] = preset;
  const res = await api.fetchApi(`/userdata/${PRESETS_FILE}?overwrite=true`, {
    method: "POST",
    body: JSON.stringify(presets, null, 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Fill a row's range and labels. Range: the strength range set in LoRA Manager wins,
// then the preset, then the description. Labels and display name: preset, then description.
async function autofillRowFromMetadata(row, presets) {
  try {
    const preset = findPreset(presets, row.name) || {};
    const card = await resolveCard(row.name);
    if (card) row.filePath = row.filePath || card.file_path || card.filePath || "";

    const applyRange = (range, source) => {
      row.min = range.min;
      row.max = range.max;
      row.value = clamp(row.value, row.min, row.max);
      row.autofilled = source;
    };
    const lmRange = card && parseUsageTipsRange(card.usage_tips);
    if (lmRange) applyRange(lmRange, "LoRA Manager");
    else if (preset.min != null) applyRange(preset, "preset");
    if (preset.step) row.step = preset.step;
    if (preset.displayName && !row.displayName) row.displayName = preset.displayName;
    for (const key of ["lowLabel", "highLabel"]) {
      if (!preset[key]) continue;
      row[key] = preset[key];
      row.autofilled = row.autofilled || "preset";
    }

    const haveRange = !!lmRange || preset.min != null;
    if (!row.filePath || (haveRange && preset.lowLabel && preset.highLabel)) return;

    const data = await lmFetchJson(
      `/api/lm/loras/model-description?file_path=${encodeURIComponent(row.filePath)}`
    );
    const hints = parseStrengthHints(data && data.success ? data.description : "");
    if (!haveRange && hints.min != null && hints.max != null) applyRange(hints, "description");
    for (const key of ["lowLabel", "highLabel"]) {
      if (preset[key] || !hints[key]) continue;
      row[key] = hints[key];
      row.autofilled = row.autofilled || "description";
    }
  } catch (e) {
    /* best-effort: ignore */
  }
}

// ---------------------------------------------------------------------------
// Pool import — read the upstream Lora Pool node's POOL_CONFIG
// ---------------------------------------------------------------------------

// Look up a graph link by id, tolerating both the legacy object map and the newer
// Map-based graph.links (matches LoRA Manager's own getLinkFromGraph).
function getLinkFromGraph(graph, linkId) {
  if (!graph || graph.links == null) return null;
  if (typeof graph.links.get === "function") return graph.links.get(linkId) || null;
  return graph.links[linkId] || null;
}

// Find a connected "Lora Pool (LoraManager)" node feeding our pool_config input, and
// return the *filters* dict it would output — i.e. poolWidget.value.filters, exactly
// what LM's Lora Pool node passes downstream (its process() returns (filters,)).
// Returns null if no pool is connected.
function readUpstreamPoolFilters(node) {
  if (!node || !node.inputs) return null;
  for (const input of node.inputs) {
    if (!input || input.name !== "pool_config" || input.link == null) continue;
    const link = getLinkFromGraph(node.graph, input.link);
    if (!link) continue;
    const source = node.graph && node.graph.getNodeById && node.graph.getNodeById(link.origin_id);
    if (!source || source.comfyClass !== "Lora Pool (LoraManager)") continue;

    // Respect a muted/bypassed pool node.
    const active = source.mode === undefined || source.mode === 0 || source.mode === 3;
    if (!active) return null;

    const poolWidget = (source.widgets || []).find((w) => w && w.name === "pool_config");
    let value = poolWidget && poolWidget.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (e) {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    // Send the inner filters dict (server's _apply_pool_filters reads keys at top level).
    return value.filters || {};
  }
  return null;
}

// ===========================================================================
// Widget factory
// ===========================================================================

function createSlidersWidget(node, inputName) {
  let rows = [];
  let dragFrom = null; // index of the row being dragged within this node, else null

  const container = document.createElement("div");
  container.className = "lora-slider-widget";

  const toolbar = document.createElement("div");
  toolbar.className = "ls-toolbar";
  container.appendChild(toolbar);

  // Collapsible "paste / type loras" panel (hidden until toggled).
  const textPanel = document.createElement("div");
  textPanel.className = "ls-textpanel";
  textPanel.style.display = "none";
  const textArea = document.createElement("textarea");
  textArea.className = "ls-textarea";
  textArea.rows = 3;
  textArea.placeholder =
    "Type or paste LoRAs — one per line/comma. Accepts <lora:folder/name:0.8> syntax (e.g. copied from LoRA Manager) or bare names.";
  const textAddBtn = document.createElement("button");
  textAddBtn.className = "ls-tool ls-tool-primary";
  textAddBtn.textContent = "Add from text";
  textPanel.appendChild(textArea);
  textPanel.appendChild(textAddBtn);
  container.appendChild(textPanel);

  const statusEl = document.createElement("div");
  statusEl.className = "ls-status";
  statusEl.style.display = "none";
  container.appendChild(statusEl);

  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
  }

  const rowsEl = document.createElement("div");
  rowsEl.className = "ls-rows";
  container.appendChild(rowsEl);

  const emptyEl = document.createElement("div");
  emptyEl.className = "ls-empty";
  emptyEl.textContent = "No LoRAs yet — use “+ Add LoRAs” or connect a Lora Pool and click “Import from Pool”.";
  container.appendChild(emptyEl);

  function refreshSize() {
    node.setDirtyCanvas(true, true);
  }

  function commit() {
    // Persist by reference; ComfyUI reads getValue() on serialize.
    widget.value = rows;
    if (typeof widget.callback === "function") widget.callback(rows);
    refreshSize();
  }

  // ---- render ----
  function render() {
    rowsEl.innerHTML = "";
    emptyEl.style.display = rows.length ? "none" : "block";

    rows.forEach((row, index) => {
      rowsEl.appendChild(buildRowEl(row, index));
    });
  }

  function buildRowEl(row, index) {
    const el = document.createElement("div");
    el.className = "ls-row" + (row.active ? "" : " ls-inactive") + (row.locked ? " ls-locked" : "");

    const rerenderRow = () => {
      const replacement = buildRowEl(row, index);
      el.replaceWith(replacement);
      commit();
    };

    const dragHandle = document.createElement("span");
    dragHandle.className = "ls-drag-handle";
    dragHandle.textContent = "⠿";
    dragHandle.title = "Drag to reorder this LoRA";
    dragHandle.draggable = true;
    dragHandle.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.name);
      dragFrom = index;
      el.classList.add("ls-dragging");
    };
    dragHandle.ondragend = () => {
      dragFrom = null;
      el.classList.remove("ls-dragging");
    };
    // Only react to a row dragged from this same node; leave file drops and
    // drags from other slider nodes alone.
    el.ondragover = (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("ls-drag-over");
    };
    el.ondragleave = () => el.classList.remove("ls-drag-over");
    el.ondrop = (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      el.classList.remove("ls-drag-over");
      const from = dragFrom;
      dragFrom = null;
      moveRow(from, index);
    };
    el.appendChild(dragHandle);

    // active toggle
    const active = document.createElement("input");
    active.type = "checkbox";
    active.className = "ls-active";
    active.checked = row.active;
    active.title = "Enable / disable this LoRA";
    active.onchange = () => {
      row.active = active.checked;
      el.classList.toggle("ls-inactive", !row.active);
      commit();
    };
    el.appendChild(active);

    // title
    const title = document.createElement("span");
    title.className = "ls-title";
    title.textContent = row.displayName || row.modelName || row.name;
    const filledFrom = row.autofilled === true ? "metadata" : row.autofilled;
    title.title = row.name + (filledFrom ? `  (auto-filled from ${filledFrom})` : "");
    el.appendChild(title);

    // low label
    const low = document.createElement("span");
    low.className = "ls-label ls-low";
    low.textContent = row.lowLabel;
    el.appendChild(low);

    // slider
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "ls-range";
    slider.min = String(row.min);
    slider.max = String(row.max);
    slider.step = String(row.step);
    slider.value = String(row.value);
    slider.disabled = row.locked;
    slider.oninput = () => {
      row.value = parseFloat(slider.value);
      valueBox.value = row.value;
    };
    // Avoid forcing a LiteGraph redraw for every step while the native range
    // thumb is held; some ComfyUI versions otherwise interrupt mouse dragging.
    slider.onchange = commit;
    el.appendChild(slider);

    // high label
    const high = document.createElement("span");
    high.className = "ls-label ls-high";
    high.textContent = row.highLabel;
    el.appendChild(high);

    // numeric value (editable)
    const valueBox = document.createElement("input");
    valueBox.type = "number";
    valueBox.className = "ls-value";
    valueBox.step = String(row.step);
    valueBox.value = row.value;
    valueBox.onchange = () => {
      const v = clamp(parseFloat(valueBox.value) || 0, row.min, row.max);
      row.value = v;
      valueBox.value = v;
      slider.value = String(v);
      commit();
    };
    el.appendChild(valueBox);

    // per-row buttons
    el.appendChild(
      iconButton("🎲", "Randomize this slider", () => {
        if (row.locked) return;
        row.value = randomInRange(row.min, row.max, row.step);
        slider.value = String(row.value);
        valueBox.value = row.value;
        commit();
      })
    );
    el.appendChild(
      iconButton(row.locked ? "🔒" : "🔓", "Lock (exclude from Randomize All)", () => {
        row.locked = !row.locked;
        rerenderRow();
      })
    );
    el.appendChild(
      iconButton("↑", "Move this LoRA up", () => moveRow(index, index - 1))
    );
    el.appendChild(
      iconButton("↓", "Move this LoRA down", () => moveRow(index, index + 1))
    );
    el.appendChild(
      iconButton("⚙", "Configure display name, min/max & labels", () => {
        openConfigModal(row, rerenderRow);
      })
    );
    el.appendChild(
      iconButton("✕", "Remove", () => {
        rows.splice(rows.indexOf(row), 1);
        render();
        commit();
      })
    );

    return el;
  }

  function iconButton(glyph, title, onClick) {
    const b = document.createElement("button");
    b.className = "ls-icon";
    b.textContent = glyph;
    b.title = title;
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };
    return b;
  }

  function moveRow(from, to) {
    if (from === to || from < 0 || from >= rows.length || to < 0 || to >= rows.length) return;
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    render();
    commit();
  }

  // ---- adding rows ----
  function addRows(newRows, { autofill } = { autofill: true }) {
    const existing = new Set(rows.map((r) => r.name));
    const created = [];
    for (const r of newRows) {
      const row = normalizeRow(r);
      if (!row.name || existing.has(row.name)) continue;
      existing.add(row.name);
      rows.push(row);
      created.push(row);
    }
    render();
    commit();
    if (autofill) autofillRows(created);
  }

  // Auto-fill ranges and labels for the given rows (new rows, or all unlocked rows
  // when the user asks for it from the toolbar).
  async function autofillRows(targets) {
    if (!targets.length) return;
    if (targets.length > AUTOFILL_MAX_ROWS) {
      setStatus(`Skipped auto-fill for ${targets.length} LoRAs (too many) - set ranges with the gear button.`);
      return;
    }
    // Read the presets file fresh each time so edits made outside ComfyUI are picked up.
    const presets = await readPresets().catch((e) => {
      console.warn(`[LoraSlider] could not read ${PRESETS_FILE}:`, e);
      return {};
    });
    // Throttled so we never flood LoRA Manager's server.
    setStatus(`Auto-filling ranges and labels 0/${targets.length}...`);
    await runWithConcurrency(
      targets,
      (row) => autofillRowFromMetadata(row, presets),
      AUTOFILL_CONCURRENCY,
      (doneCount, total) => {
        render();
        setStatus(doneCount < total ? `Auto-filling ranges and labels ${doneCount}/${total}...` : "");
      }
    );
    render();
    commit();
    setStatus("");
  }

  // ---- parse typed / pasted loras ----
  // Accepts "<lora:folder/name:0.8:0.7>" syntax and/or bare names separated by
  // newlines or commas. Returns [{name, value, clipStrength?}].
  function parseLoraText(text) {
    const results = [];
    const seen = new Set();
    const re = /<lora:([^:>]+):([-+]?\d*\.?\d+)(?::([-+]?\d*\.?\d+))?>/gi;
    let m;
    while ((m = re.exec(text))) {
      const name = stripExtension(m[1].trim()).replace(/\\/g, "/");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const entry = { name, value: parseFloat(m[2]) };
      if (m[3] != null) entry.clipStrength = parseFloat(m[3]);
      results.push(entry);
    }
    // Remaining text (after removing <lora:...> tags): treat each token as a bare name.
    const remainder = text.replace(re, "\n");
    for (const tok of remainder.split(/[\n,]+/)) {
      const t = tok.trim();
      if (!t || /\s/.test(t)) continue; // skip prose / multi-word lines
      const name = stripExtension(t).replace(/\\/g, "/");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      results.push({ name, value: 1.0 });
    }
    return results;
  }

  // ---- toolbar ----
  function toolbarButton(label, title, onClick, extraClass) {
    const b = document.createElement("button");
    b.className = "ls-tool" + (extraClass ? " " + extraClass : "");
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };
    toolbar.appendChild(b);
    return b;
  }

  function toolbarSeparator() {
    const s = document.createElement("span");
    s.className = "ls-sep";
    toolbar.appendChild(s);
  }

  // --- add group ---
  toolbarButton("+ Add LoRAs", "Pick LoRAs from Lora Manager (supports folder/name search)", () =>
    openPickerModal(addRows)
  );
  toolbarButton("+ Text", "Type or paste LoRAs (incl. <lora:…> codes from Lora Manager)", () => {
    textPanel.style.display = textPanel.style.display === "none" ? "flex" : "none";
    if (textPanel.style.display !== "none") textArea.focus();
    refreshSize();
  });
  toolbarButton("Import from Pool", "Add every LoRA matched by a connected Lora Pool node", importFromPool);
  toolbarButton(
    "Re-apply presets",
    "Re-read range and labels for every unlocked slider (presets file, LoRA Manager range, description)",
    () => autofillRows(rows.filter((r) => !r.locked))
  );

  toolbarSeparator();

  // --- randomize group (locked sliders are never affected) ---
  toolbarButton(
    "🎲 Strength",
    "Randomize the strength of every unlocked slider (within each slider's range)",
    () => {
      for (const row of rows) {
        if (row.locked) continue;
        row.value = randomInRange(row.min, row.max, row.step);
      }
      render();
      commit();
    }
  );
  toolbarButton(
    "🎲 Enabled",
    "Randomly enable/disable each unlocked slider",
    () => {
      for (const row of rows) {
        if (row.locked) continue;
        row.active = Math.random() < 0.5;
      }
      render();
      commit();
    }
  );

  toolbarSeparator();

  toolbarButton("Reset", "Set all sliders to 0 (off)", () => {
    for (const row of rows) row.value = clamp(0, row.min, row.max);
    render();
    commit();
  });
  toolbarButton("Clear", "Remove all sliders", () => {
    if (!rows.length || confirm("Remove all sliders from this node?")) {
      rows = [];
      render();
      commit();
    }
  });

  textAddBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const parsed = parseLoraText(textArea.value);
    if (!parsed.length) {
      setStatus("No LoRAs recognized in the text.");
      return;
    }
    addRows(parsed, { autofill: true });
    textArea.value = "";
  };

  async function importFromPool() {
    const filters = readUpstreamPoolFilters(node);
    if (filters === null) {
      alert("Connect a 'Lora Pool (LoraManager)' node to the pool_config input first.");
      return;
    }
    setStatus("Querying Lora Pool…");
    const data = await lmFetchJson("/api/lm/loras/cycler-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool_config: filters, sort_by: "filename" }),
    });
    setStatus("");
    const loras = (data && data.success && data.loras) || [];
    if (!loras.length) {
      alert("The connected Lora Pool matched no LoRAs (check its filters).");
      return;
    }
    if (
      loras.length > 250 &&
      !confirm(`The connected Lora Pool matched ${loras.length} LoRAs. Add them all as sliders?`)
    ) {
      return;
    }
    addRows(
      loras.map((l) => ({ name: l.file_name, modelName: l.model_name })),
      { autofill: true }
    );
  }

  // ---- config modal ----
  function openConfigModal(row, onSaved) {
    const fields = [
      { key: "displayName", label: "Display Name (blank = original filename)", type: "text" },
      { key: "min", label: "Strength Min", type: "number", step: "0.1" },
      { key: "max", label: "Strength Max", type: "number", step: "0.1" },
      { key: "step", label: "Step", type: "number", step: "0.01" },
      { key: "lowLabel", label: "Low / negative means…", type: "text" },
      { key: "highLabel", label: "High / positive means…", type: "text" },
    ];
    const apply = (values) => {
      const min = parseFloat(values.min);
      const max = parseFloat(values.max);
      row.displayName = String(values.displayName || "").trim();
      // Ignore an emptied or inverted min/max instead of breaking the slider.
      if (Number.isFinite(min) && Number.isFinite(max) && min !== max) {
        row.min = Math.min(min, max);
        row.max = Math.max(min, max);
      }
      row.step = Math.max(0.0001, parseFloat(values.step) || DEFAULTS.step);
      row.lowLabel = values.lowLabel;
      row.highLabel = values.highLabel;
      row.value = clamp(row.value, row.min, row.max);
      row.autofilled = false;
      onSaved();
    };
    modal(`Configure: ${row.modelName || row.name}`, fields, row, apply, {
      label: "Save as preset",
      title: `Save, and remember these settings for this LoRA in every workflow (${PRESETS_FILE} in ComfyUI's user folder)`,
      onClick: (values) => {
        apply(values);
        savePreset(row).then(
          () => setStatus(`Saved preset for ${row.modelName || row.name}.`),
          (e) => setStatus(`Could not save preset (${e.message}); the presets file was left untouched.`)
        );
      },
    });
  }

  // ---- picker modal ----
  async function openPickerModal(onAdd) {
    const overlay = makeOverlay();
    const box = document.createElement("div");
    box.className = "ls-modal";
    box.innerHTML = `
      <h3>Add LoRAs</h3>
      <select class="ls-search ls-folder" title="Show every LoRA in one folder (and its subfolders)"><option value="">All folders</option></select>
      <input class="ls-search" type="text" placeholder="Search by name or path, e.g. turbo/slider ..." autocomplete="off">
      <div class="ls-picker-hint">Pick a folder to list everything in it, then "Select all shown" and untick what you do not want.</div>
      <div class="ls-picker-bulk">
        <button class="ls-cancel ls-all">Select all shown</button>
        <button class="ls-cancel ls-none">Select none</button>
        <span class="ls-count"></span>
      </div>
      <div class="ls-picker-list">Loading...</div>
      <div class="ls-modal-actions">
        <button class="ls-cancel">Cancel</button>
        <button class="ls-confirm">Add selected</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const searchEl = box.querySelector(".ls-search");
    const listEl = box.querySelector(".ls-picker-list");
    const folderEl = box.querySelector(".ls-folder");
    const countEl = box.querySelector(".ls-count");
    const selected = new Map();
    let shown = []; // checkboxes currently listed
    let loadSeq = 0;

    const updateCount = () => {
      countEl.textContent = `${selected.size} selected, ${shown.length} shown`;
    };
    const setAllShown = (checked) => {
      for (const cb of shown) {
        cb.checked = checked;
        cb.onchange();
      }
    };
    box.querySelector(".ls-all").onclick = () => setAllShown(true);
    box.querySelector(".ls-none").onclick = () => setAllShown(false);

    lmFetchJson("/api/lm/loras/folders").then((data) => {
      for (const folder of ((data && data.folders) || []).filter(Boolean).sort()) {
        const opt = document.createElement("option");
        opt.value = opt.textContent = folder;
        folderEl.appendChild(opt);
      }
    });

    async function load() {
      const seq = ++loadSeq;
      const folder = folderEl.value;
      listEl.textContent = "Loading...";
      // Use the relative-paths endpoint: it matches search tokens as substrings against
      // the full relative path (folder + name). Treat "/" and "\" as token separators so
      // "turbo/slider" => tokens ["turbo","slider"], both required (AND) anywhere in path.
      const tokens = searchEl.value.trim().replace(/[\\/]+/g, " ");
      // LM caps a page at 100. A chosen folder is listed in full (bounded: 10 pages);
      // an unscoped search stays at one page.
      const PAGE = 100;
      const maxPages = folder ? 10 : 1;
      let paths = [];
      for (let page = 0; page < maxPages; page++) {
        const data = await lmFetchJson(
          `/api/lm/loras/relative-paths?limit=${PAGE}&offset=${page * PAGE}` +
            `&search=${encodeURIComponent(tokens)}` +
            (folder ? `&folder=${encodeURIComponent(folder)}` : "")
        );
        const batch = (data && data.relative_paths) || [];
        paths = paths.concat(batch);
        if (batch.length < PAGE) break;
      }
      if (seq !== loadSeq) return; // a newer search or folder change superseded this one
      if (folder) paths.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" }));
      listEl.innerHTML = "";
      shown = [];
      if (!paths.length) {
        listEl.textContent = "No matches.";
        updateCount();
        return;
      }
      for (const rel of paths) {
        const name = stripExtension(String(rel)).replace(/\\/g, "/");
        if (!name) continue;
        const leaf = name.split("/").pop();
        const rowEl = document.createElement("label");
        rowEl.className = "ls-picker-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(name);
        cb.onchange = () => {
          if (cb.checked) {
            selected.set(name, { name, modelName: leaf, filePath: "" });
          } else {
            selected.delete(name);
          }
          updateCount();
        };
        shown.push(cb);
        const text = document.createElement("span");
        text.textContent = name;
        rowEl.appendChild(cb);
        rowEl.appendChild(text);
        listEl.appendChild(rowEl);
      }
      updateCount();
    }

    let debounce;
    searchEl.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, 200);
    };
    folderEl.onchange = load;

    box.querySelector(".ls-modal-actions .ls-cancel").onclick = () => overlay.remove();
    box.querySelector(".ls-confirm").onclick = () => {
      onAdd(Array.from(selected.values()), { autofill: true });
      overlay.remove();
    };
    overlay.onmousedown = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    await load();
    searchEl.focus();
  }

  // ---- generic modal builder ----
  function makeOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "ls-overlay";
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") overlay.remove();
    });
    return overlay;
  }

  function modal(titleText, fields, source, onSave, extra) {
    const overlay = makeOverlay();
    const box = document.createElement("div");
    box.className = "ls-modal";
    const h = document.createElement("h3");
    h.textContent = titleText;
    box.appendChild(h);

    const inputs = {};
    for (const f of fields) {
      const wrap = document.createElement("div");
      wrap.className = "ls-field";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = f.type;
      if (f.step) input.step = f.step;
      input.value = source[f.key];
      wrap.appendChild(label);
      wrap.appendChild(input);
      box.appendChild(wrap);
      inputs[f.key] = input;
    }

    const actions = document.createElement("div");
    actions.className = "ls-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "ls-cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = () => overlay.remove();
    const save = document.createElement("button");
    save.className = "ls-confirm";
    save.textContent = "Save";
    const submit = (handler) => () => {
      const values = {};
      for (const k in inputs) values[k] = inputs[k].value;
      handler(values);
      overlay.remove();
    };
    save.onclick = submit(onSave);
    actions.appendChild(cancel);
    if (extra) {
      const extraBtn = document.createElement("button");
      extraBtn.className = "ls-cancel";
      extraBtn.textContent = extra.label;
      extraBtn.title = extra.title || "";
      extraBtn.onclick = submit(extra.onClick);
      actions.appendChild(extraBtn);
    }
    actions.appendChild(save);
    box.appendChild(actions);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") save.click();
    });

    overlay.appendChild(box);
    overlay.onmousedown = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    document.body.appendChild(overlay);
  }

  // ---- the DOM widget ----
  const widget = node.addDOMWidget(inputName, "loraslider", container, {
    getValue() {
      return rows;
    },
    setValue(v) {
      rows = Array.isArray(v) ? v.map(normalizeRow) : [];
      render();
    },
    serialize: true,
    hideOnZoom: false,
  });

  widget.value = rows;
  widget.onRemove = () => container.remove();

  render();
  return { widget, minWidth: 480, minHeight: 160 };
}

// ===========================================================================
// Extension registration
// ===========================================================================

app.registerExtension({
  name: "Wonderflex.LoraSlider",

  getCustomWidgets() {
    return {
      LORA_SLIDERS(node, inputName) {
        return createSlidersWidget(node, inputName);
      },
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      this.serialize_widgets = true;
      if (!this.size || this.size[0] < 480) this.size = [520, 320];
    });
  },
});
