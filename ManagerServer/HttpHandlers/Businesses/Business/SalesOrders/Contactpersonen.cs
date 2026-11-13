using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: contactpersonen (het eigen veld "Contactpersoon" met keuzemogelijkheden).
//  - beheerpagina: toevoegen, hernoemen (ook in alle orders), samenvoegen, verwijderen, sorteren,
//    met per naam in hoeveel documenten en bij welke klanten hij voorkomt
//  - in het verkooporderformulier: contactpersonen die eerder bij deze klant zijn gebruikt met één klik
//    kiezen, en direct een nieuwe contactpersoon toevoegen
// Vervangt de extensie "Contactpersonen beheren".
namespace ManagerServer.HttpHandlers.Businesses.Business.SalesOrders
{
    internal static class Contactpersoon
    {
        // Het veld: een veld met meerdere waarden, of een tekstveld met een keuzelijst
        internal sealed class Veld
        {
            public MultipleValueCustomField Meerdere;
            public TextCustomField Tekst;
            public Guid Key => Meerdere?.Key ?? Tekst.Key;
            public string Naam => Meerdere?.Name ?? Tekst.Name;
            public Guid[] Placement => Meerdere?.Placement ?? Tekst.Placement ?? [];

            public List<string> Opties()
            {
                if (Meerdere != null) return (Meerdere.Options ?? []).Select(x => x?.Value?.Trim()).Where(x => !string.IsNullOrEmpty(x)).ToList();
                return (Tekst.OptionsForDropdownList ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
            }

            public ManagerServer.Model.Object MetOpties(IEnumerable<string> opties)
            {
                var lijst = opties.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
                if (Meerdere != null)
                {
                    var c = (MultipleValueCustomField)Meerdere.DeepClone();
                    c.Options = lijst.Select(x => new MultipleValueCustomField.Option { Value = x }).ToArray();
                    return c;
                }
                var t = (TextCustomField)Tekst.DeepClone();
                t.OptionsForDropdownList = string.Join("\n", lijst);
                return t;
            }
        }

        private static readonly Guid VeldSleutel = new Guid("e0ad84cf-d3ba-412e-8971-c914cafa049f");
        private const string VeldNaam = "Contactpersoon";

        internal static Veld Find(Database database)
        {
            var mv = database.OfType<MultipleValueCustomField>();
            var tx = database.OfType<TextCustomField>().Where(x => x.Type == ManagerServer.Model.Enums.TextCustomFieldType.DropdownList).ToArray();
            var m = mv.FirstOrDefault(x => x.Key == VeldSleutel);
            if (m != null) return new Veld { Meerdere = m };
            var t = tx.FirstOrDefault(x => x.Key == VeldSleutel);
            if (t != null) return new Veld { Tekst = t };
            m = mv.FirstOrDefault(x => !x.Inactive && string.Equals(x.Name?.Trim(), VeldNaam, StringComparison.OrdinalIgnoreCase) && ((ICustomField)x).Contains(typeof(SalesOrder)));
            if (m != null) return new Veld { Meerdere = m };
            t = tx.FirstOrDefault(x => !x.Inactive && string.Equals(x.Name?.Trim(), VeldNaam, StringComparison.OrdinalIgnoreCase) && ((ICustomField)x).Contains(typeof(SalesOrder)));
            return t != null ? new Veld { Tekst = t } : null;
        }

        // Alle documenten waar het veld op staat (verkooporders, offertes, facturen, ...)
        internal static IEnumerable<(ManagerServer.Model.Object Doc, CustomFields Cf)> Documenten(Database database, Veld veld)
        {
            var types = veld.Placement.Select(ManagerServer.Model.Attributes.GuidAttribute.GetTypeByGuid).Where(x => x != null).Distinct().ToList();
            if (!types.Contains(typeof(SalesOrder))) types.Add(typeof(SalesOrder));
            foreach (var type in types)
            {
                foreach (var o in database.UnorderedOfType(type))
                {
                    var cf = (o as ICustomFields)?.CustomFields;
                    if (cf != null) yield return (o, cf);
                }
            }
        }

