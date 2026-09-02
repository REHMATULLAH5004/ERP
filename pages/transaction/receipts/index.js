// ============================================
// RECEIVABLES MODULE - WITH PARTIAL PAYMENT SUPPORT
// ============================================

// 🔥 FIX: everything below is now wrapped in this IIFE. Previously
// `const safeToast = ...` (and the other top-level declarations) lived
// directly at script scope. If this script tag ever gets executed a second
// time on the same page — e.g. navigating to the Receivables screen twice
// in an SPA without a full reload — redeclaring a top-level `const` throws
// a hard SyntaxError immediately ("Identifier 'safeToast' has already been
// declared"), which aborts that entire script execution mid-way, including
// whatever DOM operation (like appendChild) happened to be running at that
// moment. Wrapping everything in its own function scope means each
// execution gets its own private `safeToast`, `parseNhimaCSV`, etc. with no
// collision possible, regardless of how many times the script runs.
(function() {

    const safeToast = (function() {
        let _toastLock = false; 
    
        return function(message, type = 'info') {
            if (_toastLock) return;
            _toastLock = true;
    
            if (typeof window.showToast === 'function' && window.showToast !== safeToast) {
                _toastLock = false;
                window.showToast(message, type);
                return;
            }
    
            let container = document.getElementById('receivableToastContainer');
            if (!container) {
                container = document.createElement('div');
                container.id = 'receivableToastContainer';
                container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
                document.body.appendChild(container);
            }
    
            const colors = { success: '#10b981', error: '#dc2626', warning: '#f59e0b', info: '#2563eb' };
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = `
                background: ${colors[type] || colors.info};
                color: white;
                padding: 10px 16px;
                border-radius: 6px;
                font-size: 0.85rem;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                max-width: 320px;
            `;
            container.appendChild(toast);
            
            _toastLock = false; 
    
            setTimeout(() => {
                toast.style.transition = 'opacity 0.3s ease';
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        };
    })();
    
    // ============================================
    // EXPOSE NHIMA SETTLEMENT FUNCTIONS TO GLOBAL SCOPE
    // ============================================
    
    window.openNhimaSettlementModal = function() {
        const modal = document.getElementById('nhimaSettlementModal');
        if (!modal) {
            console.error('NHIMA Settlement Modal not found.');
            safeToast('NHIMA Settlement Modal not found.', 'error');
            return;
        }
        
        document.getElementById('nhimaCsvFile').value = '';
        document.getElementById('nhimaSettlementDateCsv').value = new Date().toISOString().split('T')[0];
        modal.classList.add('show');
    };
    
    window.processNhimaSettlement = async function() {
        const fileInput = document.getElementById('nhimaCsvFile');
        const settlementDate = document.getElementById('nhimaSettlementDateCsv').value;
    
        if (!fileInput.files || fileInput.files.length === 0) {
            safeToast('Please select a CSV file', 'error');
            return;
        }
    
        if (!settlementDate) {
            safeToast('Please select a settlement date', 'error');
            return;
        }
    
        parseNhimaCSV(fileInput.files[0], async function(claims) {
            if (claims.length === 0) {
                safeToast('No valid claims found in CSV', 'error');
                return;
            }
    
            let successCount = 0, failCount = 0, skippedCount = 0;
            let errors = [];
    
            for (const claim of claims) {
                try {
                    if (!claim.claimNumber || claim.amount <= 0) {
                        skippedCount++;
                        continue;
                    }
    
                    console.log(`📝 Processing claim: ${claim.claimNumber} for ZK${claim.amount}`);
    
                    const { data: sale, error: saleError } = await supabaseClient
                        .from('sales')
                        .select('id, grand_total, customer_data, status')
                        .eq('claim_number', claim.claimNumber)
                        .maybeSingle();
    
                    if (saleError || !sale) {
                        console.warn(`⚠️ Claim ${claim.claimNumber} not found in sales table`);
                        failCount++;
                        errors.push(`Claim ${claim.claimNumber}: Not found in sales table`);
                        continue;
                    }
    
                    if (sale.status === 'Paid' || sale.status === 'Rejected') {
                        console.log(`⏭️ Claim ${claim.claimNumber} already processed (${sale.status})`);
                        skippedCount++;
                        continue;
                    }
    
                    let amountPaid = 0;
                    let finalStatus = sale.status || 'Pending';
    
                    if (claim.status === 'PAID' || claim.status === 'ACCEPTED') {
                        amountPaid = claim.amount;
                        finalStatus = 'Paid';
                    } else if (claim.status === 'PARTIAL' || claim.status === 'HALF') {
                        amountPaid = claim.amount;
                        finalStatus = 'Partial';
                    } else if (claim.status === 'REJECTED') {
                        amountPaid = 0;
                        finalStatus = 'Pending';
                    }
    
                    const customerData = sale.customer_data || {};
                    const nhimaNumber = customerData.nhima_number || claim.nhimaNumber || 'N/A';
                    const phone = customerData.phone || '';
                    const fullName = customerData.full_name || 'Unknown';
    
                    let customerId = null;
                    
                    if (nhimaNumber && nhimaNumber !== 'N/A') {
                        const { data: nhimaCustomer, error: nhimaError } = await supabaseClient
                            .from('customers')
                            .select('id, full_name, phone')
                            .eq('nhima_number', nhimaNumber)
                            .maybeSingle();
                        
                        if (!nhimaError && nhimaCustomer) {
                            customerId = nhimaCustomer.id;
                        }
                    }
                    
                    if (!customerId && phone) {
                        const { data: phoneCustomer, error: phoneError } = await supabaseClient
                            .from('customers')
                            .select('id, full_name, phone')
                            .eq('phone', phone)
                            .maybeSingle();
                        
                        if (!phoneError && phoneCustomer) {
                            customerId = phoneCustomer.id;
                        }
                    }
                    
                    if (!customerId && fullName && fullName !== 'Unknown') {
                        const { data: nameCustomer, error: nameError } = await supabaseClient
                            .from('customers')
                            .select('id, full_name, phone')
                            .eq('full_name', fullName)
                            .maybeSingle();
                        
                        if (!nameError && nameCustomer) {
                            customerId = nameCustomer.id;
                        }
                    }
                    
                    if (!customerId) {
                        console.log(`⚠️ No customer found for NHIMA ${nhimaNumber}, creating new customer`);
                        
                        const newPhone = phone || `NHIMA-${nhimaNumber}`;
                        const newFullName = fullName || 'NHIMA Customer';
                        
                        const { data: newCustomer, error: createError } = await supabaseClient
                            .from('customers')
                            .insert([{
                                full_name: newFullName,
                                phone: newPhone,
                                address: '',
                                customer_type: 'NHIMA',
                                nhima_number: nhimaNumber !== 'N/A' ? nhimaNumber : null,
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                            }])
                            .select();
                        
                        if (!createError && newCustomer && newCustomer.length > 0) {
                            customerId = newCustomer[0].id;
                        } else {
                            console.error('❌ Failed to create customer:', createError);
                            errors.push(`Claim ${claim.claimNumber}: Failed to create customer - ${createError?.message || 'Unknown error'}`);
                            failCount++;
                            continue;
                        }
                    }
    
                    if (!customerId) {
                        errors.push(`Claim ${claim.claimNumber}: Could not get or create customer`);
                        failCount++;
                        continue;
                    }
    
                    if (amountPaid > 0) {
                        const receiptNumber = `NHIMA-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                        
                        const receiptData = {
                            receipt_number: receiptNumber,
                            receipt_date: settlementDate,
                            amount: amountPaid,
                            payment_method: 'Bank Transfer',
                            status: 'Received',
                            customer_type: 'NHIMA',
                            customer_id: customerId,
                            notes: `NHIMA Settlement: ${claim.status} - ${claim.claimNumber}`
                        };
    
                        if (claim.claimNumber) receiptData.nhima_claim_number = claim.claimNumber;
                        if (nhimaNumber && nhimaNumber !== 'N/A') receiptData.nhima_number = nhimaNumber;
    
                        const { data: receipt, error: receiptError } = await supabaseClient
                            .from('customer_receipts')
                            .insert([receiptData])
                            .select();
    
                        if (receiptError || !receipt || receipt.length === 0) {
                            console.error('❌ Receipt error:', receiptError);
                            errors.push(`Claim ${claim.claimNumber}: ${receiptError?.message || 'No receipt returned'}`);
                            failCount++;
                            continue;
                        }
    
                        const receiptId = receipt[0].id;
    
                        const linkData = {
                            receipt_id: receiptId,
                            sale_id: sale.id,
                            amount_paid: amountPaid,
                            payment_date: settlementDate,
                            payment_method: 'Bank Transfer',
                            status: amountPaid >= sale.grand_total ? 'paid' : 'partial',
                            customer_id: customerId
                        };
    
                        if (claim.claimNumber) linkData.nhima_claim_number = claim.claimNumber;
                        if (nhimaNumber && nhimaNumber !== 'N/A') linkData.nhima_number = nhimaNumber;
    
                        const { error: linkError } = await supabaseClient
                            .from('customer_receipt_invoices')
                            .insert([linkData]);
    
                        if (linkError) {
                            console.error('❌ Link error:', linkError);
                            errors.push(`Claim ${claim.claimNumber}: ${linkError.message}`);
                            await supabaseClient.from('customer_receipts').delete().eq('id', receiptId);
                            failCount++;
                            continue;
                        }
    
                        await createReceiptGLEntry({
                            receipt_number: receiptNumber,
                            receipt_date: settlementDate,
                            amount: amountPaid,
                            payment_method: 'Bank Transfer',
                            customer_type: 'NHIMA'
                        });
                    }
    
                    if (claim.status === 'ACCEPTED' || claim.status === 'PAID') {
                        await supabaseClient.from('sales').update({ status: 'Paid' }).eq('id', sale.id);
                    } else if (claim.status === 'PARTIAL' || claim.status === 'HALF') {
                        await supabaseClient.from('sales').update({ status: 'Partial' }).eq('id', sale.id);
                    }
    
                    successCount++;
    
                } catch (error) {
                    console.error(`❌ Error processing claim ${claim.claimNumber}:`, error);
                    errors.push(`Claim ${claim.claimNumber}: ${error.message}`);
                    failCount++;
                }
            }
    
            let message = `Processed: ${successCount} Success, ${failCount} Failed, ${skippedCount} Skipped`;
            if (errors.length > 0) {
                message += `\n\nErrors:\n${errors.slice(0, 3).join('\n')}`;
                if (errors.length > 3) message += `\n... and ${errors.length - 3} more errors`;
            }
            safeToast(message, failCount > 0 ? 'warning' : 'success');
            
            document.getElementById('nhimaSettlementModal').classList.remove('show');
            await refreshReceivableList();
        });
    };
    
    function parseNhimaCSV(file, callback) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            const lines = text.split('\n').filter(line => line.trim() !== '');
            
            if (lines.length < 2) {
                safeToast('CSV file is empty or missing header row', 'error');
                return;
            }
    
            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
            
            const claimIndex = headers.findIndex(h => h.includes('claim') || h.includes('claimnumber'));
            const nhimaIndex = headers.findIndex(h => h.includes('nhima') || h.includes('nhimanumber'));
            const nameIndex = headers.findIndex(h => h.includes('patient') || h.includes('name') || h.includes('customer'));
            const amountIndex = headers.findIndex(h => h.includes('amount') || h.includes('total') || h.includes('balance'));
            const statusIndex = headers.findIndex(h => h.includes('status') || h.includes('result'));
            
            if (claimIndex === -1 || amountIndex === -1) {
                safeToast('CSV must contain "ClaimNumber" and "Amount" columns', 'error');
                return;
            }
    
            const data = [];
            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
                if (values.length > Math.max(claimIndex, amountIndex)) {
                    const amount = parseFloat(values[amountIndex]) || 0;
                    if (amount > 0) {
                        data.push({
                            claimNumber: values[claimIndex] || '',
                            nhimaNumber: nhimaIndex !== -1 ? values[nhimaIndex] || '' : '',
                            patientName: nameIndex !== -1 ? values[nameIndex] || '' : '',
                            amount: amount,
                            status: statusIndex !== -1 ? values[statusIndex].toUpperCase() : 'ACCEPTED'
                        });
                    }
                }
            }
            
            console.log(`✅ Parsed ${data.length} claims from CSV`);
            callback(data);
        };
        reader.readAsText(file);
    }
    
    // ============================================
    // MAIN RECEIVABLES MODULE
    // ============================================
    
    window.initReceivablePage = async function initReceivablePage() {
        if (window._receivablesInitLock) return;
        window._receivablesInitLock = true;
    
        console.log("📊 Receivables module initializing...");
    
        if (typeof supabaseClient === 'undefined') {
            console.error("❌ supabaseClient is not defined.");
            window._receivablesInitLock = false;
            return;
        }
    
        // ============================================
        // CHART OF ACCOUNTS
        // ============================================
        
        const REQUIRED_ACCOUNTS = [
            { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
            { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
            { code: '1200', name: 'Accounts Receivable', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
            { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
            { code: '2100', name: 'Sales Tax Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
            { code: '3000', name: 'Opening Balance Equity', type: 'Equity', category: 'Equity', normal_balance: 'Credit' },
            { code: '4001', name: 'Retail - NHIMA Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
            { code: '4002', name: 'Retail - Regular Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
            { code: '4003', name: 'Retail - Online Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
            { code: '4004', name: 'Retail - Staff Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
            { code: '5001', name: 'COGS - Retail', type: 'Expense', category: 'Cost of Goods Sold', normal_balance: 'Debit' }
        ];
    
        async function ensureChartOfAccounts() {
            try {
                let created = 0, existing = 0;
                for (const account of REQUIRED_ACCOUNTS) {
                    const { data: existingAccount } = await supabaseClient
                        .from('chart_of_accounts')
                        .select('code, name')
                        .eq('code', account.code)
                        .maybeSingle();
                    
                    if (existingAccount) { existing++; continue; }
                    
                    const { error: insertError } = await supabaseClient
                        .from('chart_of_accounts')
                        .insert([{
                            code: account.code,
                            name: account.name,
                            type: account.type,
                            category: account.category,
                            normal_balance: account.normal_balance,
                            created_at: new Date().toISOString()
                        }]);
                    
                    if (!insertError) created++;
                }
                console.log(`✅ Chart of Accounts: ${created} created, ${existing} existing`);
                return { created, existing };
            } catch (error) {
                console.error('Error ensuring chart of accounts:', error);
                return { created: 0, existing: 0 };
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
                    cash_zmw: accountMap['cash_in_hand_zmw'] || '1111',
                    bank_zmw: accountMap['bank_zmw'] || '1121',
                    accounts_receivable: accountMap['accounts_receivable'] || '1200',
                    inventory: accountMap['inventory'] || '1400',
                    sales_tax_payable: accountMap['sales_tax_payable'] || '2100',
                    opening_balance_equity: accountMap['opening_balance_equity'] || '3000',
                    retail_nhima_sales: accountMap['retail_nhima_sales'] || '4001',
                    retail_regular_sales: accountMap['retail_regular_sales'] || '4002',
                    retail_online_sales: accountMap['retail_online_sales'] || '4003',
                    retail_staff_sales: accountMap['retail_staff_sales'] || '4004',
                    cogs_retail: accountMap['cogs_retail'] || '5001'
                };
            } catch (error) {
                console.error('Error fetching account codes:', error);
                return {
                    cash_zmw: '1111',
                    bank_zmw: '1121',
                    accounts_receivable: '1200',
                    inventory: '1400',
                    sales_tax_payable: '2100',
                    opening_balance_equity: '3000',
                    retail_nhima_sales: '4001',
                    retail_regular_sales: '4002',
                    retail_online_sales: '4003',
                    retail_staff_sales: '4004',
                    cogs_retail: '5001'
                };
            }
        }
    
        // ============================================
        // UTILITIES
        // ============================================
    
        function formatNumber(num) {
            const n = Number(num) || 0;
            return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    
        function formatDate(dateStr) {
            if (!dateStr) return '-';
            try {
                return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } catch { return dateStr; }
        }
    
        // ============================================
        // GLOBAL STATE
        // ============================================
        const state = {
            customers: [],
            regularCustomers: [],
            nhimaMembers: [],
            wholesaleCustomers: [],
            receipts: [],
            sales: [],
            customerReceiptInvoices: [],
            currentStatementData: null,
            currentReceiptData: null,
            currentRetailCustomerId: null,
            currentWholesaleCustomerId: null
        };
    
        // ============================================
        // LOAD DATA
        // ============================================
    
        async function loadCustomers() {
            try {
                const [nhimaMembers, regularCustomers, wholesaleCustomers] = await Promise.all([
                    supabaseClient.from('nhima_members').select('*').order('full_name', { ascending: true }),
                    supabaseClient.from('customers').select('*').order('full_name', { ascending: true }),
                    supabaseClient.from('wholesale_customers').select('*').order('customer_name', { ascending: true })
                ]);
    
                state.nhimaMembers = nhimaMembers.data || [];
                state.regularCustomers = regularCustomers.data || [];
                state.wholesaleCustomers = wholesaleCustomers.data || [];
    
                const allCustomers = [];
    
                state.nhimaMembers.forEach(c => {
                    allCustomers.push({
                        ...c,
                        _source: 'nhima',
                        _type: 'RETAIL',
                        _subType: 'NHIMA',
                        _displayName: c.full_name,
                        _id: `nhima_${c.id}`,
                        _customerId: c.id,
                        _phone: c.phone || '',
                        _address: c.address || '',
                        _identifier: c.nhima_number
                    });
                });
    
                state.regularCustomers.forEach(c => {
                    allCustomers.push({
                        ...c,
                        _source: 'customers',
                        _type: 'RETAIL',
                        _subType: c.customer_type || 'REGULAR',
                        _displayName: c.full_name,
                        _id: `customer_${c.id}`,
                        _customerId: c.id,
                        _phone: c.phone || '',
                        _address: c.address || '',
                        _identifier: c.phone
                    });
                });
    
                state.wholesaleCustomers.forEach(c => {
                    allCustomers.push({
                        ...c,
                        _source: 'wholesale',
                        _type: 'WHOLESALE',
                        _subType: c.customer_type || 'REGULAR',
                        _displayName: c.customer_name,
                        _id: `wholesale_${c.id}`,
                        _customerId: c.id,
                        _phone: c.phone || '',
                        _address: c.address || '',
                        _identifier: c.phone
                    });
                });
    
                state.customers = allCustomers;
                console.log(`✅ Loaded ${state.customers.length} customers`);
                return state.customers;
            } catch (error) {
                console.error('Error loading customers:', error);
                state.customers = [];
                return [];
            }
        }
    
        async function loadReceipts() {
            try {
                const { data, error } = await supabaseClient
                    .from('customer_receipts')
                    .select('*')
                    .order('receipt_date', { ascending: false });
                
                if (error) throw error;
                state.receipts = data || [];
                console.log(`✅ Loaded ${state.receipts.length} receipts`);
                return state.receipts;
            } catch (error) {
                console.warn('Error loading receipts:', error);
                state.receipts = [];
                return [];
            }
        }
    
        async function loadSales() {
            try {
                const { data, error } = await supabaseClient
                    .from('sales')
                    .select('*')
                    .order('created_at', { ascending: true });
                
                if (error) throw error;
    
                state.sales = data || [];
    
                console.log(`✅ Loaded ${state.sales.length} total sales`);
                return state.sales;
            } catch (error) {
                console.warn('Error loading sales:', error);
                state.sales = [];
                return [];
            }
        }
    
        async function loadCustomerReceiptInvoices() {
            try {
                const { data, error } = await supabaseClient
                    .from('customer_receipt_invoices')
                    .select('*')
                    .order('created_at', { ascending: true });
                
                if (error) throw error;
                state.customerReceiptInvoices = data || [];
                console.log(`✅ Loaded ${state.customerReceiptInvoices.length} receipt-invoice links`);
                return state.customerReceiptInvoices;
            } catch (error) {
                console.warn('Error loading receipt-invoice links:', error);
                state.customerReceiptInvoices = [];
                return [];
            }
        }
    
        // ============================================
        // CALCULATE RECEIVABLES
        // ============================================
    
        function calculateNhimaReceivables() {
            const nhimaSales = state.sales.filter(sale => 
                sale.client_sub_type === 'NHIMA' && 
                sale.claim_number && sale.claim_number.trim() !== '' &&
                sale.status !== 'Paid' && sale.status !== 'Rejected'
            );
    
            // 🔥 FIX: this used to match payments to sales by comparing
            // claim_number TEXT -- confirmed against live data that this
            // breaks the moment two different sales happen to share the
            // same claim number (which nothing currently prevents). A
            // payment recorded against ONE specific sale would get applied
            // to BOTH sales sharing that claim number, silently marking the
            // second one "Settled" even though it was never actually paid.
            //
            // customer_receipt_invoices already links a payment to exactly
            // one sale by its real ID (confirmed directly against the data:
            // a receipt applied to sale X has a row here with that exact
            // sale_id, not just a matching claim number text). Matching on
            // that instead makes this immune to claim-number collisions
            // entirely, whether or not the save-time uniqueness check below
            // ever gets bypassed somehow.
            const saleIds = new Set(nhimaSales.map(s => s.id));
            const relevantInvoiceLinks = (state.customerReceiptInvoices || []).filter(link =>
                saleIds.has(link.sale_id)
            );
    
            const paidBySaleId = {};
            relevantInvoiceLinks.forEach(link => {
                paidBySaleId[link.sale_id] = (paidBySaleId[link.sale_id] || 0) + (link.amount_paid || 0);
            });
    
            let totalSales = 0, totalReceived = 0;
            nhimaSales.forEach(s => totalSales += s.grand_total || 0);
            Object.values(paidBySaleId).forEach(amt => totalReceived += amt);
    
            // 🔥 FIX: Ensure outstanding never goes negative
            const receivable = Math.max(0, totalSales - totalReceived);
    
            const claimDetails = nhimaSales.map(sale => {
                const paidAmount = paidBySaleId[sale.id] || 0;
                const balance = Math.max(0, (sale.grand_total || 0) - paidAmount);
                return {
                    saleId: sale.id,
                    claimNumber: sale.claim_number || 'N/A',
                    nhimaNumber: sale.customer_data?.nhima_number || 'N/A',
                    customerName: sale.customer_data?.full_name || 'Unknown',
                    date: sale.created_at,
                    amount: sale.grand_total || 0,
                    paidAmount: paidAmount,
                    balance: balance,
                    isSettled: balance <= 0.01,
                    status: balance <= 0.01 ? 'Settled' : (sale.status || 'Pending')
                };
            });
    
            return {
                totalSales, totalReceived, receivable,
                hasReceivable: receivable > 0.01,
                claimDetails,
                count: claimDetails.length
            };
        }
    
        function calculateRetailReceivables() {
            const retailSubTypes = ['REGULAR', 'ONLINE', 'STAFF'];
            const retailSales = state.sales.filter(sale => 
                retailSubTypes.includes(sale.client_sub_type) &&
                sale.status !== 'Paid' && sale.status !== 'Rejected'
            );
    
            const customerMap = {};
            retailSales.forEach(sale => {
                const data = sale.customer_data || {};
                const key = data.phone || data.full_name || 'unknown';
                if (!customerMap[key]) {
                    const customer = state.customers.find(c => c.phone === data.phone || c.full_name === data.full_name);
                    customerMap[key] = {
                        customer: customer || {
                            _displayName: data.full_name || 'Unknown',
                            _phone: data.phone || '',
                            _customerId: null,
                            _source: 'unknown',
                            _type: 'RETAIL',
                            _subType: 'REGULAR'
                        },
                        sales: [],
                        totalSales: 0,
                        totalReceived: 0,
                        opening_balance_zmw: customer?.opening_balance_zmw || 0,
                        receipts: []
                    };
                }
                customerMap[key].sales.push(sale);
                customerMap[key].totalSales += sale.grand_total || 0;
            });
    
            Object.values(customerMap).forEach(entry => {
                const receipts = state.receipts.filter(r => r.customer_id === entry.customer._customerId);
                receipts.forEach(r => entry.totalReceived += r.amount || 0);
                entry.receipts = receipts;
                entry.receivable = entry.opening_balance_zmw + entry.totalSales - entry.totalReceived;
                entry.hasReceivable = entry.receivable > 0.01;
            });
    
            return Object.values(customerMap).filter(c => c.hasReceivable);
        }
    
        function calculateWholesaleReceivables() {
            const wholesaleSales = state.sales.filter(sale => 
                sale.client_type === 'WHOLESALE' &&
                sale.status !== 'Paid' && sale.status !== 'Rejected'
            );
    
            const customerMap = {};
            wholesaleSales.forEach(sale => {
                const data = sale.customer_data || {};
                const key = data.id || data.phone || 'unknown';
                if (!customerMap[key]) {
                    const customer = state.customers.find(c => 
                        c._source === 'wholesale' && (c.id === data.id || c.phone === data.phone)
                    );
                    customerMap[key] = {
                        customer: customer || {
                            _displayName: data.customer_name || data.full_name || 'Unknown',
                            _phone: data.phone || '',
                            _customerId: data.id || null,
                            _source: 'wholesale',
                            _type: 'WHOLESALE',
                            _subType: data.customer_type || 'REGULAR'
                        },
                        sales: [],
                        totalSales: 0,
                        totalReceived: 0,
                        opening_balance_zmw: customer?.opening_balance_zmw || 0,
                        receipts: []
                    };
                }
                customerMap[key].sales.push(sale);
                customerMap[key].totalSales += sale.grand_total || 0;
            });
    
            Object.values(customerMap).forEach(entry => {
                const receipts = state.receipts.filter(r => r.wholesale_customer_id === entry.customer._customerId);
                receipts.forEach(r => entry.totalReceived += r.amount || 0);
                entry.receipts = receipts;
                entry.receivable = entry.opening_balance_zmw + entry.totalSales - entry.totalReceived;
                entry.hasReceivable = entry.receivable > 0.01;
            });
    
            return Object.values(customerMap).filter(c => c.hasReceivable);
        }
    
        // ============================================
        // RENDER FUNCTIONS
        // ============================================
    
        // 🔥 CHANGED: this table is now VIEW-ONLY. No checkboxes, no selection,
        // nothing clickable — just the claims and their status, plus a Download
        // CSV button. Ticking claims off for settlement now happens exclusively
        // inside the "NHIMA Bulk" modal (openNhimaBulkModal), which is the only
        // place that renders `.nhima-claim-checkbox` inputs. Having the same
        // checkbox mechanism live in two places (this table AND the bulk modal)
        // was the source of the confusion — this table never actually did
        // anything with a checked box (updateNhimaSelection() already ignores
        // clicks here, see its own guard), so it was pure visual clutter that
        // looked like it should do something but didn't.
        function renderNhimaTable() {
            const data = calculateNhimaReceivables();
            const tbody = document.getElementById('nhimaReceivableTableBody');
            const countSpan = document.getElementById('nhimaCount');
    
            if (!tbody) return;
    
            // Inject a "Download CSV" button once, right next to the claim
            // count, so this view-only table still has a way to get the data
            // out (e.g. to prep the settlement CSV upload workflow).
            if (countSpan && !document.getElementById('nhimaDownloadCsvBtn')) {
                const dlBtn = document.createElement('button');
                dlBtn.id = 'nhimaDownloadCsvBtn';
                dlBtn.className = 'btn btn-sm btn-outline';
                dlBtn.style.cssText = 'margin-left:12px;background:transparent;color:#059669;border:1px solid #059669;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.75rem;';
                dlBtn.innerHTML = '<i class="fa-solid fa-file-csv"></i> Download CSV';
                dlBtn.onclick = () => window.exportNhimaClaims();
                countSpan.insertAdjacentElement('afterend', dlBtn);
            }
    
            if (data.claimDetails.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">
                    <i class="fa-regular fa-circle-check" style="font-size:1.5rem;display:block;margin-bottom:8px;color:#22c55e;"></i>
                    No NHIMA claims pending
                </td></tr>`;
                if (countSpan) countSpan.textContent = '0 claims';
                return;
            }
    
            const pendingClaims = data.claimDetails.filter(c => !c.isSettled);
    
            tbody.innerHTML = pendingClaims.map((claim) => {
                const statusColor = claim.isSettled ? '#10b981' : '#f59e0b';
                return `
                <tr>
                    <td><strong>${claim.claimNumber}</strong></td>
                    <td>${claim.customerName}</td>
                    <td>${claim.nhimaNumber}</td>
                    <td style="text-align:right;">ZK ${formatNumber(claim.amount)}</td>
                    <td style="text-align:right;color:#10b981;">ZK ${formatNumber(claim.paidAmount)}</td>
                    <td style="text-align:right;font-weight:600;">ZK ${formatNumber(claim.balance)}</td>
                    <td style="text-align:center;">
                        <span style="background:${statusColor}20;color:${statusColor};padding:2px 10px;border-radius:10px;font-size:0.7rem;font-weight:600;">
                            ${claim.isSettled ? 'Settled' : (claim.status || 'Pending')}
                        </span>
                    </td>
                </tr>`;
            }).join('');
    
            const totalBalance = pendingClaims.reduce((sum, c) => sum + c.balance, 0);
    
            if (countSpan) {
                countSpan.textContent = `${pendingClaims.length} pending claims | Total: ZK${formatNumber(totalBalance)}`;
            }
    
            const summary = document.getElementById('nhimaSummary');
            if (summary) {
                summary.style.display = data.hasReceivable ? 'block' : 'none';
                document.getElementById('nhimaTotalClaims').textContent = data.claimDetails.length;
                document.getElementById('nhimaTotalAmount').textContent = `ZK${formatNumber(data.totalSales)}`;
                document.getElementById('nhimaTotalPaid').textContent = `ZK${formatNumber(data.totalReceived)}`;
                document.getElementById('nhimaOutstandingBalance').textContent = `ZK${formatNumber(data.receivable)}`;
            }
        }
    
        function renderRetailTable() {
            const data = calculateRetailReceivables();
            const tbody = document.getElementById('retailReceivableTableBody');
            const countSpan = document.getElementById('retailCount');
    
            if (!tbody) return;
    
            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;">
                    <i class="fa-regular fa-circle-check" style="font-size:1.5rem;display:block;margin-bottom:8px;color:#22c55e;"></i>
                    No retail receivables
                </td></tr>`;
                if (countSpan) countSpan.textContent = '0 customers';
                return;
            }
    
            const totalReceivable = data.reduce((sum, c) => sum + c.receivable, 0);
    
            tbody.innerHTML = data.map(c => {
                const customer = c.customer;
                const badgeClass = customer._subType === 'ONLINE' ? 'client-type-online' : 
                                  customer._subType === 'STAFF' ? 'client-type-staff' : 'client-type-regular';
    
                return `
                <tr>
                    <td>
                        <span class="customer-name-link" onclick="openRetailStatement('${customer._id || customer._customerId}')">
                            ${customer._displayName}
                        </span>
                    </td>
                    <td>${customer._phone || '-'}</td>
                    <td><span class="client-type-badge ${badgeClass}">${customer._subType || 'REGULAR'}</span></td>
                    <td style="text-align:right;font-weight:600;color:${c.receivable > 0 ? '#dc2626' : '#10b981'};">
                        ZK${formatNumber(c.receivable)}
                    </td>
                    <td style="text-align:center;">
                        <button class="btn btn-success btn-sm" onclick="openRetailReceipt('${customer._id || customer._customerId}')">
                            <i class="fa-solid fa-receipt"></i> Receive
                        </button>
                    </td>
                </tr>`;
            }).join('');
    
            if (countSpan) {
                countSpan.textContent = `${data.length} customers | Total: ZK${formatNumber(totalReceivable)}`;
            }
        }
    
        function renderWholesaleTable() {
            const data = calculateWholesaleReceivables();
            const tbody = document.getElementById('wholesaleReceivableTableBody');
            const countSpan = document.getElementById('wholesaleCount');
    
            if (!tbody) return;
    
            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;">
                    <i class="fa-regular fa-circle-check" style="font-size:1.5rem;display:block;margin-bottom:8px;color:#22c55e;"></i>
                    No wholesale receivables
                </td></tr>`;
                if (countSpan) countSpan.textContent = '0 customers';
                return;
            }
    
            const totalReceivable = data.reduce((sum, c) => sum + c.receivable, 0);
    
            tbody.innerHTML = data.map(c => {
                const customer = c.customer;
                const badgeClass = customer._subType === 'INTERNAL' ? 'client-type-internal' : 'client-type-wholesale';
    
                return `
                <tr>
                    <td>
                        <span class="customer-name-link" onclick="openWholesaleStatement('${customer._id || customer._customerId}')">
                            ${customer._displayName}
                        </span>
                    </td>
                    <td>${customer._phone || '-'}</td>
                    <td><span class="client-type-badge ${badgeClass}">${customer._subType || 'REGULAR'}</span></td>
                    <td style="text-align:right;font-weight:600;color:${c.receivable > 0 ? '#dc2626' : '#10b981'};">
                        ZK${formatNumber(c.receivable)}
                    </td>
                    <td style="text-align:center;">
                        <button class="btn btn-success btn-sm" onclick="openWholesaleReceipt('${customer._id || customer._customerId}')">
                            <i class="fa-solid fa-receipt"></i> Receive
                        </button>
                    </td>
                </tr>`;
            }).join('');
    
            if (countSpan) {
                countSpan.textContent = `${data.length} customers | Total: ZK${formatNumber(totalReceivable)}`;
            }
        }
    
        function renderStats() {
            const nhimaData = calculateNhimaReceivables();
            const retailData = calculateRetailReceivables();
            const wholesaleData = calculateWholesaleReceivables();
    
            const retailTotal = retailData.reduce((sum, c) => sum + c.receivable, 0);
            const wholesaleTotal = wholesaleData.reduce((sum, c) => sum + c.receivable, 0);
            const totalReceivable = Math.max(0, nhimaData.receivable + retailTotal + wholesaleTotal);
    
            const totalReceivableCustomers = document.getElementById('totalReceivableCustomers');
            if (totalReceivableCustomers) totalReceivableCustomers.textContent = `ZK${formatNumber(totalReceivable)}`;
    
            const totalNhimaReceivables = document.getElementById('totalNhimaReceivables');
            if (totalNhimaReceivables) totalNhimaReceivables.textContent = `ZK${formatNumber(nhimaData.receivable)}`;
    
            const totalRetailReceivables = document.getElementById('totalRetailReceivables');
            if (totalRetailReceivables) totalRetailReceivables.textContent = `ZK${formatNumber(retailTotal)}`;
    
            const totalWholesaleReceivables = document.getElementById('totalWholesaleReceivables');
            if (totalWholesaleReceivables) totalWholesaleReceivables.textContent = `ZK${formatNumber(wholesaleTotal)}`;
    
            const today = new Date().toISOString().split('T')[0];
            const todayReceipts = state.receipts.filter(r => r.receipt_date === today);
            const totalReceivedToday = todayReceipts.reduce((sum, r) => sum + (r.amount || 0), 0);
            
            const totalReceivedTodayEl = document.getElementById('totalReceivedToday');
            if (totalReceivedTodayEl) totalReceivedTodayEl.textContent = `ZK${formatNumber(totalReceivedToday)}`;
        }
    
        function renderAllTables() {
            renderNhimaTable();
            renderRetailTable();
            renderWholesaleTable();
            renderStats();
        }
    
        // ============================================
        // NHIMA SELECTION FUNCTIONS
        // ============================================
    
        window.updateNhimaSelection = function() {
            // 🔥 FIX: Prevent updateNhimaSelection from reading hidden Bulk Modal checkboxes
            const modal = document.getElementById('nhimaBulkModal');
            if (!modal || !modal.classList.contains('show')) return;
    
            const checked = document.querySelectorAll('.nhima-claim-checkbox:checked');
            const summary = document.getElementById('nhimaSelectionSummary');
            
            if (checked.length === 0) {
                if (summary) summary.style.display = 'none';
                return;
            }
    
            let totalAmount = 0, totalBalance = 0;
            checked.forEach(cb => {
                totalAmount += parseFloat(cb.dataset.amount) || 0;
                totalBalance += parseFloat(cb.dataset.balance) || 0;
            });
    
            document.getElementById('nhimaSelectedCount').textContent = checked.length;
            document.getElementById('nhimaSelectedTotal').textContent = `ZK ${formatNumber(totalAmount)}`;
            document.getElementById('nhimaSelectedBalance').textContent = `ZK ${formatNumber(totalBalance)}`;
            if (summary) summary.style.display = 'block';
        };
    
        window.selectAllNhimaClaims = function() {
            document.querySelectorAll('.nhima-claim-checkbox:not(:disabled)').forEach(cb => cb.checked = true);
            window.updateNhimaSelection();
        };
    
        window.deselectAllNhimaClaims = function() {
            document.querySelectorAll('.nhima-claim-checkbox').forEach(cb => cb.checked = false);
            window.updateNhimaSelection();
        };
    
        window.toggleAllNhimaClaims = function() {
            const selectAll = document.getElementById('selectAllNhima');
            document.querySelectorAll('.nhima-claim-checkbox:not(:disabled)').forEach(cb => {
                cb.checked = selectAll?.checked || false;
            });
            window.updateNhimaSelection();
        };
    
        // ============================================
        // PROCESS NHIMA BULK SETTLEMENT
        // ============================================
    
        window.processNhimaBulkSettlement = async function() {
            const checked = document.querySelectorAll('.nhima-claim-checkbox:checked');
            if (checked.length === 0) {
                safeToast('Please select at least one claim to settle', 'error');
                return;
            }
    
            const settlementDate = document.getElementById('nhimaSettlementDate')?.value || new Date().toISOString().split('T')[0];
    
            if (!confirm(`Process ${checked.length} NHIMA claims for settlement? This will create receipts and GL entries.`)) return;
    
            let successCount = 0, failCount = 0;
            let errors = [];
    
            for (const cb of checked) {
                try {
                    const claimId = cb.dataset.claimId;
                    const claimNumber = cb.dataset.claimNumber;
                    const balance = parseFloat(cb.dataset.balance) || 0;
                    const customerName = cb.dataset.customer || 'Unknown';
                    const nhimaNumber = cb.dataset.nhima || 'N/A';
    
                    if (balance <= 0) continue;
    
                    let customerId = null;
                    
                    if (nhimaNumber && nhimaNumber !== 'N/A') {
                        const { data: existingCustomer, error: findError } = await supabaseClient
                            .from('customers')
                            .select('id, full_name, phone')
                            .eq('nhima_number', nhimaNumber)
                            .maybeSingle();
                        
                        if (!findError && existingCustomer) customerId = existingCustomer.id;
                    }
    
                    if (!customerId) {
                        const { data: saleData, error: saleError } = await supabaseClient
                            .from('sales')
                            .select('customer_data, customer_id')
                            .eq('id', claimId)
                            .maybeSingle();
                        
                        if (!saleError && saleData) {
                            if (saleData.customer_id) {
                                customerId = saleData.customer_id;
                            } else {
                                const phone = saleData.customer_data?.phone;
                                if (phone) {
                                    const { data: phoneCustomer } = await supabaseClient
                                        .from('customers')
                                        .select('id')
                                        .eq('phone', phone)
                                        .maybeSingle();
                                    if (phoneCustomer) customerId = phoneCustomer.id;
                                }
                            }
                        }
                    }
    
                    if (!customerId) {
                        const phone = `NHIMA-${nhimaNumber}`;
                        const { data: newCustomer, error: createError } = await supabaseClient
                            .from('customers')
                            .insert([{
                                full_name: customerName || 'NHIMA Customer',
                                phone: phone,
                                customer_type: 'NHIMA',
                                nhima_number: nhimaNumber !== 'N/A' ? nhimaNumber : null,
                                created_at: new Date().toISOString()
                            }])
                            .select();
                        
                        if (createError || !newCustomer || newCustomer.length === 0) {
                            errors.push(`Claim ${claimNumber}: Failed to create customer`);
                            failCount++;
                            continue;
                        }
                        customerId = newCustomer[0].id;
                    }
    
                    const receiptNumber = `NHIMA-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                    
                    const receiptData = {
                        receipt_number: receiptNumber,
                        receipt_date: settlementDate,
                        amount: balance,
                        payment_method: 'Bank Transfer',
                        status: 'Received',
                        customer_type: 'NHIMA',
                        customer_id: customerId,
                        notes: `NHIMA Settlement - ${claimNumber} - ${customerName}`,
                        nhima_claim_number: claimNumber
                    };
                    if (nhimaNumber && nhimaNumber !== 'N/A') receiptData.nhima_number = nhimaNumber;
    
                    const { data: receipt, error: receiptError } = await supabaseClient
                        .from('customer_receipts')
                        .insert([receiptData])
                        .select();
    
                    if (receiptError || !receipt || receipt.length === 0) {
                        errors.push(`Claim ${claimNumber}: ${receiptError?.message || 'No receipt returned'}`);
                        failCount++;
                        continue;
                    }
    
                    const receiptId = receipt[0].id;
    
                    const linkData = {
                        receipt_id: receiptId,
                        sale_id: claimId,
                        amount_paid: balance,
                        payment_date: settlementDate,
                        payment_method: 'Bank Transfer',
                        status: 'paid',
                        customer_id: customerId,
                        nhima_claim_number: claimNumber
                    };
                    if (nhimaNumber && nhimaNumber !== 'N/A') linkData.nhima_number = nhimaNumber;
    
                    const { error: linkError } = await supabaseClient
                        .from('customer_receipt_invoices')
                        .insert([linkData]);
    
                    if (linkError) {
                        errors.push(`Claim ${claimNumber}: ${linkError.message}`);
                        await supabaseClient.from('customer_receipts').delete().eq('id', receiptId);
                        failCount++;
                        continue;
                    }
    
                    await supabaseClient.from('sales').update({ status: 'Paid' }).eq('id', claimId);
                    await createReceiptGLEntry({
                        receipt_number: receiptNumber,
                        receipt_date: settlementDate,
                        amount: balance,
                        payment_method: 'Bank Transfer',
                        customer_type: 'NHIMA'
                    });
    
                    successCount++;
    
                } catch (error) {
                    errors.push(`Claim ${cb.dataset.claimNumber}: ${error.message}`);
                    failCount++;
                }
            }
    
            let message = `NHIMA Settlement: ${successCount} processed, ${failCount} failed`;
            if (errors.length > 0) {
                message += `\n\nErrors:\n${errors.slice(0, 5).join('\n')}`;
                if (errors.length > 5) message += `\n... and ${errors.length - 5} more errors`;
            }
            safeToast(message, failCount > 0 ? 'warning' : 'success');
            
            const modal = document.getElementById('nhimaBulkModal');
            if (modal) modal.classList.remove('show');
            
            await refreshReceivableList();
        };
    
        // ============================================
        // OPEN NHIMA BULK MODAL
        // ============================================
    
        window.openNhimaBulkModal = function() {
            const data = calculateNhimaReceivables();
            if (!data.hasReceivable) {
                safeToast('No NHIMA Bulk claims to display', 'error');
                return;
            }
    
            const modal = document.getElementById('nhimaBulkModal');
            if (!modal) return;
    
            const dateInput = document.getElementById('nhimaSettlementDate');
            if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
    
            document.getElementById('nhimaBulkModalTitle').textContent = `NHIMA Bulk Claims (${data.claimDetails.length} Claims)`;
    
            const totalBalance = data.claimDetails.reduce((sum, c) => sum + c.balance, 0);
    
            let html = `
                <div style="margin-bottom:15px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
                    <div style="padding:12px;background:#f8fafc;border-radius:6px;text-align:center;">
                        <span style="font-size:0.7rem;color:#64748b;">Total Claims</span>
                        <p style="font-weight:700;margin:0;font-size:1.1rem;">${data.claimDetails.length}</p>
                    </div>
                    <div style="padding:12px;background:#f8fafc;border-radius:6px;text-align:center;">
                        <span style="font-size:0.7rem;color:#64748b;">Total Amount</span>
                        <p style="font-weight:700;margin:0;font-size:1.1rem;">ZK ${formatNumber(data.totalSales)}</p>
                    </div>
                    <div style="padding:12px;background:#dcfce7;border-radius:6px;text-align:center;">
                        <span style="font-size:0.7rem;color:#64748b;">Total Paid</span>
                        <p style="font-weight:700;margin:0;font-size:1.1rem;color:#10b981;">ZK ${formatNumber(data.totalReceived)}</p>
                    </div>
                    <div style="padding:12px;background:#fef2f2;border-radius:6px;text-align:center;">
                        <span style="font-size:0.7rem;color:#64748b;">Outstanding</span>
                        <p style="font-weight:700;margin:0;font-size:1.1rem;color:${totalBalance > 0 ? '#dc2626' : '#10b981'};">ZK ${formatNumber(totalBalance)}</p>
                    </div>
                </div>
    
                <div style="margin-bottom:15px;display:flex;gap:10px;flex-wrap:wrap;">
                    <button class="btn btn-sm btn-success" onclick="selectAllNhimaClaims()" style="background:#10b981;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;">
                        <i class="fa-solid fa-check-double"></i> Select All
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="deselectAllNhimaClaims()" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:6px 12px;border-radius:4px;cursor:pointer;">
                        <i class="fa-solid fa-square"></i> Deselect All
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="processNhimaBulkSettlement()" style="background:#2563eb;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;">
                        <i class="fa-solid fa-file-invoice"></i> Process Selected
                    </button>
                    <button class="btn btn-sm btn-success" onclick="exportNhimaClaims()" style="background:#059669;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;">
                        <i class="fa-solid fa-file-export"></i> Export Report
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="openNhimaSettlementModal()" style="background:transparent;color:#8b5cf6;border:1px solid #8b5cf6;padding:6px 12px;border-radius:4px;cursor:pointer;">
                        <i class="fa-solid fa-upload"></i> CSV Upload
                    </button>
                </div>
    
                <div style="max-height:400px;overflow-y:auto;border:1px solid #e8edf3;border-radius:6px;">
                    <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
                        <thead style="background:#f8fafc;position:sticky;top:0;z-index:10;">
                            <tr>
                                <th style="width:30px;padding:8px 12px;"><input type="checkbox" id="selectAllNhima" onchange="toggleAllNhimaClaims()"></th>
                                <th style="padding:8px 12px;text-align:left;">Claim #</th>
                                <th style="padding:8px 12px;text-align:left;">Customer</th>
                                <th style="padding:8px 12px;text-align:left;">NHIMA #</th>
                                <th style="padding:8px 12px;text-align:right;">Amount</th>
                                <th style="padding:8px 12px;text-align:right;">Paid</th>
                                <th style="padding:8px 12px;text-align:right;">Balance</th>
                                <th style="padding:8px 12px;text-align:center;">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${data.claimDetails.map((claim, index) => {
                                const statusColor = claim.isSettled ? '#10b981' : '#f59e0b';
                                return `
                                <tr style="border-bottom:1px solid #f1f5f9;${claim.isSettled ? 'opacity:0.6;' : ''}">
                                    <td style="padding:8px 12px;text-align:center;">
                                        <input type="checkbox" class="nhima-claim-checkbox" 
                                            data-index="${index}"
                                            data-claim-id="${claim.saleId}"
                                            data-claim-number="${claim.claimNumber}"
                                            data-amount="${claim.amount || 0}"
                                            data-balance="${claim.balance || 0}"
                                            data-customer="${claim.customerName}"
                                            data-nhima="${claim.nhimaNumber}"
                                            ${claim.isSettled ? 'disabled' : ''}
                                            onchange="updateNhimaSelection()">
                                    </td>
                                    <td style="padding:8px 12px;font-weight:500;">${claim.claimNumber}</td>
                                    <td style="padding:8px 12px;">${claim.customerName}</td>
                                    <td style="padding:8px 12px;font-family:monospace;font-size:0.8rem;">${claim.nhimaNumber}</td>
                                    <td style="padding:8px 12px;text-align:right;">ZK ${formatNumber(claim.amount)}</td>
                                    <td style="padding:8px 12px;text-align:right;color:#10b981;">ZK ${formatNumber(claim.paidAmount)}</td>
                                    <td style="padding:8px 12px;text-align:right;font-weight:600;color:${claim.balance > 0 ? '#dc2626' : '#10b981'};">ZK ${formatNumber(claim.balance)}</td>
                                    <td style="padding:8px 12px;text-align:center;">
                                        <span style="background:${statusColor}20;color:${statusColor};padding:2px 10px;border-radius:10px;font-size:0.7rem;font-weight:600;">${claim.isSettled ? 'Settled' : 'Pending'}</span>
                                    </td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
                <div id="nhimaSelectionSummary" style="margin-top:10px;padding:10px;background:#f8fafc;border-radius:6px;display:none;">
                    <div style="display:flex;gap:20px;flex-wrap:wrap;">
                        <span>Selected: <strong id="nhimaSelectedCount">0</strong> claims</span>
                        <span>Total Amount: <strong id="nhimaSelectedTotal">ZK 0.00</strong></span>
                        <span>Outstanding Balance: <strong id="nhimaSelectedBalance">ZK 0.00</strong></span>
                    </div>
                </div>
                <div style="margin-top:15px;padding:12px;background:#f0fdf4;border-radius:6px;border-left:4px solid #10b981;">
                    <p style="margin:0;font-size:0.85rem;color:#15803d;">
                        <i class="fa-solid fa-info-circle"></i>
                        <strong>Payment Method:</strong> NHIMA settlements are always processed via <strong>Bank Transfer (ZMW)</strong>
                    </p>
                </div>
            `;
    
            document.getElementById('nhimaBulkModalBody').innerHTML = html;
            modal.classList.add('show');
            window.updateNhimaSelection();
        };
    
        // ============================================
        // EXPORT NHIMA CLAIMS
        // ============================================
    
        window.exportNhimaClaims = function() {
            const data = calculateNhimaReceivables();
            if (!data.hasReceivable || data.claimDetails.length === 0) {
                safeToast('No NHIMA claims to export', 'error');
                return;
            }
    
            let csv = 'Claim Number,NHIMA Number,Customer,Date,Amount,Paid,Balance,Status\n';
            data.claimDetails.forEach(c => {
                const dateStr = c.date ? new Date(c.date).toISOString().split('T')[0] : '';
                csv += `"${c.claimNumber}","${c.nhimaNumber}","${c.customerName}","${dateStr}",${c.amount || 0},${c.paidAmount || 0},${c.balance || 0},${c.isSettled ? 'Settled' : 'Pending'}\n`;
            });
    
            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `NHIMA_Claims_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            safeToast('NHIMA Claims exported successfully!', 'success');
        };
    
        // ============================================
        // SIMPLIFIED RECEIPT FUNCTIONS - RETAIL
        // ============================================
    
        window.openRetailReceipt = function(customerId) {
            const modal = document.getElementById('retailReceiptModal');
            if (!modal) return;
    
            document.getElementById('retailReceiptDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('retailReceiptAmount').value = '';
            document.getElementById('retailReceiptMethod').value = 'Cash';
            document.getElementById('retailReceiptReference').value = '';
            document.getElementById('retailReceiptNotes').value = '';
            document.getElementById('retailCustomerInfo').style.display = 'none';
            document.getElementById('retailReceiptCustomerId').value = '';
    
            const customerData = calculateRetailReceivables().find(c => 
                c.customer._id === customerId || c.customer._customerId === customerId
            );
    
            if (!customerData) {
                safeToast('Customer not found', 'error');
                return;
            }
    
            state.currentRetailCustomerId = customerId;
            document.getElementById('retailCustomerName').textContent = customerData.customer._displayName;
            document.getElementById('retailCustomerPhone').textContent = customerData.customer._phone || '-';
            document.getElementById('retailCustomerType').textContent = customerData.customer._subType || 'REGULAR';
            document.getElementById('retailCustomerReceivable').textContent = `ZK${formatNumber(customerData.receivable)}`;
            document.getElementById('retailReceiptMaxAmount').textContent = `ZK${formatNumber(customerData.receivable)}`;
            document.getElementById('retailCustomerInfo').style.display = 'block';
    
            modal.classList.add('show');
        };
    
        // ============================================
        // SIMPLIFIED RECEIPT FUNCTIONS - WHOLESALE
        // ============================================
    
        window.openWholesaleReceipt = function(customerId) {
            const modal = document.getElementById('wholesaleReceiptModal');
            if (!modal) return;
    
            document.getElementById('wholesaleReceiptDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('wholesaleReceiptAmount').value = '';
            document.getElementById('wholesaleReceiptMethod').value = 'Cash';
            document.getElementById('wholesaleReceiptReference').value = '';
            document.getElementById('wholesaleReceiptNotes').value = '';
            document.getElementById('wholesaleCustomerInfo').style.display = 'none';
            document.getElementById('wholesaleReceiptCustomerId').value = '';
    
            const customerData = calculateWholesaleReceivables().find(c => 
                c.customer._id === customerId || c.customer._customerId === customerId
            );
    
            if (!customerData) {
                safeToast('Customer not found', 'error');
                return;
            }
    
            state.currentWholesaleCustomerId = customerId;
            document.getElementById('wholesaleCustomerName').textContent = customerData.customer._displayName;
            document.getElementById('wholesaleCustomerPhone').textContent = customerData.customer._phone || '-';
            document.getElementById('wholesaleCustomerType').textContent = customerData.customer._subType || 'REGULAR';
            document.getElementById('wholesaleCustomerReceivable').textContent = `ZK${formatNumber(customerData.receivable)}`;
            document.getElementById('wholesaleReceiptMaxAmount').textContent = `ZK${formatNumber(customerData.receivable)}`;
            document.getElementById('wholesaleCustomerInfo').style.display = 'block';
    
            modal.classList.add('show');
        };
    
        // ============================================
        // SAVE RETAIL RECEIPT
        // ============================================
    
        window.saveRetailReceipt = async function() {
            const customerId = document.getElementById('retailReceiptCustomerId').value || state.currentRetailCustomerId;
            const receiptDate = document.getElementById('retailReceiptDate').value;
            const amount = parseFloat(document.getElementById('retailReceiptAmount').value);
            const method = document.getElementById('retailReceiptMethod').value;
            const reference = document.getElementById('retailReceiptReference').value.trim();
            const notes = document.getElementById('retailReceiptNotes').value.trim();
    
            if (!customerId || !receiptDate || !amount || amount <= 0) {
                safeToast('Please fill in all required fields', 'error');
                return;
            }
    
            const customerData = calculateRetailReceivables().find(c => 
                c.customer._id === customerId || c.customer._customerId === customerId
            );
    
            if (!customerData) {
                safeToast('Customer not found', 'error');
                return;
            }
    
            if (amount > customerData.receivable) {
                safeToast(`Amount exceeds receivable (ZK${formatNumber(customerData.receivable)})`, 'error');
                return;
            }
    
            try {
                const receiptNumber = `RCT-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                const cust = customerData.customer;
                
                let validCustomerId = cust._customerId;
                
                if (!validCustomerId && cust._phone) {
                    const { data: foundCustomer, error: findError } = await supabaseClient
                        .from('customers')
                        .select('id, full_name, phone')
                        .eq('phone', cust._phone)
                        .maybeSingle();
                    if (!findError && foundCustomer) validCustomerId = foundCustomer.id;
                }
                
                if (!validCustomerId && cust._displayName) {
                    const { data: foundCustomer, error: findError } = await supabaseClient
                        .from('customers')
                        .select('id, full_name, phone')
                        .eq('full_name', cust._displayName)
                        .maybeSingle();
                    if (!findError && foundCustomer) validCustomerId = foundCustomer.id;
                }
                
                if (!validCustomerId) {
                    const phone = cust._phone || `CUST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                    const { data: newCustomer, error: createError } = await supabaseClient
                        .from('customers')
                        .insert([{
                            full_name: cust._displayName || 'Unknown Customer',
                            phone: phone,
                            address: cust._address || '',
                            customer_type: cust._subType || 'REGULAR',
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        }])
                        .select();
                    
                    if (createError || !newCustomer || newCustomer.length === 0) {
                        throw new Error('Failed to create customer record.');
                    }
                    validCustomerId = newCustomer[0].id;
                }
    
                const receiptData = {
                    receipt_number: receiptNumber,
                    receipt_date: receiptDate,
                    amount: amount,
                    payment_method: method,
                    reference_number: reference || null,
                    notes: notes || null,
                    status: 'Received',
                    customer_id: validCustomerId,
                    customer_type: cust._subType || 'REGULAR'
                };
    
                const { data: receipt, error: receiptError } = await supabaseClient
                    .from('customer_receipts')
                    .insert([receiptData])
                    .select();
    
                if (receiptError) throw receiptError;
    
                const receiptId = receipt[0].id;
                const receiptInvoices = [];
                let remainingAmount = amount;
    
                const outstandingInvoices = customerData.sales
                    .filter(sale => {
                        const paid = state.customerReceiptInvoices
                            .filter(ri => ri.sale_id === sale.id && !ri.is_opening_balance)
                            .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                        return (sale.grand_total || 0) - paid > 0.01;
                    })
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
                for (const sale of outstandingInvoices) {
                    if (remainingAmount <= 0) break;
                    const paid = state.customerReceiptInvoices
                        .filter(ri => ri.sale_id === sale.id && !ri.is_opening_balance)
                        .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                    const remaining = (sale.grand_total || 0) - paid;
                    const amountToPay = Math.min(remaining, remainingAmount);
    
                    if (amountToPay > 0) {
                        receiptInvoices.push({
                            receipt_id: receiptId,
                            sale_id: sale.id,
                            customer_id: validCustomerId,
                            amount_paid: amountToPay,
                            payment_date: receiptDate,
                            payment_method: method,
                            payment_reference: reference || null,
                            status: amountToPay >= remaining ? 'paid' : 'partial',
                            is_opening_balance: false
                        });
                        remainingAmount -= amountToPay;
                    }
                }
    
                if (remainingAmount > 0 && customerData.opening_balance_zmw > 0) {
                    const paidOpening = state.customerReceiptInvoices
                        .filter(ri => ri.customer_id === validCustomerId && ri.is_opening_balance === true)
                        .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                    const remainingOpening = customerData.opening_balance_zmw - paidOpening;
                    const amountToPay = Math.min(remainingOpening, remainingAmount);
                    if (amountToPay > 0) {
                        receiptInvoices.push({
                            receipt_id: receiptId,
                            customer_id: validCustomerId,
                            amount_paid: amountToPay,
                            payment_date: receiptDate,
                            payment_method: method,
                            payment_reference: reference || null,
                            status: amountToPay >= remainingOpening ? 'paid' : 'partial',
                            is_opening_balance: true
                        });
                        remainingAmount -= amountToPay;
                    }
                }
    
                if (receiptInvoices.length > 0) {
                    const { error: riError } = await supabaseClient
                        .from('customer_receipt_invoices')
                        .insert(receiptInvoices);
                    if (riError) {
                        await supabaseClient.from('customer_receipts').delete().eq('id', receiptId);
                        throw riError;
                    }
                }
    
                await createReceiptGLEntry({
                    receipt_number: receiptNumber,
                    receipt_date: receiptDate,
                    amount: amount,
                    payment_method: method,
                    customer_type: cust._subType || 'REGULAR'
                });
    
                state.currentReceiptData = { customer: cust, amount, receiptNumber, paymentMethod: method, reference, notes };
    
                safeToast(`Receipt recorded! ZK${formatNumber(amount)} received`, 'success');
                document.getElementById('retailReceiptModal').classList.remove('show');
    
                setTimeout(() => {
                    document.getElementById('printReceiptModal')?.classList.add('show');
                }, 500);
    
                await refreshReceivableList();
    
            } catch (error) {
                console.error('Error saving receipt:', error);
                safeToast('Error saving receipt: ' + error.message, 'error');
            }
        };
    
        // ============================================
        // SAVE WHOLESALE RECEIPT
        // ============================================
    
        window.saveWholesaleReceipt = async function() {
            const customerId = document.getElementById('wholesaleReceiptCustomerId').value || state.currentWholesaleCustomerId;
            const receiptDate = document.getElementById('wholesaleReceiptDate').value;
            const amount = parseFloat(document.getElementById('wholesaleReceiptAmount').value);
            const method = document.getElementById('wholesaleReceiptMethod').value;
            const reference = document.getElementById('wholesaleReceiptReference').value.trim();
            const notes = document.getElementById('wholesaleReceiptNotes').value.trim();
    
            if (!customerId || !receiptDate || !amount || amount <= 0) {
                safeToast('Please fill in all required fields', 'error');
                return;
            }
    
            const customerData = calculateWholesaleReceivables().find(c => 
                c.customer._id === customerId || c.customer._customerId === customerId
            );
    
            if (!customerData) {
                safeToast('Customer not found', 'error');
                return;
            }
    
            if (amount > customerData.receivable) {
                safeToast(`Amount exceeds receivable (ZK${formatNumber(customerData.receivable)})`, 'error');
                return;
            }
    
            try {
                const receiptNumber = `RCT-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                const cust = customerData.customer;
                
                let validCustomerId = cust._customerId;
                
                if (!validCustomerId && cust._phone) {
                    const { data: foundCustomer, error: findError } = await supabaseClient
                        .from('wholesale_customers')
                        .select('id, customer_name, phone')
                        .eq('phone', cust._phone)
                        .maybeSingle();
                    if (!findError && foundCustomer) validCustomerId = foundCustomer.id;
                }
                
                if (!validCustomerId && cust._displayName) {
                    const { data: foundCustomer, error: findError } = await supabaseClient
                        .from('wholesale_customers')
                        .select('id, customer_name, phone')
                        .eq('customer_name', cust._displayName)
                        .maybeSingle();
                    if (!findError && foundCustomer) validCustomerId = foundCustomer.id;
                }
                
                if (!validCustomerId) {
                    const phone = cust._phone || `WHOLESALE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                    const { data: newCustomer, error: createError } = await supabaseClient
                        .from('wholesale_customers')
                        .insert([{
                            customer_name: cust._displayName || 'Unknown Wholesale Customer',
                            phone: phone,
                            address: cust._address || '',
                            customer_type: cust._subType || 'REGULAR',
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        }])
                        .select();
                    
                    if (createError || !newCustomer || newCustomer.length === 0) {
                        throw new Error('Failed to create wholesale customer record.');
                    }
                    validCustomerId = newCustomer[0].id;
                }
    
                const receiptData = {
                    receipt_number: receiptNumber,
                    receipt_date: receiptDate,
                    amount: amount,
                    payment_method: method,
                    reference_number: reference || null,
                    notes: notes || null,
                    status: 'Received',
                    wholesale_customer_id: validCustomerId,
                    customer_type: 'WHOLESALE'
                };
    
                const { data: receipt, error: receiptError } = await supabaseClient
                    .from('customer_receipts')
                    .insert([receiptData])
                    .select();
    
                if (receiptError) throw receiptError;
    
                const receiptId = receipt[0].id;
                const receiptInvoices = [];
                let remainingAmount = amount;
    
                const outstandingInvoices = customerData.sales
                    .filter(sale => {
                        const paid = state.customerReceiptInvoices
                            .filter(ri => ri.sale_id === sale.id && !ri.is_opening_balance)
                            .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                        return (sale.grand_total || 0) - paid > 0.01;
                    })
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
                for (const sale of outstandingInvoices) {
                    if (remainingAmount <= 0) break;
                    const paid = state.customerReceiptInvoices
                        .filter(ri => ri.sale_id === sale.id && !ri.is_opening_balance)
                        .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                    const remaining = (sale.grand_total || 0) - paid;
                    const amountToPay = Math.min(remaining, remainingAmount);
    
                    if (amountToPay > 0) {
                        receiptInvoices.push({
                            receipt_id: receiptId,
                            sale_id: sale.id,
                            wholesale_customer_id: validCustomerId,
                            amount_paid: amountToPay,
                            payment_date: receiptDate,
                            payment_method: method,
                            payment_reference: reference || null,
                            status: amountToPay >= remaining ? 'paid' : 'partial',
                            is_opening_balance: false
                        });
                        remainingAmount -= amountToPay;
                    }
                }
    
                if (remainingAmount > 0 && customerData.opening_balance_zmw > 0) {
                    const paidOpening = state.customerReceiptInvoices
                        .filter(ri => ri.wholesale_customer_id === validCustomerId && ri.is_opening_balance === true)
                        .reduce((sum, ri) => sum + (ri.amount_paid || 0), 0);
                    const remainingOpening = customerData.opening_balance_zmw - paidOpening;
                    const amountToPay = Math.min(remainingOpening, remainingAmount);
                    if (amountToPay > 0) {
                        receiptInvoices.push({
                            receipt_id: receiptId,
                            wholesale_customer_id: validCustomerId,
                            amount_paid: amountToPay,
                            payment_date: receiptDate,
                            payment_method: method,
                            payment_reference: reference || null,
                            status: amountToPay >= remainingOpening ? 'paid' : 'partial',
                            is_opening_balance: true
                        });
                        remainingAmount -= amountToPay;
                    }
                }
    
                if (receiptInvoices.length > 0) {
                    const { error: riError } = await supabaseClient
                        .from('customer_receipt_invoices')
                        .insert(receiptInvoices);
                    if (riError) {
                        await supabaseClient.from('customer_receipts').delete().eq('id', receiptId);
                        throw riError;
                    }
                }
    
                await createReceiptGLEntry({
                    receipt_number: receiptNumber,
                    receipt_date: receiptDate,
                    amount: amount,
                    payment_method: method,
                    customer_type: 'WHOLESALE'
                });
    
                state.currentReceiptData = { customer: cust, amount, receiptNumber, paymentMethod: method, reference, notes };
    
                safeToast(`Receipt recorded! ZK${formatNumber(amount)} received`, 'success');
                document.getElementById('wholesaleReceiptModal').classList.remove('show');
    
                setTimeout(() => {
                    document.getElementById('printReceiptModal')?.classList.add('show');
                }, 500);
    
                await refreshReceivableList();
    
            } catch (error) {
                console.error('Error saving receipt:', error);
                safeToast('Error saving receipt: ' + error.message, 'error');
            }
        };
    
        // ============================================
        // GL ACCOUNTING ENTRY FOR RECEIPT
        // ============================================
    
        async function createReceiptGLEntry(receiptData) {
            try {
                const accountCodes = await getAccountCodesFromChartOfAccounts();
                if (!accountCodes) return createReceiptGLFallback(receiptData);
    
                const entryDate = receiptData.receipt_date || new Date().toISOString().split('T')[0];
                const journalNumber = `RCT-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    
                const cashMap = {
                    'Cash': accountCodes.cash_zmw || '1111',
                    'Bank Transfer': accountCodes.bank_zmw || '1121'
                };
                const cashAccount = cashMap[receiptData.payment_method] || accountCodes.cash_zmw || '1111';
                const receivableAccount = accountCodes.accounts_receivable || '1200';
    
                const { data: journal, error: journalError } = await supabaseClient
                    .from('journal_entries')
                    .insert([{
                        entry_date: entryDate,
                        reference: receiptData.receipt_number || journalNumber,
                        description: `Receipt: ${receiptData.receipt_number} - ${receiptData.customer_type || 'Customer'}`,
                        journal_number: journalNumber,
                        status: 'Posted',
                        created_at: new Date().toISOString()
                    }])
                    .select();
    
                if (journalError) throw journalError;
    
                await supabaseClient.from('journal_lines').insert([
                    {
                        journal_entry_id: journal[0].id,
                        account_code: cashAccount,
                        description: `${receiptData.payment_method} payment: ${receiptData.receipt_number}`,
                        debit: receiptData.amount,
                        credit: 0
                    },
                    {
                        journal_entry_id: journal[0].id,
                        account_code: receivableAccount,
                        description: `Clearing AR: ${receiptData.receipt_number}`,
                        debit: 0,
                        credit: receiptData.amount
                    }
                ]);
    
                console.log(`✅ GL Entry created for Receipt: ${journalNumber}`);
            } catch (error) {
                console.error('Error creating GL entry:', error);
                safeToast('Receipt saved, but GL entry failed', 'warning');
            }
        }
    
        async function createReceiptGLFallback(receiptData) {
            const entryDate = receiptData.receipt_date || new Date().toISOString().split('T')[0];
            const journalNumber = `RCT-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
            const cashMap = { 'Cash': '1111', 'Bank Transfer': '1121' };
            const cashAccount = cashMap[receiptData.payment_method] || '1111';
    
            const { data: journal } = await supabaseClient
                .from('journal_entries')
                .insert([{
                    entry_date: entryDate,
                    reference: receiptData.receipt_number || journalNumber,
                    description: `Receipt: ${receiptData.receipt_number}`,
                    journal_number: journalNumber,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                }])
                .select();
    
            if (journal) {
                await supabaseClient.from('journal_lines').insert([
                    { journal_entry_id: journal[0].id, account_code: cashAccount, debit: receiptData.amount, credit: 0, description: `${receiptData.payment_method} payment` },
                    { journal_entry_id: journal[0].id, account_code: '1200', debit: 0, credit: receiptData.amount, description: 'Clearing AR' }
                ]);
            }
        }
    
        // ============================================
        // STATEMENT FUNCTIONS
        // ============================================
    
        window.openRetailStatement = function(customerId) {
            const data = calculateRetailReceivables().find(c => c.customer._id === customerId || c.customer._customerId === customerId);
            if (!data) { safeToast('Customer not found', 'error'); return; }
            openStatement(data.customer, data);
        };
    
        window.openWholesaleStatement = function(customerId) {
            const data = calculateWholesaleReceivables().find(c => c.customer._id === customerId || c.customer._customerId === customerId);
            if (!data) { safeToast('Customer not found', 'error'); return; }
            openStatement(data.customer, data);
        };
    
        function openStatement(customer, customerData) {
            const transactions = [];
            const allEntries = [];
            let runningBalance = customerData.opening_balance_zmw || 0;
    
            if (runningBalance > 0) {
                transactions.push({ date: 'Opening Balance', type: 'Opening Balance', reference: 'Opening', amount: runningBalance, balance: runningBalance, isOpening: true });
            }
    
            customerData.sales?.forEach(sale => {
                allEntries.push({
                    date: new Date(sale.created_at),
                    type: `Sale (${customer._type || 'RETAIL'} ${customer._subType || 'REGULAR'})`,
                    reference: sale.sale_id,
                    amount: sale.grand_total || 0,
                    isReceipt: false
                });
            });
    
            customerData.receipts?.forEach(r => {
                allEntries.push({
                    date: new Date(r.receipt_date),
                    type: 'Receipt',
                    reference: r.receipt_number,
                    amount: -(r.amount || 0),
                    isReceipt: true,
                    method: r.payment_method
                });
            });
    
            allEntries.sort((a, b) => a.date - b.date);
    
            allEntries.forEach(entry => {
                runningBalance += entry.amount;
                transactions.push({
                    date: entry.date.toLocaleDateString(),
                    type: entry.type + (entry.method ? ' (' + entry.method + ')' : ''),
                    reference: entry.reference,
                    amount: entry.amount,
                    balance: runningBalance,
                    isReceipt: entry.isReceipt
                });
            });
    
            state.currentStatementData = {
                customer: customer,
                customerData: customerData,
                transactions: transactions,
                closingBalance: runningBalance,
                customerType: customer._type || 'RETAIL',
                customerSubType: customer._subType || 'REGULAR'
            };
    
            renderStatement(state.currentStatementData);
            
            const modal = document.getElementById('statementModal');
            if (modal) modal.classList.add('show');
        }
    
        function renderStatement(data) {
            const { customer, customerData, transactions, closingBalance, customerType, customerSubType } = data;
            const typeDisplay = `${customerType} (${customerSubType})`;
            const openingBalance = customerData?.opening_balance_zmw || 0;
            const totalSales = customerData?.totalSales || 0;
            const totalReceived = customerData?.totalReceived || 0;
    
            let html = `
                <div class="statement-header">
                    <h2>${customer._displayName}</h2>
                    <p>${customer._address || ''} ${customer._phone ? '| Phone: ' + customer._phone : ''}</p>
                    <p>Client Type: <strong>${typeDisplay}</strong></p>
                    ${customer.nhima_number ? `<p>NHIMA #: ${customer.nhima_number}</p>` : ''}
                </div>
                <div class="statement-info">
                    <table>
                        <tr>
                            <td class="label">Opening Balance:</td>
                            <td>ZK${formatNumber(openingBalance)}</td>
                            <td class="label">Total Sales:</td>
                            <td>ZK${formatNumber(totalSales)}</td>
                        </tr>
                        <tr>
                            <td class="label">Total Received:</td>
                            <td>ZK${formatNumber(totalReceived)}</td>
                            <td class="label">Closing Balance:</td>
                            <td style="font-weight:bold;color:${closingBalance > 0 ? '#dc2626' : '#15803d'};">
                                ZK${formatNumber(closingBalance)}
                            </td>
                        </tr>
                    </table>
                </div>
                <table class="statement-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>Reference</th>
                            <th style="text-align:right;">Amount</th>
                            <th style="text-align:right;">Balance</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${transactions.map(t => {
                            const isReceipt = t.isReceipt;
                            const amountClass = isReceipt ? 'credit' : (t.amount > 0 ? 'debit' : '');
                            const amountDisplay = isReceipt ? `(ZK${formatNumber(Math.abs(t.amount))})` : `ZK${formatNumber(t.amount)}`;
                            return `<tr>
                                <td>${t.date}</td>
                                <td>${t.type}</td>
                                <td>${t.reference}</td>
                                <td class="text-right ${amountClass}">${amountDisplay}</td>
                                <td class="text-right">ZK${formatNumber(t.balance)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                    <tfoot>
                        <tr class="total-row">
                            <td colspan="4" style="text-align:right;">Closing Balance:</td>
                            <td style="text-align:right;color:${closingBalance > 0 ? '#dc2626' : '#15803d'};">
                                ZK${formatNumber(closingBalance)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            `;
            
            const content = document.getElementById('statementContent');
            if (content) content.innerHTML = html;
        }
    
        // ============================================
        // PRINT FUNCTIONS
        // ============================================
    
        window.printStatement = function() {
            const data = state.currentStatementData;
            if (!data) { safeToast('No statement data to print', 'error'); return; }
    
            const { customer, customerData, transactions, closingBalance, customerType, customerSubType } = data;
            const printWindow = window.open('', '_blank', 'width=800,height=600');
            if (!printWindow) { safeToast('Please allow popups', 'error'); return; }
    
            printWindow.document.write(`
                <!DOCTYPE html><html><head><title>Statement - ${customer._displayName}</title>
                <style>
                    body{font-family:Arial;padding:20px;max-width:1000px;margin:0 auto;}
                    .statement-header{text-align:center;border-bottom:2px solid #333;padding-bottom:15px;margin-bottom:20px;}
                    .statement-header h2{margin:0;color:#0f172a;}
                    .statement-info{background:#f8fafc;padding:15px;border-radius:6px;margin-bottom:20px;}
                    .statement-info td{padding:4px 8px;}.statement-info .label{font-weight:600;width:150px;}
                    table{width:100%;border-collapse:collapse;margin:15px 0;font-size:0.9rem;}
                    th{background:#f1f5f9;padding:10px;text-align:left;border:1px solid #e2e8f0;}
                    td{padding:10px;border:1px solid #e2e8f0;}
                    .text-right{text-align:right;}.total-row{font-weight:bold;background:#f8fafc;}
                    .credit{color:#15803d;}.debit{color:#dc2626;}
                </style></head>
                <body>
                    <div class="statement-header">
                        <h2>${customer._displayName}</h2>
                        <p>${customer._address || ''} ${customer._phone ? '| Phone: ' + customer._phone : ''}</p>
                        <p>Client Type: <strong>${customerType} (${customerSubType})</strong></p>
                    </div>
                    <div class="statement-info"><table>
                        <tr><td class="label">Opening Balance:</td><td>ZK${formatNumber(customerData?.opening_balance_zmw || 0)}</td>
                            <td class="label">Total Sales:</td><td>ZK${formatNumber(customerData?.totalSales || 0)}</td></tr>
                        <tr><td class="label">Total Received:</td><td>ZK${formatNumber(customerData?.totalReceived || 0)}</td>
                            <td class="label">Closing Balance:</td><td style="font-weight:bold;color:${closingBalance > 0 ? '#dc2626' : '#15803d'};">ZK${formatNumber(closingBalance)}</td></tr>
                    </table></div>
                    <table>
                        <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th style="text-align:right;">Amount</th><th style="text-align:right;">Balance</th></tr></thead>
                        <tbody>${transactions.map(t => {
                            const amountDisplay = t.isReceipt ? `(ZK${formatNumber(Math.abs(t.amount))})` : `ZK${formatNumber(t.amount)}`;
                            return `<tr><td>${t.date}</td><td>${t.type}</td><td>${t.reference}</td><td class="text-right ${t.isReceipt ? 'credit' : 'debit'}">${amountDisplay}</td><td class="text-right">ZK${formatNumber(t.balance)}</td></tr>`;
                        }).join('')}</tbody>
                        <tfoot><tr class="total-row"><td colspan="4" style="text-align:right;">Closing Balance:</td><td style="text-align:right;color:${closingBalance > 0 ? '#dc2626' : '#15803d'};">ZK${formatNumber(closingBalance)}</td></tr></tfoot>
                    </table>
                    <div style="text-align:center;margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:0.9rem;">
                        <p>Generated on: ${new Date().toLocaleString()}</p>
                    </div>
                </body></html>
            `);
            printWindow.document.close();
            setTimeout(() => { printWindow.focus(); printWindow.print(); }, 500);
        };
    
        window.printReceiptDocument = async function() {
            const data = state.currentReceiptData;
            if (!data) { safeToast('No receipt data to print', 'error'); return; }

            // 🔥 CHANGED: the shared window-level getCompanySettings() helper
            // (assets/js/shared-company-settings.js) no longer exists on the
            // site, so calling it here threw "getCompanySettings is not
            // defined" the moment a receipt was printed. Self-contained now:
            // reads the same single `company_settings` row directly, with a
            // hardcoded fallback if that fails for any reason.
            let companySettings;
            try {
                const { data: settingsRow, error: settingsError } = await supabaseClient
                    .from('company_settings')
                    .select('company_name, address, phone')
                    .eq('id', 1)
                    .maybeSingle();
                companySettings = (!settingsError && settingsRow) ? {
                    company_name: settingsRow.company_name || 'GRIFFINS MEDICALS LIMITED',
                    address: settingsRow.address || 'Plot 3534, Freedomway, Lusaka',
                    phone: settingsRow.phone || '+260 97 000 0000'
                } : { company_name: 'GRIFFINS MEDICALS LIMITED', address: 'Plot 3534, Freedomway, Lusaka', phone: '+260 97 000 0000' };
            } catch (e) {
                console.warn('Could not load company_settings, using defaults:', e);
                companySettings = { company_name: 'GRIFFINS MEDICALS LIMITED', address: 'Plot 3534, Freedomway, Lusaka', phone: '+260 97 000 0000' };
            }

            const { customer, amount, receiptNumber, paymentMethod, reference, notes } = data;
            const printWindow = window.open('', '_blank', 'width=420,height=600,scrollbars=yes');
            if (!printWindow) { safeToast('Please allow popups', 'error'); return; }

            printWindow.document.write(`
                <!DOCTYPE html><html><head><title>Receipt - ${receiptNumber}</title>
                <style>
                    body{font-family:'Courier New',monospace;padding:20px;max-width:400px;margin:0 auto;background:white;}
                    .header{text-align:center;border-bottom:2px dashed #333;padding-bottom:10px;margin-bottom:15px;}
                    .header h2{margin:0;font-size:1.2rem;}
                    .header p{margin:3px 0;font-size:0.85rem;color:#475569;}
                    .receipt-info{margin-bottom:15px;font-size:0.85rem;}
                    .receipt-info div{padding:2px 0;}
                    .receipt-info .label{font-weight:600;display:inline-block;width:120px;}
                    .footer{text-align:center;margin-top:20px;padding-top:15px;border-top:2px dashed #333;font-size:0.8rem;color:#64748b;}
                    hr{border:1px dashed #e2e8f0;}
                    .amount-display{text-align:center;margin:15px 0;}
                    .amount-display .label{font-size:0.9rem;color:#475569;}
                    .amount-display .amount{font-size:2rem;font-weight:bold;color:#059669;margin:5px 0;}
                </style></head>
                <body>
                    <div class="header">
                        <h2>${companySettings.company_name}</h2>
                        <p>${companySettings.address}</p>
                        <p>Phone: ${companySettings.phone}</p>
                    </div>
                    <div class="receipt-info">
                        <div><span class="label">Receipt #:</span> ${receiptNumber || 'N/A'}</div>
                        <div><span class="label">Date:</span> ${new Date().toLocaleString()}</div>
                        <div><span class="label">Customer:</span> ${customer._displayName || 'N/A'}</div>
                        <div><span class="label">Phone:</span> ${customer._phone || 'N/A'}</div>
                        <div><span class="label">Payment Method:</span> ${paymentMethod || 'Cash'}</div>
                        ${reference ? `<div><span class="label">Reference:</span> ${reference}</div>` : ''}
                        ${notes ? `<div><span class="label">Notes:</span> ${notes}</div>` : ''}
                    </div>
                    <hr>
                    <div class="amount-display">
                        <div class="label">Amount Received</div>
                        <div class="amount">ZK${formatNumber(amount)}</div>
                    </div>
                    <hr>
                    <div class="footer"><p>Thank you for your payment!</p><p>This is a computer-generated receipt.</p></div>
                    <script>window.onload=function(){window.print();};<\/script>
                </body></html>
            `);
            printWindow.document.close();
            printWindow.focus();
        };
    
        // ============================================
        // CLOSE MODAL FUNCTIONS
        // ============================================
    
        window.closeRetailReceiptModal = function() {
            document.getElementById('retailReceiptModal').classList.remove('show');
        };
    
        window.closeWholesaleReceiptModal = function() {
            document.getElementById('wholesaleReceiptModal').classList.remove('show');
        };
    
        window.closeModal = function(modalId) {
            document.getElementById(modalId)?.classList.remove('show');
        };
    
        // ============================================
        // HELPER FUNCTIONS
        // ============================================
    
        async function createBadDebtWriteOff(saleId, amount, claimNumber) {
            const journalNumber = `WRITE-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
            const { data: journal } = await supabaseClient.from('journal_entries').insert([{
                entry_date: new Date().toISOString().split('T')[0],
                reference: `NHIMA-REJECT-${claimNumber}`,
                description: `NHIMA claim ${claimNumber} rejected. Write-off.`,
                journal_number: journalNumber,
                status: 'Posted'
            }]).select();
    
            if (journal) {
                await supabaseClient.from('journal_lines').insert([
                    { journal_entry_id: journal[0].id, account_code: '6900', debit: amount, credit: 0, description: 'Bad Debt Expense' },
                    { journal_entry_id: journal[0].id, account_code: '1200', debit: 0, credit: amount, description: 'Write-off AR' }
                ]);
            }
        }
    
        window.downloadNhimaTemplate = function() {
            const headers = ['ClaimNumber', 'NHIMANumber', 'PatientName', 'Amount', 'Status'];
            const csv = headers.join(',') + '\nNHIMA-CLAIM-001,12345,John Doe,500.00,ACCEPTED';
            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'NHIMA_Settlement_Template.csv';
            a.click();
            URL.revokeObjectURL(url);
            safeToast('Template downloaded!', 'success');
        };
    
        window.refreshReceivableList = async function() {
            await loadCustomers();
            await loadReceipts();
            await loadSales();
            await loadCustomerReceiptInvoices();
            renderAllTables();
        };
    
        // ============================================
        // INITIALIZE
        // ============================================
        await ensureChartOfAccounts();
        await loadCustomers();
        await loadReceipts();
        await loadSales();
        await loadCustomerReceiptInvoices();
        renderAllTables();
    
        window._receivablesInitLock = false;
        console.log("✅ Receivables module initialized!");
    };
    
    // ============================================
    // START THE MODULE
    // ============================================
    window.initReceivablePage();
    
    })();