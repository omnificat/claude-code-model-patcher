#!/usr/bin/env node

// ════════════════════════════════════════════════════
//  Claude Code Patcher
//  Dynamic model limits · Max effort unlock
//  macOS · Linux · Windows · Node 18+
//  Usage: node claude-code-patch.mjs [--undo|--auto]
// ════════════════════════════════════════════════════

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { platform, homedir, arch } from "os";
import { createInterface, emitKeypressEvents } from "readline";

// ── Tokens ───────────────────────────────────────────

const OPUS_46_API_MAX = 128_000;

// ── Colors ───────────────────────────────────────────

const S = {
  r: "\x1b[31m",
  g: "\x1b[32m",
  y: "\x1b[33m",
  c: "\x1b[36m",
  m: "\x1b[35m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  x: "\x1b[0m",
  inv: "\x1b[7m",
  bgR: "\x1b[41m\x1b[97m",
  bgG: "\x1b[42m\x1b[97m",
  bgY: "\x1b[43m\x1b[30m",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  clr: "\x1b[2K",
  up: (n) => `\x1b[${n}A`,
};
const W = process.stdout.columns || 60;
const noColor = process.env.NO_COLOR || !process.stdout.isTTY;
const s = noColor
  ? Object.fromEntries(
      Object.keys(S).map((k) => [
        k,
        typeof S[k] === "function" ? () => "" : "",
      ]),
    )
  : S;

// ── Helpers ──────────────────────────────────────────

const die = (m) => {
  process.stdout.write(s.show);
  console.error(`\n ${s.r}${s.b}✗${s.x} ${m}\n`);
  process.exit(1);
};
const ok = (m) => console.log(` ${s.g}${s.b}✓${s.x} ${m}`);
const info = (m) => console.log(` ${s.c}›${s.x} ${m}`);
const warn = (m) => console.log(` ${s.y}⚠${s.x} ${m}`);
const fmt = (n) => Number(n).toLocaleString("en-US");
const sh = (cmd) => {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
};

function parseK(v) {
  v = String(v).trim().toLowerCase().replace(/,/g, "");
  if (v.endsWith("k")) return parseInt(v) * 1000;
  return parseInt(v);
}

// ── Find cli.js ──────────────────────────────────────

function findCli() {
  const os = platform(),
    home = homedir(),
    p = [];
  const add = (...a) =>
    p.push(join(...a, "@anthropic-ai", "claude-code", "cli.js"));
  const raw = (...a) => p.push(join(...a));

  const bin = sh(
    os === "win32" ? "where claude 2>nul" : "which claude 2>/dev/null",
  );
  if (bin)
    try {
      const r = realpathSync(bin.split("\n")[0].trim()),
        d = dirname(r);
      raw(d, "cli.js");
      add(d, "..", "lib", "node_modules");
      add(d, "..", "node_modules");
    } catch {}

  const npm = sh("npm root -g");
  if (npm) add(npm);
  const pnpm = sh("pnpm root -g");
  if (pnpm) add(pnpm);
  if (process.env.VOLTA_HOME)
    add(process.env.VOLTA_HOME, "tools", "image", "packages");
  const bun = sh("bun pm -g bin");
  if (bun) add(dirname(bun), "node_modules");

  if (os === "win32") {
    const ad = process.env.APPDATA || join(home, "AppData", "Roaming");
    const la = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    add(ad, "npm", "node_modules");
    raw(la, "Programs", "claude-code", "cli.js");
    raw(home, ".claude", "local", "cli.js");
  } else if (os === "darwin") {
    const brew = arch() === "arm64" ? "/opt/homebrew" : "/usr/local";
    [
      "/usr/local/lib/node_modules",
      join(brew, "lib", "node_modules"),
      join(home, ".npm-global", "lib", "node_modules"),
    ].forEach((d) => add(d));
    raw(home, ".claude", "local", "cli.js");
  } else {
    [
      "/usr/lib/node_modules",
      "/usr/local/lib/node_modules",
      join(home, ".npm-global", "lib", "node_modules"),
      join(home, ".local", "lib", "node_modules"),
    ].forEach((d) => add(d));
    raw(home, ".local", "share", "claude-code", "cli.js");
    raw(home, ".claude", "local", "cli.js");
  }

  for (const f of p)
    try {
      if (existsSync(f)) return realpathSync(f);
    } catch {}
  return null;
}

// ── Dynamic model parser ─────────────────────────────
// Finds the model→limits function by its structure, not
// its name. Extracts every branch with model IDs + limits.

function parseModels(src) {
  // Match branches: VAR.includes("id")||... )VAR=NUM,VAR=NUM
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

// ── Effort gate detector ─────────────────────────────

function detectEffort(src) {
  const locked = /effort==="max"&&\(!\w\|\|\w+\(\)\)/.test(src);
  const unlocked = /effort==="max"&&false/.test(src);
  return { locked, unlocked, present: locked || unlocked };
}

// ── Patch computation ────────────────────────────────
// Handles group splitting when only some IDs in a branch
// are selected. Processes last-to-first to preserve indices.

function buildModelPatch(src, groups, selected, newLimit) {
  let out = src;
  const sel = new Set(selected);

  for (const g of [...groups].sort((a, b) => b.idx - a.idx)) {
    const hit = g.ids.filter((id) => sel.has(id));
    const miss = g.ids.filter((id) => !sel.has(id));
    if (!hit.length) continue;

    const { condVar: v, defVar: k, defVal: dv, limVar: y, limVal: lv } = g;
    let rep;

    if (!miss.length) {
      // Whole group selected → just swap the limit number
      rep = g.raw.replace(new RegExp(`${y}=\\d+`), `${y}=${newLimit}`);
    } else {
      // Split: selected → new limit, rest → keep old
      const sCond = hit.map((id) => `${v}.includes("${id}")`).join("||");
      const uCond = miss.map((id) => `${v}.includes("${id}")`).join("||");
      rep = `${sCond})${k}=${dv},${y}=${newLimit};else if(${uCond})${k}=${dv},${y}=${lv}`;
    }

    out = out.slice(0, g.idx) + rep + out.slice(g.idx + g.raw.length);
  }
  return out;
}

function buildEffortPatch(src) {
  return src.replace(
    /effort==="max"&&\(!\w\|\|\w+\(\)\)/,
    `effort==="max"&&false`,
  );
}

// ── TUI: multi-select ────────────────────────────────

async function multiSelect(items, title, subtitle) {
  if (!process.stdin.isTTY) return items.filter((i) => i.pre);

  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let cur = items.findIndex((i) => i.pre);
    if (cur < 0) cur = 0;
    const sel = new Set(
      items.map((it, i) => (it.pre ? i : -1)).filter((i) => i >= 0),
    );
    const h = items.length + 3;

    stdout.write(s.hide);
    stdout.write("\n".repeat(h));

    const render = () => {
      stdout.write(s.up(h));
      stdout.write(
        `${s.clr} ${s.b}${title}${s.x}  ${s.d}↑↓ move  space select  a all  enter done${s.x}\n`,
      );
      stdout.write(`${s.clr} ${s.d}${subtitle || ""}${s.x}\n`);
      stdout.write(`${s.clr}\n`);
      for (let i = 0; i < items.length; i++) {
        const on = sel.has(i),
          at = i === cur;
        const box = on ? `${s.g}✓${s.x}` : `${s.d}·${s.x}`;
        const ptr = at ? `${s.c}❯${s.x}` : " ";
        const lbl = at ? `${s.b}${items[i].label}${s.x}` : items[i].label;
        const val = items[i].right || "";
        const hint = items[i].hint ? `  ${s.d}${items[i].hint}${s.x}` : "";
        const gap = Math.max(1, 30 - (items[i].label?.length || 0));
        stdout.write(
          `${s.clr}  ${ptr} ${box} ${lbl}${" ".repeat(gap)}${s.d}${val}${s.x}${hint}\n`,
        );
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
      stdout.write(s.show);
      resolve(items.filter((_, i) => sel.has(i)));
    };

    stdin.on("keypress", (ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        stdout.write(s.show);
        process.exit(0);
      }
      if (key.name === "return") return done();
      if (key.name === "space") {
        sel.has(cur) ? sel.delete(cur) : sel.add(cur);
        render();
      }
      if (key.name === "up") {
        cur = (cur - 1 + items.length) % items.length;
        render();
      }
      if (key.name === "down") {
        cur = (cur + 1) % items.length;
        render();
      }
      if (key.name === "a") {
        const allOn = items.every((_, i) => sel.has(i));
        if (allOn) sel.clear();
        else items.forEach((_, i) => sel.add(i));
        render();
      }
    });
  });
}