        internal static string[] Waarden(CustomFields cf, Guid key)
        {
            var uit = new List<string>();
            if (cf.StringArrays != null && cf.StringArrays.TryGetValue(key, out var arr) && arr != null) uit.AddRange(arr);
            if (cf.Strings != null && cf.Strings.TryGetValue(key, out var s) && !string.IsNullOrWhiteSpace(s)) uit.Add(s);
            return uit.Select(x => x?.Trim()).Where(x => !string.IsNullOrEmpty(x)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        internal static Guid? KlantVan(ManagerServer.Model.Object o) => o switch
        {
            SalesOrder x => x.Customer,
            SalesQuote x => x.Customer,
            SalesInvoice x => x.Customer,
            CreditNote x => x.Customer,
            DeliveryNote x => x.Customer,
            _ => null,
        };

        internal static DateTime DatumVan(ManagerServer.Model.Object o) => o switch
        {
            SalesOrder x => x.Date,
            SalesQuote x => x.IssueDate,
            SalesInvoice x => x.IssueDate,
            _ => DateTime.MinValue,
        };
    }

    [ProtoContract]
    [Title("Contactpersonen")]
    internal sealed class Contactpersonen : BusinessTemplate
    {
        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "contactpersonen.js", "contactpersoon-formulier.js", "orders-samenvoegen.css" })
                {
                    using var stream = provider.GetFileInfo("resources/orders-samenvoegen/" + name).CreateReadStream();
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

        internal static string Version => FilesVersion.Value;

        protected override void InnerGet2()
        {
            var dataUrl = new ContactpersonenData() { Business = Business }.ToUrl();
            Write($@"<link rel=""stylesheet"" href=""resources/orders-samenvoegen/orders-samenvoegen.css?version={Version}"" />");
            using (Div(@class: "card"))
            {
                using (Div(@class: "card-header"))
                {
                    using (Div(@class: "card-title")) Write("Contactpersonen");
                }
                Write(@"<div id=""cp-app"" class=""os""><p class=""os-zacht"">Laden…</p></div>");
            }
            Write($@"<script src=""resources/orders-samenvoegen/contactpersonen.js?version={Version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" id=""contactpersonen-script""></script>");
        }

        // Voor het verkooporderformulier: snel kiezen en toevoegen
        internal static string RenderFormulier(string business)
        {
            var dataUrl = new ContactpersonenData() { Business = business }.ToUrl();
            var pageUrl = new Contactpersonen() { Business = business }.ToUrl();
            return $@"<script src=""resources/orders-samenvoegen/contactpersoon-formulier.js?version={Version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" data-beheer=""{System.Net.WebUtility.HtmlEncode(pageUrl)}"" id=""contactpersoon-formulier-script""></script>";
        }
    }

    // POST {actie: "lijst" | "klant" | "toevoegen" | "hernoemen" | "verwijderen" | "sorteren", ...}
    [ProtoContract]
    internal sealed class ContactpersonenData : BusinessHandler
    {
        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            var ns = typeof(SalesOrderForm).Namespace;
            if (database == null || !permissions.CanView(ns))
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
                var veld = Contactpersoon.Find(database) ?? throw new InvalidOperationException("Het eigen veld \"Contactpersoon\" (met keuzemogelijkheden) voor verkooporders is niet gevonden.");
                var actie = request["actie"]?.ToString();
                string resultaat = null;

                if (actie is "toevoegen" or "hernoemen" or "verwijderen" or "sorteren")
                {
                    // Instellingen wijzigen: alleen voor wie verkooporders mag bewerken
                    if (!permissions.CanUpdate(ns)) throw new InvalidOperationException("Je mag verkooporders niet bewerken.");
                    resultaat = Wijzig(database, veld, actie, request);
                    database = ApplicationData.Businesses.Get(Business);
                    veld = Contactpersoon.Find(database);
                }
                else if (actie != "lijst" && actie != "klant") throw new InvalidOperationException("Onbekende actie");

                var output = actie == "klant" && Guid.TryParse(request["klant"]?.ToString(), out var klant)
                    ? Klant(database, veld, klant)
                    : Lijst(database, veld);
                if (resultaat != null) output["resultaat"] = resultaat;
                Response.ContentType = "application/json; charset=utf-8";
                await Response.WriteAsync(output.ToString(Formatting.None));
            }
            catch (InvalidOperationException ex)
            {
                Response.StatusCode = 400;
                await Response.WriteAsync(ex.Message);
            }
        }

