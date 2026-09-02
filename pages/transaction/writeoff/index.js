// ============================================
// WRITE-OFF POS LOGIC (WITH ACCOUNTING)
// ============================================

(async function initWriteOff() {
    console.log("Write-Off initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 CHANGED: the shared window-level getCompanySettings() helper
    // (assets/js/shared-company-settings.js) no longer exists on the site,
    // so calling it here threw "getCompanySettings is not defined" and
    // aborted this entire module's init. Self-contained now: reads the
    // WO- prefix straight from the `company_settings` row, with a
    // hardcoded fallback if that fails for any reason.
    const companySettings = await (async function loadCompanySettingsInline() {
        const fallback = { writeoff_prefix: 'WO' };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select('writeoff_prefix')
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return { writeoff_prefix: data.writeoff_prefix || fallback.writeoff_prefix };
        } catch (e) {
            console.warn('Could not load company_settings, using defaults:', e);
            return fallback;
        }
    })();

    // ============================================
    // DOM REFERENCES
    // ============================================
    const tableBody = document.getElementById('writeOffTableBody');
    const productSelect = document.getElementById('writeOffProductSelect');
    const batchSelect = document.getElementById('writeOffBatchSelect');
    const qtyInput = document.getElementById('writeOffQtyInput');
    const addBatchBtn = document.getElementById('addBatchBtn');
    const reasonSelect = document.getElementById('writeOffReason');
    const reasonOther = document.getElementById('writeOffReasonOther');
    const saveBtn = document.getElementById('saveWriteOffBtn');
    const resetBtn = document.getElementById('resetWriteOffBtn');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const batchInfo = document.getElementById('batchInfo');
    const batchInfoText = document.getElementById('batchInfoText');

    // State
    let allProducts = [];
    let selectedProductBatches = [];
    let writeOffItems = [];
    let isLoading = false;

    // 🔥 FIX: same issue as retail.js/wholesale.js/donation.js -- this
    // used to not exist at all, so loadWriteOffForEdit() populated the
    // form from an existing write-off but saveWriteOff() had no way to
    // know it was an edit rather than a brand-new write-off, so it
    // ALWAYS inserted a new write_offs row (plus a new audit sales row,
    // a second stock deduction, and a second accounting entry) instead
    // of correcting the original. Set by loadWriteOffForEdit(), cleared
    // by generateReference() (Reset / post-save), read by saveWriteOff()
    // to decide update vs insert.
    let editingWriteOffId = null;

    // 🔥 ADDED: same as retail.js/wholesale.js/donation.js -- current
    // user's role, needed to gate the Delete button in search results to
    // Admin only. Fetched once in the background.
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
    // Ported from retail.js/wholesale.js/donation.js. Previously this file
    // hardcoded account codes ('6002', '1400') directly into journal_lines
    // inserts with no guarantee those rows existed in chart_of_accounts.
    const REQUIRED_ACCOUNTS = [
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '6002', name: 'Inventory Write-Offs', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and twice per
    // save at that, since the accounting-entries function called it
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
                inventory_write_offs: accountMap['inventory_write_offs'] || '6002'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return { inventory: '1400', inventory_write_offs: '6002' };
        }
    }

    // ============================================
    // CHECK CONNECTION FIRST
    // ============================================
    async function checkConnection() {
        try {
            const { data, error } = await supabaseClient
                .from('products')
                .select('id')
                .limit(1);
            
            if (error) {
                console.error("Connection check failed:", error);
                return false;
            }
            console.log("✅ Supabase connection successful");
            return true;
        } catch (e) {
            console.error("Connection error:", e);
            return false;
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
    // GENERATE REFERENCE NUMBER
    // ============================================
    function generateReference() {
        // 🔥 FIX: a fresh generated reference means this is a NEW write-off
        // from here on, not an edit of an existing one -- clear the edit
        // tracker so Save inserts instead of updating. Same pattern as
        // retail.js/wholesale.js/donation.js.
        editingWriteOffId = null;

        const display = document.getElementById('writeOffIdDisplay');
        const date = new Date();
        const year = date.getFullYear();
        // 🔥 FIX: the old scheme was WO-{year}-{4-digit random} — only
        // 10,000 possible IDs per year with no time component. Matched
        // here to retail/wholesale/donation's timestamp+random scheme.
        const timestamp = date.getTime().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const ref = `${companySettings.writeoff_prefix}-${year}-${timestamp}-${random}`;
        if (display) display.textContent = ref;
        return ref;
    }
    generateReference();

    // ============================================
    // LOAD PRODUCTS WITH RETRY
    // ============================================
    async function loadProducts(retryCount = 0) {
        if (isLoading) return;
        isLoading = true;

        try {
            const isConnected = await checkConnection();
            if (!isConnected) {
                productSelect.innerHTML = '<option value="">⚠️ Connection failed. Please refresh.</option>';
                isLoading = false;
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name')
                .order('product_name');

            clearTimeout(timeoutId);

            if (error) {
                console.error("Error loading products:", error);
                throw error;
            }

            allProducts = products || [];
            
            productSelect.innerHTML = '<option value="">🔍 Search or select product...</option>';
            if (products && products.length > 0) {
                products.forEach(p => {
                    productSelect.innerHTML += `<option value="${p.id}">${p.product_name}</option>`;
                });
            } else {
                productSelect.innerHTML = '<option value="">No products found</option>';
            }

            console.log(`✅ Loaded ${products ? products.length : 0} products`);

        } catch (error) {
            console.error("Error loading products:", error);
            
            if (retryCount < 3) {
                console.log(`Retrying... (${retryCount + 1}/3)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                await loadProducts(retryCount + 1);
            } else {
                productSelect.innerHTML = `
                    <option value="">❌ Error loading products</option>
                    <option value="RETRY" style="color: #2563eb;">🔄 Click to retry</option>
                `;
                productSelect.addEventListener('change', function() {
                    if (this.value === 'RETRY') {
                        loadProducts();
                    }
                });
            }
        } finally {
            isLoading = false;
        }
    }

    // ============================================
    // LOAD BATCHES FOR SELECTED PRODUCT
    // ============================================
    async function loadBatchesForProduct(productId) {
        if (!productId) {
            batchSelect.innerHTML = '<option value="">Select batch...</option>';
            batchInfo.style.display = 'none';
            return;
        }

        try {
            const { data: batches, error } = await supabaseClient
                .from('batches')
                .select(`
                    id,
                    batch_number,
                    expiry_date,
                    total_qty,
                    cost_price
                `)
                .eq('product_id', productId)
                .gt('total_qty', 0)
                .order('expiry_date', { ascending: true });

            if (error) throw error;

            selectedProductBatches = batches || [];
            
            batchSelect.innerHTML = '<option value="">Select batch...</option>';
            
            if (batches.length === 0) {
                batchSelect.innerHTML = '<option value="">No stock available</option>';
                batchInfo.style.display = 'block';
                batchInfoText.textContent = '⚠️ No stock available for this product.';
                batchInfoText.style.color = '#dc2626';
                return;
            }

            const firstBatch = batches[0];
            const expiry = new Date(firstBatch.expiry_date);
            const today = new Date();
            const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
            
            batchInfo.style.display = 'block';
            batchInfoText.style.color = '#64748b';
            batchInfoText.textContent = `📦 ${batches.length} batch(es) available. FEFO: ${firstBatch.batch_number} (${daysUntilExpiry} days until expiry)`;

            batches.forEach(b => {
                const expiryDate = new Date(b.expiry_date).toLocaleDateString();
                const days = Math.ceil((new Date(b.expiry_date) - today) / (1000 * 60 * 60 * 24));
                let expiryLabel = '';
                if (days < 0) expiryLabel = '🔴 EXPIRED';
                else if (days <= 30) expiryLabel = `🟡 ${days} days`;
                else expiryLabel = `🟢 ${days} days`;
                
                batchSelect.innerHTML += `
                    <option value="${b.id}" data-qty="${b.total_qty}" data-cost="${b.cost_price}" data-expiry="${b.expiry_date}">
                        ${b.batch_number} | Qty: ${b.total_qty} | Exp: ${expiryDate} ${expiryLabel}
                    </option>
                `;
            });

            if (batches.length > 0) {
                batchSelect.value = batches[0].id;
                updateQtyMax();
            }

        } catch (error) {
            console.error("Error loading batches:", error);
            batchSelect.innerHTML = '<option value="">Error loading batches</option>';
            batchInfo.style.display = 'block';
            batchInfoText.textContent = '❌ Error loading batches. Please try again.';
            batchInfoText.style.color = '#dc2626';
        }
    }

    // ============================================
    // UPDATE QTY MAX
    // ============================================
    function updateQtyMax() {
        const selected = batchSelect.options[batchSelect.selectedIndex];
        if (selected && selected.dataset.qty) {
            const maxQty = parseInt(selected.dataset.qty) || 0;
            qtyInput.max = maxQty;
            qtyInput.placeholder = `Max: ${maxQty}`;
            if (parseInt(qtyInput.value) > maxQty) {
                qtyInput.value = maxQty;
            }
        }
    }

    // ============================================
    // ADD BATCH TO WRITE-OFF LIST
    // ============================================
    function addBatchToWriteOff() {
        const productId = productSelect.value;
        const batchId = batchSelect.value;
        const qty = parseInt(qtyInput.value) || 0;

        if (!productId) {
            alert('Please select a product.');
            productSelect.focus();
            return;
        }

        if (!batchId) {
            alert('Please select a batch.');
            batchSelect.focus();
            return;
        }

        if (qty <= 0) {
            alert('Please enter a valid quantity.');
            qtyInput.focus();
            return;
        }

        if (writeOffItems.find(item => item.batch_id === batchId)) {
            alert('This batch is already in the list.');
            return;
        }

        const product = allProducts.find(p => p.id === productId);
        const batch = selectedProductBatches.find(b => b.id === batchId);

        if (!batch) {
            alert('Batch not found.');
            return;
        }

        if (qty > batch.total_qty) {
            alert(`Maximum available quantity is ${batch.total_qty}`);
            return;
        }

        writeOffItems.push({
            batch_id: batch.id,
            batch_number: batch.batch_number,
            product_name: product ? product.product_name : 'Unknown',
            product_id: productId,
            expiry_date: batch.expiry_date,
            available_qty: batch.total_qty,
            qty_to_write: qty,
            cost_per_unit: batch.cost_price || 0,
            total_cost: (batch.cost_price || 0) * qty
        });

        renderWriteOffTable();
        updateTotals();
        resetSelection();
    }

    // ============================================
    // RESET SELECTION
    // ============================================
    function resetSelection() {
        productSelect.value = '';
        batchSelect.innerHTML = '<option value="">Select batch...</option>';
        qtyInput.value = '1';
        batchInfo.style.display = 'none';
        selectedProductBatches = [];
        productSelect.focus();
    }

    // ============================================
    // RENDER WRITE-OFF TABLE
    // ============================================
    function renderWriteOffTable() {
        if (!tableBody) return;
        
        if (writeOffItems.length === 0) {
            tableBody.innerHTML = `
                <tr class="writeoff-placeholder">
                    <td colspan="8" style="text-align: center; padding: 40px; color: #94a3b8;">
                        <i class="fa-solid fa-box-open" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                        <p>No batches added yet.</p>
                        <p style="font-size: 0.85rem;">Search and select a product above to add batches.</p>
                    </td>
                </tr>
            `;
            return;
        }

        let html = '';
        writeOffItems.forEach((item, index) => {
            const expiry = new Date(item.expiry_date);
            const today = new Date();
            const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
            const isExpired = daysUntilExpiry < 0;

            html += `
                <tr style="${isExpired ? 'background: #fef2f2;' : ''} border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px 10px 10px 20px; font-weight: 500;">${item.product_name}</td>
                    <td style="padding: 10px; font-family: monospace;">${item.batch_number}</td>
                    <td style="padding: 10px; ${isExpired ? 'color: #dc2626;' : ''}">${expiry.toLocaleDateString()}</td>
                    <td style="padding: 10px; text-align: center;">${item.available_qty}</td>
                    <td style="padding: 10px; text-align: center;">
                        <input type="number" class="writeoff-qty" data-index="${index}" 
                               min="0" max="${item.available_qty}" value="${item.qty_to_write}" 
                               style="width: 70px; padding: 4px 8px; border: 1px solid #e2e8f0; border-radius: 4px; text-align: center;">
                    </td>
                    <td style="padding: 10px; text-align: right;">K${item.cost_per_unit.toFixed(2)}</td>
                    <td style="padding: 10px; text-align: right; font-weight: 600;" class="writeoff-total-cost" data-index="${index}">
                        K${item.total_cost.toFixed(2)}
                    </td>
                    <td style="padding: 10px 20px 10px 10px; text-align: center;">
                        <button class="remove-writeoff-item" data-index="${index}" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 1.1rem;">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </td>
                </tr>
            `;
        });

        tableBody.innerHTML = html;

        document.querySelectorAll('.writeoff-qty').forEach(input => {
            input.addEventListener('input', function() {
                const index = parseInt(this.dataset.index);
                const qty = parseInt(this.value) || 0;
                const max = parseInt(this.max) || 0;
                
                if (qty > max) {
                    this.value = max;
                    alert(`Maximum available quantity is ${max}`);
                    return;
                }
                
                writeOffItems[index].qty_to_write = qty;
                writeOffItems[index].total_cost = qty * writeOffItems[index].cost_per_unit;
                
                const totalCostEl = document.querySelector(`.writeoff-total-cost[data-index="${index}"]`);
                if (totalCostEl) {
                    totalCostEl.textContent = `K${writeOffItems[index].total_cost.toFixed(2)}`;
                }
                updateTotals();
            });
        });

        document.querySelectorAll('.remove-writeoff-item').forEach(btn => {
            btn.addEventListener('click', function() {
                const index = parseInt(this.dataset.index);
                writeOffItems.splice(index, 1);
                renderWriteOffTable();
                updateTotals();
            });
        });
    }

    // ============================================
    // UPDATE TOTALS
    // ============================================
    function updateTotals() {
        let totalItems = writeOffItems.length;
        let totalQty = 0;
        let totalCost = 0;

        writeOffItems.forEach(item => {
            totalQty += item.qty_to_write || 0;
            totalCost += item.total_cost || 0;
        });

        const itemsEl = document.getElementById('writeOffTotalItems');
        const qtyEl = document.getElementById('writeOffTotalQty');
        const costEl = document.getElementById('writeOffTotalCost');
        
        if (itemsEl) itemsEl.textContent = totalItems;
        if (qtyEl) qtyEl.textContent = totalQty;
        if (costEl) costEl.textContent = `K${totalCost.toFixed(2)}`;
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================
    
    if (productSelect) {
        productSelect.addEventListener('change', function() {
            const productId = this.value;
            loadBatchesForProduct(productId);
        });
    }

    if (batchSelect) {
        batchSelect.addEventListener('change', updateQtyMax);
    }

    if (addBatchBtn) {
        addBatchBtn.addEventListener('click', addBatchToWriteOff);
    }

    if (qtyInput) {
        qtyInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addBatchToWriteOff();
            }
        });
    }

    // ============================================
    // REASON SELECT LOGIC
    // ============================================
    if (reasonSelect) {
        reasonSelect.addEventListener('change', function() {
            if (this.value === 'Other') {
                if (reasonOther) reasonOther.style.display = 'block';
            } else {
                if (reasonOther) {
                    reasonOther.style.display = 'none';
                    reasonOther.value = '';
                }
            }
        });
    }

    // ============================================
    // LOAD WRITE-OFF FOR EDIT
    // ============================================
    async function loadWriteOffForEdit(saleData) {
        try {
            console.log('Loading write-off for edit:', saleData);

            // 🔥 FIX: the write_offs table itself has no `items` column --
            // items only ever lived in write_off_items, joined by
            // write_off_id. saleData here is the RAW write_offs row (as
            // passed by transaction-view.js), so saleData.items was always
            // undefined and this whole "Add items to table" step was a
            // silent no-op: editing a write-off never actually loaded any
            // items to edit. Fetch them explicitly when they weren't
            // already provided some other way.
            const writeOffId = saleData.db_id || saleData.id || null;
            let sourceItems = saleData.items;
            if ((!sourceItems || sourceItems.length === 0) && writeOffId) {
                const { data: woItems, error: woItemsError } = await supabaseClient
                    .from('write_off_items')
                    .select('*')
                    .eq('write_off_id', writeOffId);

                if (woItemsError) {
                    console.error('Error loading write-off items for edit:', woItemsError);
                    alert('Error loading write-off items: ' + woItemsError.message);
                    return;
                }

                // available_qty must reflect what will actually be
                // available once this write-off's original deduction is
                // restored at save time (saveWriteOff() does that
                // restoration first) -- so it's the batch's CURRENT stock
                // plus the quantity this same write-off already took out,
                // not just the current stock on its own (which would make
                // the max="" cap on the qty input, and the newQty math at
                // save time, both understate what's really available).
                const batchIds = [...new Set((woItems || []).map(i => i.batch_id).filter(Boolean))];
                const { data: batches } = await supabaseClient
                    .from('batches').select('id, total_qty').in('id', batchIds);
                const batchQtyMap = {};
                (batches || []).forEach(b => batchQtyMap[b.id] = b.total_qty);

                sourceItems = (woItems || []).map(row => ({
                    batch_id: row.batch_id,
                    batch_number: row.batch_number,
                    product_name: row.product_name,
                    product_id: row.product_id,
                    qty: row.qty_written_off,
                    available_qty: (batchQtyMap[row.batch_id] ?? 0) + (row.qty_written_off || 0),
                    cost_per_unit: row.cost_per_unit,
                    total: row.total_cost
                }));
            }

            // Set reason
            if (saleData.payment && saleData.payment.note) {
                const reason = saleData.payment.note;
                // Check if reason matches any predefined options
                const options = ['Expired', 'Damaged', 'Expired/Expiring', 'Damaged/Expired', 'Stock Adjustment'];
                if (options.includes(reason)) {
                    reasonSelect.value = reason;
                } else {
                    reasonSelect.value = 'Other';
                    reasonOther.style.display = 'block';
                    reasonOther.value = reason;
                }
            } else if (saleData.reason) {
                // Raw write_offs rows carry the reason directly on the
                // `reason` column, not nested under payment.note.
                const reason = saleData.reason;
                const options = ['Expired', 'Damaged', 'Expired/Expiring', 'Damaged/Expired', 'Stock Adjustment'];
                if (options.includes(reason)) {
                    reasonSelect.value = reason;
                } else {
                    reasonSelect.value = 'Other';
                    reasonOther.style.display = 'block';
                    reasonOther.value = reason;
                }
            }

            // Add items to table
            if (sourceItems && sourceItems.length > 0) {
                // Clear existing items
                writeOffItems = [];

                // Add each item as a write-off item
                sourceItems.forEach(item => {
                    writeOffItems.push({
                        batch_id: item.batch_id || '',
                        batch_number: item.batch_number || 'N/A',
                        product_name: item.product_name || 'Unknown',
                        product_id: item.product_id || '',
                        expiry_date: item.expiry_date || new Date().toISOString(),
                        available_qty: item.available_qty || item.qty || 0,
                        qty_to_write: item.qty || 0,
                        cost_per_unit: item.cost_per_unit || item.rate || 0,
                        total_cost: item.total || (item.qty * item.rate) || 0
                    });
                });

                renderWriteOffTable();
                updateTotals();
            }

            // Set reference number
            const refNumber = saleData.sale_id || saleData.reference_number;
            if (refNumber) {
                const display = document.getElementById('writeOffIdDisplay');
                if (display) {
                    display.textContent = refNumber;
                }
            }

            // 🔥 FIX: set this so Save updates this write-off in place
            // instead of inserting a duplicate. See the state declaration
            // near the top of the file for why this is needed at all.
            editingWriteOffId = writeOffId;

            alert('✅ Write-Off loaded for editing. Make changes and save.');

        } catch (error) {
            console.error('Error loading write-off for edit:', error);
            alert('Error loading write-off: ' + error.message);
        }
    }

    // ============================================
    // WRITE-OFF ACCOUNTING INTEGRATION (NEW)
    // ============================================
    async function createWriteOffAccountingEntries(refNumber, validItems, totalCost) {
        try {
            if (totalCost > 0) {
                await ensureChartOfAccounts();
                const accountCodes = await getAccountCodesFromChartOfAccounts();
                const entryDate = new Date().toISOString().split('T')[0];

                // 1. Create the Journal Entry Header
                const journal = {
                    entry_date: entryDate,
                    reference: refNumber,
                    description: `Inventory Write-off: ${validItems.length} item(s)`,
                    journal_number: `WOF-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: journalData, error: jError } = await supabaseClient
                    .from('journal_entries')
                    .insert([journal])
                    .select();

                if (jError) throw jError;

                // 2. Create the Journal Lines
                const lines = [
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.inventory_write_offs,
                        description: `Write-off cost`,
                        debit: totalCost,
                        credit: 0
                    },
                    {
                        journal_entry_id: journalData[0].id,
                        account_code: accountCodes.inventory,
                        description: `Inventory reduction from write-off`,
                        debit: 0,
                        credit: totalCost
                    }
                ];

                const { error: lineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(lines);

                if (lineError) throw lineError;

                console.log(`✅ Write-off accounting entries created for ${refNumber} (Cost: K${totalCost.toFixed(2)})`);
            }
        } catch (accError) {
            console.error('Error creating write-off accounting entries:', accError);
            // Don't block the save
        }
    }

    // ============================================
    // SAVE WRITE-OFF (UPDATED WITH ACCOUNTING)
    // ============================================
    async function saveWriteOff() {
        if (!reasonSelect) return;
        
        const reason = reasonSelect.value;
        if (!reason) {
            alert('Please select a reason for write-off.');
            reasonSelect.focus();
            return;
        }

        if (reason === 'Other' && reasonOther && !reasonOther.value.trim()) {
            alert('Please specify the reason.');
            reasonOther.focus();
            return;
        }

        const finalReason = reason === 'Other' ? (reasonOther ? reasonOther.value.trim() : '') : reason;

        const validItems = writeOffItems.filter(item => item.qty_to_write > 0);
        if (validItems.length === 0) {
            alert('Please add at least one item with quantity > 0 to write off.');
            return;
        }

        const totalQty = validItems.reduce((sum, i) => sum + i.qty_to_write, 0);
        const totalCost = validItems.reduce((sum, i) => sum + i.total_cost, 0);

        if (!confirm(`Are you sure you want to write off ${totalQty} items worth K${totalCost.toFixed(2)}? This action cannot be undone.`)) {
            return;
        }

        const btn = document.getElementById('saveWriteOffBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        }

        try {
            let refNumber = document.getElementById('writeOffIdDisplay')?.textContent || generateReference();

            // 🔥 FIX: editing an existing write-off (editingWriteOffId set
            // by loadWriteOffForEdit()) must UPDATE the original write_offs
            // row, never insert a new one -- see that variable's
            // declaration near the top of the file (this used to always
            // insert, silently duplicating the write-off, its stock
            // deduction, and its accounting entry on every edit). Before
            // writing anything, undo exactly what the ORIGINAL save did:
            // restore the stock it deducted (from the original
            // write_off_items rows), remove those rows, and remove the old
            // audit `sales` record and its journal entry (both matched by
            // this write-off's own reference number, which stays the same
            // across an edit). The rest of this function then re-runs its
            // normal deduction/audit/accounting steps for the edited items
            // exactly as it already does for a brand-new write-off.
            if (editingWriteOffId) {
                const { data: oldItems, error: oldItemsError } = await supabaseClient
                    .from('write_off_items')
                    .select('batch_id, qty_written_off')
                    .eq('write_off_id', editingWriteOffId);

                if (oldItemsError) {
                    console.error('Error loading original write-off items for edit:', oldItemsError);
                    alert('❌ Could not load the original write-off to edit it safely. Nothing was changed.\n' + oldItemsError.message);
                    return;
                }

                if (oldItems && oldItems.length > 0) {
                    const qtyToRestoreByBatch = new Map();
                    for (const item of oldItems) {
                        qtyToRestoreByBatch.set(item.batch_id, (qtyToRestoreByBatch.get(item.batch_id) || 0) + (item.qty_written_off || 0));
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

                await supabaseClient.from('write_off_items').delete().eq('write_off_id', editingWriteOffId);

                await supabaseClient.from('sales').delete().eq('sale_id', refNumber).eq('client_type', 'WRITEOFF');

                const { data: oldJournals } = await supabaseClient
                    .from('journal_entries')
                    .select('id')
                    .eq('reference', refNumber);

                if (oldJournals && oldJournals.length > 0) {
                    const oldJournalIds = oldJournals.map(j => j.id);
                    await supabaseClient.from('journal_lines').delete().in('journal_entry_id', oldJournalIds);
                    await supabaseClient.from('journal_entries').delete().in('id', oldJournalIds);
                }
            }

            // Create (or update) the write-off record
            let writeOff;
            if (editingWriteOffId) {
                const { data, error: woError } = await supabaseClient
                    .from('write_offs')
                    .update({
                        reference_number: refNumber,
                        date: new Date().toISOString().split('T')[0],
                        reason: finalReason,
                        total_qty_written_off: totalQty,
                        total_cost_written_off: totalCost
                    })
                    .eq('id', editingWriteOffId)
                    .select();

                if (woError) throw woError;
                if (!data || data.length === 0) {
                    alert('❌ Could not find the original write-off to update. Nothing was saved.');
                    return;
                }
                writeOff = data;
            } else {
                const { data, error: woError } = await supabaseClient
                    .from('write_offs')
                    .insert([{
                        reference_number: refNumber,
                        date: new Date().toISOString().split('T')[0],
                        reason: finalReason,
                        total_qty_written_off: totalQty,
                        total_cost_written_off: totalCost
                    }])
                    .select();

                if (woError) {
                    // 🔥 ADDED: same duplicate-reference retry pattern used
                    // in retail.js/wholesale.js/donation.js.
                    if (woError.code === '23505' || woError.message?.includes('duplicate key')) {
                        console.log('⚠️ Duplicate reference, regenerating...');
                        refNumber = generateReference();
                        const { data: retryData, error: retryError } = await supabaseClient
                            .from('write_offs')
                            .insert([{
                                reference_number: refNumber,
                                date: new Date().toISOString().split('T')[0],
                                reason: finalReason,
                                total_qty_written_off: totalQty,
                                total_cost_written_off: totalCost
                            }])
                            .select();
                        if (retryError) throw new Error('Failed to save (Retry): ' + retryError.message);
                        writeOff = retryData;
                    } else {
                        throw woError;
                    }
                } else {
                    writeOff = data;
                }
            }

            const writeOffId = writeOff[0].id;

            // ============================================
            // Add write-off items and update stock
            // ============================================
            // 🔥 FIX: this loop used to `throw` immediately on the first
            // item that failed (either the write_off_items insert or the
            // batches update), which aborted the ENTIRE function via the
            // outer catch block. That meant the sales audit record and the
            // accounting journal entries were skipped completely — even for
            // items earlier in the loop that had ALREADY been successfully
            // deducted from stock. You'd end up with real stock reductions
            // and write_off_items rows in the database, but zero audit
            // trail and zero accounting for any of it. Now each item is
            // processed independently: failures are collected and reported,
            // but successful items still get their sales record and
            // accounting entries posted for the amount actually written off.
            // 🔥 PERF FIX: previously processed one item at a time --
            // insert its write_off_items row, THEN update its batch, THEN
            // move to the next item -- so a write-off with many lines
            // meant waiting on 2 sequential round-trips per line, one
            // after another. Each item here is independent (its own
            // batch, its own pre-fetched available_qty), so all of them
            // now run concurrently via Promise.all(). Per-item success/
            // failure tracking (an item recorded but its stock update
            // failing, etc.) is preserved exactly as before -- each item
            // just reports its own outcome instead of the loop moving on
            // to the next item only after this one fully finishes.
            const itemResults = await Promise.all(validItems.map(async (item) => {
                try {
                    const { error: itemError } = await supabaseClient
                        .from('write_off_items')
                        .insert([{
                            write_off_id: writeOffId,
                            batch_id: item.batch_id,
                            product_id: item.product_id,
                            product_name: item.product_name,
                            batch_number: item.batch_number,
                            qty_written_off: item.qty_to_write,
                            cost_per_unit: item.cost_per_unit,
                            total_cost: item.total_cost
                        }]);

                    if (itemError) {
                        return { item, ok: false, message: `${item.product_name} (${item.batch_number}): ${itemError.message}` };
                    }

                    const newQty = item.available_qty - item.qty_to_write;
                    const { error: updateError } = await supabaseClient
                        .from('batches')
                        .update({ total_qty: newQty })
                        .eq('id', item.batch_id);

                    if (updateError) {
                        // The write_off_items row was inserted but the stock
                        // update failed — flag this clearly rather than
                        // silently treating it as fully successful.
                        return { item, ok: false, message: `${item.product_name} (${item.batch_number}): item recorded but stock update failed - ${updateError.message}` };
                    }

                    console.log(`Batch ${item.batch_number} stock updated: ${item.available_qty} -> ${newQty}`);
                    return { item, ok: true };

                } catch (err) {
                    return { item, ok: false, message: `${item.product_name} (${item.batch_number}): ${err.message}` };
                }
            }));

            const succeededItems = itemResults.filter(r => r.ok).map(r => r.item);
            const itemErrors = itemResults.filter(r => !r.ok).map(r => r.message);

            if (succeededItems.length === 0) {
                alert(`❌ Write-off failed for all items:\n\n${itemErrors.join('\n')}`);
                return;
            }

            // From here on, use only what actually succeeded.
            const succeededQty = succeededItems.reduce((sum, i) => sum + i.qty_to_write, 0);
            const succeededCost = succeededItems.reduce((sum, i) => sum + i.total_cost, 0);

            if (itemErrors.length > 0) {
                alert(`⚠️ Write-off partially completed.\n\n${succeededItems.length} of ${validItems.length} items succeeded (${succeededQty} units, K${succeededCost.toFixed(2)}).\n\nFailed:\n${itemErrors.join('\n')}\n\nPlease review the failed items manually.`);
            }

            // Also create a sales record for the write-off (Audit Trail)
            const salesRecord = {
                sale_id: refNumber,
                type: 'WRITEOFF',
                prefix: 'WO',
                client_type: 'WRITEOFF',
                client_sub_type: 'WRITEOFF',
                customer_data: {
                    full_name: 'Stock Write-Off',
                    reason: finalReason
                },
                items: succeededItems.map(item => ({
                    product_id: item.product_id,
                    product_name: item.product_name,
                    batch_id: item.batch_id,
                    batch_number: item.batch_number,
                    qty: item.qty_to_write,
                    rate: item.cost_per_unit,
                    total: item.total_cost,
                    cost_per_unit: item.cost_per_unit
                })),
                payment: {
                    type: 'Write-Off',
                    note: finalReason
                },
                subtotal: succeededCost,
                tax: 0,
                grand_total: succeededCost,
                status: 'COMPLETED',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            let salesInsertResult = await supabaseClient.from('sales').insert([salesRecord]);
            if (salesInsertResult.error) {
                // 🔥 ADDED: same duplicate-key retry pattern.
                if (salesInsertResult.error.code === '23505' || salesInsertResult.error.message?.includes('duplicate key')) {
                    console.log('⚠️ Duplicate sale_id on write-off audit record, regenerating...');
                    salesRecord.sale_id = `${refNumber}-${Math.floor(Math.random() * 10000)}`;
                    salesInsertResult = await supabaseClient.from('sales').insert([salesRecord]);
                }
                if (salesInsertResult.error) {
                    console.error('Error creating sales record for write-off:', salesInsertResult.error);
                    alert(`⚠️ Write-Off ${refNumber} saved but sales record failed. Please check manually.`);
                }
            }

            // ============================================
            // CREATE ACCOUNTING ENTRIES (CALLED HERE)
            // ============================================
            await createWriteOffAccountingEntries(refNumber, succeededItems, succeededCost);

            // Only show the "completed successfully" alert when everything
            // succeeded — the partial-failure alert above already covers
            // the mixed-result case, so showing this too would misleadingly
            // claim full success right after warning about failures.
            if (itemErrors.length === 0) {
                alert(`✅ Write-Off ${refNumber} completed successfully!\nTotal: ${succeededQty} items | K${succeededCost.toFixed(2)}`);
            }

            resetForm();
            generateReference();

        } catch (error) {
            console.error("Error processing write-off:", error);
            alert("❌ Error processing write-off: " + error.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Process Write-Off';
            }
        }
    }

    // ============================================
    // RESET FORM
    // ============================================
    function resetForm() {
        writeOffItems = [];
        renderWriteOffTable();
        updateTotals();
        if (reasonSelect) reasonSelect.value = '';
        if (reasonOther) {
            reasonOther.style.display = 'none';
            reasonOther.value = '';
        }
        resetSelection();
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
            if (resetBtn) resetBtn.click();
        }
    });

    // ============================================
    // BUTTON EVENTS
    // ============================================
    if (saveBtn) saveBtn.addEventListener('click', saveWriteOff);
    
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            if (writeOffItems.length > 0) {
                if (!confirm('Are you sure you want to reset all items?')) return;
            }
            resetForm();
            // 🔥 FIX: same as retail.js's Clear button -- regenerate the
            // reference (and clear editingWriteOffId as a side effect of
            // generateReference()) so Reset genuinely starts a new
            // write-off instead of leaving the form pointed at whatever
            // record was being edited, now with its items wiped out.
            generateReference();
        });
    }

    // ============================================
    // 🔥 ADDED: SEARCH WRITE-OFFS (find + edit an older write-off) --
    // same feature retail.js/wholesale.js/donation.js already have.
    // Before this, the ONLY way to edit an existing write-off at all was
    // Transaction Overview's "Today's Transactions" widget -- and even
    // that never actually loaded the write-off's items (see
    // loadWriteOffForEdit()'s fix above). No date limit here -- this
    // searches every write-off ever saved.
    // ============================================
    async function searchWriteOffRecords(query) {
        const resultsEl = document.getElementById('writeOffSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>`;

        try {
            let dbQuery = supabaseClient
                .from('write_offs')
                .select('id, reference_number, date, reason, total_qty_written_off, total_cost_written_off, created_at')
                .order('created_at', { ascending: false })
                .limit(20);

            if (query && query.trim() !== '') {
                const term = query.trim().replace(/[%_]/g, '\\$&');
                dbQuery = dbQuery.or(
                    `reference_number.ilike.%${term}%,reason.ilike.%${term}%`
                );
            }

            const { data: results, error } = await dbQuery;
            if (error) throw error;

            renderWriteOffSearchResults(results || []);
        } catch (error) {
            console.error('Error searching write-offs:', error);
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#dc2626;">Error searching: ${error.message}</div>`;
        }
    }

    function renderWriteOffSearchResults(results) {
        const resultsEl = document.getElementById('writeOffSearchResults');
        if (!resultsEl) return;

        if (results.length === 0) {
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;">No matching write-offs found.</div>`;
            return;
        }

        const isAdmin = currentUserRole === 'Admin';

        resultsEl.innerHTML = results.map(r => {
            const date = new Date(r.created_at || r.date).toLocaleDateString();
            return `
                <div style="padding:12px; margin-bottom:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <span style="font-weight:600;">${r.reference_number}</span>
                            <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">${r.reason || 'N/A'} &middot; ${r.total_qty_written_off || 0} units &middot; K${(r.total_cost_written_off || 0).toFixed(2)} &middot; ${date}</div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button class="writeoff-search-edit-btn" data-id="${r.id}" style="background:#f59e0b; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-pen"></i> Edit</button>
                            ${isAdmin ? `<button class="writeoff-search-delete-btn" data-id="${r.id}" data-ref="${r.reference_number}" style="background:#dc2626; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        resultsEl.querySelectorAll('.writeoff-search-edit-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const record = results.find(r => r.id === btn.dataset.id);
                if (!record) return;
                await loadWriteOffForEdit(record);
                document.getElementById('writeOffSearchModal').style.display = 'none';
            });
        });

        resultsEl.querySelectorAll('.writeoff-search-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteWriteOffRecord(btn.dataset.id, btn.dataset.ref));
        });
    }

    // 🔥 ADDED: same conservative baseline as the other modules'
    // deleteXRecord() -- removes the write-off, its write_off_items rows,
    // and its audit sales row only. Does not touch stock or the
    // accounting ledger. Admin-only, checked both in the UI and here.
    async function deleteWriteOffRecord(id, refNumber) {
        if (currentUserRole !== 'Admin') {
            alert('Only an Admin can delete a write-off record.');
            return;
        }

        const confirmed = confirm(
            `Delete ${refNumber}?\n\nThis permanently removes the write-off record. ` +
            `It does NOT restore stock or reverse any accounting entries already posted for it -- ` +
            `those will need to be corrected separately if this write-off affected them.\n\nThis cannot be undone.`
        );
        if (!confirmed) return;

        try {
            const { error: itemsError } = await supabaseClient.from('write_off_items').delete().eq('write_off_id', id);
            if (itemsError) throw itemsError;

            await supabaseClient.from('sales').delete().eq('sale_id', refNumber).eq('client_type', 'WRITEOFF');

            const { error: woError } = await supabaseClient.from('write_offs').delete().eq('id', id);
            if (woError) throw woError;

            alert(`✅ ${refNumber} deleted.`);
            searchWriteOffRecords(document.getElementById('writeOffSearchInput')?.value || '');
        } catch (error) {
            console.error('Error deleting write-off:', error);
            alert('Error deleting write-off: ' + error.message);
        }
    }

    const searchWriteOffsBtn = document.getElementById('searchWriteOffsBtn');
    const writeOffSearchModal = document.getElementById('writeOffSearchModal');
    const writeOffCloseSearchModalBtn = document.getElementById('writeOffCloseSearchModalBtn');
    const writeOffSearchInput = document.getElementById('writeOffSearchInput');
    const writeOffSearchGoBtn = document.getElementById('writeOffSearchGoBtn');

    if (searchWriteOffsBtn && writeOffSearchModal) {
        searchWriteOffsBtn.addEventListener('click', () => {
            writeOffSearchModal.style.display = 'flex';
            if (writeOffSearchInput) writeOffSearchInput.value = '';
            searchWriteOffRecords('');
        });
    }
    if (writeOffCloseSearchModalBtn && writeOffSearchModal) {
        writeOffCloseSearchModalBtn.addEventListener('click', () => {
            writeOffSearchModal.style.display = 'none';
        });
    }
    if (writeOffSearchModal) {
        writeOffSearchModal.addEventListener('click', (e) => {
            if (e.target === writeOffSearchModal) writeOffSearchModal.style.display = 'none';
        });
    }
    if (writeOffSearchGoBtn) {
        writeOffSearchGoBtn.addEventListener('click', () => {
            searchWriteOffRecords(writeOffSearchInput?.value || '');
        });
    }
    if (writeOffSearchInput) {
        writeOffSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchWriteOffRecords(writeOffSearchInput.value || '');
            }
        });
    }

    // ============================================
    // EXPOSE GLOBALLY
    // ============================================
    window.loadWriteOffForEdit = loadWriteOffForEdit;

    // ============================================
    // INITIAL SETUP
    // ============================================
    const isConnected = await checkConnection();
    if (isConnected) {
        await loadProducts();
    } else {
        productSelect.innerHTML = `
            <option value="">⚠️ Cannot connect to database</option>
            <option value="RETRY" style="color: #2563eb;">🔄 Click to retry</option>
        `;
        productSelect.addEventListener('change', function() {
            if (this.value === 'RETRY') {
                initWriteOff();
            }
        });
    }
    
    renderWriteOffTable();
    updateTotals();

    console.log("✅ Write-Off initialized successfully!");
})();