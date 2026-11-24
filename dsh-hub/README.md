# dsh-hub

One DeepSeek Harness as the hub of your computers. The hub serves a chat page you open from your phone or any
browser, with accounts. Your other computers join it as **nodes**, and the bots can run work on them: *"use the
ROG's GPU to run Video2X on this video"*. Several bots can share a group chat.

```
   phone / browsers ──https or LAN──►  HUB (main DSH + dsh-hub, role: hub)
                                        chat page · accounts · chats · files · DSH agents
                                              ▲            ▲
                         outbound websocket   │            │   (nodes open no port)
                                        ROG (DSH, node)   Pi (DSH, node)
```

The server is not a sync. The hub owns the chats, files and agents. A node only runs commands for it, within the
node's own policy.

## Try it without DSH

The echo brain stands in for a model. It says back what you say, and it runs `run <computer>: <command>` on a node.

```
npm install
node bin/dsh-hub.js hub                 # prints a setup code; open http://localhost:4180/setup
```

Then add a computer under ⚙️ Settings → Computers → Add. On that computer, or the same one in a second terminal:

```
node bin/dsh-hub.js join http://<hub>:4180 ABCD-EFGH
node bin/dsh-hub.js node
```

In a chat, type `computers`, or `run <name>: nvidia-smi`. Approve the card and watch the job card. Attach a file and
type `send to <name>` to copy it into that computer's inbox; `get <name>: <path>` brings a file from it into the chat.

## Files between your computers

The phone's upload lands on the hub. From there a bot copies it to the computer that will do the work, runs the work
there, and brings the result back into the chat:

```
phone ──upload──► hub ──computer_send_file──► ROG's inbox ──computer_run (video2x)──► out.mp4 ──computer_get_file──► chat
```

Each copy is a job with a live card (progress, Stop). The hub never sends a file down the node's websocket. It makes a
ticket for that one computer, that one file and that one direction, valid for an hour. The computer then downloads or
uploads over plain HTTP with its own secret and the ticket. A download picks up where it stopped if the connection
breaks, and both sides check the SHA-256. Files sent to a computer land in its inbox (`~/.dsh-hub/inbox`, or
`policy.inbox`), and a name already there gets " (2)". A file brought back is typed by its name, never by what the
computer says.

## With DSH

DSH needs Node 24.22 or newer.

1. **Hub (the main computer):**
   1. Copy [`examples/hub-profile`](examples/hub-profile) to `<DSH home>/profiles/hub/`.
   2. Fix the `file:` path, then run `npm install` there.
   3. Run `dsh --profile hub`.
   4. Open `http://<hub>:4180/setup` with the setup code from its console.
2. **Each other computer:**
   1. Get a pairing code on the page.
   2. Put it in [`examples/node-profile`](examples/node-profile)'s `cordis.patch.yml`.
   3. Run `dsh --profile node`. After the first run the code isn't needed.

Every option is documented at the top of [`plugin/index.js`](plugin/index.js).

## Security

The rule: anyone who can use the page can run commands on your computers. So the page always has accounts, even on
the home network.

| | |
|---|---|
| First account | Made only with the setup code printed in the hub's console, so nobody on the network can claim an empty hub. |
| Passwords | scrypt (N=2^15, r=8, p=1), compared in constant time. Wrong tries are slowed, then locked out per name, per address, and for every outside address together (never the home network). |
| Sign-ins | A random 32-byte token in an `HttpOnly; SameSite=Strict` cookie (`Secure` over https). Only its SHA-256 is stored. 30 days from last use. Changing the password signs out everywhere and closes open pages. |
| Requests | Only home-network and Tailscale addresses (`access: lan`, the default). The Host header must be a home name, which stops DNS rebinding. The Origin must be the page's own. The API takes JSON only. A strict CSP is set. |
| Nodes | Join once with a single-use pairing code that expires in 10 minutes. After that they authenticate with a 32-byte secret, of which the hub stores only the hash. Nodes connect out, so they open no port. |
| Commands | Each computer's policy on the hub is **ask** (the default: an approval card shows the exact command), **always** or **never**. The node's own `policy` (`any` / `allowlist` / `never`) is in its own config and the hub can't change it, so a compromised hub still only gets what the node allows. Only owners use and approve computers. |
| Files | Moving a file follows the same hub policy (ask, always, never). The node's own `policy.files` decides what the hub may take: `any` (the default when `exec` is `any`), `folders` (only `policy.folders` and the inbox, the default otherwise) or `never` (no files either way). Tickets are single-use per transfer, tied to one node, and expire. |

For use away from home, put the hub on Tailscale or WireGuard and keep `access: lan`. Tailscale's addresses count as
local. If you open it to the internet anyway (`access: anywhere`), give it https: either `tls` with a certificate, or
an https reverse proxy listed in `trustProxy`. Without https, the page warns that passwords cross the network
readable.

If you're locked out, run `node bin/dsh-hub.js password <name>` on the hub's computer.

## Layout

| File | Role |
|---|---|
| [`lib/start.js`](lib/start.js) | Builds a hub: data folder, accounts, nodes, chats, server |
| [`lib/auth.js`](lib/auth.js) | Accounts, passwords, sign-ins, lockouts, the setup code |
| [`lib/guard.js`](lib/guard.js) | Address, Host and Origin checks; security headers |
| [`lib/server.js`](lib/server.js) | HTTP(S) routes, uploads and files (with ranges for video), the `/ws` and `/node` websockets |
| [`lib/hub.js`](lib/hub.js) | Chats, who answers (`@mentions`, everyone, hand-offs), streaming, approval and job cards |
| [`lib/tools.js`](lib/tools.js) | The computer tools any brain gets: `computers_list`, `computer_run`, `computer_send_file`, `computer_get_file`, `computer_job`, `computer_job_cancel` |
| [`lib/nodes.js`](lib/nodes.js) | The hub's side of the nodes: pairing, enrolment, connections, jobs |
| [`lib/node-agent.js`](lib/node-agent.js) | A node: connects out, describes itself (GPUs, tools), runs commands within its own policy |
| [`lib/store.js`](lib/store.js) | One SQLite file (`hub.db`) |
| [`plugin/`](plugin) | The DSH plugin: the hub or node role, and DSH agents as the brain |
| [`static/`](static) | The page, ported from ChimeraArchive's web UI |

`npm test` runs the hub end to end with a real node on this computer, and the DSH brain against a stand-in for DSH.

## Not yet

- **Notifications** on the phone when a card needs you.
- **Resuming an upload from a computer.** A download to a computer resumes; an upload from one starts over.
- **Checked against a running DSH.** The plugin follows DSH's source and passes tests against a stand-in, but hasn't
  run inside DSH yet.
