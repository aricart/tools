import { cli, Flags,Command } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import { resolve, join } from "https://deno.land/std@0.97.0/path/mod.ts"

async function findTestFiles(dir: string): Promise<string[]> {
  const tests : string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if(e.isDirectory) {
     const sub = await findTestFiles(join(dir, e.name))
      tests.push(...sub)
    }
    if (e.isFile && (e.name.endsWith(".js") || e.name.endsWith(".ts"))) {
      tests.push(join(dir, e.name))
    }
  }
  return tests
}

async function findTests(file: string): Promise<void> {
  const text = await Deno.readTextFile(file);
  const matches = text.matchAll(/^Deno test\(["'](.+)["'],/m);
  console.log(matches);
}

const runOneByOne = cli({
  use: "--dir testdir",
  short: "run tests one by one to find some async issue",
  long: "run-one-by-one will run all tests one by one",
  run: async (cmd: Command, args: string[], flags: Flags): Promise<number> => {
    const dir = resolve(flags.value<string>("dir"));
    const testFiles = await findTestFiles(dir);
    if (testFiles.length === 0) {
      console.log(`no .ts or .js files found in ${dir}`);
      return 0
    }
    const proms : Promise<void>[] = [];
    for (const fn of testFiles) {
      const p = findTests(fn)
      proms.push(p);
    }
    await Promise.all(proms)

    return 0
  }
});

runOneByOne.addFlag({
  name: "dir",
  default: ".",
  type: "string",
  usage: "directory with tests"
});

Deno.exit(await runOneByOne.execute(Deno.args));