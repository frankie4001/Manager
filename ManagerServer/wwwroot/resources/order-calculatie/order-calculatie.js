/* Calculatie op de verkooporder (Eigen aanpassing).
 *
 * Inklapbaar blok boven het verkooporderformulier:
 *  - inkoopkosten: regels van inkoopfacturen met deze order in het eigen veld "Verkooporder"
 *  - extra kosten: zelf toe te voegen regels (omschrijving, aantal, prijs)
 *  - opslag % per order en de berekende verkoopprijs (alleen getoond)
 * Extra kosten, opslag en uitgezette inkoopregels worden bewaard in het verborgen eigen veld
 * "Calculatie" van de order en dus opgeslagen met "Aanmaken"/"Bijwerken".
 */
(function () {
  "use strict";
  // replaceChildren zonder lege waarden (null/false) en met geneste lijsten
  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const script = document.getElementById("order-calculatie-script");
  const formulier = document.getElementById("v-model-form");
  if (!script || !formulier || !window.app || document.getElementById("order-calculatie")) return;
  const app = window.app;
  const DATA_URL = script.dataset.url;

  // ---------- hulpjes ----------
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "open") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  const rond = (n) => Math.round((Number(n) || 0) * 100 + 1e-9) / 100;
  const euro = (n) => "€ " + rond(n).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (isFinite(n) ? n.toLocaleString("nl-NL", { maximumFractionDigits: 1 }) + "%" : "—");
  // "1.234,5" / "1234.5" / "12" -> getal; leeg -> null
  function leesGetal(s) {
    s = String(s == null ? "" : s).trim().replace(/\s|€/g, "");
    if (!s) return null;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  const getalTekst = (n) => (n == null ? "" : String(n).replace(".", ","));
  const datumNl = (d) => (d ? d.split("-").reverse().join("-") : "");

  // ---------- toestand ----------
  let gegevens = null;   // {veld, veldNaam, verkooporderVeldGevonden, inkoop[]}
  let fout = null;
  let bezig = false;
  let calc = { v: 1, opslag: null, extra: [], uit: [], orders: [] };
  let calcRest = {};
  const open_facturen = new Set(); // uitgeklapte inkoopfacturen (alleen in dit scherm)

  function leesCalculatie() {
    const s = gegevens && gegevens.veld && app.CustomFields2 && app.CustomFields2.Strings ? app.CustomFields2.Strings[gegevens.veld] : null;
    calc = { v: 1, opslag: null, extra: [], uit: [] };
    calcRest = {};
    if (!s) return;
    try {
      const o = JSON.parse(s);
      // Overige gegevens (bijv. "samenvoeging": herkomst van regels) ongewijzigd bewaren
      for (const [k, v] of Object.entries(o)) if (!["v", "opslag", "extra", "uit", "orders"].includes(k)) calcRest[k] = v;
      calc.opslag = typeof o.opslag === "number" ? o.opslag : null;
      calc.extra = Array.isArray(o.extra) ? o.extra.map((x) => ({ oms: String(x.oms || ""), aantal: typeof x.aantal === "number" ? x.aantal : 1, prijs: typeof x.prijs === "number" ? x.prijs : 0 })) : [];
      calc.uit = Array.isArray(o.uit) ? o.uit.map(String) : [];
    } catch (e) { /* ongeldige inhoud: opnieuw beginnen */ }
  }

  // Calculatie terugschrijven in het (verborgen) eigen veld van de order
  function bewaar() {
    if (!gegevens || !gegevens.veld) return;
    if (!app.CustomFields2) app.CustomFields2 = { Strings: {} };
    if (!app.CustomFields2.Strings) app.$set(app.CustomFields2, "Strings", {});
    const extra = calc.extra.filter((x) => x.oms || x.prijs);
    const leeg = calc.opslag == null && !extra.length && !calc.uit.length && !Object.keys(calcRest).length;
    app.$set(app.CustomFields2.Strings, gegevens.veld, leeg ? "" : JSON.stringify({ ...calcRest, v: 1, opslag: calc.opslag, extra, uit: calc.uit }));
    gewijzigd = true;
  }
  let gewijzigd = false;

  // Het eigen veld "Calculatie" niet als tekstvak in het formulier tonen
  function verbergVeld() {
    if (!gegevens || !gegevens.veldNaam) return;
    for (const g of formulier.querySelectorAll(".form-group")) {
      const label = g.querySelector("label");
      if (label && label.textContent.trim() === gegevens.veldNaam && g.style.display !== "none") g.style.display = "none";
    }
  }
  new MutationObserver(verbergVeld).observe(formulier, { childList: true, subtree: true });

  // ---------- bedragen ----------
  function orderBedrag() {
    let som = 0;
    for (const l of app.Lines || []) {
      const qty = l.Qty == null ? 1 : Number(l.Qty) || 0;
      let b = rond(qty * (Number(l.SalesUnitPrice) || 0));
      if (app.Discount) {
        if (app.DiscountType === 0) b = rond(b * (1 - (Number(l.DiscountPercentage) || 0) / 100));
        else b -= Number(l.DiscountAmount) || 0;
      }
      if (app.AmountsIncludeTax && l.TaxCode && Array.isArray(l.TaxCode.Rates)) {
        const r = l.TaxCode.Rates.reduce((t, x) => t + x, 0);
        if (r) b = rond(b / (1 + r / 100));
      }
      som += b;
    }
    return rond(som);
  }
  function totalen() {
    const inkoop = (gegevens ? gegevens.inkoop : []).filter((x) => !calc.uit.includes(x.id)).reduce((t, x) => t + x.bedrag, 0);
    const extra = calc.extra.reduce((t, x) => t + rond((x.aantal ?? 1) * (x.prijs || 0)), 0)
      + subExtra().reduce((t, x) => t + rond((x.aantal ?? 1) * (x.prijs || 0)), 0);
    const kosten = rond(inkoop + extra);
    const verkoop = calc.opslag == null ? null : rond(kosten * (1 + calc.opslag / 100));
    const order = orderBedrag();
    return { inkoop: rond(inkoop), extra: rond(extra), kosten, verkoop, order, winst: rond(order - kosten) };
  }

  // Extra kosten die op de samengevoegde (oude) orders waren ingevuld
  function subExtra() {
    const uit = [];
    for (const o of (gegevens && gegevens.samengevoegdUit) || []) for (const x of o.extra || [])
      uit.push({ order: o.referentie, oms: String(x.oms || ""), aantal: typeof x.aantal === "number" ? x.aantal : 1, prijs: typeof x.prijs === "number" ? x.prijs : 0 });
    return uit;
  }
  const meerdereOrders = () => ((gegevens && gegevens.samengevoegdUit) || []).length > 0;

  // ---------- scherm ----------
  const OPEN_KEY = "order-calculatie-open";
  let open = false;
  try { open = localStorage.getItem(OPEN_KEY) === "1"; } catch (e) { /* geen opslag */ }
  const samenvatting = el("span", { class: "oc-samenvatting" });
  const inhoud = el("div", { class: "oc-inhoud" });
  const blok = el("details", { id: "order-calculatie", class: "oc", open },
    el("summary", { class: "oc-kop" }, el("span", { class: "oc-titel" }, "Calculatie"), samenvatting), inhoud);
  blok.addEventListener("toggle", () => { try { localStorage.setItem(OPEN_KEY, blok.open ? "1" : "0"); } catch (e) { /* */ } });
  formulier.parentNode.insertBefore(blok, formulier);

  function tekenSamenvatting() {
    const t = totalen();
    const delen = [`kosten ${euro(t.kosten)}`];
    if (t.verkoop != null) delen.push(`verkoopprijs ${euro(t.verkoop)} (+${pct(calc.opslag)})`);
    if (t.order) delen.push(`order ${euro(t.order)}, winst ${euro(t.winst)}` + (t.kosten ? ` (${pct((t.winst / t.kosten) * 100)})` : ""));
    vervang(samenvatting, bezig ? "laden…" : delen.join(" · "));
    samenvatting.className = "oc-samenvatting" + (t.order && t.kosten && t.winst < 0 ? " oc-rood" : "");
  }

  function teken() {
    tekenSamenvatting();
    if (fout) { vervang(inhoud, el("div", { class: "oc-melding oc-fout" }, "Calculatie kon niet worden geladen: " + fout)); return; }
    if (!gegevens) { vervang(inhoud, el("div", { class: "oc-zacht" }, "Laden…")); return; }
    const t = totalen();
    const meldingen = [];
    if (!gegevens.veld) meldingen.push(el("div", { class: "oc-melding oc-let" },
      `Om extra kosten en de opslag bij de order te bewaren is een eigen veld "${gegevens.veldNaam}" voor verkooporders nodig. `,
      el("button", { type: "button", class: "oc-knop", onclick: veldAanmaken }, "Veld aanmaken")));
    if (!gegevens.verkooporderVeldGevonden) meldingen.push(el("div", { class: "oc-melding oc-let" },
      "Er is geen eigen veld \"Verkooporder\" voor inkoopfacturen (of de regels daarvan) gevonden; inkoopkosten kunnen niet aan de order worden gekoppeld."));
    if (gegevens.samengevoegdIn) meldingen.push(el("div", { class: "oc-melding oc-let" },
      `Deze order is samengevoegd in order ${gegevens.samengevoegdIn.referentie}; de kosten tellen daar mee. `,
      gegevens.samengevoegdIn.url ? el("a", { href: gegevens.samengevoegdIn.url }, "Order " + gegevens.samengevoegdIn.referentie + " openen") : null,
      gegevens.samengevoegdIn.gefactureerd ? null : [" · ", el("a", { href: gegevens.samenvoegPagina }, "uit samenvoeging halen")]));
    if ((gegevens.samengevoegdUit || []).length) meldingen.push(el("div", { class: "oc-melding oc-info" },
      "Samengevoegd uit order ", gegevens.samengevoegdUit.map((o, i) => [i ? ", " : "", el("a", { href: o.url, title: o.in && o.in !== app.Reference ? "via order " + o.in : null }, o.referentie)]),
      " — hun inkoop- en extra kosten tellen hier automatisch mee.", gegevens.gefactureerd ? null : [" ", el("a", { href: gegevens.samenvoegPagina }, "Samenvoeging beheren")]));
    if (!app.Reference) meldingen.push(el("div", { class: "oc-melding oc-zacht" }, "Inkoopkosten worden gezocht op de referentie van de order; die is nog leeg."));

    // Inkoop, per inkoopfactuur; uitklappen toont de regels
    const facturen = [];
    for (const x of gegevens.inkoop) {
      let f = facturen.find((g) => g.factuur === x.factuur);
      if (!f) facturen.push((f = { factuur: x.factuur, regels: [] }));
      f.regels.push(x);
    }
    const zetAan = (ids, aan) => {
      calc.uit = calc.uit.filter((i) => !ids.includes(i));
      if (!aan) calc.uit.push(...ids);
      bewaar(); teken();
    };
    const inkoopRegels = [];
    for (const f of facturen) {
      const x0 = f.regels[0], ids = f.regels.map((x) => x.id);
      const aanTal = f.regels.filter((x) => !calc.uit.includes(x.id)).length;
      const bedrag = f.regels.filter((x) => !calc.uit.includes(x.id)).reduce((t, x) => t + x.bedrag, 0);
      const uitgeklapt = open_facturen.has(f.factuur);
      const vink = el("input", { type: "checkbox", checked: aanTal > 0, title: "Meetellen", onchange: (e) => zetAan(ids, e.target.checked) });
      vink.indeterminate = aanTal > 0 && aanTal < ids.length;
      inkoopRegels.push(el("tr", { class: "oc-factuur" + (aanTal ? "" : " oc-uit") },
        el("td", {}, vink),
        el("td", { class: "oc-nowrap" }, datumNl(x0.datum)),
        el("td", { class: "oc-nowrap" }, el("a", { href: x0.url, target: "_blank", title: "Inkoopfactuur openen" }, x0.referentie || "—")),
        el("td", {}, x0.leverancier),
        el("td", { class: "oc-nowrap" }, x0.factuurnummer || ""),
        meerdereOrders() ? el("td", { class: "oc-nowrap" }, [...new Set(f.regels.map((x) => x.order))].join(", ")) : null,
        el("td", {}, f.regels.length === 1 ? x0.omschrijving : el("button", { type: "button", class: "oc-link oc-link-los", onclick: () => {
          if (uitgeklapt) open_facturen.delete(f.factuur); else open_facturen.add(f.factuur);
          teken();
        } }, (uitgeklapt ? "▾ " : "▸ ") + `${f.regels.length} regels` + (aanTal < ids.length && aanTal ? ` (${aanTal} meegeteld)` : ""))),
        el("td", { class: "oc-num" }, euro(bedrag))));
      if (uitgeklapt && f.regels.length > 1) for (const x of f.regels) {
        const aan = !calc.uit.includes(x.id);
        inkoopRegels.push(el("tr", { class: "oc-detail" + (aan ? "" : " oc-uit") },
          el("td"), el("td", { class: "oc-rechts" }, el("input", { type: "checkbox", checked: aan, title: "Meetellen", onchange: (e) => zetAan([x.id], e.target.checked) })),
          el("td", { colspan: 3 }), meerdereOrders() ? el("td", {}, x.order) : null, el("td", {}, x.omschrijving), el("td", { class: "oc-num" }, euro(x.bedrag))));
      }
    }

    // Extra kosten
    const extraRegels = calc.extra.map((x, i) => el("tr", {},
      el("td", {}, el("input", { class: "oc-invoer oc-breed", value: x.oms, placeholder: "bijv. Arbeid, Transport", onchange: (e) => { x.oms = e.target.value; bewaar(); tekenSamenvatting(); } })),
      el("td", {}, el("input", { class: "oc-invoer oc-getal", value: getalTekst(x.aantal), inputmode: "decimal", onchange: (e) => { x.aantal = leesGetal(e.target.value) ?? 1; bewaar(); teken(); } })),
      el("td", {}, el("input", { class: "oc-invoer oc-getal", value: getalTekst(x.prijs), inputmode: "decimal", onchange: (e) => { x.prijs = leesGetal(e.target.value) ?? 0; bewaar(); teken(); } })),
      el("td", { class: "oc-num" }, euro((x.aantal ?? 1) * (x.prijs || 0))),
      el("td", {}, el("button", { type: "button", class: "oc-weg", title: "Regel verwijderen", onclick: () => { calc.extra.splice(i, 1); bewaar(); teken(); } }, "×"))));

    const opslagInvoer = el("input", { class: "oc-invoer oc-getal", value: getalTekst(calc.opslag), inputmode: "decimal", placeholder: "0",
      onchange: (e) => { calc.opslag = leesGetal(e.target.value); bewaar(); teken(); } });

    vervang(inhoud, 
      ...meldingen,
      el("div", { class: "oc-sectie" }, "Inkoop", el("span", { class: "oc-zacht oc-klein" }, ` — inkoopfacturen met verkooporder ${[app.Reference || "…", ...((gegevens.samengevoegdUit || []).map((o) => o.referentie))].join(", ")}`),
        el("button", { type: "button", class: "oc-link", title: "Opnieuw zoeken", onclick: laad }, "vernieuwen")),
      gegevens.inkoop.length
        ? el("div", { class: "oc-tabelvak" }, el("table", { class: "oc-tabel" },
          el("thead", {}, el("tr", {}, el("th"), el("th", {}, "Datum"), el("th", { title: "Volgnummer (referentie) van de inkoopfactuur in Manager" }, "Volgnr."), el("th", {}, "Leverancier"),
            el("th", {}, "Factuurnr."), meerdereOrders() ? el("th", { title: "Verkooporder waarop de inkoop is geboekt" }, "Order") : null, el("th", {}, "Omschrijving"), el("th", { class: "oc-num" }, "Bedrag"))),
          el("tbody", {}, inkoopRegels),
          el("tfoot", {}, el("tr", {}, el("td", { colspan: meerdereOrders() ? 7 : 6 }, "Subtotaal inkoop"), el("td", { class: "oc-num" }, euro(t.inkoop))))))
        : el("div", { class: "oc-zacht oc-klein" }, "Nog geen inkoopfacturen gekoppeld aan deze order."),

      el("div", { class: "oc-sectie" }, "Extra kosten"),
      el("div", { class: "oc-tabelvak" }, el("table", { class: "oc-tabel" },
        calc.extra.length || subExtra().length ? el("thead", {}, el("tr", {}, el("th", {}, "Omschrijving"), el("th", { class: "oc-num" }, "Aantal"), el("th", { class: "oc-num" }, "Prijs"), el("th", { class: "oc-num" }, "Bedrag"), el("th"))) : null,
        el("tbody", {}, extraRegels, subExtra().map((x) => el("tr", { class: "oc-sub" },
          el("td", {}, el("span", { class: "oc-order", title: "Uit samengevoegde order" }, x.order), " ", x.oms),
          el("td", { class: "oc-num" }, getalTekst(x.aantal)), el("td", { class: "oc-num" }, euro(x.prijs)),
          el("td", { class: "oc-num" }, euro((x.aantal ?? 1) * (x.prijs || 0))), el("td")))),
        el("tfoot", {}, el("tr", {},
          el("td", {}, el("button", { type: "button", class: "oc-knop", onclick: () => { calc.extra.push({ oms: "", aantal: 1, prijs: 0 }); bewaar(); teken(); const i = inhoud.querySelectorAll(".oc-breed"); if (i.length) i[i.length - 1].focus(); } }, "+ regel")),
          el("td", { colspan: 2 }, calc.extra.length || subExtra().length ? "Subtotaal extra" : ""), el("td", { class: "oc-num" }, calc.extra.length || subExtra().length ? euro(t.extra) : ""), el("td"))))),

      el("div", { class: "oc-totaal" },
        el("div", {}, el("span", {}, "Totale kosten"), el("strong", {}, euro(t.kosten))),
        el("div", {}, el("label", {}, "Opslag ", opslagInvoer, " %"), el("span", {}, t.verkoop != null ? "→ verkoopprijs" : ""), el("strong", { class: "oc-groot" }, t.verkoop != null ? euro(t.verkoop) : "—")),
        el("div", { class: "oc-zacht" }, el("span", {}, "Huidig orderbedrag (excl. btw)"), el("span", {}, euro(t.order))),
        t.order ? el("div", { class: t.winst < 0 ? "oc-rood" : "oc-groen" }, el("span", {}, "Winst op huidig orderbedrag"),
          el("span", {}, euro(t.winst) + (t.kosten ? ` · ${pct((t.winst / t.kosten) * 100)} op kosten` : "") + ` · ${pct((t.winst / t.order) * 100)} marge`)) : null),
      gegevens.veld ? el("div", { class: "oc-zacht oc-klein" }, "Extra kosten en opslag worden bij de order bewaard met \"Aanmaken\" / \"Bijwerken\".") : null);
  }

  // ---------- server ----------
  async function post(body) {
    const r = await fetch(DATA_URL, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
    return r.json();
  }
  async function laad() {
    bezig = true; tekenSamenvatting();
    try {
      const eerste = !gegevens;
      gegevens = await post({ actie: "gegevens", referentie: app.Reference || "", order: script.dataset.order || null });
      fout = null;
      if (eerste) leesCalculatie();
      verbergVeld();
    } catch (e) { fout = e.message; }
    bezig = false;
    teken();
  }
  async function veldAanmaken() {
    try {
      gegevens = await post({ actie: "veld-aanmaken", referentie: app.Reference || "", order: script.dataset.order || null });
      leesCalculatie();
      bewaar();
      teken();
    } catch (e) { alert("Veld aanmaken mislukt: " + e.message); }
  }

  // Opnieuw zoeken als de referentie verandert; bedragen bijwerken als de orderregels veranderen
  let wacht = null;
  app.$watch("Reference", () => { clearTimeout(wacht); wacht = setTimeout(laad, 600); });
  app.$watch(() => JSON.stringify([app.Lines, app.Discount, app.DiscountType, app.AmountsIncludeTax]), () => { if (gegevens) teken(); });

  teken();
  laad();
})();
