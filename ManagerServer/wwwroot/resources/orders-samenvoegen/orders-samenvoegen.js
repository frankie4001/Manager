/* Verkooporders samenvoegen en weer uit elkaar halen (Eigen aanpassing).
 * Alle wijzigingen gebeuren in één keer op de server (zie OrdersSamenvoegen.cs).
 */
(function () {
  "use strict";
  const script = document.getElementById("orders-samenvoegen-script");
  const root = document.getElementById("os-app");
  if (!script || !root) return;
  const DATA_URL = script.dataset.url;

  // replaceChildren zonder lege waarden en met geneste lijsten
  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "disabled" || k === "open") e[k] = !!v;
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
  const getal = (n) => Number(n).toLocaleString("nl-NL", { maximumFractionDigits: 4 });

  let data = null, bezig = false, melding = null;
  const gekozen = new Set();        // keys van gekozen open orders
  let doel = "";                    // "" = nieuwe order, anders key van een samengevoegde order
  let filter = "";

  async function post(body) {
    const r = await fetch(DATA_URL, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
    return r.json();
  }
  async function laad(body) {
    bezig = true; teken();
    try {
      data = await post(body || { actie: "lijst" });
      if (data.resultaat) melding = { soort: "ok", tekst: data.resultaat.tekst, url: data.resultaat.url };
      const open = new Set(data.open.map((o) => o.key));
      for (const k of [...gekozen]) if (!open.has(k)) gekozen.delete(k);
      if (doel && !data.samengevoegd.some((t) => t.key === doel && t.open)) doel = "";
    } catch (e) {
      melding = { soort: "fout", tekst: e.message };
    }
    bezig = false; teken();
  }

  const opKey = (k) => data.open.find((o) => o.key === k);
  const keuze = () => [...gekozen].map(opKey).filter(Boolean).sort((a, b) => a.referentie.localeCompare(b.referentie, undefined, { numeric: true }));
  const doelOrder = () => (doel ? data.samengevoegd.find((t) => t.key === doel) : null);

  function controle() {
    const k = keuze(), T = doelOrder();
    const klanten = new Set(k.map((o) => o.klantKey || "").concat(T ? [T.klantKey || ""] : []));
    if (!k.length) return { ok: false, tekst: "" };
    if (klanten.size > 1) return { ok: false, tekst: T ? "Andere klant dan order " + T.referentie + "." : "De gekozen orders hebben niet dezelfde klant." };
    if (new Set(k.map((o) => o.inclBtw).concat(T ? [T.inclBtw] : [])).size > 1) return { ok: false, tekst: "De orders verschillen in 'bedragen incl. btw'." };
    if (!T && k.length < 2) return { ok: false, tekst: "Kies minstens twee orders van dezelfde klant." };
    return { ok: true, tekst: "" };
  }

  // ---------- scherm ----------
  function teken() {
    if (!data) { vervang(root, el("p", { class: "os-zacht" }, bezig ? "Laden…" : ""), meldingEl()); return; }
    const c = controle(), k = keuze(), T = doelOrder();
    const doelen = data.samengevoegd.filter((t) => t.open);

    const balk = el("div", { class: "os-balk" },
      el("label", {}, "Doel ", el("select", { class: "os-invoer", onchange: (e) => { doel = e.target.value; teken(); } },
        el("option", { value: "" }, "nieuwe samengevoegde order maken"),
        doelen.map((t) => el("option", { value: t.key, selected: t.key === doel || null }, `toevoegen aan order ${t.referentie} – ${t.klant}`)))),
      el("button", { type: "button", class: "os-knop os-primair", disabled: !c.ok || bezig, onclick: voorbeeld }, T ? `Voorbeeld toevoegen aan order ${T.referentie}…` : "Voorbeeld samenvoegen…"),
      el("span", { class: c.ok || !k.length ? "os-zacht" : "os-rood" }, k.length ? `${k.length} gekozen, ${euro(k.reduce((t, o) => t + o.bedrag, 0))}` + (c.tekst ? " – " + c.tekst : "") : "Vink orders van dezelfde klant aan."),
      el("span", { class: "os-ruimte" }),
      el("input", { class: "os-invoer", type: "search", placeholder: "Zoeken (nummer, klant, omschrijving)", value: filter, oninput: (e) => { filter = e.target.value; tekenLijst(); } }));

    vervang(root, meldingEl(), balk, el("div", { id: "os-lijst" }), samengevoegdEl());
    tekenLijst();
  }

  function meldingEl() {
    if (!melding) return null;
    return el("div", { class: "os-melding os-" + melding.soort }, melding.tekst, " ",
      melding.url ? el("a", { href: melding.url }, "Order openen") : null,
      el("button", { type: "button", class: "os-sluit", onclick: () => { melding = null; teken(); } }, "×"));
  }

  function tekenLijst() {
    const vak = document.getElementById("os-lijst");
    if (!vak) return;
    const f = filter.trim().toLowerCase();
    const lijst = data.open.filter((o) => !f || [o.referentie, o.klant, o.omschrijving, o.bestelnummer].join(" ").toLowerCase().includes(f));
    const perKlant = new Map();
    for (const o of lijst) { if (!perKlant.has(o.klant)) perKlant.set(o.klant, []); perKlant.get(o.klant).push(o); }
    // Klanten met maar één order kunnen niets samenvoegen
    for (const [klant, orders] of [...perKlant]) if (orders.length < 2) perKlant.delete(klant);
    const groepen = [...perKlant].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    const T = doelOrder();
    vervang(vak, 
      el("div", { class: "os-kop" }, "Nog te factureren orders per klant (klanten met meer dan één order)"),
      groepen.length ? groepen.map(([klant, orders]) => el("details", { class: "os-groep", open: !!f || orders.some((o) => gekozen.has(o.key)) || (T && T.klant === klant) || groepen.length <= 5 },
        el("summary", {}, klant, el("span", { class: "os-zacht" }, ` (${orders.length})`)),
        el("table", { class: "os-tabel" },
          el("thead", {}, el("tr", {}, el("th"), el("th", {}, "Order"), el("th", {}, "Datum"), el("th", {}, "Omschrijving"), el("th", {}, "Bestelnummer"), el("th", { class: "os-num" }, "Bedrag"))),
          el("tbody", {}, orders.sort((a, b) => b.referentie.localeCompare(a.referentie, undefined, { numeric: true })).map((o) => {
            const isDoel = T && T.key === o.key;
            return el("tr", { class: isDoel ? "os-is-doel" : null },
              el("td", {}, el("input", { type: "checkbox", checked: gekozen.has(o.key), disabled: isDoel, title: isDoel ? "Dit is het doel" : null, onchange: (e) => { if (e.target.checked) gekozen.add(o.key); else gekozen.delete(o.key); teken(); } })),
              el("td", {}, el("a", { href: o.url, target: "_blank" }, o.referentie)),
              el("td", { class: "os-nowrap" }, datumNl(o.datum)),
              el("td", {}, o.omschrijving),
              el("td", {}, o.bestelnummer),
              el("td", { class: "os-num" }, euro(o.bedrag)));
          }))))) : el("p", { class: "os-zacht" }, f ? "Geen orders gevonden." : "Er zijn geen klanten met meer dan één nog te factureren order."));
  }

  function samengevoegdEl() {
    if (!data.samengevoegd.length) return null;
    return el("div", { class: "os-blok" },
      el("div", { class: "os-kop" }, "Samengevoegde orders", el("span", { class: "os-zacht os-klein" }, " — nog niet gefactureerd; die kunnen nog worden aangevuld of teruggedraaid")),
      el("table", { class: "os-tabel" },
        el("thead", {}, el("tr", {}, el("th", {}, "Order"), el("th", {}, "Klant"), el("th", {}, "Omschrijving"), el("th", {}, "Samengevoegd uit"), el("th", { class: "os-num" }, "Bedrag"), el("th"))),
        el("tbody", {}, data.samengevoegd.sort((a, b) => b.referentie.localeCompare(a.referentie, undefined, { numeric: true })).map((t) => el("tr", {},
          el("td", {}, el("a", { href: t.url, target: "_blank" }, t.referentie), t.open ? null : el("span", { class: "os-zacht" }, " (gefactureerd)")),
          el("td", {}, t.klant),
          el("td", {}, t.omschrijving),
          el("td", {}, t.deelorders.map((d) => d.referentie).join(", ")),
          el("td", { class: "os-num" }, euro(t.bedrag)),
          el("td", {}, el("button", { type: "button", class: "os-knop", disabled: bezig, onclick: () => terugdraaien(t) }, "Uit samenvoeging halen…")))))));
  }

  // ---------- dialogen ----------
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

  function voorbeeld() {
    const k = keuze(), T = doelOrder();
    const regels = [];
    for (const o of k) for (const r of o.regels) regels.push({ order: o.referentie, tekst: [r.omschrijving, o.bestelnummer ? "(" + o.bestelnummer + ")" : ""].filter(Boolean).join(" "), aantal: r.aantal, prijs: r.prijs, bedrag: r.bedrag });
    const totaal = regels.reduce((t, r) => t + r.bedrag, 0);
    const ref = el("input", { class: "os-invoer", value: data.volgendNummer });
    const oms = el("input", { class: "os-invoer os-breed", value: "Samengevoegde orders " + k.map((o) => o.referentie).join(", ") });
    const fout = el("div", { class: "os-rood" });
    const knop = el("button", { type: "button", class: "os-knop os-primair" }, T ? `Toevoegen en oude orders annuleren` : "Nieuwe order aanmaken en oude annuleren");
    const d = dialoog(T ? `Orders toevoegen aan order ${T.referentie}` : "Orders samenvoegen tot een nieuwe order", [
      T ? null : el("div", { class: "os-raster" }, el("label", {}, "Nieuw ordernummer"), ref, el("label", {}, "Omschrijving"), oms),
      el("div", { class: "os-scroll" }, el("table", { class: "os-tabel" },
        el("thead", {}, el("tr", {}, el("th", {}, "Order"), el("th", {}, "Omschrijving op de order"), el("th", { class: "os-num" }, "Aantal"), el("th", { class: "os-num" }, "Prijs"), el("th", { class: "os-num" }, "Bedrag"))),
        el("tbody", {}, regels.map((r) => el("tr", {}, el("td", {}, r.order), el("td", {}, r.tekst), el("td", { class: "os-num" }, getal(r.aantal)), el("td", { class: "os-num" }, euro(r.prijs)), el("td", { class: "os-num" }, euro(r.bedrag))))),
        el("tfoot", {}, el("tr", {}, el("td", { colspan: 4 }, T ? "Toe te voegen" : "Totaal"), el("td", { class: "os-num" }, euro(totaal)))))),
      el("p", { class: "os-zacht os-klein" },
        T ? `${regels.length} regels worden toegevoegd aan order ${T.referentie} (nu ${euro(T.bedrag)}, daarna ${euro(T.bedrag + totaal)}). `
          : `${regels.length} regels, totaal ${euro(totaal)}${k[0] && k[0].inclBtw ? " incl. btw" : " excl. btw"}. De nieuwe order neemt klant en instellingen over van order ${k[0].referentie}; Bestelnummer, Contactpersoon, Opmerking, Afg. leverdatum en Inkoop materialen blijven leeg en vinkvelden staan uit. `,
        `De orders ${k.map((o) => o.referentie).join(", ")} worden geannuleerd met de opmerking "samengevoegd in order ${T ? T.referentie : "…"}". Dit kan later weer ongedaan worden gemaakt.`),
      fout,
    ], [el("button", { type: "button", class: "os-knop", onclick: () => d.remove() }, "Annuleren"), knop]);
    knop.addEventListener("click", async () => {
      knop.disabled = true; fout.textContent = "";
      try {
        const r = await post({ actie: "samenvoegen", orders: k.map((o) => o.key), doel: T ? T.key : null, referentie: ref.value.trim(), omschrijving: oms.value.trim() });
        d.remove(); gekozen.clear(); doel = "";
        data = r; melding = { soort: "ok", tekst: r.resultaat.tekst, url: r.resultaat.url }; teken();
      } catch (e) { fout.textContent = "Niet gelukt: " + e.message; knop.disabled = false; }
    });
  }

  function terugdraaien(T) {
    const kies = new Set();
    const info = el("p", { class: "os-klein" });
    const fout = el("div", { class: "os-rood" });
    const knop = el("button", { type: "button", class: "os-knop os-primair", disabled: true }, "Uit samenvoeging halen en herstellen");
    const bij = () => {
      const subs = T.deelorders.filter((s) => kies.has(s.key));
      const regels = subs.reduce((t, s) => t + s.regelsInDoel, 0), bedrag = subs.reduce((t, s) => t + s.bedragInDoel, 0);
      const alles = subs.length && regels >= T.regels.length;
      knop.disabled = !subs.length;
      info.textContent = !subs.length ? `Vink de orders aan die je uit order ${T.referentie} wilt halen.`
        : alles ? `Alle regels (${euro(bedrag)}) gaan uit order ${T.referentie}. Die order wordt daarom zelf geannuleerd (opmerking "samenvoeging teruggedraaid"); de orders ${subs.map((s) => s.referentie).join(", ")} worden hersteld.`
          : `${regels} regels (${euro(bedrag)}) worden uit order ${T.referentie} gehaald (nu ${euro(T.bedrag)}, daarna ${euro(T.bedrag - bedrag)}). De orders ${subs.map((s) => s.referentie).join(", ")} worden hersteld: niet meer geannuleerd en de opmerking "samengevoegd in order ${T.referentie}" verdwijnt (een eerdere opmerking komt terug).`;
    };
    const d = dialoog(`Orders uit order ${T.referentie} halen`, [
      el("div", { class: "os-scroll" }, el("table", { class: "os-tabel" },
        el("thead", {}, el("tr", {}, el("th"), el("th", {}, "Order"), el("th", {}, "Omschrijving"), el("th", { class: "os-num" }, `Regels in ${T.referentie}`), el("th", { class: "os-num" }, "Bedrag"))),
        el("tbody", {}, T.deelorders.map((s) => el("tr", {},
          el("td", {}, el("input", { type: "checkbox", onchange: (e) => { if (e.target.checked) kies.add(s.key); else kies.delete(s.key); bij(); } })),
          el("td", {}, el("a", { href: s.url, target: "_blank" }, s.referentie)),
          el("td", {}, s.omschrijving),
          el("td", { class: "os-num" }, s.regelsVerwacht >= 0 && s.regelsInDoel < s.regelsVerwacht
            ? el("span", { class: "os-rood", title: "Een of meer regels zijn na het samenvoegen gewijzigd en worden niet meer herkend; die blijven staan." }, `${s.regelsInDoel} van ${s.regelsVerwacht}`)
            : s.regelsInDoel ? String(s.regelsInDoel) : el("span", { class: "os-rood", title: "Geen regels van deze order gevonden" }, "0")),
          el("td", { class: "os-num" }, euro(s.bedragInDoel))))))),
      info, fout,
    ], [el("button", { type: "button", class: "os-knop", onclick: () => d.remove() }, "Annuleren"), knop]);
    bij();
    knop.addEventListener("click", async () => {
      knop.disabled = true; fout.textContent = "";
      try {
        const r = await post({ actie: "terugdraaien", doel: T.key, orders: [...kies] });
        d.remove();
        data = r; melding = { soort: "ok", tekst: r.resultaat.tekst, url: r.resultaat.url }; teken();
      } catch (e) { fout.textContent = "Niet gelukt: " + e.message; knop.disabled = false; }
    });
  }

  laad();
})();
