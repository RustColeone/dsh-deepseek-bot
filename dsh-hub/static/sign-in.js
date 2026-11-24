"use strict";
// The sign-in and setup forms: sent as JSON (the API takes nothing else), then on to the chat page.
(() => {
  const form = document.getElementById("sign-in");
  const error = document.getElementById("error");
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1|\[?f[cd]|[^.]+$|.*\.(local|lan|home|home\.arpa|internal|ts\.net)$)/i;
  if (location.protocol !== "https:" && !local.test(location.hostname)) document.getElementById("insecure").hidden = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if ("again" in values) {
      if (values.again !== values.password) { error.textContent = "The two passwords differ."; return; }
      delete values.again;
    }
    const button = form.querySelector("button");
    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch(form.dataset.api, { method: "POST", headers: { "Content-Type": "application/json" },
                                                      body: JSON.stringify(values) });
      const answer = await response.json().catch(() => ({}));
      if (response.ok) { location.href = "./"; return; }
      error.textContent = answer.error || `Refused (${response.status}).`;
    } catch {
      error.textContent = "The hub can't be reached.";
    } finally {
      button.disabled = false;
    }
  });
})();
