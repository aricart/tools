import { cli, Flags } from "https://deno.land/x/cobra@v0.0.4/mod.ts";
import {
  connect,
  ConnectionOptions,
  credsAuthenticator,
  jwtAuthenticator,
  NatsConnection,
  StringCodec,
} from "https://deno.land/x/nats/src/mod.ts";
import { MsgHdrsImpl } from "https://deno.land/x/nats/nats-base-client/internal_mod.ts";

const sc = StringCodec();

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
    debug: !!flags.value<boolean>("debug"),
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

const reqmon = cli({
  use: "reqmon [--debug] [--server host:port]",
  short: "track req/resp",
  run: async (cmd, args, flags): Promise<number> => {
    type rr = {
      s: string;
      st: number;
      r: string;
      err?: string;
    };
    const pending = new Map<string, rr>();
    const rtt: number[] = [];
    let errors = 0;
    let timedout = 0;
    let lastServiced = 0;
    const maxWait = flags.value<number>("max-wait") * 1000;

    let line = 0;

    setInterval(async () => {
      const now = Date.now();
      let waits: number[] = [];
      pending.forEach((v, k) => {
        if (now - v.st > maxWait) {
          timedout++;
          pending.delete(v.r);
        } else {
          waits.push(now - v.st);
        }
      });
      const wait: metric = { name: "waiting", count: waits.length };
      if (waits.length) {
        const sum = waits.reduce((pv, v): number => {
          return pv + v;
        });
        wait.ave = sum / waits.length;
      }
      const serviced: metric = { name: "serviced", count: rtt.length };
      if (rtt.length) {
        const rtts = rtt.reduce((pv, v): number => {
          return pv + v;
        });
        serviced.ave = rtts / rtt.length;
      }
      const errs = { name: "errors", count: errors };
      const to = { name: "timeouts", count: timedout };

      if (line) {
        Deno.stdout.writeSync(sc.encode("".padEnd(line, "\b")));
      }
      const s =
        `waiting: ${wait.count} serviced: ${serviced.count} errs: ${errs.count} timedout: ${to.count}`;
      line = s.length;
      Deno.stdout.writeSync(sc.encode(s));
    }, 1000);

    const nc = await conn(flags);
    console.log(`connected`);
    const sub = nc.subscribe(">");
    const done = (async () => {
      for await (const m of sub) {
        let r = pending.get(m.subject);
        if (r) {
          rtt.push(Date.now() - r.st);
          if (m.headers) {
            if ((m.headers as MsgHdrsImpl).hasError) {
              errors++;
            }
          }
          pending.delete(m.subject);
          continue;
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
reqmon.addFlag({
  name: "max-wait",
  default: 60,
  usage: "max wait before forgetting message",
});
reqmon.addFlag({
  name: "server",
  default: "",
  type: "string",
  persistent: true,
  usage: "server hostport",
});
reqmon.addFlag({
  name: "demo",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use demo.nats.io",
});
reqmon.addFlag({
  name: "test",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.synadia-test.com:4222",
});
reqmon.addFlag({
  name: "ngs",
  default: "",
  type: "boolean",
  persistent: true,
  usage: "use connect.ngs.global:4222",
});
reqmon.addFlag({
  name: "debug",
  short: "d",
  type: "boolean",
  persistent: true,
  usage: "enable protocol debugging",
});
reqmon.addFlag({
  name: "creds",
  short: "c",
  type: "string",
  persistent: true,
  usage: "filepath to creds file",
});
reqmon.addFlag({
  name: "jwt",
  short: "j",
  type: "string",
  persistent: true,
  usage: "filepath to jwt file",
});

Deno.exit(await reqmon.execute(Deno.args));
