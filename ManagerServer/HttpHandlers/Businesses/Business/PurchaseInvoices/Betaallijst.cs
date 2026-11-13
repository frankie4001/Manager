using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Xml.Linq;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: betaallijst van openstaande inkoopfacturen.
//  - openstaand bedrag zoals Manager het zelf berekent (kolom "Balance Due")
//  - IBAN van de factuur (eigen veld "Bankrekening"), anders van een eerdere factuur of de leverancier
//  - selecteren, kopiëren, afdrukken, markeren als betaald (eigen vinkveld "Factuur betaald")
//  - SEPA-betaalbestand (pain.001.001.03) voor de bank
// Vervangt de extensie "Betaallijst". Knop staat bij Inkoopfacturen (PurchaseInvoices.OnHeaderStartSection).
// Eigen rekening voor het SEPA-bestand staat in <datamap>/betaallijst.json.
namespace ManagerServer.HttpHandlers.Businesses.Business.PurchaseInvoices
{
    internal static class BetaallijstHelpers
    {
        public static readonly Guid[] BetaaldSleutels = [new Guid("ca439363-2c92-4bf6-a2e5-8868738fa0a1"), new Guid("09e01a52-c947-4393-913e-2a0c496dd16d")];
        public static readonly Guid OpmerkingenSleutel = new Guid("aaf1c9cc-341a-4a26-9baf-b6893817d450");

        internal static string IbanNorm(string s) => Regex.Replace(s ?? string.Empty, @"\s", string.Empty).ToUpperInvariant();

        internal static bool IbanGeldig(string iban)
        {
            iban = IbanNorm(iban);
            if (!Regex.IsMatch(iban, @"^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$")) return false;
            var r = iban.Substring(4) + iban.Substring(0, 4);
            var rest = 0;
            foreach (var c in r)
            {
                var n = char.IsLetter(c) ? c - 'A' + 10 : c - '0';
                rest = n > 9 ? (rest * 100 + n) % 97 : (rest * 10 + n) % 97;
            }
            return rest == 1;
        }

        // Eerste geldige IBAN in een tekst (ook met spaties)
        internal static string IbanIn(string tekst)
        {
            if (string.IsNullOrWhiteSpace(tekst)) return null;
            foreach (Match m in Regex.Matches(tekst.ToUpperInvariant(), @"[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}"))
            {
                var t = IbanNorm(m.Value);
                for (var len = Math.Min(34, t.Length); len >= 15; len--)
                    if (IbanGeldig(t.Substring(0, len))) return t.Substring(0, len);
            }
            return null;
        }

        internal static string FormatIban(string iban) => string.IsNullOrEmpty(iban) ? string.Empty : Regex.Replace(iban, ".{4}(?!$)", "$0 ");

        internal static Guid? CheckboxVeld(Database database)
        {
            var velden = database.OfType<CheckboxCustomField>().ToArray();
            foreach (var k in BetaaldSleutels) if (velden.Any(x => x.Key == k)) return k;
            return velden.Where(x => !x.Inactive && ((ICustomField)x).Contains(typeof(PurchaseInvoice)) && x.Name != null && x.Name.Contains("betaald", StringComparison.OrdinalIgnoreCase))
                .Select(x => (Guid?)x.Key).FirstOrDefault();
        }

        internal static Guid? TekstVeld(Database database, Guid sleutel, params string[] namen)
        {
            var velden = database.OfType<TextCustomField>().ToArray();
            if (velden.Any(x => x.Key == sleutel)) return sleutel;
            return velden.Where(x => !x.Inactive && ((ICustomField)x).Contains(typeof(PurchaseInvoice)) && namen.Any(n => string.Equals(x.Name?.Trim(), n, StringComparison.OrdinalIgnoreCase)))
                .Select(x => (Guid?)x.Key).FirstOrDefault();
        }

        internal static string Tekst(PurchaseInvoice i, Guid? key) =>
            key.HasValue && i.CustomFields2?.Strings != null && i.CustomFields2.Strings.TryGetValue(key.Value, out var s) ? s?.Trim() : null;

