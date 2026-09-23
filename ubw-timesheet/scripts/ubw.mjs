#!/usr/bin/env node
// ubw.mjs - Unit4 ERP (Business World) timesheet CLI.
//
// Works the "Timesheets - standard" screen (menu TS1611) the way a person
// does: it drives a real browser through the agent-browser CLI, clicks the
// screen's buttons, and types into its fields. It never posts forms or calls
// Unit4 endpoints itself. Page state is read from the rendered DOM. Node >= 18,
// no npm dependencies; agent-browser must be on PATH. See ../SCREEN.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME_DIR = process.env.UBW_HOME || path.join(os.homedir(), ".ubw-timesheet");
const CONFIG_FILE = path.join(HOME_DIR, "config.json");
const STATE_FILE = path.join(HOME_DIR, "browser-state.json");
const SESSION = process.env.UBW_SESSION || "ubw-timesheet";
const DEFAULT_URL = "https://ubw.unit4cloud.com/nl_mcw_prod_web";
const DEFAULT_MENU = "TS1611";
// The timesheet screen lives in this iframe of Container.aspx.
const FRAME = "#contentContainerFrame";
// Every click and keystroke goes to the element that carries this attribute.
const TARGET_ATTR = "data-ubw-target";
// Sign-in pages. Headless runs abort them, so an expired sign-in never reaches
// Microsoft (and never sends an MFA prompt) outside the login command.
const SIGN_IN_PAGES = ["https://login.microsoftonline.com/**", "https://login.live.com/**"];
const SELECT_ALL = process.platform === "darwin" ? "Meta+a" : "Control+a";
const INSTALL_HINT = "Install it with: npm install -g agent-browser && agent-browser install";

class UbwError extends Error {
  constructor(message, { exitCode = 1, details } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}
class NeedsLogin extends UbwError {
  constructor(message = "No valid Unit4 session. Run the login command; it opens a browser window for a one-time sign-in.") {
    super(message, { exitCode: 2 });
  }
}
class NeedsAgentBrowser extends UbwError {
  constructor(detail = "") {
    super(`agent-browser is not installed or not on PATH${detail ? ` (${detail})` : ""}. ${INSTALL_HINT}`, { exitCode: 3 });
  }
}

// ---------------------------------------------------------------------------
// Config files

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  return { baseUrl: DEFAULT_URL, menuId: DEFAULT_MENU, ...cfg };
}
function containerUrl(config) {
  const client = config.client ? `&client=${encodeURIComponent(config.client)}` : "";
  return `${config.baseUrl}/Container.aspx?type=topgen&menu_id=${encodeURIComponent(config.menuId)}&activityStepId=1-1&addLaunchIndication=false${client}`;
}

