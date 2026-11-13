using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: PDF-inkoopfactuur inlezen.
//
// Alles van deze functie staat in dit bestand en in wwwroot/resources/pdf-import/.
// In Manager zelf zijn alleen twee haakjes nodig:
//  - VueForm: InnerGet5() (na het formulier) en OnSaved() (na opslaan)
//  - PurchaseInvoiceForm: roept PdfImport.Render() en PdfImport.OnSavedAsync() aan
//
// Sjablonen en geleerde herkenning staan in <datamap>/pdf-sjablonen.json, zodat ze een
// update van Manager overleven en in de back-up van de datamap zitten.
namespace ManagerServer.HttpHandlers.Businesses.Business.PurchaseInvoices
{
    internal static class PdfImport
    {
        public const string FileField = "PdfImportBestand";
        public const string InfoField = "PdfImportInfo";

        // Instellingen (zelfde betekenis als in de oude extensie)
        public const string FactuurnummerVeld = "Factuurnummer";
        public const string BankrekeningVeld = "Bankrekening";
        public const string VerkooporderVeld = "Verkooporder";
        public const string StandaardRekening = "Kosten van grond- en hulpstoffen en inkoopprijs van de verkopen (materialen)";
        public const string AfrondingOmschrijving = "Btw-afrondingsverschil";

        private static readonly object fileLock = new object();

        internal static string GetFilePath() => Path.Combine(DirectoryResolver.Resolve(), "pdf-sjablonen.json");

        // Inhoud van pdf-sjablonen.json; zonder bestand de meegeleverde standaardsjablonen.
        internal static JObject Load()
        {
            lock (fileLock)
            {
                JObject data = null;
                try
                {
                    var path = GetFilePath();
                    if (File.Exists(path)) data = JObject.Parse(File.ReadAllText(path, Encoding.UTF8));
                }
                catch (Exception ex)
                {
                    Console.WriteLine("pdf-sjablonen.json kon niet worden gelezen: " + ex.Message);
                }

                if (data == null)
                {
                    data = new JObject();
                    try
                    {
                        var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                        using var stream = provider.GetFileInfo("resources/pdf-import/standaard-sjablonen.json").CreateReadStream();
                        using var reader = new StreamReader(stream, Encoding.UTF8);
                        data = JObject.Parse(reader.ReadToEnd());
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("Standaard PDF-sjablonen konden niet worden geladen: " + ex.Message);
                    }
                }

                if (data["sjablonen"] is not JArray) data["sjablonen"] = new JArray();
                if (data["herkenning"] is not JObject) data["herkenning"] = new JObject();
                return data;
            }
        }

        internal static void Save(JObject data)
        {
            lock (fileLock)
            {
                var path = GetFilePath();
                var temp = path + ".tmp";
                File.WriteAllText(temp, data.ToString(Formatting.Indented), new UTF8Encoding(false));
                File.Move(temp, path, true);
            }
        }

