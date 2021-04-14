import { cli } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import {
  checkKey,
  decode,
  encodeGeneric,
  Key,
} from "/Users/synadia/Dropbox/code/src/github.com/ConnectEverything/ngsapi-js/src/mod.ts";
import { KeyPair } from "https://deno.land/x/nkeys.js//modules/esm/mod.ts";
const ngsg = cli({
  use: "ngsgenerator",
  short: "generates ngs entities and configurations",
});

ngsg.addFlag({
  name: "identities",
  usage: "file mapping entity names to secrets. ENTITY=SEED",
});

const apiServers: Map<string, string> = new Map<string, string>();
apiServers.set("stage", "https://ngs-api.stage.synadia-ops.com");
apiServers.set("prod", "https://api.synadia.io");

async function resolveKey(s: Key): Promise<KeyPair> {
  const sv = s as string;
  if (!sv.startsWith("SO")) {
    s = await Deno.readTextFile(sv);
  }
  return checkKey(s, "O", true);
}

const operator = ngsg.addCommand({
  use: "convert-operator --operator-key [seed|filepath] {--stage | --prod}",
  short: "converts an operator jwt to v2",
  run: async (cmd, args, flags): Promise<number> => {
    if (flags.value<boolean>("stage") && flags.value<boolean>("prod")) {
      cmd.stderr("error: only one of --stage or --prod is allowed");
      cmd.help();
      return Promise.resolve(1);
    }
    let apiserver = "";
    if (flags.value<boolean>("stage")) {
      apiserver = apiServers.get("stage") ?? "";
    }
    if (flags.value<boolean>("prod")) {
      apiserver = apiServers.get("prod") ?? "";
    }
    if (apiserver === "") {
      cmd.stderr("error: either --stage or --prod must be specified");
      cmd.help();
      return Promise.resolve(1);
    }
    const r = await fetch(`${apiserver}/jwt/v1/operator`);
    if (!r.ok) {
      throw new Error(r.statusText);
    }
    const src = await r.text();
    const oc = await decode(src);
    const on = oc.name;

    if (!flags.value<string>("operator-key")) {
      cmd.stderr("error: --operator-key is required");
      cmd.help();
      return Promise.resolve(1);
    }
    const okp = await resolveKey(flags.value<string>("operator-key") as Key);
    const opk = okp.getPublicKey();
    if (oc.iss !== opk) {
      cmd.stderr(
        `error: specified key ${opk} is not expected - wanted ${oc.iss}`,
      );
      cmd.help();
      return Promise.resolve(1);
    }
    const oc2 = await encodeGeneric(on, okp, "operator", oc.nats);

    const fn = flags.value<string>("out");
    if (fn === "--") {
      cmd.stdout(oc2);
    } else {
      await Deno.writeTextFile(fn, oc2);
    }
    return Promise.resolve(0);
  },
});
operator.addFlag({
  name: "operator-key",
  short: "K",
  usage: "operator key used to sign the operator jwts",
  type: "string",
});
operator.addFlag({
  name: "stage",
  usage: "target the stage environment",
  type: "boolean",
});
operator.addFlag({
  name: "prod",
  usage: "target the stage environment",
  type: "boolean",
});
operator.addFlag({
  name: "out",
  short: "o",
  usage: "output-file",
  type: "string",
  default: "--",
});

ngsg.execute(Deno.args);
