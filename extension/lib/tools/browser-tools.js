// MCP-style browser tools, executed in the service worker.
// Each tool has a JSON-Schema-ish input schema (provider-agnostic) plus an
// `execute(args)` that returns a serializable result.

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

async function getTabById(tabId) {
  if (tabId == null) return activeTab();
  return chrome.tabs.get(tabId);
}

async function execInTab(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result;
}

function truncate(str, max = 20000) {
  if (typeof str !== "string") return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n\n[truncated ${str.length - max} chars]`;
}

// ---------- in-page helpers (run inside the tab via executeScript) ----------

function _readability() {
  const clone = document.cloneNode(true);
  for (const sel of ["script", "style", "noscript", "iframe", "svg"]) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }
  const text = (clone.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: location.href,
    title: document.title,
    text,
    html_length: document.documentElement.outerHTML.length
  };
}

function _querySnapshot(selector, limit) {
  const nodes = Array.from(document.querySelectorAll(selector || "body")).slice(
    0,
    limit || 50
  );
  return nodes.map((n, i) => ({
    index: i,
    tag: n.tagName.toLowerCase(),
    id: n.id || null,
    classes: n.className?.toString?.() || "",
    text: (n.innerText || "").slice(0, 500),
    role: n.getAttribute("role"),
    href: n.getAttribute("href") || null,
    name: n.getAttribute("name") || null,
    type: n.getAttribute("type") || null,
    placeholder: n.getAttribute("placeholder") || null
  }));
}

function _click(selector, index) {
  const els = document.querySelectorAll(selector);
  const el = els[index || 0];
  if (!el) throw new Error(`No element matched ${selector}[${index || 0}]`);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.click();
  return { clicked: el.tagName.toLowerCase(), text: (el.innerText || "").slice(0, 200) };
}

function _type(selector, text, submit) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`No element matched ${selector}`);
  el.focus();
  if ("value" in el) {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;
    setter ? setter.call(el, text) : (el.value = text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.textContent = text;
  }
  if (submit) {
    const form = el.closest("form");
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  return { ok: true };
}

function _scroll(direction, amount) {
  const dy = (direction === "up" ? -1 : 1) * (amount || window.innerHeight * 0.8);
  window.scrollBy({ top: dy, behavior: "instant" });
  return { scrollY: window.scrollY };
}

function _eval(expr) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expr});`);
  const result = fn();
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}

// ---------- tool registry ----------