        internal static bool Betaald(PurchaseInvoice i, Guid? key) =>
            key.HasValue && i.CustomFields2?.Booleans != null && i.CustomFields2.Booleans.TryGetValue(key.Value, out var b) && b;

        // Instellingen voor het SEPA-bestand: <datamap>/betaallijst.json, per administratie
        private static readonly object fileLock = new object();
        private static string Pad => Path.Combine(DirectoryResolver.Resolve(), "betaallijst.json");

        internal static JObject Instellingen(string business)
        {
            lock (fileLock)
            {
                try
                {
                    if (File.Exists(Pad) && JObject.Parse(File.ReadAllText(Pad, Encoding.UTF8))[business] is JObject o) return o;
                }
                catch { }
                return new JObject();
            }
        }

        internal static void BewaarInstellingen(string business, JObject instellingen)
        {
            lock (fileLock)
            {
                JObject alles;
                try { alles = File.Exists(Pad) ? JObject.Parse(File.ReadAllText(Pad, Encoding.UTF8)) : new JObject(); }
                catch { alles = new JObject(); }
                alles[business] = instellingen;
                File.WriteAllText(Pad + ".tmp", alles.ToString(Formatting.Indented), new UTF8Encoding(false));
                File.Move(Pad + ".tmp", Pad, true);
            }
        }

        // SEPA staat alleen een beperkte tekenset toe
        internal static string SepaTekst(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            var genormaliseerd = s.Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder();
            foreach (var c in genormaliseerd)
            {
                if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
                if (c == '&') { sb.Append('+'); continue; }
                sb.Append(Regex.IsMatch(c.ToString(), @"[A-Za-z0-9/\-?:().,'+ ]") ? c : ' ');
            }
            var t = Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
            return t.Length > max ? t.Substring(0, max).Trim() : t;
        }
    }

