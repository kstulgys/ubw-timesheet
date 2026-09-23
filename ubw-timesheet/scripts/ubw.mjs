#!/usr/bin/env node
// ubw.mjs - Unit4 ERP (Business World) timesheet CLI.
//
// The "Timesheets - standard" screen (menu TS1611) is an ASP.NET WebForms page.
// This tool sends the same postbacks the browser sends, over plain HTTPS, and
// parses the returned HTML. Node >= 18, no dependencies. See ../PROTOCOL.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME_DIR = process.env.UBW_HOME || path.join(os.homedir(), ".ubw-timesheet");
const CONFIG_FILE = path.join(HOME_DIR, "config.json");
const SESSION_FILE = path.join(HOME_DIR, "session.json");
const PROFILE_DIR = path.join(HOME_DIR, "browser-profile");
const DEFAULT_URL = "https://ubw.unit4cloud.com/nl_mcw_prod_web";
const DEFAULT_MENU = "TS1611";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

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

// ---------------------------------------------------------------------------
// Config and session files

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

// ---------------------------------------------------------------------------
// HTTP

function httpRequest(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          ...headers,
          ...(body != null ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Cookie jar for the app host and the identity server host.
class Jar {
  constructor(cookies = []) {
    this.cookies = cookies; // [{ name, value, domain, path }]
  }
  static fromCdp(cookies, registrableDomain) {
    const jar = new Jar();
    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, "");
      if (domain === registrableDomain || domain.endsWith("." + registrableDomain)) jar.add({ name: c.name, value: c.value, domain, path: c.path || "/" });
    }
    return jar;
  }
  add(cookie) {
    this.cookies = this.cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
    if (cookie.value !== "") this.cookies.push(cookie);
  }
  header(url) {
    const u = new URL(url);
    return this.cookies
      .filter((c) => (u.hostname === c.domain || u.hostname.endsWith("." + c.domain)) && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  absorb(url, setCookieHeaders) {
    const u = new URL(url);
    let changed = false;
    for (const sc of [].concat(setCookieHeaders || [])) {
      const [kv, ...attrs] = sc.split(";").map((s) => s.trim());
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const attr = (n) => (attrs.find((a) => a.toLowerCase().startsWith(n + "=")) || "").slice(n.length + 1);
      const expires = attr("expires");
      const maxAge = attr("max-age");
      const expired = (maxAge !== "" && Number(maxAge) <= 0) || (expires && new Date(expires) < new Date());
      this.add({ name: kv.slice(0, i), value: expired ? "" : kv.slice(i + 1), domain: (attr("domain") || u.hostname).replace(/^\./, ""), path: attr("path") || "/" });
      changed = true;
    }
    return changed;
  }
  has(host, name) {
    return this.cookies.some((c) => c.name === name && (host === c.domain || host.endsWith("." + c.domain)));
  }
}

class Session {
  constructor(config, jar) {
    this.config = config;
    this.jar = jar;
  }

  static load() {
    const config = loadConfig();
    const saved = readJson(SESSION_FILE, null);
    if (!saved || !Array.isArray(saved.cookies) || !saved.cookies.length) throw new NeedsLogin();
    return new Session(config, new Jar(saved.cookies));
  }

  save() {
    writeJson(SESSION_FILE, { cookies: this.jar.cookies, updatedAt: new Date().toISOString() });
  }

  url(p) {
    return p.startsWith("http") ? p : this.config.baseUrl + p;
  }

  // raw: return redirects and errors as-is instead of turning them into NeedsLogin.
  async request(method, p, { form, headers = {}, raw = false } = {}) {
    const url = this.url(p);
    const res = await httpRequest(method, url, {
      headers: {
        cookie: this.jar.header(url),
        referer: this.config.baseUrl + "/Default.aspx",
        ...(form != null ? { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin } : {}),
        ...headers,
      },
      body: form,
    });
    if (this.jar.absorb(url, res.headers["set-cookie"])) this.save();
    if (!raw && (res.status === 302 || res.status === 401 || res.status === 403)) {
      const loc = res.headers.location || "";
      if (res.status !== 302 || /Login|identity|login\.microsoftonline/i.test(loc)) throw new NeedsLogin();
    }
    return res;
  }

  get(p) {
    return this.request("GET", p);
  }
  post(p, fields) {
    return this.request("POST", p, { form: new URLSearchParams(fields).toString() });
  }

  async info() {
    const res = await this.request("GET", "/api/session/current", { headers: { accept: "application/json" } });
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new NeedsLogin();
    }
    if (!data.active) throw new NeedsLogin();
    return data;
  }

  // Silent renewal: the app sends us to Unit4 Identity Services, which answers
  // with a self-posting token form as long as its own session cookie is
  // valid. No Microsoft round trip, so no MFA prompt. Returns false when the
  // identity server wants a real login.
  async renew() {
    const appHost = new URL(this.config.baseUrl).hostname;
    this.jar.cookies = this.jar.cookies.filter((c) => !(appHost === c.domain || appHost.endsWith("." + c.domain))); // start the app side clean
    const returnPath = new URL(this.config.baseUrl).pathname + "/Default.aspx";
    const first = await this.request("GET", `/Login/Login.aspx?ReturnUrl=${encodeURIComponent(returnPath)}`, { raw: true });
    const authorize = first.status === 302 ? first.headers.location : null;
    if (!authorize || !/\/connect\/authorize/.test(authorize)) return false;
    const ids = await this.request("GET", authorize, { raw: true });
    if (ids.status !== 200) return false; // 302 means "go to Microsoft": stop here
    const action = (ids.text.match(/<form[^>]*action=['"]([^'"]+)['"]/) || [])[1];
    const fields = [...ids.text.matchAll(/<input[^>]*name=['"]([^'"]+)['"][^>]*value=['"]([^'"]*)['"]/g)].map((m) => [m[1], decodeEntities(m[2])]);
    if (!action || !fields.some(([k]) => k === "id_token" || k === "code")) return false;
    const back = await this.request("POST", decodeEntities(action), { raw: true, form: new URLSearchParams(fields).toString(), headers: { referer: new URL(authorize).origin + "/" } });
    if (back.status !== 302 || !this.jar.has(new URL(this.config.baseUrl).hostname, ".ASPXAUTH")) return false;
    try {
      await this.info();
      return true;
    } catch {
      return false;
    }
  }

  screenPath() {
    const { menuId, client } = this.config;
    return `/ContentContainer.aspx?type=topgen&menu_id=${menuId}&activityStepId=1-1&addLaunchIndication=false&client=${client}`;
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
// The timesheet screen

class Screen {
  constructor(session, html) {
    this.session = session;
    this.html = html;
    this.parse();
  }

  static async open(session, date) {
    const res = await session.get(session.screenPath());
    let screen = new Screen(session, res.text);
    if (date && !screen.dayColumn(date)) {
      const target = screen.names.header + "date_in_period";
      screen = await screen.postback(target, undefined, { [target + "$i"]: formatDate(date, screen.regional.datePattern) });
    }
    return screen;
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

  // Header status field: "P" Draft, "N" Ready. The label comes from the lookup,
  // because the screen speaks the user's language. A save has to follow.
  async setHeaderStatus(code) {
    if (!this.names.status) throw new UbwError("Status field not found on the timesheet screen.");
    const { items } = await this.lookup(this.names.status, "");
    const option = items.find((i) => i.value === code);
    if (!option) throw new UbwError(`Status ${code} is not offered for period ${this.period} (offered: ${items.map((i) => i.value).join(", ") || "none"}).`);
    return this.postback(this.names.status + "$Control", "validate", {
      [this.names.status + "$Editor"]: option.description,
      [this.names.status + "$RowValue"]: option.value,
      [this.names.status + "$RowDescription"]: option.description,
    });
  }

  // One WebForms postback. `changes` are field values to set (marks their IsDirty flags).
  async postback(target, argument, changes = {}) {
    const body = { ...this.fields };
    for (const [k, v] of Object.entries(changes)) {
      body[k] = v;
      const dirty = k.replace(/\$(i|Editor|RowValue|RowDescription)$/, "$IsDirty");
      if (dirty !== k && dirty in body) body[dirty] = "true";
    }
    body.__EVENTTARGET = target;
    body.__EVENTARGUMENT = argument ?? "undefined";
    body.__LASTFOCUS = "";
    body["b$TCFocusedField"] = target;
    body["b$PageActiveElement"] = target;
    body.postbackCounter = String(Number(body.postbackCounter || 0) + 1);
    body.scrollPosA = "0,0";
    body.scrollPosI = "undefined";
    const res = await this.session.post(this.session.screenPath(), body);
    return new Screen(this.session, res.text);
  }

  // Every call hits the server: work orders come and go, so nothing is cached.
  // The server ignores BatchStart/BatchSize and returns at most 50 matches;
  // `more` tells the caller to narrow the search.
  async lookup(fieldName, text) {
    const list = this.lists[fieldName];
    if (!list) throw new UbwError(`No lookup control for ${fieldName}`);
    const res = await this.session.post("/System/Services/DataListService.aspx", { Search: text, Context: list.context, BatchStart: "1", BatchSize: "50" });
    const items = [...res.text.matchAll(/<item><value>([^<]*)<\/value><descr>([^<]*)<\/descr><\/item>/g)]
      .map((m) => ({ value: decodeEntities(m[1]), description: decodeEntities(m[2]) }))
      .filter((it) => it.description !== "[NEW]");
    return { items, more: /<hasmoredata>True<\/hasmoredata>/i.test(res.text) };
  }

  listField(row, title) {
    return Object.keys(this.lists).find((n) => n.startsWith(row.name + "$") && this.lists[n].title === title) || null;
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
// Browser login: launch a Chromium browser with a private profile, wait for the
// SSO round trip to land on the app, copy the cookies out over CDP (pipe).

function findBrowser() {
  if (process.env.UBW_BROWSER) return process.env.UBW_BROWSER;
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LocalAppData"]].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, "Google/Chrome/Application/chrome.exe"),
        path.join(root, "Microsoft/Edge/Application/msedge.exe"),
        path.join(root, "BraveSoftware/Brave-Browser/Application/brave.exe"),
        path.join(root, "Chromium/Application/chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    );
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
    for (const dir of (process.env.PATH || "").split(path.delimiter)) for (const n of names) candidates.push(path.join(dir, n));
    candidates.push("/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge");
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  throw new UbwError("No Chromium-based browser found (Chrome, Edge, Brave, Chromium). Set UBW_BROWSER=<path to browser executable>.");
}

class BrowserCdp {
  constructor(exe, args, { headless = false } = {}) {
    const flags = [
      `--user-data-dir=${PROFILE_DIR}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--window-size=1100,900",
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      ...(headless ? ["--headless=new"] : []),
      ...args,
    ];
    this.child = spawn(exe, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: !!headless });
    this.exited = new Promise((resolve) => this.child.on("exit", resolve));
    this.child.on("error", () => {});
    this.seq = 0;
    this.pending = new Map();
    let buf = "";
    this.child.stdio[4].on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(msg);
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          }
        } catch {}
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.child.stdio[3].write(JSON.stringify({ id, method, params }) + "\0");
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
    });
  }
  async close() {
    try {
      await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 2000))]);
    } catch {}
    setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }, 3000).unref();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 4000))]);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function registrableDomain(baseUrl) {
  return new URL(baseUrl).hostname.split(".").slice(-2).join(".");
}

// Opens a browser window on the app, waits for the SSO round trip to land,
// and returns a Session built from the browser's cookies (app + identity
// server). Null when the user did not finish in time.
async function browserLogin(config, { timeoutMs, log }) {
  const exe = findBrowser();
  const landing = config.baseUrl + "/Default.aspx";
  const browser = new BrowserCdp(exe, [landing], { headless: false });
  const deadline = Date.now() + timeoutMs;
  try {
    try {
      await browser.send("Target.getTargets");
    } catch (e) {
      throw new UbwError(`Browser did not answer over the debugging pipe (${exe}): ${e.message}`);
    }
    log("A browser window opened. Log in there; this command continues when the timesheet app loads.");
    while (Date.now() < deadline) {
      await sleep(700);
      let targets;
      try {
        targets = (await browser.send("Target.getTargets")).targetInfos;
      } catch {
        break; // browser closed by the user
      }
      const onApp = targets.some((t) => t.type === "page" && t.url.startsWith(config.baseUrl) && !/\/Login\//i.test(t.url));
      if (!onApp) continue;
      const { cookies } = await browser.send("Storage.getCookies");
      const jar = Jar.fromCdp(cookies, registrableDomain(config.baseUrl));
      if (!jar.has(new URL(config.baseUrl).hostname, ".ASPXAUTH")) continue;
      const session = new Session(config, jar);
      try {
        await session.info();
        return session;
      } catch {
        /* the app is still finishing the login */
      }
    }
    return null;
  } finally {
    await browser.close();
  }
}

function persist(session, info) {
  session.config = { ...session.config, client: info.client, userId: info.userId };
  writeJson(CONFIG_FILE, { baseUrl: session.config.baseUrl, menuId: session.config.menuId, client: info.client, userId: info.userId });
  session.save();
  return session;
}

// Silent path first (identity server session), browser window only when asked.
async function ensureLoggedIn(config, { interactive, log }) {
  let session = null;
  try {
    session = Session.load();
  } catch {
    /* no stored session */
  }
  if (session && (await session.renew().catch(() => false))) return persist(session, await session.info());
  if (!interactive) throw new NeedsLogin();
  session = await browserLogin(config, { timeoutMs: 5 * 60 * 1000, log });
  if (!session) throw new NeedsLogin("Sign-in did not finish within 5 minutes. Run the login command again.");
  return persist(session, await session.info());
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
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["json", "help", "draft", "fresh"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function withSession(flags, fn) {
  let session;
  try {
    session = Session.load();
    await session.info();
  } catch (e) {
    if (!(e instanceof NeedsLogin)) throw e;
    session = await ensureLoggedIn(loadConfig(), { interactive: false, log: (m) => console.error(m) });
  }
  return fn(session);
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

const commands = {
  async login({ flags }) {
    const config = loadConfig();
    if (flags.url) config.baseUrl = String(flags.url).replace(/\/+$/, "");
    if (flags.menu) config.menuId = String(flags.menu);
    if (flags.url || flags.menu) writeJson(CONFIG_FILE, { ...readJson(CONFIG_FILE, {}), baseUrl: config.baseUrl, menuId: config.menuId });
    if (flags.cookie) {
      // Escape hatch: paste the Cookie header of a logged-in request to the app.
      const jar = new Jar();
      const host = new URL(config.baseUrl).hostname;
      for (const part of String(flags.cookie).split(";")) {
        const i = part.indexOf("=");
        if (i > 0) jar.add({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: host, path: "/" });
      }
      const session = new Session(config, jar);
      const info = await session.info();
      persist(session, info);
      return out.json({ ok: true, userId: info.userId, client: info.client, renewable: false });
    }
    if (flags.fresh) fs.rmSync(SESSION_FILE, { force: true });
    const session = await ensureLoggedIn(config, { interactive: true, log: (m) => console.error(m) });
    const info = await session.info();
    out.json({ ok: true, userId: info.userId, client: info.client, baseUrl: config.baseUrl, sessionMinutesLeft: Math.round(info.timeleft / 6e8) });
  },

  async logout() {
    for (const f of [SESSION_FILE]) fs.rmSync(f, { force: true });
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    out.json({ ok: true });
  },

  async whoami({ flags }) {
    await withSession(flags, async (session) => {
      const info = await session.info();
      out.json({ userId: info.userId, client: info.client, baseUrl: session.config.baseUrl, sessionMinutesLeft: Math.round(info.timeleft / 6e8) });
    });
  },

  async show({ flags, positional }) {
    const date = parseIsoDate(positional[0] || "today");
    await withSession(flags, async (session) => {
      const screen = await Screen.open(session, date);
      printScreen(screen, flags);
    });
  },

  async search({ flags, positional }) {
    const text = positional.join(" ");
    if (!text) throw new UbwError("Usage: ubw search <text>");
    await withSession(flags, async (session) => {
      let screen = await Screen.open(session);
      screen = await screen.postback(screen.buttons.add); // an empty row gives an unfiltered lookup
      const row = screen.editingRow;
      const field = row && screen.listField(row, "Work order");
      if (!field) throw new UbwError("Could not open a lookup row.");
      // The server matches the whole phrase; query the longest word and filter on the rest here.
      const words = text.split(/\s+/).filter(Boolean);
      const query = words.reduce((a, b) => (b.length > a.length ? b : a));
      const found = await screen.lookup(field, query);
      const items = found.items.filter((i) => words.every((w) => (i.value + " " + i.description).toLowerCase().includes(w.toLowerCase())));
      if (flags.json) return out.json({ query, truncated: found.more, items });
      if (!items.length) console.log("No matching work orders.");
      else out.table(items.map((i) => ({ workOrder: i.value, description: i.description })));
      if (found.more) console.log(`Server capped "${query}" at 50 matches; use a more specific word to see the rest.`);
    });
  },

  async set({ flags, positional }) {
    const [workOrder, ...specs] = positional;
    if (!workOrder || !specs.length) throw new UbwError("Usage: ubw set <work-order> <YYYY-MM-DD=hours> [more days...] [--timecode 0]");
    const timecode = flags.timecode != null ? String(flags.timecode) : "0";
    let entries = specs.map((s) => {
      const m = /^([^=]+)=(-?\d+(?:[.,]\d+)?)$/.exec(s);
      if (!m) throw new UbwError(`Bad entry "${s}". Use YYYY-MM-DD=hours, e.g. 2026-09-07=8`);
      return { date: parseIsoDate(m[1]), hours: parseFloat(m[2].replace(",", ".")) };
    });
    await withSession(flags, async (session) => {
      const results = [];
      while (entries.length) {
        let screen = await Screen.open(session, entries[0].date);
        const inPeriod = entries.filter((e) => screen.dayColumn(e.date));
        if (!inPeriod.length) throw new UbwError(`Date ${isoDate(entries[0].date)} is not in period ${screen.period}.`);
        entries = entries.filter((e) => !inPeriod.includes(e));

        let row = screen.findRow(workOrder, timecode);
        const wanted = inPeriod.filter((e) => !row || row.hours[isoDate(e.date)] !== e.hours);
        if (row && !wanted.length) {
          // Nothing to write; the server stays silent on a save without changes.
          results.push({ period: screen.period, changed: false, row: rowSummary(row), messages: screen.messages });
          continue;
        }
        if (row && !row.editing) {
          screen = await screen.postback(row.name + "$_edit");
          row = screen.findRow(workOrder, timecode);
          if (!row || !row.editing) throw new UbwError(`Row ${workOrder} in period ${screen.period} is not editable (status "${row?.status || "?"}").`, { details: screen.messages });
        }
        if (!row) {
          if (!screen.buttons.add) throw new UbwError(`Period ${screen.period} is ${screen.status.label}; rows cannot be added.`);
          screen = await screen.postback(screen.buttons.add);
          const fresh = screen.editingRow;
          if (!fresh) throw new UbwError("Could not add a row.", { details: screen.messages });
          const woField = screen.listField(fresh, "Work order");
          const changes = { [woField + "$Editor"]: workOrder, [woField + "$RowValue"]: workOrder };
          if (timecode !== fresh.timecode) {
            const tcField = screen.listField(fresh, "Time code");
            changes[tcField + "$Editor"] = timecode;
            changes[tcField + "$RowValue"] = timecode;
          }
          screen = await screen.postback(woField + "$Control", "validate", changes);
          row = screen.findRow(workOrder, timecode);
          if (!row || !row.editing) throw new UbwError(`Work order ${workOrder} was not accepted.`, { details: screen.messages });
        }
        // Type each day the way the browser does: the cell's change event is a
        // postback of its own, and the server computes the row's invoice value
        // (Zoom > Inv.value) only there. Hours that ride on Save alone are stored
        // with Inv.value 0, so the project gets them as negative invoice hours.
        for (const e of wanted) {
          const input = screen.editingRow?.cells[screen.dayColumn(e.date).column]?.input;
          if (!input) throw new UbwError(`No editable cell for ${isoDate(e.date)}.`);
          screen = await screen.postback(input.slice(0, -"$i".length), undefined, { [input]: formatHours(e.hours, screen.regional.decimalSep) });
          if (screen.messages.errors.length) throw new UbwError(`Unit4 rejected ${isoDate(e.date)}=${e.hours}: ${describeMessages(screen.messages).join(" | ")}`, { details: screen.messages });
        }
        screen = await screen.postback(screen.buttons.save);
        const saved = screen.findRow(workOrder, timecode);
        results.push({ period: screen.period, changed: true, row: saved ? rowSummary(saved) : null, messages: screen.messages });
        const mismatch = saved && wanted.find((e) => saved.hours[isoDate(e.date)] !== e.hours);
        if (screen.messages.errors.length || screen.messages.result?.type !== "success" || !saved || mismatch) {
          throw new UbwError(`Save failed for period ${screen.period}: ${describeMessages(screen.messages).join(" | ") || (mismatch ? `${isoDate(mismatch.date)} shows ${saved.hours[isoDate(mismatch.date)]} instead of ${mismatch.hours}` : "no confirmation from server")}`, { details: results });
        }
        // The invoice value is not in the grid; the row's Zoom dialog shows it.
        // Right after Save the dialog shows zeros, so read it from a fresh load.
        const reloaded = await Screen.open(session, inPeriod[0].date);
        const stored = reloaded.findRow(workOrder, timecode);
        if (!stored) throw new UbwError(`Row ${workOrder} is missing after reloading period ${reloaded.period}.`, { details: results });
        const zoom = await reloaded.postback(stored.name + "$zoom", "action:Zoom");
        const detail = (suffix) => Object.entries(zoom.fields).find(([k]) => !k.startsWith(zoom.names.grid) && k.endsWith(suffix))?.[1];
        const sum = detail("$reg_value$i"), inv = detail("$inv_value$i");
        if (sum == null || inv == null) throw new UbwError(`Could not read Inv.value for ${workOrder} in period ${screen.period}; check the row's Zoom dialog in Unit4.`, { details: results });
        if (parseHours(inv, screen.regional.decimalSep) !== parseHours(sum, screen.regional.decimalSep))
          throw new UbwError(`Period ${screen.period}: ${workOrder} saved with Sum ${sum} but Inv.value ${inv}; the project would invoice the wrong hours.`, { details: results });
      }
      if (flags.json) out.json(results);
      else for (const r of results) {
        console.log(r.changed ? r.messages.result.message : `Period ${r.period}: already had these hours, nothing saved`);
        if (r.row) out.table([{ workOrder: r.row.workOrder, description: r.row.description.slice(0, 40), status: r.row.status, ...Object.fromEntries(Object.entries(r.row.hours).map(([d, h]) => [d.slice(5), h.toFixed(2)])), sum: r.row.sum.toFixed(2) }]);
      }
    });
  },

  async delete({ flags, positional }) {
    const [workOrder, dateArg] = positional;
    if (!workOrder || !dateArg) throw new UbwError("Usage: ubw delete <work-order> <YYYY-MM-DD> [--timecode 0]");
    const timecode = flags.timecode != null ? String(flags.timecode) : "0";
    await withSession(flags, async (session) => {
      let screen = await Screen.open(session, parseIsoDate(dateArg));
      const row = screen.findRow(workOrder, timecode);
      if (!row) throw new UbwError(`No row for ${workOrder} in period ${screen.period}.`);
      if (!screen.buttons.delete) throw new UbwError(`Period ${screen.period} is ${screen.status.label}; rows cannot be removed.`);
      screen = await screen.postback(screen.buttons.delete, undefined, { [row.name + "$_delete"]: "on" });
      if (screen.findRow(workOrder, timecode)) throw new UbwError(`Row ${workOrder} could not be removed.`, { details: screen.messages });
      screen = await screen.postback(screen.buttons.save);
      if (flags.json) out.json({ period: screen.period, messages: screen.messages, rows: screen.toJSON().rows });
      else printScreen(screen, flags);
      if (screen.messages.errors.length) throw new UbwError("Save reported errors.", { details: screen.messages });
    });
  },

  async submit({ flags, positional }) {
    const date = parseIsoDate(positional[0] || "today");
    const wanted = flags.draft ? "P" : "N";
    const rowWanted = flags.draft ? "Draft" : "Ready";
    await withSession(flags, async (session) => {
      let screen = await Screen.open(session, date);
      if (!screen.rows.length) throw new UbwError(`Period ${screen.period} has no rows to submit.`);
      if (screen.status.code === wanted && screen.rows.every((r) => r.status === rowWanted)) {
        if (flags.json) out.json(screen.toJSON());
        else {
          printScreen(screen, flags);
          console.log(`Period ${screen.period}: already ${flags.draft ? "Draft" : "sent for approval"}, nothing saved`);
        }
        return;
      }
      if (!screen.buttons.ready) throw new UbwError(`Period ${screen.period} is ${screen.status.label}; status cannot change.`);
      // Two things carry a status: every grid row, and the timesheet header. The
      // grid buttons move the rows only; a period whose rows are Ready under a
      // Draft header reports "Parts of the timesheet ... have been sent for
      // approval" and still waits for the employee. The header field moves the
      // period as a whole, so the header goes first on the way back to Draft and
      // last on the way to Ready.
      const mark = () => Object.fromEntries(screen.rows.map((r) => [r.name + "$_delete", "on"]));
      if (flags.draft && screen.status.code !== wanted) screen = await screen.setHeaderStatus(wanted);
      screen = await screen.postback(flags.draft ? screen.buttons.draft : screen.buttons.ready, flags.draft ? "action:SetDraftStatus" : "action:SetSubmitStatus", mark());
      if (screen.status.code !== wanted) screen = await screen.setHeaderStatus(wanted);
      screen = await screen.postback(screen.buttons.save);
      if (flags.json) out.json(screen.toJSON());
      else printScreen(screen, flags);
      if (screen.messages.errors.length) throw new UbwError("Save reported errors.", { details: screen.messages });
      if (screen.status.code !== wanted) throw new UbwError(`Period ${screen.period} still has status ${screen.status.label} (${screen.status.code}).`, { details: screen.messages });
      // Rows that the approver already holds do not come back on the employee's request.
      const stuck = screen.rows.filter((r) => r.status !== rowWanted);
      if (stuck.length)
        throw new UbwError(
          `Period ${screen.period} header is ${screen.status.label}, but ${stuck.map((r) => `${r.workOrder} (${r.status})`).join(", ")} did not change to ${rowWanted}.` +
            (flags.draft ? " Unit4 keeps rows that are already sent for approval; the approver has to reject them." : ""),
          { details: screen.messages },
        );
      if (screen.messages.result?.type !== "success") throw new UbwError("Submit did not confirm success.", { details: screen.messages });
    });
  },

  help() {
    console.log(`ubw - Unit4 ERP timesheet CLI

  ubw login [--url BASE] [--menu TS1611]   renew silently, else log in through a browser window; --fresh forces the window
  ubw login --cookie "name=value; ..."      save a pasted Cookie header instead (no silent renewal later)
  ubw whoami                                session check
  ubw show [DATE]                           timesheet period containing DATE (default today)
  ubw search TEXT                           find work orders by code or description
  ubw set WO DATE=HOURS [DATE=HOURS ...]    write hours on the row for work order WO (adds the row when missing), saves as draft
  ubw delete WO DATE                        remove the WO row from the period containing DATE
  ubw submit [DATE] [--draft]               set the rows and the period to Ready and save (sends for approval); --draft takes the period back
  ubw logout                                forget session and browser profile

DATE is YYYY-MM-DD, today or yesterday. Add --json for machine output.
Exit codes: 0 ok, 1 error, 2 login needed.

Environment:
  UBW_HOME     data directory (default ~/.ubw-timesheet)
  UBW_BROWSER  browser executable when none is found (Chrome, Edge, or Brave)
  UBW_DEBUG    directory; every page received is written there`);
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

export { Screen, Session, BrowserCdp, browserLogin, findBrowser, parseInputs, tags, elementAt, childElements };
