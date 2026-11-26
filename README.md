# dsh-deepseek-bot

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

The echo brain stands in for a model. It says back what you say, and it runs `run <computer>: <command>` on a node
(also `delegate <computer>: <task>` on one running DSH).

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

Each computer uses its own DSH sign-in (your DeepSeek account, or an API key). The hub's bots think on the hub's
account; a bot living on the ROG thinks on the ROG's.

### Installing it

In the DSH desktop app: **Plugins → Add plugin**, and give it this address, which needs nothing else on the computer:

```
https://github.com/RustColeone/dsh-deepseek-bot/archive/refs/tags/v0.2.0.tar.gz
```

Or on the command line (the desktop app's is
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`, and it brings its own Node):

```
dsh plugin --profile desktop add https://github.com/RustColeone/dsh-deepseek-bot/archive/refs/tags/v0.2.0.tar.gz
```

A release's address never changes what it installs; a newer release is installed by removing this one and adding
its address. `github:RustColeone/dsh-deepseek-bot` (the newest commit) works too, but needs [Git](https://git-scm.com)
on the computer. To work on the plugin itself, add your checkout: `"link:C:/path/to/dsh-deepseek-bot"` follows the
folder as you edit it. The plugin is plain JavaScript, so nothing is built at install time.

A fresh install does nothing until you choose what the computer is. (A computer that already had a hub stays one.)

### Setting it up

Either way writes the same settings (`<DSH home>/dsh-hub/settings.json`), and a running DSH follows them within
seconds:

- **In DSH:** Plugins → dsh-hub, in the desktop app or DSH's web page. Choose *The hub* or *A computer of a hub*, and
  the page shows its settings and how it is doing. A hub with no account yet shows its setup code there. A computer
  joins a hub with the hub's address and a pairing code from that hub's page.
- **On the command line:** `dsh-hub config` (in the plugin's `bin` folder; on Windows `dsh-hub.cmd`, which uses the
  desktop app's Node when Node isn't installed):

  ```
  dsh-hub config                                  # what this computer is, every setting, the setup code
  dsh-hub config hub                              # make it the hub
  dsh-hub config join http://192.168.1.10:4180 ABCD-EFGH   # make it a computer of that hub
  dsh-hub config set node.policy.exec never       # one setting; unset puts it back
  dsh-hub config off
  ```

  With the desktop app the folder is `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-hub\bin`.

Then:

1. **The hub (the main computer):** open `http://<hub>:4180/setup` and make your account with the setup code, which is
   on the plugin's page, in `dsh-hub config`, in the hub's console and in `<DSH home>/dsh-hub/hub/setup-code.txt`.
2. **Each other computer:** on the hub's page, ⚙️ Settings → Computers → Add gives a pairing code; join with it as
   above. After that the code isn't needed.

A profile's `cordis.patch.yml` can set all of this too, as in [`examples/hub-profile`](examples/hub-profile) and
[`examples/node-profile`](examples/node-profile) (also the hub's bots and model, which the page doesn't set). What
the profile sets wins, and the page shows it as locked. Every option is documented at the top of
[`plugin/index.js`](plugin/index.js). A profile of its own for the hub, run with `dsh hub --no-open`, is made from the
shipped `web` profile: `dsh hub --from-default-profile web --dump-config`, then add the plugin to it with
`dsh plugin --profile hub add <address>`.

## Bots that live on your computers

A computer running DSH as a node has agents of its own, which think with that computer's sign-in and work with its
own shell, files and web:

- **Its bots.** Add one from the page (⚙️ Settings → Computers → the computer → Add a bot here), or list them in its
  profile's config (`bots:`). It then shows up as a chat member like the hub's bots: chat with it alone, or bring it
  into a group chat with @mentions. A file attached for it is copied to its computer first, and it can post files
  from there into the chat (`chat_send_file`). Its DSH sessions are kept on its computer; the chat itself is kept on
  the hub.
- **Tasks.** A hub bot can hand a computer a task of many steps (`computer_delegate`). An agent there does it and
  reports back, with a job card in the chat showing what it is doing. Passing the `session` from the result
  continues with the same agent.

What those agents do is governed by their computer's DSH permissions (`permission`, `workspace-write` by default,
working in the inbox folder). When DSH asks for an approval, the card shows up in the hub's chat. The computer's own
policy decides whether the hub may add bots there (`policy.bots`) or hand it tasks (`policy.tasks`).
`dsh-hub node` without DSH has no agents: it only runs commands and moves files.

## Security

The rule: anyone who can use the page can run commands on your computers. So the page always has accounts, even on
the home network.

| | |
|---|---|
| First account | Made only with the setup code shown on the hub's computer (its console, and `setup-code.txt` in its folder until the owner exists), so nobody on the network can claim an empty hub. |
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
| [`plugin/index.js`](plugin/index.js) | The DSH plugin: the hub or node role, restarted when its settings change |
| [`plugin/control.js`](plugin/control.js) | What the computer runs, and the settings page's routes on DSH's own API (its owner only) |
| [`plugin/client.js`](plugin/client.js) | The settings page under DSH's Plugins |
| [`lib/settings.js`](lib/settings.js) | The settings file that page and `dsh-hub config` write |
| [`plugin/runner.js`](plugin/runner.js) | Running a DSH agent: a session made or resumed, a turn streamed, its approvals routed |
| [`plugin/brain.js`](plugin/brain.js) | The hub's bots as DSH agents |
| [`plugin/node-brain.js`](plugin/node-brain.js) | A node's own bots and its task agent as DSH agents |
| [`static/`](static) | The page, ported from ChimeraArchive's web UI |

`npm test` runs the hub end to end with a real node on this computer, and the DSH brain against a stand-in for DSH.

## Not yet

- **Notifications** on the phone when a card needs you.
- **Resuming an upload from a computer.** A download to a computer resumes; an upload from one starts over.
- **A task outlasting a dropped connection.** If a node loses the hub, its running bot replies and tasks stop.

## License

[MIT](LICENSE). The Nunito font in `static/` is under the [SIL Open Font License](static/NUNITO-OFL.txt).
