/* Verkooporders zonder bestelnummer per klant: kopiëren (voor een e-mail) of afdrukken (Eigen aanpassing). */
(function () {
  "use strict";
  const script = document.getElementById("bestelnummer-ontbreekt-script");
  const root = document.getElementById("bo-app");
  if (!script || !root) return;

  const vervang = (doel, ...kids) => doel.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "open") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
  const vergelijk = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  let groepen = [], melding = null, bestelVeld = true;

  async function laad() {
    try {
      const r = await fetch(script.dataset.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error((await r.text()) || "HTTP " + r.status);
      const data = await r.json();
      bestelVeld = data.bestelnummerVeld;
      const per = new Map();
      for (const o of data.orders) {
        o.contactpersoon = o.contactpersoon.split(",").map((x) => x.trim()).filter((x) => x && !GUID.test(x)).join(", ");
        o.gekozen = true;
        if (!per.has(o.klant)) per.set(o.klant, []);
        per.get(o.klant).push(o);
      }
      groepen = [...per].sort((a, b) => vergelijk(a[0], b[0])).map(([klant, orders]) => ({ klant, orders: orders.sort((a, b) => vergelijk(b.referentie, a.referentie)), sort: { key: "referentie", op: false } }));
    } catch (e) { melding = { soort: "fout", tekst: "Laden mislukt: " + e.message }; }
    teken();
  }

  const KOLOMMEN = [["referentie", "Order"], ["omschrijving", "Beschrijving"], ["contactpersoon", "Contactpersoon"]];

  function teken() {
    const totaal = groepen.reduce((t, g) => t + g.orders.length, 0);
    vervang(root,
      melding ? el("div", { class: "os-melding os-" + melding.soort }, melding.tekst, el("button", { type: "button", class: "os-sluit", onclick: () => { melding = null; teken(); } }, "×")) : null,
      !bestelVeld ? el("div", { class: "os-melding os-fout" }, "Het eigen veld \"Bestelnummer\" voor verkooporders is niet gevonden.") : null,
      el("div", { class: "os-balk" },
        el("span", {}, `${totaal} nog te factureren orders zonder bestelnummer bij ${groepen.length} klanten.`),
        el("span", { class: "os-ruimte" }),
        el("button", { type: "button", class: "os-knop", onclick: () => afdrukken(groepen) }, "Alles afdrukken"),
        el("button", { type: "button", class: "os-knop", onclick: () => { groepen = []; teken(); laad(); } }, "Vernieuwen")),
      groepen.length ? groepen.map(groepEl) : el("p", { class: "os-zacht" }, "Alle nog te factureren orders hebben een bestelnummer."));
  }

  function groepEl(g) {
    const alle = g.orders.every((o) => o.gekozen);
    return el("details", { class: "os-groep", open: groepen.length <= 3 },
      el("summary", {}, g.klant, el("span", { class: "os-zacht" }, ` (${g.orders.length})`),
        el("span", { class: "os-acties" },
          el("button", { type: "button", class: "os-knop", onclick: (e) => { e.preventDefault(); kopieer(g); } }, "Kopiëren"),
          el("button", { type: "button", class: "os-knop", onclick: (e) => { e.preventDefault(); afdrukken([g]); } }, "Afdrukken"))),
      el("table", { class: "os-tabel" },
        el("thead", {}, el("tr", {},
          el("th", {}, el("input", { type: "checkbox", checked: alle, title: "Alles aan/uit", onchange: (e) => { for (const o of g.orders) o.gekozen = e.target.checked; teken(); } })),
          KOLOMMEN.map(([k, naam]) => el("th", { class: "os-sorteer", title: "Sorteren", onclick: () => {
            g.sort = { key: k, op: g.sort.key === k ? !g.sort.op : true };
            g.orders.sort((a, b) => (g.sort.op ? 1 : -1) * vergelijk(a[k], b[k]));
            teken();
          } }, naam, g.sort.key === k ? (g.sort.op ? " ▲" : " ▼") : "")),
          el("th", {}, "Bestelnummer"))),
        el("tbody", {}, g.orders.map((o) => el("tr", { class: o.gekozen ? null : "os-uit" },
          el("td", {}, el("input", { type: "checkbox", checked: o.gekozen, onchange: (e) => { o.gekozen = e.target.checked; teken(); } })),
          el("td", {}, el("a", { href: o.url, target: "_blank" }, o.referentie)),
          el("td", {}, o.omschrijving),
          el("td", {}, o.contactpersoon),
          el("td", { class: "os-invul" }))))));
  }

  // Tabel voor in een e-mail (vaste breedtes, inline opmaak)
  function tabelHtml(g) {
    const W = [70, 260, 170, 160], c = "border:1px solid #999999;padding:6px 10px;text-align:left;vertical-align:top;";
    const kop = ["Order", "Beschrijving", "Contactpersoon", "Bestelnummer"].map((h, i) => `<th width="${W[i]}" style="${c}background-color:#e9edf1;color:#000000;width:${W[i]}px;">${h}</th>`).join("");
    const rijen = g.orders.filter((o) => o.gekozen).map((o, n) => {
      const bg = n % 2 ? "background-color:#f3f5f7;" : "background-color:#ffffff;";
      return "<tr>" + [o.referentie, o.omschrijving, o.contactpersoon].map((v, i) => `<td width="${W[i]}" style="${c}${bg}color:#000000;width:${W[i]}px;">${esc(v)}</td>`).join("")
        + `<td width="${W[3]}" style="${c}${bg}width:${W[3]}px;height:26px;">&nbsp;</td></tr>`;
    }).join("");
    const breed = W.reduce((a, b) => a + b, 0);
    return `<table width="${breed}" style="width:${breed}px;table-layout:fixed;border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#000000;background-color:#ffffff;"><thead><tr>${kop}</tr></thead><tbody>${rijen}</tbody></table>`;
  }
  const tekstTabel = (g) => ["Order\tBeschrijving\tContactpersoon\tBestelnummer"].concat(g.orders.filter((o) => o.gekozen).map((o) => [o.referentie, o.omschrijving, o.contactpersoon, ""].map((x) => String(x).replace(/\s+/g, " ")).join("\t"))).join("\n");

  async function kopieer(g) {
    const n = g.orders.filter((o) => o.gekozen).length;
    if (!n) { melding = { soort: "fout", tekst: "Vink minstens één order aan." }; teken(); return; }
    let ok = false;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([tabelHtml(g)], { type: "text/html" }), "text/plain": new Blob([tekstTabel(g)], { type: "text/plain" }) })]);
        ok = true;
      }
    } catch (e) { /* hieronder via selectie */ }
    if (!ok) {
      const tijdelijk = el("div", { style: "position:fixed;left:-10000px;top:0;background:#fff;color:#000;" });
      tijdelijk.innerHTML = tabelHtml(g);
      document.body.append(tijdelijk);
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(tijdelijk); sel.removeAllRanges(); sel.addRange(range);
      try { ok = document.execCommand("copy"); } catch (e) { /* */ }
      sel.removeAllRanges(); tijdelijk.remove();
    }
    melding = ok ? { soort: "ok", tekst: `Gekopieerd: ${g.klant} (${n} orders). Plak de tabel in je e-mail.` } : { soort: "fout", tekst: "Kopiëren is niet gelukt in deze browser." };
    teken();
  }

  function afdrukken(lijst) {
    const delen = lijst.filter((g) => g.orders.some((o) => o.gekozen)).map((g, i) =>
      `<section${i ? ' class="nieuw"' : ""}><h2>${esc(g.klant)}</h2><p>Verkooporders zonder bestelnummer — afgedrukt op ${esc(new Date().toLocaleString("nl-NL"))}</p>${tabelHtml(g).replace(/width="\d+"|width:\d+px;|table-layout:fixed;/g, "")}</section>`);
    if (!delen.length) { melding = { soort: "fout", tekst: "Vink minstens één order aan." }; teken(); return; }
    const w = window.open("", "_blank");
    if (!w) { melding = { soort: "fout", tekst: "Het afdrukvenster werd geblokkeerd; sta pop-ups toe voor Manager." }; teken(); return; }
    w.document.write(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Bestelnummer ontbreekt</title><style>
      @page { size: A4 portrait; margin: 12mm; }
      body { font-family: Calibri, Arial, sans-serif; color: #000; }
      h2 { margin: 0 0 4px; font-size: 18px; } p { margin: 0 0 8px; font-size: 12px; color: #333; }
      table { width: 100% !important; border-collapse: collapse; }
      th, td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      th:nth-child(1) { width: 12%; } th:nth-child(2) { width: 43%; } th:nth-child(3) { width: 22%; } th:nth-child(4) { width: 23%; }
      tr { break-inside: avoid; } section.nieuw { break-before: page; }
    </style></head><body>${delen.join("")}<script>window.onload = () => { window.print(); };<\/script></body></html>`);
    w.document.close();
  }

  laad();
})();