// ── TUI: text input ──────────────────────────────────

async function ask(prompt, defaultVal) {
  if (!process.stdin.isTTY) return String(defaultVal);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(` ${prompt}`, (ans) => {
      rl.close();
      r(ans.trim() || String(defaultVal));
    });
  });
}

// ── TUI: confirm ─────────────────────────────────────

async function confirm(prompt, def = true) {
  const a = await ask(
    `${prompt} ${s.d}(${def ? "Y/n" : "y/N"})${s.x} `,
    def ? "y" : "n",
  );
  return a.toLowerCase().startsWith("y");
}

// ── Write with auto-sudo ─────────────────────────────

function writeSafe(path, data) {
  try {
    writeFileSync(path, data, "utf8");
    return;
  } catch {}
  if (platform() === "win32") die("Permission denied. Run as Administrator.");
  warn("Permission denied — retrying with sudo…");
  const tmp = join(homedir(), ".cc-patch-tmp");
  writeFileSync(tmp, data, "utf8");
  try {
    execSync(`sudo cp "${tmp}" "${path}"`, { stdio: "inherit" });
  } catch {
    die(`Write failed. Try: sudo node ${process.argv[1]}`);
  }
  try {
    execSync(`rm -f "${tmp}"`);
  } catch {}
}

// ── Diff display ─────────────────────────────────────

