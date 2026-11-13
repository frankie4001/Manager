/* Betaallijst inkoopfacturen (Eigen aanpassing). Zie Betaallijst.cs. */
(function () {
  "use strict";
  const script = document.getElementById("betaallijst-script");
  const root = document.getElementById("bl-app");
  if (!script || !root) return;

  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "disabled" || k === "indeterminate") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  const euro = (n) => "€ " + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const datumNl = (d) => (d ? d.split("-").reverse().join("-") : "");
  const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dagenTot = (d, vandaag) => Math.round((Date.parse(d) - Date.parse(vandaag)) / 864e5);
  const plusDagen = (d, n) => { const x = new Date(Date.parse(d) + n * 864e5); return x.toISOString().slice(0, 10); };

  let data = null, melding = null, bezig = false;
  const gekozen = new Set();
  const f = { tot: "", zoek: "", alleenVervallen: false, toonBetaald: false, sort: "vervaldatum", op: true };

  async function post(body) {
    const r = await fetch(script.dataset.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
    return r.json();
  }
  async function laad() {
    bezig = true; teken();
    try {
      data = await post({ actie: "lijst" });
      const bestaand = new Set(data.facturen.map((x) => x.key));
      for (const k of [...gekozen]) if (!bestaand.has(k)) gekozen.delete(k);
    } catch (e) { melding = { soort: "fout", tekst: "Laden mislukt: " + e.message }; }
    bezig = false; teken();
  }

  function zichtbaar() {
    if (!data) return [];
    const z = f.zoek.trim().toLowerCase();
    let l = data.facturen.filter((x) =>
      (f.toonBetaald || !x.betaald) &&
      (!f.tot || x.vervaldatum <= f.tot) &&
      (!f.alleenVervallen || x.vervaldatum < data.vandaag) &&
      (!z || [x.leverancier, x.factuurnummer, x.referentie, x.opmerking, x.ibanTekst].join(" ").toLowerCase().includes(z)));
    const cmp = { vervaldatum: (a, b) => a.vervaldatum.localeCompare(b.vervaldatum), leverancier: (a, b) => a.leverancier.localeCompare(b.leverancier, "nl"), bedrag: (a, b) => a.bedrag - b.bedrag }[f.sort];
    return l.sort((a, b) => (f.op ? 1 : -1) * cmp(a, b) || a.leverancier.localeCompare(b.leverancier, "nl"));
  }
  const keuze = () => data.facturen.filter((x) => gekozen.has(x.key));

  // ---------- scherm ----------
  function teken() {
    if (!data) { vervang(root, meldingEl(), el("p", { class: "os-zacht" }, bezig ? "Laden…" : "")); return; }
    const open = data.facturen.filter((x) => !x.betaald);
    const som = (l) => l.reduce((t, x) => t + x.bedrag, 0);
    const vervallen = open.filter((x) => x.vervaldatum < data.vandaag);
    const week = open.filter((x) => x.vervaldatum >= data.vandaag && x.vervaldatum <= plusDagen(data.vandaag, 7));
    const k = keuze();
    const tegel = (label, waarde, sub, cls) => el("div", { class: "bl-tegel" + (cls ? " " + cls : "") }, el("div", { class: "bl-label" }, label), el("div", { class: "bl-waarde" }, waarde), el("div", { class: "bl-sub" }, sub));

    vervang(root,
      meldingEl(),
      el("div", { class: "bl-tegels" },
        tegel("Openstaand", euro(som(open)), `${open.length} facturen`),
        tegel("Vervallen", euro(som(vervallen)), `${vervallen.length} facturen`, vervallen.length ? "bl-rood" : null),
        tegel("Vervalt binnen 7 dagen", euro(som(week)), `${week.length} facturen`),
        tegel("Geselecteerd", euro(som(k)), `${k.length} facturen`, k.length ? "bl-blauw" : null)),
      el("div", { class: "os-balk" },
        el("label", { class: "bl-inline" }, "Vervalt uiterlijk ", el("input", { class: "os-invoer", type: "date", value: f.tot, onchange: (e) => { f.tot = e.target.value; teken(); } })),
        el("input", { class: "os-invoer", type: "search", placeholder: "Zoeken (leverancier, factuurnr., opmerking)", value: f.zoek, oninput: (e) => { f.zoek = e.target.value; tekenTabel(); } }),
        el("label", { class: "bl-inline" }, el("input", { type: "checkbox", checked: f.alleenVervallen, onchange: (e) => { f.alleenVervallen = e.target.checked; teken(); } }), " alleen vervallen"),
        data.betaaldVeld ? el("label", { class: "bl-inline" }, el("input", { type: "checkbox", checked: f.toonBetaald, onchange: (e) => { f.toonBetaald = e.target.checked; teken(); } }), " ook gemarkeerd als betaald") : null,
        el("span", { class: "os-ruimte" }),
        el("button", { type: "button", class: "os-knop", title: "Instellingen voor het SEPA-bestand", onclick: instellingen }, "Instellingen"),
        el("button", { type: "button", class: "os-knop", disabled: bezig, onclick: laad }, "Vernieuwen")),
      el("div", { class: "os-balk" },
        el("button", { type: "button", class: "os-knop os-primair", disabled: !k.some((x) => !x.betaald), onclick: sepa }, "SEPA-bestand maken…"),
        data.betaaldVeld ? el("button", { type: "button", class: "os-knop", disabled: !k.some((x) => !x.betaald) || bezig, onclick: () => markeer(k.filter((x) => !x.betaald), true) }, "Markeer als betaald") : null,
        data.betaaldVeld && k.some((x) => x.betaald) ? el("button", { type: "button", class: "os-knop", onclick: () => markeer(k.filter((x) => x.betaald), false) }, "Markering weghalen") : null,
        el("button", { type: "button", class: "os-knop", onclick: kopieer }, "Kopiëren"),
        el("button", { type: "button", class: "os-knop", onclick: afdrukken }, "Afdrukken"),
        el("span", { class: "os-zacht os-klein" }, k.length ? "Geldt voor de geselecteerde facturen." : "Zonder selectie gelden Kopiëren en Afdrukken voor de hele lijst.")),
      !data.betaaldVeld ? el("p", { class: "os-zacht os-klein" }, "Geen eigen vinkveld \"Factuur betaald\" voor inkoopfacturen gevonden; markeren als betaald is daarom niet beschikbaar.") : null,
      el("div", { id: "bl-tabel" }));
    tekenTabel();
  }

  function meldingEl() {
    if (!melding) return null;
    return el("div", { class: "os-melding os-" + melding.soort }, melding.tekst,
      el("button", { type: "button", class: "os-sluit", onclick: () => { melding = null; teken(); } }, "×"));
  }

  function tekenTabel() {
    const vak = document.getElementById("bl-tabel");
    if (!vak) return;
    const lijst = zichtbaar();
    const kiesbaar = lijst.filter((x) => !x.betaald || f.toonBetaald);
    const alle = kiesbaar.length > 0 && kiesbaar.every((x) => gekozen.has(x.key));
    const deels = !alle && kiesbaar.some((x) => gekozen.has(x.key));
    const kop = (key, naam, cls) => el("th", { class: "os-sorteer" + (cls ? " " + cls : ""), onclick: () => { f.op = f.sort === key ? !f.op : true; f.sort = key; tekenTabel(); } }, naam, f.sort === key ? (f.op ? " ▲" : " ▼") : "");
    const k = lijst.filter((x) => gekozen.has(x.key));
    const totaalLijst = k.length ? k : lijst.filter((x) => !x.betaald);

    vervang(vak, el("div", { class: "os-scroll bl-scroll" }, el("table", { class: "os-tabel bl-tabel" },
      el("thead", {}, el("tr", {},
        el("th", {}, el("input", { type: "checkbox", checked: alle, indeterminate: deels, title: "Alles selecteren", onchange: (e) => { for (const x of kiesbaar) { if (e.target.checked) gekozen.add(x.key); else gekozen.delete(x.key); } teken(); } })),
        kop("vervaldatum", "Vervaldatum"), kop("leverancier", "Leverancier"), el("th", {}, "Bankrekening"), el("th", { title: "Factuurnummer van de leverancier en ons volgnummer" }, "Omschrijving"), el("th", {}, "Opmerking"), kop("bedrag", "Bedrag", "os-num"))),
      el("tbody", {}, lijst.length ? lijst.map((x) => {
        const d = dagenTot(x.vervaldatum, data.vandaag);
        const te = d < 0 ? `${-d} ${-d === 1 ? "dag" : "dagen"} te laat` : d === 0 ? "vandaag" : `over ${d} ${d === 1 ? "dag" : "dagen"}`;
        return el("tr", { class: (x.betaald ? "bl-betaald " : "") + (gekozen.has(x.key) ? "bl-sel" : "") },
          el("td", {}, el("input", { type: "checkbox", checked: gekozen.has(x.key), onchange: (e) => { if (e.target.checked) gekozen.add(x.key); else gekozen.delete(x.key); teken(); } })),
          el("td", { class: "os-nowrap" + (d < 0 ? " bl-laat" : "") }, datumNl(x.vervaldatum), el("span", { class: "bl-dagen" }, te)),
          el("td", {}, x.leverancier),
          el("td", { class: "os-nowrap" }, x.iban ? el("span", { title: "Gevonden op: " + x.ibanBron }, x.ibanTekst) : el("span", { class: "os-rood bl-cursief" }, "niet gevonden"),
            x.euro ? null : el("span", { class: "os-rood os-klein" }, " (geen euro)")),
          el("td", { class: "os-nowrap" },
            el("span", { class: "bl-kopieer", title: "Factuurnummer en volgnummer, om te kopiëren voor een handmatige betaling" }, omschrijving(x)),
            el("button", { type: "button", class: "bl-knopje", title: "Kopiëren", onclick: (e) => kopieerTekst(omschrijving(x), e.currentTarget) }, "⧉"),
            el("a", { href: x.url, target: "_blank", class: "bl-knopje", title: "Inkoopfactuur openen" }, "↗"),
            x.betaald ? el("span", { class: "bl-label-betaald" }, "gemarkeerd als betaald") : null),
          el("td", { class: "bl-wrap" }, x.opmerking),
          el("td", { class: "os-num" }, euro(x.bedrag)));
      }) : el("tr", {}, el("td", { colspan: 7, class: "os-zacht" }, "Geen openstaande facturen met deze filters."))),
      el("tfoot", {}, el("tr", {}, el("td"), el("td", { colspan: 5 }, k.length ? `Geselecteerd: ${k.length} van ${lijst.length}` : `Totaal: ${totaalLijst.length} facturen`), el("td", { class: "os-num" }, euro(totaalLijst.reduce((t, x) => t + x.bedrag, 0))))))));
  }

  // Zoals in het SEPA-bestand: factuurnummer spatie volgnummer
  const omschrijving = (x) => [x.factuurnummer, x.referentie].map((t) => String(t || "").trim()).filter(Boolean).join(" ");
  async function kopieerTekst(t, knop) {
    try { await navigator.clipboard.writeText(t); knop.textContent = "✓"; setTimeout(() => { knop.textContent = "⧉"; }, 1200); }
    catch (e) { melding = { soort: "fout", tekst: "Kopiëren is niet gelukt in deze browser; selecteer de tekst en kopieer met Ctrl+C." }; teken(); }
  }

  // ---------- acties ----------
  async function markeer(lijst, betaald) {
    if (!lijst.length) return;
    const totaal = lijst.reduce((t, x) => t + x.bedrag, 0);
    if (!confirm(betaald ? `${lijst.length} factuur/facturen (${euro(totaal)}) markeren als betaald?` : `Markering "betaald" weghalen bij ${lijst.length} factuur/facturen?`)) return;
    bezig = true; teken();
    try {
      data = await post({ actie: "markeren", keys: lijst.map((x) => x.key), betaald });
      melding = { soort: "ok", tekst: data.resultaat };
      for (const x of lijst) gekozen.delete(x.key);
    } catch (e) { melding = { soort: "fout", tekst: e.message }; }
    bezig = false; teken();
  }

  const voorExport = () => { const k = zichtbaar().filter((x) => gekozen.has(x.key)); return k.length ? k : zichtbaar().filter((x) => !x.betaald); };

  async function kopieer() {
    const rijen = voorExport();
    const tekst = [["Leverancier", "Bankrekening", "Bedrag", "Vervaldatum", "Omschrijving", "Opmerking"].join("\t")]
      .concat(rijen.map((x) => [x.leverancier, x.iban || "", x.bedrag.toFixed(2).replace(".", ","), datumNl(x.vervaldatum), omschrijving(x), (x.opmerking || "").replace(/\s+/g, " ")].join("\t"))).join("\n");
    try { await navigator.clipboard.writeText(tekst); melding = { soort: "ok", tekst: `${rijen.length} facturen gekopieerd (plak in Excel).` }; }
    catch (e) { melding = { soort: "fout", tekst: "Kopiëren is niet gelukt in deze browser." }; }
    teken();
  }

  function afdrukken() {
    const rijen = voorExport();
    const filters = [f.tot ? "vervalt uiterlijk " + datumNl(f.tot) : null, f.alleenVervallen ? "alleen vervallen" : null, f.zoek ? `zoeken "${f.zoek}"` : null, rijen.some((x) => gekozen.has(x.key)) ? "alleen geselecteerde facturen" : null].filter(Boolean);
    const w = window.open("", "_blank");
    if (!w) { melding = { soort: "fout", tekst: "Het afdrukvenster werd geblokkeerd; sta pop-ups toe voor Manager." }; teken(); return; }
    const totaal = rijen.reduce((t, x) => t + x.bedrag, 0);
    w.document.write(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Betaallijst</title><style>
      @page { size: A4 landscape; margin: 10mm; }
      body { font-family: Arial, sans-serif; font-size: 11px; color: #000; }
      h1 { font-size: 16px; margin: 0 0 2px; } p { margin: 0 0 8px; color: #333; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { background: #e5e5e5; } td.r, th.r { text-align: right; white-space: nowrap; } .laat { font-weight: bold; }
      tfoot td { font-weight: bold; border-top: 2px solid #000; }
      th, tfoot td { -webkit-print-color-adjust: exact; print-color-adjust: exact; } tr { break-inside: avoid; }
    </style></head><body><h1>Betaallijst inkoopfacturen</h1><p>Afgedrukt op ${esc(new Date().toLocaleString("nl-NL"))}${filters.length ? " — " + esc(filters.join(", ")) : ""}</p>
    <table><thead><tr><th>Vervaldatum</th><th>Leverancier</th><th>Bankrekening</th><th>Omschrijving</th><th>Opmerking</th><th class="r">Bedrag</th></tr></thead><tbody>
    ${rijen.map((x) => `<tr><td class="${x.vervaldatum < data.vandaag ? "laat" : ""}">${esc(datumNl(x.vervaldatum))}</td><td>${esc(x.leverancier)}</td><td>${esc(x.ibanTekst || "niet gevonden")}</td><td>${esc(omschrijving(x))}</td><td>${esc(x.opmerking)}</td><td class="r">${esc(euro(x.bedrag))}</td></tr>`).join("")}
    </tbody><tfoot><tr><td colspan="5">Totaal: ${rijen.length} facturen</td><td class="r">${esc(euro(totaal))}</td></tr></tfoot></table>
    <script>window.onload = () => { window.print(); };<\/script></body></html>`);
    w.document.close();
  }

  function dialoog(titel, inhoud, knoppen) {
    const d = el("div", { class: "os-overlay" },
      el("div", { class: "os-dialoog" },
        el("div", { class: "os-dialoog-kop" }, el("strong", {}, titel)),
        el("div", { class: "os-dialoog-inhoud" }, inhoud),
        el("div", { class: "os-dialoog-voet" }, knoppen)));
    d.addEventListener("click", (e) => { if (e.target === d) d.remove(); });
    document.body.append(d);
    return d;
  }

  function instellingen(naVolgende) {
    const inst = data.instellingen || {};
    const naam = el("input", { class: "os-invoer os-breed", value: inst.naam || "" });
    const iban = el("input", { class: "os-invoer os-breed", value: inst.rekening || inst.voorstel || "", placeholder: "NL00 BANK 0000 0000 00" });
    const bic = el("input", { class: "os-invoer", value: inst.bic || "", placeholder: "optioneel" });
    const fout = el("div", { class: "os-rood" });
    const knop = el("button", { type: "button", class: "os-knop os-primair" }, "Bewaren");
    const d = dialoog("Instellingen betaallijst", [
      el("div", { class: "os-raster" }, el("label", {}, "Naam rekeninghouder"), naam, el("label", {}, "Eigen IBAN"), iban, el("label", {}, "BIC"), bic),
      el("p", { class: "os-zacht os-klein" }, "Van deze rekening wordt betaald in het SEPA-bestand. Wordt bewaard in de datamap van Manager (betaallijst.json), per administratie."),
      fout], [el("button", { type: "button", class: "os-knop", onclick: () => d.remove() }, "Annuleren"), knop]);
    knop.addEventListener("click", async () => {
      try {
        const r = await post({ actie: "instellingen", naam: naam.value, rekening: iban.value, bic: bic.value });
        data.instellingen = r.instellingen; d.remove();
        if (typeof naVolgende === "function") naVolgende(); else { melding = { soort: "ok", tekst: r.resultaat }; teken(); }
      } catch (e) { fout.textContent = e.message; }
    });
  }

  function sepa() {
    const inst = data.instellingen || {};
    if (!inst.rekening) { instellingen(sepa); return; }
    const lijst = keuze().filter((x) => !x.betaald);
    const zonder = lijst.filter((x) => !x.iban || !x.euro);
    const ok = lijst.filter((x) => x.iban && x.euro);
    const perLev = new Set(ok.map((x) => x.leverancier + "|" + x.iban)).size;
    // Standaard 2 dagen voor de eerste vervaldatum (niet eerder dan vandaag)
    const eerste = ok.map((x) => x.vervaldatum).sort()[0];
    const voorstel = eerste ? plusDagen(eerste, -2) : data.vandaag;
    const datum = el("input", { class: "os-invoer", type: "date", value: voorstel < data.vandaag ? data.vandaag : voorstel, min: data.vandaag });
    const bundel = el("input", { type: "checkbox" });
    const fout = el("div", { class: "os-rood" });
    const knop = el("button", { type: "button", class: "os-knop os-primair", disabled: !ok.length }, "Bestand maken");
    const d = dialoog("SEPA-betaalbestand", [
      el("p", {}, `${ok.length} facturen, totaal ${euro(ok.reduce((t, x) => t + x.bedrag, 0))}, van rekening ${String(inst.rekening).replace(/(.{4})(?!$)/g, "$1 ")} (${inst.naam || ""}).`),
      el("div", { class: "os-raster" }, el("label", {}, "Uitvoerdatum"), datum),
      perLev < ok.length ? el("label", { class: "bl-inline" }, bundel, ` één betaling per leverancier (${perLev} betalingen in plaats van ${ok.length}; de factuurnummers komen in de omschrijving)`) : null,
      zonder.length ? el("div", { class: "os-melding os-fout" }, "Niet in het bestand (geen geldig IBAN of geen euro): ", zonder.map((x) => `${x.leverancier} ${x.factuurnummer || "#" + x.referentie}`).join(", ")) : null,
      el("p", { class: "os-zacht os-klein" }, eerste ? `Standaard 2 dagen voor de eerste vervaldatum (${datumNl(eerste)}), niet eerder dan vandaag. ` : "",
        "Als omschrijving krijgt de leverancier zijn eigen factuurnummer en ons volgnummer (bijv. \"52600001 12\"); het kenmerk van de betaling is \"VNR 12\". Controleer na het uploaden in je bankomgeving de bedragen en rekeningen voordat je de batch goedkeurt."),
      fout], [el("button", { type: "button", class: "os-knop", onclick: () => d.remove() }, "Annuleren"), knop]);
    knop.addEventListener("click", async () => {
      knop.disabled = true;
      try {
        const r = await post({ actie: "sepa", keys: ok.map((x) => x.key), datum: datum.value, bundelen: bundel.checked });
        const blob = new Blob([r.xml], { type: "application/xml" });
        const a = el("a", { href: URL.createObjectURL(blob), download: r.bestandsnaam });
        document.body.append(a); a.click(); a.remove();
        d.remove();
        naSepa(r);
      } catch (e) { fout.textContent = e.message; knop.disabled = false; }
    });
  }

  // Na het maken van het bestand: eventueel meteen markeren als betaald
  function naSepa(r) {
    const lijst = data.facturen.filter((x) => r.keys.includes(x.key));
    melding = { soort: "ok", tekst: `${r.bestandsnaam} gemaakt: ${r.aantal} betaling(en), totaal ${euro(r.totaal)}.` };
    teken();
    if (!data.betaaldVeld) return;
    const d = dialoog("Facturen markeren als betaald?", [
      el("p", {}, `Wil je de ${lijst.length} facturen in het bestand nu markeren als betaald? Dan verdwijnen ze van de betaallijst.`),
      el("p", { class: "os-zacht os-klein" }, "Tip: doe dit pas als de bank de batch heeft geaccepteerd. Je kunt het ook later doen via \"Markeer als betaald\"."),
    ], [el("button", { type: "button", class: "os-knop", onclick: () => d.remove() }, "Later"),
      el("button", { type: "button", class: "os-knop os-primair", onclick: async () => {
        d.remove();
        try { data = await post({ actie: "markeren", keys: lijst.map((x) => x.key), betaald: true }); melding = { soort: "ok", tekst: data.resultaat }; for (const x of lijst) gekozen.delete(x.key); }
        catch (e) { melding = { soort: "fout", tekst: e.message }; }
        teken();
      } }, "Nu markeren")]);
  }

  laad();
})();
