/* Contactpersonen beheren (Eigen aanpassing). Zie Contactpersonen.cs. */
(function () {
  "use strict";
  const script = document.getElementById("contactpersonen-script");
  const root = document.getElementById("cp-app");
  if (!script || !root) return;

  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "disabled") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  const datumNl = (d) => (d ? d.split("-").reverse().join("-") : "");

  let data = null, melding = null, zoek = "", bezig = false, sortering = "naam";

  async function post(body) {
    bezig = true;
    try {
      const r = await fetch(script.dataset.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
      data = await r.json();
      if (data.resultaat) melding = { soort: "ok", tekst: data.resultaat };
    } catch (e) { melding = { soort: "fout", tekst: e.message }; }
    bezig = false;
    teken();
  }

  function teken() {
    if (!data) { vervang(root, melding ? el("div", { class: "os-melding os-fout" }, melding.tekst) : el("p", { class: "os-zacht" }, "Laden…")); return; }
    const z = zoek.trim().toLowerCase();
    let namen = data.namen.filter((n) => !z || n.naam.toLowerCase().includes(z) || n.klanten.some((k) => k.toLowerCase().includes(z)));
    const cmp = (a, b) => a.localeCompare(b, "nl", { sensitivity: "base" });
    if (sortering === "gebruik") namen = namen.slice().sort((a, b) => b.gebruik - a.gebruik || cmp(a.naam, b.naam));
    else if (sortering === "laatst") namen = namen.slice().sort((a, b) => String(b.laatst || "").localeCompare(String(a.laatst || "")) || cmp(a.naam, b.naam));
    else namen = namen.slice().sort((a, b) => cmp(a.naam, b.naam));

    const nieuw = el("input", { class: "os-invoer", placeholder: "Naam nieuwe contactpersoon", maxlength: "80", onkeydown: (e) => { if (e.key === "Enter") voegToe(); } });
    const voegToe = () => {
      const naam = nieuw.value.trim();
      if (!naam) return;
      if (data.namen.some((n) => n.inLijst && n.naam.toLowerCase() === naam.toLowerCase())) { melding = { soort: "fout", tekst: `"${naam}" staat al in de lijst.` }; teken(); return; }
      post({ actie: "toevoegen", naam });
    };
    const kop = (k, t) => el("th", { class: "os-sorteer" + (k === "gebruik" ? " os-num" : ""), onclick: () => { sortering = k; teken(); } }, t, sortering === k ? " ▼" : "");

    vervang(root,
      melding ? el("div", { class: "os-melding os-" + melding.soort }, melding.tekst, el("button", { type: "button", class: "os-sluit", onclick: () => { melding = null; teken(); } }, "×")) : null,
      el("div", { class: "os-balk" },
        nieuw, el("button", { type: "button", class: "os-knop os-primair", disabled: bezig, onclick: voegToe }, "Toevoegen"),
        el("span", { class: "os-ruimte" }),
        el("input", { class: "os-invoer", type: "search", placeholder: "Zoeken op naam of klant", value: zoek, oninput: (e) => { zoek = e.target.value; tekenTabel(); } }),
        data.gesorteerd ? null : el("button", { type: "button", class: "os-knop", title: "De keuzelijst in Manager alfabetisch zetten", onclick: () => post({ actie: "sorteren" }) }, "Lijst sorteren")),
      el("p", { class: "os-zacht os-klein" }, `Keuzemogelijkheden van het veld "${data.veld}" (${data.namen.filter((n) => n.inLijst).length}). Nieuwe namen worden alfabetisch ingevoegd. Hernoemen past de naam ook aan in alle orders, offertes en facturen waar hij gekozen is; hernoem je naar een bestaande naam, dan worden ze samengevoegd.`),
      el("div", { id: "cp-tabel" }));
    tekenTabel();

    function tekenTabel() {
      const vak = document.getElementById("cp-tabel");
      const z2 = zoek.trim().toLowerCase();
      const lijst = namen.filter((n) => !z2 || n.naam.toLowerCase().includes(z2) || n.klanten.some((k) => k.toLowerCase().includes(z2)));
      vervang(vak, el("table", { class: "os-tabel" },
        el("thead", {}, el("tr", {}, kop("naam", "Naam"), kop("gebruik", "Gebruikt"), kop("laatst", "Laatst"), el("th", {}, "Klanten"), el("th"))),
        el("tbody", {}, lijst.length ? lijst.map((n) => el("tr", { class: n.inLijst ? null : "os-uit" },
          el("td", {}, n.naam, n.inLijst ? null : el("span", { class: "os-rood os-klein", title: "Wel gekozen in documenten, maar niet (meer) in de keuzelijst" }, " (niet in lijst)")),
          el("td", { class: "os-num" }, n.gebruik ? String(n.gebruik) : "–"),
          el("td", { class: "os-nowrap" }, datumNl(n.laatst)),
          el("td", { class: "os-klein" }, n.klanten.join(", ")),
          el("td", { class: "os-nowrap" },
            el("button", { type: "button", class: "os-knop", disabled: bezig, onclick: () => {
              const nieuweNaam = prompt(`Nieuwe naam voor "${n.naam}" (een bestaande naam voegt ze samen):`, n.naam);
              if (nieuweNaam && nieuweNaam.trim() && nieuweNaam.trim() !== n.naam) post({ actie: "hernoemen", oud: n.naam, nieuw: nieuweNaam.trim() });
            } }, "Hernoemen"), " ",
            n.inLijst && !n.gebruik ? el("button", { type: "button", class: "os-knop", disabled: bezig, onclick: () => { if (confirm(`"${n.naam}" verwijderen?`)) post({ actie: "verwijderen", naam: n.naam }); } }, "Verwijderen") : null)))
          : el("tr", {}, el("td", { colspan: 5, class: "os-zacht" }, "Geen contactpersonen gevonden.")))));
    }
  }

  post({ actie: "lijst" });
})();
