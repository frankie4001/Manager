using System.IO;
using System.Linq;
using System.Threading.Tasks;
using ManagerServer.Model;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Eigen aanpassing: overzicht van nog te factureren verkooporders zonder bestelnummer, per klant,
// om te kopiëren (voor een e-mail aan de klant) of af te drukken. Vervangt het gelijknamige tabblad
// van de eerdere extensie. Knop staat bij Verkooporders (SalesOrders.OnHeaderStartSection).
namespace ManagerServer.HttpHandlers.Businesses.Business.SalesOrders
{
    [ProtoContract]
    [Title("Bestelnummer ontbreekt")]
    internal sealed class BestelnummerOntbreekt : BusinessTemplate
    {
        private static readonly Lazy<string> FilesVersion = new Lazy<string>(() =>
        {
            try
            {
                var provider = new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(HttpServer).Assembly, "wwwroot");
                using var sha = System.Security.Cryptography.SHA256.Create();
                foreach (var name in new[] { "bestelnummer-ontbreekt.js", "orders-samenvoegen.css" })
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
            var dataUrl = new BestelnummerOntbreektData() { Business = Business }.ToUrl();
            Write($@"<link rel=""stylesheet"" href=""resources/orders-samenvoegen/orders-samenvoegen.css?version={version}"" />");
            using (Div(@class: "card"))
            {
                using (Div(@class: "card-header"))
                {
                    using (Div(@class: "card-title")) Write("Verkooporders zonder bestelnummer");
                }
                Write(@"<div id=""bo-app"" class=""os""><p class=""os-zacht"">Laden…</p></div>");
            }
            Write($@"<script src=""resources/orders-samenvoegen/bestelnummer-ontbreekt.js?version={version}"" data-url=""{System.Net.WebUtility.HtmlEncode(dataUrl)}"" id=""bestelnummer-ontbreekt-script""></script>");
        }
    }

    [ProtoContract]
    internal sealed class BestelnummerOntbreektData : BusinessHandler
    {
        public override async Task Post()
        {
            var permissions = GetCurrentUserPermissions(Business);
            var database = ApplicationData.Businesses.Get(Business);
            if (database == null || !permissions.CanView(typeof(SalesOrderForm).Namespace))
            {
                Response.StatusCode = 403;
                await Response.WriteAsync("Geen toegang");
                return;
            }

            var bestel = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Bestelnummer);
            var contact = OrderSamenvoeging.FieldKey(database, OrderSamenvoeging.Contactpersoon);
            var orders = database.OfType<SalesOrder>().Where(x => !x.Cancelled).ToArray();
            var status = new SalesOrders() { HttpContext = HttpContext, Business = Business }.GetInvoiced(orders);
            var customers = database.OfType<Customer>().ToDictionary(x => x.Key, x => x.Name ?? string.Empty);

            var list = new JArray();
            foreach (var o in orders)
            {
                if (status.TryGetValue(o, out var s) && s.InvoiceStatus == SalesOrders.InvoiceStatus.Invoiced) continue;
                if (OrderSamenvoeging.Bestelnummers(o, bestel).Length > 0) continue;
                list.Add(new JObject
                {
                    ["referentie"] = o.Reference ?? string.Empty,
                    ["klant"] = o.Customer.HasValue && customers.TryGetValue(o.Customer.Value, out var n) ? n : "(geen klant)",
                    ["omschrijving"] = o.Description ?? (o.Lines ?? []).Select(x => x.LineDescription).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)) ?? string.Empty,
                    ["contactpersoon"] = string.Join(", ", OrderSamenvoeging.Bestelnummers(o, contact)),
                    ["url"] = new SalesOrderView() { Business = Business, Key = o.Key }.ToUrl(),
                });
            }

            Response.ContentType = "application/json; charset=utf-8";
            await Response.WriteAsync(new JObject { ["orders"] = list, ["bestelnummerVeld"] = bestel.HasValue }.ToString(Formatting.None));
        }
    }
}
