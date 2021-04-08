import { cli, Flags } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import {
  connect,
  ConnectionOptions,
  credsAuthenticator,
  jwtAuthenticator,
  NatsConnection,
} from "https://deno.land/x/nats/src/mod.ts";
import {
  MsgHdrsImpl,
  NatsConnectionImpl,
} from "https://deno.land/x/nats/nats-base-client/internal_mod.ts";
import { green, red, yellow } from "https://deno.land/std/fmt/colors.ts";

function bytes(bytes: number): string {
  const pre = ["K", "M", "G", "T", "P", "E"];
  const post = "B";
  if (bytes < 1024) {
    return `${bytes.toFixed(2)}${post}`;
  }
  const exp = parseInt(Math.log(bytes) / Math.log(1024) + "");
  const index = parseInt((exp - 1) + "");
  return `${(bytes / Math.pow(1024, exp)).toFixed(2)}${pre[index]}${post}`;
}

function numbers(n: number) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

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

type metric = {
  name: string;
  count: number;
  ave?: number;
};

const mon = cli({
  use: "mon [--debug] [--server host:port] [--max-wait secs]",
  short: "monitor messages flowing through NATS",
  long: `The monitor will print a single line updating every second
showing the following statistics:

MSGS  - number of messages seen
RPEND - number of pending requests
ROK   - number of requests that received a response
RTIMO - number of requests that didn't receive a response 
        within --max-wait seconds
ERR   - number of messages that sported an error code header
MAX   - maximum payload size seen
AVG   - average payload size
`,
  run: async (cmd, args, flags): Promise<number> => {
    type rr = {
      s: string;
      st: number;
      r: string;
      err?: string;
    };
    const pending = new Map<string, rr>();
    let ok = 0;
    let rtt = 0;
    let errors = 0;
    let timedout = 0;
    const maxWait = flags.value<number>("max-wait") * 1000;
    let line = 0;
    let payload = 0;
    let maxPayload = 0;
    let count = 0;

    setInterval(async () => {
      const now = Date.now();
      let waitCounts = 0;
      let waits = 0;
      pending.forEach((v, k) => {
        if (now - v.st > maxWait) {
          timedout++;
          pending.delete(v.r);
        } else {
          waits += now - v.st;
          waitCounts++;
        }
      });
      const wait: metric = { name: "RPEND", count: waitCounts };
      wait.ave = waits / waits;

      const serviced: metric = { name: "ROK", count: ok };
      if (ok) {
        serviced.ave = rtt / ok;
      }
      const total = { name: "MSGS", count: count };
      const to = { name: "RTIMO", count: timedout };
      const errs = { name: "ERR", count: errors };

      cmd.stdout("\r");

      const buf = [total, serviced, wait, to, errs];
      let color;
      const lines = buf.map((e) => {
        color = (e.name !== "ROK" && e.name !== "MSGS") && e.count > 0
          ? red
          : green;
        color = e.name === "RPEND" && e.count > 0 ? yellow : color;
        return `${e.name}: ${color(numbers(e.count))}`;
      });
      lines.push(
        `MAX: ${bytes(maxPayload)} AVG: ${
          bytes(payload ? payload / count : 0)
        }`,
      );
      const s = lines.join(" ");
      line = s.length;
      cmd.stdout(s);
    }, 1000);

    const nc = await conn(flags);
    const nci = nc as unknown as NatsConnectionImpl;
    cmd.stdout(`${green(`connected`)} ${nci.protocol.server.toString()}`);
    const sub = nc.subscribe(">");
    const done = (async () => {
      for await (const m of sub) {
        count++;
        payload += m.data.length;
        maxPayload = Math.max(m.data.length, maxPayload);
        let r = pending.get(m.subject);
        if (r) {
          rtt += Date.now() - r.st;
          if (m.headers) {
            if ((m.headers as MsgHdrsImpl).hasError) {
              errors++;
            }
          }
          pending.delete(m.subject);
          ok++;
        } else if (m.reply) {
          r = {
            s: m.subject,
            st: Date.now(),
            r: m.reply,
          };
          pending.set(m.reply, r);
        }
      }
    })();
    await done;
    await nc.close();
    return Promise.resolve(0);
  },
});
mon.addFlag({
  name: "max-wait",
  default: 60,
  usage: "max wait before forgetting message",
});
mon.addFlag({
  name: "server",
  default: "",
  type: "string",
  persistent: true,
  usage: "server hostport",
});
mon.addFlag({
  name: "demo",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use demo.nats.io",
});
mon.addFlag({
  name: "test",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.synadia-test.com:4222",
});
mon.addFlag({
  name: "ngs",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.global:4222",
});
mon.addFlag({
  name: "debug",
  short: "d",
  type: "boolean",
  persistent: true,
  usage: "enable protocol debugging",
});
mon.addFlag({
  name: "creds",
  short: "c",
  type: "string",
  persistent: true,
  usage: "filepath to creds file",
});
mon.addFlag({
  name: "jwt",
  short: "j",
  type: "string",
  persistent: true,
  usage: "filepath to jwt file",
});

Deno.exit(await mon.execute(Deno.args));
