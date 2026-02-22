#!/usr/bin/env node

// ═══════════════════════════════════════════════════
//  Claude Code Patcher
//  Model output limits · Max effort unlock
//  macOS · Linux · Windows · Node 18+
//
//  node claude-code-patch.mjs          Interactive
//  node claude-code-patch.mjs --auto   Effort only
//  node claude-code-patch.mjs --undo   Restore
// ═══════════════════════════════════════════════════

import { readFileSync, writeFileSync, copyFileSync, existsSync, realpathSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { platform, homedir, arch } from "os";
import { createInterface, emitKeypressEvents } from "readline";

// ── ANSI ─────────────────────────────────────────

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const _ = (c, t) => (tty ? `\x1b[${c}m${t}\x1b[0m` : t);
const bold = (t) => _(1, t);
const dim = (t) => _(2, t);
const red = (t) => _(31, t);
const green = (t) => _(32, t);
const yellow = (t) => _(33, t);
const cyan = (t) => _(36, t);
const bgRed = (t) => _("41;97", t);
const bgGreen = (t) => _("42;97", t);
const HIDE = tty ? "\x1b[?25l" : "";
const SHOW = tty ? "\x1b[?25h" : "";
const CLR = tty ? "\x1b[2K" : "";
const UP = (n) => (tty ? `\x1b[${n}A` : "");

// ── Helpers ──────────────────────────────────────

const die = (m) => {
  process.stdout.write(SHOW);
  console.error(`\n ${red(bold("✗"))} ${m}\n`);
  process.exit(1);
};
const ok = (m) => console.log(` ${green(bold("✓"))} ${m}`);
const info = (m) => console.log(` ${cyan("›")} ${m}`);
const warn = (m) => console.log(` ${yellow("⚠")} ${m}`);
const fmt = (n) => Number(n).toLocaleString("en-US");

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};

const parseK = (v) => {
  v = String(v).trim().toLowerCase().replace(/,/g, "");
  if (v.endsWith("k")) return parseInt(v) * 1000;
  return parseInt(v);
};

// ── Find cli.js ──────────────────────────────────

function findCli() {
  const os = platform(),
    home = homedir(),
    p = [];
  const pkg = (...a) => p.push(join(...a, "@anthropic-ai", "claude-code", "cli.js"));
  const raw = (...a) => p.push(join(...a));

  const bin = sh(os === "win32" ? "where claude 2>nul" : "which claude 2>/dev/null");
  if (bin)
    try {
      const r = realpathSync(bin.split("\n")[0].trim()),
        d = dirname(r);
      raw(d, "cli.js");
      pkg(d, "..", "lib", "node_modules");
      pkg(d, "..", "node_modules");
    } catch {}

  const npm = sh("npm root -g");
  if (npm) pkg(npm);
  const pnpm = sh("pnpm root -g");
  if (pnpm) pkg(pnpm);
  if (process.env.VOLTA_HOME) pkg(process.env.VOLTA_HOME, "tools", "image", "packages");
  const bun = sh("bun pm -g bin");
  if (bun) pkg(dirname(bun), "node_modules");

  if (os === "win32") {
    const ad = process.env.APPDATA || join(home, "AppData", "Roaming");
    const la = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    pkg(ad, "npm", "node_modules");
    raw(la, "Programs", "claude-code", "cli.js");
    raw(home, ".claude", "local", "cli.js");
  } else if (os === "darwin") {
    const brew = arch() === "arm64" ? "/opt/homebrew" : "/usr/local";
    for (const d of ["/usr/local/lib/node_modules", join(brew, "lib", "node_modules"), join(home, ".npm-global", "lib", "node_modules")])
      pkg(d);
    raw(home, ".claude", "local", "cli.js");
  } else {
    for (const d of ["/usr/lib/node_modules", "/usr/local/lib/node_modules", join(home, ".npm-global", "lib", "node_modules"), join(home, ".local", "lib", "node_modules")])
      pkg(d);
    raw(home, ".local", "share", "claude-code", "cli.js");
    raw(home, ".claude", "local", "cli.js");
  }

  for (const f of p)
    try {
      if (existsSync(f)) return realpathSync(f);
    } catch {}
  return null;
}