        private static int Vergelijk(string a, string b) => string.Compare(a, b, new System.Globalization.CultureInfo("nl-NL"), System.Globalization.CompareOptions.IgnoreCase);

        private JObject Lijst(Database database, Contactpersoon.Veld veld)
        {
            var klanten = database.OfType<Customer>().ToDictionary(x => x.Key, x => x.Name ?? string.Empty);
            var gebruik = new Dictionary<string, (int Aantal, HashSet<string> Klanten, DateTime Laatst)>(StringComparer.OrdinalIgnoreCase);
            foreach (var (doc, cf) in Contactpersoon.Documenten(database, veld))
            {
                foreach (var naam in Contactpersoon.Waarden(cf, veld.Key))
                {
                    if (!gebruik.TryGetValue(naam, out var g)) g = (0, new HashSet<string>(), DateTime.MinValue);
                    var k = Contactpersoon.KlantVan(doc);
                    if (k.HasValue && klanten.TryGetValue(k.Value, out var kn)) g.Klanten.Add(kn);
                    var d = Contactpersoon.DatumVan(doc);
                    gebruik[naam] = (g.Aantal + 1, g.Klanten, d > g.Laatst ? d : g.Laatst);
                }
            }
            var opties = veld.Opties();
            var namen = new JArray();
            foreach (var naam in opties.Concat(gebruik.Keys.Where(x => !opties.Contains(x, StringComparer.OrdinalIgnoreCase))))
            {
                gebruik.TryGetValue(naam, out var g);
                namen.Add(new JObject
                {
                    ["naam"] = naam,
                    ["inLijst"] = opties.Contains(naam, StringComparer.OrdinalIgnoreCase),
                    ["gebruik"] = g.Aantal,
                    ["klanten"] = new JArray((g.Klanten ?? new HashSet<string>()).OrderBy(x => x, Comparer<string>.Create(Vergelijk))),
                    ["laatst"] = g.Laatst > DateTime.MinValue ? g.Laatst.ToString("yyyy-MM-dd") : null,
                });
            }
            return new JObject
            {
                ["veld"] = veld.Naam,
                ["veldKey"] = veld.Key.ToString(),
                ["meerdere"] = veld.Meerdere != null,
                ["gesorteerd"] = opties.SequenceEqual(opties.OrderBy(x => x, Comparer<string>.Create(Vergelijk))),
                ["namen"] = namen,
            };
        }

        // Contactpersonen die eerder bij deze klant zijn gebruikt (meest recent eerst)
        private JObject Klant(Database database, Contactpersoon.Veld veld, Guid klant)
        {
            var gebruik = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
            foreach (var (doc, cf) in Contactpersoon.Documenten(database, veld))
            {
                if (Contactpersoon.KlantVan(doc) != klant) continue;
                var d = Contactpersoon.DatumVan(doc);
                foreach (var naam in Contactpersoon.Waarden(cf, veld.Key))
                    if (!gebruik.TryGetValue(naam, out var oud) || d > oud) gebruik[naam] = d;
            }
            return new JObject
            {
                ["veld"] = veld.Naam,
                ["veldKey"] = veld.Key.ToString(),
                ["meerdere"] = veld.Meerdere != null,
                ["klant"] = new JArray(gebruik.OrderByDescending(x => x.Value).Select(x => x.Key)),
                ["alle"] = new JArray(veld.Opties()),
            };
        }

