// ============================================
// FIXED ASSETS MODULE
// ============================================

(async function initFixedAssets() {
    console.log("🏢 Fixed Assets module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        assets: [],
        depreciationEntries: [],
        currentViewData: null,
        depreciationMethods: ['straight-line', 'declining-balance', 'units-of-production']
    };

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // This module never posted anything when a NEW asset was registered
    // -- only depreciation touched the ledger. One dedicated Fixed Asset
    // account per category (so the Balance Sheet can break down what you
    // actually own), reusing the Accumulated Depreciation (1260) and
    // Depreciation Expense (6280) codes already hardcoded elsewhere in
    // this file, plus Gain/Loss on Disposal and the same
    // Cash/Bank/Payable accounts used everywhere else in this system.
    const CATEGORY_ACCOUNT_CODES = {
        'Furniture': '1210',
        'IT Equipment': '1220',
        'Vehicles': '1230',
        'Office Equipment': '1240',
        'Medical Equipment': '1250',
        'Other': '1255'
    };

    const REQUIRED_ACCOUNTS = [
        ...Object.entries(CATEGORY_ACCOUNT_CODES).map(([cat, code]) => ({
            code, name: `Fixed Assets - ${cat}`, type: 'Asset', category: 'Fixed Asset', normal_balance: 'Debit'
        })),
        { code: '1260', name: 'Accumulated Depreciation', type: 'Asset', category: 'Fixed Asset', normal_balance: 'Credit' },
        { code: '6280', name: 'Depreciation Expense', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' },
        { code: '7200', name: 'Gain/Loss on Disposal of Assets', type: 'Expense', category: 'Other', normal_balance: 'Debit' },
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1120', name: 'Bank - USD', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '2001', name: 'Accounts Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' }
    ];

    async function ensureChartOfAccounts() {
        try {
            for (const account of REQUIRED_ACCOUNTS) {
                const { data: existing } = await supabaseClient
                    .from('chart_of_accounts')
                    .select('code')
                    .eq('code', account.code)
                    .maybeSingle();
                if (existing) continue;

                await supabaseClient.from('chart_of_accounts').insert([{
                    code: account.code,
                    name: account.name,
                    type: account.type,
                    category: account.category,
                    normal_balance: account.normal_balance,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }]);
            }
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
        }
    }

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadAssets() {
        try {
            const { data, error } = await supabaseClient
                .from('fixed_assets')
                .select('*')
                .order('purchase_date', { ascending: false });

            if (error) {
                console.warn('fixed_assets table not found, using empty state');
                state.assets = [];
                return [];
            }
            state.assets = data || [];
            console.log(`✅ Loaded ${state.assets.length} assets`);
            return state.assets;
        } catch (error) {
            console.error('Error loading assets:', error);
            state.assets = [];
            return [];
        }
    }

    async function loadDepreciationEntries() {
        try {
            const { data, error } = await supabaseClient
                .from('depreciation_entries')
                .select('*')
                .order('entry_date', { ascending: false });

            if (error) {
                console.warn('depreciation_entries table not found');
                state.depreciationEntries = [];
                return [];
            }
            state.depreciationEntries = data || [];
            return state.depreciationEntries;
        } catch (error) {
            console.error('Error loading depreciation entries:', error);
            state.depreciationEntries = [];
            return [];
        }
    }

    // ============================================
    // CALCULATE DEPRECIATION
    // ============================================

    function calculateDepreciation(asset, months = 0) {
        const cost = asset.cost || 0;
        const salvageValue = asset.salvage_value || 0;
        const usefulLife = asset.useful_life || 5; // in years
        const method = asset.depreciation_method || 'straight-line';
        const currentDepreciation = asset.accumulated_depreciation || 0;

        let annualDepreciation = 0;
        let monthlyDepreciation = 0;
        let totalDepreciation = 0;
        let netBookValue = cost - currentDepreciation;

        switch (method) {
            case 'straight-line':
                annualDepreciation = (cost - salvageValue) / usefulLife;
                monthlyDepreciation = annualDepreciation / 12;
                break;
            case 'declining-balance':
                const rate = 2 / usefulLife; // Double declining balance
                annualDepreciation = netBookValue * rate;
                monthlyDepreciation = annualDepreciation / 12;
                break;
            case 'units-of-production':
                // Simplified - assume 1000 units per year
                const unitsPerYear = 1000;
                const totalUnits = usefulLife * unitsPerYear;
                const perUnit = (cost - salvageValue) / totalUnits;
                monthlyDepreciation = perUnit * (unitsPerYear / 12);
                annualDepreciation = monthlyDepreciation * 12;
                break;
            default:
                annualDepreciation = (cost - salvageValue) / usefulLife;
                monthlyDepreciation = annualDepreciation / 12;
        }

        // Calculate total depreciation if we run for 'months' months
        const depreciationToAdd = monthlyDepreciation * months;
        totalDepreciation = currentDepreciation + depreciationToAdd;
        
        // Ensure we don't exceed cost - salvage value
        const maxDepreciation = cost - salvageValue;
        if (totalDepreciation > maxDepreciation) {
            totalDepreciation = maxDepreciation;
        }

        return {
            annualDepreciation,
            monthlyDepreciation,
            totalDepreciation,
            netBookValue: cost - totalDepreciation,
            remainingLife: Math.max(0, usefulLife - (totalDepreciation / annualDepreciation)),
            isFullyDepreciated: totalDepreciation >= maxDepreciation
        };
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderStats() {
        const assets = state.assets;
        const total = assets.length;
        const totalCost = assets.reduce((sum, a) => sum + (a.cost || 0), 0);
        const totalDepreciation = assets.reduce((sum, a) => sum + (a.accumulated_depreciation || 0), 0);
        const netBookValue = totalCost - totalDepreciation;

        document.getElementById('totalAssets').textContent = total;
        document.getElementById('totalCost').textContent = `ZMW ${formatNumber(totalCost)}`;
        document.getElementById('totalDepreciation').textContent = `ZMW ${formatNumber(totalDepreciation)}`;
        document.getElementById('netBookValue').textContent = `ZMW ${formatNumber(netBookValue)}`;
    }

    function renderAssets(data = null) {
        const assets = data || state.assets;
        const tbody = document.getElementById('faTableBody');
        const countSpan = document.getElementById('faListCount');
        const countMain = document.getElementById('faCount');

        if (!tbody) return;

        // Apply filters
        const searchTerm = document.getElementById('searchFA')?.value?.toLowerCase() || '';
        const categoryFilter = document.getElementById('faCategoryFilter')?.value || 'all';
        const statusFilter = document.getElementById('faStatusFilter')?.value || 'all';

        let filtered = assets;

        if (searchTerm) {
            filtered = filtered.filter(a => 
                a.name.toLowerCase().includes(searchTerm) ||
                (a.asset_code || '').toLowerCase().includes(searchTerm) ||
                (a.serial_number || '').toLowerCase().includes(searchTerm)
            );
        }

        if (categoryFilter !== 'all') {
            filtered = filtered.filter(a => a.category === categoryFilter);
        }

        if (statusFilter !== 'all') {
            filtered = filtered.filter(a => a.status === statusFilter);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                ${assets.length === 0 ? 'No fixed assets registered yet.' : 'No assets match the filters.'}
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 assets';
            if (countMain) countMain.textContent = '0 assets';
            return;
        }

        const getStatusBadge = (status) => {
            const map = {
                'Active': 'status-active',
                'Fully Depreciated': 'status-fully-depreciated',
                'Disposed': 'status-disposed'
            };
            return map[status] || 'status-active';
        };

        const getCategoryBadge = (category) => {
            const colors = {
                'Furniture': '#fef3c7',
                'IT Equipment': '#dbeafe',
                'Vehicles': '#dcfce7',
                'Office Equipment': '#e0e7ff',
                'Medical Equipment': '#fce7f3',
                'Other': '#f1f5f9'
            };
            const textColors = {
                'Furniture': '#b45309',
                'IT Equipment': '#1d4ed8',
                'Vehicles': '#15803d',
                'Office Equipment': '#4338ca',
                'Medical Equipment': '#be185d',
                'Other': '#475569'
            };
            return { bg: colors[category] || '#f1f5f9', text: textColors[category] || '#475569' };
        };

        tbody.innerHTML = filtered.map(a => {
            const dep = calculateDepreciation(a);
            const statusClass = getStatusBadge(a.status || 'Active');
            const cat = getCategoryBadge(a.category);

            return `
            <tr>
                <td style="padding-left: 20px; font-family: monospace; font-weight: 600;">${a.asset_code || 'N/A'}</td>
                <td><strong>${a.name}</strong></td>
                <td>
                    <span style="background: ${cat.bg}; color: ${cat.text}; padding: 2px 10px; border-radius: 10px; font-size: 0.7rem; font-weight: 500;">
                        ${a.category || '-'}
                    </span>
                </td>
                <td>${formatDate(a.purchase_date)}</td>
                <td style="text-align: right; font-weight: 500;">ZMW ${formatNumber(a.cost || 0)}</td>
                <td style="text-align: right; color: #f59e0b;">ZMW ${formatNumber(a.accumulated_depreciation || 0)}</td>
                <td style="text-align: right; font-weight: 600; color: ${dep.netBookValue > 0 ? '#2563eb' : '#94a3b8'};">ZMW ${formatNumber(dep.netBookValue)}</td>
                <td style="text-align: center;">
                    <span class="status-badge ${statusClass}">${a.status || 'Active'}</span>
                </td>
                <td style="text-align: center;">
                    <button class="btn btn-sm btn-outline" onclick="viewAsset('${a.id}')" title="View Details">
                        <i class="fa-regular fa-eye"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="editAsset('${a.id}')" title="Edit" style="color: #f59e0b;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="viewDepreciationHistory('${a.id}')" title="Depreciation History" style="color: #8b5cf6;">
                        <i class="fa-regular fa-clock"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="deleteAsset('${a.id}')" title="Delete" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');

        if (countSpan) countSpan.textContent = `${filtered.length} assets`;
        if (countMain) countMain.textContent = `${filtered.length} assets`;
    }

    // ============================================
    // ASSET CRUD OPERATIONS
    // ============================================

    function openNewAsset() {
        const modal = document.getElementById('assetModal');
        const title = document.getElementById('assetModalTitle');
        const form = document.getElementById('assetForm');
        const editId = document.getElementById('editAssetId');

        title.innerHTML = `<i class="fa-solid fa-plus"></i> New Asset`;
        editId.value = '';
        form.reset();

        // Set default values
        document.getElementById('assetPurchaseDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('assetUsefulLife').value = 5;
        document.getElementById('assetStatus').value = 'Active';
        document.getElementById('assetDepreciationMethod').value = 'straight-line';
        document.getElementById('depreciationPreview').style.display = 'none';

        // Generate asset code
        const count = state.assets.length + 1;
        document.getElementById('assetCode').value = `FA-${String(count).padStart(4, '0')}`;

        modal.classList.add('show');
    }

    async function editAsset(assetId) {
        try {
            const asset = state.assets.find(a => a.id === assetId);
            if (!asset) {
                showToast('Asset not found', 'error');
                return;
            }

            const modal = document.getElementById('assetModal');
            const title = document.getElementById('assetModalTitle');
            const editId = document.getElementById('editAssetId');

            title.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit Asset`;
            editId.value = assetId;

            document.getElementById('assetCode').value = asset.asset_code || '';
            document.getElementById('assetName').value = asset.name || '';
            document.getElementById('assetCategory').value = asset.category || '';
            document.getElementById('assetPurchaseDate').value = asset.purchase_date || '';
            document.getElementById('assetCost').value = asset.cost || '';
            document.getElementById('assetUsefulLife').value = asset.useful_life || 5;
            document.getElementById('assetSalvageValue').value = asset.salvage_value || 0;
            document.getElementById('assetDepreciationMethod').value = asset.depreciation_method || 'straight-line';
            document.getElementById('assetSerialNumber').value = asset.serial_number || '';
            document.getElementById('assetStatus').value = asset.status || 'Active';
            document.getElementById('assetDescription').value = asset.description || '';

            // Show depreciation preview
            showDepreciationPreview();

            modal.classList.add('show');
        } catch (error) {
            console.error('Error loading asset for edit:', error);
            showToast('Error loading asset: ' + error.message, 'error');
        }
    }

    async function deleteAsset(assetId) {
        // 🔥 FIX: this used to hard-delete the row outright -- any
        // depreciation entries already posted for this asset would stay
        // in the ledger forever, permanently referencing an asset that no
        // longer exists anywhere. Now performs a proper disposal instead:
        // reverses the asset's cost and accumulated depreciation from the
        // books, records any gain/loss, and marks it Disposed rather than
        // deleting it -- the standard accounting treatment, and it keeps
        // the asset register as an audit trail.
        const asset = state.assets.find(a => a.id === assetId);
        if (!asset) { showToast('Asset not found', 'error'); return; }

        if (asset.status === 'Disposed') {
            showToast('This asset is already disposed.', 'warning');
            return;
        }

        const proceedsStr = prompt(
            `Dispose "${asset.name}"?\n\nIf you received any money for it (sold/traded in), enter the amount. Leave blank or 0 if it was scrapped/written off with nothing received.`,
            '0'
        );
        if (proceedsStr === null) return; // cancelled

        const proceeds = parseFloat(proceedsStr) || 0;
        const cost = asset.cost || 0;
        const accumulatedDep = asset.accumulated_depreciation || 0;
        const netBookValue = cost - accumulatedDep;
        const gainLoss = proceeds - netBookValue; // positive = gain, negative = loss

        if (!confirm(`Net book value: ZMW ${formatNumber(netBookValue)}\nProceeds received: ZMW ${formatNumber(proceeds)}\n${gainLoss >= 0 ? 'Gain' : 'Loss'}: ZMW ${formatNumber(Math.abs(gainLoss))}\n\nPost this disposal?`)) {
            return;
        }

        try {
            await ensureChartOfAccounts();
            const assetAccountCode = CATEGORY_ACCOUNT_CODES[asset.category] || CATEGORY_ACCOUNT_CODES['Other'];

            const entryData = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: asset.asset_code,
                description: `Disposal: ${asset.name} (${asset.asset_code})`,
                journal_number: `DISP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: entry, error: entryError } = await supabaseClient.from('journal_entries').insert([entryData]).select();
            if (entryError) throw entryError;

            const lines = [];
            // Remove accumulated depreciation (debit clears the contra-asset)
            if (accumulatedDep > 0) {
                lines.push({ journal_entry_id: entry[0].id, account_code: '1260', description: `Clear accumulated depreciation: ${asset.name}`, debit: accumulatedDep, credit: 0 });
            }
            // Cash/bank received, if any (defaults to Cash in Hand -- no field for this in the simple prompt flow)
            if (proceeds > 0) {
                lines.push({ journal_entry_id: entry[0].id, account_code: '1111', description: `Proceeds from disposal: ${asset.name}`, debit: proceeds, credit: 0 });
            }
            // Gain or loss balances the entry
            if (gainLoss > 0) {
                lines.push({ journal_entry_id: entry[0].id, account_code: '7200', description: `Gain on disposal: ${asset.name}`, debit: 0, credit: gainLoss });
            } else if (gainLoss < 0) {
                lines.push({ journal_entry_id: entry[0].id, account_code: '7200', description: `Loss on disposal: ${asset.name}`, debit: Math.abs(gainLoss), credit: 0 });
            }
            // Remove the asset at original cost
            lines.push({ journal_entry_id: entry[0].id, account_code: assetAccountCode, description: `Asset disposed: ${asset.name}`, debit: 0, credit: cost });

            const { error: lineError } = await supabaseClient.from('journal_lines').insert(lines);
            if (lineError) throw lineError;

            await supabaseClient
                .from('fixed_assets')
                .update({ status: 'Disposed', updated_at: new Date().toISOString() })
                .eq('id', assetId);

            showToast(`Asset disposed. ${gainLoss >= 0 ? 'Gain' : 'Loss'} of ZMW ${formatNumber(Math.abs(gainLoss))} recorded.`, 'success');
            await refreshFixedAssets();
        } catch (error) {
            console.error('Error disposing asset:', error);
            showToast('Error disposing asset: ' + error.message, 'error');
        }
    }

    async function viewAsset(assetId) {
        try {
            const asset = state.assets.find(a => a.id === assetId);
            if (!asset) {
                showToast('Asset not found', 'error');
                return;
            }

            state.currentViewData = asset;
            const dep = calculateDepreciation(asset);

            const content = document.getElementById('viewAssetContent');
            const cat = asset.category || 'Other';

            content.innerHTML = `
                <div class="view-detail-row">
                    <span class="label">Asset Code</span>
                    <span class="value"><strong style="font-family: monospace;">${asset.asset_code || 'N/A'}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Asset Name</span>
                    <span class="value"><strong>${asset.name}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Category</span>
                    <span class="value"><span style="background: #f1f5f9; color: #475569; padding: 2px 10px; border-radius: 10px; font-size: 0.75rem;">${cat}</span></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Purchase Date</span>
                    <span class="value">${formatDate(asset.purchase_date)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Cost</span>
                    <span class="value" style="font-weight: 600; color: #2563eb;">ZMW ${formatNumber(asset.cost || 0)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Accumulated Depreciation</span>
                    <span class="value" style="color: #f59e0b;">ZMW ${formatNumber(asset.accumulated_depreciation || 0)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Net Book Value</span>
                    <span class="value" style="font-weight: 700; font-size: 1.1rem; color: ${dep.netBookValue > 0 ? '#2563eb' : '#94a3b8'};">ZMW ${formatNumber(dep.netBookValue)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Useful Life</span>
                    <span class="value">${asset.useful_life || 5} years</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Salvage Value</span>
                    <span class="value">ZMW ${formatNumber(asset.salvage_value || 0)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Depreciation Method</span>
                    <span class="value">${(asset.depreciation_method || 'straight-line').replace('-', ' ').toUpperCase()}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Annual Depreciation</span>
                    <span class="value">ZMW ${formatNumber(dep.annualDepreciation)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Monthly Depreciation</span>
                    <span class="value">ZMW ${formatNumber(dep.monthlyDepreciation)}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Remaining Life</span>
                    <span class="value">${dep.remainingLife.toFixed(1)} years</span>
                </div>
                ${asset.serial_number ? `
                <div class="view-detail-row">
                    <span class="label">Serial Number</span>
                    <span class="value">${asset.serial_number}</span>
                </div>
                ` : ''}
                ${asset.description ? `
                <div class="view-detail-row">
                    <span class="label">Description</span>
                    <span class="value">${asset.description}</span>
                </div>
                ` : ''}
                <div class="view-detail-row" style="border-bottom: none;">
                    <span class="label">Status</span>
                    <span class="value"><span class="status-badge ${asset.status === 'Active' ? 'status-active' : asset.status === 'Fully Depreciated' ? 'status-fully-depreciated' : 'status-disposed'}">${asset.status || 'Active'}</span></span>
                </div>
            `;

            document.getElementById('viewAssetModal').classList.add('show');
        } catch (error) {
            console.error('Error viewing asset:', error);
            showToast('Error loading asset details: ' + error.message, 'error');
        }
    }

    function printAsset() {
        const asset = state.currentViewData;
        if (!asset) {
            showToast('No asset to print', 'error');
            return;
        }

        const dep = calculateDepreciation(asset);
        const printWindow = window.open('', '_blank', 'width=600,height=500');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Asset Details - ${asset.name}</title>
                <style>
                    body { font-family: 'Courier New', monospace; padding: 20px; max-width: 600px; margin: 0 auto; }
                    h2 { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; }
                    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
                    td { padding: 6px 8px; border-bottom: 1px solid #eee; }
                    .label { font-weight: 600; width: 40%; }
                    .value { font-weight: 500; }
                    .total { font-weight: 700; font-size: 1.1rem; }
                    .footer { text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; color: #666; font-size: 0.8rem; }
                    @media print { body { margin: 0; padding: 10px; } }
                </style>
            </head>
            <body>
                <h2>${asset.asset_code || 'Asset'}</h2>
                <table>
                    <tr><td class="label">Asset Name</td><td class="value">${asset.name}</td></tr>
                    <tr><td class="label">Category</td><td class="value">${asset.category || '-'}</td></tr>
                    <tr><td class="label">Purchase Date</td><td class="value">${formatDate(asset.purchase_date)}</td></tr>
                    <tr><td class="label">Cost</td><td class="value">ZMW ${formatNumber(asset.cost || 0)}</td></tr>
                    <tr><td class="label">Accumulated Depreciation</td><td class="value">ZMW ${formatNumber(asset.accumulated_depreciation || 0)}</td></tr>
                    <tr><td class="label total">Net Book Value</td><td class="value total">ZMW ${formatNumber(dep.netBookValue)}</td></tr>
                    <tr><td class="label">Useful Life</td><td class="value">${asset.useful_life || 5} years</td></tr>
                    <tr><td class="label">Depreciation Method</td><td class="value">${(asset.depreciation_method || 'straight-line').replace('-', ' ').toUpperCase()}</td></tr>
                    <tr><td class="label">Annual Depreciation</td><td class="value">ZMW ${formatNumber(dep.annualDepreciation)}</td></tr>
                    <tr><td class="label">Status</td><td class="value">${asset.status || 'Active'}</td></tr>
                    ${asset.serial_number ? `<tr><td class="label">Serial Number</td><td class="value">${asset.serial_number}</td></tr>` : ''}
                    ${asset.description ? `<tr><td class="label">Description</td><td class="value">${asset.description}</td></tr>` : ''}
                </table>
                <div class="footer">
                    <p>Generated on ${new Date().toLocaleString()}</p>
                </div>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => printWindow.focus(), 500);
    }

    // ============================================
    // DEPRECIATION HISTORY
    // ============================================

    async function viewDepreciationHistory(assetId) {
        try {
            const asset = state.assets.find(a => a.id === assetId);
            if (!asset) {
                showToast('Asset not found', 'error');
                return;
            }

            const history = state.depreciationEntries.filter(d => d.asset_id === assetId);

            const content = document.getElementById('depreciationHistoryContent');

            if (history.length === 0) {
                content.innerHTML = `
                    <p style="text-align: center; padding: 30px; color: #94a3b8;">
                        <i class="fa-regular fa-clock" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                        No depreciation entries found for ${asset.name}
                    </p>
                `;
            } else {
                let html = `
                    <h5>Depreciation History - ${asset.name}</h5>
                    <div class="table-responsive">
                        <table class="table-minimal">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th style="text-align: right;">Amount</th>
                                    <th style="text-align: right;">Accumulated</th>
                                    <th style="text-align: right;">Net Book Value</th>
                                </tr>
                            </thead>
                            <tbody>
                `;

                history.forEach(d => {
                    html += `
                        <tr>
                            <td>${formatDate(d.entry_date)}</td>
                            <td style="text-align: right;">ZMW ${formatNumber(d.amount)}</td>
                            <td style="text-align: right;">ZMW ${formatNumber(d.accumulated_depreciation)}</td>
                            <td style="text-align: right;">ZMW ${formatNumber(d.net_book_value)}</td>
                        </tr>
                    `;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;

                content.innerHTML = html;
            }

            document.getElementById('depreciationHistoryModal').classList.add('show');
        } catch (error) {
            console.error('Error loading depreciation history:', error);
            showToast('Error loading history: ' + error.message, 'error');
        }
    }

    // ============================================
    // RUN DEPRECIATION
    // ============================================

    async function runDepreciation() {
        if (state.assets.length === 0) {
            showToast('No assets to depreciate', 'warning');
            return;
        }

        // Confirm with user
        const confirmMessage = `This will run depreciation for all active assets for the current month.\n\n` +
            `Total Assets: ${state.assets.length}\n` +
            `This will create journal entries for depreciation expense.\n\n` +
            `Continue?`;

        if (!confirm(confirmMessage)) {
            return;
        }

        try {
            let totalDepreciation = 0;
            let entriesCreated = 0;

            for (const asset of state.assets) {
                if (asset.status === 'Disposed' || asset.status === 'Fully Depreciated') {
                    continue;
                }

                const dep = calculateDepreciation(asset, 1); // 1 month

                if (dep.isFullyDepreciated) {
                    // Update asset status
                    await supabaseClient
                        .from('fixed_assets')
                        .update({ status: 'Fully Depreciated' })
                        .eq('id', asset.id);
                    continue;
                }

                // Save depreciation entry
                const entryData = {
                    asset_id: asset.id,
                    entry_date: new Date().toISOString().split('T')[0],
                    amount: dep.monthlyDepreciation,
                    accumulated_depreciation: dep.totalDepreciation,
                    net_book_value: dep.netBookValue,
                    created_at: new Date().toISOString()
                };

                const { error: entryError } = await supabaseClient
                    .from('depreciation_entries')
                    .insert([entryData]);

                if (entryError) throw entryError;

                // Update asset
                const { error: assetError } = await supabaseClient
                    .from('fixed_assets')
                    .update({
                        accumulated_depreciation: dep.totalDepreciation,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', asset.id);

                if (assetError) throw assetError;

                totalDepreciation += dep.monthlyDepreciation;
                entriesCreated++;
            }

            // Create journal entry for depreciation
            if (totalDepreciation > 0) {
                await createDepreciationJournalEntry(totalDepreciation);
            }

            showToast(`✅ Depreciation run completed!\n${entriesCreated} assets depreciated\nTotal: ZMW ${formatNumber(totalDepreciation)}`, 'success');
            await refreshFixedAssets();

        } catch (error) {
            console.error('Error running depreciation:', error);
            showToast('Error running depreciation: ' + error.message, 'error');
        }
    }

    // ============================================
    // 🔥 ADDED: ASSET PURCHASE JOURNAL ENTRY
    // ============================================
    async function createAssetPurchaseJournalEntry(asset, paidFromCode) {
        try {
            await ensureChartOfAccounts();
            const assetAccountCode = CATEGORY_ACCOUNT_CODES[asset.category] || CATEGORY_ACCOUNT_CODES['Other'];

            const entryData = {
                entry_date: asset.purchase_date,
                reference: asset.asset_code,
                description: `Asset purchase: ${asset.name} (${asset.asset_code})`,
                journal_number: `FA-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: entry, error: entryError } = await supabaseClient
                .from('journal_entries')
                .insert([entryData])
                .select();

            if (entryError) throw entryError;

            const creditDescription = paidFromCode === '2001'
                ? `Purchased on credit: ${asset.name}`
                : `Paid for: ${asset.name}`;

            const lines = [
                { journal_entry_id: entry[0].id, account_code: assetAccountCode, description: `Asset acquired: ${asset.name}`, debit: asset.cost, credit: 0 },
                { journal_entry_id: entry[0].id, account_code: paidFromCode, description: creditDescription, debit: 0, credit: asset.cost }
            ];

            const { error: lineError } = await supabaseClient.from('journal_lines').insert(lines);
            if (lineError) throw lineError;

            console.log('✅ Asset purchase journal entry created');
        } catch (error) {
            console.error('Error creating asset purchase journal entry:', error);
            showToast('Asset saved, but the accounting entry failed -- please check manually.', 'warning');
        }
    }

    async function createDepreciationJournalEntry(amount) {
        try {
            const entryData = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: 'DEPRECIATION',
                description: `Monthly depreciation for ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}`,
                journal_number: `DEP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted'
            };

            const { data: entry, error: entryError } = await supabaseClient
                .from('journal_entries')
                .insert([entryData])
                .select();

            if (entryError) throw entryError;

            const lines = [
                {
                    journal_entry_id: entry[0].id,
                    account_code: '6280', // Depreciation Expense
                    description: 'Depreciation expense',
                    debit: amount,
                    credit: 0
                },
                {
                    journal_entry_id: entry[0].id,
                    account_code: '1260', // Accumulated Depreciation
                    description: 'Accumulated depreciation',
                    debit: 0,
                    credit: amount
                }
            ];

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(lines);

            if (lineError) throw lineError;

            console.log('✅ Depreciation journal entry created');
        } catch (error) {
            console.error('Error creating depreciation journal entry:', error);
        }
    }

    // ============================================
    // SAVE ASSET
    // ============================================

    async function saveAsset() {
        const editId = document.getElementById('editAssetId').value;
        const name = document.getElementById('assetName').value.trim();
        const category = document.getElementById('assetCategory').value;
        const purchaseDate = document.getElementById('assetPurchaseDate').value;
        const cost = parseFloat(document.getElementById('assetCost').value);
        const usefulLife = parseInt(document.getElementById('assetUsefulLife').value) || 5;
        const salvageValue = parseFloat(document.getElementById('assetSalvageValue').value) || 0;
        const depreciationMethod = document.getElementById('assetDepreciationMethod').value;
        const serialNumber = document.getElementById('assetSerialNumber').value.trim();
        const status = document.getElementById('assetStatus').value;
        const description = document.getElementById('assetDescription').value.trim();
        const assetCode = document.getElementById('assetCode').value.trim();

        // Validation
        if (!name) {
            showToast('Please enter an asset name', 'error');
            return;
        }
        if (!category) {
            showToast('Please select a category', 'error');
            return;
        }
        if (!purchaseDate) {
            showToast('Please select a purchase date', 'error');
            return;
        }
        if (!cost || cost <= 0) {
            showToast('Please enter a valid cost', 'error');
            return;
        }

        const assetData = {
            name: name,
            category: category,
            purchase_date: purchaseDate,
            cost: cost,
            useful_life: usefulLife,
            salvage_value: salvageValue,
            depreciation_method: depreciationMethod,
            serial_number: serialNumber || null,
            status: status || 'Active',
            description: description || null,
            updated_at: new Date().toISOString()
        };

        if (!editId) {
            assetData.asset_code = assetCode || `FA-${String(state.assets.length + 1).padStart(4, '0')}`;
            assetData.accumulated_depreciation = 0;
            assetData.created_at = new Date().toISOString();
        }

        try {
            let result;
            if (editId) {
                const { data, error } = await supabaseClient
                    .from('fixed_assets')
                    .update(assetData)
                    .eq('id', editId)
                    .select();

                if (error) throw error;
                result = data;
                showToast('Asset updated successfully! (Note: this does not adjust any journal entries already posted -- edit the ledger manually if the cost changed.)', 'success');
            } else {
                const { data, error } = await supabaseClient
                    .from('fixed_assets')
                    .insert([assetData])
                    .select();

                if (error) throw error;
                result = data;

                // 🔥 ADDED: post the purchase to the ledger -- previously
                // registering a new asset never touched journal_entries
                // at all, so the Balance Sheet's Fixed Assets total never
                // reflected anything entered here.
                const paidFrom = document.getElementById('assetPaidFrom')?.value || '1111';
                await createAssetPurchaseJournalEntry(result[0], paidFrom);

                showToast('Asset added successfully!', 'success');
            }

            closeModal('assetModal');
            await refreshFixedAssets();

        } catch (error) {
            console.error('Error saving asset:', error);
            showToast('Error saving asset: ' + error.message, 'error');
        }
    }

    // ============================================
    // DEPRECIATION PREVIEW
    // ============================================

    function showDepreciationPreview() {
        const cost = parseFloat(document.getElementById('assetCost').value) || 0;
        const usefulLife = parseInt(document.getElementById('assetUsefulLife').value) || 5;
        const salvageValue = parseFloat(document.getElementById('assetSalvageValue').value) || 0;
        const method = document.getElementById('assetDepreciationMethod').value || 'straight-line';

        const tempAsset = {
            cost: cost,
            useful_life: usefulLife,
            salvage_value: salvageValue,
            depreciation_method: method,
            accumulated_depreciation: 0
        };

        const dep = calculateDepreciation(tempAsset);

        document.getElementById('previewAnnualDep').textContent = `ZMW ${formatNumber(dep.annualDepreciation)}`;
        document.getElementById('previewMonthlyDep').textContent = `ZMW ${formatNumber(dep.monthlyDepreciation)}`;
        document.getElementById('previewTotalDep').textContent = `ZMW ${formatNumber(dep.totalDepreciation)}`;

        document.getElementById('depreciationPreview').style.display = cost > 0 ? 'block' : 'none';
    }

    // ============================================
    // FILTERS
    // ============================================

    function applyFAFilters() {
        renderAssets();
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshFixedAssets() {
        await loadAssets();
        await loadDepreciationEntries();
        renderStats();
        renderAssets();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#f59e0b';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${bgColor};
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
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(modal => {
                    modal.classList.remove('show');
                });
            }
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                }
            });
        });

        // Auto-generate asset code
        document.getElementById('assetCategory')?.addEventListener('change', function() {
            if (!document.getElementById('editAssetId').value) {
                const prefix = this.value.substring(0, 2).toUpperCase() || 'FA';
                const count = state.assets.length + 1;
                document.getElementById('assetCode').value = `${prefix}-${String(count).padStart(4, '0')}`;
            }
        });

        // Depreciation preview on change
        ['assetCost', 'assetUsefulLife', 'assetSalvageValue', 'assetDepreciationMethod'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', showDepreciationPreview);
            document.getElementById(id)?.addEventListener('change', showDepreciationPreview);
        });

        // Search and filters
        document.getElementById('searchFA')?.addEventListener('input', applyFAFilters);
        document.getElementById('faCategoryFilter')?.addEventListener('change', applyFAFilters);
        document.getElementById('faStatusFilter')?.addEventListener('change', applyFAFilters);
    }

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.openNewAsset = openNewAsset;
    window.editAsset = editAsset;
    window.deleteAsset = deleteAsset;
    window.viewAsset = viewAsset;
    window.printAsset = printAsset;
    window.viewDepreciationHistory = viewDepreciationHistory;
    window.saveAsset = saveAsset;
    window.runDepreciation = runDepreciation;
    window.applyFAFilters = applyFAFilters;
    window.refreshFixedAssets = refreshFixedAssets;
    window.closeModal = closeModal;
    window.showToast = showToast;

    // ============================================
    // INITIALIZE
    // ============================================
    await ensureChartOfAccounts();
    await loadAssets();
    await loadDepreciationEntries();
    renderStats();
    renderAssets();
    setupEventListeners();

    console.log("✅ Fixed Assets module initialized successfully!");
    console.log(`🏢 ${state.assets.length} assets loaded`);
})();