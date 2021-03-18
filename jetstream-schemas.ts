#!/usr/bin/env -S deno run --unstable --allow-all

import { join } from "https://deno.land/std/path/mod.ts";
import { walk } from "https://deno.land/std/fs/mod.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";

const root = "/Users/synadia/Dropbox/code/src";
const repo = "https://github.com/nats-io/jsm.go";
const u = new URL(repo);

const args = parse(Deno.args, {
  alias: {
    "f": ["filter"],
    "u": ["update"],
  },
  default: {
    f: "",
    u: false,
  },
  string: ["filter"],
  boolean: ["update"],
});

const localRepo = join(root, u.hostname, u.pathname);
if (args.u) {
  Deno.chdir(localRepo);
  console.info(`updating ${repo}`);
  const p = Deno.run({
    cmd: ["git", "pull"],
  });
  const { success } = await p.status();
  if (!success) {
    throw new Error("git pull failed");
  }
  p.close();
}

const fp = join(localRepo, "schemas");
Deno.chdir(fp);
const matches = new Map<string, string>();

await (async () => {
  for await (const f of walk(".")) {
    if (f.isFile && f.path.endsWith(".json")) {
      if (args.f === "" || f.name.includes(args.f)) {
        matches.set(f.name, f.path);
      }
    }
    if (f.isDirectory) {
      continue;
    }
  }
})();

if (matches.size === 0) {
  console.error("no matches found");
} else if (matches.size === 1) {
  matches.forEach(async (path) => {
    console.dir(`file://${join(fp, path)}`);
    const t = await Deno.readTextFile(path);
    const d = JSON.parse(t);
    console.dir(JSON.parse(JSON.stringify(d)));
  });
} else {
  matches.forEach((path) => {
    console.dir(`file://${join(fp, path)}`);
  });
}

// git clone --branch v1.0.0 https://github.com/nats-io/nats.deno.git