function showSnippet(label, src, idx, len, color) {
  const pad = 55;
  const a = Math.max(0, idx - pad),
    z = Math.min(src.length, idx + len + pad);
  const pre = src.slice(a, idx).replace(/\n/g, "↵");
  const hit = src.slice(idx, idx + len).replace(/\n/g, "↵");
  const post = src.slice(idx + len, z).replace(/\n/g, "↵");
  console.log(
    `   ${s.d}${label}${s.x} ${s.d}…${pre}${s.x}${color}${s.b}${hit}${s.x}${s.d}${post}…${s.x}`,
  );
}

// ── Banner ───────────────────────────────────────────

function banner() {
  console.log();
  console.log(`  ${s.d}┌${"─".repeat(38)}┐${s.x}`);
  console.log(
    `  ${s.d}│${s.x}  ${s.b}⚡ Claude Code Patcher${s.x}${" ".repeat(15)}${s.d}│${s.x}`,
  );
  console.log(
    `  ${s.d}│${s.x}  ${s.d}Model limits · Effort unlock${s.x}${" ".repeat(8)}${s.d}│${s.x}`,
  );
  console.log(`  ${s.d}└${"─".repeat(38)}┘${s.x}`);
  console.log();
}

// ── Main ─────────────────────────────────────────────