        private string Wijzig(Database database, Contactpersoon.Veld veld, string actie, JObject request)
        {
            var opties = veld.Opties();
            var sorteer = request["sorteer"]?.Type != JTokenType.Boolean || request["sorteer"].Value<bool>();
            var changed = new List<ManagerServer.Model.Object>();
            string tekst;

            switch (actie)
            {
                case "toevoegen":
                {
                    var naam = request["naam"]?.ToString()?.Trim();
                    if (string.IsNullOrEmpty(naam)) throw new InvalidOperationException("Vul een naam in.");
                    if (naam.Length > 80) throw new InvalidOperationException("De naam is te lang.");
                    if (opties.Contains(naam, StringComparer.OrdinalIgnoreCase)) return $"\"{naam}\" staat al in de lijst.";
                    opties.Add(naam);
                    tekst = $"\"{naam}\" is toegevoegd.";
                    break;
                }
                case "hernoemen":
                {
                    var oud = request["oud"]?.ToString()?.Trim();
                    var nieuw = request["nieuw"]?.ToString()?.Trim();
                    if (string.IsNullOrEmpty(oud) || string.IsNullOrEmpty(nieuw)) throw new InvalidOperationException("Vul een naam in.");
                    var bestaat = opties.FirstOrDefault(x => string.Equals(x, nieuw, StringComparison.OrdinalIgnoreCase) && !string.Equals(x, oud, StringComparison.OrdinalIgnoreCase));
                    if (bestaat != null) nieuw = bestaat;   // samenvoegen met een bestaande naam
                    var i = opties.FindIndex(x => string.Equals(x, oud, StringComparison.OrdinalIgnoreCase));
                    if (i >= 0) opties[i] = nieuw; else if (!opties.Contains(nieuw, StringComparer.OrdinalIgnoreCase)) opties.Add(nieuw);

                    // Ook in alle documenten waar de oude naam gekozen is
                    var aantal = 0;
                    foreach (var (doc, cf) in Contactpersoon.Documenten(database, veld).ToArray())
                    {
                        if (!Contactpersoon.Waarden(cf, veld.Key).Contains(oud, StringComparer.OrdinalIgnoreCase)) continue;
                        var kopie = doc.DeepClone();
                        var c = ((ICustomFields)kopie).CustomFields;
                        if (c.StringArrays != null && c.StringArrays.TryGetValue(veld.Key, out var arr) && arr != null)
                            c.StringArrays[veld.Key] = arr.Select(x => string.Equals(x?.Trim(), oud, StringComparison.OrdinalIgnoreCase) ? nieuw : x).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
                        if (c.Strings != null && c.Strings.TryGetValue(veld.Key, out var s) && string.Equals(s?.Trim(), oud, StringComparison.OrdinalIgnoreCase))
                            c.Strings[veld.Key] = nieuw;
                        changed.Add(kopie);
                        aantal++;
                    }
                    tekst = (bestaat != null ? $"\"{oud}\" is samengevoegd met \"{nieuw}\"" : $"\"{oud}\" heet nu \"{nieuw}\"") + (aantal > 0 ? $" (ook aangepast in {aantal} document{(aantal == 1 ? "" : "en")})." : ".");
                    break;
                }
                case "verwijderen":
                {
                    var naam = request["naam"]?.ToString()?.Trim();
                    var gebruikt = Contactpersoon.Documenten(database, veld).Count(x => Contactpersoon.Waarden(x.Cf, veld.Key).Contains(naam, StringComparer.OrdinalIgnoreCase));
                    if (gebruikt > 0) throw new InvalidOperationException($"\"{naam}\" is gekozen in {gebruikt} document(en) en kan niet worden verwijderd. Hernoem hem naar een andere naam om ze samen te voegen.");
                    opties.RemoveAll(x => string.Equals(x, naam, StringComparison.OrdinalIgnoreCase));
                    tekst = $"\"{naam}\" is verwijderd.";
                    break;
                }
                default:
                    tekst = "De lijst is alfabetisch gesorteerd.";
                    sorteer = true;
                    break;
            }

            if (sorteer) opties = opties.OrderBy(x => x, Comparer<string>.Create(Vergelijk)).ToList();
            changed.Insert(0, veld.MetOpties(opties));
            ApplicationData.Businesses.Process(Business, changed.ToArray(), GetUserName());
            return tekst;
        }
    }
}