    [ProtoContract]
    [Title("Betaallijst")]
    internal sealed class Betaallijst : BusinessTemplate
    {
        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "orders-samenvoegen/orders-samenvoegen.css", "betaallijst/betaallijst.js", "betaallijst/betaallijst.css" })
                {
                    using var stream = provider.GetFileInfo("resources/" + name).CreateReadStream();
                    using var ms = new MemoryStream();
                    stream.CopyTo(ms);
                    var bytes = ms.ToArray();
                    sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
                }
                sha.TransformFinalBlock([], 0, 0);
                return Convert.ToHexString(sha.Hash).Substring(0, 12).ToLowerInvariant();
            }
            catch
            {
                return typeof(Template).Assembly.GetName().Version.ToString() + "-" + DateTime.UtcNow.Ticks;
            }
        });

        protected override void InnerGet2()
        {
            var v = FilesVersion.Value;
            var dataUrl = new BetaallijstData() { Business = Business }.ToUrl();
            Write($@"<link rel=""stylesheet"" href=""resources/orders-samenvoegen/orders-samenvoegen.css?version={v}"" />");
            Write($@"<link rel=""stylesheet"" href=""resources/betaallijst/betaallijst.css?version={v}"" />");
            using (Div(@class: "card"))
            {
                using (Div(@class: "card-header"))
                {
                    using (Div(@class: "card-title")) Write("Betaallijst inkoopfacturen");
                }
                Write(@"<div id=""bl-app"" class=""os""><p class=""os-zacht"">Laden…</p></div>");
            }
            Write($@"<script src=""resources/betaallijst/betaallijst.js?version={v}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" id=""betaallijst-script""></script>");
        }
    }

    // POST {actie: "lijst" | "markeren" (keys, betaald) | "instellingen" (rekening, naam, bic) | "sepa" (keys, datum, bundelen)}
    [ProtoContract]
    internal sealed class BetaallijstData : BusinessHandler
    {
        private static string Ns => typeof(PurchaseInvoiceForm).Namespace;

        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            if (database == null || !permissions.CanView(Ns))
            {
                Response.StatusCode = 403;
                await Response.WriteAsync("Geen toegang");
                return;
            }

            JObject request;
            using (var reader = new StreamReader(Request.Body, Encoding.UTF8))
            {
                try { request = JObject.Parse(await reader.ReadToEndAsync()); }
                catch { Response.StatusCode = 400; await Response.WriteAsync("Ongeldige gegevens"); return; }
            }

            try
            {
                var actie = request["actie"]?.ToString();
                JObject output;
                switch (actie)
                {
                    case "lijst":
                        output = Lijst(database);
                        break;
                    case "markeren":
                        if (!permissions.CanUpdate(Ns)) throw new InvalidOperationException("Je mag inkoopfacturen niet bewerken.");
                        var tekst = Markeren(database, request);
                        output = Lijst(ApplicationData.Businesses.Get(Business));
                        output["resultaat"] = tekst;
                        break;
                    case "instellingen":
                        var iban = BetaallijstHelpers.IbanNorm(request["rekening"]?.ToString());
                        if (iban.Length > 0 && !BetaallijstHelpers.IbanGeldig(iban)) throw new InvalidOperationException("Het IBAN van de eigen rekening is niet geldig.");
                        BetaallijstHelpers.BewaarInstellingen(Business, new JObject
                        {
                            ["rekening"] = iban,
                            ["naam"] = request["naam"]?.ToString()?.Trim() ?? string.Empty,
                            ["bic"] = (request["bic"]?.ToString() ?? string.Empty).Trim().ToUpperInvariant(),
                        });
                        output = new JObject { ["resultaat"] = "Instellingen bewaard.", ["instellingen"] = BetaallijstHelpers.Instellingen(Business) };
                        break;
                    case "sepa":
                        output = Sepa(database, request);
                        break;
                    default:
                        throw new InvalidOperationException("Onbekende actie");
                }
                Response.ContentType = "application/json; charset=utf-8";
                await Response.WriteAsync(output.ToString(Formatting.None));
            }
            catch (InvalidOperationException ex)
            {
                Response.StatusCode = 400;
                await Response.WriteAsync(ex.Message);
            }
        }

        private sealed class Regel
        {
            public PurchaseInvoice Factuur;
            public decimal Open;
            public string Leverancier;
            public string Iban;
            public string IbanBron;
            public string Factuurnummer;
            public string Opmerking;
            public bool Betaald;
            public bool Euro;
        }

        private List<Regel> Regels(Database database)
        {
            var facturen = database.OfType<PurchaseInvoice>().ToArray();
            var saldi = new PurchaseInvoices() { HttpContext = HttpContext, Business = Business }.GetBalances(facturen);
            var bankVeld = BetaallijstHelpers.TekstVeld(database, Guid.Empty, PdfImport.BankrekeningVeld);
            var nummerVeld = BetaallijstHelpers.TekstVeld(database, Guid.Empty, PdfImport.FactuurnummerVeld);
            var opmerkingVeld = BetaallijstHelpers.TekstVeld(database, BetaallijstHelpers.OpmerkingenSleutel, "Opmerkingen", "Opmerking");
            var betaaldVeld = BetaallijstHelpers.CheckboxVeld(database);
            var leveranciers = database.OfType<Supplier>().ToDictionary(x => x.Key);
            var baseCurrency = database.Single<BaseCurrency>();
            // Zonder valutacode in Manager gaan we uit van euro's
            var euroBasis = string.IsNullOrWhiteSpace(baseCurrency.GetCode()) || string.Equals(baseCurrency.GetCode().Trim(), "EUR", StringComparison.OrdinalIgnoreCase);

            // Laatst gebruikte IBAN per leverancier (van eerdere facturen)
            var laatsteIban = new Dictionary<Guid, string>();
            foreach (var f in facturen.Where(x => x.Supplier.HasValue).OrderBy(x => x.IssueDate))
            {
                var i = BetaallijstHelpers.IbanIn(BetaallijstHelpers.Tekst(f, bankVeld));
                if (i != null) laatsteIban[f.Supplier.Value] = i;
            }

            var uit = new List<Regel>();
            foreach (var f in facturen)
            {
                if (!saldi.TryGetValue(f, out var s) || s.BalanceDue == null || s.BalanceDue.Item1 <= 0.005m) continue;
                leveranciers.TryGetValue(f.Supplier ?? Guid.Empty, out var lev);
                string iban = BetaallijstHelpers.IbanIn(BetaallijstHelpers.Tekst(f, bankVeld)), bron = "factuur";
                if (iban == null && f.Supplier.HasValue && laatsteIban.TryGetValue(f.Supplier.Value, out var li)) { iban = li; bron = "eerdere factuur"; }
                if (iban == null && lev != null)
                {
                    var teksten = new List<string> { lev.Address };
                    if (lev.CustomFields2?.Strings != null) teksten.AddRange(lev.CustomFields2.Strings.Values);
                    if (lev.CustomFields != null) teksten.AddRange(lev.CustomFields.Values);
                    iban = teksten.Select(BetaallijstHelpers.IbanIn).FirstOrDefault(x => x != null);
                    bron = "leverancier";
                }
                uit.Add(new Regel
                {
                    Factuur = f,
                    Open = s.BalanceDue.Item1,
                    Leverancier = lev?.Name ?? string.Empty,
                    Iban = iban,
                    IbanBron = iban != null ? bron : null,
                    Factuurnummer = BetaallijstHelpers.Tekst(f, nummerVeld),
                    Opmerking = BetaallijstHelpers.Tekst(f, opmerkingVeld),
                    Betaald = BetaallijstHelpers.Betaald(f, betaaldVeld),
                    Euro = lev?.Currency == null ? euroBasis : string.Equals((database.SingleOrDefault<ForeignCurrency>(lev.Currency.Value))?.GetCode(), "EUR", StringComparison.OrdinalIgnoreCase),
                });
            }
            return uit;
        }

        private JObject Lijst(Database database)
        {
            var regels = Regels(database);
            var instellingen = BetaallijstHelpers.Instellingen(Business);
            if (instellingen["rekening"] == null)
            {
                // Voorstel: IBAN uit de bedrijfsgegevens
                var bd = database.Single<BusinessDetails>();
                var teksten = new List<string> { bd.Address };
                if (bd.CustomFields2?.Strings != null) teksten.AddRange(bd.CustomFields2.Strings.Values);
                instellingen["voorstel"] = teksten.Select(BetaallijstHelpers.IbanIn).FirstOrDefault(x => x != null);
                instellingen["naam"] = bd.Name ?? Business;
            }
            return new JObject
            {
                ["facturen"] = new JArray(regels.Select(r => new JObject
                {
                    ["key"] = r.Factuur.Key.ToString(),
                    ["url"] = new PurchaseInvoiceView() { Business = Business, Key = r.Factuur.Key }.ToUrl(),
                    ["referentie"] = r.Factuur.Reference ?? string.Empty,
                    ["factuurnummer"] = r.Factuurnummer ?? string.Empty,
                    ["datum"] = r.Factuur.IssueDate.ToString("yyyy-MM-dd"),
                    ["vervaldatum"] = r.Factuur.GetDueDate().ToString("yyyy-MM-dd"),
                    ["leverancier"] = r.Leverancier,
                    ["iban"] = r.Iban,
                    ["ibanTekst"] = BetaallijstHelpers.FormatIban(r.Iban),
                    ["ibanBron"] = r.IbanBron,
                    ["opmerking"] = r.Opmerking ?? string.Empty,
                    ["bedrag"] = r.Open,
                    ["betaald"] = r.Betaald,
                    ["euro"] = r.Euro,
                })),
                ["betaaldVeld"] = BetaallijstHelpers.CheckboxVeld(database).HasValue,
                ["instellingen"] = instellingen,
                ["vandaag"] = DateTime.Today.ToString("yyyy-MM-dd"),
            };
        }

        private string Markeren(Database database, JObject request)
        {
            var veld = BetaallijstHelpers.CheckboxVeld(database)
                ?? throw new InvalidOperationException("Het eigen vinkveld \"Factuur betaald\" voor inkoopfacturen is niet gevonden.");
            var waarde = request["betaald"]?.Type != JTokenType.Boolean || request["betaald"].Value<bool>();
            var keys = (request["keys"] as JArray)?.Select(x => Guid.Parse(x.ToString())).ToArray() ?? [];
            var changed = new List<ManagerServer.Model.Object>();
            foreach (var k in keys)
            {
                var f = database.SingleOrDefault<PurchaseInvoice>(k) ?? throw new InvalidOperationException("Een factuur bestaat niet meer; vernieuw de lijst.");
                var c = (PurchaseInvoice)f.DeepClone();
                c.CustomFields2 ??= new CustomFields();
                c.CustomFields2.Booleans ??= new Dictionary<Guid, bool>();
                c.CustomFields2.Booleans[veld] = waarde;
                changed.Add(c);
            }
            if (changed.Count == 0) throw new InvalidOperationException("Geen facturen gekozen.");
            ApplicationData.Businesses.Process(Business, changed.ToArray(), GetUserName());
            return waarde ? $"{changed.Count} factuur/facturen gemarkeerd als betaald." : $"Markering \"betaald\" weggehaald bij {changed.Count} factuur/facturen.";
        }

        // SEPA-overboekingen (pain.001.001.03)
        private JObject Sepa(Database database, JObject request)
        {
            var inst = BetaallijstHelpers.Instellingen(Business);
            var eigenIban = BetaallijstHelpers.IbanNorm(inst["rekening"]?.ToString());
            if (!BetaallijstHelpers.IbanGeldig(eigenIban)) throw new InvalidOperationException("Vul eerst bij Instellingen het IBAN van de eigen rekening in.");
            var eigenNaam = BetaallijstHelpers.SepaTekst(inst["naam"]?.ToString() is { Length: > 0 } n ? n : (database.Single<BusinessDetails>().Name ?? Business), 70);
            var bic = inst["bic"]?.ToString();

            var datum = DateTime.TryParse(request["datum"]?.ToString(), out var d) ? d.Date : DateTime.Today;
            if (datum < DateTime.Today) datum = DateTime.Today;
            var keys = (request["keys"] as JArray)?.Select(x => x.ToString()).ToHashSet() ?? new HashSet<string>();
            var bundelen = request["bundelen"]?.Type == JTokenType.Boolean && request["bundelen"].Value<bool>();

            var regels = Regels(database).Where(r => keys.Contains(r.Factuur.Key.ToString())).ToList();
            var overgeslagen = regels.Where(r => r.Iban == null || !r.Euro).Select(r => $"{r.Leverancier} {r.Factuurnummer ?? r.Factuur.Reference} ({(r.Iban == null ? "geen IBAN" : "geen euro")})").ToList();
            regels = regels.Where(r => r.Iban != null && r.Euro).ToList();
            if (regels.Count == 0) throw new InvalidOperationException("Geen van de gekozen facturen kan worden betaald (geen geldig IBAN of geen euro).");

            // Omschrijving: factuurnummer van de leverancier + ons volgnummer (terug te vinden op het bankafschrift)
            string Volgnr(Regel r) => string.IsNullOrWhiteSpace(r.Factuur.Reference) ? null : r.Factuur.Reference.Trim();
            string Omschrijving(Regel r) => string.Join(" ", new[] { r.Factuurnummer, Volgnr(r) }.Where(x => !string.IsNullOrWhiteSpace(x)));
            var betalingen = bundelen
                ? regels.GroupBy(r => (r.Leverancier, r.Iban)).Select(g => (Naam: g.Key.Leverancier, Iban: g.Key.Iban, Bedrag: g.Sum(x => x.Open), Tekst: g.Count() == 1 ? Omschrijving(g.First()) : string.Join(", ", g.Select(Omschrijving)), Facturen: g.ToList())).ToList()
                : regels.Select(r => (Naam: r.Leverancier, Iban: r.Iban, Bedrag: r.Open, Tekst: Omschrijving(r), Facturen: new List<Regel> { r })).ToList();

            XNamespace ns = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03";
            var nu = DateTime.Now;
            var msgId = "BL" + nu.ToString("yyyyMMddHHmmss");
            var totaal = betalingen.Sum(x => Math.Round(x.Bedrag, 2));
            string Bedrag(decimal b) => Math.Round(b, 2).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);
            var i = 0;
            var doc = new XDocument(new XDeclaration("1.0", "UTF-8", null),
                new XElement(ns + "Document",
                    new XElement(ns + "CstmrCdtTrfInitn",
                        new XElement(ns + "GrpHdr",
                            new XElement(ns + "MsgId", msgId),
                            new XElement(ns + "CreDtTm", nu.ToString("yyyy-MM-ddTHH:mm:ss")),
                            new XElement(ns + "NbOfTxs", betalingen.Count),
                            new XElement(ns + "CtrlSum", Bedrag(totaal)),
                            new XElement(ns + "InitgPty", new XElement(ns + "Nm", eigenNaam))),
                        new XElement(ns + "PmtInf",
                            new XElement(ns + "PmtInfId", msgId + "-1"),
                            new XElement(ns + "PmtMtd", "TRF"),
                            new XElement(ns + "BtchBookg", "true"),
                            new XElement(ns + "NbOfTxs", betalingen.Count),
                            new XElement(ns + "CtrlSum", Bedrag(totaal)),
                            new XElement(ns + "PmtTpInf", new XElement(ns + "SvcLvl", new XElement(ns + "Cd", "SEPA"))),
                            new XElement(ns + "ReqdExctnDt", datum.ToString("yyyy-MM-dd")),
                            new XElement(ns + "Dbtr", new XElement(ns + "Nm", eigenNaam)),
                            new XElement(ns + "DbtrAcct", new XElement(ns + "Id", new XElement(ns + "IBAN", eigenIban))),
                            new XElement(ns + "DbtrAgt", new XElement(ns + "FinInstnId",
                                string.IsNullOrWhiteSpace(bic) ? new XElement(ns + "Othr", new XElement(ns + "Id", "NOTPROVIDED")) : new XElement(ns + "BIC", bic))),
                            new XElement(ns + "ChrgBr", "SLEV"),
                            betalingen.Select(b => new XElement(ns + "CdtTrfTxInf",
                                new XElement(ns + "PmtId", new XElement(ns + "EndToEndId", EindKenmerk(b.Facturen, ++i))),
                                new XElement(ns + "Amt", new XElement(ns + "InstdAmt", new XAttribute("Ccy", "EUR"), Bedrag(b.Bedrag))),
                                new XElement(ns + "Cdtr", new XElement(ns + "Nm", BetaallijstHelpers.SepaTekst(b.Naam, 70) is { Length: > 0 } cn ? cn : "Onbekend")),
                                new XElement(ns + "CdtrAcct", new XElement(ns + "Id", new XElement(ns + "IBAN", b.Iban))),
                                new XElement(ns + "RmtInf", new XElement(ns + "Ustrd", BetaallijstHelpers.SepaTekst(b.Tekst, 140)))))))));

            var sb = new StringBuilder();
            using (var w = new Utf8StringWriter(sb)) doc.Save(w);
            return new JObject
            {
                ["xml"] = sb.ToString(),
                ["bestandsnaam"] = $"betaalbatch-{datum:yyyy-MM-dd}.xml",
                ["aantal"] = betalingen.Count,
                ["totaal"] = totaal,
                ["keys"] = new JArray(regels.Select(r => r.Factuur.Key.ToString())),
                ["overgeslagen"] = new JArray(overgeslagen),
            };
        }

        // Kenmerk per betaling: de volgnummers van de facturen ("VNR 12-13"), anders een volgnummer in de batch
        private static string EindKenmerk(List<Regel> facturen, int i)
        {
            var refs = facturen.Select(x => x.Factuur.Reference?.Trim()).Where(x => !string.IsNullOrEmpty(x)).ToArray();
            var t = refs.Length > 0 ? "VNR " + string.Join("-", refs) : "BETALING " + i;
            t = BetaallijstHelpers.SepaTekst(t, 35);
            return t.Length > 0 ? t : "BETALING " + i;
        }

        private sealed class Utf8StringWriter : StringWriter
        {
            public Utf8StringWriter(StringBuilder sb) : base(sb) { }
            public override Encoding Encoding => new UTF8Encoding(false);
        }
    }
}
