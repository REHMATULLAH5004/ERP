// ============================================
// DONATION POS LOGIC (WITH ACCOUNTING INTEGRATION)
// ============================================

(async function initDonationPos() {
    console.log("Donation POS initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 CHANGED: the shared window-level getCompanySettings() helper
    // (assets/js/shared-company-settings.js) no longer exists on the site,
    // so calling it here threw "getCompanySettings is not defined" and
    // aborted this entire module's init. Self-contained now: reads the
    // same single `company_settings` row directly, with a hardcoded
    // fallback if that fails for any reason.
    const companySettings = await (async function loadCompanySettingsInline() {
        const fallback = {
            company_name: 'GRIFFINS MEDICALS LIMITED',
            address: 'Plot 3534, Freedomway, Lusaka',
            phone: '+260 97 000 0000',
            zamra_number: 'ZAMRA-123456',
            donation_prefix: 'DON'
        };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select('company_name, address, phone, zamra_number, donation_prefix')
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return {
                company_name: data.company_name || fallback.company_name,
                address: data.address || fallback.address,
                phone: data.phone || fallback.phone,
                zamra_number: data.zamra_number || fallback.zamra_number,
                donation_prefix: data.donation_prefix || fallback.donation_prefix
            };
        } catch (e) {
            console.warn('Could not load company_settings, using defaults:', e);
            return fallback;
        }
    })();

    // ============================================
    // DOM REFERENCES
    // ============================================
    const posTableBody = document.getElementById('donationPosTableBody');
    const saveBtn = document.getElementById('saveDonationBtn');
    const clearBtn = document.getElementById('clearDonationBtn');
    const donationNumber = document.getElementById('donationNumber');
    const donationDateTime = document.getElementById('donationDateTime');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const doneeName = document.getElementById('doneeName');
    const doneeContact = document.getElementById('doneeContact');
    const doneeAddress = document.getElementById('doneeAddress');
    const donationNote = document.getElementById('donationNote');
    const paymentType = document.getElementById('donationPaymentType');

    // Print modal refs
    const printModal = document.getElementById('printModal');
    let currentDonationData = null;

    // 🔥 FIX: same issue as retail.js/wholesale.js -- this used to not
    // exist at all, so loadDonationForEdit() populated the form from an
    // existing donation but saveDonation() had no way to know it was an
    // edit rather than a brand-new donation, so it ALWAYS inserted.
    // Re-saving an "edited" donation silently created a second, separate
    // record for the same real-world giveaway (duplicate donation,
    // stock deducted twice, cost posted twice) while the original row
    // sat there untouched. Set by loadDonationForEdit(), cleared by
    // generateNextDonationId() (Reset / post-save), read by
    // saveDonation() to decide update vs insert.
    let editingDonationDbId = null;

    // 🔥 ADDED: same as retail.js/wholesale.js -- current user's role,
    // needed to gate the Delete button in search results to Admin only.
    // Fetched once in the background so it doesn't block anything else.
    let currentUserRole = null;
    (async function fetchCurrentUserRole() {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (!session) return;
            const { data: profile } = await supabaseClient
                .from('user_profiles')
                .select('role')
                .eq('id', session.user.id)
                .maybeSingle();
            currentUserRole = profile?.role || null;
        } catch (e) {
            console.warn("Could not fetch current user role:", e);
        }
    })();

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // Ported from retail.js/wholesale.js. Previously this file hardcoded
    // account codes ('6001', '1400') directly into journal_lines inserts
    // with no guarantee those rows existed in chart_of_accounts.
    const REQUIRED_ACCOUNTS = [
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '6001', name: 'Cost of Donated Goods', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and twice per
    // save at that, since createDonationAccountingEntries() called it
    // directly AND getAccountCodesFromChartOfAccounts() called it again
    // right afterwards. Each run checked every required account ONE AT A
    // TIME (a separate SELECT, and INSERT if missing, per account) -- up
    // to REQUIRED_ACCOUNTS.length * 2 sequential round-trips just for this
    // housekeeping step. REQUIRED_ACCOUNTS is a fixed list baked into this
    // file and never changes while the page is open, so it only needs
    // checking once per page load. Now: checked in a single query, any
    // missing ones created in a single batch insert, and skipped entirely
    // after the first successful run.
    let chartOfAccountsSynced = false;

    async function ensureChartOfAccounts() {
        if (chartOfAccountsSynced) {
            return { created: 0, existing: REQUIRED_ACCOUNTS.length, cached: true };
        }

        try {
            const codes = REQUIRED_ACCOUNTS.map(a => a.code);
            const { data: existingAccounts, error: findError } = await supabaseClient
                .from('chart_of_accounts')
                .select('code')
                .in('code', codes);

            if (findError) throw findError;

            const existingCodes = new Set((existingAccounts || []).map(a => a.code));
            const missing = REQUIRED_ACCOUNTS.filter(a => !existingCodes.has(a.code));

            let created = 0;
            if (missing.length > 0) {
                const { error: insertError } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert(missing.map(account => ({
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        category: account.category,
                        normal_balance: account.normal_balance,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })));

                if (insertError) {
                    console.error('Error creating missing accounts:', insertError);
                } else {
                    created = missing.length;
                    missing.forEach(a => console.log(`✅ Created account: ${a.code} - ${a.name}`));
                }
            }

            const existing = REQUIRED_ACCOUNTS.length - missing.length;
            console.log(`✅ Chart of Accounts sync complete: ${created} created, ${existing} existing`);
            chartOfAccountsSynced = true;
            return { created, existing };
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
            return { created: 0, existing: 0, error };
        }
    }

    async function getAccountCodesFromChartOfAccounts() {
        try {
            await ensureChartOfAccounts();
            const accountNames = REQUIRED_ACCOUNTS.map(a => a.name);
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', accountNames);

            if (error) throw error;

            const accountMap = {};
            accounts.forEach(acc => {
                const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                accountMap[key] = acc.code;
            });

            return {
                inventory: accountMap['inventory'] || '1400',
                cost_of_donated_goods: accountMap['cost_of_donated_goods'] || '6001'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return { inventory: '1400', cost_of_donated_goods: '6001' };
        }
    }

    // ============================================
    // TOGGLE SIDEBAR
    // ============================================
    if (toggleSidebarBtn) {
        // 🔥 FIX: previously looked up a `#appRoot` element that doesn't
        // exist anywhere in the page, so this button silently did
        // nothing. Toggles a class on <body> instead (see style.css),
        // which hides the sidebar and lets the workspace expand.
        toggleSidebarBtn.addEventListener('click', function() {
            document.body.classList.toggle('layout-fullscreen');
        });
    }

    // ============================================
    // INITIALIZE
    // ============================================
    generateNextDonationId();
    updateDateTime();
    setInterval(updateDateTime, 60000);

    // ============================================
    // LOAD PRODUCT DROPDOWNS
    // ============================================
    try {
        await loadProductDropdowns();
    } catch (e) {
        console.warn("Could not load products:", e);
    }

    // ============================================
    // POS TABLE LOGIC
    // ============================================
    if (!posTableBody) {
        console.error("❌ donationPosTableBody not found!");
        return;
    }

    posTableBody.addEventListener('input', function(e) {
        if (e.target.classList.contains('donation-pos-qty')) {
            const row = e.target.closest('tr');
            const rows = posTableBody.querySelectorAll('tr');
            const qty = parseInt(e.target.value) || 0;
            
            if (row === rows[rows.length - 1] && qty > 0) {
                addPOSRow();
            }
            updateRowTotal(row);
            updateTotals();
        }
    });

    // ============================================
    // PRODUCT SELECTION
    // ============================================
    posTableBody.addEventListener('change', async function(e) {
        if (e.target.classList.contains('donation-pos-item')) {
            const row = e.target.closest('tr');
            const productId = e.target.value;
            const packInput = row.querySelector('.donation-pos-pack-size');

            if (!productId) {
                if (packInput) packInput.value = '';
                updateTotals();
                return;
            }

            try {
                const { data: product, error: prodError } = await supabaseClient
                    .from('products')
                    .select('conversion_rate')
                    .eq('id', productId)
                    .single();

                if (prodError) throw prodError;

                if (packInput) {
                    packInput.value = product.conversion_rate + 's';
                }
                
                updateTotals();

            } catch (err) {
                console.error("Error fetching product data:", err);
            }
        }
    });

    // Remove row handler
    posTableBody.addEventListener('click', function(e) {
        if (e.target.closest('.donation-remove-btn')) {
            const rows = posTableBody.querySelectorAll('tr');
            if (rows.length > 1) {
                e.target.closest('tr').remove();
                updateTotals();
            } else {
                alert('You must have at least one item.');
            }
        }
    });

    // ============================================
    // ADD POS ROW
    // ============================================
    function addPOSRow() {
        const template = document.querySelector('.donation-pos-row');
        if (!template) {
            console.error("❌ donation-pos-row template missing!");
            return;
        }
        
        const newRow = template.cloneNode(true);
        newRow.classList.remove('donation-pos-row');

        const itemSelect = newRow.querySelector('.donation-pos-item');
        const packInput = newRow.querySelector('.donation-pos-pack-size');
        const qtyInput = newRow.querySelector('.donation-pos-qty');
        const totalInput = newRow.querySelector('.donation-pos-total');

        if (itemSelect) {
            itemSelect.value = '';
            loadProductDropdownsForRow(itemSelect);
        }
        if (packInput) packInput.value = '';
        if (qtyInput) qtyInput.value = '1';
        if (totalInput) totalInput.value = 'K0.00';

        posTableBody.appendChild(newRow);
    }

    // ============================================
    // LOAD PRODUCT DROPDOWNS (REMOVED COST_PRICE QUERY)
    // ============================================
    async function loadProductDropdowns() {
        const selects = document.querySelectorAll('.donation-pos-item');
        try {
            // ⚠️ REMOVED 'cost_price' from select because the column doesn't exist!
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name') 
                .order('product_name');
            
            if (error) throw error;
            
            selects.forEach(select => {
                if (select) {
                    select.innerHTML = `<option value="">Select Item</option>`;
                    products.forEach(p => {
                        // Set data-cost to 0 for now to prevent crashing.
                        select.innerHTML += `<option value="${p.id}" data-cost="0">${p.product_name}</option>`;
                    });
                }
            });
        } catch (e) {
            console.warn("Could not load products:", e);
        }
    }

    async function loadProductDropdownsForRow(select) {
        if (!select) return;
        try {
            // ⚠️ REMOVED 'cost_price' from select because the column doesn't exist!
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name')
                .order('product_name');
            
            if (error) throw error;
            
            select.innerHTML = `<option value="">Select Item</option>`;
            products.forEach(p => {
                // Set data-cost to 0 for now to prevent crashing.
                select.innerHTML += `<option value="${p.id}" data-cost="0">${p.product_name}</option>`;
            });
        } catch (e) {
            console.warn("Could not load products for row:", e);
        }
    }

    function generateNextDonationId() {
        // 🔥 FIX: a fresh generated donation number means this is a NEW
        // donation from here on, not an edit of an existing one -- clear
        // the edit tracker so Save inserts instead of updating. Covers
        // the Reset button and the post-save form reset. Same pattern as
        // retail.js/wholesale.js.
        editingDonationDbId = null;

        const display = document.getElementById('donationIdDisplay');
        const invoiceDisplay = document.getElementById('donationNumber');
        if (!display) return;

        const date = new Date();
        const year = date.getFullYear();
        // 🔥 FIX: the old scheme was DON-{year}-{4-digit random} — only
        // 10,000 possible IDs per year with no time component, a much
        // higher collision risk than retail/wholesale's timestamp+random
        // scheme. Matched here for consistency.
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const donationId = `${companySettings.donation_prefix}-${year}-${timestamp}-${random}`;
        
        display.textContent = `Donation #: ${donationId}`;
        if (invoiceDisplay) invoiceDisplay.value = donationId;
    }

    function updateDateTime() {
        const now = new Date();
        const dateTimeStr = now.toLocaleString('en-ZM', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        if (donationDateTime) donationDateTime.value = dateTimeStr;
    }

    function updateRowTotal(row) {
        if (!row) return;
        const qty = parseInt(row.querySelector('.donation-pos-qty')?.value) || 0;
        const totalInput = row.querySelector('.donation-pos-total');
        const itemSelect = row.querySelector('.donation-pos-item');
        const productName = itemSelect ? itemSelect.options[itemSelect.selectedIndex]?.text || '' : '';
        
        // Show donation value as K0.00 but include item count
        if (totalInput) {
            if (qty > 0 && productName) {
                totalInput.value = `K0.00 (${qty} × ${productName})`;
            } else {
                totalInput.value = 'K0.00';
            }
        }
    }

    function updateTotals() {
        const rows = posTableBody.querySelectorAll('tr');
        let totalItems = 0;
        let itemDetails = [];

        rows.forEach(row => {
            const qty = parseInt(row.querySelector('.donation-pos-qty')?.value) || 0;
            const itemSelect = row.querySelector('.donation-pos-item');
            const productName = itemSelect ? itemSelect.options[itemSelect.selectedIndex]?.text || '' : '';
            
            if (qty > 0 && productName) {
                totalItems += qty;
                itemDetails.push(`${qty} × ${productName}`);
            }
        });

        document.getElementById('donationTotalItems').textContent = totalItems;
        
        // Show grand total with item details
        if (totalItems > 0) {
            document.getElementById('donationGrandTotal').textContent = `K0.00 (${totalItems} items donated)`;
        } else {
            document.getElementById('donationGrandTotal').textContent = 'K0.00';
        }
    }

    // ============================================
    // GET DONATION DATA (MIRRORING RETAIL LOGIC)
    // ============================================
    function getDonationData() {
        const rows = posTableBody.querySelectorAll('tr');
        const items = [];
        let hasItems = false;

        rows.forEach(row => {
            const itemSelect = row.querySelector('.donation-pos-item');
            const qtyInput = row.querySelector('.donation-pos-qty');
            const packInput = row.querySelector('.donation-pos-pack-size');
            
            if (itemSelect && itemSelect.value) {
                const qty = parseInt(qtyInput.value) || 0;
                if (qty > 0) {
                    hasItems = true;
                    // ⚠️ NO SUPABASE FETCH HERE. 
                    // In Retail, cost_per_unit is read from the HTML dataset. 
                    // Since Donations don't use batch selection, we simply default to 0.
                    // The actual cost is calculated in the accounting function using the product's cost_price column
                    // which must exist in the 'products' table.
                    items.push({
                        product_id: itemSelect.value,
                        product_name: itemSelect.options[itemSelect.selectedIndex]?.text || '',
                        qty: qty,
                        pack_size: packInput.value || '1s',
                        tax_rate: 0,
                        rate: 0,
                        total: 0,
                        cost_per_unit: 0 // Retail also reads this from HTML, we set to 0 since we lack a batch picker here
                    });
                }
            }
        });

        if (!hasItems) {
            alert('Please add at least one item to the donation.');
            return null;
        }

        // Get donee details
        const doneeData = {
            donee_name: doneeName.value || '',
            contact_number: doneeContact.value || '',
            address: doneeAddress.value || ''
        };

        const paymentType = document.getElementById('donationPaymentType')?.value || 'Donation';
        const note = donationNote.value || '';

        const totalItems = items.reduce((sum, item) => sum + item.qty, 0);

        const donationData = {
            type: 'DONATION',
            prefix: 'DON',
            client_type: 'DONATION',
            client_sub_type: 'DONATION',
            donee: doneeData,
            items: items,
            payment: {
                type: paymentType,
                note: note
            },
            totals: {
                total_items: totalItems,
                subtotal: 0,
                tax: 0,
                grand_total: 0
            },
            donation_id: document.getElementById('donationNumber')?.value || '',
            date: document.getElementById('donationDateTime')?.value || new Date().toLocaleString(),
            status: 'COMPLETED'
        };

        return donationData;
    }

    // ============================================
    // PRINT FUNCTION
    // ============================================
    function printDonation() {
        const donationData = currentDonationData;
        if (!donationData) {
            alert('No donation data to print.');
            return;
        }

        const printContent = `<!DOCTYPE html>
        <html>
        <head>
            <title>Donation Receipt - ${donationData.donation_id}</title>
            <style>
                body { font-family: 'Courier New', monospace; padding: 20px; max-width: 800px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
                .header h1 { margin: 0; color: #0f172a; font-size: 1.5rem; }
                .header p { margin: 3px 0; color: #475569; font-size: 0.9rem; }
                .receipt-info { margin-bottom: 20px; padding: 10px; background: #f8fafc; border-radius: 4px; font-size: 0.9rem; }
                .receipt-info div { display: inline-block; margin-right: 30px; }
                .donee-info { margin-bottom: 20px; padding: 10px; background: #f8fafc; border-radius: 4px; font-size: 0.9rem; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.85rem; }
                th { background: #f1f5f9; padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0; }
                td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
                .text-right { text-align: right; }
                .text-center { text-align: center; }
                .totals { text-align: right; margin-top: 20px; padding-top: 20px; border-top: 2px solid #e2e8f0; font-size: 0.9rem; }
                .grand-total { font-size: 1.2rem; font-weight: bold; color: #0f172a; }
                .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 0.8rem; }
                .donor-message { text-align: center; margin: 20px 0; padding: 15px; background: #e8f5e9; border: 2px solid #4caf50; border-radius: 8px; }
                .zero-amount { color: #64748b; font-style: italic; }
                @media print { body { margin: 0; padding: 10px; } }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>${companySettings.company_name}</h1>
                <p>${companySettings.address}</p>
                <p>Phone: ${companySettings.phone} | ZAMRA: ${companySettings.zamra_number}</p>
            </div>
            <div class="receipt-info">
                <div><strong>Donation #:</strong> ${donationData.donation_id}</div>
                <div><strong>Date:</strong> ${donationData.date}</div>
                <div><strong>Payment:</strong> ${donationData.payment.type}</div>
            </div>
            <div class="donee-info">
                <strong>Donee Details (Recipient)</strong><br>
                <strong>Name:</strong> ${donationData.donee.donee_name || 'N/A'}<br>
                ${donationData.donee.contact_number ? `<strong>Contact:</strong> ${donationData.donee.contact_number}<br>` : ''}
                ${donationData.donee.address ? `<strong>Address:</strong> ${donationData.donee.address}` : ''}
            </div>
            ${donationData.payment.note ? `<div style="margin-bottom: 15px; padding: 8px; background: #f1f5f9; border-radius: 4px;"><strong>Note:</strong> ${donationData.payment.note}</div>` : ''}
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Item</th>
                        <th class="text-center">Pack</th>
                        <th class="text-center">Qty</th>
                        <th class="text-right">Value</th>
                    </tr>
                </thead>
                <tbody>
                    ${donationData.items.map((item, index) => `
                        <tr>
                            <td>${index + 1}</td>
                            <td>${item.product_name}</td>
                            <td class="text-center">${item.pack_size}</td>
                            <td class="text-center">${item.qty}</td>
                            <td class="text-right zero-amount">K0.00</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <div class="totals">
                <p>Total Items Donated: <strong>${donationData.totals.total_items}</strong></p>
                <p class="grand-total">Total Donation Value: <strong class="zero-amount">K0.00</strong></p>
                <p style="font-size: 0.8rem; color: #64748b; margin-top: 5px;">* This is a charitable donation with no monetary value charged</p>
            </div>
            
            <!-- DONOR MESSAGE -->
            <div class="donor-message">
                <strong style="color: #2e7d32; font-size: 1.1rem;">❤️ Donated by ${companySettings.company_name}</strong><br>
                <span style="font-size: 0.95rem; color: #475569;">In support of ${donationData.donee.donee_name || 'our community'}</span><br>
                <span style="font-size: 0.85rem; color: #64748b; margin-top: 5px; display: inline-block;">"Caring for our community, one donation at a time."</span>
            </div>
            
            <div class="footer">
                <p>This is a computer-generated donation receipt.</p>
                <p style="font-size: 0.85rem; color: #64748b;">Thank you for allowing us to serve you.</p>
            </div>
        </body>
        </html>`;

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(printContent);
        printWindow.document.close();
        printWindow.print();
    }

    // ============================================
    // PRINT DIALOG
    // ============================================
    function showPrintDialog(donationData) {
        if (!printModal) return;

        printModal.style.display = 'flex';

        const yesBtn = document.getElementById('printYesBtn');
        const noBtn = document.getElementById('printNoBtn');
        
        const newYesBtn = yesBtn.cloneNode(true);
        const newNoBtn = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);

        newYesBtn.onclick = function() {
            printModal.style.display = 'none';
            setTimeout(() => {
                printDonation();
            }, 300);
        };

        newNoBtn.onclick = function() {
            printModal.style.display = 'none';
        };
    }

    // ============================================
    // ACCOUNTING INTEGRATION FOR DONATION
    // ============================================
    // 🔥 FIX: this used to independently re-query `batches` for
    // `.gt('total_qty', 0)` to figure out cost — AFTER saveDonation() had
    // already deducted stock from those same batches. If a donation took a
    // batch's remaining qty down to 0 (very common for donations, which
    // often clear out near-expiry stock), this second query would no
    // longer find it, silently booking LESS cost than was actually given
    // away (or K0 for stock that really did have a cost). Now this just
    // sums the cost_per_unit each item already had captured at the moment
    // it was actually deducted from — no re-querying, no chance of drift.
    async function createDonationAccountingEntries(donationData) {
        try {
            await ensureChartOfAccounts();
            const accountCodes = await getAccountCodesFromChartOfAccounts();

            let totalCost = 0;
            donationData.items.forEach(item => {
                const packSize = parseInt(item.pack_size) || 1;
                totalCost += (item.cost_per_unit || 0) * item.qty * packSize;
            });

            // Since a donation never involves money, revenue, or a
            // receivable, there is nothing to book beyond recognizing the
            // cost of what was given away and taking it out of inventory.
            if (totalCost > 0) {
                const entryDate = new Date().toISOString().split('T')[0];
                const donationId = donationData.donation_id;

                const journal = {
                    entry_date: entryDate,
                    reference: donationId,
                    description: `Donation to ${donationData.donee.donee_name || 'Community'}`,
                    journal_number: `${companySettings.donation_prefix}-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: journalData, error: jError } = await supabaseClient
                    .from('journal_entries')
                    .insert([journal])
                    .select();

                if (jError) throw jError;

                const lines = [
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.cost_of_donated_goods,
                        description: `Cost of donated items`,
                        debit: totalCost,
                        credit: 0
                    },
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.inventory,
                        description: `Inventory reduction from donation`,
                        debit: 0,
                        credit: totalCost
                    }
                ];

                const { error: lineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(lines);

                if (lineError) throw lineError;

                console.log(`✅ Donation accounting entries created for ${donationId} (Cost: K${totalCost.toFixed(2)})`);
            } else {
                console.log(`ℹ️ Donation ${donationData.donation_id} had zero cost, no accounting entry created.`);
            }
        } catch (accError) {
            console.error('Error creating donation accounting entries:', accError);
        }
    }

    // ============================================
    // SAVE DONATION - SAVES TO SALES TABLE WITH STOCK DEDUCTION
    // ============================================
    async function saveDonation() {
        const donationData = getDonationData();
        if (!donationData) return;

        // Confirm with user
        const totalItems = donationData.totals.total_items;
        const itemNames = donationData.items.map(i => `${i.qty} × ${i.product_name}`).join(', ');
        
        if (!confirm(`Are you sure you want to donate ${totalItems} items?\n\n${itemNames}\n\nThis will deduct from stock.`)) {
            return;
        }

        try {
            const dbRecord = {
                sale_id: donationData.donation_id,
                type: 'DONATION',
                prefix: 'DON',
                client_type: 'DONATION',
                client_sub_type: 'DONATION',
                customer_data: {
                    full_name: donationData.donee.donee_name || '',
                    phone: donationData.donee.contact_number || '',
                    address: donationData.donee.address || ''
                },
                items: donationData.items,
                payment: donationData.payment,
                subtotal: 0,
                tax: 0,
                grand_total: 0,
                status: 'COMPLETED',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            console.log('Saving donation to sales table:', dbRecord);

            // 🔥 FIX: editing an existing donation (editingDonationDbId set
            // by loadDonationForEdit()) must UPDATE that row, never insert
            // a new one -- see this variable's declaration near the top of
            // the file for the full story. Before writing the row, undo
            // exactly what the ORIGINAL save did: restore the stock it
            // deducted (using the batch_id/quantity actually recorded on
            // the original sale_items rows -- donation auto-picks a batch
            // at save time, so this is the only reliable record of which
            // batch was actually used) and remove its old sale_items and
            // journal entry (matched by reference, which carries the
            // donation's own id string). The rest of this function then
            // re-runs its normal FEFO stock deduction and accounting for
            // the edited items exactly as it already does for a brand-new
            // donation.
            if (editingDonationDbId) {
                const { data: oldItems, error: oldItemsError } = await supabaseClient
                    .from('sale_items')
                    .select('batch_id, quantity, pack_size')
                    .eq('sale_id', editingDonationDbId);

                if (oldItemsError) {
                    console.error('Error loading original donation items for edit:', oldItemsError);
                    alert('❌ Could not load the original donation to edit it safely. Nothing was changed.\n' + oldItemsError.message);
                    return;
                }

                if (oldItems && oldItems.length > 0) {
                    const qtyToRestoreByBatch = new Map();
                    for (const item of oldItems) {
                        const packQty = parseInt(item.pack_size) || 1;
                        qtyToRestoreByBatch.set(item.batch_id, (qtyToRestoreByBatch.get(item.batch_id) || 0) + item.quantity * packQty);
                    }
                    const { data: batchesToRestore, error: batchFetchError } = await supabaseClient
                        .from('batches')
                        .select('id, total_qty')
                        .in('id', [...qtyToRestoreByBatch.keys()]);

                    if (batchFetchError) {
                        console.error('Error restoring stock before edit-save:', batchFetchError);
                    } else {
                        await Promise.all((batchesToRestore || []).map(b =>
                            supabaseClient.from('batches')
                                .update({ total_qty: b.total_qty + (qtyToRestoreByBatch.get(b.id) || 0) })
                                .eq('id', b.id)
                        ));
                    }
                }

                await supabaseClient.from('sale_items').delete().eq('sale_id', editingDonationDbId);

                const oldDonationIdString = donationData.donation_id; // unchanged across an edit
                const { data: oldJournals } = await supabaseClient
                    .from('journal_entries')
                    .select('id')
                    .eq('reference', oldDonationIdString);

                if (oldJournals && oldJournals.length > 0) {
                    const oldJournalIds = oldJournals.map(j => j.id);
                    await supabaseClient.from('journal_lines').delete().in('journal_entry_id', oldJournalIds);
                    await supabaseClient.from('journal_entries').delete().in('id', oldJournalIds);
                }
            }

            let savedData;
            try {
                if (editingDonationDbId) {
                    const { data, error } = await supabaseClient
                        .from('sales')
                        .update(dbRecord)
                        .eq('id', editingDonationDbId)
                        .select();

                    if (error) throw new Error(error.message);
                    if (!data || data.length === 0) {
                        alert('❌ Could not find the original donation to update. Nothing was saved.');
                        return;
                    }
                    savedData = data;
                } else {
                    const { data, error } = await supabaseClient
                        .from('sales')
                        .insert([dbRecord])
                        .select();

                    if (error) {
                        // 🔥 ADDED: same duplicate-id retry as retail.js/wholesale.js
                        if (error.code === '23505' || error.message?.includes('duplicate key')) {
                            console.log('⚠️ Duplicate key error, regenerating donation_id...');

                            const timestamp = Date.now().toString().slice(-6);
                            const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
                            const newDonationId = `${companySettings.donation_prefix}-${new Date().getFullYear()}-${timestamp}-${random}`;

                            document.getElementById('donationNumber').value = newDonationId;
                            const display = document.getElementById('donationIdDisplay');
                            if (display) display.textContent = `Donation #: ${newDonationId}`;

                            dbRecord.sale_id = newDonationId;
                            donationData.donation_id = newDonationId;

                            const { data: retryData, error: retryError } = await supabaseClient
                                .from('sales')
                                .insert([dbRecord])
                                .select();

                            if (retryError) throw new Error('Failed to save (Retry): ' + retryError.message);
                            savedData = retryData;
                        } else {
                            throw new Error(error.message);
                        }
                    } else {
                        savedData = data;
                    }
                }
            } catch (dbError) {
                console.error('Database error:', dbError);
                throw dbError;
            }

            // ============================================
            // DEDUCT STOCK FOR DONATION ITEMS
            // ============================================
            // 🔥 FIX: this is the core bug fix. Previously, cost_price was
            // looked up a SECOND time later inside
            // createDonationAccountingEntries() with its own independent
            // `.gt('total_qty', 0)` query — run AFTER this loop had already
            // reduced those same batches' quantities. If a donation used up
            // a batch entirely, that second query would no longer find it
            // and would silently book less cost (or zero) than what was
            // actually given away. Now the batch (and its cost_price) is
            // looked up exactly ONCE, right here, and that same value is
            // stamped onto the item — so stock deduction, sale_items, and
            // the accounting entry all agree on the exact same number.
            let stockErrors = [];

            // 🔥 PERF FIX: this used to process every line item one at a
            // time, always in a strict sequential loop, even when the
            // items were for completely different products with nothing
            // in common. The batch lookup here is stock-state-dependent
            // (it always picks whatever batch of THIS product currently
            // has the earliest expiry with stock left) -- so two lines for
            // the SAME product genuinely must run one after another,
            // otherwise both could read the same batch's stock before
            // either write lands and double-count the same units. Two
            // lines for DIFFERENT products never touch the same batch, so
            // there's no reason to make them wait on each other. Items are
            // grouped by product_id below: each group still runs its items
            // strictly in order (safe), but different products' groups now
            // run concurrently (fast) -- a donation of 5 different
            // medicines now takes roughly as long as 1 used to, instead of 5.
            const itemsByProduct = new Map();
            for (const item of donationData.items) {
                if (!itemsByProduct.has(item.product_id)) itemsByProduct.set(item.product_id, []);
                itemsByProduct.get(item.product_id).push(item);
            }

            async function processDonationItem(item) {
                try {
                    const { data: batches, error: batchError } = await supabaseClient
                        .from('batches')
                        .select('id, total_qty, batch_number, cost_price')
                        .eq('product_id', item.product_id)
                        .gt('total_qty', 0)
                        .order('expiry_date', { ascending: true })
                        .limit(1);

                    if (batchError) {
                        console.error('Error finding batch for product:', item.product_id, batchError);
                        stockErrors.push(`Failed to find stock for ${item.product_name}`);
                        return;
                    }

                    if (!batches || batches.length === 0) {
                        stockErrors.push(`No stock available for ${item.product_name}`);
                        return;
                    }

                    const batch = batches[0];

                    const packSize = parseInt(item.pack_size) || 1;
                    const qtyToDeduct = item.qty * packSize;

                    if (batch.total_qty < qtyToDeduct) {
                        stockErrors.push(`Insufficient stock for ${item.product_name} (Available: ${batch.total_qty}, Required: ${qtyToDeduct})`);
                        return;
                    }

                    const newQty = batch.total_qty - qtyToDeduct;

                    const { error: updateError } = await supabaseClient
                        .from('batches')
                        .update({ total_qty: newQty })
                        .eq('id', batch.id);

                    if (updateError) {
                        console.error('Error updating stock for batch:', batch.id, updateError);
                        stockErrors.push(`Failed to update stock for ${item.product_name}`);
                        return;
                    }

                    console.log(`Stock updated for ${item.product_name} (Batch: ${batch.batch_number}): ${batch.total_qty} -> ${newQty}`);

                    // Stamp the exact batch/cost actually used onto the
                    // item so sale_items and the accounting entry below
                    // both use this same value.
                    item.batch_id = batch.id;
                    item.batch_number = batch.batch_number;
                    item.cost_per_unit = batch.cost_price || 0;

                } catch (err) {
                    console.error('Error processing stock for item:', item, err);
                    stockErrors.push(`Error processing ${item.product_name}`);
                }
            }

            await Promise.all([...itemsByProduct.values()].map(async (group) => {
                for (const item of group) {
                    await processDonationItem(item); // same product -> stays sequential, on purpose
                }
            }));

            if (stockErrors.length > 0) {
                alert(`⚠️ Donation saved but some stock issues occurred:\n\n${stockErrors.join('\n')}\n\nPlease review stock levels manually.`);
            }

            // ============================================
            // 🔥 ADDED: insert into sale_items table, matching
            // retail.js/wholesale.js. Uses the batch_id/cost_per_unit
            // stamped onto each item during the deduction loop above.
            // ============================================
            const itemsWithStock = donationData.items.filter(item => item.batch_id);
            if (itemsWithStock.length > 0) {
                const saleItemsData = itemsWithStock.map(item => ({
                    sale_id: savedData[0].id,
                    product_id: item.product_id,
                    batch_id: item.batch_id,
                    quantity: item.qty,
                    unit_price: 0,
                    pack_size: item.pack_size,
                    tax_rate: 0,
                    total: 0,
                    cost_per_unit: item.cost_per_unit || 0
                }));

                const { error: itemError } = await supabaseClient
                    .from('sale_items')
                    .insert(saleItemsData);

                if (itemError) {
                    // Note: stock has already been deducted at this point for
                    // a donation-specific reason -- unlike retail/wholesale,
                    // items here don't carry a pre-selected batch_id from the
                    // UI, so the deduction and the batch selection are the
                    // same step. Rolling back the stock here would require
                    // re-adding quantities to potentially multiple batches;
                    // instead we surface this clearly so it can be corrected
                    // manually, rather than risk a partial, inconsistent
                    // rollback.
                    console.error('❌ Failed to save sale_items for donation:', itemError);
                    alert('⚠️ Donation and stock deduction were saved, but item-level records failed to save.\nError: ' + itemError.message + '\nPlease verify stock and records manually.');
                } else {
                    console.log(`✅ Inserted ${saleItemsData.length} items into sale_items table.`);
                }
            }

            // ============================================
            // CREATE ACCOUNTING ENTRIES
            // ============================================
            await createDonationAccountingEntries(donationData);

            currentDonationData = donationData;

            // Show print dialog
            showPrintDialog(donationData);

            alert(`✅ Donation ${donationData.donation_id} saved successfully!\nTotal Items: ${totalItems}`);

            resetForm();

        } catch (error) {
            console.error('Error saving donation:', error);
            alert('❌ Error saving donation:\n' + error.message);
        }
    }

    function resetForm() {
        doneeName.value = '';
        doneeContact.value = '';
        doneeAddress.value = '';
        donationNote.value = '';
        
        const rows = posTableBody.querySelectorAll('tr');
        rows.forEach((row, index) => {
            if (index > 0) {
                row.remove();
            }
        });
        
        const firstRow = posTableBody.querySelector('tr:first-child');
        if (firstRow) {
            const itemSelect = firstRow.querySelector('.donation-pos-item');
            const packInput = firstRow.querySelector('.donation-pos-pack-size');
            const qtyInput = firstRow.querySelector('.donation-pos-qty');
            const totalInput = firstRow.querySelector('.donation-pos-total');

            if (itemSelect) itemSelect.value = '';
            if (packInput) packInput.value = '';
            if (qtyInput) qtyInput.value = '1';
            if (totalInput) totalInput.value = 'K0.00';

            if (itemSelect) {
                loadProductDropdownsForRow(itemSelect);
            }
        }
        
        updateTotals();
        generateNextDonationId();
        updateDateTime();
        
        // Reset payment type to Donation
        if (paymentType) paymentType.value = 'Donation';
    }

    // ============================================
    // LOAD DONATION FOR EDIT - EXPOSED GLOBALLY
    // ============================================
    function loadDonationForEdit(saleData) {
        try {
            console.log('Loading donation for edit:', saleData);
            
            // Populate donee details
            if (saleData.customer_data) {
                doneeName.value = saleData.customer_data.full_name || '';
                doneeContact.value = saleData.customer_data.phone || '';
                doneeAddress.value = saleData.customer_data.address || '';
            }
            
            // Set payment
            if (saleData.payment) {
                document.getElementById('donationPaymentType').value = saleData.payment.type || 'Donation';
                donationNote.value = saleData.payment.note || '';
            }
            
            // Set donation number
            if (saleData.sale_id) {
                document.getElementById('donationNumber').value = saleData.sale_id;
                const display = document.getElementById('donationIdDisplay');
                if (display) {
                    display.textContent = `Donation #: ${saleData.sale_id}`;
                }
            }
            
            // Add items to table
            if (saleData.items && saleData.items.length > 0) {
                // Clear existing rows
                const rows = posTableBody.querySelectorAll('tr');
                rows.forEach((row, index) => {
                    if (index > 0) row.remove();
                });
                
                // Reset first row
                const firstRow = posTableBody.querySelector('tr:first-child');
                if (firstRow) {
                    const itemSelect = firstRow.querySelector('.donation-pos-item');
                    const packInput = firstRow.querySelector('.donation-pos-pack-size');
                    const qtyInput = firstRow.querySelector('.donation-pos-qty');
                    const totalInput = firstRow.querySelector('.donation-pos-total');

                    if (itemSelect) itemSelect.value = '';
                    if (packInput) packInput.value = '';
                    if (qtyInput) qtyInput.value = '1';
                    if (totalInput) totalInput.value = 'K0.00';
                }
                
                // Add each item
                saleData.items.forEach((item, index) => {
                    if (index > 0) {
                        addPOSRow();
                    }
                    
                    const rows = posTableBody.querySelectorAll('tr');
                    const targetRow = rows[rows.length - 1];
                    
                    if (!targetRow) return;
                    
                    // Set product
                    const itemSelect = targetRow.querySelector('.donation-pos-item');
                    if (itemSelect && item.product_id) {
                        const option = Array.from(itemSelect.options).find(opt => opt.value === item.product_id);
                        if (option) {
                            itemSelect.value = item.product_id;
                            // Trigger change event to load pack size
                            itemSelect.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    
                    // Set qty after a delay
                    setTimeout(() => {
                        const qtyInput = targetRow.querySelector('.donation-pos-qty');
                        if (qtyInput) {
                            qtyInput.value = item.qty || 1;
                            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        updateRowTotal(targetRow);
                    }, 300);
                });
                
                // Update totals after all items are added
                setTimeout(() => {
                    updateTotals();
                }, 600);
            }

            // 🔥 FIX: set this so Save updates this donation in place
            // instead of inserting a duplicate. See the state declaration
            // near the top of the file for why this is needed at all.
            editingDonationDbId = saleData.db_id || null;

            alert('✅ Donation loaded for editing. Make changes and save.');
            
        } catch (error) {
            console.error('Error loading donation for edit:', error);
            alert('Error loading donation: ' + error.message);
        }
    }

    // ============================================
    // VIEW ITEMS MODAL
    // ============================================
    function showViewItemsModal(saleData) {
        const modal = document.getElementById('viewItemsModal');
        const content = document.getElementById('viewItemsContent');
        const title = document.getElementById('viewModalTitle');

        if (!modal || !content) return;

        title.innerHTML = `<i class="fa-solid fa-hand-holding-heart" style="color: #10b981;"></i> Donation - ${saleData.sale_id}`;

        let html = `
            <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div><strong>Donation #:</strong> ${saleData.sale_id}</div>
                    <div><strong>Date:</strong> ${saleData.date}</div>
                    <div><strong>Donee:</strong> ${saleData.customer.full_name || 'N/A'}</div>
                    <div><strong>Phone:</strong> ${saleData.customer.phone || 'N/A'}</div>
                    <div><strong>Payment:</strong> ${saleData.payment.type}</div>
                    <div><strong>Status:</strong> <span style="color: #10b981; font-weight: 600;">${saleData.status}</span></div>
                </div>
                ${saleData.payment.note ? `<div style="margin-top: 10px;"><strong>Note:</strong> ${saleData.payment.note}</div>` : ''}
            </div>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead style="background: #f1f5f9;">
                    <tr>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">#</th>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Item</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">Pack</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">Qty</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Value</th>
                    </tr>
                </thead>
                <tbody>
        `;

        saleData.items.forEach((item, index) => {
            html += `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px;">${index + 1}</td>
                    <td style="padding: 10px;">${item.product_name}</td>
                    <td style="padding: 10px; text-align: center;">${item.pack_size || '1s'}</td>
                    <td style="padding: 10px; text-align: center;">${item.qty}</td>
                    <td style="padding: 10px; text-align: right; color: #64748b;">K0.00</td>
                </tr>
            `;
        });

        const totalItems = saleData.items.reduce((sum, item) => sum + (item.qty || 0), 0);

        html += `
                </tbody>
                <tfoot style="background: #f8fafc; font-weight: 600;">
                    <tr>
                        <td colspan="3" style="padding: 10px; text-align: right;">Total Items Donated:</td>
                        <td style="padding: 10px; text-align: center;">${totalItems}</td>
                        <td style="padding: 10px; text-align: right; color: #64748b;">K0.00</td>
                    </tr>
                    <tr style="font-size: 1.1rem; color: #0f172a;">
                        <td colspan="4" style="padding: 10px; text-align: right;">Total Donation Value:</td>
                        <td style="padding: 10px; text-align: right; color: #64748b;">K0.00</td>
                    </tr>
                </tfoot>
            </table>
            <div style="text-align: center; padding: 15px; background: #e8f5e9; border-radius: 8px; border: 2px solid #4caf50;">
                <strong style="color: #2e7d32;">❤️ Donated by ${companySettings.company_name}</strong><br>
                <span style="font-size: 0.9rem; color: #475569;">"Caring for our community, one donation at a time."</span>
            </div>
        `;

        content.innerHTML = html;
        modal.style.display = 'flex';
        window.currentPrintData = saleData;
    }

    // ============================================
    // KEYBOARD SHORTCUTS
    // ============================================
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            if (saveBtn) saveBtn.click();
        }
        
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            if (clearBtn) clearBtn.click();
        }
    });

    // ============================================
    // BUTTON EVENTS
    // ============================================
    if (saveBtn) saveBtn.addEventListener('click', saveDonation);

    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            if (confirm('Are you sure you want to reset?')) {
                resetForm();
            }
        });
    }

    // ============================================
    // 🔥 ADDED: SEARCH DONATIONS (find + edit an older donation) --
    // same feature retail.js/wholesale.js already have. Before this,
    // the ONLY way to edit an existing donation at all was Transaction
    // Overview's "Today's Transactions" widget -- meaning a donation
    // from yesterday or earlier had no way to be found and corrected.
    // No date limit here -- this searches every donation ever saved.
    // ============================================
    async function searchDonationRecords(query) {
        const resultsEl = document.getElementById('donationSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>`;

        try {
            let dbQuery = supabaseClient
                .from('sales')
                .select('id, sale_id, created_at, items, customer_data, payment')
                .eq('client_type', 'DONATION')
                .order('created_at', { ascending: false })
                .limit(20);

            if (query && query.trim() !== '') {
                const term = query.trim().replace(/[%_]/g, '\\$&');
                dbQuery = dbQuery.or(
                    `sale_id.ilike.%${term}%,customer_data->>full_name.ilike.%${term}%`
                );
            }

            const { data: results, error } = await dbQuery;
            if (error) throw error;

            renderDonationSearchResults(results || []);
        } catch (error) {
            console.error('Error searching donations:', error);
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#dc2626;">Error searching: ${error.message}</div>`;
        }
    }

    function renderDonationSearchResults(results) {
        const resultsEl = document.getElementById('donationSearchResults');
        if (!resultsEl) return;

        if (results.length === 0) {
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;">No matching donations found.</div>`;
            return;
        }

        const isAdmin = currentUserRole === 'Admin';

        resultsEl.innerHTML = results.map(r => {
            const date = new Date(r.created_at).toLocaleDateString();
            const doneeName = r.customer_data?.full_name || 'N/A';
            const itemCount = (r.items || []).reduce((sum, i) => sum + (i.qty || 0), 0);

            return `
                <div style="padding:12px; margin-bottom:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <span style="font-weight:600;">${r.sale_id}</span>
                            <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">${doneeName} &middot; ${itemCount} items &middot; ${date}</div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button class="donation-search-edit-btn" data-id="${r.id}" style="background:#f59e0b; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-pen"></i> Edit</button>
                            ${isAdmin ? `<button class="donation-search-delete-btn" data-id="${r.id}" data-sale-number="${r.sale_id}" style="background:#dc2626; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        resultsEl.querySelectorAll('.donation-search-edit-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const record = results.find(r => r.id === btn.dataset.id);
                if (!record) return;
                await loadDonationForEdit({ ...record, db_id: record.id });
                document.getElementById('donationSearchModal').style.display = 'none';
            });
        });

        resultsEl.querySelectorAll('.donation-search-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteDonationRecord(btn.dataset.id, btn.dataset.saleNumber));
        });
    }

    // 🔥 ADDED: same conservative baseline as retail.js/wholesale.js --
    // removes the sale and its sale_items rows only, does not touch
    // stock or the accounting ledger. Admin-only, checked both in the
    // UI (button hidden from non-Admins above) and here.
    async function deleteDonationRecord(id, saleNumber) {
        if (currentUserRole !== 'Admin') {
            alert('Only an Admin can delete a donation record.');
            return;
        }

        const confirmed = confirm(
            `Delete ${saleNumber}?\n\nThis permanently removes the donation record. ` +
            `It does NOT restore stock or reverse any accounting entries already posted for it -- ` +
            `those will need to be corrected separately if this donation affected them.\n\nThis cannot be undone.`
        );
        if (!confirmed) return;

        try {
            const { error: itemsError } = await supabaseClient.from('sale_items').delete().eq('sale_id', id);
            if (itemsError) throw itemsError;

            const { error: saleError } = await supabaseClient.from('sales').delete().eq('id', id);
            if (saleError) throw saleError;

            alert(`✅ ${saleNumber} deleted.`);
            searchDonationRecords(document.getElementById('donationSearchInput')?.value || '');
        } catch (error) {
            console.error('Error deleting donation:', error);
            alert('Error deleting donation: ' + error.message);
        }
    }

    const searchDonationsBtn = document.getElementById('searchDonationsBtn');
    const donationSearchModal = document.getElementById('donationSearchModal');
    const donationCloseSearchModalBtn = document.getElementById('donationCloseSearchModalBtn');
    const donationSearchInput = document.getElementById('donationSearchInput');
    const donationSearchGoBtn = document.getElementById('donationSearchGoBtn');

    if (searchDonationsBtn && donationSearchModal) {
        searchDonationsBtn.addEventListener('click', () => {
            donationSearchModal.style.display = 'flex';
            if (donationSearchInput) donationSearchInput.value = '';
            searchDonationRecords('');
        });
    }
    if (donationCloseSearchModalBtn && donationSearchModal) {
        donationCloseSearchModalBtn.addEventListener('click', () => {
            donationSearchModal.style.display = 'none';
        });
    }
    if (donationSearchModal) {
        donationSearchModal.addEventListener('click', (e) => {
            if (e.target === donationSearchModal) donationSearchModal.style.display = 'none';
        });
    }
    if (donationSearchGoBtn) {
        donationSearchGoBtn.addEventListener('click', () => {
            searchDonationRecords(donationSearchInput?.value || '');
        });
    }
    if (donationSearchInput) {
        donationSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchDonationRecords(donationSearchInput.value || '');
            }
        });
    }

    // ============================================
    // EXPOSE GLOBAL FUNCTIONS
    // ============================================
    window.showViewItemsModal = showViewItemsModal;
    window.loadDonationForEdit = loadDonationForEdit;
    window.loadDonationTransaction = loadDonationForEdit;

    // ============================================
    // INITIAL SETUP
    // ============================================
    addPOSRow();
    
    console.log("✅ Donation POS initialized successfully!");
})();