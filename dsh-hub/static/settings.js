"use strict";
// Settings: your account (password, where you're signed in, theme, sign out), your computers (add one with a pairing
// code, rename, its policy, remove) and, for the owner, the household's accounts.
(() => {
  const $ = (selector) => document.querySelector(selector);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const state = () => window.hubState;
  const toast = (text) => window.hubToast?.(text);
  let tab = "account";
  let pairing = null; // { code, name, expires } just made

  async function api(route, payload) {
    const response = await fetch(route, payload === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) { location.href = "login"; throw new Error("signed out"); }
    if (!response.ok) throw new Error(answer.error || `refused (${response.status})`);
    return answer;
  }
  const field = (label, input) => { const row = make("label", "field"); row.append(make("span", "field-label", label), input); return row; };
  const textInput = (type, name, placeholder = "", auto = "off") => {
    const input = make("input");
    Object.assign(input, { type, name, placeholder, autocomplete: auto });
    return input;
  };
  const button = (label, style, action) => {
    const node = make("button", `small-button${style ? ` is-${style}` : ""}`, label);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const ago = (seconds) => {
    const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
    if (minutes < 2) return "just now";
    if (minutes < 120) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
  };

  // ---- account ---------------------------------------------------------------------------------------
  async function account(body) {
    const me = await api("api/me");
    body.append(make("h3", "", `${me.user.name} · ${me.user.role}`));
    if (!me.secure && !me.local) {
      body.append(make("p", "warn-note", "⚠️ You are on plain http from outside your home network: your password and " +
        "chats cross the internet readable. Use Tailscale or WireGuard, or give the hub https."));
    }
    const form = make("form", "settings-form");
    const current = textInput("password", "current", "", "current-password");
    const next = textInput("password", "next", "10+ characters", "new-password");
    const again = textInput("password", "again", "", "new-password");
    const save = make("button", "small-button is-primary", "Change password");
    form.append(make("h4", "", "Password"), field("Current", current), field("New", next), field("New again", again), save);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (next.value !== again.value) { toast("The two new passwords differ."); return; }
      try { await api("api/password", { current: current.value, next: next.value }); location.href = "login"; } catch (error) { toast(error.message); }
    };
    body.append(form);

    body.append(make("h4", "", "Theme"));
    const theme = make("select");
    for (const [value, label] of [["system", "Like the system"], ["light", "Light"], ["dark", "Dark"]]) {
      const option = make("option", "", label);
      option.value = value;
      theme.append(option);
    }
    theme.value = window.prefs?.get("theme") || "system";
    theme.onchange = () => window.prefs?.set("theme", theme.value);
    body.append(theme);

    body.append(make("h4", "", "Signed in"));
    const list = make("ul", "logins");
    for (const login of me.logins) {
      const item = make("li", login.current ? "is-current" : "");
      item.append(make("span", "", `${login.current ? "This browser" : login.agent.split(/[()]/)[1] || login.agent || "A browser"}`),
        make("span", "muted", ` · ${login.address} · ${ago(login.seen)}`));
      list.append(item);
    }
    body.append(list, make("p", "muted", "Changing your password signs you out everywhere."));
    body.append(button("Sign out", "danger", async () => { await api("api/logout", {}); location.href = "login"; }));
  }

  // ---- computers -------------------------------------------------------------------------------------
  const hubAddress = () => new URL(".", location.href).href.replace(/\/$/, "");
  function computers(body, options = {}) {
    if (state().user.role !== "owner") { body.append(make("p", "", "Only the owner manages computers.")); return; }
    body.append(make("p", "muted", "Each computer runs DSH with the dsh-hub plugin as a node (or `dsh-hub node`) and " +
      "connects out to this hub: it needs no open port. A bot asks you before running anything on a computer whose " +
      "policy is ask; the computer's own policy file has the last word."));
    const add = make("form", "settings-form add-computer");
    const name = textInput("text", "name", "e.g. ROG", "off");
    add.append(make("h4", "", "Add a computer"), field("Its name", name), make("button", "small-button is-primary", "Get a pairing code"));
    add.onsubmit = async (event) => {
      event.preventDefault();
      try { pairing = await api("api/nodes/pair", { name: name.value }); render(); } catch (error) { toast(error.message); }
    };
    body.append(add);
    if (pairing && pairing.expires > Date.now() / 1000) {
      const box = make("div", "pairing");
      box.append(make("div", "pairing-code", pairing.code),
        make("p", "", `For “${pairing.name}”, once, within 10 minutes. On that computer, either:`));
      const cli = make("pre");
      cli.append(make("code", "", `# in a copy of the dsh-hub folder\nnode bin/dsh-hub.js join ${hubAddress()} ${pairing.code}\nnode bin/dsh-hub.js node`));
      const dsh = make("pre");
      dsh.append(make("code", "", `# or in its DSH profile's cordis.patch.yml\n- id: dsh-hub\n  config:\n    role: node\n    hub: ${hubAddress()}\n    code: ${pairing.code}`));
      box.append(cli, dsh);
      body.append(box);
    }
    if (options.add) setTimeout(() => name.focus(), 0);

    const nodes = state().nodes || [];
    body.append(make("h4", "", nodes.length ? "Your computers" : "No computer has joined yet."));
    for (const node of nodes) {
      const info = node.info || {};
      const card = make("div", `node-card${node.online ? " is-online" : ""}`);
      const head = make("div", "node-head");
      head.append(make("span", "computer-dot"), make("strong", "", node.name),
        make("span", "muted", node.online ? "online" : `offline · seen ${node.seen ? ago(node.seen) : "never"}`));
      card.append(head);
      const facts = [
        [info.os || info.platform, info.arch].filter(Boolean).join(" "), info.hostname && `host ${info.hostname}`,
        info.cpu && `${info.cpu} (${info.cores} threads)`, info.memoryGB && `${info.memoryGB} GB memory`,
        ...(info.gpus || []).map((gpu) => `GPU ${gpu.name}${gpu.memoryMB ? ` (${Math.round(gpu.memoryMB / 1024)} GB)` : ""}`),
        Object.keys(info.tools || {}).length && `has ${Object.keys(info.tools).join(", ")}`,
      ].filter(Boolean);
      const list = make("ul", "node-facts");
      for (const fact of facts) list.append(make("li", "", fact));
      card.append(list);
      const policy = make("select");
      for (const [value, label] of [["ask", "Ask me before each command"], ["always", "Run without asking"], ["never", "Never run commands"]]) {
        const option = make("option", "", label);
        option.value = value;
        policy.append(option);
      }
      policy.value = node.policy;
      policy.onchange = async () => {
        if (policy.value === "always" && !confirm(`Let bots run any command on ${node.name} without asking you?`)) { policy.value = node.policy; return; }
        try { await api("api/nodes/update", { id: node.id, policy: policy.value }); } catch (error) { toast(error.message); }
      };
      const actions = make("div", "node-actions");
      actions.append(policy,
        button("Rename", "", async () => {
          const value = prompt("Name this computer", node.name);
          if (value && value.trim() !== node.name) try { await api("api/nodes/update", { id: node.id, name: value.trim() }); } catch (error) { toast(error.message); }
        }),
        button("Remove", "danger", async () => {
          if (!confirm(`Remove ${node.name}? It is signed out of the hub and has to join again with a new code.`)) return;
          try { await api("api/nodes/remove", { id: node.id }); } catch (error) { toast(error.message); }
        }));
      card.append(actions);
      body.append(card);
    }
  }

  // ---- people ----------------------------------------------------------------------------------------
  async function people(body) {
    const { users } = await api("api/users");
    body.append(make("p", "muted", "Everyone in the household can have an account: their chats are their own, and only " +
      "an owner can use or approve the computers."));
    for (const user of users) {
      const row = make("div", "person");
      row.append(make("strong", "", user.name), make("span", "muted", ` · ${user.role}`));
      if (user.role !== "owner") {
        row.append(button("Remove", "danger", async () => {
          if (!confirm(`Remove ${user.name}'s account and their chats?`)) return;
          try { await api("api/users/remove", { id: user.id }); render(); } catch (error) { toast(error.message); }
        }));
      }
      body.append(row);
    }
    const form = make("form", "settings-form");
    const name = textInput("text", "name", "", "off");
    const password = textInput("password", "password", "10+ characters", "new-password");
    form.append(make("h4", "", "Add an account"), field("Name", name), field("Password", password),
      make("button", "small-button is-primary", "Add"));
    form.onsubmit = async (event) => {
      event.preventDefault();
      try { await api("api/users", { name: name.value, password: password.value }); toast(`Added ${name.value}.`); render(); } catch (error) { toast(error.message); }
    };
    body.append(form);
  }

  // ---- the dialog ------------------------------------------------------------------------------------
  const TABS = { account: ["Account", account], computers: ["Computers", computers], people: ["People", people] };
  async function render(options = {}) {
    const owner = state()?.user.role === "owner";
    const tabs = $("#settings-tabs");
    tabs.replaceChildren();
    for (const [key, [label]] of Object.entries(TABS)) {
      if (!owner && key !== "account") continue;
      const node = make("button", `tab${key === tab ? " is-current" : ""}`, label);
      node.type = "button";
      node.setAttribute("role", "tab");
      node.onclick = () => { tab = key; render(); };
      tabs.append(node);
    }
    const body = $("#settings-body");
    const fresh = make("div");
    try { await TABS[tab][1](fresh, options); } catch (error) { if (error.message !== "signed out") fresh.append(make("p", "warn-note", error.message)); }
    body.replaceChildren(fresh);
  }
  const dialog = $("#settings");
  window.hubSettings = {
    open (which = "account", options = {}) { tab = which; dialog.hidden = false; render(options); },
    refresh () { if (!dialog.hidden && tab === "computers") render(); },
  };
  $("#settings-close").onclick = () => { dialog.hidden = true; };
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.hidden = true; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") dialog.hidden = true; });
})();
