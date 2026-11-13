using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Reflection;
using ManagerServer.Globalization;
using ManagerServer.Model;

// Eigen aanpassing: overzicht van alle eigen velden met hun gebruik, om op te ruimen.
// Verschijnt vanzelf als tegel onder Instellingen → Eigen velden (NamespaceEntry in deze map).
// Per veld: waar het staat, in hoeveel documenten het is ingevuld, wanneer voor het laatst,
// voorbeeldwaarden, of een eigen aanpassing het gebruikt, en een advies.
namespace ManagerServer.HttpHandlers.Businesses.Business.Settings.CustomFields.Overzicht
{
    [ProtoContract]
    [NamespaceEntry]
    [Title("Overzicht eigen velden")]
    internal sealed class Overzicht : BusinessTemplate
    {
        private sealed class Veld
        {
            public ICustomField Def;
            public string Soort;
            public List<string> Plekken = new();
            public List<Type> Types = new();
            public int Ingevuld;
            public int Documenten;
            public DateTime Laatst = DateTime.MinValue;
            public List<string> Voorbeelden = new();
            public string Aanpassing;
            public string Advies;
            public int Ernst;   // 0 = in gebruik, 1 = let op, 2 = kan waarschijnlijk weg
        }

        // Velden die de eigen aanpassingen gebruiken (op naam, kleine letters)
        private static readonly (string Naam, string Waarvoor, bool Vervangen)[] Aanpassingen =
        {
            ("factuurnummer", "PDF-import, betaallijst", false),
            ("bankrekening", "PDF-import (IBAN-controle), betaallijst", false),
            ("verkooporder", "PDF-import, calculatieblok, kolom Kosten", false),
            ("calculatie", "calculatieblok, samenvoegen van orders (verborgen veld)", false),
            ("opmerking", "samenvoegen van orders (\"samengevoegd in order …\")", false),
            ("opmerkingen", "betaallijst (kolom Opmerking)", false),
            ("bestelnummer", "samenvoegen, Bestelnummer ontbreekt", false),
            ("contactpersoon", "contactpersonen (keuzelijst, beheerpagina)", false),
            ("factuur betaald", "betaallijst (markeren als betaald)", false),
            ("afg. leverdatum", "samenvoegen (wordt leeggemaakt op de nieuwe order)", false),
            ("inkoop materialen exclusief btw", "samenvoegen (wordt leeggemaakt). Vervangen door het calculatieblok en de kolom Kosten", true),
        };

        private static string Norm(string s) => (s ?? string.Empty).Trim().ToLowerInvariant();

        protected override void InnerGet2()
        {
            var database = ApplicationData.Businesses.Get(Business);
            var velden = new List<Veld>();
            void Voeg<T>(string soort) where T : ManagerServer.Model.Object, ICustomField, new()
            {
                foreach (var f in database.OfType<T>()) velden.Add(new Veld { Def = f, Soort = soort });
            }
            Voeg<TextCustomField>("Tekst");
            Voeg<NumberCustomField>("Getal");
            Voeg<DateCustomField>("Datum");
            Voeg<CheckboxCustomField>("Vinkje");
            Voeg<MultipleValueCustomField>("Meerdere waarden");
            Voeg<ImageCustomField>("Afbeelding");
            var perKey = velden.ToDictionary(x => x.Def.Key);

            // Alle plekken (soorten documenten en regels) waar eigen velden op staan, één keer doorlopen
            var types = velden.SelectMany(v => v.Def.Placement ?? []).Distinct()
                .Select(g => (Guid: g, Type: ManagerServer.Model.Attributes.GuidAttribute.GetTypeByGuid(g))).Where(x => x.Type != null).ToList();
            foreach (var v in velden)
            {
                v.Types = (v.Def.Placement ?? []).Select(g => types.FirstOrDefault(t => t.Guid == g).Type).Where(t => t != null).Distinct().ToList();
                v.Plekken = v.Types.Select(PlekNaam).ToList();
            }
            var aantal = new Dictionary<Type, int>();

            var bezocht = new HashSet<Type>();
            foreach (var (_, type) in types)
            {
                var hoofd = type.IsNested ? type.DeclaringType : type;
                if (!bezocht.Add(type)) continue;
                if (hoofd == null || !typeof(ManagerServer.Model.Object).IsAssignableFrom(hoofd)) continue;
                var regelProps = type.IsNested
                    ? hoofd.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.PropertyType.IsArray && p.PropertyType.GetElementType() == type).ToArray()
                    : null;
                IEnumerable<ManagerServer.Model.Object> objecten;
                try { objecten = database.UnorderedOfType(hoofd).ToArray(); } catch { continue; }
                foreach (var o in objecten)
                {
                    var datum = Datum(o);
                    if (regelProps == null) { Tel(o, datum, perKey); aantal[type] = aantal.GetValueOrDefault(type) + 1; }
                    else foreach (var p in regelProps)
                        if (p.GetValue(o) is IEnumerable regels) foreach (var r in regels) if (r != null) { Tel(r, datum, perKey); aantal[type] = aantal.GetValueOrDefault(type) + 1; }
                }
            }

