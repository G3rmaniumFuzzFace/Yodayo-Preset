// Yodayo Preset - page-world script (Chrome extension build).
// Converted from the "Yodayo Preset" Violentmonkey userscript. Differences:
//  * presets are stored by the extension (via bridge.js -> chrome.storage.local), not by GM_* functions
//  * the toolbar icon / Alt+Shift+P toggles the panel (the "P" tab on the left still works)
(() => {
  "use strict";
  if (window.__ysp2ext) return;
  window.__ysp2ext = true;

  /* ================= storage (kept by the extension, bridged from the page) ================= */
  const LIB_KEY = "ysp2_lib", KEEP_KEY = "ysp2_keep", PEND_KEY = "ysp2_pending", OPT_KEY = "ysp2_opts";
  const TAG_PAGE = "ysp2-page", TAG_EXT = "ysp2-ext";

  const post = (msg) => {
    try { window.postMessage(Object.assign({ source: TAG_PAGE }, msg), location.origin); } catch (_) {}
  };

  let store = {};          // in-memory copy of everything we persist
  let ready = false;       // true once the bridge has sent the stored data
  const dirty = new Set(); // keys written before the bridge answered (flushed after merging)

  const gmGet = (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]);
  const gmSet = (k, v) => {
    store[k] = v;
    if (ready) post({ type: "set", key: k, value: v });
    else dirty.add(k);
  };

  let lib = { presets: {}, updatedAt: 0 };
  const saveLib = () => { lib.updatedAt = Date.now(); gmSet(LIB_KEY, lib); };

  // models actually used (persisted, small) and every model seen this page session (memory only)
  let keep = {};
  const mem = new Map();

  /* ================= slimming ================= */
  const slimModel = (m) => {
    const o = {};
    for (const k of Object.keys(m)) {
      if (k === "model_versions" || k === "user_profile" || k === "photos") continue;
      o[k] = m[k];
    }
    if (typeof o.description === "string") o.description = o.description.slice(0, 300);
    return o;
  };
  const slimVersion = (v) => {
    const o = { ...v };
    if (typeof o.description === "string") o.description = o.description.slice(0, 300);
    if (Array.isArray(o.files)) o.files = o.files.map((f) => { const c = { ...f }; delete c.object_hash; return c; });
    return o;
  };

  /* ================= watch the site's own traffic ================= */
  let lastForm = null;
  const looksLikeForm = (o) => o && typeof o === "object" && "sampling_steps" in o && "prompt" in o && "model_version_uuid" in o;

  function put(vu, m, v) {
    const prev = mem.get(vu);
    if (prev && prev.v.base_model && !v.base_model) return;
    mem.set(vu, { m, v });
  }
  function idx(n, d) {
    d = d || 0;
    if (!n || typeof n !== "object" || d > 7) return;
    if (Array.isArray(n)) { for (const x of n) idx(x, d + 1); return; }
    if (n.uuid && Array.isArray(n.model_versions) && n.model_type) {
      for (const v of n.model_versions) if (v && v.uuid) put(v.uuid, n, v);
    } else if (n.uuid && n.model_version && n.model_version.uuid && n.model_type) {
      put(n.model_version.uuid, n, n.model_version);
    }
    for (const k of Object.keys(n)) { const x = n[k]; if (x && typeof x === "object") idx(x, d + 1); }
  }

  let keepTimer;
  const persistKeep = () => { clearTimeout(keepTimer); keepTimer = setTimeout(() => gmSet(KEEP_KEY, keep), 1200); };
  // remember full data for whatever the form uses right now
  function touch() {
    if (!lastForm) return;
    const ids = [lastForm.model_version_uuid, ...(lastForm.extra_networks || []).map((e) => e.model_version_uuid)];
    let changed = false;
    for (const id of ids) {
      const e = mem.get(id);
      if (e && e.v.base_model) { keep[id] = { m: slimModel(e.m), v: slimVersion(e.v) }; changed = true; }
    }
    if (changed) persistKeep();
  }
  function resolve(id) {
    const e = mem.get(id);
    if (e && e.v.base_model) return { m: slimModel(e.m), v: slimVersion(e.v) };
    return keep[id] || null;
  }

  function remember(body) {
    if (typeof body !== "string" || body.length < 20 || body[0] !== "{") return;
    try { const o = JSON.parse(body); if (looksLikeForm(o)) { lastForm = o; touch(); } } catch (_) {}
  }
  let idxTimer;
  function onResponse(text) {
    if (typeof text !== "string" || text.length < 50 || text.length > 8e6) return;
    if (!text.includes('"model_versions"') && !text.includes('"model_version"')) return;
    try { idx(JSON.parse(text)); } catch (_) { return; }
    clearTimeout(idxTimer);
    idxTimer = setTimeout(touch, 400);
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { remember(init && init.body); } catch (_) {}
    const p = origFetch.apply(this, arguments);
    try {
      p.then((res) => {
        try {
          if (/json/i.test(res.headers.get("content-type") || "")) res.clone().text().then(onResponse).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
    } catch (_) {}
    return p;
  };
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try { remember(body); } catch (_) {}
    try {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") onResponse(this.responseText);
          else if (this.responseType === "json" && this.response) onResponse(JSON.stringify(this.response));
        } catch (_) {}
      });
    } catch (_) {}
    return xSend.apply(this, arguments);
  };

  /* ================= save ================= */
  function readSamplerDisplay() {
    try {
      const lab = [...document.querySelectorAll("p,span,label,div")].find(
        (e) => !e.children.length && /^Sampling Methods?$/i.test((e.textContent || "").trim()) && e.offsetParent !== null);
      if (!lab) return null;
      for (let n = lab.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) {
        const b = [...n.querySelectorAll("button")].find((x) => x.offsetParent !== null && (x.textContent || "").trim() && !lab.contains(x));
        if (b) return b.textContent.trim();
      }
    } catch (_) {}
    return null;
  }

  function buildPreset(name) {
    const f = lastForm;
    if (!f) return { error: "ยังไม่เห็นค่าฟอร์ม เปลี่ยนค่าอะไรก็ได้ในฟอร์มหนึ่งครั้ง (เช่น Steps แล้วเปลี่ยนกลับ) แล้วกด Save อีกที" };
    const model = resolve(f.model_version_uuid);
    if (!model) return { error: "ยังไม่มีข้อมูลโมเดลที่เลือกอยู่ในความจำ ลองกดเลือกโมเดลนั้นใหม่จากรายการ Model Hub แล้วกด Save อีกที" };
    const spells = [], missing = [];
    for (const en of f.extra_networks || []) {
      const r = resolve(en.model_version_uuid);
      if (r) spells.push({ m: r.m, v: r.v, strength: en.strength });
      else missing.push(en.model_version_uuid);
    }
    if (missing.length) return { error: `ยังไม่มีข้อมูลของ Spell ${missing.length} ตัว ลองเอา Spell นั้นออกแล้วเลือกใหม่จากรายการ แล้วกด Save อีกที` };
    const ex = Object.values(lib.presets).find((p) => p.name === name);
    return {
      preset: {
        id: ex ? ex.id : Date.now().toString(36),
        name,
        updatedAt: Date.now(),
        model,
        spells,
        form: {
          prompt: f.prompt, negative_prompt: f.negative_prompt,
          sampling_steps: f.sampling_steps, sampling_method: f.sampling_method,
          sampling_method_display_name: readSamplerDisplay() || f.sampling_method,
          scheduler: f.scheduler, width: f.width, height: f.height, cfg_scale: f.cfg_scale, seed: f.seed,
          adetailer_settings: f.adetailer_settings || null, enable_hr: f.enable_hr,
        },
        quality: (() => { try { return localStorage.getItem("isQualityTagEnabledPreference"); } catch (_) { return null; } })(),
      },
      replaced: !!ex,
    };
  }

  /* ================= load ================= */
  function buildKey(p, opts) {
    const f = p.form, cur = lastForm;
    const keepCurrent = opts && opts.prompt === false && cur;
    return {
      model: `${p.model.m.name}/${p.model.v.name}`,
      model_display_name: `${p.model.m.display_name || p.model.m.name} ${p.model.v.name}`,
      model_version_uuid: p.model.v.uuid,
      model_uuid: p.model.m.uuid,
      extra_networks: p.spells.map((s) => ({ ...s.m, model_version: s.v, strength: s.strength })),
      prompt: keepCurrent ? cur.prompt : f.prompt,
      negative_prompt: keepCurrent ? cur.negative_prompt : f.negative_prompt,
      sampling_steps: f.sampling_steps,
      sampling_method: f.sampling_method,
      sampling_method_display_name: f.sampling_method_display_name || f.sampling_method,
      scheduler: f.scheduler,
      width: f.width, height: f.height, cfg_scale: f.cfg_scale, seed: f.seed,
    };
  }

  function loadPreset(p, opts) {
    const key = buildKey(p, opts);
    // so a later Save still finds this model / these spells
    keep[p.model.v.uuid] = p.model;
    for (const s of p.spells) keep[s.v.uuid] = { m: s.m, v: s.v };
    gmSet(KEEP_KEY, keep);
    gmSet(PEND_KEY, { name: p.name, at: Date.now() });
    localStorage.setItem("temp_image_gen_settings", JSON.stringify(key));
    if (p.quality != null) localStorage.setItem("isQualityTagEnabledPreference", p.quality);
    // short delay so the extension has time to store the pending note before the page reloads
    setTimeout(() => { location.href = "/text-to-image?disable_hires=true"; }, 200);
  }

  /* ================= UI ================= */
  const C = { bg: "#1b1d2a", card: "#232536", btn: "#6366f1", sec: "#2e3146", danger: "#8b1e2d", text: "#e8e9f0", mut: "#9a9db4" };
  const h = (tag, style, props, ...kids) => {
    const el = document.createElement(tag);
    if (style) Object.assign(el.style, style);
    if (props) Object.assign(el, props);
    for (const k of kids) if (k != null) el.append(k);
    return el;
  };
  const btn = (text, bg, onclick, extra) =>
    h("button", Object.assign({ padding: "10px 14px", border: "0", borderRadius: "10px", background: bg,
      color: "#fff", fontWeight: "600", fontSize: "14px", cursor: "pointer" }, extra || {}), { textContent: text, onclick });

  const opts = { prompt: true };
  const nameInput = h("input", { flex: "1", minWidth: "0", padding: "10px", borderRadius: "10px",
    border: "1px solid #3a3d52", background: C.card, color: C.text, fontSize: "16px" },
    { type: "text", placeholder: "ตั้งชื่อ Preset..." });
  const promptCb = h("input", { width: "18px", height: "18px" }, { type: "checkbox", checked: opts.prompt });
  promptCb.onchange = () => { opts.prompt = promptCb.checked; gmSet(OPT_KEY, opts); };
  const statusEl = h("div", { fontSize: "12px", color: C.mut, margin: "8px 0" });
  const listBox = h("div");
  const logEl = h("pre", { whiteSpace: "pre-wrap", margin: "10px 0 0", padding: "8px", background: "#14151f",
    borderRadius: "8px", fontSize: "12px", display: "none", maxHeight: "30vh", overflow: "auto" });
  const ioBox = h("textarea", { width: "100%", boxSizing: "border-box", height: "90px", marginTop: "8px",
    background: C.card, color: C.text, border: "1px solid #3a3d52", borderRadius: "8px", fontSize: "12px",
    display: "none" }, { placeholder: "วาง JSON ที่นี่เพื่อ Import" });
  const log = (t) => { logEl.textContent = t || ""; logEl.style.display = t ? "block" : "none"; };

  const panel = h("div", { position: "fixed", left: "0", right: "0", bottom: "0", maxHeight: "82vh", maxWidth: "560px",
    margin: "0 auto", overflowY: "auto", background: C.bg, color: C.text, padding: "14px", boxSizing: "border-box",
    borderRadius: "16px 16px 0 0", boxShadow: "0 -4px 24px rgba(0,0,0,.6)", zIndex: "2147483600",
    display: "none", font: "14px/1.4 system-ui, sans-serif" });
  const toast = h("div", { position: "fixed", top: "8px", left: "8px", right: "8px", maxWidth: "560px", margin: "0 auto",
    zIndex: "2147483601", background: C.bg, color: C.text, border: "1px solid #3a3d52", borderRadius: "10px",
    padding: "10px", font: "13px/1.45 system-ui, sans-serif", whiteSpace: "pre-wrap", display: "none",
    boxShadow: "0 4px 18px rgba(0,0,0,.6)" }, { onclick: () => { toast.style.display = "none"; } });
  let toastTimer;
  const showToast = (t, sticky) => {
    toast.textContent = t + "\n(แตะเพื่อปิด)";
    toast.style.display = "block";
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.style.display = "none"; }, 9000);
  };

  function refreshStatus() {
    if (!lastForm) { statusEl.textContent = "ยังไม่เห็นค่าฟอร์ม (เปลี่ยนค่าในฟอร์มหนึ่งครั้งเพื่อให้ตรวจจับ)"; return; }
    const m = resolve(lastForm.model_version_uuid);
    const n = (lastForm.extra_networks || []).length;
    const ok = (lastForm.extra_networks || []).filter((e) => resolve(e.model_version_uuid)).length;
    statusEl.textContent = `ตรวจจับฟอร์มแล้ว • โมเดล ${m ? "พร้อมเซฟ" : "ยังไม่มีข้อมูล"} • Spells ${ok}/${n} พร้อมเซฟ`;
  }
  const setPanel = (on) => { panel.style.display = on ? "block" : "none"; if (on) refreshStatus(); };
  const togglePanel = () => setPanel(panel.style.display === "none");

  const summary = (p) => `${p.model.m.display_name || p.model.m.name} ${p.model.v.name} • ${p.form.width}×${p.form.height} • ${p.spells.length} Spells`;

  function render() {
    listBox.textContent = "";
    const items = Object.values(lib.presets).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!items.length) {
      listBox.append(h("div", { color: C.mut, textAlign: "center", padding: "10px" }, { textContent: "ยังไม่มี preset" }));
      return;
    }
    for (const p of items) {
      const info = h("div", { flex: "1", minWidth: "0" }, null,
        h("div", { fontWeight: "700", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, { textContent: p.name }),
        h("div", { fontSize: "11px", color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, { textContent: summary(p) }));
      listBox.append(h("div", { display: "flex", alignItems: "center", gap: "8px", padding: "10px", marginBottom: "8px",
        background: C.card, borderRadius: "10px" }, null,
        info,
        btn("Load", C.btn, () => { try { loadPreset(p, opts); } catch (e) { log("✗ " + e.message); } }),
        btn("✕", C.danger, () => {
          if (!confirm(`ลบ preset "${p.name}" ?`)) return;
          delete lib.presets[p.id]; saveLib(); render();
        }, { padding: "10px 12px" })));
    }
  }

  function doSave() {
    refreshStatus();
    if (!ready) { log("✗ ตัวเก็บข้อมูลของ extension ยังไม่พร้อม รอสักครู่หรือรีเฟรชหน้า แล้วกด Save อีกที"); return; }
    const name = nameInput.value.trim() || "Preset " + new Date().toTimeString().slice(0, 5);
    const r = buildPreset(name);
    if (r.error) { log("✗ " + r.error); return; }
    lib.presets[r.preset.id] = r.preset;
    saveLib(); render(); nameInput.value = "";
    const notes = [];
    if (r.preset.form.adetailer_settings) notes.push("ADetailer ยังไม่รองรับการโหลด (เก็บค่าไว้เฉย ๆ)");
    if (r.preset.form.enable_hr) notes.push("Hires.fix ยังไม่รองรับการโหลด");
    log(`บันทึก "${name}" แล้ว${r.replaced ? " (ทับของเดิม)" : ""}\n${summary(r.preset)}` + (notes.length ? "\n• " + notes.join("\n• ") : ""));
  }

  async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch (_) { return false; } }
  async function doExport() {
    const t = JSON.stringify(lib);
    ioBox.value = t; ioBox.style.display = "block";
    log((await copyText(t)) ? "คัดลอก JSON ไปที่ clipboard แล้ว วางในอีกเครื่องแล้วกด Import ได้เลย"
                            : "คัดลอกอัตโนมัติไม่ได้ กดค้างในกล่อง > เลือกทั้งหมด > คัดลอก");
  }
  function doImport() {
    if (ioBox.style.display === "none" || !ioBox.value.trim()) {
      ioBox.style.display = "block"; ioBox.value = "";
      log("วาง JSON ลงในกล่อง แล้วกด Import อีกครั้ง");
      return;
    }
    try {
      const j = JSON.parse(ioBox.value);
      let n = 0;
      for (const p of Object.values(j.presets || {})) {
        if (!p || !p.id || !p.model || !p.form) continue;
        const cur = lib.presets[p.id];
        if (!cur || (p.updatedAt || 0) > cur.updatedAt) { lib.presets[p.id] = p; n++; }
      }
      saveLib(); render(); ioBox.value = ""; ioBox.style.display = "none";
      log(`นำเข้า ${n} preset`);
    } catch (e) { log("✗ JSON ไม่ถูกต้อง: " + e.message); }
  }
  async function doDiag() {
    const f = lastForm;
    const info = {
      build: "chrome-extension",
      storageReady: ready,
      hasForm: !!f,
      formKeys: f ? Object.keys(f) : null,
      modelResolved: f ? !!resolve(f.model_version_uuid) : null,
      spells: f ? (f.extra_networks || []).map((e) => !!resolve(e.model_version_uuid)) : null,
      seenThisSession: mem.size,
      persisted: Object.keys(keep).length,
      presets: Object.keys(lib.presets).length,
      samplerDisplay: readSamplerDisplay(),
      quality: (() => { try { return localStorage.getItem("isQualityTagEnabledPreference"); } catch (_) { return null; } })(),
    };
    const t = JSON.stringify(info, null, 2);
    ioBox.value = t; ioBox.style.display = "block";
    log((await copyText(t)) ? "คัดลอกผลตรวจแล้ว วางส่งในแชทได้เลย" : "คัดลอกอัตโนมัติไม่ได้ เลือกทั้งหมดในกล่องแล้วคัดลอกเอง");
  }

  function buildPanel() {
    panel.append(
      h("div", { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }, null,
        h("b", { fontSize: "15px" }, { textContent: "Yodayo Preset" }),
        btn("✕", C.sec, () => setPanel(false), { padding: "6px 12px" })),
      h("div", { display: "flex", gap: "8px" }, null, nameInput, btn("Save", C.btn, doSave)),
      statusEl,
      h("label", { display: "flex", alignItems: "center", gap: "8px", margin: "0 0 12px" }, null, promptCb, "โหลด Prompt / Negative ด้วย (ปิด = คง prompt ปัจจุบันไว้)"),
      listBox,
      h("div", { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", marginTop: "4px" }, null,
        btn("Export", C.sec, doExport), btn("Import", C.sec, doImport), btn("Diagnose", C.sec, doDiag)),
      ioBox, logEl);
    render();
  }

  const tab = h("div", { position: "fixed", left: "0", top: "42%", width: "30px", height: "48px",
    background: C.btn, color: "#fff", opacity: "0.7", borderRadius: "0 12px 12px 0", display: "flex",
    alignItems: "center", justifyContent: "center", zIndex: "2147483599", font: "800 16px system-ui, sans-serif",
    userSelect: "none", cursor: "pointer" }, { textContent: "P", onclick: togglePanel });

  function afterLoadCheck() {
    const pend = gmGet(PEND_KEY, null);
    if (!pend) return;
    gmSet(PEND_KEY, null);
    if (Date.now() - pend.at > 60000) return;
    setTimeout(() => {
      let left = null;
      try { left = localStorage.getItem("temp_image_gen_settings"); } catch (_) {}
      showToast(left ? `โหลด "${pend.name}" แล้ว แต่เว็บยังไม่ได้อ่านค่า ลองรีเฟรชหน้าอีกครั้ง` : `โหลด "${pend.name}" แล้ว ✓`, !!left);
    }, 3500);
  }

  /* ================= talking to the extension's storage bridge ================= */
  let mounted = false, afterDone = false;
  function maybeAfterLoad() {
    if (afterDone || !mounted || !ready) return;
    afterDone = true;
    afterLoadCheck();
  }

  function applyInit(d) {
    // anything written before the bridge answered wins over the stored copy
    store = Object.assign({}, d, store);
    const l = d[LIB_KEY];
    if (l && l.presets) {
      for (const [id, p] of Object.entries(lib.presets)) if (!l.presets[id]) l.presets[id] = p;
      lib = l;
    }
    keep = Object.assign({}, d[KEEP_KEY] || {}, keep);
    Object.assign(opts, d[OPT_KEY] || {});
    promptCb.checked = opts.prompt;
    store[LIB_KEY] = lib;
    store[KEEP_KEY] = keep;
    ready = true;
    for (const k of dirty) post({ type: "set", key: k, value: store[k] });
    dirty.clear();
    render();
    maybeAfterLoad();
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.source !== TAG_EXT) return;
    if (m.type === "init" && !ready) applyInit(m.data || {});
    else if (m.type === "toggle") togglePanel();
  });

  const hello = () => { if (!ready) post({ type: "hello" }); };
  hello();
  document.addEventListener("DOMContentLoaded", hello);
  setTimeout(hello, 1000);
  setTimeout(hello, 3000);
  setTimeout(() => {
    if (!ready) showToast("Yodayo Preset: ตัวเก็บข้อมูลของ extension ยังไม่ตอบ ลองรีเฟรชหน้า (ถ้ายังไม่ได้ ให้ตรวจว่า extension เปิดอยู่ใน chrome://extensions)", true);
  }, 7000);

  function mount() {
    if (!document.body) return setTimeout(mount, 150);
    buildPanel();
    document.body.append(tab, panel, toast);
    setInterval(() => { if (!document.body.contains(tab)) document.body.append(tab, panel, toast); }, 3000);
    mounted = true;
    maybeAfterLoad();
  }
  mount();
})();
