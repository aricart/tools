import { cli, Flags } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import {
  clearDown,
  clearLeft,
  clearScreen,
  clearUp,
  goHome,
  hideCursor,
  position,
  prevLine,
  restore,
  save,
  write,
} from "https://deno.land/x/cursor/mod.ts";
import {
  connect,
  ConnectionOptions,
  createInbox,
  credsAuthenticator,
  Empty,
  JSONCodec,
  jwtAuthenticator,
  Msg,
  NatsConnection,
  NatsError,
} from "https://deno.land/x/nats/src/mod.ts";
import {
  NatsConnectionImpl,
} from "https://deno.land/x/nats@v1.0.2/nats-base-client/internal_mod.ts";
import { green, red, yellow } from "https://deno.land/std/fmt/colors.ts";

async function conn(flags: Flags): Promise<NatsConnection> {
  let s = flags.value<string>("server");
  if (!s && flags.value<boolean>("demo")) {
    s = "demo.nats.io";
  } else if (!s && flags.value<boolean>("test")) {
    s = "connect.ngs.synadia-test.com:4222";
  } else if (!s && flags.value<boolean>("ngs")) {
    s = "connect.ngs.global:4222";
  }
  const opts = {
    servers: [s],
    debug: flags.value<boolean>("debug"),
  } as ConnectionOptions;

  if (flags.value<string>("creds")) {
    const fp = flags.value<string>("creds");
    const bytes = await Deno.readFile(fp);
    opts.authenticator = credsAuthenticator(bytes);
  } else if (flags.value<string>("jwt")) {
    const fp = flags.value<string>("jwt");
    const jwt = await Deno.readTextFile(fp);
    let nkey = flags.value<string>("nkey");
    if (nkey && !nkey.startsWith("SU")) {
      nkey = await Deno.readTextFile(fp);
    }
    opts.authenticator = jwtAuthenticator(
      jwt,
      new TextEncoder().encode(nkey ? nkey : ""),
    );
  }
  return connect(opts);
}

interface Server {
  name: string;
  host: string;
  id: string;
  cluster: string;
  ver: string;
  seq: number;
  jetstream: boolean;

  total_connections: number;
}

interface Statsz {
  mem: number;
  slow_consumers: number;
  total_connections: number;
  active_accounts: number;
}

interface Client {
  start: string;
  host: string;
  id: number;
  acc: string;
  user: string;
  lang: string;
  ver: string;
  jwt: string;
  name_tag: string;

  // augmented
  server: string;
}

interface Conn {
  cid: number;
  ip: string;
  lang: string;
  version: string;

  // augmented
  server_id: string;
}

interface Connz {
  server_id: string;
  num_connections: number;
  connections: Conn[];
}

interface ConnzResponse {
  data: Connz;
}

interface ConnectedEvt {
  server: Server;
  client: Client;
}

interface PingResponse {
  server: Server;
  statsz: Statsz;
}

interface Version {
  lang: string;
  version: string;
  count: number;
}

const servers: Map<string, Server> = new Map<string, Server>();
let clients: Conn[] = [];
const refresh: Server[] = [];
let versions: Version[] = [];

const cec = JSONCodec<ConnectedEvt>();
function changed(err: NatsError | null, msg: Msg): void {
  const ce = cec.decode(msg.data);
  refresh.push(ce.server);
}

async function mRequest(nc: NatsConnection, subj: string): Promise<Msg[]> {
  const responses: Msg[] = [];
  const inbox = createInbox();
  const sub = nc.subscribe(inbox);
  let last = 0;
  const done = (async () => {
    for await (const m of sub) {
      responses.push(m);
      last++;
    }
  })();

  const ticker = setInterval(() => {
    if (responses.length === last) {
      clearInterval(ticker);
      sub.drain();
    }
  }, 1000);

  nc.publish(subj, Empty, { reply: inbox });
  await done;
  return Promise.resolve(responses);
}

async function getConnz(nc: NatsConnection, s: Server): Promise<Connz> {
  const jc = JSONCodec<ConnzResponse>();
  const m = await nc.request(`$SYS.REQ.SERVER.${s.id}.CONNZ`);
  const connz = jc.decode(m.data);
  return Promise.resolve(connz.data);
}

function describeServers(): string[] {
  const a: Server[] = [];
  for (const s of servers.values()) {
    a.push(s);
  }
  a.sort((a, b): number => {
    return a.name.localeCompare(b.name);
  });
  const names = a.map((v) => {
    return [v.name, v.host, `${v.total_connections}`, v.ver];
  });
  const pads = names.map((v) => {
    return [v[0].length, v[1].length, v[2].length];
  });
  const sum = pads.reduce((sum, v) => {
    return [
      Math.max(sum[0], v[0]),
      Math.max(sum[1], v[1]),
      Math.max(sum[2], v[2]),
    ];
  });

  const lines: string[] = [];
  names.forEach((v) => {
    const count = `${v[2].padEnd(sum[2], " ")}`;
    lines.push(
      `${yellow(count)} x ${v[0].padEnd(sum[0], " ")} ${
        v[1].padEnd(sum[1], " ")
      }   ${v[3]}`,
    );
  });
  return lines;
}

