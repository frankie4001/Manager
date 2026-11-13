using ManagerServer.Attributes;
using ManagerServer.Globalization;
using System;
using System.Linq;
using System.Text.Encodings.Web;
using System.Threading.Tasks;

namespace ManagerServer.HttpHandlers.Businesses.Business
{
    [ProtoContract]
    [Title(nameof(Strings.Email))]
    [Guide("This screen faciliate sending emails from Manager.")]
    internal sealed class EmailForm : BusinessTemplate
    {
        [ProtoMember(1)] public Guid? Source;

        protected override void InnerGet2()
        {
            if (!Request.HasFormContentType)
            {
                return;
            }

            var form = Request.ReadFormAsync().GetAwaiter().GetResult();

            var attachment = form["2be520d4-1fa1-4118-a5a5-627e0576a1c4"].ToString();
            var filename = form[nameof(SendEmail.FormData.Filename)].ToString();
            var to = form[nameof(SendEmail.FormData.To)].ToString();
            var subject = form[nameof(SendEmail.FormData.Subject)].ToString();
            var body = form[nameof(SendEmail.FormData.Body)].ToString();
            var variables = form["Variables"].ToString();            

            using (Div(@class: "flex items-start gap-4"))
            {
                using (Div(@class: "card flex-1"))
                {
                    using (Div(@class: "card-header"))
                    {
                        using (Div(@class: "card-title")) Write(Strings.Email);
                    }
                    using (Div(@class: "card-form"))
                    {
                        using (Div(@class: "form-group"))
                        {
                            using (Div(@class: "input-group"))
                            {
                                using (Div(@class: "input-group-text")) Write(Strings.To);
                                InputText(name: nameof(SendEmail.FormData.To), value: to, @class: "form-control", form: nameof(EmailForm));
                            }
                        }

                        using (Div(@class: "form-group"))
                        {
                            using (Div(@class: "input-group"))
                            {
                                using (Div(@class: "input-group-text")) Write(Strings.Subject);
                                InputText(name: nameof(SendEmail.FormData.Subject), value: subject, @class: "form-control", form: nameof(EmailForm));
                            }
                        }

                        using (Div(@class: "form-group"))
                        {
                            Textarea(name: nameof(SendEmail.FormData.Body), rows: 10, text: body, @class: "form-control field-sizing-content resize", spellcheck: true, form: nameof(EmailForm));
                        }

                        using (Script())
                        {
                            // Placeholders in the email template (subject and body) are filled in with
                            // Liquid, e.g. {{ InvoiceNumber }}, {{ Total }} or {{ CustomerName }}.
                            // The data comes from the same view data that themes use.
                            var dataUrl = Source.HasValue
                                ? new ManagerServer.Api.Businesses.Business.GetTransactionViewV1 { Business = Business, Key = Source, Language = Strings.CurrentLanguage.Value }.ToUrl()
                                : string.Empty;

                            // Localized field labels -> placeholder names, for views whose fields have no key.
                            var labelKeys = new System.Collections.Generic.Dictionary<string, string>();
                            void AddLabel(string label, string key) { if (!string.IsNullOrWhiteSpace(label) && !labelKeys.ContainsKey(label)) labelKeys[label] = key; }
                            AddLabel(Strings.InvoiceDate, nameof(Strings.InvoiceDate));
                            AddLabel(Strings.DueDate, nameof(Strings.DueDate));
                            AddLabel(Strings.InvoiceNumber, nameof(Strings.InvoiceNumber));
                            AddLabel(Strings.OrderNumber, nameof(Strings.OrderNumber));
                            AddLabel(Strings.QuoteNumber, nameof(Strings.QuoteNumber));
                            AddLabel(Strings.IssueDate, nameof(Strings.IssueDate));
                            AddLabel(Strings.Date, nameof(Strings.Date));
                            AddLabel(Strings.Reference, nameof(Strings.Reference));
                            AddLabel(Strings.Invoice, nameof(Strings.Invoice));

                            Write(@"(async () => {
// The Liquid library is not part of this page by default, so load it when needed.
if (typeof liquidjs === 'undefined') {
    try {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/resources/liquidjs/liquid.browser.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    } catch (e) { console.error('Could not load Liquid', e); return; }
}
const engine = new liquidjs.Liquid();
let variables = {};
const rawVariables = '" + JavaScriptEncoder.Default.Encode(variables ?? string.Empty) + @"';
if (rawVariables) { try { variables = JSON.parse(rawVariables); } catch (e) { } }

const dataUrl = '" + JavaScriptEncoder.Default.Encode(dataUrl) + @"';
const labelKeys = " + Newtonsoft.Json.JsonConvert.SerializeObject(labelKeys) + @";
const balanceDueLabel = '" + JavaScriptEncoder.Default.Encode(Strings.BalanceDue ?? string.Empty) + @"';
if (dataUrl) {
    try {
        const response = await fetch(dataUrl);
        if (response.ok) {
            const view = await response.json();
            if (view) {
                const v = Object.assign({}, view);
                v.Title = view.title;
                v.Reference = view.reference;
                v.Status = view.emphasis ? view.emphasis.text : '';
                // Placeholder name without spaces or special characters, e.g. 'Order nr.' -> 'Ordernr'
                const toName = label => (label || '').split('\n')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]/g, '');
                (view.fields || []).forEach(f => {
                    const firstLine = (f.label || '').split('\n')[0]; // bilingual labels have two lines
                    const key = f.key || labelKeys[f.label] || labelKeys[firstLine];
                    if (key && v[key] === undefined) v[key] = f.text;
                    const name = toName(f.label);
                    if (name && v[name] === undefined) v[name] = f.text;
                });
                // The document's own number and date under a name that fits the document type,
                // e.g. {{ OrderNumber }} and {{ OrderDate }} on a sales order confirmation.
                const ownNumber = { salesinvoice: 'InvoiceNumber', purchaseinvoice: 'InvoiceNumber', salesorder: 'OrderNumber', purchaseorder: 'OrderNumber', salesquote: 'QuoteNumber', purchasequote: 'QuoteNumber', creditnote: 'CreditNoteNumber', debitnote: 'DebitNoteNumber', deliverynote: 'DeliveryNoteNumber', goodsreceipt: 'GoodsReceiptNumber' }[view.type];
                const ownDate = { salesorder: 'OrderDate', purchaseorder: 'OrderDate', salesquote: 'QuoteDate', purchasequote: 'QuoteDate' }[view.type];
                if (ownNumber && view.reference) v[ownNumber] = view.reference;
                if (ownDate && v[ownDate] === undefined) v[ownDate] = v.IssueDate || v.Date;
                if (v.Reference === undefined) v.Reference = view.reference;
                if (v.InvoiceNumber === undefined && view.reference && !ownNumber) v.InvoiceNumber = view.reference;
                ((view.table && view.table.totals) || []).forEach(t => {
                    if (t.key && v[t.key] === undefined) v[t.key] = t.text;
                    if (t.label === balanceDueLabel) v.BalanceDue = t.text;
                });
                const r = view.recipient || {};
                v.CustomerName = v.SupplierName = v.RecipientName = r.name || '';
                v.RecipientCode = r.code || '';
                v.RecipientEmail = r.email || '';
                v.BusinessName = (view.business && view.business.name) || '';
                (view.custom_fields || []).forEach(c => {
                    if (c.label && v[c.label] === undefined) v[c.label] = c.text;
                    const name = toName(c.label);
                    if (name && v[name] === undefined) v[name] = c.text;
                });
                variables = Object.assign(v, variables);

                // Show the available placeholders in the browser console (F12 > Console).
                const list = {};
                Object.keys(variables).forEach(k => { const x = variables[k]; if (x === null || typeof x !== 'object') list[k] = x; });
                console.info('Email placeholders, e.g. {{ InvoiceNumber }}:');
                console.table(list);
            }
        }
    } catch (e) { console.error(e); }
}

const fill = async (name, template) => {
    try {
        // Also accept single braces, e.g. {InvoiceNumber}, for known placeholders.
        template = template.replace(/(^|[^{])\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g, (m, pre, key) => (key in variables) ? pre + '{{ ' + key + ' }}' : m);
        const x = await engine.parseAndRender(template, variables);
        document.getElementsByName(name)[0].value = x.trim();
    } catch (e) { console.error(e); }
};
await fill('" + nameof(SendEmail.FormData.Subject) + @"', '" + JavaScriptEncoder.Default.Encode(subject) + @"');
await fill('" + nameof(SendEmail.FormData.Body) + @"', '" + JavaScriptEncoder.Default.Encode(body) + @"');
})();
");
                        }

                        using (Div(@class: "form-group"))
                        {
                            using (Div(@class: "flex flex-wrap gap-2"))
                            {
                                using (Div(@class: "input-group"))
                                {
                                    using (Div(@class: "input-group-text"))
                                    {
                                        using (Label(@class: "flex items-start gap-2 mb-0 whitespace-normal text-start"))
                                        {
                                            InputHidden(name: nameof(SendEmail.FormData.PDF), value: attachment, form: nameof(EmailForm));
                                            InputHidden(name: nameof(SendEmail.FormData.Filename), value: filename, form: nameof(EmailForm));
                                            InputCheckbox(disabled: true, @checked: true, @class: "form-check-input");
                                            Write(filename + ".pdf");
                                        }
                                    }
                                }

                                if (Source.HasValue)
                                {
                                    foreach (var e in ApplicationData.Businesses.Get(Business).OfType<ManagerServer.Model.Attachment>().Where(x => x.Object == Source.Value).OrderBy(x => x.Name))
                                    {
                                        using (Div(@class: "input-group"))
                                        {
                                            using (Div(@class: "input-group-text"))
                                            {
                                                using (Label(@class: "flex items-start gap-2 mb-0 cursor-pointer whitespace-normal text-start"))
                                                {
                                                    InputCheckbox(name: nameof(SendEmail.FormData.Attachments), value: e.Key.ToString(), @class: "form-check-input", form: nameof(EmailForm));
                                                    Write(e.Name);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    using (Div(@class: "card-header"))
                    {
                        using (Div(@class: "flex gap-2 items-center"))
                        {
                            using (Form(id: nameof(EmailForm), method: "POST", action: new SendEmail() { Business = Business, Source = Source, Referrer = Referrer }.ToUrl(), hxBoost: true, hxDisabledElt: "button"))
                            {
                                using (Button(@class: "btn btn-primary"))
                                {
                                    Write(Strings.Send);
                                    I(@class: "htmx-indicator ms-2 fas fa-circle-notch fa-spin !hidden");
                                }
                            }
                            using (A(href: Referrer, @class: "btn")) Write(Strings.Cancel);
                        }
                    }
                }

                using (Div(@class: "card flex-1"))
                {
                    using (Div(@class: "card-header"))
                    {
                        using (Div(@class: "card-title")) Write(filename + ".pdf");
                    }

                    using (Div(@class: "card-body p-0"))
                    {
                        IFrame(src: "data:application/pdf;base64," + attachment, @class: "w-full aspect-2/3");
                    }
                }
            }            
        }

        protected override async Task InnerPost()
        {
            await Request.ReadFormAsync();
            await Get();
        }
    }
}
