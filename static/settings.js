"use strict";
// Settings: for the owner, the bots (make one from a preset, its picture, model, where it lives, who may use it);
// your account (password, where you're signed in, theme, sign out), your computers (add one with a pairing code,
// rename, its policy, remove) and, for the owner, the household's accounts.
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
      "connects out to this hub: it needs no open port. A bot asks you before running anything or moving a file on a computer whose " +
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
      card.append(nodeBots(node, info));
      const policy = make("select");
      for (const [value, label] of [["ask", "Ask me first (commands and files)"], ["always", "Let bots use it without asking"], ["never", "Bots can't use it"]]) {
        const option = make("option", "", label);
        option.value = value;
        policy.append(option);
      }
      policy.value = node.policy;
      policy.onchange = async () => {
        if (policy.value === "always" && !confirm(`Let bots run any command and move any file on ${node.name} without asking you?`)) { policy.value = node.policy; return; }
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

  /** The bots living on one computer, and adding one there (it runs in that computer's DSH, with its own account). */
  function nodeBots(node, info) {
    const box = make("div", "node-bots-box");
    box.append(make("h4", "", "Bots living here"));
    if (!info.agents) {
      box.append(make("p", "muted", node.online
        ? "This computer runs `dsh-hub node` without DSH, so it can run commands and move files but has no bots of its own. Run it as DSH with the dsh-hub plugin (role: node) to give it bots."
        : "Bots can live on a computer that runs DSH with the dsh-hub plugin. It is offline now."));
      return box;
    }
    const mine = (state().bots || []).filter((bot) => bot.name.startsWith(`@${node.id}/`));
    const list = make("ul", "node-bots");
    for (const bot of mine) {
      const item = make("li");
      item.append(make("strong", "", bot.display), make("span", "muted", bot.description.replace(/\s*\(lives on .*\)$/, "")));
      list.append(item);
    }
    if (!mine.length) list.append(make("li", "muted", "None yet."));
    box.append(list);
    if (node.online) box.append(button(`Add a bot on ${node.name}`, "", () => window.hubSettings.open("bots", { bot: { new: true, home: node.id } })));
    return box;
  }

  // ---- bots ------------------------------------------------------------------------------------------
  // Every bot in one place: the hub's (made here, or from the config: locked), and those living on the computers.
  // `editing`: null (the list), { new: true, home? } or { name } (that bot's form).
  let editing = null;
  const face = (bot) => window.hubAvatar ? window.hubAvatar(bot.display, undefined, bot.picture) : make("span", "", bot.display.charAt(0));
  const modelLabel = (settings, model) => {
    if (!model) return "DSH's default model";
    const found = settings.models.find((item) => item.provider === model.provider && item.model === model.model);
    return found ? `${found.name} (${found.providerName})` : `${model.model} (${model.provider}, not offered now)`;
  };

  async function bots(body) {
    if (state().user.role !== "owner") { body.append(make("p", "", "Only the owner manages the bots.")); return; }
    const settings = await api("api/bots");
    if (editing) return botForm(body, settings);
    body.append(make("p", "muted", "The bots you and the people of this hub chat with. A bot thinks with the DSH of the " +
      "computer it lives on: the hub's, or that computer's own sign-in."));
    const list = make("div", "bot-list");
    const row = (bot, tags, line, actions) => {
      const item = make("div", "bot-item");
      const text = make("div", "bot-text");
      const title = make("div", "bot-name", bot.display);
      for (const [label, kind] of tags) title.append(make("span", `bot-tag${kind ? ` is-${kind}` : ""}`, label));
      text.append(title, make("div", "bot-line muted", line));
      item.append(face(bot), text, ...actions);
      list.append(item);
    };
    for (const bot of settings.bots) {
      const tags = [["on the hub", ""]];
      if (bot.locked) tags.push(["from the config", "locked"]);
      if (bot.shared === "owner") tags.push(["only you", "private"]);
      row(bot, tags, [bot.description, modelLabel(settings, bot.model), bot.computers === false ? "no computers" : ""].filter(Boolean).join(" · "),
        [button(bot.locked ? "Picture" : "Edit", "", () => { editing = { name: bot.name }; render(); })]);
    }
    for (const bot of settings.living) {
      row(bot, [[`lives on ${bot.nodeName}`, ""], ...(bot.online ? [] : [["offline", "locked"]])],
        [bot.description.replace(/\s*\(lives on .*\)$/, ""), `${bot.nodeName}'s own DSH and model`].filter(Boolean).join(" · "),
        [button("Edit", "", () => { editing = { name: bot.name }; render(); })]);
    }
    if (!settings.bots.length && !settings.living.length) list.append(make("p", "muted", "No bots yet."));
    body.append(list, button("＋ New bot", "primary", () => { editing = { new: true }; render(); }));
  }

  function botForm(body, settings) {
    const current = editing.new ? null
      : settings.bots.find((bot) => bot.name === editing.name) || settings.living.find((bot) => bot.name === editing.name);
    if (!editing.new && !current) { editing = null; return bots(body); }
    const living = current ? current.name.startsWith("@") : Boolean(editing.home);
    const locked = Boolean(current?.locked);
    const draft = {
      display: current?.display || "", description: (current?.description || "").replace(/\s*\(lives on .*\)$/, ""),
      prompt: current?.prompt || "", preset: current?.preset || "", picture: current?.picture || null,
      model: current?.model || null, computers: current ? current.computers !== false : true,
      shared: current?.shared || "everyone", home: editing.home || "",
    };
    body.append(make("h3", "", current ? (locked ? `${current.display} (from the config)` : `Edit ${current.display}`) : "New bot"));
    if (locked) body.append(make("p", "muted", "This bot is set in the hub's DSH profile (cordis.patch.yml): change it there. Its picture is yours to set here."));
    if (current && living && current.prompt === undefined) {
      body.append(make("p", "muted", `It lives on ${current.nodeName}. Its personality is kept there: leave it empty to keep it as it is.`));
    }
    const form = make("div", "new-bot");

    // the picture: shown, uploaded, taken away
    const side = make("div", "bot-face");
    const preview = make("div", "bot-face-big");
    const showFace = () => preview.replaceChildren(face({ display: draft.display || "?", picture: draft.picture }));
    showFace();
    const file = make("input");
    Object.assign(file, { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/avif", hidden: true });
    file.onchange = async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        const response = await fetch("api/bots/picture", { method: "POST", headers: { "Content-Type": chosen.type || "application/octet-stream" }, body: chosen });
        const answer = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(answer.error || `refused (${response.status})`);
        draft.picture = answer.file.id;
        showFace();
      } catch (error) { toast(error.message); }
      file.value = "";
    };
    side.append(preview, file, button("Upload…", "", () => file.click()), button("No picture", "", () => { draft.picture = null; showFace(); }));
    form.append(side);

    const fields = make("div", "bot-fields");
    const name = textInput("text", "display", "e.g. Mochi", "off");
    name.value = draft.display;
    name.disabled = locked;
    name.oninput = () => { draft.display = name.value; showFace(); };
    fields.append(field("Name", name));

    if (!current) {
      // where it lives: the hub, or a computer running DSH (it thinks with that computer's own sign-in)
      const home = make("select");
      home.append(Object.assign(make("option", "", "The hub (this computer)"), { value: "" }));
      for (const computer of settings.computers) {
        const option = make("option", "", computer.online ? computer.name : `${computer.name} (offline)`);
        option.value = computer.id;
        option.disabled = !computer.online;
        home.append(option);
      }
      home.value = draft.home;
      home.onchange = () => { editing = { new: true, home: home.value }; draft.home = home.value; render(); };
      fields.append(field("Lives on", home));
    }

    const about = textInput("text", "description", "one line, shown in the chat", "off");
    about.value = draft.description;
    about.disabled = locked;
    fields.append(field("About", about));

    // a preset fills the personality in; it is the bot's own from then on
    const prompt = make("textarea", "bot-prompt");
    Object.assign(prompt, { rows: 6, placeholder: "Its personality: who it is, how it talks, what it is good at.", value: draft.prompt });
    prompt.disabled = locked;
    if (!locked) {
      const presets = make("div", "presets");
      for (const preset of settings.presets) {
        const chip = make("button", `preset${draft.preset === preset.id ? " is-on" : ""}`, preset.label);
        chip.type = "button";
        chip.title = preset.about;
        chip.onclick = () => {
          const filled = preset.prompt.replaceAll("{name}", name.value.trim() || "the assistant");
          if (prompt.value.trim() && prompt.value !== filled && !confirm(`Replace the personality with ${preset.label}'s?`)) return;
          prompt.value = filled;
          draft.preset = preset.id;
          for (const other of presets.children) other.classList.toggle("is-on", other === chip);
        };
        presets.append(chip);
      }
      fields.append(make("h4", "", "Start from"), presets);
    }
    fields.append(make("h4", "", "Personality"), prompt);

    const checks = [];
    if (!living) {
      const model = make("select");
      model.append(Object.assign(make("option", "", "DSH's default model"), { value: "" }));
      const groups = new Map();
      for (const item of settings.models) {
        if (!groups.has(item.providerName)) {
          const group = make("optgroup");
          group.label = item.providerName;
          groups.set(item.providerName, group);
          model.append(group);
        }
        const option = make("option", "", item.name);
        option.value = JSON.stringify({ provider: item.provider, model: item.model });
        groups.get(item.providerName).append(option);
      }
      if (draft.model && !settings.models.some((item) => item.provider === draft.model.provider && item.model === draft.model.model)) {
        const option = make("option", "", modelLabel(settings, draft.model));
        option.value = JSON.stringify(draft.model);
        model.append(option);
      }
      model.value = draft.model ? JSON.stringify(draft.model) : "";
      model.disabled = locked;
      fields.append(field("Thinks with", model));
      checks.push(() => { draft.model = model.value ? JSON.parse(model.value) : null; });

      const tick = (label, on, set) => {
        const box = make("input");
        Object.assign(box, { type: "checkbox", checked: on, disabled: locked });
        const line = make("label", "check");
        line.append(box, make("span", "", label));
        fields.append(line);
        checks.push(() => set(box.checked));
      };
      tick("May use your computers (asking you first, as each computer's policy says)", draft.computers, (value) => { draft.computers = value; });
      tick("Everyone on this hub may chat with it (else only you)", draft.shared !== "owner", (value) => { draft.shared = value ? "everyone" : "owner"; });
    } else {
      fields.append(make("p", "muted", "It thinks with that computer's own DSH and its default model, and works on that computer."));
    }

    const actions = make("div", "bot-actions");
    const save = button(current ? "Save" : `Create`, "primary", async () => {
      for (const take of checks) take();
      const payload = locked ? { picture: draft.picture }
        : { display: name.value.trim(), description: about.value.trim(), prompt: prompt.value.trim(), preset: draft.preset, picture: draft.picture,
            ...(living ? {} : { model: draft.model, computers: draft.computers, shared: draft.shared }) };
      if (living && current && !payload.prompt) delete payload.prompt;
      try {
        if (current) await api("api/bots/update", { name: current.name, ...payload });
        else await api("api/bots", { ...payload, ...(draft.home ? { home: draft.home } : {}) });
        toast(current ? `Saved ${payload.display || current.display}.` : `${payload.display} is here: start a chat with it.`);
        editing = null;
        render();
      } catch (error) { toast(error.message); }
    });
    actions.append(save, button("Cancel", "", () => { editing = null; render(); }));
    if (current && !locked) {
      actions.append(button("Remove", "danger", async () => {
        if (!confirm(`Remove ${current.display}? Chats with it stay, but it no longer answers.`)) return;
        try { await api("api/bots/remove", { name: current.name }); editing = null; render(); } catch (error) { toast(error.message); }
      }));
    }
    fields.append(actions);
    form.append(fields);
    body.append(form);
    setTimeout(() => (locked ? null : name).focus?.(), 0);
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
  const TABS = { bots: ["Bots", bots], account: ["Account", account], computers: ["Computers", computers], people: ["People", people] };
  async function render(options = {}) {
    const owner = state()?.user.role === "owner";
    const tabs = $("#settings-tabs");
    tabs.replaceChildren();
    for (const [key, [label]] of Object.entries(TABS)) {
      if (!owner && key !== "account") continue;
      const node = make("button", `tab${key === tab ? " is-current" : ""}`, label);
      node.type = "button";
      node.setAttribute("role", "tab");
      node.onclick = () => { tab = key; editing = null; render(); };
      tabs.append(node);
    }
    const body = $("#settings-body");
    const fresh = make("div");
    try { await TABS[tab][1](fresh, options); } catch (error) { if (error.message !== "signed out") fresh.append(make("p", "warn-note", error.message)); }
    body.replaceChildren(fresh);
  }
  const dialog = $("#settings");
  window.hubSettings = {
    open (which = "account", options = {}) { tab = which; editing = options.bot ?? null; dialog.hidden = false; render(options); },
    // the bots' list follows changes made elsewhere; a form being filled in is left alone
    refresh () { if (!dialog.hidden && (tab === "computers" || (tab === "bots" && !editing))) render(); },
  };
  $("#settings-close").onclick = () => { dialog.hidden = true; };
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.hidden = true; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") dialog.hidden = true; });
})();