async function main() {
  banner();

  const cliPath = findCli();
  if (!cliPath)
    die(
      "Cannot find Claude Code cli.js.\n   Install: npm i -g @anthropic-ai/claude-code@next",
    );

  // ── Undo ──
  if (process.argv.includes("--undo")) {
    const bak = cliPath + ".bak";
    if (!existsSync(bak)) die("No backup found at " + bak);
    writeSafe(cliPath, readFileSync(bak, "utf8"));
    ok("Restored from backup.\n");
    return;
  }

  ok(`Found ${s.d}${cliPath}${s.x}`);
  const ver = sh("claude --version");
  if (ver) info(`Version ${s.b}${ver}${s.x}`);

  let src;
  try {
    src = readFileSync(cliPath, "utf8");
  } catch (e) {
    die(`Read failed: ${e.message}`);
  }

  // ── Parse ──
  const groups = parseModels(src);
  if (!groups.length)
    die(
      "No model limit branches found. Claude Code internals may have changed.",
    );

  const effort = detectEffort(src);

  // ── Build flat model list ──
  const flat = [];
  for (const g of groups) {
    for (const id of g.ids) {
      const isOpus46 = id.includes("opus-4-6");
      flat.push({
        id,
        group: g,
        limit: g.limVal,
        def: g.defVal,
        apiMax: isOpus46 ? OPUS_46_API_MAX : g.limVal,
        isOpus46,
      });
    }
  }

  // ── Display table ──
  console.log();
  console.log(` ${s.b} Model ID                   Default    Max Output${s.x}`);
  console.log(` ${s.d} ${"─".repeat(50)}${s.x}`);
  for (const m of flat) {
    const id = m.id.padEnd(27);
    const def = fmt(m.def).padStart(7);
    const lim = fmt(m.limit).padStart(10);
    const tag =
      m.isOpus46 && m.limit < OPUS_46_API_MAX
        ? `  ${s.y}← API max: ${fmt(OPUS_46_API_MAX)}${s.x}`
        : "";
    console.log(
      ` ${s.d} ${s.x}${id} ${s.d}${def}${s.x}  ${s.b}${lim}${s.x}${tag}`,
    );
  }
  console.log();

  // ── Auto mode ──
  const isAuto = process.argv.includes("--auto");

  let selectedModels, newLimit, doEffort;

  if (isAuto) {
    selectedModels = flat.filter((m) => m.isOpus46).map((m) => m.id);
    newLimit = OPUS_46_API_MAX;
    doEffort = effort.locked;
    if (!selectedModels.length && !doEffort) {
      ok("Nothing to patch in auto mode.\n");
      return;
    }
    info(`Auto: ${selectedModels.join(", ") || "none"} → ${fmt(newLimit)}`);
    if (doEffort) info("Auto: unlocking max effort");
  } else {
    // ── Interactive: select models ──
    const items = flat.map((m) => ({
      label: m.id,
      right: fmt(m.limit),
      hint:
        m.isOpus46 && m.limit < OPUS_46_API_MAX
          ? `API max: ${fmt(OPUS_46_API_MAX)}`
          : "",
      pre: m.isOpus46 && m.limit < OPUS_46_API_MAX,
      id: m.id,
    }));

    const chosen = await multiSelect(
      items,
      "Select models to modify",
      "Pre-selected models can be improved beyond current limits",
    );

    selectedModels = chosen.map((c) => c.id);

    if (!selectedModels.length && !effort.locked) {
      console.log();
      warn("Nothing selected.\n");
      return;
    }

    // ── Interactive: token limit ──
    if (selectedModels.length) {
      const hasOpus = selectedModels.some((id) => id.includes("opus-4-6"));
      const currentMax = Math.max(
        ...selectedModels.map(
          (id) => flat.find((m) => m.id === id)?.limit ?? 0,
        ),
      );
      const hint = hasOpus
        ? `${s.d}64K=default  ${s.b}128K${s.x}${s.d}=Opus 4.6 max  current: ${fmt(currentMax)}${s.x}`
        : `${s.d}current: ${fmt(currentMax)}${s.x}`;

      console.log();
      console.log(` ${hint}`);
      const raw = await ask(
        `${s.b}New output limit:${s.x} `,
        hasOpus ? OPUS_46_API_MAX : currentMax,
      );
      newLimit = parseK(raw);

      if (isNaN(newLimit) || newLimit <= 0) die("Invalid number.");
      if (newLimit > 200_000)
        die("Cannot exceed 200K (that's context window territory).");
    }

    // ── Interactive: effort ──
    if (effort.locked) {
      console.log();
      doEffort = await confirm(
        `${s.b}Unlock "max" effort${s.x} in interactive mode? ${s.d}(Opus 4.6 only)${s.x}`,
      );
    } else if (effort.unlocked) {
      doEffort = false;
      info("Max effort already unlocked.");
    } else {
      doEffort = false;
    }
  }

  // ── Nothing to do? ──
  const modelChange = selectedModels.length && newLimit;
  const effortChange = doEffort;
  if (!modelChange && !effortChange) {
    console.log();
    warn("No changes to apply.\n");
    return;
  }

  // ── Preview ──
  console.log();
  console.log(` ${s.b}┌─ Preview ${"─".repeat(29)}┐${s.x}`);
  if (modelChange) {
    for (const id of selectedModels) {
      const m = flat.find((f) => f.id === id);
      if (m && m.limit !== newLimit) {
        console.log(
          ` ${s.b}│${s.x}  ${id.padEnd(20)} ${s.r}${fmt(m.limit)}${s.x} → ${s.g}${s.b}${fmt(newLimit)}${s.x}`,
        );
      } else if (m) {
        console.log(
          ` ${s.b}│${s.x}  ${id.padEnd(20)} ${s.d}${fmt(m.limit)} (no change)${s.x}`,
        );
      }
    }
  }
  if (effortChange) {
    console.log(
      ` ${s.b}│${s.x}  ${"max effort".padEnd(20)} ${s.r}blocked${s.x} → ${s.g}${s.b}unlocked${s.x}`,
    );
  }
  console.log(` ${s.b}└${"─".repeat(40)}┘${s.x}`);
  console.log();

  if (!isAuto) {
    const go = await confirm(`${s.b}Apply?${s.x}`);
    if (!go) {
      warn("Aborted.\n");
      return;
    }
  }

  // ── Backup ──
  try {
    copyFileSync(cliPath, cliPath + ".bak");
    ok(`Backup → ${s.d}${cliPath}.bak${s.x}`);
  } catch {
    warn("Could not create backup (permissions) — continuing");
  }

  // ── Apply model patches ──
  let out = src;
  if (modelChange) {
    const before = out;
    out = buildModelPatch(out, groups, selectedModels, newLimit);
    if (out === before)
      warn("Model patch produced no changes (limits may already match).");
  }

  // ── Apply effort patch ──
  if (effortChange) {
    out = buildEffortPatch(out);
  }

  // ── Write ──
  writeSafe(cliPath, out);
  console.log();

  // ── Verify ──
  let final;
  try {
    final = readFileSync(cliPath, "utf8");
  } catch {
    die("Cannot re-read for verification.");
  }

  const newGroups = parseModels(final);
  const newEffort = detectEffort(final);
  let pass = 0,
    total = 0;

  console.log(` ${s.b}Verification${s.x}\n`);

  if (modelChange) {
    for (const id of selectedModels) {
      total++;
      // Find the model in the new parsed groups
      const ng = newGroups.find((g) => g.ids.includes(id));
      if (ng && ng.limVal === newLimit) {
        const m = final.match(
          new RegExp(
            `includes\\("${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)[^;]*?(\\w)=(${newLimit})`,
          ),
        );
        if (m) {
          showSnippet(`${s.g}✓${s.x}`, final, m.index, m[0].length, s.bgG);
        } else {
          console.log(
            `   ${s.g}✓${s.x} ${s.b}${id}${s.x} → ${s.g}${fmt(newLimit)}${s.x}`,
          );
        }
        pass++;
      } else {
        console.log(
          `   ${s.r}✗${s.x} ${s.b}${id}${s.x} — expected ${fmt(newLimit)}, got ${ng ? fmt(ng.limVal) : "???"}`,
        );
      }
    }
  }

  if (effortChange) {
    total++;
    if (newEffort.unlocked && !newEffort.locked) {
      const m = final.match(/effort==="max"&&false/);
      if (m) showSnippet(`${s.g}✓${s.x}`, final, m.index, m[0].length, s.bgG);
      else console.log(`   ${s.g}✓${s.x} max effort unlocked`);
      pass++;
    } else {
      console.log(`   ${s.r}✗${s.x} effort patch failed`);
    }
  }

  console.log();

  if (pass === total) {
    console.log(
      ` ${s.g}${s.b}All ${pass} patch${pass === 1 ? "" : "es"} verified.${s.x}`,
    );
    console.log(
      ` ${s.d}Re-run after updates. Use --undo to restore. --auto for scripting.${s.x}\n`,
    );
  } else {
    die(`${pass}/${total} verified. Restore: node ${process.argv[1]} --undo`);
  }
}

main().catch((e) => die(e.message));
