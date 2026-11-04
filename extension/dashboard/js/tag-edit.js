// Adding and removing tags by hand on a card. Hand-made tags survive re-tagging.
import { $, esc, toast, api } from "./util.js";
import { state } from "./state.js";
import { tagRow } from "./cards.js";

export async function saveTags(cardEl, tags) {
  const b = cardEl._data;
  b.tags = [...new Set(tags)].sort();
  cardEl.querySelector(".card-tags").innerHTML = tagRow(b.tags);
  try {
    await api("/api/tags", { id: b.id, tags: b.tags });
  } catch (e) {
    toast("Couldn't save tags: " + e.message);
  }
}

export const removeTag = (cardEl, tag) => saveTags(cardEl, cardEl._data.tags.filter((x) => x !== tag));

// Swaps the "+ tag" button for an input with suggestions from existing tags.
export function openTagInput(cardEl, btn) {
  const input = document.createElement("input");
  input.className = "tag-input";
  input.placeholder = "new tag";
  input.setAttribute("list", "tag-suggest");
  btn.replaceWith(input);
  input.focus();
  let dl = $("#tag-suggest");
  if (!dl) { dl = document.createElement("datalist"); dl.id = "tag-suggest"; document.body.appendChild(dl); }
  dl.innerHTML = state.stats.tags.slice(0, 200).map((t) => `<option value="${esc(t.name)}">`).join("");
  const commit = () => {
    const v = input.value.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    saveTags(cardEl, v ? [...cardEl._data.tags, v] : cardEl._data.tags);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { input.value = ""; commit(); }
  });
  input.addEventListener("blur", commit, { once: true });
}