// ── Source analysis ──────────────────────────────
//
// Dynamically parses the model→limits function and
// detects the state of all 5 patchable sites.
// Zero hardcoded model names — everything is read
// from the binary at runtime.

function parseModels(src) {
  // Match: VAR.includes("id")||... )VAR=NUM,VAR=NUM
  const re = /((?:\w\.includes\("[^"]+"\)(?:\|\|)?)+)\)(\w)=(\d+),(\w)=(\d+)/g;
  const idRe = /includes\("([^"]+)"\)/g;
  const groups = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const ids = [];
    let mm;
    while ((mm = idRe.exec(m[1])) !== null) ids.push(mm[1]);
    idRe.lastIndex = 0;
    groups.push({
      ids,
      condVar: m[1].match(/^(\w)\./)?.[1] ?? "q",
      defVar: m[2],
      defVal: +m[3],
      limVar: m[4],
      limVal: +m[5],
      raw: m[0],
      idx: m.index,
    });
  }
  return groups;
}

function analyze(src) {
  return {
    // Effort gate: blocks "max" in interactive mode
    effortGate: {
      locked: /effort==="max"&&\(!\w\|\|\w+\(\)\)/.test(src),
      unlocked: /effort==="max"&&false/.test(src),
    },
    // Effort bar + cycling: ["low","medium","high"] without "max"
    effortLevels: {
      count: (src.match(/\["low","medium","high"\]/g) || []).length,
      patched: (src.match(/\["low","medium","high","max"\]/g) || []).length >= 4,
    },
    // Effort chooser dialog: max option in [H,O] picker
    effortChooser: {
      needsPatch: /==="medium"\?\[\w,\w\]:\[\w,\w\]/.test(src) && !/label:"Use max effort"/.test(src),
      patched: /label:"Use max effort"/.test(src),
    },
  };
}

// ── Patch builders ───────────────────────────────
//
// Each function takes source → returns patched source.
// All use regex so they survive variable renames.

function patchModelLimits(src, groups, selected, newLimit) {
  let out = src;
  const sel = new Set(selected);

  // Process last-to-first to preserve indices
  for (const g of [...groups].sort((a, b) => b.idx - a.idx)) {
    const hit = g.ids.filter((id) => sel.has(id));
    const miss = g.ids.filter((id) => !sel.has(id));
    if (!hit.length) continue;

    const { condVar: v, defVar: k, defVal: dv, limVar: y, limVal: lv } = g;
    let rep;

    if (!miss.length) {
      // Whole group → swap the number
      rep = g.raw.replace(new RegExp(`${y}=\\d+`), `${y}=${newLimit}`);
    } else {
      // Split: selected get new limit, rest keep old
      const sCond = hit.map((id) => `${v}.includes("${id}")`).join("||");
      const uCond = miss.map((id) => `${v}.includes("${id}")`).join("||");
      rep = `${sCond})${k}=${dv},${y}=${newLimit};else if(${uCond})${k}=${dv},${y}=${lv}`;
    }

    out = out.slice(0, g.idx) + rep + out.slice(g.idx + g.raw.length);
  }
  return out;
}

function patchEffortGate(src) {
  return src.replace(/effort==="max"&&\(!\w\|\|\w+\(\)\)/, `effort==="max"&&false`);
}

function patchEffortLevels(src) {
  // Add "max" to every ["low","medium","high"] array that lacks it.
  // These are the bar display (di4) and ←→ cycling (ci4) arrays.
  // Arrays that already include "max" won't match.
  return src.replaceAll(`["low","medium","high"]`, `["low","medium","high","max"]`);
}

function patchEffortChooser(src) {
  // Inject "Use max effort" into the /model effort picker dialog.
  // Pattern: j=J==="medium"?[H,O]:[O,H]
  const re = /(\w)=(\w)==="medium"\?\[(\w),(\w)\]:\[\4,\3\]/;
  const m = src.match(re);
  if (!m) return src;
  const [, j, J, H, O] = m;
  const mx = `{label:"Use max effort",description:"Maximum reasoning depth. Highest token cost.",value:"max"}`;
  const rep = `${j}=${J}==="medium"?[${H},${O},${mx}]:${J}==="max"?[${mx},${O},${H}]:[${O},${H},${mx}]`;
  return src.slice(0, m.index) + rep + src.slice(m.index + m[0].length);
}

