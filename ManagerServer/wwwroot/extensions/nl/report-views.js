// Per-report presentation for the NL extension, keyed by the report ids in reports.js
// (see au/report-views.js for the hooks). Eigen aanpassing: de concept btw-aangifte
// in de vorm van het aangifteformulier van de Belastingdienst.

// Eigen aanpassing: alles staat in dit bestand (opmaak en Nederlandse labels), zodat de
// officiële bestanden van de extensie alleen een <script src="report-views.js"> extra hebben.
(function () {
  // Opmaak
  const stijl = document.createElement("style");
  stijl.textContent = "/* Eigen aanpassing: concept btw-aangifte in de vorm van het aangifteformulier (report-views.js) */\n.btw-acties { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }\n.btw-schakelaar { display: inline-flex; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; }\n.btw-schakelaar button { border: 0; background: #fff; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; color: #374151; }\n.btw-schakelaar button + button { border-left: 1px solid #d1d5db; }\n.btw-schakelaar button.actief { background: #154273; color: #fff; }\n.btw-aangifte { max-width: 900px; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; background: #fff; }\n.btw-kop { display: flex; justify-content: space-between; align-items: stretch; gap: 16px; padding: 18px 20px; background: #154273; color: #fff; flex-wrap: wrap; }\n.btw-bedrijf { font-size: 13px; opacity: .85; }\n.btw-titel { font-size: 22px; font-weight: 700; margin: 2px 0; }\n.btw-periode { font-size: 16px; font-weight: 600; }\n.btw-sub { font-size: 12px; opacity: .8; margin-top: 4px; }\n.btw-uitkomst { background: #fff; color: #111827; border-radius: 6px; padding: 10px 16px; min-width: 190px; text-align: right; align-self: center; }\n.btw-uitkomst-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }\n.btw-uitkomst-bedrag { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }\n.btw-uitkomst-sub { font-size: 11px; color: #6b7280; }\n.btw-betalen .btw-uitkomst-label { color: #b91c1c; }\n.btw-terug .btw-uitkomst-label { color: #15803d; }\n#reportOutput .btw-tabel { width: 100%; border-collapse: collapse; }\n#reportOutput .btw-tabel td { white-space: normal; }\n.btw-col-code { width: 44px; }\n.btw-col-bedrag { width: 190px; }\n#reportOutput .btw-tabel thead th { background: #fff; color: #6b7280; font-size: 11px; text-transform: none; letter-spacing: 0; font-weight: 600; text-align: right; vertical-align: bottom; padding: 10px 12px 6px; border-bottom: 1px solid #e5e7eb; }\n#reportOutput .btw-sectiekop th { background: #eef2f7; color: #154273; text-align: left; font-size: 14px; font-weight: 700; text-transform: none; letter-spacing: 0; padding: 10px 12px; border-top: 1px solid #d1d5db; }\n.btw-nr { display: inline-block; min-width: 26px; height: 26px; line-height: 26px; text-align: center; border-radius: 50%; background: #154273; color: #fff; font-size: 13px; margin-right: 10px; }\n#reportOutput .btw-tabel td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }\n.btw-code { font-weight: 700; color: #154273; }\n.btw-tekst { color: #1f2937; }\n#reportOutput td.btw-bedrag { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; border-left: 1px solid #f1f5f9; }\n.btw-bedrag a { color: #111827; text-decoration: none; }\n.btw-bedrag a:hover { color: #2563eb; text-decoration: underline; }\n.btw-euro { color: #9ca3af; margin-right: 2px; }\n.btw-nul, .btw-nul a { color: #9ca3af; }\n.btw-nvt { background: repeating-linear-gradient(135deg, #f3f4f6, #f3f4f6 6px, #fafafa 6px, #fafafa 12px); }\n.btw-totaal td { font-weight: 700; background: #f8fafc; border-top: 2px solid #154273; }\n.btw-kopieer { border: 0; background: none; color: #9ca3af; cursor: pointer; padding: 0 0 0 6px; font-size: 13px; }\n.btw-kopieer:hover { color: #2563eb; }\n.btw-voet { margin: 0; padding: 12px 20px 16px; font-size: 12px; color: #6b7280; line-height: 1.5; }\n@media (max-width: 720px) {\n  .btw-col-bedrag { width: 120px; }\n  .btw-kop { flex-direction: column; }\n  .btw-uitkomst { text-align: left; }\n}\n@media print {\n  .btw-acties { display: none !important; }\n  .btw-aangifte { border: 0; max-width: none; }\n  .btw-kop, .btw-sectiekop th, .btw-nr, .btw-nvt, .btw-totaal td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n  .btw-kopieer { display: none; }\n  #reportOutput .btw-tabel thead th { font-size: 10px; }\n  .btw-sectie { break-inside: avoid; }\n}";
  document.head.appendChild(stijl);

  // Nederlandse labels voor de keuzes boven de rapporten (ook in het rapportenoverzicht)
  const LABELS = {
    "Business": "Administratie", "Period": "Periode", "Quarter": "Kwartaal", "Month": "Maand", "Year": "Jaar",
    "From date": "Van", "To date": "Tot en met", "Accounting basis": "Stelsel", "Financial year": "Boekjaar", "Employee": "Medewerker",
  };
  const OPTIES = {
    "Quarter": "Kwartaal", "Month": "Maand", "Custom range": "Eigen periode", "Accrual": "Factuurstelsel", "Cash": "Kasstelsel",
    "Q1 (Jan–Mar)": "1e kwartaal (jan–mrt)", "Q2 (Apr–Jun)": "2e kwartaal (apr–jun)", "Q3 (Jul–Sep)": "3e kwartaal (jul–sep)", "Q4 (Oct–Dec)": "4e kwartaal (okt–dec)",
    "January": "januari", "February": "februari", "March": "maart", "April": "april", "May": "mei", "June": "juni",
    "July": "juli", "August": "augustus", "September": "september", "October": "oktober", "November": "november", "December": "december",
  };
  function vertaal(root) {
    root.querySelectorAll("form#reportControls label, .business-bar label").forEach((label) => {
      for (const n of label.childNodes) {
        if (n.nodeType === 3 && LABELS[n.textContent.trim()]) { n.textContent = LABELS[n.textContent.trim()] + "\n"; break; }
      }
    });
    root.querySelectorAll("form#reportControls option").forEach((o) => { if (OPTIES[o.textContent.trim()]) o.textContent = OPTIES[o.textContent.trim()]; });
    root.querySelectorAll("form#reportControls button[type=submit]").forEach((b) => { if (b.textContent.trim() === "Generate") b.textContent = "Tonen"; });
  }
  const start = () => {
    vertaal(document);
    if (document.title === "Netherlands — Concept BTW Aangifte") {
      document.title = "Concept btw-aangifte";
      const h1 = document.querySelector("h1"); if (h1) h1.textContent = "Concept btw-aangifte";
    }
    const nav = document.querySelector(".page-nav a"); if (nav && nav.textContent.trim() === "← Netherlands") nav.textContent = "← Nederland";
    new MutationObserver((mutaties) => { for (const m of mutaties) for (const n of m.addedNodes) if (n.nodeType === 1) vertaal(n); })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();

const REPORT_VIEWS = {

  // ---- Concept BTW Aangifte -------------------------------------------------
  "b755a3ef-32aa-4eab-8936-0e48b057f627": {
    render: function (report, data, business, period) {
      const output = document.getElementById("reportOutput");
      const accountingEl = document.getElementById("accounting");
      const kasstelsel = accountingEl && accountingEl.value === "1";
      const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

      // Periode als "4e kwartaal 2026", "november 2026" of "1 oktober 2026 t/m 15 november 2026"
      const d = (s) => { const [j, m, dg] = s.split("-").map(Number); return { j, m, dg }; };
      const lang = (s) => { const x = d(s); return `${x.dg} ${MAANDEN[x.m - 1]} ${x.j}`; };
      const laatsteDag = (j, m) => new Date(j, m, 0).getDate();
      const van = d(period.from), tot = d(period.to);
      let periodeNaam = `${lang(period.from)} t/m ${lang(period.to)}`;
      if (van.dg === 1 && tot.dg === laatsteDag(tot.j, tot.m) && van.j === tot.j) {
        if (van.m === tot.m) periodeNaam = `${MAANDEN[van.m - 1]} ${van.j}`;
        else if (tot.m - van.m === 2 && (van.m - 1) % 3 === 0) periodeNaam = `${(van.m - 1) / 3 + 1}e kwartaal ${van.j}`;
        else if (van.m === 1 && tot.m === 12) periodeNaam = `jaar ${van.j}`;
      }

      // Rubrieken uit de rijen halen: "1a Leveringen..." -> code 1a
      const secties = [];
      let huidig = null;
      const rubriek = {};
      for (const row of data.rows || []) {
        const naam = String(row.name || "").replace(/\n-+\s*$/, "").trim();
        if (!naam) continue;
        if (row.isHeader) {
          const m = naam.match(/^(\d)\s+(.*)$/);
          huidig = { nr: m ? m[1] : "", titel: m ? m[2] : naam, rijen: [] };
          secties.push(huidig);
          continue;
        }
        const m = naam.match(/^(\d[a-z])\s+(.*)$/i);
        const rij = { code: m ? m[1] : "", tekst: (m ? m[2] : naam).replace(/\(rubrieken 1 t\/m 4$/, "(rubrieken 1 t/m 4)"), cellen: row.cells || [] };
        if (rij.code) rubriek[rij.code] = rij;
        if (!huidig) { huidig = { nr: "", titel: "", rijen: [] }; secties.push(huidig); }
        huidig.rijen.push(rij);
      }

      const getal = (c) => (c && !c.hidden && c.number != null ? Number(c.number) : null);
      const fmt = (n, dec) => Number(n).toLocaleString("nl-NL", { minimumFractionDigits: dec, maximumFractionDigits: dec });

      // Afronden op hele euro's in uw voordeel: omzet en omzetbelasting naar beneden,
      // voorbelasting (5b) naar boven; 5a en 5c worden uit de afgeronde bedragen berekend.
      const afgerond = {};
      let som5a = 0;
      for (const s of secties) for (const r of s.rijen) {
        if (!r.code || /^5/.test(r.code)) continue;
        afgerond[r.code] = r.cellen.map((c) => (getal(c) == null ? null : Math.floor(getal(c) + 1e-9)));
        if (afgerond[r.code][1] != null) som5a += afgerond[r.code][1];
      }
      const exact5b = getal((rubriek["5b"] || { cellen: [] }).cellen[1]) || 0;
      afgerond["5a"] = [null, som5a];
      afgerond["5b"] = [null, Math.ceil(exact5b - 1e-9)];
      afgerond["5c"] = [null, som5a - Math.ceil(exact5b - 1e-9)];
      const exact5c = getal((rubriek["5c"] || { cellen: [] }).cellen[1]) || 0;

      let modus = (() => { try { return localStorage.getItem("nl-btw-modus") || "exact"; } catch (e) { return "exact"; } })();

      const cel = (r, i) => {
        const c = r.cellen[i];
        const exact = getal(c);
        if (exact == null) return `<td class="btw-bedrag btw-nvt"></td>`;
        const waarde = modus === "afgerond" && afgerond[r.code] ? afgerond[r.code][i] : exact;
        const tekst = modus === "afgerond" ? fmt(waarde, 0) : fmt(waarde, data.decimals != null ? data.decimals : 2);
        const nul = waarde === 0 ? " btw-nul" : "";
        if (modus === "afgerond") {
          return `<td class="btw-bedrag${nul}"><span class="btw-euro">€</span> ${escapeText(tekst)}<button type="button" class="btw-kopieer" data-waarde="${waarde}" title="Kopiëren">⧉</button></td>`;
        }
        const inhoud = `<span class="btw-euro">€</span> ${escapeText(tekst)}`;
        return `<td class="btw-bedrag${nul}">${c.drillDownUrl ? `<a href="${escapeAttr(c.drillDownUrl)}" target="_blank" rel="noopener" title="Boekingen bekijken">${inhoud}</a>` : inhoud}</td>`;
      };

      const teken = () => {
        const uitkomst = modus === "afgerond" ? afgerond["5c"][1] : exact5c;
        const dec = modus === "afgerond" ? 0 : 2;
        const betalen = uitkomst >= 0;
        const html = `
          <div class="report-actions btw-acties">
            <div class="btw-schakelaar" role="group" aria-label="Bedragen">
              <button type="button" data-modus="exact" class="${modus === "exact" ? "actief" : ""}">Exacte bedragen</button>
              <button type="button" data-modus="afgerond" class="${modus === "afgerond" ? "actief" : ""}">Afgerond voor de aangifte</button>
            </div>
            <button type="button" class="primary" id="printReport">Afdrukken</button>
          </div>
          <div id="printable-content" class="btw-aangifte">
            <div class="btw-kop">
              <div>
                <div class="btw-bedrijf">${escapeText(business)}</div>
                <div class="btw-titel">Concept btw-aangifte</div>
                <div class="btw-periode">${escapeText(periodeNaam)}</div>
                <div class="btw-sub">${escapeText(lang(period.from))} t/m ${escapeText(lang(period.to))} · ${kasstelsel ? "kasstelsel" : "factuurstelsel"}${modus === "afgerond" ? " · afgerond op hele euro's" : ""}</div>
              </div>
              <div class="btw-uitkomst ${betalen ? "btw-betalen" : "btw-terug"}">
                <div class="btw-uitkomst-label">${betalen ? "Te betalen" : "Terug te vragen"}</div>
                <div class="btw-uitkomst-bedrag">€ ${escapeText(fmt(Math.abs(uitkomst), dec))}</div>
                <div class="btw-uitkomst-sub">rubriek 5c</div>
              </div>
            </div>
            <table class="btw-tabel">
              <colgroup><col class="btw-col-code"><col><col class="btw-col-bedrag"><col class="btw-col-bedrag"></colgroup>
              <thead><tr><th></th><th></th><th>Bedrag waarover omzetbelasting wordt berekend</th><th>Omzetbelasting</th></tr></thead>
              ${secties.map((s) => `
                <tbody class="btw-sectie">
                  <tr class="btw-sectiekop"><th colspan="4"><span class="btw-nr">${escapeText(s.nr)}</span>${escapeText(s.titel)}</th></tr>
                  ${s.rijen.map((r) => `
                    <tr class="${r.code === "5c" ? "btw-totaal" : ""}">
                      <td class="btw-code">${escapeText(r.code)}</td>
                      <td class="btw-tekst">${escapeText(r.tekst)}</td>
                      ${cel(r, 0)}${cel(r, 1)}
                    </tr>`).join("")}
                </tbody>`).join("")}
            </table>
            <p class="btw-voet">${modus === "afgerond"
              ? "Afgerond in uw voordeel: omzet en omzetbelasting naar beneden, voorbelasting naar boven; 5a en 5c zijn berekend uit de afgeronde bedragen. Met ⧉ kopieert u een bedrag om het in Mijn Belastingdienst Zakelijk te plakken."
              : "Klik op een bedrag om de onderliggende boekingen te zien. Grijze vakken worden in deze rubriek niet ingevuld."}
              Dit is een concept; controleer de bedragen voordat u de aangifte indient.</p>
          </div>
          <textarea name="content" hidden></textarea>`;
        output.innerHTML = html;
        output.querySelector("#printReport").addEventListener("click", () => window.print());
        output.querySelectorAll(".btw-schakelaar button").forEach((b) => b.addEventListener("click", () => {
          modus = b.dataset.modus;
          try { localStorage.setItem("nl-btw-modus", modus); } catch (e) { /* */ }
          teken();
        }));
        output.querySelectorAll(".btw-kopieer").forEach((b) => b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(b.dataset.waarde); b.textContent = "✓"; setTimeout(() => { b.textContent = "⧉"; }, 1200); } catch (e) { /* */ }
        }));
      };
      teken();
    },
  },
};