// ---------------------------------------------------------------------------
// agent-browser

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// npm installs agent-browser as a .cmd shim on Windows, which only starts
// through the shell. Arguments are selectors, dates, codes, and base64, so
// double quotes are enough there.
function winQuote(a) {
  return /^[\w@%+=:,./\[\]#-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

function agentBrowser(args, { timeout = 90000 } = {}) {
  const argv = ["--session", SESSION, ...args];
  const win = process.platform === "win32";
  const r = spawnSync("agent-browser", win ? argv.map(winQuote) : argv, { encoding: "utf8", timeout, shell: win, windowsHide: true });
  if (r.error?.code === "ENOENT") throw new NeedsAgentBrowser();
  if (r.error) throw new UbwError(`agent-browser ${args[0]} failed: ${r.error.message}`);
  if (win && r.status === 1 && /not recognized|cannot find/i.test(r.stderr || "")) throw new NeedsAgentBrowser();
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// Runs a command with --json and returns its data; throws on failure.
function ab(args, opts) {
  const r = agentBrowser([...args, "--json"], opts);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (!j || !j.success) throw new UbwError(`agent-browser ${args[0]} failed: ${j?.error || r.stderr || r.stdout || `exit ${r.status}`}`);
  return j.data;
}

function checkAgentBrowser() {
  const r = spawnSync("agent-browser", ["--version"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
  if (r.error || r.status !== 0) throw new NeedsAgentBrowser(r.error?.code || (r.stderr || "").trim());
  return (r.stdout || "").trim();
}

// Closes this tool's browser session and waits until agent-browser has let go
// of it; a launch right after `close` otherwise fails to connect.
async function closeSession() {
  const active = () => {
    const r = agentBrowser(["session", "list", "--json"]);
    try {
      return JSON.parse(r.stdout).data.sessions.some((s) => (s.name ?? s.session ?? s) === SESSION);
    } catch {
      return false;
    }
  };
  if (!active()) return;
  agentBrowser(["close"]);
  for (let i = 0; i < 40 && active(); i++) await sleep(250);
  await sleep(300);
}

const idOf = (name) => name.replace(/\$/g, "_");

// One browser session on the timesheet screen. Every change goes through a
// real click or keystroke; JavaScript only reads the page and marks the
// element the next click or keystroke goes to.
class Ui {
  constructor(config, { headed }) {
    this.config = config;
    this.headed = headed;
  }

  static async open(config, { headed = false } = {}) {
    checkAgentBrowser();
    // A session left over from an interrupted run would ignore --state.
    await closeSession();
    const launch = [];
    if (fs.existsSync(STATE_FILE)) launch.push("--state", STATE_FILE);
    if (headed) launch.push("--headed");
    ab([...launch, "open", "about:blank"]);
    const ui = new Ui(config, { headed });
    if (!headed) for (const page of SIGN_IN_PAGES) ab(["network", "route", page, "--abort"]);
    return ui;
  }

  url() {
    return ab(["get", "url"]).url ?? "";
  }

  js(code) {
    return ab(["eval", "-b", Buffer.from(code, "utf8").toString("base64")]).result;
  }

  // Runs `body` with `d` bound to the timesheet document.
  frameJs(body) {
    return this.js(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); const d = f && f.contentDocument; if (!d) return null; ${body} })()`);
  }

  // The screen's postback counter once its document has loaded, else null.
  counter() {
    return this.frameJs(`const i = d.readyState === "complete" && d.querySelector("[name=postbackCounter]"); return i ? Number(i.value) : null;`);
  }

  async waitFor(test, what, ms = 60000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = test();
      if (v) return v;
      if (Date.now() > end) throw new UbwError(`Timed out waiting for ${what}.`);
      await sleep(250);
    }
  }

  // Opens the timesheet screen. Unit4 renews an expired app session through
  // its identity server on its own; when that needs Microsoft, the aborted
  // sign-in page ends the wait.
  async openScreen() {
    const target = containerUrl(this.config);
    for (let attempt = 0; attempt < 2; attempt++) {
      agentBrowser(["open", target]);
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        if (this.counter() != null) return this.screen();
        const url = this.url();
        if (!this.headed && !/^https:\/\/[^/]*unit4cloud\.com\//.test(url) && url !== "about:blank") throw new NeedsLogin();
        if (url.startsWith(this.config.baseUrl) && !/\/(Container|Login)\b|\/ContentContainer/i.test(url) && /\.aspx/i.test(url)) break; // landed on the home page after renewal
        await sleep(500);
      }
    }
    throw new NeedsLogin("The timesheet screen did not load. Run the login command.");
  }

  screen() {
    const html = this.frameJs(`return d.documentElement.outerHTML;`);
    if (!html) throw new UbwError("Timesheet screen not loaded.");
    return new Screen(html);
  }

  // Marks the element that `findBody` returns (it sees `d`); throws when absent.
  mark(findBody, what) {
    const ok = this.frameJs(
      `d.querySelectorAll("[${TARGET_ATTR}]").forEach((e) => e.removeAttribute("${TARGET_ATTR}")); const el = (() => { ${findBody} })(); if (!el) return false; el.setAttribute("${TARGET_ATTR}", ""); return true;`,
    );
    if (!ok) throw new UbwError(`${what} not found on the timesheet screen.`);
  }
  markId(id, what) {
    this.mark(`return d.getElementById(${JSON.stringify(id)});`, what);
  }

  act(...args) {
    ab(["frame", FRAME]);
    ab([args[0], `[${TARGET_ATTR}]`, ...args.slice(1)]);
  }

  // Runs `fn` (a click or keystroke) and waits for the postback it causes.
  async postback(fn, what) {
    const before = this.counter();
    fn();
    await this.waitFor(() => {
      const n = this.counter();
      return n != null && n > before;
    }, what);
    return this.screen();
  }

  click(what) {
    return this.postback(() => this.act("click"), what);
  }

  // Types into the marked field like a person: focus, select the old value,
  // type, and leave with Tab. Tab fires the field's change event.
  typeKeys(text) {
    ab(["frame", FRAME]);
    ab(["focus", `[${TARGET_ATTR}]`]);
    ab(["press", SELECT_ALL]);
    ab(["keyboard", "type", text]);
    ab(["press", "Tab"]);
  }
  type(text, what) {
    return this.postback(() => this.typeKeys(text), what);
  }

  async save() {
    this.markId("b$tblsysSave", "Save button");
    return this.click("Save");
  }

  // Loads the period that contains `date` by typing it into "Date in period".
  async goto(date) {
    let s = this.screen();
    if (s.dayColumn(date)) return s;
    this.markId(idOf(s.names.header + "date_in_period$i"), "Date in period field");
    s = await this.type(formatDate(date, s.regional.datePattern), "the period to load");
    if (!s.dayColumn(date)) throw new UbwError(`Unit4 did not load the period of ${isoDate(date)} (showing ${s.period}).`, { details: s.messages });
    return s;
  }

  // Opens the row's details (Zoom), reads Sum and Inv.value, closes the dialog.
  async invoiceValue(row) {
    this.markId(idOf(row.name) + "_zoom", "Zoom button");
    const s = await this.click("the row details");
    const pick = (suffix) => Object.entries(s.fields).find(([k]) => !k.startsWith(s.names.grid) && k.endsWith(suffix))?.[1];
    const sum = pick("$reg_value$i"), inv = pick("$inv_value$i");
    this.markId("b__dialogclose", "Close button of the row details");
    await this.click("the row details to close");
    if (sum == null || inv == null) throw new UbwError(`Could not read Sum and Inv.value of ${row.workOrder}.`);
    return { sum, inv, match: parseHours(sum, s.regional.decimalSep) === parseHours(inv, s.regional.decimalSep) };
  }

  saveState() {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    ab(["state", "save", STATE_FILE]);
    try {
      fs.chmodSync(STATE_FILE, 0o600);
    } catch {}
  }

  close() {
    return closeSession();
  }
}

// Opens the screen in a headless browser, runs fn, keeps the refreshed
// cookies, and always closes the browser.
async function withScreen(fn) {
  const ui = await Ui.open(loadConfig());
  try {
    const screen = await ui.openScreen();
    try {
      return await fn(ui, screen);
    } finally {
      ui.saveState();
    }
  } finally {
    await ui.close();
  }
}

// ---------------------------------------------------------------------------
// HTML tokenizer (enough for ASP.NET output)

const VOID_TAGS = new Set(["input", "img", "br", "hr", "col", "meta", "link", "area", "base", "wbr", "source", "param"]);

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;?/g, " ")
    .replace(/&sum;/g, "\u2211")
    .replace(/&amp;/g, "&");
}

function* tags(html, from = 0, to = html.length) {
  let i = from;
  while (i < to) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt >= to) return;
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? to : e + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) {
      i = lt + 1;
      continue;
    }
    let j = lt + m[0].length;
    const attrs = {};
    let selfClosing = false;
    while (j < to) {
      const ch = html[j];
      if (ch === ">") {
        j++;
        break;
      }
      if (ch === "/" && html[j + 1] === ">") {
        selfClosing = true;
        j += 2;
        break;
      }
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      let k = j;
      while (k < to && !/[\s=>]/.test(html[k]) && !(html[k] === "/" && html[k + 1] === ">")) k++;
      const name = html.slice(j, k).toLowerCase();
      j = k;
      while (j < to && /\s/.test(html[j])) j++;
      if (html[j] === "=") {
        j++;
        while (j < to && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          if (!(name in attrs)) attrs[name] = decodeEntities(html.slice(j + 1, e < 0 ? to : e));
          j = e < 0 ? to : e + 1;
        } else {
          let e = j;
          while (e < to && !/[\s>]/.test(html[e])) e++;
          if (!(name in attrs)) attrs[name] = decodeEntities(html.slice(j, e));
          j = e;
        }
      } else if (name && !(name in attrs)) attrs[name] = "";
    }
    const name = m[2].toLowerCase();
    yield { start: lt, end: j, name, closing: m[1] === "/", selfClosing: selfClosing || VOID_TAGS.has(name), attrs };
    i = j;
    if (!m[1] && (name === "script" || name === "style")) {
      const e = html.indexOf(`</${name}`, j);
      i = e < 0 ? to : e;
    }
  }
}

// Element = open tag + inner range. Finds the matching close tag by depth.
function elementAt(html, openTag, to = html.length) {
  if (openTag.selfClosing) return { ...openTag, innerStart: openTag.end, innerEnd: openTag.end, outerEnd: openTag.end };
  let depth = 0;
  for (const t of tags(html, openTag.end, to)) {
    if (t.name !== openTag.name) continue;
    if (t.closing) {
      if (depth === 0) return { ...openTag, innerStart: openTag.end, innerEnd: t.start, outerEnd: t.end };
      depth--;
    } else if (!t.selfClosing) depth++;
  }
  return { ...openTag, innerStart: openTag.end, innerEnd: to, outerEnd: to };
}

// Direct child elements named `name` of `el` (ignores deeper nesting).
function childElements(html, el, name) {
  const out = [];
  let pos = el.innerStart;
  for (;;) {
    const stack = [];
    let child = null;
    for (const t of tags(html, pos, el.innerEnd)) {
      if (t.closing) {
        const i = stack.lastIndexOf(t.name);
        if (i >= 0) stack.length = i;
        continue;
      }
      if (stack.length === 0 && t.name === name) {
        child = elementAt(html, t, el.innerEnd);
        break;
      }
      if (!t.selfClosing) stack.push(t.name);
    }
    if (!child) return out;
    out.push(child);
    pos = child.outerEnd;
  }
}

function findTag(html, name, predicate, from = 0) {
  for (const t of tags(html, from)) if (!t.closing && t.name === name && predicate(t.attrs)) return t;
  return null;
}
function allTags(html, name, predicate = () => true) {
  const out = [];
  for (const t of tags(html)) if (!t.closing && t.name === name && predicate(t.attrs)) out.push(t);
  return out;
}

function innerText(html, el) {
  // Prefer the widget's own data-originalText when present.
  for (const t of tags(html, el.innerStart, el.innerEnd)) {
    if (!t.closing && t.attrs["data-originaltext"] != null) return t.attrs["data-originaltext"].trim();
  }
  return decodeEntities(html.slice(el.innerStart, el.innerEnd).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// All submittable inputs of the page, like a browser would post them.
function parseInputs(html) {
  const fields = {};
  for (const t of allTags(html, "input")) {
    const a = t.attrs;
    if (!a.name) continue;
    const type = (a.type || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image" || type === "file") continue;
    if (type === "checkbox" || type === "radio") {
      if ("checked" in a) fields[a.name] = a.value ?? "on";
      continue;
    }
    fields[a.name] = a.value ?? "";
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Dates and numbers in the user's regional format

function parseDatePattern(pattern) {
  const tokens = [...pattern.matchAll(/yyyy|yy|MM|M|dd|d/g)].map((m) => m[0]);
  return { pattern, order: tokens.map((t) => t[0]) }; // e.g. ["M","d","y"]
}
function parseDateIn(str, order) {
  const nums = (str.match(/\d+/g) || []).map(Number);
  const parts = {};
  order.forEach((k, i) => (parts[k] = nums[i]));
  if (!parts.d || !parts.M) return null;
  let y = parts.y ?? new Date().getFullYear();
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, parts.M - 1, parts.d));
}
function formatDate(date, pattern) {
  const y = date.getUTCFullYear();
  const M = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return pattern.replace(/yyyy|yy|MM|M|dd|d/g, (t) =>
    ({ yyyy: String(y), yy: String(y % 100).padStart(2, "0"), MM: String(M).padStart(2, "0"), M: String(M), dd: String(d).padStart(2, "0"), d: String(d) })[t],
  );
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
// Key of a day column in `row.hours`: its ISO date, or the column name when the label did not parse.
function dayKey(day) {
  return day.date ? isoDate(day.date) : day.column;
}
function parseIsoDate(s) {
  if (s === "today" || s === "yesterday") {
    const d = new Date();
    const local = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    if (s === "yesterday") local.setUTCDate(local.getUTCDate() - 1);
    return local;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new UbwError(`Bad date "${s}". Use YYYY-MM-DD, today or yesterday.`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isoDate(d) !== s) throw new UbwError(`Bad date "${s}".`);
  return d;
}
function parseHours(s, decimalSep) {
  const n = parseFloat(String(s).replace(decimalSep, "."));
  return Number.isFinite(n) ? n : 0;
}
function formatHours(n, decimalSep) {
  return n.toFixed(2).replace(".", decimalSep);
}


// ---------------------------------------------------------------------------
// The timesheet screen, parsed from the rendered DOM

class Screen {
  constructor(html) {
    this.html = html;
    this.parse();
  }

  parse() {
    const html = this.html;
    if (process.env.UBW_DEBUG) {
      fs.mkdirSync(process.env.UBW_DEBUG, { recursive: true });
      fs.writeFileSync(path.join(process.env.UBW_DEBUG, `screen-${Date.now()}.html`), html);
    }
    this.fields = parseInputs(html);
    if (!("__VIEWSTATE" in this.fields)) throw new UbwError("Unexpected page (no form). Session may be broken; run: ubw login");

    const rx = (re, def) => (html.match(re) || [])[1] ?? def;
    const datePattern = rx(/datePattern:'([^']*)'/, "M/d/yyyy");
    this.regional = { datePattern, decimalSep: rx(/decimalSep:'([^']*)'/, "."), order: parseDatePattern(datePattern).order };

    // Header section: field names are discovered from the date field.
    const dateKey = Object.keys(this.fields).find((k) => k.endsWith("$date_in_period$i"));
    if (!dateKey) throw new UbwError("Timesheet screen not recognised (no date_in_period field).");
    const headerPrefix = dateKey.slice(0, -"date_in_period$i".length);
    this.names = { header: headerPrefix };
    this.date = parseDateIn(this.fields[dateKey], this.regional.order);

    // DataListControl titles -> field names ("Period", "Status", "Work order", ...)
    this.lists = {};
    for (const t of allTags(html, "datalistcontrol")) {
      const name = t.attrs.id.replace(/_Control$/, "").replace(/_/g, "$");
      this.lists[name] = { title: t.attrs.title, context: t.attrs.context };
    }
    const headerList = (title) => Object.keys(this.lists).find((n) => n.startsWith(headerPrefix) && this.lists[n].title === title);
    const periodName = headerList("Period");
    const statusName = headerList("Status");
    this.names.status = statusName || null;
    const personName = headerList("Name");
    this.person = personName ? { userId: this.fields[personName + "$RowValue"], name: this.fields[personName + "$RowDescription"] } : {};
    this.period = periodName ? this.fields[periodName + "$Editor"] : "";
    this.periodDescription = periodName ? this.fields[periodName + "$RowDescription"] : "";
    this.status = statusName ? { code: this.fields[statusName + "$RowValue"], label: this.fields[statusName + "$RowDescription"] } : {};
    this.normalHours = parseHours(this.fields[headerPrefix + "normalhrs_schedule$i"] ?? "0", this.regional.decimalSep);

    // Buttons (onclick handlers carry the postback names; quotes arrive as &#39;)
    const handlers = html.replace(/&#39;/g, "'");
    const button = (re) => (handlers.match(re) || [])[1] ?? null;
    this.buttons = {
      save: button(/id="(b\$tblsysSave)"/),
      add: button(/'([^']*\$buttons\$_newButton)'/),
      delete: button(/'([^']*\$buttons\$_deleteButton)'/),
      ready: button(/'([^']*\$buttons\$[^']*)', true, 'action:SetSubmitStatus'/),
      draft: button(/'([^']*\$buttons\$[^']*)', true, 'action:SetDraftStatus'/),
    };

    // Grid
    const headerTh = findTag(html, "th", (a) => /\$ctl\d+\$status$/.test(a["data-name"] || ""));
    if (!headerTh) throw new UbwError("Timesheet grid not found.");
    this.names.grid = headerTh.attrs["data-name"].replace(/ctl\d+\$status$/, "");
    const gridHtmlPrefix = this.names.grid.replace(/\$/g, "_");
    const headerTr = findTag(html, "tr", (a) => /^Header\b/.test(a.class || ""));
    if (!headerTr) throw new UbwError("Timesheet grid header not found.");
    const headerEl = elementAt(html, headerTr);
    this.columns = childElements(html, headerEl, "th").map((th) => ({
      field: th.attrs["data-fieldname"] || "",
      title: (th.attrs.title || "").replace(/\s*-\s*Header\s*$/, "").trim(),
    }));
    this.days = this.columns
      .filter((c) => /^reg_value\d+$/.test(c.field))
      .map((c) => ({ column: c.field, label: c.title, date: this.dayDate(c.title) }));

    this.rows = [];
    this.totals = null;
    for (const tr of allTags(html, "tr", (a) => (a.id || "").startsWith(gridHtmlPrefix + "row") || a.id === gridHtmlPrefix + "_sumRow")) {
      const el = elementAt(html, tr);
      const cells = childElements(html, el, "td");
      const isSum = tr.attrs.id.endsWith("_sumRow");
      const row = { index: isSum ? null : Number(tr.attrs.id.slice(gridHtmlPrefix.length + 3)), editing: /\bEditRow\b/.test(tr.attrs.class || ""), cells: {} };
      row.name = isSum ? null : `${this.names.grid}row${row.index}`;
      cells.forEach((td, i) => {
        const col = this.columns[i];
        if (!col || !col.field) return;
        const inputs = allTagsIn(html, td, "input").map((t) => t.attrs.name).filter(Boolean);
        const cell = { text: innerText(html, td), inputs };
        if (row.editing && inputs.length) {
          const editor = inputs.find((n) => n.endsWith("$Editor") || n.endsWith("$i"));
          if (editor) {
            cell.input = editor;
            cell.text = this.fields[editor] ?? "";
            const list = editor.endsWith("$Editor") ? editor.slice(0, -"$Editor".length) : null;
            if (list) cell.description = this.fields[list + "$RowDescription"] ?? "";
          }
        }
        row.cells[col.field] = cell;
      });
      const c = (f) => row.cells[f]?.text ?? "";
      row.status = c("status");
      row.timecode = c("timecode");
      row.workOrder = c("work_order");
      row.project = c("project");
      row.activity = c("activity");
      row.description = c("description");
      row.unit = c("reg_unit");
      row.hours = {};
      for (const day of this.days) row.hours[dayKey(day)] = parseHours(c(day.column), this.regional.decimalSep);
      // The sum cell of the row being edited lags behind; add the days up instead.
      row.sum = Object.values(row.hours).reduce((a, b) => a + b, 0);
      if (isSum) this.totals = row;
      else this.rows.push(row);
    }

    this.messages = this.parseMessages();
  }

  dayDate(label) {
    // "Tue 9/1" -> nearest matching date around the screen date (the label has no year).
    const nums = (label.match(/\d+/g) || []).map(Number);
    if (nums.length < 2 || !this.date) return null;
    const order = this.regional.order.filter((k) => k !== "y");
    const M = nums[order.indexOf("M")];
    const d = nums[order.indexOf("d")];
    const y = this.date.getUTCFullYear();
    let best = null;
    for (const yy of [y - 1, y, y + 1]) {
      const cand = new Date(Date.UTC(yy, M - 1, d));
      if (!best || Math.abs(cand - this.date) < Math.abs(best - this.date)) best = cand;
    }
    return best;
  }

  parseMessages() {
    const html = this.html;
    const items = (id) => {
      const t = findTag(html, "table", (a) => a.id === id);
      if (!t) return [];
      const el = elementAt(html, t);
      return [...html.slice(el.innerStart, el.innerEnd).matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)]
        .filter((m) => !/display:\s*none/.test(m[1]))
        .map((m) => decodeEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim())
        .filter(Boolean);
    };
    const ria = /displayRiaMsg\(\{\s*title:'((?:[^'\\]|\\.)*)',\s*message:'((?:[^'\\]|\\.)*)',\s*messageType:'([^']*)'/.exec(html);
    return {
      errors: items("errorList"),
      warnings: items("warningList"),
      result: ria ? { title: ria[1], message: ria[2].replace(/\\'/g, "'"), type: ria[3] } : null,
    };
  }

  get editingRow() {
    return this.rows.find((r) => r.editing) || null;
  }

  findRow(workOrder, timecode) {
    return this.rows.find((r) => r.workOrder === workOrder && (timecode == null || r.timecode === timecode)) || null;
  }

  dayColumn(date) {
    return this.days.find((d) => d.date && isoDate(d.date) === isoDate(date)) || null;
  }

  who() {
    if (!this.person.userId) throw new UbwError("The timesheet screen shows no employee.");
    return this.person;
  }

  toJSON() {
    return {
      date: isoDate(this.date),
      period: this.period,
      periodDescription: this.periodDescription,
      status: this.status,
      normalHours: this.normalHours,
      days: this.days.map((d) => ({ column: d.column, label: d.label, date: d.date ? isoDate(d.date) : null })),
      rows: this.rows.map((r) => ({
        index: r.index,
        editing: r.editing,
        status: r.status,
        timecode: r.timecode,
        workOrder: r.workOrder,
        project: r.project,
        activity: r.activity,
        description: r.description,
        unit: r.unit,
        hours: r.hours,
        sum: r.sum,
      })),
      totals: this.totals ? { hours: this.totals.hours, sum: this.totals.sum } : null,
      messages: this.messages,
    };
  }
}

function allTagsIn(html, el, name) {
  const out = [];
  for (const t of tags(html, el.innerStart, el.innerEnd)) if (!t.closing && t.name === name) out.push(t);
  return out;
}

// ---------------------------------------------------------------------------
// Commands

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v != null) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["json", "help", "fresh", "dry-run"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const out = {
  json: (data) => console.log(JSON.stringify(data, null, 2)),
  table(rows) {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
    const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(width[i])).join("  ").trimEnd();
    console.log(line(keys));
    for (const r of rows) console.log(line(keys.map((k) => r[k])));
  },
};

function rowSummary(row) {
  return { workOrder: row.workOrder, timecode: row.timecode, description: row.description, status: row.status, hours: row.hours, sum: row.sum };
}

function describeMessages(m) {
  const lines = [];
  if (m.result) lines.push(`${m.result.title}: ${m.result.message}`);
  for (const e of m.errors) lines.push(`Error: ${e}`);
  for (const w of m.warnings) lines.push(`Warning: ${w}`);
  return lines;
}

function printScreen(screen, flags) {
  if (flags.json) return out.json(screen.toJSON());
  const first = screen.days[0]?.date, last = screen.days[screen.days.length - 1]?.date;
  console.log(
    `Period ${screen.period}${screen.periodDescription && screen.periodDescription !== screen.period ? ` (${screen.periodDescription})` : ""}: ${first ? isoDate(first) : "?"} to ${last ? isoDate(last) : "?"}, status ${screen.status.label} (${screen.status.code}), normal hours ${screen.normalHours}`,
  );
  const rows = screen.rows.map((r) => {
    const o = { workOrder: r.workOrder, timecode: r.timecode, status: r.status, description: r.description.slice(0, 40) };
    for (const d of screen.days) o[d.label] = r.hours[dayKey(d)].toFixed(2);
    o.sum = r.sum.toFixed(2);
    return o;
  });
  if (screen.totals) {
    const o = { workOrder: "TOTAL", timecode: "", status: "", description: "" };
    for (const d of screen.days) o[d.label] = screen.totals.hours[dayKey(d)].toFixed(2);
    o.sum = screen.totals.sum.toFixed(2);
    rows.push(o);
  }
  if (rows.length) out.table(rows);
  else console.log("(no rows)");
  for (const l of describeMessages(screen.messages)) console.log(l);
}

function rowByWorkOrder(screen, workOrder) {
  return screen.findRow(workOrder, "0");
}

// Marks row `row`'s cell in `column` (td), for a click that opens the row for editing.
function markCell(ui, row, column) {
  ui.mark(
    `const tr = d.getElementById(${JSON.stringify(idOf(row.name))}); const i = [...d.querySelectorAll("tr.Header th")].findIndex((th) => th.dataset.fieldname === ${JSON.stringify(column)}); return tr && i >= 0 ? tr.children[i] : null;`,
    `Cell ${column} of ${row.workOrder}`,
  );
}

const commands = {
  async login({ flags }) {
    const config = loadConfig();
    if (flags.url) config.baseUrl = String(flags.url).replace(/\/+$/, "");
    if (flags.menu) config.menuId = String(flags.menu);
    if (flags.fresh) fs.rmSync(STATE_FILE, { force: true });
    const ui = await Ui.open(config, { headed: true });
    try {
      agentBrowser(["open", `${config.baseUrl}/Default.aspx`]);
      console.error("A browser window opened. Sign in there; this command continues when Unit4 has loaded.");
      const onApp = () => {
        const url = ui.url();
        return url.startsWith(config.baseUrl) && !/\/Login\//i.test(url);
      };
      await ui.waitFor(onApp, "the Unit4 sign-in", 5 * 60 * 1000).catch(() => {
        throw new NeedsLogin("Sign-in did not finish within 5 minutes. Run the login command again.");
      });
      const screen = await ui.openScreen();
      const who = screen.who();
      writeJson(CONFIG_FILE, { ...readJson(CONFIG_FILE, {}), baseUrl: config.baseUrl, menuId: config.menuId, userId: who.userId });
      ui.saveState();
      out.json({ ok: true, ...who, baseUrl: config.baseUrl });
    } finally {
      await ui.close();
    }
  },

  async logout() {
    await closeSession();
    fs.rmSync(STATE_FILE, { force: true });
    fs.rmSync(path.join(HOME_DIR, "session.json"), { force: true });
    fs.rmSync(path.join(HOME_DIR, "browser-profile"), { recursive: true, force: true });
    out.json({ ok: true });
  },

  async whoami() {
    await withScreen(async (ui, screen) => out.json({ ...screen.who(), baseUrl: ui.config.baseUrl, period: screen.period }));
  },

  async show({ flags, positional }) {
    const date = parseIsoDate(positional[0] || "today");
    await withScreen(async (ui) => printScreen(await ui.goto(date), flags));
  },

  // Types the keyword into the work-order field of a new row and reads the
  // list the field drops down. The row is never saved.
  async search({ flags, positional }) {
    const text = positional.join(" ");
    if (!text) throw new UbwError("Usage: ubw search <text>");
    const words = text.split(/\s+/).filter(Boolean);
    const query = words.reduce((a, b) => (b.length > a.length ? b : a));
    await withScreen(async (ui, screen) => {
      if (!screen.buttons.add) throw new UbwError(`Period ${screen.period} is ${screen.status.label}; search needs a period where rows can be added.`);
      ui.markId(idOf(screen.buttons.add), "Add button");
      const s = await ui.click("the new row");
      const input = s.editingRow?.cells.work_order?.input;
      if (!input) throw new UbwError("The new row has no work order field.");
      const popup = JSON.stringify(idOf(input).replace(/_Editor$/, "_Popup"));
      // The drop-down holds option rows, or only a notice such as "Too many
      // values. Please narrow your search."
      const listed = () =>
        ui.frameJs(
          `const p = d.getElementById(${popup}); if (!p) return null; const rows = [...p.querySelectorAll("tr[role=option]")].map((tr) => [...tr.cells].map((c) => c.textContent.trim())); if (rows.length && p.offsetParent) return { rows }; const notice = p.innerText.trim(); return notice ? { notice } : null;`,
        );
      ui.markId(idOf(input), "Work order field");
      ab(["frame", FRAME]);
      ab(["focus", `[${TARGET_ATTR}]`]);
      ab(["keyboard", "type", query]);
      let list = null;
      for (let attempt = 0; attempt < 3 && !list; attempt++) {
        const end = Date.now() + 4000;
        while (!list && Date.now() < end) {
          await sleep(250);
          list = listed();
        }
        // The drop-down sometimes misses the first keystrokes; type once more.
        if (!list) {
          ab(["press", "End"]);
          ab(["keyboard", "type", "x"]);
          ab(["press", "Backspace"]);
        }
      }
      if (!list) throw new UbwError(`The work order field showed no list for "${query}".`);
      if (!list.rows) throw new UbwError(`Unit4 says for "${query}": ${list.notice} Use a longer or more specific word.`);
      const all = list.rows.filter((r) => r[1] !== "[NEW]").map(([value, description]) => ({ value, description: description ?? "" }));
      const items = all.filter((i) => words.every((w) => (i.value + " " + i.description).toLowerCase().includes(w.toLowerCase())));
      if (flags.json) return out.json({ query, items });
      if (!items.length) console.log("No matching work orders.");
      else out.table(items.map((i) => ({ workOrder: i.value, description: i.description })));
    });
  },

  async set({ flags, positional }) {
    const [workOrder, ...specs] = positional;
    if (!workOrder || !specs.length) throw new UbwError("Usage: ubw set <work-order> <YYYY-MM-DD=hours> [more days...]");
    let entries = specs.map((s) => {
      const m = /^([^=]+)=(\d+(?:[.,]\d+)?)$/.exec(s);
      if (!m) throw new UbwError(`Bad entry "${s}". Use YYYY-MM-DD=hours, e.g. 2026-09-07=8`);
      return { date: parseIsoDate(m[1]), hours: parseFloat(m[2].replace(",", ".")) };
    });
    await withScreen(async (ui) => {
      const results = [];
      while (entries.length) {
        let s = await ui.goto(entries[0].date);
        const inPeriod = entries.filter((e) => s.dayColumn(e.date));
        entries = entries.filter((e) => !inPeriod.includes(e));
        let row = rowByWorkOrder(s, workOrder);
        const wanted = inPeriod.filter((e) => !row || row.hours[isoDate(e.date)] !== e.hours);
        if (row && !wanted.length) {
          results.push({ period: s.period, changed: false, row: rowSummary(row), messages: s.messages });
          continue;
        }
        if (row && !row.editing) {
          // Clicking a day cell opens the row for editing.
          markCell(ui, row, s.dayColumn(wanted[0].date).column);
          s = await ui.click(`row ${workOrder} to open for editing`);
          row = rowByWorkOrder(s, workOrder);
          if (!row || !row.editing || !row.cells[s.dayColumn(wanted[0].date).column]?.input)
            throw new UbwError(`Row ${workOrder} in period ${s.period} is not editable (status "${row?.status || "?"}").`, { details: s.messages });
        }
        if (!row) {
          if (!s.buttons.add) throw new UbwError(`Period ${s.period} is ${s.status.label}; rows cannot be added.`);
          ui.markId(idOf(s.buttons.add), "Add button");
          s = await ui.click("the new row");
          const input = s.editingRow?.cells.work_order?.input;
          if (!input) throw new UbwError("The new row has no work order field.", { details: s.messages });
          ui.markId(idOf(input), "Work order field");
          s = await ui.type(workOrder, "the work order to be accepted");
          row = rowByWorkOrder(s, workOrder);
          if (!row || !row.editing || s.messages.errors.length) throw new UbwError(`Work order ${workOrder} was not accepted.`, { details: s.messages });
        }
        for (const e of wanted) {
          const input = s.editingRow?.cells[s.dayColumn(e.date).column]?.input;
          if (!input) throw new UbwError(`No editable cell for ${isoDate(e.date)}.`);
          ui.markId(idOf(input), `Hours field for ${isoDate(e.date)}`);
          s = await ui.type(formatHours(e.hours, s.regional.decimalSep), `the hours for ${isoDate(e.date)}`);
          if (s.messages.errors.length) throw new UbwError(`Unit4 rejected ${isoDate(e.date)}=${e.hours}.`, { details: s.messages });
        }
        s = await ui.save();
        const saved = rowByWorkOrder(s, workOrder);
        results.push({ period: s.period, changed: true, row: saved ? rowSummary(saved) : null, messages: s.messages });
        if (s.messages.errors.length || s.messages.result?.type !== "success" || !saved)
          throw new UbwError(`Save failed for period ${s.period}: ${describeMessages(s.messages).join(" | ") || "no confirmation from Unit4"}`, { details: results });
        // Read back from a fresh load: hours per day and the invoice value.
        await ui.openScreen();
        s = await ui.goto(inPeriod[0].date);
        const stored = rowByWorkOrder(s, workOrder);
        const mismatch = stored ? wanted.find((e) => stored.hours[isoDate(e.date)] !== e.hours) : null;
        if (!stored || mismatch) throw new UbwError(`Period ${s.period}: ${!stored ? `row ${workOrder} is missing after the save` : `${isoDate(mismatch.date)} shows ${stored.hours[isoDate(mismatch.date)]} instead of ${mismatch.hours}`}.`, { details: results });
        const value = await ui.invoiceValue(stored);
        if (!value.match) throw new UbwError(`Period ${s.period}: ${workOrder} saved with Sum ${value.sum} but Inv.value ${value.inv}; the project would invoice the wrong hours. Correct the row in the Unit4 web UI.`, { details: results });
      }
      if (flags.json) out.json(results);
      else
        for (const r of results) {
          console.log(r.changed ? r.messages.result.message : `Period ${r.period}: already had these hours, nothing saved`);
          if (r.row) out.table([{ workOrder: r.row.workOrder, description: r.row.description.slice(0, 40), status: r.row.status, ...Object.fromEntries(Object.entries(r.row.hours).map(([d, h]) => [d.slice(5), h.toFixed(2)])), sum: r.row.sum.toFixed(2) }]);
        }
    });
  },

  async delete({ flags, positional }) {
    const [workOrder, dateArg] = positional;
    if (!workOrder || !dateArg) throw new UbwError("Usage: ubw delete <work-order> <YYYY-MM-DD>");
    await withScreen(async (ui) => {
      let s = await ui.goto(parseIsoDate(dateArg));
      const row = rowByWorkOrder(s, workOrder);
      if (!row) throw new UbwError(`No row for ${workOrder} in period ${s.period}.`);
      if (!s.buttons.delete) throw new UbwError(`Period ${s.period} is ${s.status.label}; rows cannot be removed.`);
      ui.markId(idOf(row.name) + "__delete", `Mark box of ${workOrder}`);
      ui.act("check");
      ui.markId(idOf(s.buttons.delete), "Delete button");
      s = await ui.click("the row to be removed");
      if (rowByWorkOrder(s, workOrder)) throw new UbwError(`Row ${workOrder} could not be removed.`, { details: s.messages });
      s = await ui.save();
      if (flags.json) out.json({ period: s.period, messages: s.messages, rows: s.toJSON().rows });
      else printScreen(s, flags);
      if (s.messages.errors.length || s.messages.result?.type !== "success") throw new UbwError("Save did not confirm success.", { details: s.messages });
    });
  },

  // Marks every row, presses Ready, sets the period status to Ready, saves.
  async submit({ flags, positional }) {
    const date = parseIsoDate(positional[0] || "today");
    await withScreen(async (ui) => {
      let s = await ui.goto(date);
      if (!s.rows.length) throw new UbwError(`Period ${s.period} has no rows to submit.`);
      if (s.status.code === "N" && s.rows.every((r) => r.status === "Ready")) {
        printScreen(s, flags);
        if (!flags.json) console.log(`Period ${s.period}: already sent for approval, nothing saved`);
        return;
      }
      if (!s.buttons.ready || !s.names.status) throw new UbwError(`Period ${s.period} is ${s.status.label}; status cannot change.`);
      for (const r of s.rows) {
        ui.markId(idOf(r.name) + "__delete", `Mark box of ${r.workOrder}`);
        ui.act("check");
      }
      ui.markId(idOf(s.buttons.ready), "Ready button");
      s = await ui.click("the rows to turn Ready");
      // The Status field validates on the client; no postback follows.
      ui.markId(idOf(s.names.status + "$Editor"), "Status field");
      ui.typeKeys(flags.label ? String(flags.label) : "Ready");
      const code = ui.frameJs(`const i = d.getElementById(${JSON.stringify(idOf(s.names.status + "$RowValue"))}); return i && i.value;`);
      if (code !== "N") throw new UbwError(`The Status field did not take Ready (value ${code}). On a screen in another language, pass the label with --label.`);
      if (flags["dry-run"]) {
        const rows = ui.screen().rows;
        console.log(`Dry run for period ${s.period}: rows ${rows.map((r) => `${r.workOrder} ${r.status}`).join(", ")}, Status field Ready. Not saved; closing the browser discards it.`);
        return;
      }
      s = await ui.save();
      if (s.messages.errors.length) throw new UbwError("Save reported errors.", { details: s.messages });
      await ui.openScreen();
      s = await ui.goto(date);
      printScreen(s, flags);
      const stuck = s.rows.filter((r) => r.status !== "Ready");
      if (s.status.code !== "N" || stuck.length)
        throw new UbwError(`Period ${s.period} is ${s.status.label} with rows ${s.rows.map((r) => `${r.workOrder} (${r.status})`).join(", ")}; the week is not with the approver.`);
    });
  },

  // Compares Sum and Inv.value of every row in the row details.
  async check({ flags, positional }) {
    const date = parseIsoDate(positional[0] || "today");
    await withScreen(async (ui) => {
      const s = await ui.goto(date);
      const rows = [];
      for (const row of s.rows) rows.push({ workOrder: row.workOrder, status: row.status, ...(await ui.invoiceValue(row)) });
      if (flags.json) out.json({ period: s.period, rows });
      else if (!rows.length) console.log(`Period ${s.period}: no rows`);
      else out.table(rows.map((r) => ({ period: s.period, workOrder: r.workOrder, status: r.status, sum: r.sum, invValue: r.inv, ok: r.match ? "yes" : "NO" })));
      if (rows.some((r) => !r.match)) throw new UbwError(`Period ${s.period}: Inv.value differs from Sum; the project would invoice the wrong hours.`);
    });
  },

  help() {
    console.log(`ubw - Unit4 ERP timesheet CLI (drives the web UI through agent-browser)

  ubw login [--url BASE] [--menu TS1611]   open a browser window for the Unit4 sign-in; --fresh forgets the old session first
  ubw whoami                                session check
  ubw show [DATE]                           timesheet period containing DATE (default today)
  ubw search TEXT                           find work orders by code or description
  ubw set WO DATE=HOURS [DATE=HOURS ...]    type hours on the row for work order WO (adds the row when missing), save as draft
  ubw delete WO DATE                        remove the WO row from the period containing DATE
  ubw submit [DATE] [--dry-run] [--label L]  mark the rows Ready, set the period status to Ready, save (sends for approval); --dry-run stops before Save
  ubw check [DATE]                          compare Sum and Inv.value of every row in the period
  ubw logout                                forget the stored browser session

DATE is YYYY-MM-DD, today or yesterday. Add --json for machine output.
Exit codes: 0 ok, 1 error, 2 login needed, 3 agent-browser missing.

Environment:
  UBW_HOME     data directory (default ~/.ubw-timesheet)
  UBW_SESSION  agent-browser session name (default ubw-timesheet)
  UBW_DEBUG    directory; every screen read is written there`);
  },
};

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift() || "help";
  const fn = commands[cmd];
  if (!fn || flags.help) return commands.help();
  try {
    await fn({ flags, positional });
  } catch (e) {
    if (e instanceof UbwError) {
      console.error(`ubw: ${e.message}`);
      if (e.details) console.error(JSON.stringify(e.details, null, 2));
      process.exitCode = e.exitCode;
    } else {
      console.error(`ubw: ${e.stack || e}`);
      process.exitCode = 1;
    }
  }
}

// Node resolves the entry file through symlinks, so compare real paths (a
// symlinked skill directory is the normal install).
function isEntryPoint() {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isEntryPoint()) main();

export { Screen, parseInputs, tags, elementAt, childElements, winQuote };