// ── TUI: multi-select ────────────────────────────

async function multiSelect(items, title, subtitle) {
  if (!process.stdin.isTTY) return items.filter((i) => i.pre);

  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let cur = Math.max(0, items.findIndex((i) => i.pre));
    const sel = new Set(items.map((it, i) => (it.pre ? i : -1)).filter((i) => i >= 0));
    const h = items.length + 3;

    stdout.write(HIDE);
    stdout.write("\n".repeat(h));

    const render = () => {
      stdout.write(UP(h));
      stdout.write(`${CLR} ${bold(title)}  ${dim("↑↓ move  space select  a all  enter done")}\n`);
      stdout.write(`${CLR} ${dim(subtitle || "")}\n`);
      stdout.write(`${CLR}\n`);
      for (let i = 0; i < items.length; i++) {
        const on = sel.has(i),
          at = i === cur;
        const box = on ? green("✓") : dim("·");
        const ptr = at ? cyan("❯") : " ";
        const lbl = at ? bold(items[i].label) : items[i].label;
        const val = items[i].right || "";
        const hint = items[i].hint ? `  ${dim(items[i].hint)}` : "";
        const gap = Math.max(1, 28 - (items[i].label?.length || 0));
        stdout.write(`${CLR}  ${ptr} ${box} ${lbl}${" ".repeat(gap)}${dim(val)}${hint}\n`);
      }
    };

    render();
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners("keypress");
      stdout.write(SHOW);
      resolve(items.filter((_, i) => sel.has(i)));
    };

    stdin.on("keypress", (ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { stdout.write(SHOW); process.exit(0); }
      if (key.name === "return") return done();
      if (key.name === "space") { sel.has(cur) ? sel.delete(cur) : sel.add(cur); render(); }
      if (key.name === "up") { cur = (cur - 1 + items.length) % items.length; render(); }
      if (key.name === "down") { cur = (cur + 1) % items.length; render(); }
      if (key.name === "a") {
        const allOn = items.every((_, i) => sel.has(i));
        if (allOn) sel.clear(); else items.forEach((_, i) => sel.add(i));
        render();
      }
    });
  });
}

async function ask(prompt, defaultVal) {
  if (!process.stdin.isTTY) return String(defaultVal);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(` ${prompt}`, (ans) => { rl.close(); r(ans.trim() || String(defaultVal)); });
  });
}

async function confirm(prompt, def = true) {
  const a = await ask(`${prompt} ${dim(def ? "(Y/n)" : "(y/N)")} `, def ? "y" : "n");
  return a.toLowerCase().startsWith("y");
}

// ── Diff display ─────────────────────────────────

function snippet(src, pattern) {
  const m = typeof pattern === "string" ? (() => { const i = src.indexOf(pattern); return i >= 0 ? { index: i, 0: pattern } : null; })() : src.match(pattern);
  if (!m) return null;
  const pad = 55, i = m.index, len = m[0].length;
  const a = Math.max(0, i - pad), z = Math.min(src.length, i + len + pad);
  const pre = src.slice(a, i).replace(/\n/g, "↵");
  const hit = src.slice(i, i + len).replace(/\n/g, "↵");
  const post = src.slice(i + len, z).replace(/\n/g, "↵");
  return { pre, hit, post };
}

function showSnip(tag, src, pattern, colorFn) {
  const s = snippet(src, pattern);
  if (!s) return;
  console.log(`   ${tag} ${dim("…" + s.pre)}${colorFn(bold(s.hit))}${dim(s.post + "…")}`);
}

// ── Write with auto-sudo ─────────────────────────

function writeSafe(path, data) {
  try { writeFileSync(path, data, "utf8"); return; } catch {}
  if (platform() === "win32") die("Permission denied. Run as Administrator.");
  warn("Permission denied — retrying with sudo…");
  const tmp = join(homedir(), ".cc-patch-tmp");
  writeFileSync(tmp, data, "utf8");
  try { execSync(`sudo cp "${tmp}" "${path}"`, { stdio: "inherit" }); }
  catch { die(`Write failed. Try: sudo node ${process.argv[1]}`); }
  try { execSync(`rm -f "${tmp}"`); } catch {}
}

// ── Banner ───────────────────────────────────────

