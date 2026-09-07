// Platform smoke test for scripts/ubw.mjs. It needs no Unit4 account: it
// checks the parts that differ per operating system (entry detection through
// symlinks, data directory handling, browser discovery, and the CDP pipe
// transport) against a headless browser on about:blank.
//
// Run: node test/smoke.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ubw-timesheet", "scripts");
const script = path.join(scriptsDir, "ubw.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ubw-smoke-"));
process.env.UBW_HOME = home;
const env = { ...process.env, UBW_HOME: home };
const results = [];
const step = (name, ok, note = "") => {
  results.push({ name, ok, note });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? ` (${note})` : ""}`);
};

function run(file, args) {
  const r = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 60000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// 1. The script runs as an entry point, also through a symlink or junction.
{
  const direct = run(script, ["help"]);
  step("help runs directly", direct.status === 0 && direct.stdout.includes("ubw - Unit4 ERP timesheet CLI"), `exit ${direct.status}`);

  const link = path.join(home, "linked-scripts");
  fs.symlinkSync(scriptsDir, link, process.platform === "win32" ? "junction" : "dir");
  const viaLink = run(path.join(link, "ubw.mjs"), ["help"]);
  step("help runs through a symlink", viaLink.status === 0 && viaLink.stdout.includes("ubw - Unit4 ERP timesheet CLI"), `exit ${viaLink.status}`);
}

// 2. Without a stored session every command asks for the login command.
{
  const r = run(script, ["whoami"]);
  step("whoami exits 2 without a session", r.status === 2 && r.stderr.includes("login command"), `exit ${r.status}`);
}

// 3. Browser discovery and the CDP pipe transport.
const { BrowserCdp, findBrowser } = await import(pathToFileURL(script).href);
let exe = null;
try {
  exe = findBrowser();
  step("browser found", fs.existsSync(exe), exe);
} catch (e) {
  step("browser found", false, e.message);
}

if (exe) {
  const extra = process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [];
  const browser = new BrowserCdp(exe, [...extra, "about:blank"], { headless: true });
  try {
    let version = null;
    for (let attempt = 0; attempt < 6 && !version; attempt++) {
      try {
        version = await browser.send("Browser.getVersion");
      } catch (e) {
        if (browser.child.exitCode !== null) throw new Error(`browser exited with code ${browser.child.exitCode}`);
      }
    }
    step("CDP over pipe answers", !!version, version?.product);

    const targets = await browser.send("Target.getTargets");
    step("page target on about:blank", targets.targetInfos.some((t) => t.type === "page" && t.url === "about:blank"));

    const cookies = await browser.send("Storage.getCookies");
    step("Storage.getCookies works", Array.isArray(cookies.cookies), `${cookies.cookies.length} cookies`);

    step("profile lives under UBW_HOME", fs.existsSync(path.join(home, "browser-profile")));
  } catch (e) {
    step("CDP session", false, e.message);
  } finally {
    await browser.close();
    await new Promise((r) => setTimeout(r, 500));
    step("browser exits on close", browser.child.exitCode !== null || browser.child.signalCode !== null, `code ${browser.child.exitCode}, signal ${browser.child.signalCode}`);
  }
}

fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${process.platform} ${os.release()} node ${process.version}: ${results.length - failed.length}/${results.length} checks passed`);
assert.equal(failed.length, 0, `failed: ${failed.map((r) => r.name).join(", ")}`);
