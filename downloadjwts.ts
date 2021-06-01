import { cli, Flags } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import { checkKey, Key, decode, ClaimsData, Account } from "../../ConnectEverything/ngsapi-js/src/mod.ts";

async function downloadAccounts(flags: Flags): Promise<string> {
  let k = flags.value<string>("key") as Key;
  try {
    k = checkKey(k, "U", true);
    k = new TextDecoder().decode(k.getSeed());
  } catch (err) {
    throw new Error(`error parsing key: ${err}`);
  }

  let s = "";
  if (flags.value<boolean>("stage")) {
    s = "https://ngs-api.stage.synadia-ops.com";
  } else if (flags.value<boolean>("prod")) {
    s = "https://api.synadia.io";
  }
  if (s === "") {
    throw new Error("--prod or --stage must be provided");
  }

  const args = ["/Users/synadia/go/bin/ngsa", "account", "list", "-W", "-k", `${k}`, "--url", `${s}`, "--limit", "1000"];
  const p = Deno.run({
    cmd: args,
    stderr: "piped",
    stdout: "null",
  });
  await p.status();
  const d = await p.stderrOutput();
  await Deno.writeFile("/tmp/output", d);
  return Promise.resolve(new TextDecoder().decode(d));
}

async function getJwt(server: string, key: string): Promise<ClaimsData<Account>> {
  const r = await fetch(`${server}/jwt/v1/accounts/${key}`);
  const d = await r.text();
  return decode<Account>(d);
}

const tool = cli({
  use: "download [--prod|--stage] --dir /path --key key",
  short: "download jwts from NGS requires ngsa",
  run: async (cmd, args, flags): Promise<number> => {
    try {
      let s: string;
      const inFile = flags.value<string>("in");
      if(!inFile) {
        s = await downloadAccounts(flags);
      } else {
        s = await Deno.readTextFile(inFile);
      }
      const words = s.split(" ");
      const keys = words.filter((v) => {
        console.log(v);
        v = v.trim();
        if(v.length === 56) {
          try {
            checkKey(v as Key, "A", false);
            return true
          } catch(_err) {
            // ignore
          }
        }
      });
      let server = "";
      if (flags.value<boolean>("stage")) {
        server = "https://ngs-api.stage.synadia-ops.com";
      } else if (flags.value<boolean>("prod")) {
        server = "https://api.synadia.io";
      }

      let errors = 0;
      const fetches = [];
      for(let i=0; i < keys.length; i++) {
        console.log(`processing ${keys[i]}`);
        try {
          const ac = await getJwt(server, keys[i])
          fetches.push(ac)
        } catch(err) {
          errors++;
        }
      }

      let v2s = 0;
      let v1s = 0;
      fetches.forEach((p) => {
        const ac = p as ClaimsData<Account>;
        if (ac.nats.version === 2) {
          v2s++;
        } else {
          v1s++;
        }
      });
      // const v = await Promise.allSettled(fetches);
      // v.forEach((p) => {
      //   if(p.status === "fulfilled") {
      //     const ac = p.value as ClaimsData<Account>;
      //     if (ac.nats.version === 2) {
      //       v2s++;
      //     } else {
      //       v1s++;
      //     }
      //   } else {
      //     errors++;
      //   }
      // });
      console.log(`processed ${fetches.length} v1: ${v1s} v2: ${v2s} errors: ${errors}`);

    } catch (err) {
      console.error(err.message);
      return Promise.resolve(1);
    }

    return Promise.resolve(0);
  },
});

tool.addFlag({
  name: "prod",
  default: "",
  type: "boolean",
});

tool.addFlag({
  name: "stage",
  default: "",
  type: "boolean",
});

tool.addFlag({
  name: "dir",
  default: "",
  type: "boolean",
});

tool.addFlag({
  name: "key",
  default: "",
  type: "string",
});
tool.addFlag({
  name: "in",
  default: "",
  type: "string"
})

Deno.exit(await tool.execute(Deno.args));
