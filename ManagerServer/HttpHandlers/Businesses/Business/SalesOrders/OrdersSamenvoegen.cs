using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using ManagerServer.Globalization;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: verkooporders samenvoegen en weer uit elkaar halen.
//
// Werkt op dezelfde manier als de eerdere extensie, zodat orders die daarmee zijn samengevoegd
// hier ook herkend en teruggedraaid kunnen worden:
//  - de nieuwe (of bestaande samengevoegde) order krijgt alle regels, elke omschrijving begint met
//    "[oud ordernummer]" en eindigt met het bestelnummer van die order tussen haakjes
//  - de oude orders worden geannuleerd met in het eigen veld "Opmerking" de regel
//    "samengevoegd in order X" (een eerdere opmerking blijft eronder staan)
// Alles gebeurt in één keer op de server (alles of niets).
//
// Alles staat in dit bestand en in wwwroot/resources/orders-samenvoegen/; in Manager zelf krijgt
// alleen de lijst met verkooporders een knop "Samenvoegen" (SalesOrders.OnHeaderStartSection).
namespace ManagerServer.HttpHandlers.Businesses.Business.SalesOrders
{
    internal static class OrderSamenvoeging
    {
        // Eigen velden: eerst op sleutel (zoals in de extensie), anders op naam
        public static readonly (Guid Key, string Name) Opmerking = (new Guid("89afb50d-e740-454d-bd5f-3a1790e72514"), "Opmerking");
        public static readonly (Guid Key, string Name) Bestelnummer = (new Guid("d1ee5bd0-ee99-496b-a53c-20d37778f1c7"), "Bestelnummer");
        public static readonly (Guid Key, string Name) Contactpersoon = (new Guid("e0ad84cf-d3ba-412e-8971-c914cafa049f"), "Contactpersoon");
        public static readonly (Guid Key, string Name) AfgLeverdatum = (new Guid("9b03402e-1fad-457e-8174-60a715182c49"), "Afg. leverdatum");
        public static readonly (Guid Key, string Name) InkoopMaterialen = (new Guid("aea48f9a-8605-49eb-a4fa-3c0000d2e7c6"), "Inkoop materialen exclusief btw");

        public const string SamengevoegdIn = "samengevoegd in order";
        public const string Teruggedraaid = "samenvoeging teruggedraaid";
        private static readonly Regex SamengevoegdRegex = new Regex(@"^\s*samengevoegd in order\s+(\S+)", RegexOptions.IgnoreCase);

        internal static Guid? FieldKey(Database database, (Guid Key, string Name) field)
        {
            var all = new List<ICustomField>();
            all.AddRange(database.OfType<TextCustomField>());
            all.AddRange(database.OfType<DateCustomField>());
            all.AddRange(database.OfType<NumberCustomField>());
            all.AddRange(database.OfType<MultipleValueCustomField>());
            all.AddRange(database.OfType<CheckboxCustomField>());
            var byKey = all.FirstOrDefault(x => x.Key == field.Key);
            if (byKey != null) return byKey.Key;
            return all.Where(x => !x.Inactive && string.Equals(x.Name?.Trim(), field.Name, StringComparison.OrdinalIgnoreCase) && x.Contains(typeof(SalesOrder))).Select(x => (Guid?)x.Key).FirstOrDefault();
        }

        internal static string GetString(SalesOrder o, Guid? key)
        {
            if (!key.HasValue) return null;
            if (o.CustomFields2?.Strings != null && o.CustomFields2.Strings.TryGetValue(key.Value, out var s)) return s;
            if (o.CustomFields != null && o.CustomFields.TryGetValue(key.Value, out var s2)) return s2;
            return null;
        }

        internal static void SetString(SalesOrder o, Guid key, string value)
        {
            o.CustomFields2 ??= new CustomFields();
            o.CustomFields2.Strings ??= new Dictionary<Guid, string>();
            if (string.IsNullOrEmpty(value)) o.CustomFields2.Strings.Remove(key);
            else o.CustomFields2.Strings[key] = value;
            if (o.CustomFields != null && o.CustomFields.ContainsKey(key)) o.CustomFields[key] = value ?? string.Empty;
        }

