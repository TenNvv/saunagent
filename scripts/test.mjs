import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Node 22 names this --experimental-test-isolation; newer releases accept
// --test-isolation. Pick whichever this binary recognizes.
const probe = spawnSync(
  process.execPath,
  ["--test-isolation=none", "-p", "0"],
  { encoding: "utf8" },
);
const isolation = /bad option: --test-isolation/.test(probe.stderr ?? "")
  ? "--experimental-test-isolation=none"
  : "--test-isolation=none";
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`);
const child = spawnSync(
  process.execPath,
  [isolation, "--import", "tsx", "--test", ...files, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(child.status ?? 1);
