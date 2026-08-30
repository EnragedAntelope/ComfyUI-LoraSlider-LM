import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parseStrengthHints } from "./strength_parser.js";

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

// Resolve an absolute file_path for a LoRA name via LM's listing route.
async function resolveFilePath(name) {
  const leaf = name.split("/").pop();
  const data = await lmFetchJson(
    `/api/lm/loras/list?page=1&page_size=100&search=${encodeURIComponent(leaf)}`
  );
  const items = (data && (data.items || data.data || data.loras)) || [];
  for (const card of items) {
    if (nameFromCard(card) === name || stripExtension(card.file_name || "") === leaf) {
      return card.file_path || card.filePath || "";
    }
  }
  return "";
}

// Fetch the description for a LoRA and parse suggested min/max + labels into the row.
// Only fills fields the user hasn't already customized away from defaults.
async function autofillRowFromMetadata(row, renderRow) {
  try {
    let filePath = row.filePath;
    if (!filePath) filePath = await resolveFilePath(row.name);
    if (!filePath) return;
    row.filePath = filePath;

    const data = await lmFetchJson(
      `/api/lm/loras/model-description?file_path=${encodeURIComponent(filePath)}`
    );
    const description = data && data.success ? data.description : "";
    if (!description) return;

    const hints = parseStrengthHints(description);
    if (hints.min != null && hints.max != null) {
      row.min = hints.min;
      row.max = hints.max;
      row.value = clamp(row.value, row.min, row.max);
    }
    if (hints.lowLabel) row.lowLabel = hints.lowLabel;
    if (hints.highLabel) row.highLabel = hints.highLabel;
    row.autofilled = true;
    if (renderRow) renderRow();
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
      e.dataTransfer.setData("text/plain", String(index));
      el.classList.add("ls-dragging");
    };
    dragHandle.ondragend = () => el.classList.remove("ls-dragging");
    el.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("ls-drag-over");
    };
    el.ondragleave = () => el.classList.remove("ls-drag-over");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("ls-drag-over");
      const from = Number.parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (!Number.isInteger(from) || from < 0 || from >= rows.length || from === index) return;
      const [moved] = rows.splice(from, 1);
      rows.splice(index, 0, moved);
      render();
      commit();
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
    title.title = row.name + (row.autofilled ? "  (range auto-filled from metadata)" : "");
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
    if (!autofill || !created.length) return;

    if (created.length > AUTOFILL_MAX_ROWS) {
      setStatus(
        `Added ${created.length} LoRAs. Skipped metadata auto-fill (too many) — set ranges with the ⚙ button.`
      );
      return;
    }

    // Throttled so we never flood LoRA Manager's server.
    setStatus(`Auto-filling strength ranges 0/${created.length}…`);
    runWithConcurrency(
      created,
      (row) => autofillRowFromMetadata(row, null),
      AUTOFILL_CONCURRENCY,
      (doneCount, total) => {
        render();
        setStatus(doneCount < total ? `Auto-filling strength ranges ${doneCount}/${total}…` : "");
      }
    ).then(() => {
      render();
      commit();
      setStatus("");
    });
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
    modal(`Configure: ${row.modelName || row.name}`, fields, row, (values) => {
      row.displayName = String(values.displayName || "").trim();
      row.min = parseFloat(values.min);
      row.max = parseFloat(values.max);
      row.step = Math.max(0.0001, parseFloat(values.step) || DEFAULTS.step);
      row.lowLabel = values.lowLabel;
      row.highLabel = values.highLabel;
      row.value = clamp(row.value, row.min, row.max);
      row.autofilled = false;
      onSaved();
    });
  }

  // ---- picker modal ----
  async function openPickerModal(onAdd) {
    const overlay = makeOverlay();
    const box = document.createElement("div");
    box.className = "ls-modal";
    box.innerHTML = `
      <h3>Add LoRAs</h3>
      <input class="ls-search" type="text" placeholder="Search by name or path, e.g. turbo/slider …" autocomplete="off">
      <div class="ls-picker-hint">Tip: include a “/” to match folders — “turbo/slider” finds LoRAs whose path contains both.</div>
      <div class="ls-picker-list">Loading…</div>
      <div class="ls-modal-actions">
        <button class="ls-cancel">Cancel</button>
        <button class="ls-confirm">Add selected</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const searchEl = box.querySelector(".ls-search");
    const listEl = box.querySelector(".ls-picker-list");
    const selected = new Map();

    async function load(search) {
      listEl.textContent = "Loading…";
      // Use the relative-paths endpoint: it matches search tokens as substrings against
      // the full relative path (folder + name). Treat "/" and "\" as token separators so
      // "turbo/slider" => tokens ["turbo","slider"], both required (AND) anywhere in path.
      const tokens = (search || "").trim().replace(/[\\/]+/g, " ");
      const data = await lmFetchJson(
        `/api/lm/loras/relative-paths?limit=100&search=${encodeURIComponent(tokens)}`
      );
      const paths = (data && data.relative_paths) || [];
      listEl.innerHTML = "";
      if (!paths.length) {
        listEl.textContent = "No matches.";
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
        };
        const text = document.createElement("span");
        text.textContent = name;
        rowEl.appendChild(cb);
        rowEl.appendChild(text);
        listEl.appendChild(rowEl);
      }
    }

    let debounce;
    searchEl.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => load(searchEl.value), 200);
    };

    box.querySelector(".ls-cancel").onclick = () => overlay.remove();
    box.querySelector(".ls-confirm").onclick = () => {
      onAdd(Array.from(selected.values()), { autofill: true });
      overlay.remove();
    };
    overlay.onmousedown = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    await load("");
    searchEl.focus();
  }

  // ---- generic modal builder ----
  function makeOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "ls-overlay";
    return overlay;
  }

  function modal(titleText, fields, source, onSave) {
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
    save.onclick = () => {
      const values = {};
      for (const k in inputs) values[k] = inputs[k].value;
      onSave(values);
      overlay.remove();
    };
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(actions);

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