        internal static void ClearField(SalesOrder o, Guid? key)
        {
            if (!key.HasValue) return;
            var k = key.Value;
            var cf = o.CustomFields2;
            if (cf != null)
            {
                cf.Strings?.Remove(k);
                cf.Decimals?.Remove(k);
                cf.Dates?.Remove(k);
                cf.Booleans?.Remove(k);
                cf.StringArrays?.Remove(k);
                cf.Images?.Remove(k);
            }
            if (o.CustomFields != null && o.CustomFields.ContainsKey(k)) o.CustomFields[k] = string.Empty;
        }

        // "samengevoegd in order 800" -> "800" (alleen bij geannuleerde orders)
        internal static string MergedInto(SalesOrder o, Guid? opmerkingKey)
        {
            if (!o.Cancelled) return null;
            var text = GetString(o, opmerkingKey);
            if (string.IsNullOrWhiteSpace(text)) return null;
            var m = SamengevoegdRegex.Match(text);
            return m.Success ? m.Groups[1].Value : null;
        }

        internal static string[] Bestelnummers(SalesOrder o, Guid? key)
        {
            if (!key.HasValue) return [];
            var list = new List<string>();
            var s = GetString(o, key);
            if (!string.IsNullOrWhiteSpace(s)) list.Add(s.Trim());
            if (o.CustomFields2?.StringArrays != null && o.CustomFields2.StringArrays.TryGetValue(key.Value, out var arr) && arr != null) list.AddRange(arr.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));
            return list.Distinct().ToArray();
        }

        internal static Regex PrefixRegex(string reference) => new Regex("^\\[" + Regex.Escape(reference) + "\\](\\s|$)");

        // Herkenning van een orderregel (om bij terugdraaien de juiste regels terug te vinden)
        internal static string Fingerprint(SalesOrder.Line l) =>
            (l.LineDescription ?? string.Empty).Trim() + "|" + (l.Qty ?? 1m).ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + l.SalesUnitPrice.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + l.Item;

        // Regels in de samengevoegde order die van een deelorder komen. Bij nieuwe samenvoegingen staat dat in
        // de calculatie van de order ("samenvoeging"); bij oudere (extensie) aan "[ordernummer]" voor de omschrijving.
        internal static List<int> SubLineIndices(SalesOrder target, string subReference, JObject calc, HashSet<int> used)
        {
            var result = new List<int>();
            var lines = target.Lines ?? [];
            var map = calc?["samenvoeging"] as JObject;
            var fingerprints = map?.Properties().FirstOrDefault(p => string.Equals(p.Name, subReference, StringComparison.OrdinalIgnoreCase))?.Value as JArray;
            if (fingerprints != null)
            {
                foreach (var fp in fingerprints.Select(x => x.ToString()))
                {
                    for (var i = 0; i < lines.Length; i++)
                    {
                        if (used.Contains(i) || Fingerprint(lines[i]) != fp) continue;
                        used.Add(i); result.Add(i); break;
                    }
                }
                return result;
            }
            var prefix = PrefixRegex(subReference ?? string.Empty);
            for (var i = 0; i < lines.Length; i++)
            {
                if (used.Contains(i) || !prefix.IsMatch((lines[i].LineDescription ?? string.Empty).Trim())) continue;
                used.Add(i); result.Add(i);
            }
            return result;
        }

        internal static int ExpectedLines(JObject calc, string subReference)
        {
            var map = calc?["samenvoeging"] as JObject;
            var fps = map?.Properties().FirstOrDefault(p => string.Equals(p.Name, subReference, StringComparison.OrdinalIgnoreCase))?.Value as JArray;
            return fps?.Count ?? -1;
        }

        // Orders die (direct) in deze order zijn samengevoegd
        internal static SalesOrder[] SubOrders(Database database, string reference, Guid? opmerkingKey)
        {
            if (string.IsNullOrWhiteSpace(reference)) return [];
            return database.OfType<SalesOrder>()
                .Where(x => string.Equals(MergedInto(x, opmerkingKey), reference.Trim(), StringComparison.OrdinalIgnoreCase))
                .OrderBy(x => x.Reference, NumericComparer.Instance)
                .ToArray();
        }

