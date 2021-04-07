#!/usr/bin/env -S deno run --unstable --allow-all

import { join } from "https://deno.land/std/path/mod.ts";
import { walk } from "https://deno.land/std/fs/mod.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";
import { cyan, green, yellow } from "https://deno.land/std/fmt/colors.ts";

const root = "/Users/synadia/Dropbox/code/src";
const repo = "https://github.com/nats-io/jsm.go";
const u = new URL(repo);

const args = parse(Deno.args, {
  alias: {
    "f": ["filter"],
    "u": ["update"],
    "r": ["raw"],
  },
  default: {
    f: "",
    u: false,
  },
  string: ["filter"],
  boolean: ["update", "raw"],
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
    const txt = await Deno.readTextFile(path);
    if (!args.raw) {
      const d = JSON.parse(txt);
      const t = parseSchema(d);
      console.log(JSON.stringify(t, null, " "));
      // processSchema(d);
    } else {
      console.log(txt);
    }
  });
} else {
  matches.forEach((path) => {
    console.dir(`file://${join(fp, path)}`);
  });
}

interface Schema {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  type: string;
  properties: Record<string, Schema>;
  required: string[];
  oneOf?: Schema[];
  allOf?: Schema[];
  items: Schema;
}

class Type {
  name: string;
  optional: boolean;
  type: string;
  children!: Type[];

  constructor(name: string, optional: boolean, type: string) {
    this.name = name ?? "";
    this.optional = optional;
    this.type = type;
  }

  addChild(t: Type) {
    if (this.children === undefined) {
      this.children = [];
    }
    this.children.push(t);
  }

  render(pad: string = "") {
    if (this.type === "object") {
      const n = this.name ? `${pad}${this.name}: {` : `${pad}{`;
      console.log(`${n}`);
    }
  }
}

function parseSchema(s: Schema, name = "", p?: Type): Type {
  const t = new Type(name, !(s.required && s.required.indexOf(name)), s.type);
  if (p) {
    p.addChild(t);
  }
  parseChildren(s, t);
  return t;
}

function parseChildren(s: Schema, p: Type) {
  if (s.properties) {
    Object.keys(s.properties).forEach((v) => {
      parseSchema(s.properties[v], v, p);
    });
  }
  if (s.oneOf) {
    s.oneOf.forEach((v) => {
      parseSchema(v, "", p);
    });
  }
  if (s.allOf) {
    s.allOf.forEach((v) => {
      parseSchema(v, "", p);
    });
  }
}

//
// function processProps(s: Schema, indent = "") {
//   if (s.oneOf) {
//     s.oneOf.forEach((v) => {
//       processProps(v, indent + "  ");
//     });
//   }
//   if (s.allOf) {
//     s.allOf.forEach((v) => {
//       processProps(v, indent + "  ");
//     });
//   }
//   if (s.properties) {
//     processProperties(s, indent + "  ");
//   }
// }
//
// function processProperties(s: Schema, indent = "") {
//   Object.keys(s.properties).forEach((k) => {
//     const ns = s.properties[k];
//     const r = s.required?.indexOf(k) !== -1 ? "" : "?";
//     if (ns.type === "integer") {
//       ns.type = "number";
//     }
//     if (ns.type === "array") {
//       console.log(`${indent}${k}${r}: [`);
//       console.log(`  ${indent}{`);
//       processProps(ns.items, "    " + indent);
//       console.log(`  ${indent}},`);
//       console.log(`${indent}],`);
//     } else if (ns.type === "object") {
//       console.log(`${indent}${k}${r}: {`);
//       processProps(ns, "  " + indent);
//       console.log(`${indent}},`);
//     } else if (ns.type !== undefined) {
//       console.log(`${indent}${k}${r}: ${ns.type},`);
//     }
//
//     if (ns.oneOf) {
//       ns.oneOf.forEach((v) => {
//         processProps(v, indent + "  ");
//       });
//     }
//     if (ns.allOf) {
//       ns.allOf.forEach((v) => {
//         processProps(v, indent + "  ");
//       });
//     }
//     if(ns.properties) {
//       processProperties(ns, indent + "  ");
//     }
//   });
// }
//
// function processSchema(o: any) {
//   const s = o as Schema;
//   console.log("{");
//   processProps(s, "  ");
//   console.log("}");
// }
