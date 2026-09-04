// ============================================
// PRODUCT MASTER - WITH DYNAMIC ACCOUNTING & CSV UPLOAD
// ============================================

(async function initProductPage() {
    console.log("Product page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // ACCOUNT CACHE - Load from Chart of Accounts
    // ============================================
    let accountCache = {};

    // 🔒 LOCKED: cached copy of today's shared exchange rate (Dashboard),
    // loaded once at init and used to drive the read-only Exchange Rate
    // field on the Add Batch form -- see updateBatchCost() below.
    let sharedZmwPerUsd = 25.00;

    // 🔥 ADDED: safeguard against a repeat of the ALL-CAPS-vs-Proper-Case
    // mess found across products/customers/suppliers/etc. and cleaned up
    // in bulk. Only touches a value that is ENTIRELY caps (e.g. someone
    // typed or pasted "ESOZ 20MG TABLET") -- anything already mixed-case,
    // including deliberately-preserved acronyms like "(UK)", is left
    // exactly as typed.
    function toProperCaseIfAllCaps(str) {
        if (!str) return str;
        const trimmed = str.trim();
        if (trimmed.length > 2 && trimmed === trimmed.toUpperCase() && trimmed !== trimmed.toLowerCase()) {
            return trimmed.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        }
        return str;
    }

    async function loadAccountCodes() {
        try {
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', ['Inventory', 'Opening Balance Equity', 'Accounts Payable']);

            if (error) throw error;

            accountCache = {};
            accounts.forEach(acc => {
                const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                accountCache[key] = acc.code;
            });

            if (!accountCache.inventory) {
                console.warn("⚠️ 'Inventory' account not found. Falling back to 1400.");
                accountCache.inventory = '1400';
            }
            if (!accountCache.opening_balance_equity) {
                console.warn("⚠️ 'Opening Balance Equity' account not found. Falling back to 3000.");
                accountCache.opening_balance_equity = '3000';
            }
            if (!accountCache.accounts_payable) {
                console.warn("⚠️ 'Accounts Payable' account not found. Falling back to 2001.");
                accountCache.accounts_payable = '2001';
            }

            console.log('✅ Account codes loaded successfully:', accountCache);
            return accountCache;

        } catch (error) {
            console.error('❌ Error loading account codes:', error);
            accountCache = {
                inventory: '1400',
                opening_balance_equity: '3000',
                accounts_payable: '2001'
            };
            return accountCache;
        }
    }

    // ============================================
    // LOAD PRODUCTS (Moved inside the function)
    // ============================================
    async function loadProducts() {
        const tbody = document.getElementById('productTableBody');

        try {
            const { data: products, error: prodError } = await supabaseClient
                .from('products')
                .select(`
                    id,
                    product_name,
                    conversion_rate,
                    min_order_qty,
                    nhima_price_fixed,
                    retail_regular_percent,
                    generic_name_id,
                    category_id,
                    sub_category_id,
                    supplier_id,
                    brand_id,
                    dosage_form_id,
                    generic_names ( name ),
                    categories ( name ),
                    sub_categories ( name ),
                    brands ( name ),
                    suppliers ( name )
                `)
                .order('product_name', { ascending: true });

            if (prodError) throw prodError;

            if (!products || products.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 30px; color: #94a3b8;">No products found. Click "Add Product" to get started!</td></tr>`;
                return;
            }

            const productIds = products.map(p => p.id);
            let stockMap = {};
            
            if (productIds.length > 0) {
                const { data: batches, error: batchError } = await supabaseClient
                    .from('batches')
                    .select('product_id, total_qty')
                    .in('product_id', productIds);

                if (!batchError && batches) {
                    batches.forEach(b => {
                        if (!stockMap[b.product_id]) stockMap[b.product_id] = 0;
                        stockMap[b.product_id] += b.total_qty || 0;
                    });
                }
            }

            const productsWithStock = products.map(p => ({
                ...p,
                total_stock: stockMap[p.id] || 0
            }));

            renderProducts(productsWithStock);

        } catch (error) {
            console.error("Error loading products:", error);
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message}</td></tr>`;
        }
    }

    // ============================================
    // RENDER PRODUCTS (Moved inside the function)
    // ============================================
    function renderProducts(products) {
        const tbody = document.getElementById('productTableBody');
        
        if (!tbody) return;
        
        if (products.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 30px; color: #94a3b8;">No products found. Click "Add Product" to get started!</td></tr>`;
            return;
        }
        
        tbody.innerHTML = products.map(p => {
            const stock = p.total_stock || 0;
            const minQty = p.min_order_qty || 1;
            const stockClass = stock < minQty ? 'color: #dc2626; font-weight: bold;' : 'color: #15803d;';
            
            return `
            <tr>
                <td style="padding-left: 20px; font-weight: 500;">${p.product_name}</td>
                <td>${p.generic_names?.name || '-'}</td>
                <td>${p.categories?.name || '-'}</td>
                <td>${p.sub_categories?.name || '-'}</td>
                <td>${p.conversion_rate || 1}</td>
                <td style="text-align: right; font-weight: bold;">${minQty}</td>
                <td style="text-align: right; ${stockClass}">${stock}</td>
                <td style="padding-right: 20px; text-align: right;">
                    <button onclick="editProduct('${p.id}')" style="background: none; border: none; color: #3b82f6; cursor: pointer;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                </td>
            </tr>
        `}).join('');
    }

    // ============================================
    // LOAD DROPDOWNS (Moved inside the function)
    // ============================================
    async function loadDropdowns() {
        try {
            const currentCategory = document.getElementById('category').value;
            const currentGeneric = document.getElementById('genericName').value;
            const currentDosage = document.getElementById('dosageForm').value;
            const currentSub = document.getElementById('subCategory').value;
            const currentBrand = document.getElementById('brand').value;
            const currentSupplier = document.getElementById('supplier').value;

            const { data: cats } = await supabaseClient.from('categories').select('id, name').order('name');
            const catSelect = document.getElementById('category');
            catSelect.innerHTML = `<option value="">Select Category</option>` + 
                (cats || []).map(c => `<option value="${c.id}" ${c.id === currentCategory ? 'selected' : ''}>${c.name}</option>`).join('');

            const { data: generics } = await supabaseClient.from('generic_names').select('id, name').order('name');
            const genSelect = document.getElementById('genericName');
            genSelect.innerHTML = `<option value="">Select Generic Name</option>` + 
                (generics || []).map(g => `<option value="${g.id}" ${g.id === currentGeneric ? 'selected' : ''}>${g.name}</option>`).join('');

            const { data: dosages } = await supabaseClient.from('dosage_forms').select('id, name').order('name');
            const dosSelect = document.getElementById('dosageForm');
            dosSelect.innerHTML = `<option value="">Select Dosage Form</option>` + 
                (dosages || []).map(d => `<option value="${d.id}" ${d.id === currentDosage ? 'selected' : ''}>${d.name}</option>`).join('');

            const { data: brands } = await supabaseClient.from('brands').select('id, name').order('name');
            const brandSelect = document.getElementById('brand');
            brandSelect.innerHTML = `<option value="">Select Brand</option>` + 
                (brands || []).map(b => `<option value="${b.id}" ${b.id === currentBrand ? 'selected' : ''}>${b.name}</option>`).join('');

            const { data: suppliers } = await supabaseClient.from('suppliers').select('id, name').order('name');
            const supSelect = document.getElementById('supplier');
            supSelect.innerHTML = `<option value="">Select Supplier</option>` + 
                (suppliers || []).map(s => `<option value="${s.id}" ${s.id === currentSupplier ? 'selected' : ''}>${s.name}</option>`).join('');

            if (currentCategory) {
                const { data: subs } = await supabaseClient
                    .from('sub_categories')
                    .select('id, name')
                    .eq('category_id', currentCategory)
                    .order('name');
                const subSelect = document.getElementById('subCategory');
                subSelect.innerHTML = `<option value="">Select Sub-Category</option>` + 
                    (subs || []).map(s => `<option value="${s.id}" ${s.id === currentSub ? 'selected' : ''}>${s.name}</option>`).join('');
            } else {
                const subSelect = document.getElementById('subCategory');
                subSelect.innerHTML = `<option value="">Select Sub-Category</option>`;
            }

            document.getElementById('category').addEventListener('change', async (e) => {
                const catId = e.target.value;
                const subSelect = document.getElementById('subCategory');
                if (!catId) {
                    subSelect.innerHTML = `<option value="">Select Sub-Category</option>`;
                    return;
                }
                const { data: subs } = await supabaseClient
                    .from('sub_categories')
                    .select('id, name')
                    .eq('category_id', catId)
                    .order('name');
                subSelect.innerHTML = `<option value="">Select Sub-Category</option>` + 
                    (subs || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
            });

        } catch (error) {
            console.error("Error loading dropdowns:", error);
        }
    }

    // ============================================
    // PAGE LOCK - Wait for Accounts to load
    // ============================================
    const openBtn = document.getElementById('addProductBtn');
    const csvBtn = document.getElementById('csvUploadBtn');
    if (openBtn) openBtn.disabled = true;
    if (csvBtn) csvBtn.disabled = true;

    await loadAccountCodes();
    sharedZmwPerUsd = await getSharedExchangeRate();

    if (openBtn) openBtn.disabled = false;
    if (csvBtn) csvBtn.disabled = false;

    // ============================================
    // DOM REFERENCES
    // ============================================
    await loadProducts();
    await loadDropdowns();

    const modal = document.getElementById('addProductModal');
    const closeBtn = document.getElementById('closeModalBtn');
    const cancelBtn = document.getElementById('cancelModalBtn');
    const modalTitle = document.getElementById('modalTitle');
    const submitBtn = document.getElementById('saveProductBtn');
    const hiddenId = document.getElementById('editProductId');
    
    const batchSectionContainer = document.querySelector('.batch-section');
    const batchDetailsSection = document.getElementById('batchDetailsSection');

    // ============================================
    // CSV UPLOAD MODAL
    // ============================================
    const csvModal = document.getElementById('csvUploadModal');
    const csvCloseBtn = document.getElementById('csvCloseModalBtn');
    const csvCancelBtn = document.getElementById('csvCancelModalBtn');
    const csvFileInput = document.getElementById('csvFileInput');
    // 🔥 FIX: this used to read id="csvUploadBtn" -- but the toolbar
    // "Import CSV" button up top had that exact same id. Duplicate IDs
    // aren't valid HTML, and getElementById() silently returns whichever
    // element comes first in the DOM (the toolbar button), so this
    // variable never actually pointed at the modal's submit button. Fixed
    // by giving the submit button its own id (csvImportSubmitBtn) in the
    // HTML, and now this reference is used below to disable it during
    // the import instead of sitting unused.
    const csvUploadBtn = document.getElementById('csvImportSubmitBtn');
    const csvDropZone = document.getElementById('csvDropZone');
    const csvFileNameDisplay = document.getElementById('csvFileName');
    const csvProgressContainer = document.getElementById('csvProgressContainer');
    const csvProgressBar = document.getElementById('csvProgressBar');
    const csvProgressText = document.getElementById('csvProgressText');
    const csvStatusContainer = document.getElementById('csvStatusContainer');
    const csvStatusText = document.getElementById('csvStatusText');

    // ============================================
    // 🔥 FIX: CSV DROP ZONE FUNCTIONALITY
    // This used to live in an inline <script> tag at the bottom of
    // index.html. Sub-module pages get their HTML injected via
    // `.innerHTML = html`, and browsers silently discard (never execute)
    // any <script> tags inserted that way -- app.js's own loadSubModule()
    // comments call this out explicitly. So none of this ever ran: the
    // "Click to select CSV file" zone did nothing, drag-and-drop did
    // nothing, and the hidden required file input could never be filled
    // in -- which is exactly what caused the browser's native validation
    // to block the form with "invalid form control ... not focusable"
    // when Import Products was clicked. Moved here, into the real script
    // file that app.js actually injects and executes.
    // ============================================
    if (csvDropZone && csvFileInput) {
        csvDropZone.addEventListener('click', () => csvFileInput.click());

        csvDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            csvDropZone.style.borderColor = '#2563eb';
            csvDropZone.style.background = '#f8fafc';
        });

        csvDropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            csvDropZone.style.borderColor = '#e2e8f0';
            csvDropZone.style.background = 'transparent';
        });

        csvDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            csvDropZone.style.borderColor = '#e2e8f0';
            csvDropZone.style.background = 'transparent';

            if (e.dataTransfer.files.length > 0) {
                csvFileInput.files = e.dataTransfer.files;
                const file = e.dataTransfer.files[0];
                csvFileNameDisplay.textContent = '📄 ' + file.name;
                csvFileNameDisplay.style.display = 'block';
                showToast('File selected: ' + file.name, 'success');
            }
        });

        csvFileInput.addEventListener('change', function () {
            if (this.files.length > 0) {
                const file = this.files[0];
                csvFileNameDisplay.textContent = '📄 ' + file.name;
                csvFileNameDisplay.style.display = 'block';
                showToast('File selected: ' + file.name, 'success');
            } else {
                csvFileNameDisplay.style.display = 'none';
            }
        });
    }

    // ============================================
    // 🔥 FIX: DOWNLOAD CSV TEMPLATE
    // Same root cause as above -- this was defined as window.downloadCSVTemplate
    // inside the dead inline <script>, so the "Download Template" button's
    // onclick="downloadCSVTemplate()" had nothing to call and silently failed.
    // ============================================
    window.downloadCSVTemplate = function () {
        const headers = [
            'product_name', 'sku', 'generic_name', 'category', 'sub_category',
            'dosage_form', 'brand', 'supplier', 'tax_percent', 'conversion_rate',
            'min_order_qty', 'nhima_price_fixed', 'wholesale_internal_percent',
            'wholesale_regular_percent', 'retail_online_percent', 'retail_regular_percent',
            'retail_staff_percent', 'opening_qty', 'batch_number', 'expiry_date',
            'cost_price', 'currency'
        ];

        const sampleRow = [
            'Paracetamol 500mg', 'PRD-0001', 'Paracetamol', 'Pharmaceuticals', 'Pain Relief',
            'Tablet', 'BrandX', 'SupplierCo', '16', '30',
            '10', '75.00', '25',
            '30', '35', '40',
            '20', '100', 'B-2026-001', '2027-12-31',
            '50.00', 'ZMW'
        ];

        let csv = headers.join(',') + '\n';
        csv += sampleRow.join(',') + '\n';

        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'product_import_template.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        showToast('Template downloaded successfully!', 'success');
    };

    // Open CSV Upload Modal
    if (csvBtn) {
        csvBtn.addEventListener('click', () => {
            if (csvModal) {
                csvModal.style.display = 'flex';
                csvFileInput.value = '';
                csvProgressContainer.style.display = 'none';
                csvStatusContainer.style.display = 'none';
                csvProgressBar.style.width = '0%';
                csvProgressText.textContent = '0%';
                document.getElementById('csvFileName').style.display = 'none';
            }
        });
    }

    // Close CSV Upload Modal
    if (csvCloseBtn) {
        csvCloseBtn.addEventListener('click', () => {
            csvModal.style.display = 'none';
        });
    }
    if (csvCancelBtn) {
        csvCancelBtn.addEventListener('click', () => {
            csvModal.style.display = 'none';
        });
    }
    if (csvModal) {
        csvModal.addEventListener('click', (e) => {
            if (e.target === csvModal) csvModal.style.display = 'none';
        });
    }

    // ============================================
    // 🔥 FIX: PROPER CSV FIELD PARSER
    // The import used to split each line on a bare `,` and then strip
    // every quote character from the result. That works only as long as
    // no field's own text ever contains a comma -- but real category
    // names do (e.g. "Vitamins, Supplements & Herbals - OTC - Solid"),
    // and a bare split() has no idea that comma is INSIDE a quoted
    // field, not a column separator. The result: that one field split
    // into two, and every column after it shifted over by one for the
    // rest of the row -- batch numbers landing in the expiry_date
    // column, prices landing in currency, etc. (exactly what caused
    // "invalid input syntax for type date: P-793": that's a batch
    // number, shifted into the expiry_date slot). This is a real
    // (minimal) CSV tokenizer instead: it tracks whether it's inside a
    // quoted field and only treats `,` as a separator outside quotes,
    // and unescapes doubled quotes ("" -> ") per the CSV spec -- so it
    // also stops stripping the inch-mark quotes out of instrument names
    // like Crile Forcep 5" Straight as a side effect.
    // ============================================
    function parseCSVLine(line) {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; }
                    else { inQuotes = false; }
                } else {
                    cur += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        result.push(cur);
        return result;
    }

    // ============================================
    // PROCESS CSV UPLOAD
    // ============================================
    document.getElementById('csvUploadForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const file = csvFileInput.files[0];
        if (!file) {
            showToast('Please select a CSV file', 'error');
            return;
        }

        try {
            // Disable the submit button for the duration of the import
            // so it can't be double-clicked mid-run.
            if (csvUploadBtn) {
                csvUploadBtn.disabled = true;
                csvUploadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
            }

            // Show progress
            csvProgressContainer.style.display = 'block';
            csvProgressBar.style.width = '10%';
            csvProgressText.textContent = '10%';
            csvStatusContainer.style.display = 'none';

            const text = await file.text();
            const lines = text.split('\n').filter(line => line.trim());
            
            if (lines.length < 2) {
                showToast('CSV file is empty or has no data rows', 'error');
                csvProgressContainer.style.display = 'none';
                return;
            }

            // Parse headers
            const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
            
            // Validate required columns
            const requiredColumns = ['product_name', 'cost_price'];
            const missingColumns = requiredColumns.filter(col => !headers.includes(col));
            if (missingColumns.length > 0) {
                showToast(`Missing required columns: ${missingColumns.join(', ')}`, 'error');
                csvProgressContainer.style.display = 'none';
                return;
            }

            // Parse data rows
            const products = [];
            const errors = [];
            
            for (let i = 1; i < lines.length; i++) {
                const values = parseCSVLine(lines[i]).map(v => v.trim());
                
                if (values.length < headers.length) {
                    errors.push(`Row ${i}: Missing columns`);
                    continue;
                }

                const product = {};
                headers.forEach((header, index) => {
                    product[header] = values[index] || '';
                });

                // 🔥 FIX: this is what was actually breaking the import.
                // Your template uses a literal "-" as the placeholder for
                // "doesn't apply" (e.g. surgical instruments have no batch
                // number or expiry date), but batches.expiry_date is a real
                // Postgres `date` column -- it rejects "-" outright
                // ("invalid input syntax for type date"). Every row with
                // batch_number/expiry_date set to "-" was failing at the
                // batch-insert step (the product itself got created, just
                // with no stock, and the row was reported as an error).
                // Treat a bare "-" the same as an empty value from here on,
                // so it falls through to the existing null/auto-generated
                // fallbacks below instead of being sent to Postgres as-is.
                if (product.batch_number === '-') product.batch_number = '';
                if (product.expiry_date === '-') product.expiry_date = '';

                // Validate required fields
                if (!product.product_name || !product.cost_price) {
                    errors.push(`Row ${i}: Missing product_name or cost_price`);
                    continue;
                }

                // Set defaults for optional fields
                product.conversion_rate = parseInt(product.conversion_rate) || 1;
                product.min_order_qty = parseInt(product.min_order_qty) || 1;
                product.tax_percent = parseFloat(product.tax_percent) || 0;
                product.nhima_price_fixed = parseFloat(product.nhima_price_fixed) || 0;
                product.wholesale_internal_percent = parseFloat(product.wholesale_internal_percent) || 0;
                product.wholesale_regular_percent = parseFloat(product.wholesale_regular_percent) || 0;
                product.retail_online_percent = parseFloat(product.retail_online_percent) || 0;
                product.retail_regular_percent = parseFloat(product.retail_regular_percent) || 0;
                product.retail_staff_percent = parseFloat(product.retail_staff_percent) || 0;
                product.opening_qty = parseInt(product.opening_qty) || 0;
                product.cost_price = parseFloat(product.cost_price) || 0;
                product.currency = product.currency || 'ZMW';
                
                products.push(product);
            }

            if (products.length === 0) {
                showToast('No valid products found in CSV', 'error');
                csvProgressContainer.style.display = 'none';
                return;
            }

            // Update progress
            csvProgressBar.style.width = '30%';
            csvProgressText.textContent = '30%';

            // Process products
            let successCount = 0;
            let errorCount = 0;
            const errorMessages = [];

            for (let i = 0; i < products.length; i++) {
                try {
                    const p = products[i];
                    
                    // Look up or create related records
                    const genericId = await findOrCreate('generic_names', p.generic_name);
                    const categoryId = await findOrCreate('categories', p.category);
                    const subCategoryId = await findOrCreateSubCategory(p.sub_category, categoryId);
                    const dosageFormId = await findOrCreate('dosage_forms', p.dosage_form);
                    const brandId = await findOrCreate('brands', p.brand);
                    const supplierId = await findOrCreate('suppliers', p.supplier);

                    // Generate SKU if not provided.
                    // 🔥 FIX: a plain random 4-digit number (0000-9999)
                    // collides constantly on a batch of this size -- with
                    // ~90 rows each drawing independently from only 10,000
                    // possibilities, a duplicate is likely (birthday
                    // paradox), and products.sku has a UNIQUE constraint,
                    // so the insert for whichever row lost the coin flip
                    // failed outright with "duplicate key value violates
                    // unique constraint products_sku_key" -- that product
                    // never got created at all. Combining the millisecond
                    // timestamp with this row's own loop index guarantees
                    // no two rows in the same import can ever collide with
                    // each other, and makes a collision with any
                    // previously-imported SKU astronomically unlikely.
                    const sku = p.sku || `PRD-${Date.now().toString(36).toUpperCase()}${i}`;

                    // Convert cost price to ZMW
                    let costInZMW = p.cost_price;
                    if (p.currency !== 'ZMW' && p.currency === 'USD') {
                        // If USD, use exchange rate from form or default.
                        // 🔥 Set to 20.00 ZMW/USD per instruction -- there's
                        // no stored rate in exchange_rates yet, so this is
                        // the fallback used for every USD-priced CSV row's
                        // opening-stock accounting entry.
                        const rate = 20.00;
                        costInZMW = p.cost_price * rate;
                    }

                    // 🔥 FIX: the same product commonly appears on more than
                    // one CSV row -- one row per delivery/batch (e.g. three
                    // rows for "Ahabir 500Mg 60S Tablet", each with its own
                    // batch_number/expiry_date/opening_qty). This used to
                    // unconditionally INSERT a brand-new product for every
                    // row, so that single product ended up duplicated three
                    // times in Product Master (with its stock split across
                    // the duplicates) instead of one product with three
                    // batches. Look up an existing product by name first --
                    // same case-insensitive exact-match pattern findOrCreate()
                    // already uses below -- and reuse it if found.
                    const { data: existingProductRows, error: existingProductError } = await supabaseClient
                        .from('products')
                        .select('id')
                        .ilike('product_name', p.product_name.trim())
                        .limit(1);

                    if (existingProductError) throw existingProductError;

                    let productId;
                    if (existingProductRows && existingProductRows.length > 0) {
                        productId = existingProductRows[0].id;
                    } else {
                        // Create product
                        const { data: productData, error: productError } = await supabaseClient
                            .from('products')
                            .insert([{
                                sku: sku,
                                product_name: p.product_name,
                                generic_name_id: genericId,
                                category_id: categoryId,
                                sub_category_id: subCategoryId,
                                dosage_form_id: dosageFormId,
                                brand_id: brandId,
                                supplier_id: supplierId,
                                tax_percent: p.tax_percent,
                                conversion_rate: p.conversion_rate,
                                min_order_qty: p.min_order_qty,
                                nhima_price_fixed: p.nhima_price_fixed,
                                wholesale_internal_percent: p.wholesale_internal_percent,
                                wholesale_regular_percent: p.wholesale_regular_percent,
                                retail_online_percent: p.retail_online_percent,
                                retail_regular_percent: p.retail_regular_percent,
                                retail_staff_percent: p.retail_staff_percent,
                            }])
                            .select();

                        if (productError) throw productError;
                        productId = productData[0].id;
                    }

                    // Create batch if opening quantity > 0
                    if (p.opening_qty > 0) {
                        const totalCost = costInZMW * p.opening_qty;

                        // Create batch
                        // 🔥 FIX: same missing opening_qty bug as the
                        // single Add Product path.
                        const { error: batchError } = await supabaseClient
                            .from('batches')
                            .insert([{
                                product_id: productId,
                                batch_number: p.batch_number || `B-${new Date().toISOString().split('T')[0]}`,
                                expiry_date: p.expiry_date || null,
                                cost_price: costInZMW,
                                total_qty: p.opening_qty,
                                opening_qty: p.opening_qty,
                            }]);

                        if (batchError) throw batchError;

                        // Create journal entry
                        await createAccountingEntry(productId, p.product_name, totalCost, costInZMW);
                    }

                    successCount++;
                    
                    // Update progress
                    const progress = 30 + ((i + 1) / products.length) * 60;
                    csvProgressBar.style.width = `${progress}%`;
                    csvProgressText.textContent = `${Math.round(progress)}%`;

                } catch (error) {
                    errorCount++;
                    errorMessages.push(`Row ${i + 2}: ${error.message}`);
                    console.error(`Error importing product:`, error);
                }
            }

            // Show final status
            csvProgressBar.style.width = '100%';
            csvProgressText.textContent = '100%';
            csvStatusContainer.style.display = 'block';

            const statusMessage = `
✅ Import Complete!
Success: ${successCount} products
Errors: ${errorCount} products
${errorMessages.length > 0 ? '\n\nErrors:\n' + errorMessages.slice(0, 5).join('\n') : ''}
${errorMessages.length > 5 ? `\n... and ${errorMessages.length - 5} more errors` : ''}
            `;
            csvStatusText.textContent = statusMessage;

            showToast(`Imported ${successCount} products successfully!`, 'success');
            await loadProducts();

        } catch (error) {
            console.error('Error processing CSV:', error);
            showToast('Error processing CSV: ' + error.message, 'error');
            csvProgressContainer.style.display = 'none';
        } finally {
            // Runs on every exit path -- success, the early validation
            // returns above (empty file, missing columns, no valid rows),
            // and the catch block -- so the button never gets stuck
            // showing "Importing...".
            if (csvUploadBtn) {
                csvUploadBtn.disabled = false;
                csvUploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Import Products';
            }
        }
    });

    // ============================================
    // HELPER FUNCTIONS FOR CSV IMPORT
    // ============================================

    async function findOrCreate(table, name) {
        if (!name || name.trim() === '') return null;

        const { data: existing, error: findError } = await supabaseClient
            .from(table)
            .select('id')
            .ilike('name', name.trim())
            .maybeSingle();

        if (findError) throw findError;

        if (existing) return existing.id;

        const { data: created, error: createError } = await supabaseClient
            .from(table)
            .insert([{ name: name.trim() }])
            .select();

        if (createError) throw createError;

        return created[0].id;
    }

    async function findOrCreateSubCategory(name, categoryId) {
        if (!name || name.trim() === '' || !categoryId) return null;

        const { data: existing, error: findError } = await supabaseClient
            .from('sub_categories')
            .select('id')
            .eq('category_id', categoryId)
            .ilike('name', name.trim())
            .maybeSingle();

        if (findError) throw findError;

        if (existing) return existing.id;

        const { data: created, error: createError } = await supabaseClient
            .from('sub_categories')
            .insert([{ 
                name: name.trim(),
                category_id: categoryId
            }])
            .select();

        if (createError) throw createError;

        return created[0].id;
    }

    async function createAccountingEntry(productId, productName, totalCost, costPerUnit) {
        try {
            let inventoryAccount = accountCache.inventory || '1400';
            let equityAccount = accountCache.opening_balance_equity || '3000';

            // Ensure accounts exist
            const { count: invCount } = await supabaseClient
                .from('chart_of_accounts')
                .select('*', { count: 'exact', head: true })
                .eq('code', inventoryAccount);
            
            if (invCount === 0) {
                await supabaseClient.from('chart_of_accounts').insert([{ 
                    code: inventoryAccount, 
                    name: 'Inventory', 
                    type: 'Asset', 
                    normal_balance: 'Debit' 
                }]);
            }

            const { count: eqCount } = await supabaseClient
                .from('chart_of_accounts')
                .select('*', { count: 'exact', head: true })
                .eq('code', equityAccount);

            if (eqCount === 0) {
                await supabaseClient.from('chart_of_accounts').insert([{ 
                    code: equityAccount, 
                    name: 'Opening Balance Equity', 
                    type: 'Equity', 
                    normal_balance: 'Credit' 
                }]);
            }

            // Create journal entry
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `CSV-${productId.substring(0, 8)}`,
                description: `Opening stock from CSV import: ${productName}`,
                journal_number: `CSV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();

            if (jError) throw jError;

            // Create journal lines
            const lines = [
                {
                    journal_entry_id: journalData[0].id,
                    account_code: inventoryAccount,
                    description: `Opening stock: ${productName}`,
                    debit: totalCost,
                    credit: 0
                },
                {
                    journal_entry_id: journalData[0].id,
                    account_code: equityAccount,
                    description: `Equity for opening stock: ${productName}`,
                    debit: 0,
                    credit: totalCost
                }
            ];

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(lines);

            if (lineError) throw lineError;

            console.log(`✅ Accounting entry created for ${productName}`);

        } catch (error) {
            console.error('Error creating accounting entry:', error);
            throw error;
        }
    }

    // ============================================
    // RESET FORM FUNCTION
    // ============================================
    // 🔥 FIX (issue #1): previously relied almost entirely on native
    // form.reset(), with only a few fields explicitly cleared by hand.
    // Any field that isn't a standard form-associated control -- or sits
    // outside the <form id="addProductForm"> tag in the HTML -- is
    // silently skipped by .reset(), so the form appeared to "not empty"
    // after saving. Now every field is explicitly cleared by ID, so this
    // no longer depends on the exact DOM structure being right.
    function resetFormFields() {
        const form = document.getElementById('addProductForm');
        if (form) form.reset();

        hiddenId.value = '';
        document.getElementById('sku').value = 'PRD-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        document.getElementById('productName').value = '';
        document.getElementById('genericName').value = '';
        document.getElementById('category').value = '';
        document.getElementById('subCategory').innerHTML = `<option value="">Select Sub-Category</option>`;
        document.getElementById('dosageForm').value = '';
        document.getElementById('brand').value = '';
        document.getElementById('supplier').value = '';
        document.getElementById('tax').value = 0;
        document.getElementById('packSize').value = 1;
        document.getElementById('minOrderQty').value = 1;
        document.getElementById('nhimaPrice').value = 0;
        document.getElementById('wholesaleInternalPercent').value = 0;
        document.getElementById('wholesaleRegularPercent').value = 0;
        document.getElementById('retailOnlinePercent').value = 0;
        document.getElementById('retailRegularPercent').value = 0;
        document.getElementById('retailStaffPercent').value = 0;
        document.getElementById('openingQty').value = 0;
        document.getElementById('openingBatchNo').value = '';
        document.getElementById('openingExpiry').value = '';
        document.getElementById('openingCostPrice').value = '';
        document.getElementById('openingCostPriceFinal').value = '';
        document.getElementById('costZMWDisplay').textContent = '0.00';
        document.getElementById('batchCurrency').value = 'ZMW';
        document.getElementById('batchExchangeRate').value = '';
        document.getElementById('batchExchangeRate').style.display = 'none';
        batchDetailsSection.style.display = 'none';
        document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-box-open" style="color: #2563eb;"></i> Add New Product';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Product';
        batchSectionContainer.style.display = 'block';
    }

    // ============================================
    // CUSTOM CONFIRM MODAL
    // ============================================
    // 🔥 FIX (issue #2): this used to show generic OK/Cancel buttons where
    // "OK" (which reads like a plain acknowledgment) actually triggered
    // "add another product", and "Cancel" (which reads like "undo/discard")
    // actually triggered "close normally" -- backwards from what the
    // labels implied. Now the buttons say exactly what they do:
    // "Add Another" (clears the form for a fresh entry) and "Close".
    function showCustomConfirm(title, message, onAddAnother, onClose) {
        const existing = document.getElementById('customConfirmModal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'customConfirmModal';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px);
            z-index: 9999; display: flex; justify-content: center; align-items: center;
            animation: modalFadeIn 0.25s ease;
        `;

        overlay.innerHTML = `
            <div style="background: white; padding: 30px; border-radius: 12px; width: 90%; max-width: 420px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); text-align: center;">
                <div style="margin-bottom: 16px;">
                    <i class="fa-solid fa-circle-check" style="font-size: 3rem; color: #22c55e;"></i>
                </div>
                <h3 style="margin: 0 0 8px 0; color: #0f172a; font-size: 1.2rem;">${title}</h3>
                <p style="color: #64748b; margin-bottom: 20px;">${message}</p>
                <div style="display: flex; gap: 10px; justify-content: center;">
                    <button id="confirmAddAnotherBtn" style="background: #2563eb; color: white; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer; font-size: 0.9rem;">
                        <i class="fa-solid fa-plus"></i> Add Another
                    </button>
                    <button id="confirmCloseBtn" style="background: #f1f5f9; border: 1px solid #e2e8f0; padding: 10px 30px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; color: #475569;">
                        Close
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('confirmAddAnotherBtn').addEventListener('click', () => {
            overlay.remove();
            if (onAddAnother) onAddAnother();
        });

        document.getElementById('confirmCloseBtn').addEventListener('click', () => {
            overlay.remove();
            if (onClose) onClose();
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                if (onClose) onClose();
            }
        });
    }

    // ============================================
    // MODAL LOGIC
    // ============================================
    const openModal = (iconHtml, titleText, btnText, showBatchSection) => {
        modal.style.display = 'flex';
        modalTitle.innerHTML = `${iconHtml} ${titleText}`;
        submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${btnText}`;
        
        if (showBatchSection) {
            batchSectionContainer.style.display = 'block';
        } else {
            batchSectionContainer.style.display = 'none';
            batchDetailsSection.style.display = 'none';
            document.getElementById('openingCostPrice').removeAttribute('required');
            document.getElementById('openingBatchNo').removeAttribute('required');
            document.getElementById('openingExpiry').removeAttribute('required');
        }
    };

    const closeModal = () => {
        modal.style.display = 'none';
        resetFormFields();
    };

    if (openBtn && modal) {
        openBtn.addEventListener('click', () => {
            resetFormFields();
            setTimeout(() => {
                openModal('<i class="fa-solid fa-box-open" style="color: #2563eb;"></i>', 'Add New Product', 'Save Product', true);
            }, 50);
        });

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    // ============================================
    // BATCH DETAILS LOGIC
    // ============================================
    const openingQty = document.getElementById('openingQty');
    
    const checkBatchFields = () => {
        const qty = parseInt(openingQty.value) || 0;
        
        if (qty > 0) {
            batchDetailsSection.style.display = 'block';
            document.getElementById('openingCostPrice').setAttribute('required', '');
            document.getElementById('openingBatchNo').setAttribute('required', '');
            document.getElementById('openingExpiry').setAttribute('required', '');
        } else {
            batchDetailsSection.style.display = 'none';
            document.getElementById('openingCostPrice').removeAttribute('required');
            document.getElementById('openingBatchNo').removeAttribute('required');
            document.getElementById('openingExpiry').removeAttribute('required');
        }
    };

    openingQty.addEventListener('input', checkBatchFields);

    // ============================================
    // CURRENCY CONVERTER
    // ============================================
    const batchCurrency = document.getElementById('batchCurrency');
    const batchExchangeRate = document.getElementById('batchExchangeRate');
    const openingCostPrice = document.getElementById('openingCostPrice');
    const costZMWDisplay = document.getElementById('costZMWDisplay');
    const openingCostPriceFinal = document.getElementById('openingCostPriceFinal');

    const updateBatchCost = () => {
        const currency = batchCurrency.value;
        const cost = parseFloat(openingCostPrice.value) || 0;
        
        if (currency === 'ZMW') {
            batchExchangeRate.style.display = 'none';
            batchExchangeRate.value = '';
            costZMWDisplay.textContent = cost.toFixed(2);
            openingCostPriceFinal.value = cost.toFixed(2);
        } else {
            batchExchangeRate.style.display = 'block';
            // 🔒 LOCKED: field is read-only now -- always today's shared
            // exchange rate from the Dashboard, never a typed-in value.
            // Prevents a typo'd rate from corrupting this batch's cost
            // price (the same bug class that hit a Furosemide purchase).
            batchExchangeRate.value = sharedZmwPerUsd;
            const rate = sharedZmwPerUsd || 0;
            if (rate > 0) {
                const converted = cost * rate;
                costZMWDisplay.textContent = converted.toFixed(2);
                openingCostPriceFinal.value = converted.toFixed(2);
            } else {
                costZMWDisplay.textContent = 'Enter Rate';
                openingCostPriceFinal.value = '';
            }
        }
    };

    batchCurrency.addEventListener('change', updateBatchCost);
    openingCostPrice.addEventListener('input', updateBatchCost);
    batchExchangeRate.addEventListener('input', updateBatchCost);

    // ============================================
    // EDIT PRODUCT LOGIC
    // ============================================
    window.editProduct = async function(productId) {
        try {
            console.log("Editing product:", productId);
            
            const { data: product, error } = await supabaseClient
                .from('products')
                .select('*')
                .eq('id', productId)
                .single();

            if (error) throw error;
            
            console.log("Product data loaded:", product);

            resetFormFields();
            
            setTimeout(() => {
                openModal('<i class="fa-solid fa-pen-to-square" style="color: #2563eb;"></i>', 'Edit Product', 'Update Product', false);
            }, 100);
            
            hiddenId.value = product.id;
            
            document.getElementById('sku').value = product.sku || '';
            document.getElementById('productName').value = product.product_name || '';
            document.getElementById('tax').value = product.tax_percent || 0;
            document.getElementById('packSize').value = product.conversion_rate || 1;
            document.getElementById('minOrderQty').value = product.min_order_qty || 1;
            document.getElementById('wholesaleInternalPercent').value = product.wholesale_internal_percent || 0;
            document.getElementById('wholesaleRegularPercent').value = product.wholesale_regular_percent || 0;
            document.getElementById('retailOnlinePercent').value = product.retail_online_percent || 0;
            document.getElementById('retailRegularPercent').value = product.retail_regular_percent || 0;
            document.getElementById('retailStaffPercent').value = product.retail_staff_percent || 0;
            document.getElementById('nhimaPrice').value = product.nhima_price_fixed || 0;
            
            await loadDropdowns();
            
            setTimeout(() => {
                if (product.generic_name_id) {
                    document.getElementById('genericName').value = product.generic_name_id;
                }
                if (product.dosage_form_id) {
                    document.getElementById('dosageForm').value = product.dosage_form_id;
                }
                if (product.brand_id) {
                    document.getElementById('brand').value = product.brand_id;
                }
                if (product.supplier_id) {
                    document.getElementById('supplier').value = product.supplier_id;
                }
                
                if (product.category_id) {
                    document.getElementById('category').value = product.category_id;
                    
                    const catId = product.category_id;
                    (async function loadSubs() {
                        const { data: subs } = await supabaseClient
                            .from('sub_categories')
                            .select('id, name')
                            .eq('category_id', catId);
                        
                        const subSelect = document.getElementById('subCategory');
                        subSelect.innerHTML = `<option value="">Select Sub-Category</option>` + 
                            (subs || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
                        
                        if (product.sub_category_id) {
                            subSelect.value = product.sub_category_id;
                        }
                    })();
                }
            }, 300);
            
        } catch (error) {
            console.error("Error loading product data:", error);
            showToast('Error loading product data: ' + error.message, 'error');
        }
    };

    // ============================================
    // SUBMIT FORM
    // ============================================
    document.getElementById('addProductForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        const isEditing = hiddenId.value !== '';
        const formData = {
            sku: document.getElementById('sku').value,
            // 🔥 ADDED: auto-corrects a pure ALL-CAPS entry to Proper Case
            // on save -- see toProperCaseIfAllCaps() above.
            product_name: toProperCaseIfAllCaps(document.getElementById('productName').value),
            generic_name_id: document.getElementById('genericName').value || null,
            category_id: document.getElementById('category').value || null,
            sub_category_id: document.getElementById('subCategory').value || null,
            dosage_form_id: document.getElementById('dosageForm').value || null,
            brand_id: document.getElementById('brand').value || null,
            supplier_id: document.getElementById('supplier').value || null,
            tax: parseFloat(document.getElementById('tax').value) || 0,
            conversion_rate: parseInt(document.getElementById('packSize').value) || 1,
            min_order_qty: parseInt(document.getElementById('minOrderQty').value) || 1,
            nhima_price: parseFloat(document.getElementById('nhimaPrice').value) || 0,
            wholesale_internal_percent: parseFloat(document.getElementById('wholesaleInternalPercent').value) || 0,
            wholesale_regular_percent: parseFloat(document.getElementById('wholesaleRegularPercent').value) || 0,
            retail_online_percent: parseFloat(document.getElementById('retailOnlinePercent').value) || 0,
            retail_regular_percent: parseFloat(document.getElementById('retailRegularPercent').value) || 0,
            retail_staff_percent: parseFloat(document.getElementById('retailStaffPercent').value) || 0,
            opening_qty: parseInt(document.getElementById('openingQty').value) || 0,
            batch_no: document.getElementById('openingBatchNo').value || null,
            expiry: document.getElementById('openingExpiry').value || null,
            batch_cost: parseFloat(document.getElementById('openingCostPriceFinal').value) || 0,
        };

        try {
            let result;
            if (isEditing) {
                const { data, error } = await supabaseClient
                    .from('products')
                    .update({
                        sku: formData.sku,
                        product_name: formData.product_name,
                        generic_name_id: formData.generic_name_id,
                        category_id: formData.category_id,
                        sub_category_id: formData.sub_category_id,
                        dosage_form_id: formData.dosage_form_id,
                        brand_id: formData.brand_id,
                        supplier_id: formData.supplier_id,
                        tax_percent: formData.tax,
                        conversion_rate: formData.conversion_rate,
                        min_order_qty: formData.min_order_qty,
                        nhima_price_fixed: formData.nhima_price,
                        wholesale_internal_percent: formData.wholesale_internal_percent,
                        wholesale_regular_percent: formData.wholesale_regular_percent,
                        retail_online_percent: formData.retail_online_percent,
                        retail_regular_percent: formData.retail_regular_percent,
                        retail_staff_percent: formData.retail_staff_percent,
                    })
                    .eq('id', hiddenId.value)
                    .select();

                if (error) throw error;
                result = data;
                showToast('Product updated successfully!', 'success');
            } else {
                const { data, error } = await supabaseClient
                    .from('products')
                    .insert([{
                        sku: formData.sku,
                        product_name: formData.product_name,
                        generic_name_id: formData.generic_name_id,
                        category_id: formData.category_id,
                        sub_category_id: formData.sub_category_id,
                        dosage_form_id: formData.dosage_form_id,
                        brand_id: formData.brand_id,
                        supplier_id: formData.supplier_id,
                        tax_percent: formData.tax,
                        conversion_rate: formData.conversion_rate,
                        min_order_qty: formData.min_order_qty,
                        nhima_price_fixed: formData.nhima_price,
                        wholesale_internal_percent: formData.wholesale_internal_percent,
                        wholesale_regular_percent: formData.wholesale_regular_percent,
                        retail_online_percent: formData.retail_online_percent,
                        retail_regular_percent: formData.retail_regular_percent,
                        retail_staff_percent: formData.retail_staff_percent,
                    }])
                    .select();

                if (error) throw error;
                result = data;

                // ==========================================
                // CREATE BATCH AND ACCOUNTING ENTRY
                // ==========================================
                let accountingFailed = false;
                if (formData.opening_qty > 0 && result && result.length > 0) {
                    const productId = result[0].id;
                    const totalCost = formData.batch_cost * formData.opening_qty;

                    // 1. Insert the Batch
                    // 🔥 FIX: opening_qty was never written here, only
                    // total_qty. total_qty changes with every future sale,
                    // stock take, or other movement -- opening_qty is
                    // meant to be a frozen snapshot of what this batch
                    // started with. Without it, the Stock Movement report
                    // falls back to reading total_qty's CURRENT value and
                    // reporting it as "Opening Stock", which silently goes
                    // wrong the moment anything touches this batch after
                    // creation (exactly what caused products with sales/
                    // stock takes to stop reconciling, while untouched
                    // products coincidentally still looked correct).
                    const { error: batchError } = await supabaseClient.from('batches').insert([{
                        product_id: productId,
                        batch_number: formData.batch_no || `B-${new Date().toISOString().split('T')[0]}`,
                        expiry_date: formData.expiry,
                        cost_price: formData.batch_cost,
                        total_qty: formData.opening_qty,
                        opening_qty: formData.opening_qty,
                    }]);
                    if (batchError) throw batchError;

                    // 🔥 FIX: steps 2-4 (chart-of-accounts checks + journal
                    // entry + journal lines) used to share the outer
                    // try/catch with the product/batch insert above. That
                    // meant a failure here (most commonly the same expired-
                    // session RLS error seen elsewhere in this app) threw
                    // all the way up to the generic "Error saving product"
                    // toast -- even though the product AND batch had
                    // already saved successfully. The confusing message
                    // made it look like nothing saved, which invited a
                    // retry with the same manually-typed SKU and a second,
                    // unrelated "duplicate key" error. Isolating this in
                    // its own try/catch lets the product/batch save be
                    // reported as the success it is, with a clear separate
                    // warning if only the accounting entry failed.
                    try {
                    // ==========================================
                    // 2. ENSURE COA ACCOUNTS EXIST
                    // ==========================================
                    let inventoryAccount = accountCache.inventory || '1400';
                    let equityAccount = accountCache.opening_balance_equity || '3000';

                    const { count: invCount } = await supabaseClient
                        .from('chart_of_accounts')
                        .select('*', { count: 'exact', head: true })
                        .eq('code', inventoryAccount);
                    
                    if (invCount === 0) {
                        console.log(`⚠️ Account ${inventoryAccount} not found. Creating it...`);
                        const { error: invCreateErr } = await supabaseClient
                            .from('chart_of_accounts')
                            .insert([{ 
                                code: inventoryAccount, 
                                name: 'Inventory', 
                                type: 'Asset', 
                                normal_balance: 'Debit' 
                            }]);
                        if (invCreateErr) console.warn("Could not auto-create Inventory account:", invCreateErr);
                    }

                    const { count: eqCount } = await supabaseClient
                        .from('chart_of_accounts')
                        .select('*', { count: 'exact', head: true })
                        .eq('code', equityAccount);

                    if (eqCount === 0) {
                        console.log(`⚠️ Account ${equityAccount} not found. Creating it...`);
                        const { error: eqCreateErr } = await supabaseClient
                            .from('chart_of_accounts')
                            .insert([{ 
                                code: equityAccount, 
                                name: 'Opening Balance Equity', 
                                type: 'Equity', 
                                normal_balance: 'Credit' 
                            }]);
                        if (eqCreateErr) console.warn("Could not auto-create Equity account:", eqCreateErr);
                    }

                    await loadAccountCodes();
                    
                    // ==========================================
                    // 3. Create the Opening Balance Journal Entry
                    // ==========================================
                    const journal = {
                        entry_date: new Date().toISOString().split('T')[0],
                        reference: `OPEN-${productId.substring(0, 8)}`,
                        description: `Opening stock for ${formData.product_name}`,
                        journal_number: `OPN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                        status: 'Posted',
                        created_at: new Date().toISOString()
                    };

                    const { data: journalData, error: jError } = await supabaseClient
                        .from('journal_entries')
                        .insert([journal])
                        .select();
                    if (jError) throw jError;

                    // ==========================================
                    // 4. Create Journal Lines
                    // ==========================================
                    const finalInventoryAccount = accountCache.inventory || '1400';
                    const finalEquityAccount = accountCache.opening_balance_equity || '3000';

                    const lines = [
                        {
                            journal_entry_id: journalData[0].id,
                            account_code: finalInventoryAccount,
                            description: `Opening stock: ${formData.product_name}`,
                            debit: totalCost,
                            credit: 0
                        },
                        {
                            journal_entry_id: journalData[0].id,
                            account_code: finalEquityAccount,
                            description: `Equity for opening stock: ${formData.product_name}`,
                            debit: 0,
                            credit: totalCost
                        }
                    ];

                    const { error: lineError } = await supabaseClient
                        .from('journal_lines')
                        .insert(lines);
                    if (lineError) throw lineError;

                    console.log(`✅ Opening inventory entry created for ${formData.product_name}`);
                    console.log(`   Inventory Account: ${finalInventoryAccount}`);
                    console.log(`   Equity Account: ${finalEquityAccount}`);
                    console.log(`   Total Cost: K${totalCost.toFixed(2)}`);
                    } catch (acctError) {
                        console.error('Accounting entry error (product and batch already saved):', acctError);
                        accountingFailed = true;
                    }
                }
                // ==========================================

                showToast('Product saved successfully!', 'success');

                if (accountingFailed) {
                    alert(
                        '⚠️ Product and opening stock saved, but the accounting entry FAILED to post.\n\n' +
                        `"${formData.product_name}" and its batch are saved, ` +
                        'but no journal entry was created for the opening stock value ' +
                        '(often caused by an expired login session -- try logging out and back in).\n\n' +
                        'Please tell an admin/accountant so the journal entry can be posted manually. ' +
                        'Do NOT re-enter this product -- it has already been saved.'
                    );
                }
            }

            submitBtn.innerHTML = `<i class="fa-solid fa-check"></i> Saved!`;

            const successMessage = isEditing ? "Product updated successfully!" : "Product saved successfully!";
            const subMessage = isEditing ? "Would you like to edit another product?" : "Would you like to add another product?";

            showCustomConfirm(
                successMessage,
                subMessage,
                () => {
                    resetFormFields();
                    loadProducts();
                    setTimeout(() => {
                        openModal('<i class="fa-solid fa-box-open" style="color: #2563eb;"></i>', 'Add New Product', 'Save Product', true);
                    }, 100);
                },
                () => {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Product`;
                    closeModal();
                    loadProducts();
                }
            );

        } catch (error) {
            console.error("Error saving product:", error);
            showToast('Error saving product: ' + error.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Product`;
        }
    });

    // ============================================
    // QUICK ADD FUNCTIONS (Moved inside)
    // ============================================
    window.openQuickAdd = function(type) {
        const existing = document.querySelector('#quickAddOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'quickAddOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); display: flex; justify-content: center;
            align-items: center; z-index: 2000;
        `;
        
        let extraField = '';
        let placeholder = `Enter ${type} name`;
        let title = `Add New ${type.charAt(0).toUpperCase() + type.slice(1)}`;
        
        if (type === 'category') {
            extraField = `
                <div style="margin-top: 10px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 5px;">Location</label>
                    <input type="text" id="quickAddLocation" placeholder="e.g. Shelf A-1" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                </div>
            `;
        }
        
        if (type === 'subcategory') {
            title = 'Add New Sub-Category';
            placeholder = 'Enter Sub-Category name';
            const catId = document.getElementById('category').value;
            const catName = document.getElementById('category').options[document.getElementById('category').selectedIndex]?.text || 'Category';
            // 🔥 FIX (issue #3): Location box was missing here entirely --
            // only the Category quick-add had one. Added the same field.
            extraField = `
                <div style="margin-top: 10px; padding: 8px 12px; background: #f1f5f9; border-radius: 4px; color: #475569; font-size: 0.9rem;">
                    <strong>Parent Category:</strong> ${catName || 'Please select a category first'}
                </div>
                <div style="margin-top: 10px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 5px;">Location</label>
                    <input type="text" id="quickAddLocation" placeholder="e.g. Shelf A-1" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                </div>
            `;
        }

        // 🔥 FIX (issue #4): supplier quick-add used to be the same bare
        // single-name-field form as Brand/Generic/Dosage. Now matches the
        // Purchase module's Add Supplier modal exactly -- same fields,
        // same Opening Balance (USD/ZMW) handling -- so a supplier added
        // from either screen behaves identically.
        if (type === 'supplier') {
            title = 'Add Supplier';
            overlay.innerHTML = `
                <div style="background: white; padding: 25px; border-radius: 10px; width: 90%; max-width: 480px; max-height: 90vh; overflow-y: auto; position: relative;">
                    <h3 style="margin: 0 0 15px 0; color: #0f172a;">${title}</h3>
                    <div style="margin-bottom: 12px;">
                        <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Supplier Name *</label>
                        <input type="text" id="quickAddInput" placeholder="Supplier name" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">TPIN Number</label>
                            <input type="text" id="supplierTpin" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">ZAMRA Number</label>
                            <input type="text" id="supplierZamra" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Contact Person</label>
                            <input type="text" id="supplierContact" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Mobile Number *</label>
                            <input type="text" id="supplierPhone" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                    </div>
                    <div style="margin-bottom: 12px;">
                        <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Email Address</label>
                        <input type="email" id="supplierEmail" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                    </div>
                    <div style="margin-bottom: 12px;">
                        <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Address</label>
                        <input type="text" id="supplierAddress" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                    </div>

                    <div style="background: #fff7ed; border-left: 4px solid #f97316; padding: 8px 10px; border-radius: 6px; margin: 14px 0 10px;">
                        <strong style="font-size: 0.8rem; color: #9a3412;">Opening Payable (optional -- either or both)</strong>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Opening Payable (USD)</label>
                            <input type="number" step="0.01" min="0" id="supplierOpeningUsd" value="0" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                        <div><label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Opening Payable (ZMW)</label>
                            <input type="number" step="0.01" min="0" id="supplierOpeningZmw" value="0" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
                    </div>
                    <div id="supplierOpeningRateGroup" style="display: none; margin-bottom: 12px;">
                        <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Exchange Rate (USD → ZMW)</label>
                        <input type="number" step="0.0001" min="0" id="supplierOpeningRate" value="25.00" style="width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px;">
                    </div>

                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
                        <button onclick="closeQuickAdd()" style="padding: 8px 20px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer;">Cancel</button>
                        <button onclick="saveQuickAdd('supplier')" style="padding: 8px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                            <i class="fa-solid fa-floppy-disk"></i> Save Supplier
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            document.getElementById('supplierOpeningUsd').addEventListener('input', function () {
                document.getElementById('supplierOpeningRateGroup').style.display = parseFloat(this.value) > 0 ? 'block' : 'none';
            });
            setTimeout(() => {
                const input = document.getElementById('quickAddInput');
                if (input) input.focus();
            }, 100);
            return;
        }

        overlay.innerHTML = `
            <div style="background: white; padding: 25px; border-radius: 10px; width: 90%; max-width: 400px; position: relative;">
                <h3 style="margin: 0 0 15px 0; color: #0f172a;">${title}</h3>
                <input type="text" id="quickAddInput" placeholder="${placeholder}" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 10px;">
                ${extraField}
                <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
                    <button onclick="closeQuickAdd()" style="padding: 8px 20px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer;">Cancel</button>
                    <button onclick="saveQuickAdd('${type}')" style="padding: 8px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            const input = document.getElementById('quickAddInput');
            if (input) input.focus();
        }, 100);
    };

    window.closeQuickAdd = function() {
        const overlay = document.querySelector('#quickAddOverlay');
        if (overlay) overlay.remove();
    };

    window.saveQuickAdd = async function(type) {
        // 🔥 FIX (issue #4): supplier now has its own dedicated save path
        // with all the extra fields and opening-payable GL posting,
        // matching Purchase's Add Supplier modal exactly.
        if (type === 'supplier') {
            const name = document.getElementById('quickAddInput').value.trim();
            const phone = document.getElementById('supplierPhone').value.trim();
            if (!name) { showToast('Supplier Name is required.', 'error'); return; }
            if (!phone) { showToast('Mobile Number is required.', 'error'); return; }

            const openingUsd = parseFloat(document.getElementById('supplierOpeningUsd').value) || 0;
            const openingZmw = parseFloat(document.getElementById('supplierOpeningZmw').value) || 0;
            const openingRate = parseFloat(document.getElementById('supplierOpeningRate').value) || 25.00;

            try {
                const record = {
                    name,
                    tpin_number: document.getElementById('supplierTpin').value.trim() || null,
                    zamra_number: document.getElementById('supplierZamra').value.trim() || null,
                    contact_person: document.getElementById('supplierContact').value.trim() || null,
                    phone,
                    email: document.getElementById('supplierEmail').value.trim() || null,
                    address: document.getElementById('supplierAddress').value.trim() || null,
                    opening_balance_usd: openingUsd,
                    opening_balance_zmw: openingZmw,
                    created_at: new Date().toISOString()
                };

                const { data, error } = await supabaseClient.from('suppliers').insert([record]).select();
                if (error) throw error;

                const newSupplier = data[0];

                // Opening payable GL posting -- Debit Opening Balance
                // Equity, Credit Accounts Payable -- same pattern as
                // Purchase's createOpeningPayableGLEntry, posted per
                // currency since the ledger tracks Accounts Payable in ZMW.
                if (openingUsd > 0) {
                    await createSupplierOpeningPayableGLEntry(newSupplier.id, name, openingUsd * openingRate, `USD ${openingUsd.toFixed(2)} @ ${openingRate}`);
                }
                if (openingZmw > 0) {
                    await createSupplierOpeningPayableGLEntry(newSupplier.id, name, openingZmw, `ZMW ${openingZmw.toFixed(2)}`);
                }

                closeQuickAdd();
                await loadDropdowns();

                const selectEl = document.getElementById('supplier');
                if (selectEl) selectEl.value = newSupplier.id;

                showToast(`Supplier "${name}" added` + (openingUsd > 0 || openingZmw > 0 ? ' with opening payable' : '') + '!', 'success');
            } catch (error) {
                showToast('Error saving supplier: ' + error.message, 'error');
            }
            return;
        }

        const input = document.getElementById('quickAddInput');
        const name = input.value.trim();
        if (!name) {
            showToast("Please enter a name.", "error");
            return;
        }

        const tableMap = {
            'generic': 'generic_names',
            'dosage': 'dosage_forms',
            'category': 'categories',
            'subcategory': 'sub_categories',
            'brand': 'brands',
            'supplier': 'suppliers'
        };

        try {
            let insertData = { name };

            // 🔥 FIX (issue #3): subcategory now also saves its Location
            // field, same as category already did.
            if (type === 'category' || type === 'subcategory') {
                const location = document.getElementById('quickAddLocation')?.value.trim();
                if (location) {
                    insertData.location = location;
                }
            }

            if (type === 'subcategory') {
                const catId = document.getElementById('category').value;
                if (!catId) {
                    showToast("Please select a Category first before adding a Sub-Category.", "error");
                    closeQuickAdd();
                    return;
                }
                insertData.category_id = catId;
            }

            const { data, error } = await supabaseClient
                .from(tableMap[type])
                .insert([insertData])
                .select();

            if (error) throw error;

            closeQuickAdd();
            await loadDropdowns();

            if (data && data.length > 0) {
                const selectMap = {
                    'generic': 'genericName',
                    'dosage': 'dosageForm',
                    'category': 'category',
                    'subcategory': 'subCategory',
                    'brand': 'brand',
                    'supplier': 'supplier'
                };
                const selectId = selectMap[type];
                const selectEl = document.getElementById(selectId);
                
                if (selectEl) {
                    selectEl.value = data[0].id;
                    if (type === 'subcategory' || type === 'category') {
                        const changeEvent = new Event('change', { bubbles: true });
                        selectEl.dispatchEvent(changeEvent);
                    }
                }
            }

            showToast(`${type} added and selected successfully!`, 'success');
        } catch (error) {
            showToast("Error saving: " + error.message, "error");
        }
    };

    async function createSupplierOpeningPayableGLEntry(supplierId, supplierName, zmwAmount, note) {
        try {
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `OPEN-PAYABLE-${String(supplierId).slice(0, 8)}`,
                description: `Opening payable for supplier: ${supplierName} (${note})`,
                journal_number: `OPN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: accountCache.opening_balance_equity || '3000', description: `Opening equity for payable - ${supplierName}`, debit: zmwAmount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: accountCache.accounts_payable || '2001', description: `Opening payable - ${supplierName}`, debit: 0, credit: zmwAmount }
            ]);
            console.log(`✅ Opening payable GL entry created for ${supplierName}: ZK${zmwAmount}`);
        } catch (error) {
            console.error('Error creating opening payable GL entry:', error);
        }
    }

    // ============================================
    // TOAST NOTIFICATION SYSTEM
    // ============================================
    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${type === 'success' ? '#059669' : '#dc2626'};
            max-width: 400px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ============================================
    // FILTER PRODUCTS
    // ============================================
    window.filterProducts = function(searchTerm) {
        const rows = document.querySelectorAll('#productTableBody tr');
        const term = searchTerm.toLowerCase();
        rows.forEach(row => {
            const text = row.textContent.toLowerCase().replace(/,/g, '');
            row.style.display = text.includes(term) ? '' : 'none';
        });
    };

    // ============================================
    // DOWNLOAD CSV TEMPLATE (Global)
    // ============================================
    window.downloadCSVTemplate = function() {
        const headers = [
            'product_name', 'sku', 'generic_name', 'category', 'sub_category',
            'dosage_form', 'brand', 'supplier', 'tax_percent', 'conversion_rate',
            'min_order_qty', 'nhima_price_fixed', 'wholesale_internal_percent',
            'wholesale_regular_percent', 'retail_online_percent',
            'retail_regular_percent', 'retail_staff_percent',
            'opening_qty', 'batch_number', 'expiry_date', 'cost_price', 'currency'
        ];

        const sampleRow = [
            'Paracetamol 500mg', 'PRD-0001', 'Paracetamol', 'Pharmaceuticals',
            'Pain Relief', 'Tablet', 'BrandX', 'SupplierCo', '16', '30', '10',
            '75.00', '25', '30', '35', '40', '20', '100', 'B-2026-001',
            '2027-12-31', '50.00', 'ZMW'
        ];

        let csv = headers.join(',') + '\n';
        csv += sampleRow.join(',') + '\n';

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'product_import_template.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        showToast('Template downloaded successfully!', 'success');
    };

    // ============================================
    // SEARCH PRODUCTS (Global)
    // ============================================
    document.getElementById('searchProduct')?.addEventListener('input', function() {
        filterProducts(this.value);
    });

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        `;
        document.head.appendChild(style);
    }

    console.log("✅ Product page initialized successfully!");

})();