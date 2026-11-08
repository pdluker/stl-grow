"use strict";
(function () {
  const API = "/grow/api";
  const LABEL = ["Not yet", "Partial", "Done", "N/A"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k === "style") Object.assign(n.style, v); // CSSOM, allowed by the CSP (style attributes are not)
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  };

  let month = thisMonth();
  let monthData = null;
  let reflectTimer = null;
  let reflectDirty = false;

  function thisMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function shift(key, n) {
    const [y, m] = key.split("-").map(Number);
    const i = y * 12 + m - 1 + n;
    return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
  }
  function fmt(key) {
    const [y, m] = key.split("-");
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }
  const pct = (s) => (s === null || s === undefined ? "—" : `${Math.round(s * 100)}%`);

  async function call(path, opts = {}) {
    const init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (init.method !== "GET") init.headers["X-Grow-Client"] = "1";
    const res = await fetch(API + path, init);
    // Expired Access session: Access answers with a redirect/HTML login page.
    const type = res.headers.get("Content-Type") || "";
    if (res.status === 401 || res.status === 403 || (res.ok && !type.includes("application/json"))) {
      throw new Error("Your sign-in expired. Reload the page to sign in again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function flash(msg) {
    const f = $("flash");
    f.textContent = msg;
    f.hidden = !msg;
  }

  // ------------------------------------------------------------ check-in view

  async function loadMonth() {
    await flushReflection();
    $("month-label").textContent = fmt(month);
    try {
      const [data, trend] = await Promise.all([call(`/month/${month}`), call(`/trend?end=${month}&n=6`)]);
      monthData = data;
      renderMonth();
      renderTrend(trend.months);
      flash("");
    } catch (e) {
      flash(e.message);
    }
  }

  function renderMonth() {
    const d = monthData;
    $("score").textContent = pct(d.score);
    const box = $("areas");
    box.replaceChildren();
    for (const a of d.areas) {
      box.append(
        el(
          "section",
          { class: "area" },
          el("div", { class: "ahead" }, el("h2", {}, a.name), a.roast ? el("span", { class: "roast" }, `“${a.roast}”`) : null),
          el("div", { class: "bar-score" }, el("i", { style: { width: `${a.score === null ? 0 : Math.round(a.score * 100)}%` } })),
          a.habits.map((h) =>
            el(
              "div",
              { class: "habit" },
              el("div", { class: "t" }, h.text, el("span", { class: "c" }, h.cadence)),
              el("div", { class: "pills" }, h.periods.map((p) => pill(h, p)))
            )
          )
        )
      );
    }
    $("reflect-title").textContent = `${fmt(d.month)} reflection`;
    $("win").value = d.reflection.win || "";
    $("miss").value = d.reflection.miss || "";
    $("saved").textContent = d.reflection.updated_at ? "Saved" : "";
    reflectDirty = false;
  }

  function pill(habit, period) {
    const b = el(
      "button",
      { type: "button", class: `pill s${period.status}`, "aria-label": `${habit.text} ${period.label || ""}: ${LABEL[period.status]}` },
      period.label ? el("small", {}, period.label) : null,
      LABEL[period.status]
    );
    b.addEventListener("click", async () => {
      const prev = period.status;
      const next = (prev + 1) % 4;
      period.status = next;
      b.disabled = true;
      try {
        await call("/status", { method: "PUT", body: { habitId: habit.id, periodKey: period.key, status: next } });
        await refreshScores();
      } catch (e) {
        period.status = prev;
        flash(e.message);
        renderMonth();
      }
    });
    return b;
  }

  async function refreshScores() {
    const [data, trend] = await Promise.all([call(`/month/${month}`), call(`/trend?end=${month}&n=6`)]);
    // Keep any unsaved reflection text the user is typing.
    const win = $("win").value;
    const miss = $("miss").value;
    const dirty = reflectDirty;
    monthData = data;
    renderMonth();
    if (dirty) {
      $("win").value = win;
      $("miss").value = miss;
      reflectDirty = true;
    }
    renderTrend(trend.months);
  }

  function renderTrend(months) {
    const box = $("trend");
    box.replaceChildren(
      ...months.map((m) =>
        el("span", {
          class: `${m.score === null ? "empty" : ""} ${m.month === month ? "cur" : ""}`.trim(),
          style: { height: `${m.score === null ? 4 : Math.max(4, Math.round(m.score * 40))}px` },
          title: `${fmt(m.month)}: ${pct(m.score)}`,
        })
      )
    );
  }

  function onReflectInput() {
    reflectDirty = true;
    $("saved").textContent = "Saving…";
    clearTimeout(reflectTimer);
    reflectTimer = setTimeout(flushReflection, 1200);
  }

  async function flushReflection() {
    clearTimeout(reflectTimer);
    if (!reflectDirty || !monthData) return;
    reflectDirty = false;
    try {
      await call("/reflection", { method: "PUT", body: { month: monthData.month, win: $("win").value, miss: $("miss").value } });
      $("saved").textContent = "Saved";
    } catch (e) {
      reflectDirty = true;
      $("saved").textContent = "Not saved";
      flash(e.message);
    }
  }

  // ------------------------------------------------------------ habits view

  async function loadHabits() {
    try {
      const data = await call("/habits");
      renderHabits(data);
      flash("");
    } catch (e) {
      flash(e.message);
    }
  }

  function renderHabits(data) {
    const list = $("habit-list");
    list.replaceChildren();
    for (const a of data.areas) {
      const habits = data.habits.filter((h) => h.area_id === a.id);
      list.append(
        el(
          "section",
          { class: "area" },
          el("h2", {}, a.name),
          habits.length ? habits.map(habitRow) : el("p", { class: "hint" }, "No habits yet.")
        )
      );
    }
    $("add-area").replaceChildren(...data.areas.map((a) => el("option", { value: a.id }, a.name)));
    $("add-cadence").replaceChildren(...data.cadences.map((c) => el("option", { value: c, selected: c === "monthly" }, c)));
  }

  function habitRow(h) {
    const input = el("input", { value: h.text, maxlength: "200", "aria-label": "Habit text" });
    const save = el("button", { type: "button" }, "Save");
    const toggle = el("button", { type: "button" }, h.active ? "Retire" : "Restore");
    save.addEventListener("click", async () => {
      try {
        await call(`/habits/${h.id}`, { method: "PATCH", body: { text: input.value } });
        flash("Saved.");
      } catch (e) {
        flash(e.message);
      }
    });
    toggle.addEventListener("click", async () => {
      try {
        await call(`/habits/${h.id}`, { method: "PATCH", body: { active: !h.active } });
        await loadHabits();
      } catch (e) {
        flash(e.message);
      }
    });
    return el("div", { class: `mh ${h.active ? "" : "retired"}` }, input, el("span", { class: "cad" }, h.cadence), save, toggle);
  }

  async function onAdd(ev) {
    ev.preventDefault();
    try {
      await call("/habits", {
        method: "POST",
        body: { text: $("add-text").value, areaId: $("add-area").value, cadence: $("add-cadence").value },
      });
      $("add-text").value = "";
      await loadHabits();
      flash("Habit added.");
    } catch (e) {
      flash(e.message);
    }
  }

  // ------------------------------------------------------------ routing

  function show() {
    const view = location.hash === "#habits" ? "habits" : "checkin";
    $("view-checkin").hidden = view !== "checkin";
    $("view-habits").hidden = view !== "habits";
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
    if (view === "habits") loadHabits();
    else loadMonth();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("prev").addEventListener("click", () => { month = shift(month, -1); loadMonth(); });
    $("next").addEventListener("click", () => { month = shift(month, 1); loadMonth(); });
    $("win").addEventListener("input", onReflectInput);
    $("miss").addEventListener("input", onReflectInput);
    $("win").addEventListener("blur", flushReflection);
    $("miss").addEventListener("blur", flushReflection);
    $("add-form").addEventListener("submit", onAdd);
    window.addEventListener("hashchange", show);
    window.addEventListener("pagehide", flushReflection);
    show();
  });
})();
