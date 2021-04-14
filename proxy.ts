import { cli } from "https://deno.land/x/cobra@v0.0.5/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

const c = cli({
  use: "proxy --server host:port --port port",
  short: "proxy connection at port to a server at host:port",
  run: async (cmd, args, flags): Promise<number> => {
    const port = flags.value<number>("port");
    if (port === 0) {
      cmd.stderr("--port is required");
      return Promise.resolve(1);
    }

    const hp = flags.value<string>("server");
    if (hp === "") {
      cmd.stderr("--server is required");
      return Promise.resolve(1);
    }
    const [host, remote] = hp.split(":");

    const log = flags.value<string>("log-dir");

    const rp = parseInt(remote, 10);
    if (isNaN(rp)) {
      cmd.stderr(`--server - port is required: ${hp}`);
      return Promise.resolve(1);
    }
    const copts = {
      hostname: host,
      port: rp,
      transport: "tcp",
    } as Deno.ConnectOptions;

    let client = 0;
    const listener = Deno.listen({ port: port, transport: "tcp" });
    console.log(`waiting for connections on port ${port}`);
    for await (const conn of listener) {
      service(client++, conn, copts, log);
    }

    return Promise.resolve(0);
  },
});

c.addFlag({
  name: "server",
  type: "string",
  usage: "server hostport",
});
c.addFlag({
  name: "port",
  type: "number",
  usage: "port number",
});
c.addFlag({
  name: "log-dir",
  type: "string",
  usage: "log-file log file of data from server",
});

function service(
  id: number,
  c: Deno.Conn,
  hp: Deno.ConnectOptions,
  dir: string,
) {
  const fp = dir ? join(dir, `${id}.log`) : "";
  const file = dir
    ? Deno.openSync(fp, { write: true, truncate: true, create: true })
    : undefined;

  if (file) {
    console.log(`logging to ${fp}`);
  }

  (async () => {
    const remote = await Deno.connect(hp);
    const fromServer = (async () => {
      const buf = new Uint8Array(4 * 1024);
      while (true) {
        const count = await remote.read(buf);
        if (count === null) {
          return;
        }
        const d = buf.subarray(0, count);
        if (file) {
          Deno.writeSync(file.rid, d);
        }
        await c.write(d);
      }
    })();
    const toServer = (async () => {
      const buf = new Uint8Array(4 * 1024);
      while (true) {
        const count = await c.read(buf);
        if (count === null) {
          return;
        }
        await remote.write(buf.subarray(0, count));
      }
    })();
    await toServer;
    await fromServer;
    c.close();
    console.info(`client ${id} closed`);
  })();
}

Deno.exit(await c.execute(Deno.args));
