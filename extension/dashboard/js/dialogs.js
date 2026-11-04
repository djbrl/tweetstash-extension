// A real dialog for anything destructive or costly. Resolves true only on the confirm button;
// Escape, Cancel or a click on the backdrop all count as "no".
import { $ } from "./util.js";

export function confirmDialog({ title, body, ok, danger = false }) {
  const d = $("#confirm-dlg");
  $("#dlg-title").textContent = title;
  $("#dlg-body").innerHTML = body;
  $("#dlg-ok").textContent = ok;
  $("#dlg-ok").className = "btn " + (danger ? "danger" : "primary");
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => {
    d.onclick = (e) => { if (e.target === d) d.close("cancel"); }; // backdrop
    d.onclose = () => resolve(d.returnValue === "ok");
  });
}
