// Platform smoke test for scripts/ubw.mjs. It needs no Unit4 account: it
// checks the parts that differ per operating system (entry detection through
// symlinks, starting agent-browser, and the sign-in guard) against the real
// Unit4 sign-in redirect, with an empty data directory.
//
// Run: node test/smoke.mjs  (agent-browser must be installed)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ubw-timesheet", "scripts");
const script = path.join(scriptsDir, "ubw.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ubw-smoke-"));
const session = `ubw-smoke-${process.pid}`;
const env = { ...process.env, UBW_HOME: home, UBW_SESSION: session };
const results = [];
const step = (name, ok, note = "") => {
  results.push({ name, ok, note });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? ` (${note})` : ""}`);
};

function run(file, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 180000 });
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

// 2. Without agent-browser on PATH the script names the install command.
{
  const empty = fs.mkdtempSync(path.join(home, "empty-path-"));
  const r = run(script, ["whoami"], { PATH: empty, Path: empty });
  step("whoami exits 3 without agent-browser", r.status === 3 && r.stderr.includes("npm install -g agent-browser"), `exit ${r.status}`);
}

// 3. With agent-browser and no stored session, Unit4 redirects to Microsoft;
//    the headless run aborts that page and asks for the login command.
{
  const r = run(script, ["whoami"]);
  step("whoami exits 2 without a session", r.status === 2 && r.stderr.includes("login command"), `exit ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
  step("no state file written", !fs.existsSync(path.join(home, "browser-state.json")));

  const list = spawnSync("agent-browser", ["session", "list", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  const open = JSON.parse(list.stdout || "{}").data?.sessions?.some((s) => JSON.stringify(s).includes(session));
  step("browser session closed", list.status === 0 && !open);
}

fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${process.platform} ${os.release()} node ${process.version}: ${results.length - failed.length}/${results.length} checks passed`);
assert.equal(failed.length, 0, `failed: ${failed.map((r) => r.name).join(", ")}`);