function describeClientVersions(): string[] {
  const lens = versions.map((v) => {
    return [v.lang.length, v.version.length, `${v.count}`.length];
  });
  const pad = lens.reduce((sum, v) => {
    return [
      Math.max(sum[0], v[0]),
      Math.max(sum[1], v[1]),
      Math.max(sum[2], v[2]),
    ];
  });
  return versions.map((v) => {
    const c = `${v.count}`;
    const count = `${c.padEnd(pad[2], " ")}`;
    return `${yellow(count)} x ${v.lang.padEnd(pad[0], " ")} ${
      v.version.padEnd(pad[1], " ")
    }`;
  });
}

async function update(nc: NatsConnection): Promise<void> {
  // unique the servers that sent updates
  const us = refresh.filter((v, index, a) => {
    return a.indexOf(v) === index;
  });

  // ask for update
  const proms: Promise<Connz>[] = [];
  us.forEach((v) => {
    proms.push(getConnz(nc, v));
  });

  // process the connz data
  const results = await Promise.allSettled(proms);
  results.forEach((r) => {
    if (r.status === "fulfilled") {
      const connz = r.value as Connz;
      // remove all clients from the specified server
      clients = clients.filter((v) => v.server_id !== connz.server_id);
      // on the new conns track the server id
      connz.connections.forEach((v) => v.server_id = connz.server_id);
      // add them
      clients.push(...connz.connections);

      const s = servers.get(connz.server_id);
      if (s) {
        s.total_connections = connz.num_connections;
      }
    }
  });

  // create some summaries
  const ct = clients.map((v) => {
    const { lang, version } = v;
    return { lang, version, count: 0 } as Version;
  });

  const langVer = ct.map((v) => {
    return `${v.lang}|||${v.version}`;
  });
  const uLangVer = langVer.filter((v, idx, a) => {
    return a.indexOf(v) === idx;
  });

  versions.length = 0;
  uLangVer.forEach((lv) => {
    const [lang, version] = lv.split("|||");
    const matches = ct.filter((v) => {
      return v.lang === lang && v.version === version;
    });
    if (matches) {
      const sum = matches[0];
      sum.count = matches.length;
      versions.push(sum);
    }
  });
}

const c = cli({
  use: "clients [--debug] [--server host:port]",
  short: "clients displays a list of all clients",
  run: async (cmd, args, flags): Promise<number> => {
    const nc = await conn(flags);
    const nci = nc as unknown as NatsConnectionImpl;

    write(`${green(`connected`)} ${nci.protocol.server.toString()}\n`);
    await save();

    // start listening for servers reporting connects/disconnects
    nc.subscribe("$SYS.ACCOUNT.*.CONNECT", { callback: changed });
    nc.subscribe("$SYS.ACCOUNT.*.DISCONNECT", { callback: changed });

    // discover initial servers
    await mRequest(nc, "$SYS.REQ.SERVER.PING")
      .then((msgs) => {
        const pjc = JSONCodec<PingResponse>();
        const responses = msgs.map((m) => {
          return pjc.decode(m.data);
        });
        servers.clear();
        const buf: Server[] = [];
        responses.forEach((r, idx) => {
          buf.push(r.server);
          servers.set(r.server.id, r.server);
        });
        refresh.push(...buf);
      });

    setInterval(async () => {
      await update(nc);
      cmd.stdout("\u001B[H");
      cmd.stdout("\u001B[0J");
      const lines = [`${green(`connected`)} ${nci.protocol.server.toString()}`];
      lines.push(green("servers"));
      lines.push(...describeServers());
      lines.push("");
      lines.push(green("clients"));
      lines.push(...describeClientVersions());

      cmd.stdout(lines.join("\n"));
    }, 1000);

    await nc.closed();
    return Promise.resolve(0);
  },
});
c.addFlag({
  name: "server",
  default: "",
  type: "string",
  persistent: true,
  usage: "server hostport",
});
c.addFlag({
  name: "demo",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use demo.nats.io",
});
c.addFlag({
  name: "test",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.synadia-test.com:4222",
});
c.addFlag({
  name: "ngs",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.global:4222",
});
c.addFlag({
  name: "debug",
  short: "d",
  type: "boolean",
  persistent: true,
  usage: "enable protocol debugging",
});
c.addFlag({
  name: "creds",
  short: "c",
  type: "string",
  persistent: true,
  usage: "filepath to creds file",
});
c.addFlag({
  name: "jwt",
  short: "j",
  type: "string",
  persistent: true,
  usage: "filepath to jwt file",
});

Deno.exit(await c.execute(Deno.args));
