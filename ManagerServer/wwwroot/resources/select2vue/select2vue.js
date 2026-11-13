Vue.component("select2", {
    props: ['value', 'multiple', 'autocompleteFilter', 'autocompleteSubtext', 'width', 'autocompleteUrl', 'autocompleteOnChange', 'noMatchesText', 'searchingText', 'placeholder'],
    data: function () {
        return {
            data: []
        }
    },
    template: "<input type='hidden' />",
    mounted: function () {
        var vm = this;
        this.data = this.value;
        $(this.$el)
            // init select2
            .select2({
                allowClear: true,
                dropdownAutoWidth: true,
                placeholder: this.placeholder,
                multiple: (this.multiple == 'true' ? true : false),
                id: 'Key',
                formatResult: function (item) {
                    var output = item.UniqueName;
                    if (vm.autocompleteSubtext && item[vm.autocompleteSubtext] != null) output = '<div class="flex justify-between items-center gap-3"><div>' + output + '</div><div class="opacity-50">' + item[vm.autocompleteSubtext].UniqueName + '</div></div>';
                    return output;
                },
                formatSelection: function (item) { return item.UniqueName; },
                formatNoMatches: this.noMatchesText,
                formatSearching: this.searchingText,
                ajax:
                {
                    url: function () { return vm.autocompleteUrl },
                    dataType: 'json',
                    width: 'copy',
                    data: function (term, page) { return { Term: term, Page: page, Filter: vm.autocompleteFilter } },
                    results: function (data, page) { return data; }
                }
            })
            .select2('data', this.data)
            .trigger("change")
            // emit event on change.
            .on("change", function () {
                vm.data = $(this).select2('data');
                vm.$emit("input", vm.data);
                vm.autocompleteOnChange(vm.data);
            });        
    },
    watch: {
        value: function (value) {
            // update value
            if (this.data != value) {
                this.data = value;
                $(this.$el).select2('data', value);
            }
        }
    },
    destroyed: function () {
        $(this.$el)
            .off()
            .select2("destroy");
    }
});