function banner() {
  console.log();
  console.log(`  ${dim("┌" + "─".repeat(40) + "┐")}`);
  console.log(`  ${dim("│")}  ${bold("⚡ Claude Code Patcher")}${" ".repeat(17)}${dim("│")}`);
  console.log(`  ${dim("│")}  ${dim("Output limits · Max effort · Universal")} ${dim("│")}`);
  console.log(`  ${dim("└" + "─".repeat(40) + "┘")}`);
  console.log();
}

// ── Main ─────────────────────────────────────────

async function main() {
  banner();

  const cliPath = findCli();
  if (!cliPath) die("Cannot find Claude Code cli.js.\n   Install: npm i -g @anthropic-ai/claude-code@next");

  // ── Undo ──
  if (process.argv.includes("--undo")) {
    const bak = cliPath + ".bak";
    if (!existsSync(bak)) die("No backup found at " + bak);
    writeSafe(cliPath, readFileSync(bak, "utf8"));
    ok("Restored from backup.\n");
    return;
  }

  ok(`Found ${dim(cliPath)}`);
  const ver = sh("claude --version");
  if (ver) info(`Version ${bold(ver)}`);

  let src;
  try { src = readFileSync(cliPath, "utf8"); } catch (e) { die(`Read failed: ${e.message}`); }

  const groups = parseModels(src);
  if (!groups.length) die("No model branches found. Claude Code internals may have changed.");

  const state = analyze(src);
  const isAuto = process.argv.includes("--auto");

  // ── Flatten models for display ──
  const flat = [];
  for (const g of groups)
    for (const id of g.ids)
      flat.push({ id, group: g, limit: g.limVal, def: g.defVal });

  // ── Model table ──
  console.log();
  console.log(` ${bold(" Model ID                   Default    Max Output")}`);
  console.log(` ${dim(" " + "─".repeat(52))}`);
  for (const m of flat) {
    const id = m.id.padEnd(27);
    const def = fmt(m.def).padStart(7);
    const lim = fmt(m.limit).padStart(10);
    console.log(` ${dim(" ")}${id} ${dim(def)}  ${bold(lim)}`);
  }
  console.log();

  // ── Effort status ──
  const needsGate = state.effortGate.locked;
  const needsLevels = state.effortLevels.count > 0;
  const needsChooser = state.effortChooser.needsPatch;
  const effortFullyPatched = state.effortGate.unlocked && state.effortLevels.patched && state.effortChooser.patched;

  // ── Collect what to do ──
  let selectedModels = [];
  let newLimit = 0;
  let doEffort = false;

  if (isAuto) {
    // Auto: effort patches only, no model assumptions
    doEffort = !effortFullyPatched;
    if (!doEffort) { ok("All effort patches already applied. Nothing to do.\n"); return; }
    info("Auto: applying all effort patches");
  } else {
    // ── Interactive: model selection ──
    const items = flat.map((m) => ({
      label: m.id,
      right: fmt(m.limit),
      hint: "",
      pre: false,
      id: m.id,
    }));

    const chosen = await multiSelect(items, "Select models to change output limit", "Skip this step (just press enter) to only patch effort levels");
    selectedModels = chosen.map((c) => c.id);

    // ── Token limit ──
    if (selectedModels.length) {
      const currentMax = Math.max(...selectedModels.map((id) => flat.find((m) => m.id === id)?.limit ?? 0));
      console.log();
      console.log(` ${dim(`Current max for selection: ${fmt(currentMax)}`)}`);
      const raw = await ask(`${bold("New output limit:")} `, currentMax);
      newLimit = parseK(raw);
      if (isNaN(newLimit) || newLimit <= 0) die("Invalid number.");
    }

    // ── Effort ──
    if (effortFullyPatched) {
      info("Max effort already fully unlocked.");
    } else {
      console.log();
      const parts = [];
      if (needsGate) parts.push("unblock interactive gate");
      if (needsLevels) parts.push("add to ←→ slider + bar");
      if (needsChooser) parts.push("add to effort chooser");
      doEffort = await confirm(`${bold("Unlock max effort?")} ${dim("(" + parts.join(", ") + ")")}`);
    }
  }

  // ── Nothing to do? ──
  const modelChange = selectedModels.length > 0 && newLimit > 0;
  const effortChange = doEffort;
  if (!modelChange && !effortChange) {
    console.log();
    warn("No changes selected.\n");
    return;
  }

  // ── Preview ──
  console.log();
  console.log(` ${bold("┌─ Preview " + "─".repeat(31) + "┐")}`);
  if (modelChange) {
    for (const id of selectedModels) {
      const m = flat.find((f) => f.id === id);
      if (m && m.limit !== newLimit)
        console.log(` ${bold("│")}  ${id.padEnd(22)} ${red(fmt(m.limit))} → ${green(bold(fmt(newLimit)))}`);
      else if (m)
        console.log(` ${bold("│")}  ${id.padEnd(22)} ${dim(fmt(m.limit) + " (no change)")}`);
    }
  }
  if (effortChange) {
    if (needsGate)
      console.log(` ${bold("│")}  ${"effort gate".padEnd(22)} ${red("blocked")} → ${green(bold("unlocked"))}`);
    if (needsLevels)
      console.log(` ${bold("│")}  ${"effort slider/bar".padEnd(22)} ${red("3 levels")} → ${green(bold("4 levels (+max)"))}`);
    if (needsChooser)
      console.log(` ${bold("│")}  ${"effort chooser".padEnd(22)} ${red("no max")} → ${green(bold("max added"))}`);
  }
  console.log(` ${bold("└" + "─".repeat(42) + "┘")}`);
  console.log();

  if (!isAuto) {
    const go = await confirm(bold("Apply?"));
    if (!go) { warn("Aborted.\n"); return; }
  }

  // ── Backup ──
  try { copyFileSync(cliPath, cliPath + ".bak"); ok(`Backup → ${dim(cliPath + ".bak")}`); }
  catch { warn("Could not create backup (permissions) — continuing"); }

  // ── Apply ──
  let out = src;

  if (modelChange) {
    const before = out;
    out = patchModelLimits(out, groups, selectedModels, newLimit);
    if (out === before) warn("Model patch produced no changes (limits may already match).");
  }

  if (effortChange) {
    if (needsGate) out = patchEffortGate(out);
    if (needsLevels) out = patchEffortLevels(out);
    if (needsChooser) out = patchEffortChooser(out);
  }

  writeSafe(cliPath, out);
  console.log();

  // ── Verify ──
  let final;
  try { final = readFileSync(cliPath, "utf8"); } catch { die("Cannot re-read for verification."); }

  const newGroups = parseModels(final);
  const newState = analyze(final);
  let pass = 0, total = 0;

  console.log(` ${bold("Verification")}\n`);

  if (modelChange) {
    for (const id of selectedModels) {
      total++;
      const ng = newGroups.find((g) => g.ids.includes(id));
      if (ng && ng.limVal === newLimit) {
        showSnip(green("✓"), final, new RegExp(`includes\\("${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)[^;]*?\\w=${newLimit}`), bgGreen);
        pass++;
      } else {
        console.log(`   ${red("✗")} ${bold(id)} — expected ${fmt(newLimit)}, got ${ng ? fmt(ng.limVal) : "???"}`);
      }
    }
  }

  if (effortChange) {
    if (needsGate) {
      total++;
      if (newState.effortGate.unlocked) {
        showSnip(green("✓"), final, /effort==="max"&&false/, bgGreen);
        pass++;
      } else console.log(`   ${red("✗")} effort gate`);
    }
    if (needsLevels) {
      total++;
      if (newState.effortLevels.patched || newState.effortLevels.count === 0) {
        showSnip(green("✓"), final, `"low","medium","high","max"`, bgGreen);
        pass++;
      } else console.log(`   ${red("✗")} effort levels`);
    }
    if (needsChooser) {
      total++;
      if (newState.effortChooser.patched) {
        showSnip(green("✓"), final, `label:"Use max effort"`, bgGreen);
        pass++;
      } else console.log(`   ${red("✗")} effort chooser`);
    }
  }

  console.log();

  if (pass === total) {
    console.log(` ${green(bold(`All ${pass} patch${pass === 1 ? "" : "es"} verified.`))}`);
    console.log(` ${dim("Re-run after updates. --undo to restore. --auto for effort-only.")}\n`);
  } else {
    die(`${pass}/${total} verified. Restore: node ${process.argv[1]} --undo`);
  }
}

main().catch((e) => die(e.message));
