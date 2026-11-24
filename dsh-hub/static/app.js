"use strict";
// The chat page (Chimera's MomoChat page, carried over): the chat list, the chat, who is in it and your computers,
// the composer. Everything goes through one websocket (lib/server.js, lib/hub.js); replies stream in as they are
// written; approval cards and job cards (a command running on one of your computers) live in the chat.
(() => {
  const $ = (selector) => document.querySelector(selector);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const COLORS = {
    deepseek: { accent: "#4d8ff0", ink: "#2f4f9e" }, claude: { accent: "#e5896a", ink: "#9a4916" },
    gpt: { accent: "#8a80d0", ink: "#5a5296" }, gemini: { accent: "#9a86f2", ink: "#683fa0" },
    grok: { accent: "#e2b545", ink: "#6f5900" }, you: { accent: "#f0a04b", ink: "#b8741f" },
    hub: { accent: "#b39c8a", ink: "#8c7a6b" },
  };
  const state = {
    title: "Hub", user: { name: "You", role: "member" }, bots: [], nodes: [], conversations: [],
    current: localStorage.getItem("hub.chat") || "", lastId: 0, progress: new Map(), unread: new Set(),
    pending: [], files: [], ws: null, retry: 0, paletteIndex: 0, menuFor: null, dragging: null, drafts: new Map(),
    search: "", maxUploadMB: 2048,
  };
  window.hubState = state;
  const messages = $("#messages");
  const input = $("#input");
  const touch = window.matchMedia("(pointer: coarse)").matches;

  // ---- people ----------------------------------------------------------------------------------------
  const keyOf = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  function look(key) {
    if (COLORS[key]) return COLORS[key];
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return { accent: `hsl(${hash} 55% 62%)`, ink: `hsl(${hash} 45% 42%)` };
  }
  function paint(node, key) {
    const colors = look(key);
    node.style.setProperty("--c", colors.accent);
    node.style.setProperty("--ci", colors.ink);
    node.style.setProperty("--cb", colors.accent);
    node.style.setProperty("--cp", colors.ink);
    return node;
  }
  const initial = (name) => (String(name || "?").trim().charAt(0) || "?").toUpperCase();
  function avatar(name, key = keyOf(name)) {
    const node = paint(make("div", "avatar"), key);
    node.textContent = initial(name);
    return node;
  }
  const chatOf = (id) => state.conversations.find((chat) => chat.id === id);
  const botsOf = (chat) => (chat?.bots ? state.bots.filter((bot) => chat.bots.includes(bot.name)) : state.bots);
  const isDirect = (chat) => botsOf(chat).length === 1 && state.bots.length > 1;
  const botByDisplay = (display) => state.bots.find((bot) => bot.display === display);

  // ---- panels: chats on the left, who and what is here on the right ---------------------------------
  const LEVELS = { wide: "(min-width: 1201px)", medium: "(min-width: 761px) and (max-width: 1200px)",
                   narrow: "(max-width: 760px)" };
  const DEFAULTS = { wide: { sidebar: true, members: true }, medium: { sidebar: true, members: false },
                     narrow: { sidebar: false, members: false } };
  const SIZES = { sidebar: [220, 440, 300], members: [220, 420, 280] };
  const media = Object.fromEntries(Object.entries(LEVELS).map(([name, query]) => [name, window.matchMedia(query)]));
  const level = () => Object.keys(media).find((name) => media[name].matches) || "wide";
  const isOpen = (name) => document.body.classList.contains(`show-${name}`);
  function setPanel(name, open, remember = true) {
    document.body.classList.toggle(`show-${name}`, open);
    $(name === "sidebar" ? "#toggle-sidebar" : "#toggle-members").setAttribute("aria-pressed", String(open));
    if (remember && level() !== "narrow") localStorage.setItem(`hub.${level()}.${name}`, open ? "open" : "closed");
    $("#scrim").hidden = !(level() === "narrow" && (isOpen("sidebar") || isOpen("members")));
    fitWidths();
  }
  const closePanels = () => { if (level() === "narrow") { setPanel("sidebar", false); setPanel("members", false); } };
  function applyLevel() {
    const current = level();
    for (const name of ["sidebar", "members"]) {
      const stored = current === "narrow" ? null : localStorage.getItem(`hub.${current}.${name}`);
      setPanel(name, stored ? stored === "open" : DEFAULTS[current][name], false);
    }
  }
  const CHAT_MIN = 360;
  const wanted = Object.fromEntries(Object.entries(SIZES).map(([name, [, , fallback]]) =>
    [name, Number(localStorage.getItem(`hub.width.${name}`)) || fallback]));
  const docked = (name) => level() !== "narrow" && isOpen(name);
  function inside() {
    const app = $("#app");
    const style = getComputedStyle(app);
    const gaps = ["sidebar", "members"].filter(docked).length * (parseFloat(style.getPropertyValue("--gap")) || 0);
    return app.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - gaps;
  }
  function fitWidths() {
    const shown = { ...wanted };
    const open = Object.keys(shown).filter(docked);
    const spare = inside() - CHAT_MIN;
    const total = open.reduce((sum, name) => sum + shown[name], 0);
    if (total > spare) for (const name of open) shown[name] = Math.max(SIZES[name][0], Math.floor(shown[name] * spare / total));
    for (const [name, width] of Object.entries(shown)) document.documentElement.style.setProperty(`--${name}-w`, `${width}px`);
  }
  function setWidth(name, width) {
    const [low, high] = SIZES[name];
    const other = name === "sidebar" ? "members" : "sidebar";
    const room = inside() - CHAT_MIN - (docked(other) ? $(`#${other}`).getBoundingClientRect().width : 0);
    wanted[name] = Math.round(Math.max(low, Math.min(high, room, width)));
    fitWidths();
    return wanted[name];
  }
  function resizable(handle, name) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = $(`#${name}`).getBoundingClientRect().width;
      const direction = name === "sidebar" ? 1 : -1;
      document.body.classList.add("is-resizing");
      let width = startWidth;
      const moveTo = (move) => { width = setWidth(name, startWidth + direction * (move.clientX - startX)); };
      const stop = () => {
        handle.removeEventListener("pointermove", moveTo);
        document.body.classList.remove("is-resizing");
        localStorage.setItem(`hub.width.${name}`, String(width));
      };
      handle.addEventListener("pointermove", moveTo);
      handle.addEventListener("pointerup", stop, { once: true });
      handle.addEventListener("pointercancel", stop, { once: true });
    });
    handle.addEventListener("dblclick", () => { localStorage.removeItem(`hub.width.${name}`); setWidth(name, SIZES[name][2]); });
  }

  // ---- who is here, and your computers ---------------------------------------------------------------
  function renderMembers() {
    const list = $("#member-list");
    list.replaceChildren();
    const chat = chatOf(state.current);
    const members = botsOf(chat);
    const busy = new Set([...state.progress.values()].filter((run) => run.conversation === state.current).map((run) => run.speaker));
    $("#members-title").textContent = members.length === 1 ? "In this chat" : `In this chat — ${members.length}`;
    for (const bot of members) {
      const card = paint(make("div", "member-card"), keyOf(bot.display));
      const member = paint(make("button", "member"), keyOf(bot.display));
      member.type = "button";
      member.title = members.length > 1 ? `Mention @${bot.display}` : bot.description || "";
      if (busy.has(bot.display)) member.classList.add("is-typing");
      const face = make("div", "member-face");
      face.append(avatar(bot.display), make("span", "presence"));
      const text = make("div", "member-text");
      text.append(make("div", "member-name", bot.display),
        make("div", "member-status", busy.has(bot.display) ? "working…" : bot.home && !bot.online ? `offline · lives on ${bot.home}` : bot.description || "here"));
    if (bot.home && !bot.online) member.classList.add("is-offline");
      member.append(face, text);
      member.onclick = () => { if (members.length > 1) mention(bot.display); if (level() === "narrow") setPanel("members", false); };
      const row = make("div", "member-row");
      row.append(member);
      if (members.length > 1) {
        const direct = make("button", "member-dm", "💬");
        direct.type = "button";
        direct.title = `Message ${bot.display} alone`;
        direct.setAttribute("aria-label", direct.title);
        direct.onclick = () => { startChat([bot.name]); if (level() === "narrow") setPanel("members", false); };
        row.append(direct);
      }
      card.append(row);
      list.append(card);
    }
    const you = make("div", "members-you");
    you.append(make("div", "members-subhead", "You"));
    const me = paint(make("div", "member is-you"), "you");
    const face = make("div", "member-face");
    face.append(avatar(state.user.name, "you"), make("span", "presence"));
    const text = make("div", "member-text");
    text.append(make("div", "member-name", state.user.name), make("div", "member-status", state.user.role));
    me.append(face, text);
    you.append(me);
    list.append(you);
    renderComputers();
  }

  const gpuText = (info) => (info?.gpus || []).map((gpu) => gpu.name).join(", ");
  function renderComputers() {
    const owner = state.user.role === "owner";
    $("#computers").hidden = !owner;
    if (!owner) return;
    const list = $("#computer-list");
    list.replaceChildren();
    if (!state.nodes.length) {
      list.append(make("div", "computer-none", "No computer has joined yet. Add one, then ask in any chat: “run nvidia-smi on my PC”."));
      return;
    }
    for (const node of state.nodes) {
      const row = make("button", `computer${node.online ? " is-online" : ""}`);
      row.type = "button";
      row.title = "Settings for this computer";
      const dot = make("span", "computer-dot");
      const text = make("span", "computer-text");
      const info = node.info || {};
      text.append(make("span", "computer-name", node.name),
        make("span", "computer-info", [node.online ? "online" : "offline", info.os || info.platform, gpuText(info)]
          .filter(Boolean).join(" · ")));
      row.append(dot, text);
      if (node.running) row.append(make("span", "computer-jobs", `${node.running} running`));
      if (node.policy !== "ask") row.append(make("span", `computer-policy policy-${node.policy}`, node.policy === "always" ? "auto" : "off"));
      row.onclick = () => window.hubSettings?.open("computers");
      list.append(row);
    }
  }

  // ---- chats -----------------------------------------------------------------------------------------
  function chatFaces(chat) {
    const members = botsOf(chat);
    const holder = make("span", `faces${members.length === 1 ? " is-one" : ""}`);
    for (const bot of members.slice(0, 3)) holder.append(avatar(bot.display));
    return holder;
  }
  function lastLine(chat) {
    const last = chat.last;
    if (!last) return botsOf(chat).length === 1 ? "Say hello" : `${botsOf(chat).length} bots`;
    if (last.kind === "user") return `You: ${last.text}`;
    return botsOf(chat).length === 1 || !last.speaker ? last.text : `${last.speaker}: ${last.text}`;
  }
  function renderChats() {
    const list = $("#chats");
    list.replaceChildren();
    const query = state.search.trim().toLowerCase();
    const matches = (chat) => !query || [chat.title, ...botsOf(chat).map((bot) => bot.display), chat.last?.text || ""]
      .join(" ").toLowerCase().includes(query);
    for (const chat of state.conversations.filter(matches)) {
      const item = make("div", "chat" + (chat.id === state.current ? " is-current" : ""));
      item.draggable = !query;
      item.dataset.id = chat.id;
      const opener = make("button", "chat-open");
      opener.type = "button";
      opener.title = botsOf(chat).map((bot) => bot.display).join(", ");
      if (chat.id === state.current) opener.setAttribute("aria-current", "true");
      opener.onclick = () => { open(chat.id); if (level() === "narrow") setPanel("sidebar", false); };
      const text = make("span", "chat-text");
      const top = make("span", "chat-top");
      top.append(make("strong", "chat-name", chat.title || chat.id),
        make("span", "chat-side", botsOf(chat).length > 1 ? "group" : ""));
      text.append(top, make("span", "chat-last", lastLine(chat)));
      opener.append(chatFaces(chat), text);
      item.append(opener);
      if (chat.pinned) item.append(make("span", "chat-pin", "📌"));
      if (state.unread.has(chat.id)) item.append(make("span", "dot"));
      const more = make("button", "chat-more", "⋯");
      more.type = "button";
      more.title = "Chat options";
      more.onclick = (event) => { event.stopPropagation(); showMenu(chat, more); };
      item.append(more);
      item.addEventListener("dragstart", (event) => {
        state.dragging = chat.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", chat.id);
        item.classList.add("is-dragging");
      });
      item.addEventListener("dragend", () => { state.dragging = null; item.classList.remove("is-dragging"); });
      item.addEventListener("dragover", (event) => {
        if (!state.dragging || state.dragging === chat.id) return;
        event.preventDefault();
        const below = event.offsetY > item.offsetHeight / 2;
        item.classList.toggle("drop-below", below);
        item.classList.toggle("drop-above", !below);
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-above", "drop-below"));
      item.addEventListener("drop", (event) => {
        if (!state.dragging) return;
        event.preventDefault();
        event.stopPropagation();
        const below = item.classList.contains("drop-below");
        item.classList.remove("drop-above", "drop-below");
        move(state.dragging, chat.id, below);
      });
      list.append(item);
    }
    if (query && !list.children.length) list.append(make("div", "chats-none", "No chat matches."));
    renderHeader();
  }
  function renderHeader() {
    const chat = chatOf(state.current);
    const members = botsOf(chat);
    $("#chat-faces").replaceChildren(chat ? chatFaces(chat) : make("span"));
    $("#chat-title").textContent = chat ? chat.title : "Chat";
    $("#chat-title").classList.add("can-rename");
    $("#chat-title").title = "Rename";
    $("#chat-sub").textContent = members.length === 1 ? `with ${members[0].display}` : members.map((bot) => bot.display).join(", ");
    document.title = `${chat ? chat.title + " · " : ""}${state.title}`;
    $("#empty-title").textContent = members.length === 1 ? `Just you and ${members[0].display}.` : `${members.map((bot) => bot.display).join(", ")} are here.`;
    input.placeholder = members.length === 1 ? `Message ${members[0].display}…` : "Message everyone… (@ someone to ask them)";
  }
  function move(id, target, below) {
    const order = state.conversations.map((chat) => chat.id).filter((item) => item !== id);
    order.splice(order.indexOf(target) + (below ? 1 : 0), 0, id);
    const byId = new Map(state.conversations.map((chat) => [chat.id, chat]));
    state.conversations = order.map((item) => byId.get(item));
    renderChats();
    transmit({ type: "order", conversations: order });
  }
  function showMenu(chat, anchor) {
    const menu = $("#chat-menu");
    menu.replaceChildren();
    state.menuFor = chat.id;
    const entries = [
      ["✏️ Rename", () => rename(chat)],
      [chat.pinned ? "📌 Unpin" : "📌 Pin to top", () => transmit({ type: "pin", conversation: chat.id, pinned: !chat.pinned })],
      ["🗑️ Delete", () => remove(chat), "danger"],
    ];
    for (const [label, action, style] of entries) {
      const item = make("button", "menu-item" + (style ? ` menu-${style}` : ""), label);
      item.type = "button";
      item.onclick = () => { hideMenu(); action(); };
      menu.append(item);
    }
    const box = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - 150)}px`;
    menu.style.left = `${Math.min(box.left, window.innerWidth - 190)}px`;
    menu.hidden = false;
  }
  function hideMenu() { $("#chat-menu").hidden = true; state.menuFor = null; }
  function rename(chat) {
    const title = prompt("Name this chat", chat.title || "");
    if (title && title.trim()) transmit({ type: "rename", conversation: chat.id, title: title.trim() });
  }
  function remove(chat) {
    if (confirm(`Delete “${chat.title || chat.id}”? Its messages and files are deleted from the hub.`)) {
      transmit({ type: "delete", conversation: chat.id });
    }
  }

  // ---- messages --------------------------------------------------------------------------------------
  const time = (seconds) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  const scrollDown = () => { messages.scrollTop = messages.scrollHeight; };
  function speakerOf(item) {
    if (item.kind === "user") return { name: item.sender || state.user.name, key: "you", mine: true };
    if (item.speaker) return { name: item.speaker, key: keyOf(item.speaker), mine: false };
    return { name: state.title, key: "hub", mine: false };
  }
  const size = (bytes) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  function fileView(file) {
    const url = `files/${encodeURIComponent(file.id)}`;
    if (/^image\//.test(file.mime)) {
      const image = make("img", "attachment-image");
      image.src = url;
      image.alt = file.name;
      image.loading = "lazy";
      image.onclick = () => view(url);
      return image;
    }
    if (/^(audio|video)\//.test(file.mime)) {
      const player = make(file.mime.startsWith("audio") ? "audio" : "video", "attachment-media");
      player.controls = true;
      player.preload = "metadata";
      player.src = url;
      return player;
    }
    const link = make("a", "attachment-file");
    link.href = url;
    link.download = file.name;
    link.append(make("span", "file-icon", "📄"), make("span", "file-name", file.name), make("span", "file-size", size(file.size)));
    return link;
  }
  function bubbleText(text) {
    const body = make("div", "markdown");
    window.Markdown.into(body, text, state.bots.map((bot) => bot.display));
    body.querySelectorAll(".mention").forEach((chip) => paint(chip, chip.dataset.who));
    return body;
  }

  const DECIDED = { approved: "✓ approved", always: "✓ always allowed", denied: "✕ denied", expired: "⌛ nobody answered",
                    cancelled: "— withdrawn" };
  function approvalCard(item) {
    const data = item.data || {};
    const card = make("div", "approval");
    const head = make("div", "approval-head");
    head.append(make("span", "approval-icon", "🔐"), make("span", "approval-title", data.title || "May I do this?"));
    card.append(head, make("div", "approval-summary", data.summary || item.text));
    if (data.detail) {
      const pre = make("pre", "approval-command");
      pre.append(make("code", "", data.detail));
      card.append(pre);
    }
    card.append(make("div", "approval-meta", [item.speaker && `Asked by ${item.speaker}`, data.meta].filter(Boolean).join(" · ")));
    const buttons = make("div", "approval-buttons");
    if (item.decided) {
      buttons.append(make("span", `decided decided-${item.decided}`, DECIDED[item.decided] || item.decided));
    } else if (state.user.role !== "owner") {
      buttons.append(make("span", "decided", "Waiting for the owner…"));
    } else {
      const choices = [["approved", "Approve", "primary"], ...(data.always ? [["always", data.always, "secondary"]] : []),
                       ["denied", "Deny", "danger"]];
      for (const [decision, label, style] of choices) {
        const button = make("button", `action action-${style}`, label);
        button.type = "button";
        button.onclick = () => {
          buttons.querySelectorAll("button").forEach((other) => { other.disabled = true; });
          transmit({ type: "decide", message: item.id, decision });
        };
        buttons.append(button);
      }
    }
    card.append(buttons);
    return card;
  }

  const JOB_STATUS = { starting: "starting", running: "running", done: "finished", failed: "failed", cancelled: "stopped", lost: "lost" };
  function jobCard(item) {
    const job = item.data || {};
    const card = make("div", `job job-${job.status}`);
    const head = make("div", "job-head");
    const icon = { send: "📤", get: "📥" }[job.kind] || "🖥️";
    head.append(make("span", "job-icon", icon), make("span", "job-node", job.node || "computer"),
      make("span", `job-status status-${job.status}`, JOB_STATUS[job.status] || job.status));
    const facts = [job.code != null ? `exit ${job.code}` : "", job.seconds != null ? `${job.seconds}s` : "", job.id].filter(Boolean);
    head.append(make("span", "job-facts", facts.join(" · ")));
    const command = make("pre", "job-command");
    command.append(make("code", "", job.command || item.text));
    card.append(head, command);
    if (job.output) {
      const output = make("pre", "job-output");
      output.textContent = job.output;
      card.append(output);
      requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
    }
    if (job.kind === "send" && job.status === "done" && job.result?.path) {
      card.append(make("div", "job-result", `✓ on ${job.node} at ${job.result.path}`));
    }
    if (job.error) card.append(make("div", "job-error", `⚠️ ${job.error}`));
    if (["starting", "running"].includes(job.status) && state.user.role === "owner") {
      const stop = make("button", "action action-danger job-stop", "Stop");
      stop.type = "button";
      stop.onclick = () => { stop.disabled = true; transmit({ type: "job_cancel", job: job.id }); };
      card.append(stop);
    }
    return card;
  }

  function renderItem(item) {
    const row = make("div", "row");
    row.dataset.id = item.id;
    if (item.kind === "approval" || item.kind === "job") {
      row.classList.add("row-card");
      row.append(item.kind === "approval" ? approvalCard(item) : jobCard(item));
      return row;
    }
    if (item.kind === "notice") {
      row.classList.add("row-pill");
      row.append(make("div", "pill", item.text));
      return row;
    }
    const who = speakerOf(item);
    row.classList.add(who.mine ? "row-mine" : "row-theirs");
    row.dataset.speaker = who.key;
    paint(row, who.key);
    const column = make("div", "column");
    const name = make("div", "name");
    name.append(make("span", "", who.name), make("span", "time", time(item.at)));
    if (item.data?.model) {
      const model = make("span", "time model-tag", `· ${item.data.model}`);
      model.title = [item.data.provider, item.data.model].filter(Boolean).join("/");
      name.append(model);
    }
    const bubble = make("div", "bubble");
    if (item.text) bubble.append(bubbleText(item.text));
    for (const file of item.files || []) bubble.append(fileView(file));
    column.append(name, bubble);
    row.append(avatar(who.name, who.key), column);
    return row;
  }

  function append(item) {
    if (item.id <= state.lastId) return;
    $("#empty").hidden = true;
    const stick = nearBottom();
    const row = renderItem(item);
    const previous = messages.lastElementChild;
    if (previous?.dataset.speaker && previous.dataset.speaker === row.dataset.speaker && item.at - Number(previous.dataset.at || 0) < 180) {
      row.classList.add("is-followup");
    }
    row.dataset.at = item.at;
    messages.append(row);
    state.lastId = Math.max(state.lastId, item.id);
    if (stick || item.kind === "user") scrollDown();
  }

  async function open(conversation) {
    if (conversation !== state.current) {
      state.drafts.set(state.current, input.value);
      input.value = state.drafts.get(conversation) || "";
      grow();
      closePalette();
    }
    state.current = conversation;
    localStorage.setItem("hub.chat", conversation);
    state.unread.delete(conversation);
    state.lastId = 0;
    messages.querySelectorAll(".row").forEach((row) => row.remove());
    $("#empty").hidden = false;
    renderChats();
    renderMembers();
    renderTyping();
    await loadHistory();
    if (!touch) input.focus();
  }
  async function loadHistory() {
    const conversation = state.current;
    try {
      const response = await fetch(`api/history?conversation=${encodeURIComponent(conversation)}&after=${state.lastId}`);
      if (response.status === 401) { location.href = "login"; return; }
      if (!response.ok) return;
      const { messages: items } = await response.json();
      if (conversation !== state.current) return;
      items.forEach((item) => append(item));
      scrollDown();
    } catch { /* the next reconnect loads it */ }
  }

  // ---- replies as they are written ---------------------------------------------------------------------
  function renderTyping() {
    const area = $("#typing");
    const stick = nearBottom();
    area.replaceChildren();
    for (const run of state.progress.values()) {
      if (run.conversation !== state.current) continue;
      const row = paint(make("div", "row row-theirs live"), keyOf(run.speaker));
      const column = make("div", "column");
      const name = make("div", "name");
      name.append(make("span", "", run.speaker), make("span", "time live-activity", run.activity || "writing…"));
      const stop = make("button", "live-stop", "Stop");
      stop.type = "button";
      stop.onclick = () => transmit({ type: "cancel", conversation: run.conversation, run_id: run.run_id });
      name.append(stop);
      const bubble = make("div", "bubble");
      if (run.text) bubble.append(bubbleText(run.text));
      else bubble.append(make("span", "dots"));
      column.append(name, bubble);
      row.append(avatar(run.speaker), column);
      area.append(row);
    }
    renderMembers();
    if (stick) scrollDown();
  }

  // ---- connection ------------------------------------------------------------------------------------
  function connect() {
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.onopen = () => { state.retry = 0; setConnection(""); };
    ws.onmessage = (message) => receive(JSON.parse(message.data));
    ws.onclose = async (event) => {
      if (event.code === 4401) { location.href = "login"; return; }
      setConnection("Reconnecting…");
      // A refused upgrade can't say why: ask whether we are still signed in.
      try { if ((await fetch("api/me")).status === 401) { location.href = "login"; return; } } catch { /* offline */ }
      setTimeout(connect, Math.min(10000, 500 * 2 ** state.retry++));
    };
  }
  function setConnection(text) {
    $("#connection").textContent = text;
    $("#connection").classList.toggle("is-off", Boolean(text));
  }

  function receive(event) {
    if (event.type === "hello") {
      const s = event.state;
      Object.assign(state, { title: s.title, user: s.user, bots: s.bots, conversations: s.conversations, nodes: s.nodes,
                             maxUploadMB: s.maxUploadMB });
      state.progress = new Map(s.progress.map((run) => [run.run_id, run]));
      $("#user-name").textContent = s.user.name;
      for (const pending of state.pending.splice(0)) state.ws.send(JSON.stringify(pending));
      if (!state.conversations.some((chat) => chat.id === state.current)) { open(s.default); return; }
      renderChats();
      renderMembers();
      renderTyping();
      loadHistory();
    } else if (event.type === "message") {
      const item = event.item;
      const chat = chatOf(item.conversation);
      if (chat && ["text", "user"].includes(item.kind) && item.text) {
        chat.last = { kind: item.kind, speaker: item.speaker || "", text: String(item.text).split(/\s+/).join(" ").slice(0, 120) };
      }
      if (item.conversation === state.current) { append(item); renderChats(); }
      else { state.unread.add(item.conversation); renderChats(); }
    } else if (event.type === "update") {
      const old = messages.querySelector(`.row[data-id="${event.item.id}"]`);
      if (old) {
        const output = old.querySelector(".job-output");
        const following = !output || output.scrollHeight - output.scrollTop - output.clientHeight < 30;
        const row = renderItem(event.item);
        row.className = old.className;
        row.dataset.at = old.dataset.at;
        old.replaceWith(row);
        if (!following) { const fresh = row.querySelector(".job-output"); if (fresh) requestAnimationFrame(() => { fresh.scrollTop = output.scrollTop; }); }
      }
    } else if (event.type === "deleted") {
      state.conversations = event.items;
      state.unread.delete(event.conversation);
      if (event.conversation === state.current) open(state.conversations[0]?.id || "");
      else renderChats();
    } else if (event.type === "conversations") {
      state.conversations = event.items;
      renderChats();
    } else if (event.type === "nodes") {
      state.nodes = event.nodes;
      renderComputers();
      window.hubSettings?.refresh();
    } else if (event.type === "bots") {
      state.bots = event.bots;
      window.hubSettings?.refresh();
      renderMembers();
      renderChats();
    } else if (event.type === "progress") {
      state.progress.set(event.run_id, event);
      renderTyping();
    } else if (event.type === "progress_clear") {
      state.progress.delete(event.run_id);
      renderTyping();
    } else if (event.type === "error") {
      toast(event.text);
    } else if (event.type === "ack" && !event.ok) {
      toast(event.reason === "unknown_chat" ? "That chat isn't there any more, so this wasn't sent." : `Not sent (${event.reason}).`);
    }
  }

  function transmit(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
    else state.pending.push(payload);
  }
  function send(text, files = []) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, "");
    transmit({ type: "send", conversation: state.current, id, text, files });
  }
  function toast(text) {
    const node = make("div", "toast", text);
    document.body.append(node);
    setTimeout(() => node.remove(), 3500);
  }
  window.hubToast = toast;

  // ---- composer --------------------------------------------------------------------------------------
  function mention(name) {
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@\S*$/, "");
    const spacer = before && !/\s$/.test(before) ? " " : "";
    input.value = `${before}${spacer}@${name} ${text.slice(caret).replace(/^\s+/, "")}`;
    const end = before.length + spacer.length + name.length + 2;
    input.focus();
    input.setSelectionRange(end, end);
    grow();
  }
  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }
  function submit() {
    const text = input.value;
    const files = state.files.filter((file) => file.id).map((file) => file.id);
    if (state.files.some((file) => !file.id)) { toast("Still uploading…"); return; }
    if (!text.trim() && !files.length) return;
    send(text, files);
    input.value = "";
    state.files = [];
    renderAttachments();
    closePalette();
    grow();
  }
  function suggestions() {
    const at = /(?:^|\s)@(\S*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
    if (!at) return [];
    const word = at[1].toLowerCase();
    const members = botsOf(chatOf(state.current));
    if (members.length < 2) return [];
    return members.filter((bot) => bot.display.toLowerCase().startsWith(word)).map((bot) => bot.display);
  }
  function renderPalette() {
    const palette = $("#palette");
    const matches = suggestions();
    palette.replaceChildren();
    if (!matches.length) { palette.hidden = true; return; }
    state.paletteIndex = Math.min(state.paletteIndex, matches.length - 1);
    matches.forEach((name, index) => {
      const option = make("div", "option option-person" + (index === state.paletteIndex ? " is-active" : ""));
      option.setAttribute("role", "option");
      option.append(avatar(name), make("span", "option-name", name), make("span", "option-description", "ask them"));
      option.onmousedown = (event) => { event.preventDefault(); closePalette(); mention(name); };
      palette.append(option);
    });
    palette.hidden = false;
  }
  function closePalette() { $("#palette").hidden = true; state.paletteIndex = 0; }
  input.addEventListener("input", () => { grow(); state.paletteIndex = 0; renderPalette(); });
  input.addEventListener("click", renderPalette);
  input.addEventListener("keydown", (event) => {
    const matches = $("#palette").hidden ? [] : suggestions();
    if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      state.paletteIndex = (state.paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      renderPalette();
    } else if (matches.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      closePalette();
      mention(matches[state.paletteIndex]);
    } else if (event.key === "Escape") {
      closePalette();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !touch) {
      event.preventDefault();
      submit();
    }
  });
  $("#composer").addEventListener("submit", (event) => { event.preventDefault(); submit(); });

  // ---- attachments: each file is sent as it is, so big videos go straight to the hub's disk ------------
  function renderAttachments() {
    const area = $("#attachments");
    area.replaceChildren();
    for (const file of state.files) {
      const chip = make("span", "chip" + (file.id ? "" : " is-uploading"),
        file.id ? file.name : `${file.name} ${file.percent ? `${file.percent}%` : "…"}`);
      const remove = make("button", "chip-remove", "×");
      remove.type = "button";
      remove.onclick = () => { file.request?.abort(); state.files = state.files.filter((item) => item !== file); renderAttachments(); };
      chip.append(remove);
      area.append(chip);
    }
  }
  function upload(list) {
    for (const file of list) {
      const entry = { name: file.name || "pasted.png", id: null, percent: 0 };
      if (file.size > state.maxUploadMB * 1048576) { toast(`${entry.name} is over ${state.maxUploadMB} MB.`); continue; }
      state.files.push(entry);
      renderAttachments();
      const request = new XMLHttpRequest();
      entry.request = request;
      request.open("POST", `api/upload?name=${encodeURIComponent(entry.name)}`);
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        entry.percent = Math.floor(event.loaded / event.total * 100);
        renderAttachments();
      };
      request.onload = () => {
        if (request.status === 200) Object.assign(entry, JSON.parse(request.responseText).file, { request: null });
        else {
          state.files = state.files.filter((item) => item !== entry);
          let why = String(request.status);
          try { why = JSON.parse(request.responseText).error || why; } catch { /* not JSON */ }
          toast(`Could not attach ${entry.name}: ${why}`);
        }
        renderAttachments();
      };
      request.onerror = () => { state.files = state.files.filter((item) => item !== entry); toast(`Could not attach ${entry.name}.`); renderAttachments(); };
      request.send(file);
    }
  }
  $("#file-input").addEventListener("change", (event) => { upload([...event.target.files]); event.target.value = ""; });
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); upload(files); }
  });
  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (event) => { if (carriesFiles(event)) { event.preventDefault(); document.body.classList.add("is-dragging"); } });
  document.addEventListener("dragleave", (event) => { if (!event.relatedTarget) document.body.classList.remove("is-dragging"); });
  document.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    document.body.classList.remove("is-dragging");
    if (event.dataTransfer?.files?.length) upload([...event.dataTransfer.files]);
  });

  // ---- the rest --------------------------------------------------------------------------------------
  function view(url) { const viewer = $("#viewer"); viewer.querySelector("img").src = url; viewer.hidden = false; }
  $("#viewer").onclick = () => { $("#viewer").hidden = true; };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    $("#viewer").hidden = true;
    hidePicker();
    hideMenu();
    closePanels();
  });
  document.addEventListener("click", (event) => {
    if (!$("#chat-menu").hidden && !event.target.closest("#chat-menu, .chat-more")) hideMenu();
  });
  messages.addEventListener("click", (event) => {
    const button = event.target.closest(".copy");
    if (!button) return;
    const code = button.closest("pre").querySelector("code").textContent;
    const done = () => { button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(code).then(done);
    else {
      const area = make("textarea");
      area.value = code;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      done();
    }
  });

  // ---- new chats: pick who is in it ------------------------------------------------------------------
  function startChat(names) {
    if (names.length === 1 && state.bots.length > 1) {
      const existing = state.conversations.find((chat) => chat.bots?.length === 1 && chat.bots[0] === names[0]);
      if (existing) { open(existing.id); return; }
    }
    const everyone = names.length === state.bots.length;
    const id = `chat-${Date.now().toString(36)}`;
    const title = names.length === 1 && state.bots.length > 1 ? state.bots.find((bot) => bot.name === names[0])?.display : "New chat";
    state.conversations.unshift({ id, title, bots: everyone ? null : names, pinned: false, last: null });
    transmit({ type: "new", conversation: id, title, ...(everyone ? {} : { bots: names }) });
    open(id);
  }
  function showPicker() {
    if (state.bots.length < 2) { startChat(state.bots.map((bot) => bot.name)); return; }
    const list = $("#picker-list");
    list.replaceChildren();
    for (const bot of state.bots) {
      const option = paint(make("label", "picker-option"), keyOf(bot.display));
      const box = make("input");
      box.type = "checkbox";
      box.value = bot.name;
      box.checked = true;
      box.onchange = pickerChanged;
      option.append(box, avatar(bot.display), make("span", "picker-name", bot.display));
      if (bot.home) option.append(make("span", "picker-home", `on ${bot.home}`));
      list.append(option);
    }
    pickerChanged();
    $("#picker").hidden = false;
    $("#picker-start").focus();
  }
  const picked = () => [...document.querySelectorAll("#picker-list input:checked")].map((box) => box.value);
  function pickerChanged() {
    const chosen = picked();
    $("#picker-start").disabled = !chosen.length;
    $("#picker-start").textContent = !chosen.length ? "Pick someone" : chosen.length === 1
      ? `Message ${state.bots.find((bot) => bot.name === chosen[0])?.display}` : chosen.length === state.bots.length
        ? "Start with everyone" : `Start with ${chosen.length}`;
  }
  const hidePicker = () => { $("#picker").hidden = true; };
  $("#picker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = picked();
    if (!chosen.length) return;
    hidePicker();
    startChat(chosen);
    if (level() === "narrow") setPanel("sidebar", false);
  });
  $("#picker-cancel").onclick = hidePicker;
  $("#picker").addEventListener("click", (event) => { if (event.target.id === "picker") hidePicker(); });
  $("#new-chat").onclick = showPicker;
  $("#chat-title").onclick = () => { const chat = chatOf(state.current); if (chat) rename(chat); };
  $("#chat-search").addEventListener("input", (event) => { state.search = event.target.value; renderChats(); });
  $("#toggle-sidebar").onclick = () => setPanel("sidebar", !isOpen("sidebar"));
  $("#close-sidebar").onclick = () => setPanel("sidebar", false);
  $("#toggle-members").onclick = () => setPanel("members", !isOpen("members"));
  $("#close-members").onclick = () => setPanel("members", false);
  $("#scrim").onclick = closePanels;
  $("#user-tab").onclick = () => window.hubSettings?.open("account");
  $("#add-computer").onclick = () => window.hubSettings?.open("computers", { add: true });
  for (const query of Object.values(media)) query.addEventListener("change", (event) => event.matches && applyLevel());
  window.addEventListener("resize", fitWidths);
  resizable($("#resize-sidebar"), "sidebar");
  resizable($("#resize-members"), "members");
  applyLevel();

  // ---- the phone keyboard (as on Chimera's page) -----------------------------------------------------
  let pinned = true;
  messages.addEventListener("scroll", () => { pinned = nearBottom(); }, { passive: true });
  function fitViewport() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const stick = pinned;
    const root = document.documentElement.style;
    root.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    root.setProperty("--app-top", `${Math.round(viewport.offsetTop)}px`);
    document.body.classList.toggle("keyboard-open", touch && document.activeElement === input);
    if (stick) scrollDown();
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitViewport);
    window.visualViewport.addEventListener("scroll", fitViewport);
  }
  window.addEventListener("resize", fitViewport);
  input.addEventListener("focus", () => setTimeout(fitViewport, 50));
  input.addEventListener("blur", () => setTimeout(fitViewport, 50));
  if (touch) {
    input.setAttribute("enterkeyhint", "enter");
    $("#send").addEventListener("pointerdown", (event) => { if (document.activeElement === input) event.preventDefault(); });
  }
  fitViewport();
  renderChats();
  connect();
})();