            foreach (var v in velden) v.Documenten = v.Types.Sum(t => aantal.GetValueOrDefault(t));

            // Advies
            foreach (var v in velden)
            {
                var a = Aanpassingen.FirstOrDefault(x => x.Naam == Norm(v.Def.Name) || (x.Naam == "factuur betaald" && v.Soort == "Vinkje" && Norm(v.Def.Name).Contains("betaald")));
                if (a.Naam != null) v.Aanpassing = a.Waarvoor;
                var dubbel = velden.Where(x => x != v && Norm(x.Def.Name) == Norm(v.Def.Name) && (x.Def.Placement ?? []).Intersect(v.Def.Placement ?? []).Any()).ToList();

                if (v.Def.Inactive) { v.Advies = v.Ingevuld == 0 ? "Staat op inactief en is nergens ingevuld: kan weg." : "Staat op inactief (bewaarde gegevens blijven zichtbaar in oude documenten)."; v.Ernst = v.Ingevuld == 0 ? 2 : 0; }
                else if ((v.Def.Placement ?? []).Length == 0) { v.Advies = "Staat op geen enkel formulier: kan weg."; v.Ernst = 2; }
                else if (dubbel.Count > 0)
                {
                    var anderGebruikt = dubbel.Any(x => x.Ingevuld > v.Ingevuld);
                    v.Advies = $"Dubbel: er is nog een veld \"{v.Def.Name}\" op dezelfde plek" + (anderGebruikt ? $" dat vaker gebruikt wordt ({dubbel.Max(x => x.Ingevuld)}×). Deze kan waarschijnlijk weg." : ". Kijk welke je wilt houden.");
                    v.Ernst = anderGebruikt && v.Ingevuld == 0 ? 2 : 1;
                }
                else if (a.Vervangen) { v.Advies = "Wordt niet meer nodig: " + a.Waarvoor.Split(". ").Last() + ". Zet op inactief als je het niet meer invult (oude gegevens blijven bewaard)."; v.Ernst = 1; }
                else if (v.Ingevuld == 0 && v.Aanpassing == null) { v.Advies = "Nergens ingevuld en niet nodig voor een aanpassing: kan waarschijnlijk weg."; v.Ernst = 2; }
                else if (v.Ingevuld == 0) { v.Advies = "Nog nergens ingevuld, maar wel nodig voor een aanpassing: laten staan."; v.Ernst = 0; }
                else if (v.Laatst > DateTime.MinValue && v.Laatst < DateTime.Today.AddMonths(-12) && v.Aanpassing == null) { v.Advies = $"Al meer dan een jaar niet gebruikt (laatst {v.Laatst:dd-MM-yyyy}). Overweeg op inactief te zetten."; v.Ernst = 1; }
                else { v.Advies = v.Aanpassing != null ? "In gebruik; nodig voor een aanpassing." : "In gebruik."; v.Ernst = 0; }
            }

