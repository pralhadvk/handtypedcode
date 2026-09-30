/* handtypedcode — editor, replay player, gallery.
   Plain JavaScript, no build step. Talks to Supabase when config.js has keys. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const LANGS = [["javascript","JavaScript"],["typescript","TypeScript"],["python","Python"],["go","Go"],["rust","Rust"],["c","C"],["cpp","C++"],["java","Java"],["kotlin","Kotlin"],["swift","Swift"],["ruby","Ruby"],["php","PHP"],["xml","HTML"],["css","CSS"],["sql","SQL"],["bash","Shell"],["plaintext","Plain text"]];
  const LANG_NAME = Object.fromEntries(LANGS);
  const MAX_INSERT = 16;          // bigger than this in one step = treated as a paste (the server checks this too)
  const PAUSE_CAP = 2000;         // replay shortens pauses to this
  const ACTIVE_CAP = 5000;        // pauses longer than this don't count toward WPM
  const PAGE = 24;
  const DRAFT_KEY = "htc:draft:v2";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SELECT = "id,title,lang,code,stats,rhythm,created_at,author_id,profiles(username,avatar_url)";

  /* ---------------- Supabase ---------------- */
  const CFG = window.HTC_CONFIG || {};
  let sb = null;
  try {
    if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  } catch (e) { console.error("Supabase setup failed", e); }

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s"; return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; };
  const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
  const n = (x) => Number(x || 0).toLocaleString();
  const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isWs = (s) => /^\s+$/.test(s);

  function hl(text, lang) {
    if (window.hljs && lang && lang !== "plaintext" && hljs.getLanguage(lang)) {
      try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch (e) {}
    }
    return esc(text);
  }
  function applyOps(ops, from = "", start = 0, end = ops.length) {
    let t = from;
    for (let i = start; i < end; i++) { const o = ops[i]; t = t.slice(0, o[1]) + o[3] + t.slice(o[1] + o[2]); }
    return t;
  }
  function validOps(ops) {
    return Array.isArray(ops) && ops.every((o) => Array.isArray(o) && o.length === 4 && Number.isFinite(o[0]) && Number.isInteger(o[1]) && Number.isInteger(o[2]) && typeof o[3] === "string");
  }
  // Same formulas as publish_snippet() in supabase/schema.sql
  function stats(ops) {
    let dur = 0, active = 0, typed = 0, deleted = 0, corr = 0, longest = 0, multi = 0;
    for (const [dt, , del, ins] of ops) {
      dur += dt; active += Math.min(dt, ACTIVE_CAP); typed += ins.length; deleted += del;
      if (del > 0) corr++; if (dt > longest) longest = dt; if (ins.length > 1 && !isWs(ins)) multi++;
    }
    const wpm = active > 0 ? Math.round((typed / 5) / (active / 60000)) : 0;
    return { duration: dur, keys: ops.length, typed, deleted, corrections: corr, longestPause: longest, wpm, multi };
  }
  function cumTimes(ops, cap) { const T = []; let t = 0; for (const o of ops) { t += Math.min(o[0], cap); T.push(t); } return T; }
  function rhythm(ops, buckets = 60) {
    const T = cumTimes(ops, PAUSE_CAP), total = T.length ? T[T.length - 1] : 0;
    const ins = new Array(buckets).fill(0), del = new Array(buckets).fill(0);
    ops.forEach((o, i) => { const b = total ? Math.min(buckets - 1, Math.floor((T[i] / total) * buckets)) : 0; ins[b] += o[3].length; del[b] += o[2]; });
    return { ins, del };
  }
  async function sha256(str) {
    try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    catch (e) { return null; }
  }
  function drawTimeline(cv, ops, T, headT) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const mid = Math.round(h * 0.62) + 0.5, ink = tok("--muted"), acc = tok("--accent"), line = tok("--line"), fg = tok("--ink");
    c.strokeStyle = line; c.lineWidth = 1; c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
    if (!ops.length) return;
    const total = T[T.length - 1] || 1, pad = 2, span = w - pad * 2;
    for (let i = 0; i < ops.length; i++) {
      const x = Math.round(pad + (T[i] / total) * span) + 0.5, o = ops[i];
      c.globalAlpha = headT != null && T[i] > headT ? 0.28 : 1;
      if (o[2] > 0) { c.strokeStyle = acc; c.beginPath(); c.moveTo(x, mid); c.lineTo(x, Math.min(h - 1, mid + 4 + Math.min(o[2], 8) * 2)); c.stroke(); }
      if (o[3].length) { c.strokeStyle = ink; c.beginPath(); c.moveTo(x, mid); c.lineTo(x, Math.max(2, mid - 6 - Math.min(o[3].length, 8) * 2)); c.stroke(); }
    }
    c.globalAlpha = 1;
    if (headT != null) { const x = Math.round(pad + Math.min(1, headT / total) * span) + 0.5; c.strokeStyle = fg; c.lineWidth = 2; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  }
  function waveSvg(r) {
    if (!r || !Array.isArray(r.ins) || !Array.isArray(r.del)) return "";
    const N = Math.min(r.ins.length, r.del.length, 120);
    if (!N) return "";
    const maxI = Math.max(1, ...r.ins.slice(0, N).map(Number)), maxD = Math.max(1, ...r.del.slice(0, N).map(Number));
    let s = `<svg class="wave" viewBox="0 0 ${N * 2} 26" preserveAspectRatio="none" aria-hidden="true"><line class="base" x1="0" y1="17" x2="${N * 2}" y2="17"/>`;
    for (let i = 0; i < N; i++) {
      const hi = (Number(r.ins[i]) || 0) / maxI * 15, hd = (Number(r.del[i]) || 0) / maxD * 8;
      if (hi > 0) s += `<rect class="i" x="${i * 2 + 0.3}" y="${(17 - Math.max(hi, 1)).toFixed(2)}" width="1.4" height="${Math.max(hi, 1).toFixed(2)}"/>`;
      if (hd > 0) s += `<rect class="d" x="${i * 2 + 0.3}" y="17" width="1.4" height="${Math.max(hd, 1.2).toFixed(2)}"/>`;
    }
    return s + "</svg>";
  }
  function armButton(btn, label, action) {
    let armed = false, t; const orig = btn.textContent;
    btn.addEventListener("click", () => {
      if (!armed) { armed = true; btn.textContent = label; btn.classList.add("armed"); t = setTimeout(() => { armed = false; btn.textContent = orig; btn.classList.remove("armed"); }, 3500); return; }
      clearTimeout(t); armed = false; btn.textContent = orig; btn.classList.remove("armed"); action();
    });
  }
  function cleanSnip(x) {
    if (!x || typeof x.id !== "string" || typeof x.title !== "string" || typeof x.code !== "string") return null;
    const p = x.profiles && typeof x.profiles === "object" ? x.profiles : {};
    return {
      id: x.id, title: x.title.slice(0, 120), lang: LANG_NAME[x.lang] ? x.lang : "plaintext", code: x.code,
      authorId: x.author_id || null, author: typeof p.username === "string" ? p.username : null,
      createdAt: x.created_at || "", stats: x.stats && typeof x.stats === "object" ? x.stats : {}, rhythm: x.rhythm
    };
  }

  /* ---------------- auth ---------------- */
  let session = null, me = null;
  const authEl = $("#auth"), signinNote = $("#signin-note");

  function renderAuth() {
    authEl.innerHTML = "";
    if (!sb) { signinNote.textContent = ""; return; }
    if (!session) {
      const b = document.createElement("button");
      b.className = "key"; b.type = "button"; b.textContent = "Sign in with GitHub";
      b.addEventListener("click", signIn);
      authEl.append(b);
      signinNote.textContent = "Sign in to publish. Typing and replays work without an account.";
      return;
    }
    signinNote.textContent = "";
    const a = document.createElement("a");
    a.className = "who"; a.href = me ? "/u/" + encodeURIComponent(me.username) : "/"; a.dataset.link = "";
    if (me && me.avatar_url) { const img = document.createElement("img"); img.className = "avatar"; img.alt = ""; img.src = me.avatar_url; a.append(img); }
    const span = document.createElement("span"); span.textContent = me ? "@" + me.username : "Signed in"; a.append(span);
    const out = document.createElement("button");
    out.className = "key"; out.type = "button"; out.textContent = "Sign out";
    out.addEventListener("click", () => sb.auth.signOut());
    authEl.append(a, out);
  }
  async function signIn() {
    saveDraftNow();
    const { error } = await sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.origin + location.pathname } });
    if (error) flash("Couldn't start GitHub sign-in: " + error.message);
  }
  async function loadMe() {
    if (!session) { me = null; renderAuth(); refreshOwnership(); return; }
    const { data } = await sb.from("profiles").select("id,username,avatar_url").eq("id", session.user.id).maybeSingle();
    me = data || null; renderAuth(); refreshOwnership();
  }
  if (sb) sb.auth.onAuthStateChange((_event, s) => { session = s; setTimeout(loadMe, 0); });
  renderAuth();

  /* ---------------- editor ---------------- */
  const ta = $("#f-code"), titleIn = $("#f-title"), langSel = $("#f-lang"), flashEl = $("#flash"), edTl = $("#ed-tl");
  langSel.innerHTML = LANGS.map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  const ed = { ops: [], last: null, prev: "", blocked: 0 };

  let flashT;
  function flash(msg, ok) { flashEl.textContent = msg; flashEl.classList.toggle("ok", !!ok); clearTimeout(flashT); flashT = setTimeout(() => (flashEl.textContent = ""), 5000); }

  function reject(prev, caret, msg) {
    ta.value = prev; ta.selectionStart = ta.selectionEnd = Math.min(caret, prev.length);
    ed.blocked++; flash(msg); renderStatus();
  }
  function record(internal, inputType) {
    const cur = ta.value, prev = ed.prev;
    if (cur === prev) return;
    let s = 0; const minL = Math.min(cur.length, prev.length);
    while (s < minL && cur[s] === prev[s]) s++;
    let e = 0; while (e < minL - s && cur[cur.length - 1 - e] === prev[prev.length - 1 - e]) e++;
    const del = prev.length - s - e, ins = cur.slice(s, cur.length - e);
    const hist = !!inputType && inputType.startsWith("history");
    if (/[\uD800-\uDFFF]/.test(ins)) return reject(prev, s, "Emoji and other special symbols aren't supported yet.");
    if (!internal && !isWs(ins)) {
      if (ins.length > MAX_INSERT) return reject(prev, s, hist ? "Undo brought back too much at once. Retype that part instead." : "That arrived as one big chunk, so it was removed. Type it key by key.");
    }
    const now = performance.now(), dt = ed.last == null ? 0 : Math.round(now - ed.last);
    ed.last = now; ed.ops.push([dt, s, del, ins]); ed.prev = cur;
    renderStatus(); saveDraftSoon();
  }
  ta.addEventListener("input", (e) => record(false, e.inputType));
  ta.addEventListener("beforeinput", (e) => {
    if (/^insertFrom(Paste|Drop|Yank|PasteAsQuotation)$|^insertReplacementText$/.test(e.inputType)) {
      e.preventDefault(); ed.blocked++; flash("Pasting is turned off. Type it out by hand."); renderStatus();
    }
  });
  ta.addEventListener("paste", (e) => e.preventDefault());
  ta.addEventListener("drop", (e) => { e.preventDefault(); ed.blocked++; flash("Dropping text is turned off. Type it out by hand."); renderStatus(); });
  ta.addEventListener("dragover", (e) => e.preventDefault());
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const unit = langSel.value === "python" ? "    " : "  ";
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "Tab" && plain) {
      e.preventDefault(); ta.setRangeText(unit, ta.selectionStart, ta.selectionEnd, "end"); record(true);
    } else if (e.key === "Enter" && plain) {
      const pos = ta.selectionStart, before = ta.value.slice(0, pos), line = before.slice(before.lastIndexOf("\n") + 1);
      let indent = (line.match(/^[ \t]*/) || [""])[0];
      if (/[{[(:]\s*$/.test(line)) indent += unit;
      e.preventDefault(); ta.setRangeText("\n" + indent, pos, ta.selectionEnd, "end"); record(true);
    }
  });

  function renderStatus() {
    const st = stats(ed.ops), on = ed.ops.length > 0;
    $("#ed-status").innerHTML =
      `<span class="rec${on ? " on" : ""}">${on ? "Recording" : "Ready"}</span>` +
      `<span>time <b>${fmtDur(st.duration)}</b></span><span>keys <b>${n(st.keys)}</b></span>` +
      `<span>fixes <b>${n(st.corrections)}</b></span><span>wpm <b>${st.keys > 10 ? st.wpm : "–"}</b></span>` +
      `<span>paste attempts blocked <b>${n(ed.blocked)}</b></span>`;
    drawTimeline(edTl, ed.ops, cumTimes(ed.ops, PAUSE_CAP), null);
    $("#b-preview").disabled = !on;
  }

  let draftT;
  function saveDraftNow() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: titleIn.value, lang: langSel.value, code: ta.value, ops: ed.ops, blocked: ed.blocked })); } catch (e) {}
  }
  function saveDraftSoon() { clearTimeout(draftT); draftT = setTimeout(saveDraftNow, 600); }
  titleIn.addEventListener("input", saveDraftSoon);
  langSel.addEventListener("change", saveDraftSoon);
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && typeof d.code === "string" && validOps(d.ops) && applyOps(d.ops) === d.code) {
      ta.value = d.code; ed.prev = d.code; ed.ops = d.ops; ed.blocked = d.blocked | 0;
      if (typeof d.title === "string") titleIn.value = d.title;
      if (LANG_NAME[d.lang]) langSel.value = d.lang;
    }
  } catch (e) {}

  function resetEditor() {
    ta.value = ""; titleIn.value = ""; ed.ops = []; ed.prev = ""; ed.last = null; ed.blocked = 0;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    renderStatus();
  }
  armButton($("#b-reset"), "Click again to clear", () => { resetEditor(); flash("Cleared. Fresh recording.", true); ta.focus(); });

  $("#b-preview").addEventListener("click", () => {
    showSheet({ title: titleIn.value.trim() || "Your draft", lang: langSel.value, code: ta.value, draft: true }, ed.ops.slice(), false);
  });

  $("#b-publish").addEventListener("click", async () => {
    const btn = $("#b-publish");
    if (!sb) return flash("Publishing isn't set up on this site yet. You can still watch your own replay.");
    if (!session) return flash("Sign in with GitHub to publish. Your draft stays saved in this browser.");
    const code = ta.value, title = titleIn.value.trim();
    if (!title) { titleIn.focus(); return flash("Give your snippet a title first."); }
    if (code.trim().length < 20) return flash("Type at least 20 characters first.");
    const ops = ed.ops.slice();
    if (ops.length < 10) return flash("Type a little more first.");
    if (applyOps(ops) !== code) return flash("The recording fell out of sync with the editor. Start over to record a clean take.");
    btn.disabled = true; btn.textContent = "Publishing…";
    try {
      const { data, error } = await sb.rpc("publish_snippet", { p_title: title, p_lang: langSel.value, p_code: code, p_ops: ops, p_rhythm: rhythm(ops) });
      if (error) throw error;
      resetEditor(); flash("Published. It's in the gallery.", true);
      listKey = null; // force a gallery refresh
      navigate("/s/" + data);
    } catch (e) {
      flash((e && e.message) || "Couldn't publish. Check your connection and try again.");
    } finally { btn.disabled = false; btn.textContent = "Publish"; }
  });

  /* ---------------- gallery ---------------- */
  const grid = $("#grid"), emptyEl = $("#gallery-empty"), moreBtn = $("#b-more");
  let view = { mode: "home" }, listKey = null, filter = "all", seenLangs = new Set();
  let gal = { items: [], done: false, loading: false, token: 0 };

  function setEmpty(title, body) { emptyEl.hidden = false; emptyEl.innerHTML = `<strong>${esc(title)}</strong>${esc(body)}`; }

  async function loadGallery(reset) {
    if (!sb) {
      grid.innerHTML = ""; moreBtn.hidden = true;
      setEmpty("The gallery isn't connected yet", "Add your Supabase keys to config.js to turn on sign-in and the shared gallery. Typing and replays already work.");
      return;
    }
    if (reset) gal = { items: [], done: false, loading: false, token: gal.token + 1 };
    if (gal.loading || gal.done) return;
    const token = gal.token;
    gal.loading = true; moreBtn.disabled = true;
    if (reset) { grid.innerHTML = ""; setEmpty("Loading the gallery…", "Hand-typed snippets appear here once they're published."); }
    let q = sb.from("snippets").select(SELECT).order("created_at", { ascending: false }).range(gal.items.length, gal.items.length + PAGE - 1);
    if (view.mode === "user") q = q.eq("author_id", view.userId);
    if (filter !== "all") q = q.eq("lang", filter);
    const { data, error } = await q;
    if (token !== gal.token) return;
    gal.loading = false; moreBtn.disabled = false;
    if (error) { setEmpty("The gallery couldn't load", "Reload the page to try again."); moreBtn.hidden = true; return; }
    const rows = (data || []).map(cleanSnip).filter(Boolean);
    rows.forEach((r) => seenLangs.add(r.lang));
    gal.items.push(...rows); gal.done = rows.length < PAGE;
    renderGallery();
  }

  function renderGallery() {
    const fEl = $("#filters"), langs = [...seenLangs];
    fEl.innerHTML = langs.length > 1 || filter !== "all"
      ? ["all", ...langs].map((l) => `<button class="key" type="button" data-f="${l}" aria-pressed="${filter === l}">${l === "all" ? "All" : LANG_NAME[l]}</button>`).join("")
      : "";
    grid.innerHTML = "";
    for (const s of gal.items) {
      const st = s.stats, card = document.createElement("div");
      card.setAttribute("role", "button"); card.tabIndex = 0; card.className = "card"; card.dataset.id = s.id;
      card.setAttribute("aria-label", `${s.title}, ${LANG_NAME[s.lang]}. Open replay.`);
      const excerpt = s.code.split("\n").slice(0, 12).join("\n");
      card.innerHTML =
        `<div class="card-head"><div class="meta"><span class="chip">${esc(LANG_NAME[s.lang])}</span>` +
        (s.author ? `<a href="/u/${encodeURIComponent(s.author)}" data-link>@${esc(s.author)}</a>` : `<span>Someone</span>`) +
        `<span>${esc(fmtDate(s.createdAt))}</span></div><h3 class="card-title">${esc(s.title)}</h3></div>` +
        `<pre><code>${hl(excerpt, s.lang)}</code></pre>` +
        `<div class="card-foot">${waveSvg(s.rhythm)}<div class="nums"><span><b>${fmtDur(+st.duration || 0)}</b> typing</span><span><b>${+st.wpm || 0}</b> wpm</span><span><b>${n(st.corrections)}</b> fixes</span></div></div>`;
      grid.appendChild(card);
    }
    moreBtn.hidden = gal.done || !gal.items.length;
    if (gal.items.length) emptyEl.hidden = true;
    else if (filter !== "all") setEmpty(`No ${LANG_NAME[filter]} snippets yet`, "Pick another language, or type one yourself.");
    else if (view.mode === "user") setEmpty("Nothing published yet", "Hand-typed snippets from this person will show up here.");
    else setEmpty("No snippets yet", "Type the first one above. Pasting won't work, so warm up your fingers.");
  }

  $("#filters").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; loadGallery(true); } });
  moreBtn.addEventListener("click", () => loadGallery(false));
  grid.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) { e.preventDefault(); e.target.click(); }
  });
  grid.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const card = e.target.closest(".card"); if (!card) return;
    navigate("/s/" + card.dataset.id);
  });

  /* ---------------- views + routing ---------------- */
  let routeToken = 0;
  function showHome() {
    $("#view-home").hidden = false; $("#view-user").hidden = true;
    document.title = "handtypedcode";
    if (listKey === "home") return;
    listKey = "home"; view = { mode: "home" }; filter = "all"; seenLangs = new Set();
    loadGallery(true);
  }
  async function showUser(name) {
    $("#view-home").hidden = true; $("#view-user").hidden = false;
    document.title = "@" + name + " · handtypedcode";
    if (listKey === "user:" + name) return;
    listKey = "user:" + name; filter = "all"; seenLangs = new Set();
    const my = ++routeToken, av = $("#u-avatar");
    $("#u-name").textContent = "@" + name; $("#u-sub").textContent = "Loading…"; av.hidden = true;
    grid.innerHTML = ""; moreBtn.hidden = true;
    if (!sb) { $("#u-sub").textContent = "Profiles need the gallery to be connected."; loadGallery(true); return; }
    const { data: p } = await sb.from("profiles").select("id,username,avatar_url,created_at").eq("username", name).maybeSingle();
    if (my !== routeToken) return;
    if (!p) { $("#u-sub").textContent = "There's no typist with that name."; setEmpty("Nobody here", "Check the spelling of the name in the address."); return; }
    if (p.avatar_url) { av.src = p.avatar_url; av.hidden = false; }
    const { count } = await sb.from("snippets").select("id", { count: "exact", head: true }).eq("author_id", p.id);
    if (my !== routeToken) return;
    $("#u-sub").textContent = `${n(count)} hand-typed snippet${count === 1 ? "" : "s"} · joined ${fmtDate(p.created_at)}`;
    view = { mode: "user", userId: p.id };
    loadGallery(true);
  }
  function route() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    let m;
    if ((m = path.match(/^\/s\/([^/]+)$/))) { if (!listKey) showHome(); openById(decodeURIComponent(m[1])); return; }
    if (!sheet.hidden) hideSheet();
    if ((m = path.match(/^\/u\/([^/]+)$/))) showUser(decodeURIComponent(m[1]));
    else showHome();
  }
  let pushedSheet = false;
  function navigate(path) {
    if (path === location.pathname) return route();
    pushedSheet = path.startsWith("/s/");
    history.pushState({ htc: 1 }, "", path);
    route();
  }
  window.addEventListener("popstate", () => { pushedSheet = false; route(); });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); navigate(new URL(a.href).pathname);
  });

  async function openById(id) {
    const cached = gal.items.find((x) => x.id === id);
    if (!UUID_RE.test(id) || !sb) {
      showSheet({ title: "Snippet not found", lang: "plaintext", code: "", missing: true }, null, true);
      return;
    }
    const snip = cached || { id, title: "Loading…", lang: "plaintext", code: "", loading: true };
    showSheet(snip, null, true);
    const [s, l] = await Promise.all([
      cached ? Promise.resolve({ data: null }) : sb.from("snippets").select(SELECT).eq("id", id).maybeSingle(),
      sb.from("snippet_logs").select("ops").eq("snippet_id", id).maybeSingle()
    ]);
    if (P.snip !== snip) return;
    let full = cached;
    if (!full) {
      full = s.data ? cleanSnip(s.data) : null;
      if (!full) { showSheet({ title: "Snippet not found", lang: "plaintext", code: "", missing: true }, null, true); return; }
      showSheet(full, null, true);
    }
    const ops = l.data && validOps(l.data.ops) ? l.data.ops : null;
    loadOps(ops);
  }

  /* ---------------- replay sheet ---------------- */
  const sheet = $("#sheet"), pre = $("#sh-pre"), codeEl = $("#sh-code"), shTl = $("#sh-tl"), scrub = $("#sh-scrub"), playBtn = $("#sh-play");
  const P = { snip: null, routed: false, ops: [], T: [], R: [], cps: [], i: 0, vt: 0, playing: false, speed: 2, trim: true, raf: 0, lastTs: 0, returnFocus: null };
  const SPEEDS = [1, 2, 5, 10];
  $("#sh-speeds").innerHTML = SPEEDS.map((s) => `<button class="key" type="button" data-s="${s}" aria-pressed="${s === P.speed}">${s}×</button>`).join("");

  function showSheet(snip, ops, routed) {
    stop();
    if (sheet.hidden) P.returnFocus = document.activeElement;
    P.snip = snip; P.routed = routed;
    $("#sh-title").textContent = snip.title;
    const meta = $("#sh-meta"); meta.innerHTML = "";
    if (!snip.missing && !snip.loading) {
      meta.innerHTML = `<span class="chip">${esc(LANG_NAME[snip.lang] || "Plain text")}</span>` +
        (snip.draft ? `<span>by you</span><span>Unpublished draft</span>`
          : (snip.author ? `<a href="/u/${encodeURIComponent(snip.author)}" data-link>@${esc(snip.author)}</a>` : `<span>Someone</span>`) + `<span>${esc(fmtDate(snip.createdAt))}</span>`);
      document.title = snip.title + " · handtypedcode";
    }
    $("#sh-share").hidden = !snip.id;
    refreshOwnership();
    if (sheet.hidden) { sheet.hidden = false; document.documentElement.style.overflow = "hidden"; sheet.scrollTop = 0; $("#sh-back").focus(); }
    if (ops) { loadOps(ops); return; }
    P.ops = []; scrub.max = 0; playBtn.disabled = true; $("#sh-facts").innerHTML = ""; $("#sh-proof").innerHTML = "";
    $("#sh-clock").textContent = "0:00 / 0:00";
    codeEl.textContent = snip.missing ? "This snippet doesn't exist, or it was deleted." : "Loading the recording…";
    drawTimeline(shTl, [], [], null);
  }
  function hideSheet() {
    stop(); sheet.hidden = true; document.documentElement.style.overflow = ""; P.snip = null;
    document.title = listKey && listKey.startsWith("user:") ? "@" + listKey.slice(5) + " · handtypedcode" : "handtypedcode";
    if (P.returnFocus && P.returnFocus.focus && document.contains(P.returnFocus)) P.returnFocus.focus();
  }
  function closeSheet() {
    if (!P.routed) return hideSheet();
    if (pushedSheet) { history.back(); return; }
    history.pushState({ htc: 1 }, "", listKey && listKey.startsWith("user:") ? "/u/" + encodeURIComponent(listKey.slice(5)) : "/");
    route();
  }
  function refreshOwnership() {
    const s = P.snip;
    $("#sh-del").hidden = !(s && s.id && sb && session && s.authorId === session.user.id);
  }

  async function loadOps(ops) {
    const s = P.snip;
    if (!ops) {
      P.ops = []; codeEl.innerHTML = hl(s.code, s.lang); playBtn.disabled = true; scrub.max = 0;
      $("#sh-proof").innerHTML = `<span class="v bad">Recording unavailable</span><small>The keystroke log for this snippet couldn't be loaded, so it can't be replayed or checked.</small>`;
      renderFacts(s.stats || {}); drawTimeline(shTl, [], [], null); return;
    }
    P.ops = ops; P.R = cumTimes(ops, Infinity); retime();
    P.cps = [""]; let t = "";
    for (let i = 0; i < ops.length; i++) { const o = ops[i]; t = t.slice(0, o[1]) + o[3] + t.slice(o[1] + o[2]); if ((i + 1) % 200 === 0) P.cps.push(t); }
    scrub.max = ops.length; playBtn.disabled = false;
    renderFacts(stats(ops));
    seek(ops.length);
    const matches = t === s.code, hash = await sha256(JSON.stringify(ops));
    if (P.snip !== s) return;
    $("#sh-proof").innerHTML =
      `<span class="v ${matches ? "good" : "bad"}">${matches ? "✓ Replaying " + n(ops.length) + " keystrokes rebuilds this code exactly." : "✗ The recording doesn't match this code."}</span>` +
      (hash ? `<code>sha-256 of keystroke log · ${hash}</code>` : "") +
      `<small>${s.draft ? "Your draft hasn't been published yet." : "The server replayed this recording before saving it."} It shows the code was entered key by key with paste turned off. It can't show where the ideas came from.</small>`;
    P.i = 0; P.vt = 0; renderAt(0); play();
  }
  function renderFacts(st) {
    const f = [["Typing time", fmtDur(+st.duration || 0)], ["Speed", (+st.wpm || 0) + " wpm"], ["Keystrokes", n(st.keys)], ["Fixes", n(st.corrections)],
               ["Chars deleted", n(st.deleted)], ["Longest pause", fmtDur(+st.longestPause || 0)], ["Multi-char inserts", n(st.multi)]];
    $("#sh-facts").innerHTML = f.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(String(v))}</dd></div>`).join("");
  }
  function retime() { P.T = cumTimes(P.ops, P.trim ? PAUSE_CAP : Infinity); }
  function textAt(i) { const k = Math.min(Math.floor(i / 200), P.cps.length - 1); return applyOps(P.ops, P.cps[k], k * 200, i); }
  function renderAt(i) {
    const text = textAt(i), o = P.ops[i - 1], pos = o ? Math.min(text.length, o[1] + o[3].length) : 0;
    const box = document.createElement("code"); box.innerHTML = hl(text, P.snip.lang);
    const caret = document.createElement("span"); caret.className = "caret";
    const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT); let node, acc = 0, placed = false;
    while ((node = w.nextNode())) { const L = node.nodeValue.length; if (acc + L >= pos) { const after = node.splitText(pos - acc); after.parentNode.insertBefore(caret, after); placed = true; break; } acc += L; }
    if (!placed) box.appendChild(caret);
    codeEl.replaceChildren(...box.childNodes);
    const top = caret.offsetTop, left = caret.offsetLeft;
    if (top < pre.scrollTop + 8) pre.scrollTop = Math.max(0, top - 40);
    else if (top + 40 > pre.scrollTop + pre.clientHeight) pre.scrollTop = top - pre.clientHeight + 60;
    if (left < pre.scrollLeft + 8) pre.scrollLeft = Math.max(0, left - 60);
    else if (left + 30 > pre.scrollLeft + pre.clientWidth) pre.scrollLeft = left - pre.clientWidth + 80;
    scrub.value = i;
    const total = P.R.length ? P.R[P.R.length - 1] : 0;
    $("#sh-clock").textContent = fmtClock(i ? P.R[i - 1] : 0) + " / " + fmtClock(total);
    drawTimeline(shTl, P.ops, P.T, P.vt);
  }
  function seek(i) { P.i = Math.max(0, Math.min(P.ops.length, i)); P.vt = P.i ? P.T[P.i - 1] : 0; renderAt(P.i); }
  function frame(ts) {
    if (!P.playing) return;
    P.vt += (ts - P.lastTs) * P.speed; P.lastTs = ts;
    let moved = false; while (P.i < P.ops.length && P.T[P.i] <= P.vt) { P.i++; moved = true; }
    if (moved) renderAt(P.i); else drawTimeline(shTl, P.ops, P.T, P.vt);
    if (P.i >= P.ops.length) { stop(); return; }
    P.raf = requestAnimationFrame(frame);
  }
  function play() {
    if (!P.ops.length) return;
    if (P.i >= P.ops.length) seek(0);
    P.playing = true; P.lastTs = performance.now(); pre.classList.remove("idle"); playBtn.textContent = "Pause";
    P.raf = requestAnimationFrame(frame);
  }
  function stop() {
    P.playing = false; cancelAnimationFrame(P.raf); pre.classList.add("idle");
    playBtn.textContent = P.i >= P.ops.length && P.ops.length ? "Replay" : "Play";
  }
  playBtn.addEventListener("click", () => (P.playing ? stop() : play()));
  scrub.addEventListener("input", () => { stop(); seek(+scrub.value); });
  shTl.addEventListener("click", (e) => {
    if (!P.ops.length) return;
    const r = shTl.getBoundingClientRect(), total = P.T[P.T.length - 1] || 1, t = ((e.clientX - r.left) / r.width) * total;
    let i = 0; while (i < P.T.length && P.T[i] <= t) i++;
    stop(); seek(i);
  });
  $("#sh-speeds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    P.speed = +b.dataset.s; $("#sh-speeds").querySelectorAll("[data-s]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  });
  $("#sh-trim").addEventListener("change", (e) => { P.trim = e.target.checked; retime(); P.vt = P.i ? P.T[P.i - 1] : 0; drawTimeline(shTl, P.ops, P.T, P.vt); });
  $("#sh-back").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (sheet.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); }
    else if (e.key === " " && !/^(INPUT|BUTTON|SELECT|TEXTAREA|A)$/.test(document.activeElement.tagName)) { e.preventDefault(); P.playing ? stop() : play(); }
  });

  async function copyText(btn, text, done, fallbackEl) {
    const orig = btn.dataset.label || (btn.dataset.label = btn.textContent);
    try { await navigator.clipboard.writeText(text); btn.textContent = done; }
    catch (e) {
      if (fallbackEl) { const r = document.createRange(); r.selectNodeContents(fallbackEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "Selected. Press ⌘C"; }
      else btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = orig), 2000);
  }
  $("#sh-copy").addEventListener("click", () => copyText($("#sh-copy"), P.snip ? P.snip.code : "", "Copied", codeEl));
  $("#sh-share").addEventListener("click", () => P.snip && P.snip.id && copyText($("#sh-share"), location.origin + "/s/" + P.snip.id, "Link copied"));
  armButton($("#sh-del"), "Click again to delete", async () => {
    const s = P.snip; if (!s || !s.id || !sb) return;
    const btn = $("#sh-del");
    const { data, error } = await sb.from("snippets").delete().eq("id", s.id).select("id");
    if (error || !data || !data.length) { btn.textContent = "Couldn't delete"; setTimeout(() => (btn.textContent = "Delete snippet"), 2500); return; }
    gal.items = gal.items.filter((x) => x.id !== s.id); renderGallery();
    closeSheet();
  });

  /* ---------------- redraws ---------------- */
  const redraw = () => { drawTimeline(edTl, ed.ops, cumTimes(ed.ops, PAUSE_CAP), null); if (!sheet.hidden) drawTimeline(shTl, P.ops, P.T, P.vt); };
  try { new ResizeObserver(redraw).observe(edTl); new ResizeObserver(redraw).observe(shTl); } catch (e) { addEventListener("resize", redraw); }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);

  renderStatus();
  route();
})();