        // Alle orders die (ook via tussenstappen) in deze order zijn samengevoegd
        internal static SalesOrder[] AllSubOrders(Database database, string reference, Guid? opmerkingKey)
        {
            var result = new List<SalesOrder>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { reference?.Trim() ?? string.Empty };
            var queue = new Queue<string>();
            queue.Enqueue(reference);
            while (queue.Count > 0)
            {
                foreach (var sub in SubOrders(database, queue.Dequeue(), opmerkingKey))
                {
                    if (!seen.Add(sub.Reference?.Trim() ?? string.Empty)) continue;
                    result.Add(sub);
                    queue.Enqueue(sub.Reference);
                }
            }
            return result.ToArray();
        }

        internal static decimal LineAmount(SalesOrder order, SalesOrder.Line line)
        {
            var amount = Math.Round((line.Qty ?? 1m) * line.SalesUnitPrice, 2, MidpointRounding.AwayFromZero);
            if (order.Discount)
            {
                if (order.DiscountType == ManagerServer.Model.Enums.DiscountType.Percentage) amount = Math.Round(amount * (1m - line.DiscountPercentage / 100m), 2, MidpointRounding.AwayFromZero);
                else amount -= line.DiscountAmount;
            }
            return amount;
        }

        internal static decimal OrderAmount(SalesOrder o) => (o.Lines ?? []).Sum(x => LineAmount(o, x));