            Write(@"<style>
.ev { padding: 1rem; font-size: .875rem; }
.ev-uitleg { color: #525252; margin: 0 0 1rem; max-width: 60rem; line-height: 1.5; }
.ev-kop { font-weight: 700; margin: 1.25rem 0 .5rem; display: flex; align-items: center; gap: .5rem; }
.ev-teller { font-weight: 600; font-size: .75rem; border-radius: 999px; padding: 0 .5rem; }
.ev-weg .ev-teller { background: #fee2e2; color: #991b1b; } .ev-let .ev-teller { background: #fef3c7; color: #92400e; } .ev-ok .ev-teller { background: #dcfce7; color: #166534; }
.ev table { width: 100%; border-collapse: collapse; }
.ev th { text-align: left; font-weight: 600; color: #525252; padding: .375rem .5rem; border-bottom: 1px solid #d4d4d4; white-space: nowrap; }
.ev td { padding: .375rem .5rem; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
.ev td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ev .zacht { color: #737373; } .ev .klein { font-size: .75rem; }
.ev .label { display: inline-block; font-size: .6875rem; border-radius: .25rem; padding: 0 .375rem; background: #eff6ff; color: #1e40af; }
.ev .inactief { background: #f5f5f5; color: #737373; }
.ev a { color: #2563eb; }
</style>");
            using (Div(@class: "card"))
            {
                using (Div(@class: "card-header"))
                {
                    using (Div(@class: "card-title")) Write("Overzicht eigen velden");
                }
                Write(@"<div class=""ev"">");
                Write($@"<p class=""ev-uitleg"">Alle {velden.Count} eigen velden, met waar ze staan, in hoeveel documenten (of regels) ze zijn ingevuld en wanneer voor het laatst.
Velden die een van de eigen aanpassingen gebruikt, zijn gemarkeerd: die niet verwijderen of hernoemen.
<b>Tip:</b> zet een veld eerst op <i>inactief</i> (bij Bewerken) in plaats van het te verwijderen. Het verdwijnt dan uit de formulieren, maar ingevulde gegevens blijven bewaard en je kunt het altijd terugzetten.</p>");

                Groep(velden.Where(x => x.Ernst == 2), "Kan waarschijnlijk weg", "ev-weg");
                Groep(velden.Where(x => x.Ernst == 1), "Let op", "ev-let");
                Groep(velden.Where(x => x.Ernst == 0), "In gebruik", "ev-ok");
                Write("</div>");
            }
        }

        private void Groep(IEnumerable<Veld> lijst, string titel, string cls)
        {
            var rijen = lijst.OrderBy(x => x.Def.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            if (rijen.Count == 0) return;
            Write($@"<div class=""ev-kop {cls}"">{WebUtility.HtmlEncode(titel)} <span class=""ev-teller"">{rijen.Count}</span></div>");
            Write(@"<table><thead><tr><th>Naam</th><th>Soort</th><th>Staat op</th><th class=""num"">Ingevuld</th><th>Laatst</th><th>Voorbeelden</th><th>Advies</th><th></th></tr></thead><tbody>");
            foreach (var v in rijen)
            {
                var url = BewerkUrl(v.Def);
                Write("<tr>");
                Write($@"<td><b>{WebUtility.HtmlEncode(v.Def.Name ?? "(naamloos)")}</b>{(v.Def.Inactive ? @" <span class=""label inactief"">inactief</span>" : "")}{(v.Aanpassing != null ? $@"<div><span class=""label"" title=""{WebUtility.HtmlEncode(v.Aanpassing)}"">aanpassing</span> <span class=""zacht klein"">{WebUtility.HtmlEncode(v.Aanpassing)}</span></div>" : "")}</td>");
                Write($@"<td class=""zacht"">{WebUtility.HtmlEncode(v.Soort)}</td>");
                Write($@"<td class=""klein"">{WebUtility.HtmlEncode(string.Join(", ", v.Plekken))}</td>");
                Write($@"<td class=""num"">{v.Ingevuld}<div class=""zacht klein"">van {v.Documenten}</div></td>");
                Write($@"<td class=""zacht"" style=""white-space:nowrap"">{(v.Laatst > DateTime.MinValue ? v.Laatst.ToString("dd-MM-yyyy") : "–")}</td>");
                Write($@"<td class=""zacht klein"">{WebUtility.HtmlEncode(string.Join(" · ", v.Voorbeelden))}</td>");
                Write($@"<td class=""klein"">{WebUtility.HtmlEncode(v.Advies)}</td>");
                Write($@"<td>{(url != null ? $@"<a href=""{WebUtility.HtmlEncode(url)}"">Bewerken</a>" : "")}</td>");
                Write("</tr>");
            }
            Write("</tbody></table>");
        }

        private string BewerkUrl(ICustomField f)
        {
            try
            {
                var type = Assembly.GetHttpHandlerTypeByCamelCaseKey(f.GetType().Name + "Form");
                if (type == null) return null;
                var h = (HttpFramework.HttpHandler)Activator.CreateInstance(type);
                type.GetField("Business")?.SetValue(h, Business);
                type.GetProperty("Business")?.SetValue(h, Business);
                var key = (System.Reflection.MemberInfo)type.GetField("Key") ?? type.GetProperty("Key");
                if (key is FieldInfo fi) fi.SetValue(h, (Guid?)f.Key); else if (key is PropertyInfo pi) pi.SetValue(h, (Guid?)f.Key);
                var referrer = (System.Reflection.MemberInfo)type.GetField("Referrer") ?? type.GetProperty("Referrer");
                if (referrer is FieldInfo rf) rf.SetValue(h, this.ToUrl()); else if (referrer is PropertyInfo rp) rp.SetValue(h, this.ToUrl());
                return h.ToUrl();
            }
            catch { return null; }
        }

        private static string PlekNaam(Type t)
        {
            if (t.IsNested) return Strings.GetPropertyValue(t.DeclaringType.Name) + " (regels)";
            return Strings.GetPropertyValue(t.Name);
        }

        private static DateTime Datum(object o)
        {
            foreach (var n in new[] { "IssueDate", "Date" })
                if (o.GetType().GetProperty(n)?.GetValue(o) is DateTime d && d > DateTime.MinValue) return d;
            return DateTime.MinValue;
        }

        // Telt per veld of het in dit document/deze regel is ingevuld
        private static void Tel(object o, DateTime datum, Dictionary<Guid, Veld> velden)
        {
            var cf = o.GetType().GetProperty("CustomFields2")?.GetValue(o) as ManagerServer.Model.CustomFields;
            var oud = o.GetType().GetProperty("CustomFields")?.GetValue(o) as Dictionary<Guid, string>;
            var gevonden = new Dictionary<Guid, string>();
            if (cf != null)
            {
                if (cf.Strings != null) foreach (var e in cf.Strings) if (!string.IsNullOrWhiteSpace(e.Value)) gevonden[e.Key] = e.Value;
                if (cf.Decimals != null) foreach (var e in cf.Decimals) if (e.Value.HasValue) gevonden[e.Key] = e.Value.Value.ToString("0.##");
                if (cf.Dates != null) foreach (var e in cf.Dates) if (e.Value.HasValue) gevonden[e.Key] = e.Value.Value.ToString("dd-MM-yyyy");
                if (cf.Booleans != null) foreach (var e in cf.Booleans) if (e.Value) gevonden[e.Key] = "ja";
                if (cf.StringArrays != null) foreach (var e in cf.StringArrays) if (e.Value != null && e.Value.Any(x => !string.IsNullOrWhiteSpace(x))) gevonden[e.Key] = string.Join(", ", e.Value);
                if (cf.Images != null) foreach (var e in cf.Images) if (e.Value.HasValue) gevonden[e.Key] = "(afbeelding)";
            }
            if (oud != null) foreach (var e in oud) if (!string.IsNullOrWhiteSpace(e.Value) && !gevonden.ContainsKey(e.Key)) gevonden[e.Key] = e.Value;

            foreach (var (k, waarde) in gevonden)
            {
                if (!velden.TryGetValue(k, out var v)) continue;
                v.Ingevuld++;
                if (datum > v.Laatst) v.Laatst = datum;
                var w = waarde.Replace("\r", " ").Replace("\n", " ").Trim();
                if (w.Length > 40) w = w.Substring(0, 40) + "…";
                if (v.Voorbeelden.Count < 3 && !v.Voorbeelden.Contains(w)) v.Voorbeelden.Add(w);
            }
        }
    }
}
