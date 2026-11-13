/* PDF-inkoopfactuur inlezen: parser (Eigen aanpassing).
 *
 * Zet de tekst van een PDF om in factuurgegevens:
 *  - algemene herkenning zonder sjabloon (factuurnummer, datum, totalen, btw, IBAN, btw-nummer)
 *  - factuurregels via een sjabloon (tabel begin/eind + een gelabelde voorbeeldregel)
 *
 * Werkt in de browser (window.PdfImportParser) en in Node (module.exports) voor tests.
 */
(function (root) {
  "use strict";

  // ---------- getallen ----------

  // '1.234,56' -> 1234.56, '-5,00' / '5,00-' -> -5, '1,234.56' -> 1234.56. Geen getal -> null.
  function getal(s) {
    s = String(s == null ? "" : s).trim();
    let neg = false;
    if (/^-/.test(s)) { neg = true; s = s.slice(1); }
    else if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
    const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
    let n;
    if (lc >= 0 && ld >= 0) n = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (lc >= 0) n = (s.match(/,/g).length > 1) ? s.replace(/,/g, "") : s.replace(",", ".");
    else if (ld >= 0) {
      const delen = s.split(".");
      n = (delen.length > 2 || delen[delen.length - 1].length === 3) ? s.replace(/\./g, "") : s;
    } else n = s;
    if (!/^\d+(\.\d+)?$/.test(n)) return null;
    const v = Number(n);
    return neg ? -v : v;
  }
  // Een bedrag heeft precies twee decimalen (geen aantallen, nummers of percentages)
  function isBedrag(s) { return /^-?\d[\d.,]*[.,]\d{2}-?$/.test(s) && getal(s) != null; }
  const centen = (n) => Math.round(n * 100);
  // Afronden op hele centen, half weg van nul
  const rondCent = (x) => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
  const rond2 = (n) => Math.round(n * 100 + (n >= 0 ? 1e-9 : -1e-9)) / 100;

  // ---------- tekst uit pdf.js ----------

  // Zet de tekstitems van één pagina om naar regels {t, y, p}. Zelfde y-positie = zelfde regel.
  // Vetgedrukte tekst die dubbel in de PDF staat (zelfde tekst op dezelfde plek) telt één keer.
  function itemsNaarRegels(items, pagina) {
    const rijen = [];
    for (const it of items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5];
      const h = it.height || Math.abs(it.transform[3]) || Math.abs(it.transform[0]);
      let rij = rijen.find((r) => Math.abs(r.y - y) < 3);
      if (!rij) {
        if (!it.str.trim()) continue;
        rijen.push((rij = { y, delen: [] }));
      }
      if (rij.delen.some((d) => d.s === it.str && Math.abs(d.x - x) < 1)) continue;
      rij.delen.push({ x, s: it.str, w: it.width, h });
    }
    rijen.sort((a, b) => b.y - a.y);
    return rijen.map((r) => {
      let uit = "", eind = null, spatie = false;
      for (const d of r.delen.sort((a, b) => a.x - b.x)) {
        if (!d.s.trim()) { spatie = true; continue; }
        const gat = eind == null ? 0 : d.x - eind;
        if (uit && (spatie || /^\s/.test(d.s) || /\s$/.test(uit) || gat > 0.15 * (d.h || 10))) uit += " ";
        uit += d.s.trim();
        eind = d.x + (d.w || 0);
        spatie = /\s$/.test(d.s);
      }
      return { t: uit.replace(/\s+/g, " ").trim(), y: Math.round(r.y * 10) / 10, p: pagina };
    }).filter((l) => l.t);
  }

  // ---------- hulpjes ----------

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const cijfersWeg = (s) => norm(s).replace(/\d+/g, "#");

  // Woorden van een regel; valutatekens vallen weg, '€ -5,00' en '-€ 5,00' worden '-5,00'.
  function tokens(t) {
    return String(t || "")
      .replace(/-\s*(€|EUR)\s*/gi, "-")
      .replace(/(€|EUR)\s*-/gi, "-")
      .split(/\s+/)
      .map((s) => s.replace(/^(€|EUR)(?=[-\d])/i, ""))
      .filter((s) => s && !/^(€|EUR)$/i.test(s));
  }
  const soortVan = (tok) => (getal(tok) != null ? "getal" : "tekst");

  // ---------- IBAN, btw-nummer, KvK ----------

  const ibanNorm = (w) => String(w || "").replace(/\s+/g, "").toUpperCase();
  function ibanGeldig(iban) {
    iban = ibanNorm(iban);
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
    const omgezet = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55);
    let rest = 0;
    for (const c of omgezet) rest = (rest * 10 + Number(c)) % 97;
    return rest === 1;
  }

  // Alle herkenningsnummers in de tekst: IBAN's (met geldig controlegetal) en btw-nummers.
  function nummers(tekst) {
    const ibans = [], btw = [];
    const voegToe = (lijst, w) => { if (!lijst.includes(w)) lijst.push(w); };
    const t = String(tekst || "").toUpperCase();
    for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g)) {
      // Langste geldige IBAN aan het begin van de treffer
      const ruw = ibanNorm(m[0]);
      for (let len = Math.min(ruw.length, 34); len >= 14; len--) {
        if (ibanGeldig(ruw.slice(0, len))) { voegToe(ibans, ruw.slice(0, len)); break; }
      }
    }
    for (const m of t.matchAll(/\bNL ?(\d{3}) ?(\d{3}) ?(\d{3}) ?B ?(\d{2})\b/g)) voegToe(btw, "NL" + m[1] + m[2] + m[3] + "B" + m[4]);
    for (const m of t.matchAll(/\bBE ?(0?\d{3})[ .]?(\d{3})[ .]?(\d{3})\b/g)) voegToe(btw, "BE" + m[1].padStart(4, "0") + m[2] + m[3]);
    for (const m of t.matchAll(/\bDE ?(\d{3}) ?(\d{3}) ?(\d{3})\b/g)) voegToe(btw, "DE" + m[1] + m[2] + m[3]);
    return { ibans, btw, alle: [...btw, ...ibans] };
  }

  // ---------- datums ----------

  const MAANDEN = ["jan", "feb", "mrt|maa|mar", "apr", "mei|may", "jun", "jul", "aug", "sep", "okt|oct", "nov", "dec"];
  const DATUM = "(\\d{1,2}[-./]\\d{1,2}[-./]\\d{2,4}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\s+[a-z]{3,10}\\.?\\s+\\d{4})";
  // Naar "jjjj-m-d" (zoals het datumveld in Manager het verwacht); null als het geen datum is
  function datumNaarIso(s) {
    s = String(s || "").trim().toLowerCase();
    let d, m, j;
    let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (r) { j = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/))) { d = +r[1]; m = +r[2]; j = +r[3]; }
    else if ((r = s.match(/^(\d{1,2})\s+([a-z]{3,10})\.?\s+(\d{4})$/))) {
      d = +r[1]; j = +r[3];
      m = MAANDEN.findIndex((p) => new RegExp("^(" + p + ")").test(r[2])) + 1;
    } else return null;
    if (j < 100) j += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && j >= 1990 && j <= 2100)) return null;
    return `${j}-${m}-${d}`;
  }
  function dagenTussen(a, b) {
    const [j1, m1, d1] = a.split("-").map(Number), [j2, m2, d2] = b.split("-").map(Number);
    return Math.round((Date.UTC(j2, m2 - 1, d2) - Date.UTC(j1, m1 - 1, d1)) / 864e5);
  }

  // ---------- kopgegevens zonder sjabloon ----------

  // Waarde na een label; met 'geldig' worden treffers overgeslagen die geen waarde zijn
  // (bijv. "factuurnr. vermelden" in een betaaltekst).
  function zoekNaLabel(lijnen, labels, waardePatroon, geldig) {
    const re = new RegExp("(?:" + labels + ")\\s*[:.#]?\\s*" + waardePatroon, "gi");
    for (const l of lijnen) {
      for (const m of l.t.matchAll(re)) if (!geldig || geldig(m[1])) return m[1];
    }
    return null;
  }

  // Totaal excl., btw en totaal incl.: zoek drie bedragen dicht bij elkaar met excl + btw = incl
  // en btw ≈ excl × 21% of 9%. Werkt voor vrijwel elke btw-specificatie, zonder labels.
  function zoekTotalen(lijnen) {
    const bedragen = [];
    lijnen.forEach((l, i) => {
      for (const tok of tokens(l.t)) if (isBedrag(tok)) bedragen.push({ v: getal(tok), i });
    });
    let beste = null;
    for (let c = 0; c < bedragen.length; c++) {
      const incl = bedragen[c];
      if (incl.v <= 0) continue;
      const buren = bedragen.filter((b, k) => k !== c && Math.abs(b.i - incl.i) <= 4);
      for (const a of buren) {
        if (a.v <= 0 || a.v >= incl.v) continue;
        const btw = rond2(incl.v - a.v);
        const b = buren.find((x) => x !== a && centen(x.v) === centen(btw));
        if (!b) continue;
        for (const tarief of [21, 9]) {
          const tol = Math.max(0.02, Math.abs(btw) * 0.003);
          if (Math.abs(a.v * tarief / 100 - btw) <= tol) {
            const kand = { totaalExcl: a.v, btwBedrag: btw, totaalIncl: incl.v, tarief, i: incl.i };
            if (!beste || kand.totaalIncl > beste.totaalIncl || (kand.totaalIncl === beste.totaalIncl && kand.i > beste.i)) beste = kand;
          }
        }
      }
    }
    if (beste) return beste;

    // Terugval op labels (bijv. 0% btw of btw verlegd)
    const laatsteBedrag = (re) => {
      let w = null;
      for (const l of lijnen) if (re.test(l.t)) {
        const b = tokens(l.t).filter(isBedrag);
        if (b.length) w = getal(b[b.length - 1]);
      }
      return w;
    };
    const excl = laatsteBedrag(/(sub\s*totaal|subtotal|excl|netto)/i);
    const incl = laatsteBedrag(/(te betalen|totaal incl|total due|factuurbedrag|totaal|total)/i);
    if (excl == null && incl == null) return null;
    const uit = { totaalExcl: excl, totaalIncl: incl, btwBedrag: null, tarief: null };
    if (excl != null && incl != null) {
      uit.btwBedrag = rond2(incl - excl);
      const r = excl ? (uit.btwBedrag / excl) * 100 : 0;
      uit.tarief = [21, 9, 0].find((t) => Math.abs(r - t) < 0.6) ?? null;
    }
    if (excl == null) uit.totaalExcl = incl;
    return uit;
  }

  // Kopjes in een rij met de waarden op de regel eronder, bijv.
  //   FACTUURDATUM FACTUURNUMMER VERVALDATUM
  //   4-11-2026    2026-085      4-12-2026
  // worden "FACTUURDATUM: 4-11-2026", "FACTUURNUMMER: 2026-085", ...
  function kolomKoppen(lijnen) {
    const uit = [];
    for (let i = 0; i + 1 < lijnen.length; i++) {
      const koppen = lijnen[i].t.split(" "), waarden = tokens(lijnen[i + 1].t);
      if (koppen.length < 2 || koppen.length !== waarden.length) continue;
      if (koppen.some((k) => /\d/.test(k) || k.length < 3)) continue;
      koppen.forEach((k, j) => uit.push({ t: k.replace(/[:.]$/, "") + ": " + waarden[j], y: lijnen[i].y, p: lijnen[i].p }));
    }
    return uit;
  }

  function kopgegevens(alleLijnen) {
    const tekst = alleLijnen.map((l) => l.t).join("\n");
    const lijnen = [...kolomKoppen(alleLijnen), ...alleLijnen];
    const kop = {};
    kop.factuurnummer = zoekNaLabel(lijnen,
      "factuur\\s*nummer|factuurnr\\.?|factuur\\s*nr\\.?|factuur\\s*no\\.?|invoice\\s*(?:number|no\\.?|nr\\.?|#)|rechnungs?\\s*(?:nummer|nr\\.?)|nota\\s*nummer|creditnota\\s*nummer",
      "([A-Z0-9][A-Z0-9\\-/.]*[A-Z0-9]|[A-Z0-9])(?![A-Za-z])", (w) => /\d/.test(w));
    // "Factuur VM609122": letters + cijfers direct na het woord factuur
    if (!kop.factuurnummer) kop.factuurnummer = zoekNaLabel(lijnen, "factuur|invoice|rechnung", "([A-Z]{0,4}\\d[A-Z0-9\\-/]{3,})\\b", (w) => !datumNaarIso(w));
    const datum = zoekNaLabel(lijnen, "factuur\\s*datum|datum\\s*factuur|invoice\\s*date|rechnungsdatum|factuurdatum", DATUM)
      || zoekNaLabel(lijnen, "datum|date", DATUM);
    kop.factuurdatum = datum ? datumNaarIso(datum) : null;
    if (!kop.factuurdatum) {
      for (const m of tekst.toLowerCase().matchAll(new RegExp(DATUM, "g"))) {
        kop.factuurdatum = datumNaarIso(m[1]);
        if (kop.factuurdatum) break;
      }
    }
    const verval = zoekNaLabel(lijnen, "vervaldatum|verval\\s*datum|uiterste\\s*betaaldatum|due\\s*date|te betalen voor", DATUM);
    kop.vervaldatum = verval ? datumNaarIso(verval) : null;
    kop.betaaltermijn = null;
    for (const l of lijnen) {
      const m = l.t.match(/(\d{1,3})\s*(dagen|days|tage)/i);
      if (m && /(betaling|betalen|conditie|termijn|netto|payment|zahlung|binnen)/i.test(l.t)) { kop.betaaltermijn = +m[1]; break; }
    }
    if (kop.betaaltermijn == null && kop.vervaldatum && kop.factuurdatum) {
      const d = dagenTussen(kop.factuurdatum, kop.vervaldatum);
      if (d > 0 && d < 365) kop.betaaltermijn = d;
    }
    Object.assign(kop, zoekTotalen(alleLijnen) || { totaalExcl: null, btwBedrag: null, totaalIncl: null, tarief: null });
    const n = nummers(tekst);
    kop.ibans = n.ibans; kop.btwNummers = n.btw; kop.nummers = n.alle;
    return kop;
  }

  // ---------- sjabloon: voorbeeldregel -> kolommen ----------

  const VELDEN = ["omschrijving", "aantal", "eenheid", "prijs", "bedrag", "negeren"];
  const GETALVELDEN = ["aantal", "prijs", "bedrag"];

  // Labels raden voor een voorbeeldregel (van rechts: bedrag, prijs, aantal)
  function raadLabels(toks) {
    const labels = toks.map(() => "omschrijving");
    const soort = toks.map(soortVan);
    let i = toks.length - 1;
    while (i >= 0 && soort[i] !== "getal") i--;
    if (i >= 0) labels[i--] = "bedrag";
    // Kortingskolom tussen prijs en bedrag (bijv. "57,81 netto 115,62" of "10%")
    if (i >= 1 && soort[i] === "tekst" && soort[i - 1] === "getal" && labels[i + 1] === "bedrag") labels[i--] = "negeren";
    if (i >= 0 && soort[i] === "getal") labels[i--] = "prijs";
    // Eenheid tussen aantal en prijs (bijv. "4 Stuks € 8,38")
    if (i >= 1 && soort[i] === "tekst" && soort[i - 1] === "getal" && labels[i + 1] === "prijs") { labels[i--] = "eenheid"; }
    if (i >= 0 && soort[i] === "getal" && labels[i + 1] !== "bedrag") labels[i--] = "aantal";
    // Regel-, pakbon- en artikelnummers vooraan negeren (alles met cijfers vóór de eerste woorden)
    for (let k = 0; k < toks.length - 1 && labels[k] === "omschrijving" && /\d/.test(toks[k]); k++) labels[k] = "negeren";
    // Er moet wel iets van de omschrijving overblijven
    if (!labels.includes("omschrijving")) { const k = labels.lastIndexOf("negeren"); if (k > 0 && soortVan(toks[k]) === "tekst") labels[k] = "omschrijving"; }
    return labels;
  }

  // Leid de kolomindeling af uit de gelabelde voorbeeldregel:
  // vaste kolommen links, één variabel stuk in het midden (omschrijving of te negeren tekst),
  // vaste kolommen rechts. Getallen worden van rechts gelezen.
  function kolommenUitLabels(voorbeeld, labels) {
    const toks = tokens(voorbeeld);
    const soort = toks.map(soortVan);
    let a = labels.indexOf("omschrijving"), b = labels.lastIndexOf("omschrijving");
    let middenVeld = "omschrijving";
    if (a < 0) {
      // Langste aaneengesloten reeks te negeren tekst wordt het variabele stuk
      let besteA = -1, besteB = -2;
      for (let k = 0; k < labels.length; k++) {
        if (labels[k] === "negeren" && soort[k] === "tekst") {
          let e = k;
          while (e + 1 < labels.length && labels[e + 1] === "negeren" && soort[e + 1] === "tekst") e++;
          if (e - k > besteB - besteA) { besteA = k; besteB = e; }
          k = e;
        }
      }
      a = besteA; b = besteB; middenVeld = "negeren";
    }
    const kol = (k) => ({ veld: labels[k], soort: GETALVELDEN.includes(labels[k]) ? "getal" : soort[k] });
    if (a < 0) return { links: labels.map((_, k) => kol(k)), midden: null, rechts: [] };
    const links = [], rechts = [];
    for (let k = 0; k < a; k++) links.push(kol(k));
    for (let k = b + 1; k < labels.length; k++) rechts.push(kol(k));
    return { links, midden: { veld: middenVeld }, rechts };
  }

  // Probeer een regel als factuurregel te lezen; null als hij niet past.
  function leesRij(t, kolommen) {
    const toks = tokens(t);
    const { links, midden, rechts } = kolommen;
    const L = links.length, R = rechts.length;
    if (!midden && toks.length !== L + R) return null;
    if (midden && toks.length < L + R + (midden.veld === "omschrijving" ? 1 : 0)) return null;
    const rij = { omschrijving: "", aantal: null, eenheid: "", prijs: null, bedrag: null };
    const zet = (kol, tok) => {
      if (kol.soort === "getal") {
        if (GETALVELDEN.includes(kol.veld) ? getal(tok) == null : !/\d/.test(tok)) return false;
      }
      if (GETALVELDEN.includes(kol.veld)) rij[kol.veld] = getal(tok);
      else if (kol.veld === "omschrijving") rij.omschrijving += (rij.omschrijving ? " " : "") + tok;
      else if (kol.veld === "eenheid") rij.eenheid = tok;
      return true;
    };
    for (let k = 0; k < L; k++) if (!zet(links[k], toks[k])) return null;
    if (midden && midden.veld === "omschrijving") {
      const stuk = toks.slice(L, toks.length - R).join(" ");
      rij.omschrijving += (rij.omschrijving && stuk ? " " : "") + stuk;
    }
    for (let k = 0; k < R; k++) if (!zet(rechts[k], toks[toks.length - R + k])) return null;
    if (rij.bedrag == null && (rij.aantal == null || rij.prijs == null)) return null;
    return rij;
  }

  // Regels die op meerdere pagina's op dezelfde plek terugkomen (kop- en voettekst).
  // Cijfers tellen niet mee ("1/3", "Transportbedrag: € 1.098,84").
  function paginaMeubilair(lijnen) {
    const paginas = new Set(lijnen.map((l) => l.p));
    const uit = new Set();
    if (paginas.size < 2) return uit;
    const groepen = new Map();
    lijnen.forEach((l, i) => {
      const k = cijfersWeg(l.t);
      if (!groepen.has(k)) groepen.set(k, []);
      groepen.get(k).push(i);
    });
    for (const idx of groepen.values()) {
      if (idx.length < 2) continue;
      const pp = new Set(idx.map((i) => lijnen[i].p));
      if (pp.size < 2 || idx.length > pp.size + 1) continue; // meerdere keren per pagina: gewone tekst
      const ys = idx.map((i) => lijnen[i].y);
      const meest = Math.max(...ys.map((y) => ys.filter((y2) => Math.abs(y2 - y) <= 2).length));
      if (meest >= 2 && meest * 2 >= idx.length) idx.forEach((i) => uit.add(i));
    }
    return uit;
  }

  const begintMet = (t, prefix) => !!prefix && norm(t).startsWith(norm(prefix));
  const begintMetCijferloos = (t, prefix) => !!prefix && cijfersWeg(t).startsWith(cijfersWeg(prefix));

  // Lees de factuurregels met een sjabloon-tabel.
  // Geeft {regels, status[]} — status per lijn: kop | rij | vervolg | negeer | pagina | eind | buiten
  function leesTabel(lijnen, tabel) {
    const status = lijnen.map(() => "buiten");
    const regels = [];
    if (!tabel || !tabel.begin || !tabel.kolommen) return { regels, status, begin: -1 };
    const begin = lijnen.findIndex((l) => begintMetCijferloos(l.t, tabel.begin));
    if (begin < 0) return { regels, status, begin: -1 };
    status[begin] = "kop";
    const meubilair = paginaMeubilair(lijnen);
    const negeer = (tabel.negeer || []).filter(Boolean);
    const paginaEinde = (tabel.paginaEinde || []).filter(Boolean);
    let pagina = lijnen[begin].p, kopZone = false, pauze = false, rijOpPagina = false;
    for (let i = begin + 1; i < lijnen.length; i++) {
      const l = lijnen[i];
      if (l.p !== pagina) { pagina = l.p; kopZone = true; pauze = false; rijOpPagina = false; }
      const rij = leesRij(l.t, tabel.kolommen);
      if (!rij && tabel.eind && (begintMetCijferloos(l.t, tabel.eind) || norm(l.t).includes(norm(tabel.eind)))) { status[i] = "eind"; break; }
      if (rij) {
        rij.lijn = i;
        regels.push(rij);
        status[i] = "rij";
        kopZone = false; pauze = false; rijOpPagina = true;
        continue;
      }
      if (kopZone || pauze || begintMetCijferloos(l.t, tabel.begin)) { status[i] = "pagina"; continue; }
      if (paginaEinde.some((p) => begintMet(l.t, p)) || meubilair.has(i)) { status[i] = "pagina"; pauze = rijOpPagina; continue; }
      if (negeer.some((p) => begintMet(l.t, p))) { status[i] = "negeer"; continue; }
      if (tabel.vervolg && regels.length) {
        const r = regels[regels.length - 1];
        r.omschrijving = r.omschrijving ? r.omschrijving + (tabel.scheiding ?? " ") + l.t : l.t;
        status[i] = "vervolg";
      } else status[i] = "negeer";
    }
    // Aantal, prijs en bedrag in overeenstemming brengen met hoe Manager rekent (aantal × prijs)
    for (const r of regels) {
      r.waarschuwing = null;
      if (r.bedrag == null) r.bedrag = rond2(r.aantal * r.prijs);
      if (r.aantal == null || r.aantal === 0) { r.aantal = 1; r.prijs = r.bedrag; continue; }
      if (r.prijs == null) r.prijs = rond2(r.bedrag / r.aantal);
      if (centen(r.aantal * r.prijs) !== centen(r.bedrag)) {
        const p4 = Math.round((r.bedrag / r.aantal) * 10000) / 10000;
        if (centen(r.aantal * p4) === centen(r.bedrag)) r.prijs = p4;
        else {
          r.omschrijving = (r.omschrijving ? r.omschrijving + " " : "") + `(${r.aantal} × ${r.prijs})`;
          r.aantal = 1; r.prijs = r.bedrag;
        }
        r.waarschuwing = "aantal × prijs wijkt af van het regelbedrag; prijs aangepast";
      }
    }
    return { regels, status, begin };
  }

  // ---------- sjablonen ----------

  // Past het sjabloon bij deze factuur? Telt de herkenningsnummers en -teksten die voorkomen.
  // Nummers die bij de klant horen (bijv. "Uw BTW-nummer : NL000000000B00"): niet van de leverancier
  // eigenNaam: naam van het eigen bedrijf; een regel met alleen een nummer vlak onder die naam
  // (in het adresblok van de klant) hoort ook bij de klant.
  function klantNummers(lijnen, eigenNaam) {
    const uit = new Set();
    // "Uw BTW nummer : NL..." — het nummer moet direct volgen, in hetzelfde zinsdeel
    for (const l of lijnen) {
      for (const m of l.t.matchAll(/\b(uw|your|klant|debiteur|customer|afnemer)\b/gi)) {
        let deel = l.t.slice(m.index + m[0].length);
        const punt = deel.search(/\.(\s|$)/);
        if (punt >= 0) deel = deel.slice(0, punt);
        const kop = deel.match(/^[^A-Z0-9]*(?:[a-z-]+\.?\s*){0,3}[:#]?\s*/i);
        if (kop && kop[0].length <= 30) for (const n of nummers(deel.slice(kop[0].length, kop[0].length + 30)).alle) uit.add(n);
      }
    }
    const woord = norm(eigenNaam).split(/[^a-z0-9]+/).find((w) => w.length >= 5);
    if (woord) {
      lijnen.forEach((l, i) => {
        if (!norm(l.t).includes(woord)) return;
        for (let k = i + 1; k <= i + 6 && k < lijnen.length; k++) {
          const n = nummers(lijnen[k].t).alle;
          if (n.length === 1 && ibanNorm(lijnen[k].t).replace(/^(BTW|VAT)[-:A-Z]*/, "") === n[0]) uit.add(n[0]);
        }
      });
    }
    return uit;
  }

  // Nummers die in meerdere sjablonen staan tellen voor geen enkel sjabloon (bijv. het eigen btw-nummer)
  function gedeeldeNummers(sjablonen) {
    const telling = new Map();
    for (const s of sjablonen || []) for (const h of new Set((s.herken || []).map(ibanNorm))) telling.set(h, (telling.get(h) || 0) + 1);
    return new Set([...telling].filter(([, n]) => n > 1).map(([h]) => h));
  }

  // Past het sjabloon bij deze factuur? Telt de herkenningsnummers en -teksten die voorkomen.
  function sjabloonScore(sjabloon, kop, tekst, uitsluiten) {
    let score = 0;
    const t = norm(tekst);
    for (const h of sjabloon.herken || []) {
      const n = ibanNorm(h);
      if (uitsluiten.has(n)) continue;
      if (kop.nummers.includes(n)) score++;
      else if (!/^[A-Z]{2}\d/.test(n) && h.trim().length >= 4 && t.includes(norm(h))) score++;
    }
    return score;
  }
  // Kiest het best passende sjabloon. Een sjabloon waarvan de tabelkop niet in de PDF staat wordt
  // niet gebruikt (dan klopt de herkenning niet, of de leverancier heeft een nieuwe factuurindeling);
  // het wordt wel teruggegeven als 'zonderKop', zodat het scherm kan voorstellen het te bewerken.
  function kiesSjabloon(sjablonen, kop, tekst, eigen) {
    const uitsluiten = new Set([...(eigen || []), ...gedeeldeNummers(sjablonen)]);
    const regels = String(tekst).split("\n");
    let beste = null, besteScore = 0, zonderKop = null, zonderKopScore = 0;
    for (const s of sjablonen || []) {
      const sc = sjabloonScore(s, kop, tekst, uitsluiten);
      if (!sc) continue;
      const heeftKop = !s.tabel || !s.tabel.begin || regels.some((l) => begintMetCijferloos(l, s.tabel.begin));
      if (heeftKop && sc > besteScore) { beste = s; besteScore = sc; }
      if (!heeftKop && sc > zonderKopScore) { zonderKop = s; zonderKopScore = sc; }
    }
    return { sjabloon: beste, zonderKop: beste ? null : zonderKop };
  }

  // ---------- btw-afronding ----------

  // Manager rekent btw per regel en rondt per regel af; veel leveranciers rekenen btw over
  // het totaal. Bepaalt het verschil en een basisbedrag waarvan de afgeronde btw precies dat
  // verschil is (wordt als regel met btw en dezelfde regel negatief zonder btw toegevoegd).
  function btwCorrectie(regels, tarief, factuurBtw) {
    if (!tarief || factuurBtw == null) return null;
    const managerBtwCent = regels.reduce((t, r) => t + rondCent(centen(r.bedrag) * tarief), 0);
    const verschilCent = centen(factuurBtw) - managerBtwCent;
    if (verschilCent === 0) return { managerBtw: managerBtwCent / 100, verschil: 0 };
    const start = Math.round(verschilCent / tarief);
    for (let stap = 0; stap < 20; stap++) {
      for (const b of [start + stap, start - stap]) {
        const btw = b * tarief, rest = Math.abs(btw) % 1;
        if (b !== 0 && rondCent(btw) === verschilCent && Math.abs(rest - 0.5) > 0.05)
          return { managerBtw: managerBtwCent / 100, verschil: verschilCent / 100, basis: b / 100 };
      }
    }
    return { managerBtw: managerBtwCent / 100, verschil: verschilCent / 100, basis: null };
  }

  // ---------- alles samen ----------

  // eigen: nummers van het eigen bedrijf (tellen niet voor het herkennen van de leverancier)
  function uitlezen(lijnen, sjablonen, eigen, eigenNaam) {
    const tekst = lijnen.map((l) => l.t).join("\n");
    const kop = kopgegevens(lijnen);
    kop.klantNummers = [...klantNummers(lijnen, eigenNaam)];
    const eigenAlles = new Set([...(eigen || []), ...kop.klantNummers]);
    const { sjabloon, zonderKop } = kiesSjabloon(sjablonen, kop, tekst, eigenAlles);
    const uit = { ...kop, sjabloon, sjabloonZonderKop: zonderKop, regels: [], status: lijnen.map(() => "buiten"), waarschuwingen: [] };
    if (sjabloon && sjabloon.tabel) {
      const r = leesTabel(lijnen, sjabloon.tabel);
      uit.regels = r.regels; uit.status = r.status;
      if (r.begin < 0) uit.waarschuwingen.push(`Sjabloon "${sjabloon.naam}": begin van de tabel niet gevonden.`);
      else if (!r.regels.length) uit.waarschuwingen.push(`Sjabloon "${sjabloon.naam}": geen factuurregels gevonden.`);
    }
    uit.somRegels = uit.regels.reduce((t, r) => t + centen(r.bedrag), 0) / 100;
    uit.somKlopt = uit.totaalExcl != null && uit.regels.length > 0 && centen(uit.somRegels) === centen(uit.totaalExcl);
    if (uit.regels.length && uit.totaalExcl != null && !uit.somKlopt)
      uit.waarschuwingen.push(`Som van de regels (${uit.somRegels.toFixed(2)}) is niet gelijk aan het totaal excl. btw (${uit.totaalExcl.toFixed(2)}).`);
    for (const r of uit.regels) if (r.waarschuwing) uit.waarschuwingen.push(`Regel "${(r.omschrijving || "").slice(0, 40)}": ${r.waarschuwing}.`);
    if (!uit.factuurnummer) uit.waarschuwingen.push("Factuurnummer niet gevonden.");
    if (!uit.factuurdatum) uit.waarschuwingen.push("Factuurdatum niet gevonden.");
    if (uit.totaalExcl == null) uit.waarschuwingen.push("Totaalbedragen niet gevonden.");
    return uit;
  }

  const api = {
    klantNummers, gedeeldeNummers,
    getal, isBedrag, centen, rond2, tokens, soortVan, itemsNaarRegels, nummers, ibanGeldig, ibanNorm,
    datumNaarIso, kopgegevens, zoekTotalen, raadLabels, kolommenUitLabels, leesRij, leesTabel,
    paginaMeubilair, kiesSjabloon, btwCorrectie, uitlezen, VELDEN, norm,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PdfImportParser = api;
})(typeof window !== "undefined" ? window : globalThis);
