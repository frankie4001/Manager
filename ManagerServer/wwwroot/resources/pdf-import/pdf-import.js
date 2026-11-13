/* PDF-inkoopfactuur inlezen (Eigen aanpassing).
 *
 * Knop "PDF inlezen" boven een nieuwe inkoopfactuur. Leest de PDF in de browser (pdf.js),
 * herkent leverancier, factuurnummer, datum, totalen, btw en IBAN, leest de regels met een
 * sjabloon (indien aanwezig) en vult daarna het gewone formulier van Manager in.
 * Opslaan gaat via de gewone knop "Aanmaken"; de PDF wordt dan als bijlage bewaard.
 *
 * Sjablonen worden hier gemaakt met de sjabloon-maker en op de server bewaard in
 * <datamap>/pdf-sjablonen.json (zie PdfImport.cs).
 */
(function () {
  "use strict";
  // replaceChildren zonder lege waarden (null/false) en met geneste lijsten
  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const P = window.PdfImportParser;
  const script = document.getElementById("pdf-import-script");
  const formulier = document.getElementById("v-model-form");
  if (!P || !script || !formulier || document.getElementById("pdf-import")) return;
  const DATA_URL = script.dataset.url;
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = script.dataset.worker;

  // ---------- hulpjes ----------
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "selected" || k === "disabled" || k === "hidden") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  const euro = (n) => (n == null || isNaN(n) ? "—" : "€ " + Number(n).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const getalTekst = (n) => (n == null ? "" : Number(n).toLocaleString("nl-NL", { maximumFractionDigits: 4 }));
  const kloon = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
  const naamNorm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  // losser vergelijken: zonder rechtsvorm (B.V., BV, V.O.F., N.V.) en leestekens
  const los = (s) => naamNorm(s).replace(/\b(b\.?\s?v\.?|v\.?o\.?f\.?|n\.?v\.?|gmbh|bvba)(?=\s|$)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  function zoekOpNaam(lijst, naam) {
    if (!naam) return null;
    return lijst.find((x) => naamNorm(x.naam) === naamNorm(naam))
      || lijst.find((x) => los(x.naam) && los(x.naam) === los(naam))
      || null;
  }
  const opKey = (lijst, key) => (key ? lijst.find((x) => x.key === key) || null : null);
  function select(opties, waarde, leeg, onchange, attrs) {
    const s = el("select", Object.assign({ class: "pi-invoer", onchange: (e) => onchange(e.target.value) }, attrs || {}));
    if (leeg != null) s.add(new Option(leeg, ""));
    for (const o of opties) s.add(new Option(o.naam, o.key));
    s.value = waarde || "";
    return s;
  }
  // Datum "jjjj-m-d" <-> invoerveld "jjjj-mm-dd"
  const naarInvoer = (d) => (d ? d.split("-").map((x, i) => (i ? x.padStart(2, "0") : x)).join("-") : "");
  const vanInvoer = (d) => (d ? d.split("-").map((x, i) => (i ? String(Number(x)) : x)).join("-") : "");

  // ---------- toestand ----------
  const S = {
    ctx: null,          // gegevens uit Manager (leveranciers, rekeningen, btw-codes, sjablonen, ...)
    ctxFout: null,
    bestand: null,      // het PDF-bestand
    lijnen: null,       // tekstregels [{t, y, p}]
    r: null,            // resultaat van PdfImportParser.uitlezen
    k: null,            // keuzes in het scherm
    overgenomen: false, // formulier ingevuld -> PDF meesturen bij Aanmaken
  };

  function laadContext() {
    S.ctxBelofte = fetch(DATA_URL, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((ctx) => { S.ctx = ctx; S.ctxFout = null; return ctx; })
      .catch((e) => { S.ctxFout = e.message; throw e; });
    return S.ctxBelofte;
  }

  // Eigen btw-nummer/IBAN en nummers die bij meerdere leveranciers voorkomen: niet gebruiken
  // Eigen btw-nummer/IBAN: uit de bedrijfsgegevens, nummers bij "Uw ..." op de factuur, nummers die bij
  // meerdere leveranciers zijn voorgekomen en nummers die in meerdere sjablonen staan.
  function eigenNummers() {
    const set = new Set(P.nummers(S.ctx.eigenTekst || "").alle);
    for (const [nr, lijst] of Object.entries(S.ctx.herkenning || {})) if (Array.isArray(lijst) && lijst.length > 1) set.add(nr);
    for (const nr of P.gedeeldeNummers(S.ctx.sjablonen)) set.add(nr);
    if (S.lijnen) for (const nr of P.klantNummers(S.lijnen, S.ctx.eigenNaam)) set.add(nr);
    return set;
  }
  function factuurNummers() {
    const eigen = eigenNummers();
    return (S.r.nummers || []).filter((n) => !eigen.has(n));
  }

  // ---------- leverancier herkennen ----------
  function herkenLeverancier() {
    const ctx = S.ctx, lev = ctx.leveranciers;
    const s = S.r.sjabloon;
    if (s && s.leverancier) {
      const x = opKey(lev, s.leverancier.key) || zoekOpNaam(lev, s.leverancier.naam);
      if (x) return { lev: x, hoe: `sjabloon "${s.naam}"` };
    }
    const nrs = factuurNummers();
    const stemmen = new Map();
    const stem = (key, w) => stemmen.set(key, (stemmen.get(key) || 0) + w);
    for (const nr of nrs) {
      const geleerd = ctx.herkenning?.[nr];
      if (Array.isArray(geleerd) && geleerd.length === 1 && opKey(lev, geleerd[0].key)) stem(geleerd[0].key, 3);
    }
    for (const l of lev) {
      if (!l._nrs) l._nrs = new Set([...P.nummers(l.tekst || "").alle, ...(l.ibans || []).map((i) => P.ibanNorm(i.iban))]);
      for (const nr of nrs) if (l._nrs.has(nr)) stem(l.key, 2);
    }
    if (stemmen.size) {
      const [key] = [...stemmen].sort((a, b) => b[1] - a[1])[0];
      return { lev: opKey(lev, key), hoe: "btw-nummer/IBAN" };
    }
    // Naam van de leverancier in de eerste regels van de factuur
    const tekst = " " + los(S.lijnen.slice(0, 40).map((l) => l.t).join(" ")) + " ";
    let beste = null;
    for (const l of lev) {
      const n = los(l.naam);
      if (n.length >= 3 && tekst.includes(" " + n + " ") && (!beste || n.length > los(beste.naam).length)) beste = l;
    }
    if (beste) return { lev: beste, hoe: "naam op de factuur" };
    return { lev: null, hoe: null };
  }

  // ---------- standaardwaarden ----------
  function kiesBtwCode(lev) {
    const ctx = S.ctx, s = S.r.sjabloon, codes = ctx.btwCodes;
    if (s && s.btwCode) { const x = opKey(codes, s.btwCode.key) || zoekOpNaam(codes, s.btwCode.naam); if (x) return x.key; }
    const laatste = opKey(codes, lev?.laatste?.btwCode);
    if (S.r.tarief != null) {
      if (laatste && Math.round(laatste.tarief) === S.r.tarief) return laatste.key;
      const x = codes.find((c) => Math.round(c.tarief) === S.r.tarief && !/verlegd|reverse/i.test(c.naam));
      if (x) return x.key;
    }
    return laatste?.key || "";
  }
  function kiesRekening(lev) {
    const ctx = S.ctx, s = S.r.sjabloon, rek = ctx.rekeningen;
    if (s && s.rekening) { const x = opKey(rek, s.rekening.key) || zoekOpNaam(rek, s.rekening.naam); if (x) return x.key; }
    return opKey(rek, lev?.laatste?.rekening)?.key || zoekOpNaam(rek, ctx.standaardRekening)?.key || "";
  }
  function kiesTermijn(lev) {
    const s = S.r.sjabloon;
    if (s && s.betaaltermijn > 0) return s.betaaltermijn;
    if (S.r.betaaltermijn > 0) return S.r.betaaltermijn;
    if (lev?.laatste?.termijn > 0) return lev.laatste.termijn;
    return 30;
  }

  function maakRegels() {
    if (S.r.regels.length) {
      return S.r.regels.map((x) => ({ omschrijving: x.omschrijving || "", aantal: x.aantal, prijs: x.prijs, bedrag: x.bedrag, rekening: "", verkooporder: "" }));
    }
    // Zonder sjabloon: één regel met het totaal excl. btw
    const bedrag = S.r.totaalExcl;
    if (bedrag == null) return [];
    const oms = "Factuur " + (S.r.factuurnummer || "");
    return [{ omschrijving: oms.trim(), aantal: 1, prijs: bedrag, bedrag, rekening: "", verkooporder: "" }];
  }

  function tarief() {
    const c = opKey(S.ctx.btwCodes, S.k.btwCode);
    if (!c) return 0;
    return c.tarief > 1 ? c.tarief / 100 : c.tarief;
  }

  // Regels zoals ze naar Manager gaan, inclusief eventuele btw-afrondingscorrectie
  function managerRegels() {
    const regels = S.k.regels.map((x) => ({ ...x, btw: true }));
    const corr = S.k.btwCode ? P.btwCorrectie(S.k.regels, tarief(), S.r.btwBedrag) : null;
    if (corr && corr.verschil && corr.basis != null) {
      const oms = S.ctx.afrondingOmschrijving || "Btw-afrondingsverschil";
      regels.push({ omschrijving: oms, aantal: 1, prijs: corr.basis, bedrag: corr.basis, btw: true, correctie: true, rekening: "", verkooporder: "" });
      regels.push({ omschrijving: oms, aantal: 1, prijs: -corr.basis, bedrag: -corr.basis, btw: false, correctie: true, rekening: "", verkooporder: "" });
    }
    return { regels, corr };
  }

  // ---------- paneel ----------
  const invoerBestand = el("input", { type: "file", accept: "application/pdf,.pdf", hidden: true, onchange: (e) => e.target.files[0] && verwerk(e.target.files[0]) });
  const status = el("span", { class: "pi-status" });
  const inhoud = el("div", { class: "pi-inhoud", hidden: true });
  const paneel = el("div", { id: "pdf-import", class: "pi" },
    el("div", { class: "pi-balk" },
      el("button", { type: "button", class: "pi-knop pi-primair", onclick: () => invoerBestand.click() }, "PDF inlezen"),
      el("span", { class: "pi-hint" }, "of sleep een PDF-factuur hierheen"),
      status,
      el("span", { class: "pi-ruimte" }),
      el("button", { type: "button", class: "pi-link", onclick: toonSjablonenLijst }, "Sjablonen"),
      el("span", { class: "pi-zacht pi-klein", title: "Versie van de PDF-import" }, "v" + (script.dataset.versie || "?").slice(0, 6))),
    invoerBestand, inhoud);
  paneel.__pdfState = S;
  formulier.parentNode.insertBefore(paneel, formulier);

  paneel.addEventListener("dragover", (e) => { e.preventDefault(); paneel.classList.add("pi-sleep"); });
  paneel.addEventListener("dragleave", () => paneel.classList.remove("pi-sleep"));
  paneel.addEventListener("drop", (e) => {
    e.preventDefault(); paneel.classList.remove("pi-sleep");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) verwerk(f);
  });

  laadContext().catch(() => {});

  function metVeld(naam, m) { m.dataset.veld = naam; return m; }
  function melding(soort, tekst) { return el("div", { class: "pi-melding pi-" + soort }, tekst); }

  async function leesPdf(bestand) {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await bestand.arrayBuffer()) }).promise;
    let lijnen = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      lijnen = lijnen.concat(P.itemsNaarRegels(tc.items, i));
    }
    return lijnen;
  }

  async function verwerk(bestand) {
    inhoud.hidden = false;
    vervang(inhoud);
    S.overgenomen = false;
    if (!/\.pdf$/i.test(bestand.name) && bestand.type !== "application/pdf") { inhoud.append(melding("fout", "Kies een PDF-bestand.")); return; }
    if (!window.pdfjsLib) { inhoud.append(melding("fout", "De PDF-lezer (pdf.js) is niet geladen.")); return; }
    status.textContent = "Bezig met lezen…";
    try {
      const [lijnen] = await Promise.all([leesPdf(bestand), S.ctx ? null : (S.ctxBelofte || laadContext()).catch(() => null)]);
      if (!S.ctx) throw new Error("Gegevens uit Manager konden niet worden geladen (" + (S.ctxFout || "onbekend") + ").");
      if (!lijnen.length) { status.textContent = ""; inhoud.append(melding("fout", "Deze PDF bevat geen tekst (waarschijnlijk een scan). Voer deze factuur handmatig in.")); return; }
      S.bestand = bestand;
      S.lijnen = lijnen;
      analyseer();
      status.textContent = bestand.name;
    } catch (e) {
      status.textContent = "";
      inhoud.append(melding("fout", "PDF kon niet worden gelezen: " + e.message));
    }
  }

  // Lees de PDF (opnieuw) met de huidige sjablonen en vul de keuzes
  function analyseer(behoudKeuzes) {
    S.r = P.uitlezen(S.lijnen, S.ctx.sjablonen || [], eigenNummers(), S.ctx.eigenNaam);
    const oud = S.k;
    const { lev, hoe } = herkenLeverancier();
    S.k = {
      leverancier: lev?.key || "",
      hoe,
      factuurnummer: S.r.factuurnummer || "",
      datum: S.r.factuurdatum || "",
      termijn: kiesTermijn(lev),
      iban: factuurNummers().find((n) => S.r.ibans.includes(n)) || S.r.ibans[0] || "",
      btwCode: kiesBtwCode(lev),
      rekening: kiesRekening(lev),
      voAlle: "",
      regels: maakRegels(),
    };
    if (behoudKeuzes && oud) {
      for (const k of ["factuurnummer", "datum", "iban"]) if (oud[k]) S.k[k] = oud[k];
      if (oud.leverancier && !S.r.sjabloon?.leverancier) S.k.leverancier = oud.leverancier;
    }
    toonResultaat();
  }

  // ---------- resultaat ----------
  function toonResultaat() {
    const ctx = S.ctx, k = S.k, r = S.r;
    const veldVo = ctx.velden.verkooporder && ctx.verkooporders.length;
    const meldingen = el("div", { class: "pi-meldingen" });

    const ibanStatus = el("div", { class: "pi-klein" });
    const controleerIban = () => {
      const iban = P.ibanNorm(k.iban);
      const zet = (soort, tekst) => { ibanStatus.className = "pi-klein pi-tekst-" + soort; ibanStatus.textContent = tekst; };
      if (!iban) return zet("zacht", "Geen IBAN gevonden op de factuur.");
      if (!P.ibanGeldig(iban)) return zet("fout", "✖ Ongeldig IBAN (controlegetal klopt niet).");
      const lev = opKey(ctx.leveranciers, k.leverancier);
      if (!lev || !ctx.velden.bankrekening) return zet("ok", "✔ Geldig IBAN.");
      const eerder = (lev.ibans || []).filter((x) => P.ibanNorm(x.iban)).sort((a, b) => String(b.datum).localeCompare(String(a.datum)));
      if (!eerder.length) return zet("let", "✔ Geldig IBAN. Nog niet eerder gebruikt voor deze leverancier — controleer bij twijfel.");
      const vorig = P.ibanNorm(eerder[0].iban);
      if (vorig === iban) return zet("ok", "✔ Geldig IBAN, gelijk aan eerdere facturen van deze leverancier.");
      zet("fout", `⚠ LET OP: wijkt af van het eerder gebruikte IBAN ${vorig} (factuur ${eerder[0].referentie || ""}, ${eerder[0].datum}). Controleer dit bij de leverancier voordat je betaalt!`);
    };

    const regelsTabel = el("tbody");
    const totalen = el("tbody");
    const tekenRegels = () => {
      const { regels, corr } = managerRegels();
      vervang(regelsTabel);
      regels.forEach((x, i) => {
        const tr = el("tr", { class: x.correctie ? "pi-correctie" : null });
        if (x.correctie) {
          tr.append(el("td", {}, ""), el("td", {}, `${x.omschrijving} (${x.btw ? "met" : "zonder"} btw)`),
            el("td", { class: "pi-num" }, "1"), el("td", { class: "pi-num" }, euro(x.prijs)), el("td", { class: "pi-num" }, euro(x.bedrag)), el("td"), veldVo ? el("td") : null);
        } else {
          const regel = k.regels[i];
          tr.append(
            el("td", { class: "pi-zacht" }, String(i + 1)),
            el("td", {}, el("input", { class: "pi-invoer pi-breed", value: regel.omschrijving, onchange: (e) => { regel.omschrijving = e.target.value; } })),
            el("td", { class: "pi-num" }, getalTekst(regel.aantal)),
            el("td", { class: "pi-num" }, euro(regel.prijs)),
            el("td", { class: "pi-num" }, euro(regel.bedrag)),
            el("td", {}, select(ctx.rekeningen, regel.rekening, "(zoals bovenaan)", (v) => { regel.rekening = v; }, { class: "pi-invoer pi-smal" })),
            veldVo ? el("td", {}, select(ctx.verkooporders.map((o) => ({ key: o.waarde, naam: o.naam })), regel.verkooporder, "(geen)", (v) => { regel.verkooporder = v; }, { class: "pi-invoer pi-smal" })) : null);
        }
        regelsTabel.append(tr);
      });
      const som = k.regels.reduce((t, x) => t + P.centen(x.bedrag), 0) / 100;
      const klopt = r.totaalExcl != null && P.centen(som) === P.centen(r.totaalExcl);
      const rij = (label, waarde, cls) => el("tr", { class: cls }, el("td"), el("td", {}, label), el("td"), el("td"), el("td", { class: "pi-num" }, waarde), el("td"), veldVo ? el("td") : null);
      vervang(totalen, 
        rij(`Som regels (${k.regels.length})`, euro(som), klopt ? "pi-goed" : (r.totaalExcl != null ? "pi-fout-rij" : null)),
        rij("Totaal excl. btw volgens factuur", euro(r.totaalExcl), klopt ? "pi-goed" : null),
        rij("Btw volgens factuur", euro(r.btwBedrag)),
        corr && corr.verschil ? rij(`Btw zoals Manager per regel afrondt (correctie ${euro(corr.verschil)})`, euro(corr.managerBtw), "pi-zacht") : null,
        rij("Totaal incl. btw volgens factuur", euro(r.totaalIncl)));
      if (corr && corr.verschil && corr.basis == null) meldingen.append(melding("waarschuwing", `Btw verschilt ${euro(corr.verschil)} met de factuur en kon niet automatisch worden gecorrigeerd.`));
    };

    // Meldingen
    const s = r.sjabloon;
    if (s) meldingen.append(melding(r.somKlopt ? "ok" : "waarschuwing",
      `Sjabloon "${s.naam}": ${r.regels.length} regels gelezen` + (r.somKlopt ? ", som klopt met het totaal excl. btw." : ".")));
    else if (r.sjabloonZonderKop) meldingen.append(el("div", { class: "pi-melding pi-waarschuwing" },
      `Sjabloon "${r.sjabloonZonderKop.naam}" past op het btw-nummer/IBAN, maar de kopregel van de tabel staat niet in deze PDF. Is het een andere leverancier of een nieuwe factuurindeling? `,
      el("button", { type: "button", class: "pi-link", onclick: () => openMaker(r.sjabloonZonderKop) }, "Dat sjabloon bewerken")));
    else meldingen.append(melding("info", "Geen sjabloon voor deze leverancier: de factuur wordt als één regel met het totaal excl. btw ingevuld. Met \"Sjabloon maken\" worden voortaan alle regels gelezen."));
    for (const w of r.waarschuwingen) {
      const m = melding("waarschuwing", w);
      if (/^Factuurnummer niet/.test(w)) m.dataset.veld = "factuurnummer";
      if (/^Factuurdatum niet/.test(w)) m.dataset.veld = "datum";
      if (k.factuurnummer && m.dataset.veld === "factuurnummer") continue;
      if (k.datum && m.dataset.veld === "datum") continue;
      meldingen.append(m);
    }
    // Melding over een ontbrekend veld weghalen zodra het is ingevuld
    const veldIngevuld = (naam, waarde) => { if (waarde) meldingen.querySelectorAll(`[data-veld="${naam}"]`).forEach((m) => m.remove()); };
    if (!k.leverancier) meldingen.append(metVeld("leverancier", melding("waarschuwing", "Leverancier niet herkend — kies handmatig. Bij opslaan wordt het btw-nummer/IBAN onthouden, zodat de leverancier de volgende keer wel wordt herkend.")));
    if (!ctx.velden.factuurnummer) meldingen.append(melding("waarschuwing", `Eigen veld "${ctx.namen.factuurnummer}" voor inkoopfacturen niet gevonden — het factuurnummer wordt niet opgeslagen.`));
    if (k.iban && !ctx.velden.bankrekening) meldingen.append(melding("waarschuwing", `Eigen veld "${ctx.namen.bankrekening}" voor inkoopfacturen niet gevonden — het IBAN wordt niet opgeslagen.`));

    const veld = (label, invoer, extra) => el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, label), invoer, extra || null);
    const levSelect = select(ctx.leveranciers, k.leverancier, "— kies leverancier —", (v) => { k.leverancier = v; veldIngevuld("leverancier", v); controleerIban(); });

    vervang(inhoud, 
      meldingen,
      el("div", { class: "pi-raster" },
        veld("Leverancier", levSelect, k.hoe ? el("div", { class: "pi-klein pi-zacht" }, "Herkend via " + k.hoe) : null),
        veld("Factuurnummer", el("input", { class: "pi-invoer", value: k.factuurnummer, oninput: (e) => { k.factuurnummer = e.target.value.trim(); veldIngevuld("factuurnummer", k.factuurnummer); } })),
        veld("Factuurdatum", el("input", { class: "pi-invoer", type: "date", value: naarInvoer(k.datum), onchange: (e) => { k.datum = vanInvoer(e.target.value); veldIngevuld("datum", k.datum); } })),
        veld("Betaaltermijn (dagen)", el("input", { class: "pi-invoer", type: "number", min: "0", value: k.termijn, onchange: (e) => { k.termijn = parseInt(e.target.value, 10) || 0; } })),
        veld("IBAN leverancier", el("input", { class: "pi-invoer", value: k.iban, oninput: (e) => { k.iban = e.target.value; controleerIban(); } }), ibanStatus),
        veld("Btw-code", select(ctx.btwCodes, k.btwCode, "— geen btw —", (v) => { k.btwCode = v; meldingenVerversen(); tekenRegels(); })),
        veld("Grootboekrekening", select(ctx.rekeningen, k.rekening, "— kies rekening —", (v) => { k.rekening = v; })),
        veldVo ? veld("Verkooporder (alle regels)", select(ctx.verkooporders.map((o) => ({ key: o.waarde, naam: o.naam })), k.voAlle, "(geen / per regel kiezen)", (v) => {
          k.voAlle = v; for (const x of k.regels) x.verkooporder = v; tekenRegels();
        })) : null),
      el("div", { class: "pi-tabelvak" },
        el("table", { class: "pi-tabel" },
          el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Omschrijving"), el("th", { class: "pi-num" }, "Aantal"), el("th", { class: "pi-num" }, "Prijs"),
            el("th", { class: "pi-num" }, "Bedrag"), el("th", {}, "Rekening"), veldVo ? el("th", {}, "Verkooporder") : null)),
          regelsTabel, totalen)),
      el("div", { class: "pi-acties" },
        el("button", { type: "button", class: "pi-knop pi-primair", onclick: overnemen }, "Overnemen in formulier"),
        el("button", { type: "button", class: "pi-knop", onclick: () => openMaker(s) }, s ? "Sjabloon bewerken" : "Sjabloon maken"),
        el("button", { type: "button", class: "pi-knop", onclick: () => { inhoud.hidden = true; status.textContent = ""; S.overgenomen = false; invoerBestand.value = ""; } }, "Sluiten"),
        el("details", { class: "pi-tekstblok" }, el("summary", {}, "Tekst uit de PDF"), el("pre", {}, S.lijnen.map((l) => l.t).join("\n")))));

    const meldingenVerversen = () => {
      for (const m of [...meldingen.children]) if (/kon niet automatisch/.test(m.textContent)) m.remove();
    };
    controleerIban();
    tekenRegels();
  }

  // ---------- formulier van Manager invullen ----------
  function overnemen() {
    const app = window.app, ctx = S.ctx, k = S.k;
    const fout = (t) => { inhoud.prepend(melding("fout", t)); inhoud.scrollIntoView({ behavior: "smooth", block: "start" }); };
    if (!app || !app.$data) return fout("Het formulier van Manager is niet gevonden.");
    const lev = opKey(ctx.leveranciers, k.leverancier);
    if (!lev) return fout("Kies eerst een leverancier.");
    if (!k.rekening && k.regels.some((x) => !x.rekening)) return fout("Kies een grootboekrekening.");
    if (!k.datum) return fout("Vul de factuurdatum in.");

    const heeft = (veld) => Object.prototype.hasOwnProperty.call(app.$data, veld);
    const zet = (veld, waarde) => { if (heeft(veld)) app[veld] = waarde; };

    zet("IssueDate", k.datum);
    zet("Supplier", kloon(lev.obj));
    zet("HasLineDescription", true);
    zet("AmountsIncludeTax", false);
    if (k.termijn > 0) { zet("DueDate", 0); zet("DueDateDays", k.termijn); }
    if (heeft("AutomaticReference") && !app.Reference) app.AutomaticReference = true;
    if (ctx.thema && heeft("CustomTheme")) { app.CustomTheme = true; app.CustomThemeId = kloon(ctx.thema.CustomThemeId); }

    // Eigen velden op factuurniveau
    if (!app.CustomFields2) app.CustomFields2 = { Strings: {} };
    if (!app.CustomFields2.Strings) app.$set(app.CustomFields2, "Strings", {});
    const tekstVeld = (key, waarde) => { if (key && waarde) app.$set(app.CustomFields2.Strings, key, waarde); };
    tekstVeld(ctx.velden.factuurnummer, k.factuurnummer);
    tekstVeld(ctx.velden.bankrekening, P.ibanNorm(k.iban));
    if (ctx.velden.verkooporder && ctx.velden.verkooporderNiveau === "factuur") {
      const gekozen = [...new Set(k.regels.map((x) => x.verkooporder).filter(Boolean))];
      if (gekozen.length) tekstVeld(ctx.velden.verkooporder, gekozen[0]);
    }

    // Regels
    const btw = opKey(ctx.btwCodes, k.btwCode);
    const { regels } = managerRegels();
    app.Lines.splice(0, app.Lines.length);
    for (const x of regels) {
      app.addToLines();
      const l = app.Lines[app.Lines.length - 1];
      const rek = opKey(ctx.rekeningen, x.rekening || k.rekening);
      l.Account = kloon(rek && rek.obj);
      l.LineDescription = x.omschrijving;
      l.Qty = x.aantal;
      l.PurchaseUnitPrice = x.prijs;
      l.TaxCode = x.btw && btw ? kloon(btw.obj) : null;
      if (ctx.velden.verkooporder && ctx.velden.verkooporderNiveau === "regel" && x.verkooporder) {
        if (!l.CustomFields2) app.$set(l, "CustomFields2", { Strings: {} });
        if (!l.CustomFields2.Strings) app.$set(l.CustomFields2, "Strings", {});
        app.$set(l.CustomFields2.Strings, ctx.velden.verkooporder, x.verkooporder);
      }
    }

    S.overgenomen = true;
    S.nummersVoorOpslaan = factuurNummers();
    inhoud.prepend(melding("ok", `Formulier ingevuld (${regels.length} regels). Controleer de gegevens en klik op "Aanmaken"; de PDF wordt dan als bijlage bij de inkoopfactuur bewaard.`));
    formulier.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // PDF en herkenningsgegevens meesturen met "Aanmaken"
  if (!window.__pdfImportVerzendHaak) {
    window.__pdfImportVerzendHaak = true;
    document.addEventListener("htmx:configRequest", function (e) {
      const p = document.getElementById("pdf-import");
      const st = p && p.__pdfState;
      if (!st || !st.overgenomen || !st.bestand) return;
      const fd = e.detail.formData || e.detail.parameters;
      if (!fd || typeof fd.has !== "function" || !fd.has("febb4049-dcdb-4c7a-a395-4b71da72a85b")) return;
      fd.set("PdfImportBestand", st.bestand, st.bestand.name);
      fd.set("PdfImportInfo", JSON.stringify({ nummers: st.nummersVoorOpslaan || [] }));
    });
  }

  // ---------- sjablonen: lijst ----------
  async function bewaarOpServer(body) {
    const r = await fetch(DATA_URL, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
    const data = await r.json();
    S.ctx.sjablonen = data.sjablonen || [];
  }

  function toonSjablonenLijst() {
    const dialoog = el("div", { class: "pi-overlay" });
    const sluit = () => dialoog.remove();
    const lijst = el("div");
    const teken = () => {
      if (!S.ctx) { vervang(lijst, melding("fout", "Gegevens uit Manager zijn nog niet geladen.")); return; }
      const sj = S.ctx.sjablonen || [];
      vervang(lijst, 
        sj.length ? el("table", { class: "pi-tabel" },
          el("thead", {}, el("tr", {}, el("th", {}, "Sjabloon"), el("th", {}, "Leverancier"), el("th", {}, "Herkenning"), el("th", {}, ""))),
          el("tbody", {}, sj.map((s) => el("tr", {},
            el("td", {}, s.naam || "(naamloos)"),
            el("td", {}, s.leverancier?.naam || ""),
            el("td", { class: "pi-klein" }, (s.herken || []).join(", ")),
            el("td", {}, el("button", {
              type: "button", class: "pi-link pi-tekst-fout", onclick: async () => {
                if (!confirm(`Sjabloon "${s.naam}" verwijderen?`)) return;
                try { await bewaarOpServer({ actie: "verwijderen", id: s.id }); teken(); }
                catch (e) { alert("Verwijderen mislukt: " + e.message); }
              },
            }, "Verwijderen")))))) : el("p", {}, "Nog geen sjablonen."),
        el("p", { class: "pi-klein pi-zacht" }, "Een sjabloon maken of bewerken doe je na het inlezen van een PDF van die leverancier. Opgeslagen in: " + (S.ctx.bestand || "pdf-sjablonen.json")));
    };
    teken();
    dialoog.append(el("div", { class: "pi-dialoog pi-dialoog-klein" },
      el("div", { class: "pi-dialoog-kop" }, el("strong", {}, "PDF-sjablonen"), el("span", { class: "pi-ruimte" }), el("button", { type: "button", class: "pi-knop", onclick: sluit }, "Sluiten")),
      el("div", { class: "pi-dialoog-inhoud" }, lijst)));
    dialoog.addEventListener("click", (e) => { if (e.target === dialoog) sluit(); });
    document.body.append(dialoog);
  }

  // ---------- sjabloon-maker ----------
  const LABELNAMEN = { omschrijving: "omschrijving", aantal: "aantal", eenheid: "eenheid", prijs: "prijs", bedrag: "bedrag", negeren: "negeren" };
  const STATUSUITLEG = { kop: "kopregel van de tabel", rij: "factuurregel", vervolg: "hoort bij de omschrijving", negeer: "genegeerd", pagina: "paginawissel (overgeslagen)", eind: "einde van de tabel" };

  // Standaard prefix voor "regels die beginnen met": t/m de dubbele punt, anders de eerste twee woorden
  function voorstelPrefix(t) {
    const m = t.match(/^[^:]{1,40}:/);
    if (m) return m[0];
    return t.split(" ").slice(0, 2).join(" ");
  }

  function openMaker(bestaand) {
    const ctx = S.ctx, k = S.k;
    const eigen = eigenNummers();
    const sj = bestaand ? kloon(bestaand) : {
      id: null,
      naam: opKey(ctx.leveranciers, k.leverancier)?.naam || "",
      herken: factuurNummers(),
      leverancier: null, rekening: null, btwCode: null, betaaltermijn: k.termijn || 30,
      tabel: { begin: "", eind: "", voorbeeld: "", labels: [], kolommen: null, vervolg: true, scheiding: " ", negeer: [], paginaEinde: [] },
    };
    sj.herken = (sj.herken || []).filter((n) => !eigen.has(P.ibanNorm(n)));
    sj.tabel = Object.assign({ begin: "", eind: "", voorbeeld: "", labels: [], kolommen: null, vervolg: true, scheiding: " ", negeer: [], paginaEinde: [] }, sj.tabel || {});
    const T = sj.tabel;
    // Instellingen: bij een nieuw sjabloon de huidige keuzes
    let levKey = (sj.leverancier && (opKey(ctx.leveranciers, sj.leverancier.key) || zoekOpNaam(ctx.leveranciers, sj.leverancier.naam))?.key) || k.leverancier || "";
    let rekKey = (sj.rekening && (opKey(ctx.rekeningen, sj.rekening.key) || zoekOpNaam(ctx.rekeningen, sj.rekening.naam))?.key) || k.rekening || "";
    let btwKey = (sj.btwCode && (opKey(ctx.btwCodes, sj.btwCode.key) || zoekOpNaam(ctx.btwCodes, sj.btwCode.naam))?.key) || k.btwCode || "";
    let stap = !T.begin ? "begin" : !T.voorbeeld ? "voorbeeld" : "negeer";

    const dialoog = el("div", { class: "pi-overlay" });
    const lijnenVak = el("div", { class: "pi-lijnen" });
    const zijkant = el("div", { class: "pi-zijkant" });
    const sluit = () => { dialoog.remove(); document.removeEventListener("keydown", opEsc); };
    const opEsc = (e) => { if (e.key === "Escape") sluit(); };
    document.addEventListener("keydown", opEsc);

    const stappen = [
      ["begin", "1. Kopregel van de tabel"],
      ["eind", "2. Regel ná de laatste factuurregel"],
      ["voorbeeld", "3. Voorbeeld-factuurregel"],
      ["negeer", "Regels negeren"],
      ["pagina", "Paginawissel"],
    ];
    const uitleg = {
      begin: "Klik op de kopregel van de tabel met factuurregels (bijv. \"Omschrijving Aantal Prijs Bedrag\").",
      eind: "Klik op de eerste regel ná de laatste factuurregel (bijv. de regel met het subtotaal). Geen duidelijke eindregel? Dan loopt de tabel tot het einde van de PDF.",
      voorbeeld: "Klik op een gewone factuurregel. Geef daarna bij elk stukje aan wat het is.",
      negeer: "Klik op regels die niet in de omschrijving horen (bijv. \"Bewerkingen :\"). Alle regels die zo beginnen worden overgeslagen.",
      pagina: "Klik op de eerste regel van een paginawissel (bijv. \"Transportbedrag:\"). Alles daarna tot de volgende factuurregel wordt overgeslagen. Kop- en voetteksten die op elke pagina terugkomen worden al automatisch overgeslagen.",
    };

    function bereken() {
      if (T.voorbeeld && T.labels.length) T.kolommen = P.kolommenUitLabels(T.voorbeeld, T.labels);
      else T.kolommen = null;
      return P.leesTabel(S.lijnen, T);
    }

    function klikLijn(i) {
      const t = S.lijnen[i].t;
      if (stap === "begin") { T.begin = t; stap = T.eind ? (T.voorbeeld ? "negeer" : "voorbeeld") : "eind"; }
      else if (stap === "eind") { T.eind = t; stap = T.voorbeeld ? "negeer" : "voorbeeld"; }
      else if (stap === "voorbeeld") { T.voorbeeld = t; T.labels = P.raadLabels(P.tokens(t)); stap = "negeer"; }
      else if (stap === "negeer" || stap === "pagina") {
        const p = prompt(stap === "negeer" ? "Regels negeren die beginnen met:" : "Paginawissel begint bij regels die beginnen met:", voorstelPrefix(t));
        if (!p || !p.trim()) return;
        (stap === "negeer" ? T.negeer : T.paginaEinde).push(p.trim());
      }
      teken();
    }

    function teken() {
      const res = bereken();
      // Lijnen
      vervang(lijnenVak, );
      let pagina = null;
      S.lijnen.forEach((l, i) => {
        if (l.p !== pagina) { pagina = l.p; lijnenVak.append(el("div", { class: "pi-pagina" }, "pagina " + pagina)); }
        const st = res.status[i];
        const extra = (T.voorbeeld && l.t === T.voorbeeld ? " pi-l-voorbeeld" : "") + (T.eind && l.t === T.eind ? " pi-l-eind" : "");
        lijnenVak.append(el("div", { class: "pi-l pi-l-" + st + extra, title: STATUSUITLEG[st] || "", onclick: () => klikLijn(i) }, l.t));
      });

      // Zijkant
      const som = res.regels.reduce((t, r) => t + P.centen(r.bedrag), 0) / 100;
      const excl = S.r.totaalExcl;
      const klopt = excl != null && res.regels.length && P.centen(som) === P.centen(excl);

      const lijstMetWeg = (lijst) => el("div", { class: "pi-chips" }, lijst.length ? lijst.map((p, i) => el("span", { class: "pi-chip" }, p,
        el("button", { type: "button", class: "pi-chip-weg", title: "Verwijderen", onclick: () => { lijst.splice(i, 1); teken(); } }, "×"))) : el("span", { class: "pi-zacht pi-klein" }, "geen"));

      const tokens = T.voorbeeld ? P.tokens(T.voorbeeld) : [];
      while (T.labels.length < tokens.length) T.labels.push("omschrijving");
      T.labels.length = tokens.length;
      const heeftBedrag = T.labels.includes("bedrag") || (T.labels.includes("aantal") && T.labels.includes("prijs"));

      const herkenKeuzes = [...new Set([...(sj.herken || []), ...(S.r.nummers || [])])];

      vervang(zijkant, 
        el("div", { class: "pi-stappen" }, stappen.map(([s, label]) => el("button", { type: "button", class: "pi-stap" + (stap === s ? " pi-actief" : ""), onclick: () => { stap = s; teken(); } }, label))),
        el("div", { class: "pi-uitleg" }, uitleg[stap]),

        el("div", { class: "pi-blok" },
          el("div", { class: "pi-blokkop" }, "Tabel"),
          el("div", { class: "pi-klein" }, el("b", {}, "Kop: "), T.begin || el("i", { class: "pi-zacht" }, "nog niet gekozen")),
          el("div", { class: "pi-klein" }, el("b", {}, "Einde: "), T.eind || el("i", { class: "pi-zacht" }, "einde van de PDF"),
            T.eind ? el("button", { type: "button", class: "pi-link", style: "margin-left:.5rem", onclick: () => { T.eind = ""; teken(); } }, "wissen") : null)),

        el("div", { class: "pi-blok" },
          el("div", { class: "pi-blokkop" }, "Voorbeeldregel"),
          tokens.length ? el("div", { class: "pi-tokens" }, tokens.map((tok, i) => el("div", { class: "pi-token pi-token-" + T.labels[i] },
            el("div", { class: "pi-token-tekst" }, tok),
            select(P.VELDEN.map((v) => ({ key: v, naam: LABELNAMEN[v] })), T.labels[i], null, (v) => { T.labels[i] = v; teken(); }, { class: "pi-invoer pi-token-keuze" }))))
            : el("div", { class: "pi-zacht pi-klein" }, "Nog niet gekozen (stap 3)."),
          tokens.length && !heeftBedrag ? el("div", { class: "pi-klein pi-tekst-fout" }, "Geef een bedrag aan, of een aantal én een prijs.") : null,
          el("div", { class: "pi-klein pi-zacht" }, "Getallen worden van rechts gelezen; de omschrijving mag in elke regel een andere lengte hebben.")),

        el("div", { class: "pi-blok" },
          el("div", { class: "pi-blokkop" }, "Regels onder een factuurregel"),
          el("label", { class: "pi-check" }, el("input", { type: "checkbox", checked: T.vervolg, onchange: (e) => { T.vervolg = e.target.checked; teken(); } }), " horen bij de omschrijving"),
          T.vervolg ? el("label", { class: "pi-klein" }, "Scheiding: ",
            select([{ key: " ", naam: "spatie" }, { key: ", ", naam: "komma" }, { key: " - ", naam: "streepje" }, { key: "\n", naam: "nieuwe regel" }], T.scheiding, null, (v) => { T.scheiding = v; teken(); }, { class: "pi-invoer pi-smal" })) : null,
          el("div", { class: "pi-klein" }, el("b", {}, "Negeren: "), lijstMetWeg(T.negeer)),
          el("div", { class: "pi-klein" }, el("b", {}, "Paginawissel: "), lijstMetWeg(T.paginaEinde))),

        el("div", { class: "pi-blok" },
          el("div", { class: "pi-blokkop" }, "Controle"),
          el("div", { class: "pi-controle " + (klopt ? "pi-goed" : "pi-fout-rij") },
            `${res.regels.length} regels, som ${euro(som)}`, el("br"), `Totaal excl. btw volgens factuur: ${euro(excl)}`, el("br"), klopt ? "✔ Klopt" : "✖ Klopt niet"),
          res.regels.length ? el("div", { class: "pi-voorbeeldvak" }, el("table", { class: "pi-tabel pi-klein" },
            el("tbody", {}, res.regels.map((r) => el("tr", {}, el("td", {}, r.omschrijving), el("td", { class: "pi-num" }, getalTekst(r.aantal)), el("td", { class: "pi-num" }, euro(r.prijs)), el("td", { class: "pi-num" }, euro(r.bedrag))))))) : null),

        el("div", { class: "pi-blok" },
          el("div", { class: "pi-blokkop" }, "Sjabloon"),
          el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Naam"), el("input", { class: "pi-invoer", value: sj.naam, onchange: (e) => { sj.naam = e.target.value; } })),
          el("div", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Herkennen aan (btw-nummer, IBAN of tekst)"),
            el("div", {}, herkenKeuzes.map((n) => el("label", { class: "pi-check pi-klein" },
              el("input", { type: "checkbox", checked: (sj.herken || []).includes(n), onchange: (e) => { sj.herken = (sj.herken || []).filter((x) => x !== n); if (e.target.checked) sj.herken.push(n); } }),
              " " + n + (eigen.has(n) ? " (eigen nummer!)" : "")))),
            el("input", { class: "pi-invoer", placeholder: "extra tekst, bijv. www.leverancier.nl", onchange: (e) => { const v = e.target.value.trim(); if (v) { sj.herken = [...(sj.herken || []), v]; teken(); } } })),
          el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Leverancier"), select(ctx.leveranciers, levKey, "— kies —", (v) => { levKey = v; })),
          el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Grootboekrekening"), select(ctx.rekeningen, rekKey, "— kies —", (v) => { rekKey = v; })),
          el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Btw-code"), select(ctx.btwCodes, btwKey, "— automatisch —", (v) => { btwKey = v; })),
          el("label", { class: "pi-veld" }, el("span", { class: "pi-label" }, "Betaaltermijn (dagen)"), el("input", { class: "pi-invoer", type: "number", min: "0", value: sj.betaaltermijn || "", onchange: (e) => { sj.betaaltermijn = parseInt(e.target.value, 10) || null; } }))),

        el("div", { class: "pi-acties" },
          el("button", { type: "button", class: "pi-knop pi-primair", onclick: opslaan }, "Sjabloon opslaan"),
          sj.id ? el("button", { type: "button", class: "pi-knop pi-gevaar", onclick: verwijder }, "Verwijderen") : null,
          el("button", { type: "button", class: "pi-knop", onclick: sluit }, "Sluiten")));
    }

    async function opslaan() {
      if (!T.begin) return alert("Kies eerst de kopregel van de tabel (stap 1).");
      if (!T.voorbeeld || !T.kolommen) return alert("Kies eerst een voorbeeld-factuurregel (stap 3).");
      if (!(T.labels.includes("bedrag") || (T.labels.includes("aantal") && T.labels.includes("prijs")))) return alert("Geef in de voorbeeldregel een bedrag aan, of een aantal én een prijs.");
      if (!sj.naam || !sj.naam.trim()) return alert("Geef het sjabloon een naam.");
      if (!(sj.herken || []).length && !confirm("Er is niets gekozen om de leverancier aan te herkennen; het sjabloon wordt dan nooit automatisch gebruikt. Toch opslaan?")) return;
      const naamVan = (lijst, key) => { const x = opKey(lijst, key); return x ? { key: x.key, naam: x.naam } : null; };
      sj.leverancier = naamVan(ctx.leveranciers, levKey);
      sj.rekening = naamVan(ctx.rekeningen, rekKey);
      sj.btwCode = naamVan(ctx.btwCodes, btwKey);
      try {
        await bewaarOpServer({ actie: "opslaan", sjabloon: sj });
        sluit();
        analyseer(true);
        inhoud.prepend(melding("ok", `Sjabloon "${sj.naam}" opgeslagen.`));
      } catch (e) { alert("Opslaan mislukt: " + e.message); }
    }

    async function verwijder() {
      if (!confirm(`Sjabloon "${sj.naam}" verwijderen?`)) return;
      try {
        await bewaarOpServer({ actie: "verwijderen", id: sj.id });
        sluit();
        analyseer(true);
        inhoud.prepend(melding("ok", `Sjabloon "${sj.naam}" verwijderd.`));
      } catch (e) { alert("Verwijderen mislukt: " + e.message); }
    }

    dialoog.append(el("div", { class: "pi-dialoog" },
      el("div", { class: "pi-dialoog-kop" }, el("strong", {}, bestaand ? `Sjabloon bewerken: ${bestaand.naam}` : "Sjabloon maken"),
        el("span", { class: "pi-ruimte" }),
        el("span", { class: "pi-legenda pi-klein" },
          el("span", { class: "pi-l pi-l-kop" }, "kop"), el("span", { class: "pi-l pi-l-rij" }, "factuurregel"), el("span", { class: "pi-l pi-l-vervolg" }, "omschrijving"),
          el("span", { class: "pi-l pi-l-negeer" }, "genegeerd"), el("span", { class: "pi-l pi-l-pagina" }, "paginawissel"), el("span", { class: "pi-l pi-l-eind" }, "einde"))),
      el("div", { class: "pi-maker" }, lijnenVak, zijkant)));
    document.body.append(dialoog);
    teken();
  }
})();