        internal static void Update(Action<JObject> change)
        {
            lock (fileLock)
            {
                var data = Load();
                change(data);
                Save(data);
            }
        }

        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "pdf-import.js", "pdf-import-parser.js", "pdf-import.css", "pdf.min.js" })
                {
                    using var stream = provider.GetFileInfo("resources/pdf-import/" + name).CreateReadStream();
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

        // Knop en paneel boven het nieuwe-inkoopfactuurformulier
        internal static string Render(string business)
        {
            // Vingerafdruk van de bestanden i.p.v. het versienummer van Manager: de browser bewaart
            // deze bestanden een jaar, dus elke wijziging moet een nieuw adres krijgen.
            var version = FilesVersion.Value;
            var dataUrl = new PdfImportData() { Business = business }.ToUrl();
            var sb = new StringBuilder();
            sb.Append($@"<link rel=""stylesheet"" href=""resources/pdf-import/pdf-import.css?version={version}"" />");
            sb.Append($@"<script src=""resources/pdf-import/pdf.min.js?version={version}""></script>");
            sb.Append($@"<script src=""resources/pdf-import/pdf-import-parser.js?version={version}""></script>");
            sb.Append($@"<script src=""resources/pdf-import/pdf-import.js?version={version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" data-worker=""resources/pdf-import/pdf.worker.min.js?version={version}"" data-versie=""{version}"" id=""pdf-import-script""></script>");
            return sb.ToString();
        }

        // Na het opslaan van de inkoopfactuur: PDF als bijlage bewaren en de herkenning leren.
        internal static async Task OnSavedAsync(ManagerServer.ApplicationData applicationData, string business, string userName, PurchaseInvoice invoice, IFormCollection form)
        {
            var file = form.Files[FileField];
            if (file != null && file.Length > 0)
            {
                await using var stream = file.OpenReadStream();
                var sha256 = await applicationData.Storage.WriteAsync(stream);
                var name = string.IsNullOrWhiteSpace(file.FileName) ? "factuur.pdf" : Path.GetFileName(file.FileName);
                applicationData.Businesses.Process(business, new Attachment() { Key = Guid.CreateVersion7(), Object = invoice.Key, Name = name, Date = DateTime.UtcNow, Size = (int)file.Length, Sha256 = sha256 }, userName);
            }

            var info = form[InfoField].ToString();
            if (string.IsNullOrWhiteSpace(info) || !invoice.Supplier.HasValue) return;
            try
            {
                var o = JObject.Parse(info);
                var numbers = (o["nummers"] as JArray)?.Select(x => x.ToString().Replace(" ", "").ToUpperInvariant()).Where(x => x.Length >= 8).Distinct().ToArray() ?? [];
                if (numbers.Length == 0) return;
                var supplier = applicationData.Businesses.Get(business).SingleOrDefault<Supplier>(invoice.Supplier.Value);
                Update(data =>
                {
                    var learned = (JObject)data["herkenning"];
                    foreach (var number in numbers)
                    {
                        // Per nummer de leveranciers waarbij het voorkwam. Komt een nummer bij meerdere
                        // leveranciers voor (bijv. het eigen btw-nummer), dan telt het niet meer mee.
                        var list = learned[number] as JArray ?? new JArray();
                        if (!list.Any(x => x["key"]?.ToString() == invoice.Supplier.Value.ToString()))
                        {
                            list.Add(new JObject { ["key"] = invoice.Supplier.Value.ToString(), ["naam"] = supplier?.Name ?? string.Empty });
                        }
                        learned[number] = list;
                    }
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine("PDF-import: herkenning niet opgeslagen: " + ex.Message);
            }
        }
    }

    // Gegevens voor het inlezen (GET) en sjablonen opslaan/verwijderen (POST)
    [ProtoContract]
    internal sealed class PdfImportData : BusinessHandler
    {
        private static string PermissionNamespace => typeof(PurchaseInvoiceForm).Namespace;

        public override async Task Get()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            if (database == null || !permissions.CanCreate(PermissionNamespace))
            {
                Response.StatusCode = 403;
                await Response.WriteAsync("Geen toegang");
                return;
            }

            var settings = new JsonSerializerSettings();
            settings.ContractResolver = new VueForm<PurchaseInvoice>.CustomContractResolver(skipKey: false);
            settings.Converters.Add(new VueForm<PurchaseInvoice>.GuidSerializer(database, new Dictionary<Guid, NamedObject>(), []));
            settings.Converters.Add(new VueForm<PurchaseInvoice>.DateTimeConverter());
            var serializer = JsonSerializer.Create(settings);
            JToken Obj(ManagerServer.Model.Object o) => o == null ? null : JToken.FromObject(o, serializer);

            var invoices = database.OfType<PurchaseInvoice>().OrderByDescending(x => x.IssueDate).ToArray();

            // Eigen velden
            var textFields = database.OfType<TextCustomField>().Where(x => !x.Inactive).ToArray();
            Guid? FieldKey(string name, Type type, Func<PurchaseInvoice, IEnumerable<CustomFields>> usage)
            {
                var candidates = textFields.Where(x => string.Equals(x.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase) && ((ICustomField)x).Contains(type)).ToArray();
                if (candidates.Length <= 1) return candidates.FirstOrDefault()?.Key;
                // Meerdere velden met dezelfde naam: het meest gebruikte
                return candidates.OrderByDescending(c => invoices.SelectMany(usage).Count(cf => cf?.Strings != null && cf.Strings.ContainsKey(c.Key))).First().Key;
            }
            var invoiceNumberKey = FieldKey(PdfImport.FactuurnummerVeld, typeof(PurchaseInvoice), x => [x.CustomFields2]);
            var bankAccountKey = FieldKey(PdfImport.BankrekeningVeld, typeof(PurchaseInvoice), x => [x.CustomFields2]);
            var salesOrderLineKey = FieldKey(PdfImport.VerkooporderVeld, typeof(PurchaseInvoice.Line), x => (x.Lines ?? []).Select(l => l.CustomFields2));
            var salesOrderInvoiceKey = FieldKey(PdfImport.VerkooporderVeld, typeof(PurchaseInvoice), x => [x.CustomFields2]);

            // Leveranciers met hun tekst (voor btw-nummer/IBAN) en de laatst gebruikte instellingen
            var suppliers = new JArray();
            foreach (var s in database.OfType<Supplier>().Where(x => !x.Inactive).OrderBy(x => x.Name))
            {
                var text = new List<string> { s.Name, s.Code, s.Address, s.Email };
                if (s.CustomFields2?.Strings != null) text.AddRange(s.CustomFields2.Strings.Values);
                if (s.CustomFields != null) text.AddRange(s.CustomFields.Values);

                var own = invoices.Where(x => x.Supplier == s.Key).ToArray();
                var ibans = new JArray();
                if (bankAccountKey.HasValue)
                {
                    foreach (var e in own)
                    {
                        if (e.CustomFields2?.Strings != null && e.CustomFields2.Strings.TryGetValue(bankAccountKey.Value, out var iban) && !string.IsNullOrWhiteSpace(iban))
                        {
                            ibans.Add(new JObject { ["iban"] = iban, ["referentie"] = e.Reference, ["datum"] = e.IssueDate.ToString("yyyy-MM-dd") });
                        }
                    }
                }

                JObject last = null;
                var recent = own.FirstOrDefault();
                if (recent != null)
                {
                    var line = (recent.Lines ?? []).FirstOrDefault(x => x.Account.HasValue);
                    last = new JObject
                    {
                        ["rekening"] = line?.Account?.ToString(),
                        ["btwCode"] = line?.TaxCode?.ToString(),
                        ["termijn"] = recent.DueDate == ManagerServer.Model.Enums.DueDateType.Net ? recent.DueDateDays : null,
                    };
                }

                suppliers.Add(new JObject
                {
                    ["key"] = s.Key.ToString(),
                    ["naam"] = s.Name ?? string.Empty,
                    ["tekst"] = string.Join("\n", text.Where(x => !string.IsNullOrWhiteSpace(x))),
                    ["ibans"] = ibans,
                    ["laatste"] = last,
                    ["obj"] = Obj(s),
                });
            }

            // Grootboekrekeningen (resultatenrekening eerst) en btw-codes
            var accounts = new JArray();
            foreach (var a in database.OfType<ProfitAndLossStatementAccount>().Cast<NamedObject>().OrderBy(x => x.GetName())
                .Concat(database.OfType<BalanceSheetAccount>().Cast<NamedObject>().OrderBy(x => x.GetName())))
            {
                if (a.IsInactive()) continue;
                accounts.Add(new JObject { ["key"] = a.Key.ToString(), ["naam"] = a.GetName() ?? string.Empty, ["weergave"] = a.UniqueName ?? string.Empty, ["obj"] = Obj(a) });
            }
            var taxCodes = new JArray();
            foreach (var t in database.OfType<TaxCode>().Where(x => !x.Inactive).OrderBy(x => x.Name))
            {
                taxCodes.Add(new JObject { ["key"] = t.Key.ToString(), ["naam"] = t.GetDisplayName() ?? string.Empty, ["tarief"] = t.Rates.Sum(), ["obj"] = Obj(t) });
            }

            // Openstaande verkooporders (niet geannuleerd en niet volledig gefactureerd)
            var salesOrders = new JArray();
            if (salesOrderLineKey.HasValue || salesOrderInvoiceKey.HasValue)
            {
                try
                {
                    var orders = database.OfType<SalesOrder>().Where(x => !x.Cancelled).ToArray();
                    var status = new SalesOrders.SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced(orders);
                    foreach (var e in orders.OrderByDescending(x => x.Date))
                    {
                        if (status.TryGetValue(e, out var st) && st.InvoiceStatus == SalesOrders.SalesOrders.InvoiceStatus.Invoiced) continue;
                        var customer = e.Customer.HasValue ? database.SingleOrDefault<Customer>(e.Customer.Value)?.Name : null;
                        var description = e.Description ?? (e.Lines ?? []).Select(x => x.LineDescription).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)) ?? string.Empty;
                        if (description.Length > 40) description = description.Substring(0, 40);
                        salesOrders.Add(new JObject
                        {
                            ["waarde"] = e.Reference ?? string.Empty,
                            ["naam"] = string.Join(" - ", new[] { e.Reference, customer, description }.Where(x => !string.IsNullOrWhiteSpace(x))),
                        });
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("PDF-import: verkooporders niet geladen: " + ex.Message);
                }
            }

            // Verkooporderveld per regel of op factuurniveau (waar het in bestaande facturen gebruikt wordt)
            string salesOrderLevel = null;
            Guid? salesOrderKey = null;
            if (salesOrderLineKey.HasValue && salesOrderInvoiceKey.HasValue)
            {
                var onLines = invoices.Count(x => (x.Lines ?? []).Any(l => l.CustomFields2?.Strings?.ContainsKey(salesOrderLineKey.Value) == true));
                var onInvoice = invoices.Count(x => x.CustomFields2?.Strings?.ContainsKey(salesOrderInvoiceKey.Value) == true);
                if (onInvoice > onLines) { salesOrderLevel = "factuur"; salesOrderKey = salesOrderInvoiceKey; }
                else { salesOrderLevel = "regel"; salesOrderKey = salesOrderLineKey; }
            }
            else if (salesOrderLineKey.HasValue) { salesOrderLevel = "regel"; salesOrderKey = salesOrderLineKey; }
            else if (salesOrderInvoiceKey.HasValue) { salesOrderLevel = "factuur"; salesOrderKey = salesOrderInvoiceKey; }

            // Thema van de meest recente inkoopfactuur
            JObject theme = null;
            var latest = invoices.FirstOrDefault();
            if (latest != null && latest.CustomTheme && latest.CustomThemeId.HasValue)
            {
                var themeObject = database.SingleOrDefault(latest.CustomThemeId.Value);
                if (themeObject != null) theme = new JObject { ["CustomTheme"] = true, ["CustomThemeId"] = Obj(themeObject) };
            }

            // Eigen gegevens (eigen btw-nummer/IBAN tellen niet voor het herkennen van de leverancier)
            var businessDetails = database.Single<BusinessDetails>();
            var ownText = new List<string> { businessDetails.Name, businessDetails.Address };
            if (businessDetails.CustomFields2?.Strings != null) ownText.AddRange(businessDetails.CustomFields2.Strings.Values);
            if (businessDetails.CustomFields != null) ownText.AddRange(businessDetails.CustomFields.Values);

            var file = PdfImport.Load();
            var output = new JObject
            {
                ["leveranciers"] = suppliers,
                ["rekeningen"] = accounts,
                ["btwCodes"] = taxCodes,
                ["verkooporders"] = salesOrders,
                ["velden"] = new JObject
                {
                    ["factuurnummer"] = invoiceNumberKey?.ToString(),
                    ["bankrekening"] = bankAccountKey?.ToString(),
                    ["verkooporder"] = salesOrderKey?.ToString(),
                    ["verkooporderNiveau"] = salesOrderLevel,
                },
                ["namen"] = new JObject
                {
                    ["factuurnummer"] = PdfImport.FactuurnummerVeld,
                    ["bankrekening"] = PdfImport.BankrekeningVeld,
                    ["verkooporder"] = PdfImport.VerkooporderVeld,
                },
                ["thema"] = theme,
                ["eigenTekst"] = string.Join("\n", ownText.Where(x => !string.IsNullOrWhiteSpace(x))),
                ["eigenNaam"] = businessDetails.Name ?? Business,
                ["standaardRekening"] = PdfImport.StandaardRekening,
                ["afrondingOmschrijving"] = PdfImport.AfrondingOmschrijving,
                ["sjablonen"] = file["sjablonen"],
                ["herkenning"] = file["herkenning"],
                ["bestand"] = PdfImport.GetFilePath(),
            };

            Response.ContentType = "application/json; charset=utf-8";
            await Response.WriteAsync(output.ToString(Formatting.None));
        }

        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            if (ApplicationData.Businesses.Get(Business) == null || !permissions.CanCreate(PermissionNamespace))
            {
                Response.StatusCode = 403;
                await Response.WriteAsync("Geen toegang");
                return;
            }

            string body;
            using (var reader = new StreamReader(Request.Body, Encoding.UTF8)) body = await reader.ReadToEndAsync();

            JObject request;
            try { request = JObject.Parse(body); }
            catch
            {
                Response.StatusCode = 400;
                await Response.WriteAsync("Ongeldige gegevens");
                return;
            }

            var action = request["actie"]?.ToString();
            JArray result = null;
            try
            {
                PdfImport.Update(data =>
                {
                    var templates = (JArray)data["sjablonen"];
                    if (action == "opslaan" && request["sjabloon"] is JObject template)
                    {
                        var id = template["id"]?.ToString();
                        if (string.IsNullOrWhiteSpace(id)) template["id"] = id = Guid.NewGuid().ToString();
                        template["gewijzigd"] = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm");
                        var existing = templates.FirstOrDefault(x => x["id"]?.ToString() == id);
                        if (existing != null) existing.Replace(template);
                        else templates.Add(template);
                    }
                    else if (action == "verwijderen")
                    {
                        var id = request["id"]?.ToString();
                        foreach (var e in templates.Where(x => x["id"]?.ToString() == id).ToArray()) e.Remove();
                    }
                    else throw new InvalidOperationException("Onbekende actie");
                    result = templates;
                });
            }
            catch (Exception ex)
            {
                Response.StatusCode = 400;
                await Response.WriteAsync(ex.Message);
                return;
            }

            Response.ContentType = "application/json; charset=utf-8";
            await Response.WriteAsync(new JObject { ["sjablonen"] = result }.ToString(Formatting.None));
        }
    }
}
