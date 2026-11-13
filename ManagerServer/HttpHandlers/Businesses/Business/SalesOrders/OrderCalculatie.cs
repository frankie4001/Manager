using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: calculatie op de verkooporder.
//
// Een inklapbaar blok boven het verkooporderformulier met:
//  - de inkoopkosten van de order: regels van inkoopfacturen waarvan het eigen veld "Verkooporder"
//    (op de regel of op de factuur) de referentie van de order bevat (dit vult de PDF-import ook in)
//  - zelf toe te voegen extra kosten (uren, transport, ...)
//  - een opslagpercentage per order en de berekende verkoopprijs (alleen getoond)
//
// De extra kosten en de opslag worden in de order zelf bewaard, in het (verborgen) eigen tekstveld
// "Calculatie", en dus opgeslagen met "Aanmaken"/"Bijwerken".
//
// Alles staat in dit bestand en in wwwroot/resources/order-calculatie/; in Manager zelf roept
// alleen SalesOrderForm.InnerGet5() OrderCalculatie.Render() aan.
namespace ManagerServer.HttpHandlers.Businesses.Business.SalesOrders
{
    internal static class OrderCalculatie
    {
        public const string CalculatieVeld = "Calculatie";
        public const string VerkooporderVeld = "Verkooporder";

        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "order-calculatie.js", "order-calculatie.css" })
                {
                    using var stream = provider.GetFileInfo("resources/order-calculatie/" + name).CreateReadStream();
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

        internal sealed class CostLine
        {
            public PurchaseInvoice Invoice;
            public int Index;
            public PurchaseInvoice.Line Line;
            public string Order;     // ordernummer in kleine letters
            public decimal Amount;   // excl. btw
            public string Id => Invoice.Key.ToString("N") + ":" + Index;
        }

        // Eigen velden "Verkooporder" op inkoopfactuurregels en op inkoopfacturen
        internal static (HashSet<Guid> Lines, HashSet<Guid> Invoices) SalesOrderFieldKeys(Database database)
        {
            var fields = database.OfType<TextCustomField>()
                .Where(x => !x.Inactive && string.Equals(x.Name?.Trim(), VerkooporderVeld, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            return (fields.Where(x => ((ICustomField)x).Contains(typeof(PurchaseInvoice.Line))).Select(x => x.Key).ToHashSet(),
                    fields.Where(x => ((ICustomField)x).Contains(typeof(PurchaseInvoice))).Select(x => x.Key).ToHashSet());
        }

        // Alle inkoopfactuurregels die aan een verkooporder gekoppeld zijn.
        // "778" en "778 - Klant" horen allebei bij order 778.
        internal static List<CostLine> PurchaseCostLines(Database database)
        {
            var (lineKeys, invoiceKeys) = SalesOrderFieldKeys(database);
            var result = new List<CostLine>();
            if (lineKeys.Count + invoiceKeys.Count == 0) return result;
            static string OrderOf(CustomFields cf, HashSet<Guid> keys)
            {
                if (cf?.Strings == null) return null;
                foreach (var e in cf.Strings)
                {
                    if (!keys.Contains(e.Key) || string.IsNullOrWhiteSpace(e.Value)) continue;
                    return e.Value.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
                }
                return null;
            }
            var taxRates = database.OfType<TaxCode>().ToDictionary(x => x.Key, x => x.Rates.Sum());
            foreach (var invoice in database.OfType<PurchaseInvoice>().OrderBy(x => x.IssueDate))
            {
                var whole = OrderOf(invoice.CustomFields2, invoiceKeys);
                var lines = invoice.Lines ?? [];
                for (var i = 0; i < lines.Length; i++)
                {
                    var line = lines[i];
                    var order = whole ?? OrderOf(line.CustomFields2, lineKeys);
                    if (order == null) continue;
                    var amount = Math.Round((line.Qty ?? 1m) * line.PurchaseUnitPrice, 2, MidpointRounding.AwayFromZero);
                    if (invoice.Discount)
                    {
                        if (invoice.DiscountType == ManagerServer.Model.Enums.DiscountType.Percentage) amount = Math.Round(amount * (1m - line.DiscountPercentage / 100m), 2, MidpointRounding.AwayFromZero);
                        else amount -= line.DiscountAmount;
                    }
                    if (invoice.AmountsIncludeTax && line.TaxCode.HasValue && taxRates.TryGetValue(line.TaxCode.Value, out var rate) && rate != 0m)
                        amount = Math.Round(amount / (1m + rate / 100m), 2, MidpointRounding.AwayFromZero);
                    result.Add(new CostLine { Invoice = invoice, Index = i, Line = line, Order = order, Amount = amount });
                }
            }
            return result;
        }

        // Inhoud van het verborgen veld "Calculatie" van een order
        internal static JObject ReadCalculation(SalesOrder order, Guid? fieldKey)
        {
            var raw = fieldKey.HasValue ? OrderSamenvoeging.GetString(order, fieldKey) : null;
            if (string.IsNullOrWhiteSpace(raw)) return new JObject();
            try { return JObject.Parse(raw); } catch { return new JObject(); }
        }

        internal static decimal ExtraCosts(JObject calc)
        {
            var sum = 0m;
            if (calc["extra"] is JArray extra)
                foreach (var x in extra.OfType<JObject>())
                {
                    var qty = x["aantal"]?.Type is JTokenType.Integer or JTokenType.Float ? x["aantal"].Value<decimal>() : 1m;
                    var price = x["prijs"]?.Type is JTokenType.Integer or JTokenType.Float ? x["prijs"].Value<decimal>() : 0m;
                    sum += Math.Round(qty * price, 2, MidpointRounding.AwayFromZero);
                }
            return sum;
        }

        // Kosten per order (inkoop + extra kosten, inclusief de orders die erin zijn samengevoegd)
        internal static Dictionary<SalesOrder, decimal> CostsPerOrder(Database database, SalesOrder[] rows)
        {
            var field = FindField(database)?.Key;
            var opmerking = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Opmerking);
            var lines = PurchaseCostLines(database);
            var byOrder = lines.GroupBy(x => x.Order).ToDictionary(g => g.Key, g => g.ToList());
            var result = new Dictionary<SalesOrder, decimal>();
            foreach (var o in rows)
            {
                // Geannuleerde orders tellen niet mee (bij samenvoegen tellen hun kosten bij de nieuwe order)
                if (o.Cancelled) { result[o] = 0m; continue; }
                var calc = ReadCalculation(o, field);
                var excluded = (calc["uit"] as JArray)?.Select(x => x.ToString()).ToHashSet() ?? new HashSet<string>();
                var orders = new List<SalesOrder> { o };
                if (!o.Cancelled && !string.IsNullOrWhiteSpace(o.Reference)) orders.AddRange(OrderSamenvoeging.AllSubOrders(database, o.Reference, opmerking));
                var total = 0m;
                foreach (var x in orders)
                {
                    var key = x.Reference?.Trim().ToLowerInvariant();
                    if (!string.IsNullOrEmpty(key) && byOrder.TryGetValue(key, out var list)) total += list.Where(l => !excluded.Contains(l.Id)).Sum(l => l.Amount);
                    total += ExtraCosts(x == o ? calc : ReadCalculation(x, field));
                }
                result[o] = total;
            }
            return result;
        }

        // Orderbedrag excl. btw (na korting)
        internal static decimal OrderAmountExclTax(Database database, SalesOrder o)
        {
            var total = 0m;
            foreach (var l in o.Lines ?? [])
            {
                var amount = OrderSamenvoeging.LineAmount(o, l);
                if (o.AmountsIncludeTax && l.TaxCode.HasValue && database.SingleOrDefault<TaxCode>(l.TaxCode.Value) is TaxCode tc)
                {
                    var rate = tc.Rates.Sum();
                    if (rate != 0m) amount = Math.Round(amount / (1m + rate / 100m), 2, MidpointRounding.AwayFromZero);
                }
                total += amount;
            }
            return total;
        }

        internal static TextCustomField NewField() => new TextCustomField()
        {
            Key = Guid.CreateVersion7(),
            Name = CalculatieVeld,
            Placement = [ManagerServer.Model.Attributes.GuidAttribute.GetGuidByType(typeof(SalesOrder))],
            Type = ManagerServer.Model.Enums.TextCustomFieldType.ParagraphText,
            Description = "Gebruikt door het calculatieblok en het samenvoegen van verkooporders (inkoopkosten, extra kosten, opslag, herkomst van regels). Wordt in het formulier verborgen.",
            ExcludeFromCopyingOrCloning = true,
            DisplayOnView = false,
        };

        internal static TextCustomField FindField(Database database)
        {
            return database.OfType<TextCustomField>()
                .Where(x => !x.Inactive && string.Equals(x.Name?.Trim(), CalculatieVeld, StringComparison.OrdinalIgnoreCase) && ((ICustomField)x).Contains(typeof(SalesOrder)))
                .OrderBy(x => x.Key)
                .FirstOrDefault();
        }

        internal static string Render(string business, Guid? key)
        {
            var version = FilesVersion.Value;
            var dataUrl = new OrderCalculatieData() { Business = business }.ToUrl();
            var sb = new StringBuilder();
            sb.Append($@"<link rel=""stylesheet"" href=""resources/order-calculatie/order-calculatie.css?version={version}"" />");
            sb.Append($@"<script src=""resources/order-calculatie/order-calculatie.js?version={version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" data-order=""{key}"" id=""order-calculatie-script""></script>");
            return sb.ToString();
        }
    }

    // POST {actie: "gegevens", referentie, order} -> inkoopkosten van de order en de sleutel van het veld "Calculatie"
    // POST {actie: "veld-aanmaken"} -> maakt het eigen veld "Calculatie" voor verkooporders aan
    [ProtoContract]
    internal sealed class OrderCalculatieData : BusinessHandler
    {
        private static string PermissionNamespace => typeof(SalesOrderForm).Namespace;

        // Is er al een verkoopfactuur aan deze order gekoppeld?
        private bool IsInvoiced(SalesOrder o) =>
            new SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced([o]).Values.Any(x => x.InvoiceAmount != null);

        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            if (database == null || !(permissions.CanCreate(PermissionNamespace) || permissions.CanUpdate(PermissionNamespace)))
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

            var action = request["actie"]?.ToString();
            if (action == "veld-aanmaken")
            {
                if (OrderCalculatie.FindField(database) == null)
                {
                    var field = OrderCalculatie.NewField();
                    ApplicationData.Businesses.Process(Business, field, GetUserName());
                }
            }
            else if (action != "gegevens")
            {
                Response.StatusCode = 400;
                await Response.WriteAsync("Onbekende actie");
                return;
            }

            var reference = request["referentie"]?.ToString()?.Trim() ?? string.Empty;
            // Ook kosten van andere orders meetellen (bijv. bij samengevoegde orders)
            var references = new List<string>();
            if (reference.Length > 0) references.Add(reference);
            // Orders die in deze order zijn samengevoegd (ook via tussenstappen) tellen automatisch mee
            var opmerkingKey = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Opmerking);
            var mergedSubs = reference.Length > 0 ? OrderSamenvoeging.AllSubOrders(database, reference, opmerkingKey) : [];
            foreach (var sub in mergedSubs)
            {
                var r = sub.Reference?.Trim();
                if (!string.IsNullOrEmpty(r) && !references.Contains(r, StringComparer.OrdinalIgnoreCase)) references.Add(r);
            }
            if (request["referenties"] is JArray extra)
            {
                foreach (var e in extra.Select(x => x.ToString().Trim()).Where(x => x.Length > 0))
                {
                    if (!references.Contains(e, StringComparer.OrdinalIgnoreCase)) references.Add(e);
                }
            }
            var calculationField = OrderCalculatie.FindField(database);

            var refSet = new HashSet<string>(references.Select(x => x.ToLowerInvariant()));
            var costs = new JArray();
            var invoiceNumberFields = database.OfType<TextCustomField>().Where(x => string.Equals(x.Name?.Trim(), "Factuurnummer", StringComparison.OrdinalIgnoreCase)).Select(x => x.Key).ToArray();
            foreach (var c in OrderCalculatie.PurchaseCostLines(database).Where(x => refSet.Contains(x.Order)))
            {
                var invoice = c.Invoice;
                var line = c.Line;
                var supplier = invoice.Supplier.HasValue ? database.SingleOrDefault<Supplier>(invoice.Supplier.Value)?.Name : null;
                string invoiceNumber = null;
                if (invoice.CustomFields2?.Strings != null)
                    foreach (var k in invoiceNumberFields) if (invoice.CustomFields2.Strings.TryGetValue(k, out var v) && !string.IsNullOrWhiteSpace(v)) { invoiceNumber = v; break; }

                string description = line.LineDescription;
                if (string.IsNullOrWhiteSpace(description) && line.Item.HasValue) description = (database.SingleOrDefault(line.Item.Value) as NamedObject)?.GetName();
                if (string.IsNullOrWhiteSpace(description) && line.Account.HasValue) description = (database.SingleOrDefault(line.Account.Value) as NamedObject)?.GetName();

                costs.Add(new JObject
                {
                    ["id"] = c.Id,
                    ["factuur"] = invoice.Key.ToString(),
                    ["url"] = new PurchaseInvoices.PurchaseInvoiceView() { Business = Business, Key = invoice.Key }.ToUrl(),
                    ["datum"] = invoice.IssueDate.ToString("yyyy-MM-dd"),
                    ["referentie"] = invoice.Reference ?? string.Empty,
                    ["factuurnummer"] = invoiceNumber ?? string.Empty,
                    ["leverancier"] = supplier ?? string.Empty,
                    ["omschrijving"] = description ?? string.Empty,
                    ["aantal"] = line.Qty ?? 1m,
                    ["bedrag"] = c.Amount,
                    ["order"] = references.FirstOrDefault(r => r.ToLowerInvariant() == c.Order) ?? c.Order,
                });
            }
            var verkooporderVeldGevonden = OrderCalculatie.SalesOrderFieldKeys(database).Lines.Count + OrderCalculatie.SalesOrderFieldKeys(database).Invoices.Count > 0;

            // Samengevoegd uit / samengevoegd in
            var samengevoegdUit = new JArray();
            foreach (var sub in mergedSubs)
            {
                JArray subExtra = null;
                var raw = calculationField != null ? OrderSamenvoeging.GetString(sub, calculationField.Key) : null;
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    try { subExtra = JObject.Parse(raw)["extra"] as JArray; } catch { }
                }
                samengevoegdUit.Add(new JObject
                {
                    ["referentie"] = sub.Reference?.Trim(),
                    ["url"] = new SalesOrderView() { Business = Business, Key = sub.Key }.ToUrl(),
                    ["in"] = OrderSamenvoeging.MergedInto(sub, opmerkingKey),
                    ["extra"] = subExtra ?? new JArray(),
                });
            }
            JObject samengevoegdIn = null;
            if (Guid.TryParse(request["order"]?.ToString(), out var orderKey))
            {
                var self = database.SingleOrDefault<SalesOrder>(orderKey);
                var into = self != null ? OrderSamenvoeging.MergedInto(self, opmerkingKey) : null;
                if (into != null)
                {
                    var target = database.OfType<SalesOrder>().FirstOrDefault(x => !x.Cancelled && string.Equals(x.Reference?.Trim(), into, StringComparison.OrdinalIgnoreCase));
                    samengevoegdIn = new JObject
                    {
                        ["referentie"] = into,
                        ["url"] = target != null ? new SalesOrderView() { Business = Business, Key = target.Key }.ToUrl() : null,
                        ["gefactureerd"] = target != null && IsInvoiced(target),
                    };
                }
            }
            var mergePage = new OrdersSamenvoegen() { Business = Business }.ToUrl();
            var thisOrder = Guid.TryParse(request["order"]?.ToString(), out var thisKey) ? database.SingleOrDefault<SalesOrder>(thisKey) : null;

            var output = new JObject
            {
                ["samengevoegdUit"] = samengevoegdUit,
                ["samengevoegdIn"] = samengevoegdIn,
                ["samenvoegPagina"] = mergePage,
                ["gefactureerd"] = thisOrder != null && IsInvoiced(thisOrder),
                ["veld"] = calculationField?.Key.ToString(),
                ["veldNaam"] = OrderCalculatie.CalculatieVeld,
                ["verkooporderVeldGevonden"] = verkooporderVeldGevonden,
                ["inkoop"] = costs,
            };
            Response.ContentType = "application/json; charset=utf-8";
            await Response.WriteAsync(output.ToString(Formatting.None));
        }
    }
}
