/* Contactpersoon in het verkooporderformulier (Eigen aanpassing):
 * onder het veld de contactpersonen die eerder bij deze klant zijn gebruikt (één klik om te kiezen)
 * en een knop om direct een nieuwe contactpersoon aan de keuzelijst toe te voegen.
 */
(function () {
  "use strict";
  const script = document.getElementById("contactpersoon-formulier-script");
  const formulier = document.getElementById("v-model-form");
  if (!script || !formulier || !window.app) return;
  const app = window.app;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return e;
  }

  let info = null;      // {veld, veldKey, meerdere, klant[], alle[]}
  let invoer = false;   // invoerveld voor een nieuwe naam open?
  let fout = "";
  const vak = el("div", { class: "cpf" });

  async function post(body) {
    const r = await fetch(script.dataset.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
    return r.json();
  }
  const klantKey = () => (app.Customer && app.Customer.Key) || null;
  async function laad() {
    try { info = await post(klantKey() ? { actie: "klant", klant: klantKey() } : { actie: "klant", klant: "00000000-0000-0000-0000-000000000000" }); }
    catch (e) { info = null; }
    plaats();
  }

  // Huidige waarde(n) van het veld in de order
  function gekozen() {
    const cf = app.CustomFields2 || {};
    if (info.meerdere) return ((cf.StringArrays || {})[info.veldKey] || []).slice();
    const s = (cf.Strings || {})[info.veldKey];
    return s ? [s] : [];
  }
  function kies(naam) {
    if (!app.CustomFields2) app.CustomFields2 = {};
    const cf = app.CustomFields2;
    if (info.meerdere) {
      if (!cf.StringArrays) app.$set(cf, "StringArrays", {});
      const arr = cf.StringArrays[info.veldKey];
      if (!Array.isArray(arr)) app.$set(cf.StringArrays, info.veldKey, [naam]);
      else if (!arr.includes(naam)) arr.push(naam);
    } else {
      if (!cf.Strings) app.$set(cf, "Strings", {});
      app.$set(cf.Strings, info.veldKey, naam);
    }
    teken();
  }

  function veldGroep() {
    for (const g of formulier.querySelectorAll(".form-group")) {
      const label = g.querySelector("label");
      if (label && label.textContent.trim() === info.veld) return g;
    }
    return null;
  }
  function plaats() {
    if (!info) { vak.remove(); return; }
    const g = veldGroep();
    if (!g) return;
    if (vak.parentNode !== g) g.appendChild(vak);
    teken();
  }

  function teken() {
    if (!info) return;
    const nu = gekozen().map((x) => x.toLowerCase());
    const voorstel = info.klant.filter((n) => !nu.includes(n.toLowerCase()));
    const naamInvoer = el("input", { class: "cpf-invoer", placeholder: "Naam nieuwe contactpersoon", maxlength: "80" });
    const toevoegen = async () => {
      const naam = naamInvoer.value.trim();
      if (!naam) return;
      fout = "";
      try {
        const bestaand = info.alle.find((x) => x.toLowerCase() === naam.toLowerCase());
        if (!bestaand) { const r = await post({ actie: "toevoegen", naam }); info.alle = r.namen.filter((n) => n.inLijst).map((n) => n.naam); }
        kies(bestaand || naam);
        invoer = false;
      } catch (e) { fout = e.message; }
      teken();
    };
    naamInvoer.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); toevoegen(); } if (e.key === "Escape") { invoer = false; teken(); } });

    vak.replaceChildren(...[
      voorstel.length ? el("div", { class: "cpf-rij" }, el("span", { class: "cpf-zacht" }, "Eerder bij deze klant:"),
        voorstel.slice(0, 8).map((n) => el("button", { type: "button", class: "cpf-chip", title: "Kiezen", onclick: () => kies(n) }, "+ " + n))) : null,
      invoer
        ? el("div", { class: "cpf-rij" }, naamInvoer,
          el("button", { type: "button", class: "cpf-knop cpf-primair", onclick: toevoegen }, "Toevoegen"),
          el("button", { type: "button", class: "cpf-knop", onclick: () => { invoer = false; fout = ""; teken(); } }, "Annuleren"))
        : el("div", { class: "cpf-rij" },
          el("button", { type: "button", class: "cpf-link", onclick: () => { invoer = true; teken(); setTimeout(() => naamInvoer.focus(), 0); } }, "+ nieuwe contactpersoon"),
          el("a", { class: "cpf-link", href: script.dataset.beheer, target: "_blank" }, "beheren")),
      fout ? el("div", { class: "cpf-fout" }, fout) : null].filter(Boolean));
  }

  // Opnieuw plaatsen als Vue het formulier opnieuw opbouwt; voorstellen bijwerken bij een andere klant
  new MutationObserver(() => { if (info && !vak.isConnected) plaats(); }).observe(formulier, { childList: true, subtree: true });
  app.$watch(() => klantKey(), laad);
  app.$watch(() => JSON.stringify(app.CustomFields2 && (app.CustomFields2.StringArrays || app.CustomFields2.Strings)), () => { if (info) teken(); });

  const stijl = document.createElement("style");
  stijl.textContent = `
    .cpf { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.375rem; font-size: 0.8125rem; }
    .cpf-rij { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
    .cpf-zacht { color: #737373; }
    .cpf-chip { border: 1px solid #bfdbfe; background: #eff6ff; color: #1e40af; border-radius: 999px; padding: 0 0.625rem; cursor: pointer; }
    .cpf-chip:hover { background: #dbeafe; }
    .cpf-link { background: none; border: 0; padding: 0; color: #2563eb; cursor: pointer; }
    .cpf-link:hover { text-decoration: underline; }
    .cpf-invoer { border: 1px solid #d4d4d4; border-radius: 0.375rem; padding: 0.2rem 0.5rem; font: inherit; min-width: 14rem; }
    .cpf-knop { border: 1px solid #d4d4d4; border-radius: 0.375rem; padding: 0.2rem 0.625rem; background: #fff; cursor: pointer; }
    .cpf-primair { background: #2563eb; border-color: #2563eb; color: #fff; }
    .cpf-fout { color: #b91c1c; }`;
  document.head.appendChild(stijl);

  laad();
})();