Vue.component("input-decimal", {
    props: ['value', 'groupSeparator', 'decimalSeparator', 'minWidth', 'nullable', 'placeholder'],
    data: function () {
        return {
            number: null
        }
    },
    template: "<input type='text' class='form-control field-sizing-content' style='text-align: right; min-inline-size: 10ch' />",
    mounted: function () {
        var vm = this;
        this.number = this.value;
        if (this.nullable == 'true') {
            if (this.number != null) this.$el.value = this.number.toString().replace('.', decimalSeparator);
        }
        else {
            if (this.number != 0) this.$el.value = this.number.toString().replace('.', decimalSeparator);
            this.$el.placeholder = this.placeholder;
        }
        this.$el.style.minWidth = this.minWidth;
        // Numeric keypad decimal key: insert the business's decimal separator
        // (e.g. ',' for Dutch number format) instead of the character the
        // keyboard layout produces, like Excel and banking sites do.
        $(this.$el).on('keydown', function (e) {
            var ev = e.originalEvent || e;
            if (ev.code === 'NumpadDecimal' && vm.decimalSeparator && ev.key !== vm.decimalSeparator) {
                e.preventDefault();
                this.setRangeText(vm.decimalSeparator, this.selectionStart, this.selectionEnd, 'end');
                this.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        $(this.$el).on('input', function () {
            var text = $(this).val() || '';
            text = text.replaceAll(vm.groupSeparator, '');
            text = text.replaceAll(vm.decimalSeparator, '.');
            text = text.replaceAll(' ', '');
            if (text.length == 0) {
                if (vm.nullable == 'true') {
                    vm.number = null;
                    vm.$emit('input', null);
                }
                else {
                    vm.number = 0;
                    vm.$emit('input', 0);
                }
            }
            else {
                try { var parsedNumber = new Mexp().eval(text); } catch (e) { }
                if (typeof parsedNumber != 'number') {
                    $(this).parent().addClass('has-error');
                }
                else {
                    if (text.includes('*') || text.includes('/') || text.includes('+') || text.includes('-')) {
                        vm.number = (parsedNumber.toPrecision(14) * 1);
                    }
                    else {
                        vm.number = parseFloat(text);
                    }
                    vm.$emit('input', vm.number);
                    $(this).parent().removeClass('has-error');
                }
            }
        });        
    },
    watch: {
        value: function (value) {
            if (this.number != value) {
                // update value
                this.number = value;
                $(this.$el).val((this.number == 0 || this.number == null) ? '' : this.number.toString().replace('.', decimalSeparator))
            }
        }
    }
});

Vue.component("liquid-editor", {
    props: ['value'],
    template: "<div />",
    mounted: function () {
        var vm = this;
        var editor = ace.edit(this.$el);
        editor.getSession().setUseWorker(false);
        editor.getSession().setMode('ace/mode/liquid');
        editor.setOption("displayIndentGuides", false);
        if (this.value) editor.setValue(this.value, -1);
        editor.on('blur', function (e) { vm.$emit('input', editor.getValue()) });
    }
});

Vue.component("html-editor", {
    props: ['value'],
    template: "<div />",
    mounted: function () {
        var vm = this;
        var editor = ace.edit(this.$el);
        editor.getSession().setUseWorker(false);
        editor.getSession().setMode('ace/mode/html');
        editor.setOption("displayIndentGuides", false);
        if (this.value) editor.setValue(this.value, -1);
        editor.on('blur', function (e) { vm.$emit('input', editor.getValue()) });
    }
});

Vue.component("javascript-editor", {
    props: ['value'],
    template: "<div />",
    mounted: function () {
        var vm = this;
        var editor = ace.edit(this.$el);
        editor.getSession().setUseWorker(false);
        editor.getSession().setMode('ace/mode/javascript');
        editor.setOption("displayIndentGuides", false);
        if (this.value) editor.setValue(this.value, -1);
        editor.on('blur', function (e) { vm.$emit('input', editor.getValue()) });
    }
});

function format(html) {
    var tab = '';
    var result = '';
    var indent = '';

    html.split(/>\s*</).forEach(function (element) {
        if (element.match(/^\/\w/)) {
            indent = indent.substring(tab.length);
        }

        result += indent + '<' + element + '>\r\n';

        if (element.match(/^<?\w[^>]*[^\/]$/) && !element.startsWith('input')) {
            indent += tab;
        }
    });

    return result.substring(1, result.length - 3);
}

if (!Number.prototype.getDecimals) {
    Number.prototype.getDecimals = function () {
        var num = parseFloat(this.toFixed(10));
        var match = ('' + num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
        if (!match)
            return 0;
        return Math.max(0, (match[1] ? match[1].length : 0) - (match[2] ? +match[2] : 0));
    }
}

String.prototype.replaceAll = function (target, replacement) {
    return this.split(target).join(replacement);
};

// Collapsible "Options" block on forms (see NakedVueForm.cs).
// Remembers per form type whether the block was left open or closed.
(function () {
    if (window.managerOptionsCollapseInit) return; // script may be loaded more than once
    window.managerOptionsCollapseInit = true;

    function storageKey(details) {
        return 'manager.options-open.' + details.getAttribute('data-options-key');
    }

    function restore(root) {
        if (!root || !root.querySelectorAll) return;
        var list = Array.prototype.slice.call(root.querySelectorAll('details[data-options-key]'));
        if (root.matches && root.matches('details[data-options-key]')) list.push(root);
        list.forEach(function (details) {
            if (details.hasAttribute('data-options-restored')) return;
            details.setAttribute('data-options-restored', '');
            try {
                var value = localStorage.getItem(storageKey(details));
                if (value === '1') details.open = true;
                if (value === '0') details.open = false;
            } catch (e) { }
        });
    }

    // 'toggle' does not bubble, so listen in the capture phase.
    document.addEventListener('toggle', function (e) {
        var details = e.target;
        if (!details || !details.matches || !details.matches('details[data-options-key]')) return;
        if (!details.hasAttribute('data-options-restored')) return;
        try { localStorage.setItem(storageKey(details), details.open ? '1' : '0'); } catch (e2) { }
    }, true);

    // Forms are rendered by Vue and htmx after page load, so watch for new blocks.
    new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) { if (node.nodeType === 1) restore(node); });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    restore(document);
})();