export const browserTools = {
  browser_get_page: {
    description:
      "Read the current (or specified) tab: URL, title, and visible text. Use this before acting on a page.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "number", description: "Optional tab id, defaults to active." },
        max_chars: { type: "number", description: "Cap on text length (default 20000)." }
      }
    },
    async execute({ tab_id, max_chars } = {}) {
      const tab = await getTabById(tab_id);
      const data = await execInTab(tab.id, _readability);
      return { ...data, text: truncate(data.text, max_chars || 20000), tab_id: tab.id };
    }
  },

  browser_navigate: {
    description: "Navigate the active (or given) tab to a URL.",
    input_schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        tab_id: { type: "number" },
        new_tab: { type: "boolean", description: "Open in a new tab instead." }
      }
    },
    async execute({ url, tab_id, new_tab }) {
      if (new_tab) {
        const t = await chrome.tabs.create({ url });
        return { tab_id: t.id, url };
      }
      const tab = await getTabById(tab_id);
      await chrome.tabs.update(tab.id, { url });
      return { tab_id: tab.id, url };
    }
  },

  browser_query: {
    description:
      "Query DOM elements by CSS selector. Returns a structured snapshot (tag, text, id, classes, href, name, etc.) for up to N matches.",
    input_schema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string" },
        limit: { type: "number", default: 30 },
        tab_id: { type: "number" }
      }
    },
    async execute({ selector, limit = 30, tab_id }) {
      const tab = await getTabById(tab_id);
      return execInTab(tab.id, _querySnapshot, [selector, limit]);
    }
  },

  browser_click: {
    description: "Click the first element matching a CSS selector (or the Nth match).",
    input_schema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string" },
        index: { type: "number", default: 0 },
        tab_id: { type: "number" }
      }
    },
    async execute({ selector, index = 0, tab_id }) {
      const tab = await getTabById(tab_id);
      return execInTab(tab.id, _click, [selector, index]);
    }
  },

  browser_type: {
    description:
      "Focus an input/textarea matched by selector and set its value. Optionally submit the form.",
    input_schema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", default: false },
        tab_id: { type: "number" }
      }
    },
    async execute({ selector, text, submit = false, tab_id }) {
      const tab = await getTabById(tab_id);
      return execInTab(tab.id, _type, [selector, text, submit]);
    }
  },

  browser_scroll: {
    description: "Scroll the page up or down by an amount in pixels (default ~viewport).",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], default: "down" },
        amount: { type: "number" },
        tab_id: { type: "number" }
      }
    },
    async execute({ direction = "down", amount, tab_id } = {}) {
      const tab = await getTabById(tab_id);
      return execInTab(tab.id, _scroll, [direction, amount]);
    }
  },

  browser_screenshot: {
    description:
      "Capture the visible viewport of the active tab as a PNG data URL. Returned to the model as an image.",
    input_schema: { type: "object", properties: {} },
    async execute() {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
      return { image: dataUrl };
    }
  },

  browser_eval: {
    description:
      "Evaluate a JavaScript expression in the page and return its JSON-serialized result. Power-user tool.",
    input_schema: {
      type: "object",
      required: ["expression"],
      properties: {
        expression: { type: "string" },
        tab_id: { type: "number" }
      }
    },
    async execute({ expression, tab_id }) {
      const tab = await getTabById(tab_id);
      return execInTab(tab.id, _eval, [expression]);
    }
  },

  tabs_list: {
    description: "List all open tabs with id, title, url, and active state.",
    input_schema: { type: "object", properties: {} },
    async execute() {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId
      }));
    }
  },

  tabs_switch: {
    description: "Activate a tab by id.",
    input_schema: {
      type: "object",
      required: ["tab_id"],
      properties: { tab_id: { type: "number" } }
    },
    async execute({ tab_id }) {
      await chrome.tabs.update(tab_id, { active: true });
      const tab = await chrome.tabs.get(tab_id);
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, tab_id };
    }
  },

  tabs_close: {
    description: "Close one or more tabs by id.",
    input_schema: {
      type: "object",
      required: ["tab_ids"],
      properties: { tab_ids: { type: "array", items: { type: "number" } } }
    },
    async execute({ tab_ids }) {
      await chrome.tabs.remove(tab_ids);
      return { closed: tab_ids };
    }
  },

  tabs_new: {
    description: "Open a new tab, optionally at a URL.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, active: { type: "boolean", default: true } }
    },
    async execute({ url, active = true } = {}) {
      const t = await chrome.tabs.create({ url, active });
      return { tab_id: t.id, url: t.url };
    }
  },

  tabs_history_back: {
    description: "Go back in the active tab's history.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "number" } }
    },
    async execute({ tab_id } = {}) {
      const tab = await getTabById(tab_id);
      await chrome.tabs.goBack(tab.id);
      return { ok: true };
    }
  },

  tabs_history_forward: {
    description: "Go forward in the active tab's history.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "number" } }
    },
    async execute({ tab_id } = {}) {
      const tab = await getTabById(tab_id);
      await chrome.tabs.goForward(tab.id);
      return { ok: true };
    }
  },

  tabs_reload: {
    description: "Reload a tab.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "number" } }
    },
    async execute({ tab_id } = {}) {
      const tab = await getTabById(tab_id);
      await chrome.tabs.reload(tab.id);
      return { ok: true };
    }
  },

  downloads_start: {
    description: "Download a URL to disk via the Chrome downloads API.",
    input_schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        filename: { type: "string" }
      }
    },
    async execute({ url, filename }) {
      const id = await chrome.downloads.download({ url, filename });
      return { download_id: id };
    }
  },

  cookies_get: {
    description: "Read cookies for a URL.",
    input_schema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" } }
    },
    async execute({ url }) {
      const cookies = await chrome.cookies.getAll({ url });
      return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate
      }));
    }
  }
};

// Filter the registry by the user's enabled-tools settings.
export function getEnabledTools(enabledTools) {
  const out = {};
  for (const [name, tool] of Object.entries(browserTools)) {
    if (name.startsWith("browser_") && !enabledTools.browser) continue;
    if (name.startsWith("tabs_") && !enabledTools.tabs) continue;
    if (name === "browser_screenshot" && !enabledTools.screenshot) continue;
    if (name.startsWith("downloads_") && !enabledTools.downloads) continue;
    if (name.startsWith("cookies_") && !enabledTools.cookies) continue;
    out[name] = tool;
  }
  return out;
}