        internal sealed class NumericComparer : IComparer<string>
        {
            public static readonly NumericComparer Instance = new NumericComparer();
            public int Compare(string a, string b)
            {
                var na = long.TryParse(a?.Trim(), out var x);
                var nb = long.TryParse(b?.Trim(), out var y);
                if (na && nb) return x.CompareTo(y);
                if (na != nb) return na ? -1 : 1;
                return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
            }
        }
    }

    [ProtoContract]
    [Title("Verkooporders samenvoegen")]
    internal sealed class OrdersSamenvoegen : BusinessTemplate
    {
        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "orders-samenvoegen.js", "orders-samenvoegen.css" })
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

        protected override void InnerGet2()
        {
            var version = FilesVersion.Value;
            var dataUrl = new OrdersSamenvoegenData() { Business = Business }.ToUrl();
            var listUrl = new SalesOrders() { Business = Business }.ToUrl();
            var formUrl = new SalesOrderForm() { Business = Business }.ToUrl();
            Write($@"<link rel=""stylesheet"" href=""resources/orders-samenvoegen/orders-samenvoegen.css?version={version}"" />");
            using (Div(@class: "card"))
            {
                using (Div(@class: "card-header"))
                {
                    using (Div(@class: "card-title")) Write("Verkooporders samenvoegen");
                }
                Write(@"<div id=""os-app"" class=""os""><p class=""os-zacht"">Laden…</p></div>");
            }
            Write($@"<script src=""resources/orders-samenvoegen/orders-samenvoegen.js?version={version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" data-lijst=""{System.Net.WebUtility.HtmlEncode(listUrl)}"" id=""orders-samenvoegen-script""></script>");
        }
    }

    // POST {actie: "lijst"} | {actie: "samenvoegen", orders, doel, referentie, omschrijving} | {actie: "terugdraaien", doel, orders}
    [ProtoContract]
    internal sealed class OrdersSamenvoegenData : BusinessHandler
    {
        private static string PermissionNamespace => typeof(SalesOrderForm).Namespace;

        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            if (database == null || !permissions.CanCreate(PermissionNamespace) || !permissions.CanUpdate(PermissionNamespace))
            {
                Response.StatusCode = 403;
                await Response.WriteAsync("Geen toegang (aanmaken en bewerken van verkooporders is nodig).");
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
                var action = request["actie"]?.ToString();
                JObject message = null;
                if (action == "samenvoegen") message = Merge(database, request);
                else if (action == "terugdraaien") message = Unmerge(database, request);
                else if (action != "lijst") throw new InvalidOperationException("Onbekende actie");

                var output = List(ApplicationData.Businesses.Get(Business));
                if (message != null) output["resultaat"] = message;
                Response.ContentType = "application/json; charset=utf-8";
                await Response.WriteAsync(output.ToString(Formatting.None));
            }
            catch (InvalidOperationException ex)
            {
                Response.StatusCode = 400;
                await Response.WriteAsync(ex.Message);
            }
        }

        private string OrderUrl(Guid key) => new SalesOrderView() { Business = Business, Key = key }.ToUrl();
        private string OrderEditUrl(Guid key) => new SalesOrderForm() { Business = Business, Key = key }.ToUrl();

        private JObject List(Database database)
        {
            var opmerking = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Opmerking);
            var bestel = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Bestelnummer);
            var orders = database.OfType<SalesOrder>().ToArray();

            // Nog te factureren (niet volledig gefactureerd), niet geannuleerd
            var status = new SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced(orders);
            bool IsOpen(SalesOrder o) => !o.Cancelled && (!status.TryGetValue(o, out var s) || s.InvoiceStatus != SalesOrders.InvoiceStatus.Invoiced);
            bool IsInvoiced(SalesOrder o) => status.TryGetValue(o, out var s) && s.InvoiceAmount != null;
            var calcField = OrderCalculatie.FindField(database)?.Key;

            var customers = database.OfType<Customer>().ToDictionary(x => x.Key, x => x.Name ?? string.Empty);
            string CustomerName(SalesOrder o) => o.Customer.HasValue && customers.TryGetValue(o.Customer.Value, out var n) ? n : "(geen klant)";

            JObject Order(SalesOrder o) => new JObject
            {
                ["key"] = o.Key.ToString(),
                ["referentie"] = o.Reference ?? string.Empty,
                ["datum"] = o.Date.ToString("yyyy-MM-dd"),
                ["klant"] = CustomerName(o),
                ["klantKey"] = o.Customer?.ToString(),
                ["omschrijving"] = o.Description ?? (o.Lines ?? []).Select(x => x.LineDescription).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)) ?? string.Empty,
                ["bedrag"] = OrderSamenvoeging.OrderAmount(o),
                ["inclBtw"] = o.AmountsIncludeTax,
                ["regels"] = new JArray((o.Lines ?? []).Select(l => new JObject
                {
                    ["omschrijving"] = l.LineDescription ?? string.Empty,
                    ["aantal"] = l.Qty ?? 1m,
                    ["prijs"] = l.SalesUnitPrice,
                    ["bedrag"] = OrderSamenvoeging.LineAmount(o, l),
                })),
                ["bestelnummer"] = string.Join(", ", OrderSamenvoeging.Bestelnummers(o, bestel)),
                ["url"] = OrderUrl(o.Key),
                ["bewerken"] = OrderEditUrl(o.Key),
            };

            var open = orders.Where(IsOpen).OrderBy(x => x.Reference, OrderSamenvoeging.NumericComparer.Instance).ToArray();

            // Samengevoegde orders (niet geannuleerd) met hun geannuleerde deelorders
            var merged = new JArray();
            foreach (var group in orders.Select(x => (Order: x, Into: OrderSamenvoeging.MergedInto(x, opmerking))).Where(x => x.Into != null).GroupBy(x => x.Into, StringComparer.OrdinalIgnoreCase))
            {
                var target = orders.FirstOrDefault(x => !x.Cancelled && string.Equals(x.Reference?.Trim(), group.Key, StringComparison.OrdinalIgnoreCase));
                if (target == null) continue;
                // Al (deels) gefactureerde samengevoegde orders kunnen niet meer worden teruggedraaid of aangevuld
                if (IsInvoiced(target)) continue;
                var calc = OrderCalculatie.ReadCalculation(target, calcField);
                var subs = new JArray();
                foreach (var sub in group.Select(x => x.Order).OrderBy(x => x.Reference, OrderSamenvoeging.NumericComparer.Instance))
                {
                    var j = Order(sub);
                    var idx = OrderSamenvoeging.SubLineIndices(target, sub.Reference?.Trim(), calc, new HashSet<int>());
                    j["regelsInDoel"] = idx.Count;
                    j["regelsVerwacht"] = OrderSamenvoeging.ExpectedLines(calc, sub.Reference?.Trim());
                    j["bedragInDoel"] = idx.Sum(i => OrderSamenvoeging.LineAmount(target, target.Lines[i]));
                    subs.Add(j);
                }
                var t = Order(target);
                t["deelorders"] = subs;
                t["open"] = IsOpen(target);
                merged.Add(t);
            }

            long next = 0;
            try { next = ((IHasAutomaticReference)new SalesOrder()).GetNextReference(orders.Cast<IHasAutomaticReference>()); } catch { }
            if (next <= 0) next = orders.Select(x => long.TryParse(x.Reference?.Trim(), out var n) ? n : 0).DefaultIfEmpty(0).Max() + 1;

            return new JObject
            {
                ["open"] = new JArray(open.Select(Order)),
                ["samengevoegd"] = merged,
                ["volgendNummer"] = next.ToString(),
                ["opmerkingVeld"] = opmerking.HasValue,
            };
        }

        private static string LineText(SalesOrder order, SalesOrder.Line line, Guid? bestel)
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(line.LineDescription)) parts.Add(line.LineDescription.Trim());
            var numbers = OrderSamenvoeging.Bestelnummers(order, bestel);
            if (numbers.Length > 0) parts.Add("(" + string.Join(", ", numbers) + ")");
            return string.Join(" ", parts);
        }

        private JObject Merge(Database database, JObject request)
        {
            var opmerking = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Opmerking)
                ?? throw new InvalidOperationException("Het eigen veld \"Opmerking\" voor verkooporders is niet gevonden; daarin wordt bijgehouden in welke order een order is samengevoegd.");
            var bestel = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Bestelnummer);

            var keys = (request["orders"] as JArray)?.Select(x => Guid.Parse(x.ToString())).Distinct().ToArray() ?? [];
            var orders = keys.Select(k => database.SingleOrDefault<SalesOrder>(k) ?? throw new InvalidOperationException("Een gekozen order bestaat niet meer; vernieuw de pagina."))
                .OrderBy(x => x.Reference, OrderSamenvoeging.NumericComparer.Instance).ToArray();
            SalesOrder target = null;
            if (Guid.TryParse(request["doel"]?.ToString(), out var targetKey))
            {
                target = database.SingleOrDefault<SalesOrder>(targetKey) ?? throw new InvalidOperationException("De gekozen samengevoegde order bestaat niet meer.");
                if (target.Cancelled) throw new InvalidOperationException("Order " + target.Reference + " is geannuleerd.");
                if (orders.Any(x => x.Key == target.Key)) throw new InvalidOperationException("Order " + target.Reference + " staat zelf in de selectie.");
            }

            if (target != null && new SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced([target]).Values.Any(x => x.InvoiceAmount != null))
                throw new InvalidOperationException("Order " + target.Reference + " is al (deels) gefactureerd; daar kunnen geen orders meer aan worden toegevoegd.");
            if (orders.Length < (target == null ? 2 : 1)) throw new InvalidOperationException(target == null ? "Kies minstens twee orders." : "Kies minstens één order.");
            foreach (var o in orders)
            {
                if (o.Cancelled) throw new InvalidOperationException("Order " + o.Reference + " is geannuleerd.");
                if (string.IsNullOrWhiteSpace(o.Reference)) throw new InvalidOperationException("Een gekozen order heeft geen ordernummer.");
            }
            var all = target == null ? orders : orders.Append(target).ToArray();
            if (all.Select(x => x.Customer).Distinct().Count() > 1) throw new InvalidOperationException("De orders hebben niet dezelfde klant.");
            if (all.Select(x => x.AmountsIncludeTax).Distinct().Count() > 1) throw new InvalidOperationException("De orders verschillen in 'bedragen incl. btw'.");
            if (all.Select(x => x.Discount ? x.DiscountType : (ManagerServer.Model.Enums.DiscountType?)null).Where(x => x != null).Distinct().Count() > 1)
                throw new InvalidOperationException("De orders gebruiken verschillende soorten korting (percentage en bedrag).");

            var changed = new List<ManagerServer.Model.Object>();
            // In het verborgen veld "Calculatie" van de samengevoegde order wordt bijgehouden welke regels van welke order komen
            var calcFieldObject = OrderCalculatie.FindField(database);
            if (calcFieldObject == null)
            {
                calcFieldObject = OrderCalculatie.NewField();
                changed.Add(calcFieldObject);
            }
            JObject Herkomst(JObject calc)
            {
                if (calc["samenvoeging"] is not JObject map) calc["samenvoeging"] = map = new JObject();
                foreach (var o in orders) map[o.Reference.Trim()] = new JArray((o.Lines ?? []).Select(l => { var c = ProtoBuf.Serializer.DeepClone(l); c.LineDescription = LineText(o, l, bestel); return OrderSamenvoeging.Fingerprint(c); }));
                if (calc["v"] == null) calc["v"] = 1;
                return calc;
            }
            string targetRef;
            if (target == null)
            {
                targetRef = request["referentie"]?.ToString()?.Trim();
                if (string.IsNullOrWhiteSpace(targetRef)) throw new InvalidOperationException("Vul een ordernummer in.");
                if (database.OfType<SalesOrder>().Any(x => string.Equals(x.Reference?.Trim(), targetRef, StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidOperationException("Ordernummer " + targetRef + " bestaat al.");

                var created = ProtoBuf.Serializer.DeepClone(orders[0]);
                created.Key = Guid.CreateVersion7();
                created.Date = DateTime.Today;
                created.Reference = targetRef;
                created.AutomaticReference = false;
                created.Cancelled = false;
                created.Description = request["omschrijving"]?.ToString()?.Trim();
                if (string.IsNullOrWhiteSpace(created.Description)) created.Description = "Samengevoegde orders " + string.Join(", ", orders.Select(x => x.Reference.Trim()));
                created.Discount = orders.Any(x => x.Discount);
                created.Lines = orders.SelectMany(o => (o.Lines ?? []).Select(l =>
                {
                    var c = ProtoBuf.Serializer.DeepClone(l);
                    c.LineDescription = LineText(o, l, bestel);
                    return c;
                })).ToArray();

                // Deze velden blijven leeg op de nieuwe order; vinkvelden staan uit
                OrderSamenvoeging.ClearField(created, bestel);
                OrderSamenvoeging.ClearField(created, opmerking);
                OrderSamenvoeging.ClearField(created, OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Contactpersoon));
                OrderSamenvoeging.ClearField(created, OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.AfgLeverdatum));
                OrderSamenvoeging.ClearField(created, OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.InkoopMaterialen));
                OrderSamenvoeging.ClearField(created, OrderCalculatie.FindField(database)?.Key);
                if (created.CustomFields2?.Booleans != null) foreach (var k in created.CustomFields2.Booleans.Keys.ToArray()) created.CustomFields2.Booleans[k] = false;
                OrderSamenvoeging.SetString(created, calcFieldObject.Key, Herkomst(new JObject()).ToString(Formatting.None));
                changed.Add(created);
                target = created;
            }
            else
            {
                targetRef = target.Reference?.Trim();
                var updated = (SalesOrder)target.DeepClone();
                updated.Lines = (updated.Lines ?? []).Concat(orders.SelectMany(o => (o.Lines ?? []).Select(l =>
                {
                    var c = ProtoBuf.Serializer.DeepClone(l);
                    c.LineDescription = LineText(o, l, bestel);
                    return c;
                }))).ToArray();
                if (orders.Any(x => x.Discount)) updated.Discount = true;
                if (updated.Description != null && updated.Description.StartsWith("Samengevoegde orders ", StringComparison.OrdinalIgnoreCase))
                    updated.Description += ", " + string.Join(", ", orders.Select(x => x.Reference.Trim()));
                OrderSamenvoeging.SetString(updated, calcFieldObject.Key, Herkomst(OrderCalculatie.ReadCalculation(target, calcFieldObject.Key)).ToString(Formatting.None));
                changed.Add(updated);
                target = updated;
            }

            // Oude orders annuleren met "samengevoegd in order X" (een eerdere opmerking blijft eronder staan)
            foreach (var o in orders)
            {
                var c = (SalesOrder)o.DeepClone();
                var old = OrderSamenvoeging.GetString(o, opmerking)?.Trim() ?? string.Empty;
                c.Cancelled = true;
                OrderSamenvoeging.SetString(c, opmerking, OrderSamenvoeging.SamengevoegdIn + " " + targetRef + (old.Length > 0 ? "\n" + old : string.Empty));
                changed.Add(c);
            }

            ApplicationData.Businesses.Process(Business, changed.ToArray(), GetUserName());

            return new JObject
            {
                ["tekst"] = $"Klaar: {orders.Length} order(s) samengevoegd in order {targetRef} en geannuleerd.",
                ["key"] = target.Key.ToString(),
                ["url"] = OrderUrl(target.Key),
            };
        }

        private JObject Unmerge(Database database, JObject request)
        {
            var opmerking = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Opmerking)
                ?? throw new InvalidOperationException("Het eigen veld \"Opmerking\" voor verkooporders is niet gevonden.");
            if (!Guid.TryParse(request["doel"]?.ToString(), out var targetKey)) throw new InvalidOperationException("Geen samengevoegde order gekozen.");
            var target = database.SingleOrDefault<SalesOrder>(targetKey) ?? throw new InvalidOperationException("De samengevoegde order bestaat niet meer.");
            if (target.Cancelled) throw new InvalidOperationException("Order " + target.Reference + " is geannuleerd.");
            var targetRef = target.Reference?.Trim() ?? string.Empty;

            var keys = (request["orders"] as JArray)?.Select(x => Guid.Parse(x.ToString())).Distinct().ToArray() ?? [];
            var subs = keys.Select(k => database.SingleOrDefault<SalesOrder>(k) ?? throw new InvalidOperationException("Een gekozen order bestaat niet meer; vernieuw de pagina.")).ToArray();
            if (subs.Length == 0) throw new InvalidOperationException("Kies minstens één order om uit de samenvoeging te halen.");
            foreach (var s in subs)
            {
                if (!string.Equals(OrderSamenvoeging.MergedInto(s, opmerking), targetRef, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Order " + s.Reference + " is niet samengevoegd in order " + targetRef + ".");
            }

            if (new SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced([target]).Values.Any(x => x.InvoiceAmount != null))
                throw new InvalidOperationException("Order " + targetRef + " is al (deels) gefactureerd en kan niet meer worden teruggedraaid.");

            var calcField = OrderCalculatie.FindField(database)?.Key;
            var calc = OrderCalculatie.ReadCalculation(target, calcField);
            var used = new HashSet<int>();
            foreach (var s in subs) OrderSamenvoeging.SubLineIndices(target, s.Reference?.Trim(), calc, used);
            var lines = target.Lines ?? [];
            var keep = lines.Where((l, i) => !used.Contains(i)).ToArray();
            var gone = subs.Select(s => s.Reference.Trim()).ToArray();

            var changed = new List<ManagerServer.Model.Object>();
            var updated = (SalesOrder)target.DeepClone();
            if (calcField.HasValue && calc["samenvoeging"] is JObject herkomst)
            {
                foreach (var p in herkomst.Properties().Where(p => gone.Contains(p.Name, StringComparer.OrdinalIgnoreCase)).ToArray()) p.Remove();
                OrderSamenvoeging.SetString(updated, calcField.Value, calc.ToString(Formatting.None));
            }
            string text;
            if (keep.Length == 0)
            {
                // Hele samenvoeging teruggedraaid: de samengevoegde order zelf annuleren (regels blijven ter informatie staan)
                var old = OrderSamenvoeging.GetString(target, opmerking)?.Trim() ?? string.Empty;
                updated.Cancelled = true;
                OrderSamenvoeging.SetString(updated, opmerking, OrderSamenvoeging.Teruggedraaid + (old.Length > 0 ? "\n" + old : string.Empty));
                text = $"Klaar: order {targetRef} is geannuleerd en {subs.Length} order(s) hersteld.";
            }
            else
            {
                updated.Lines = keep.Select(l => ProtoBuf.Serializer.DeepClone(l)).ToArray();
                var m = Regex.Match(updated.Description ?? string.Empty, "^(samengevoegde orders )(.*)$", RegexOptions.IgnoreCase);
                if (m.Success)
                {
                    var rest = m.Groups[2].Value.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0 && !gone.Contains(x, StringComparer.OrdinalIgnoreCase)).ToArray();
                    if (rest.Length > 0) updated.Description = m.Groups[1].Value + string.Join(", ", rest);
                }
                text = $"Klaar: {subs.Length} order(s) uit order {targetRef} gehaald en hersteld ({lines.Length - keep.Length} regels verwijderd).";
            }
            changed.Add(updated);

            foreach (var s in subs)
            {
                var c = (SalesOrder)s.DeepClone();
                c.Cancelled = false;
                var full = OrderSamenvoeging.GetString(s, opmerking) ?? string.Empty;
                var rest = string.Join("\n", full.Replace("\r\n", "\n").Split('\n').Skip(1)).Trim();
                OrderSamenvoeging.SetString(c, opmerking, rest);
                changed.Add(c);
            }

            ApplicationData.Businesses.Process(Business, changed.ToArray(), GetUserName());
            return new JObject { ["tekst"] = text, ["key"] = target.Key.ToString(), ["url"] = OrderUrl(target.Key) };
        }
    }
}
