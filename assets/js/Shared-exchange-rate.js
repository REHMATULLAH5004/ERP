// ============================================
// SHARED EXCHANGE RATE UTILITY
// ============================================
// Single canonical source for "today's USD -> ZMW rate". Backed by the
// same `exchange_rates` table Account > Cash & Bank already writes to
// (rows are append-only history -- the most recent row is always the
// current rate, exactly the convention cash-bank's own
// loadExchangeRate()/saveExchangeRate() already use).
//
// Before this file existed, every screen that needed a rate (Payments,
// Purchase, Cash & Bank) either hardcoded a stale default (25.00) or
// only knew about a rate typed into THAT screen a moment ago -- so the
// same day's real rate had to be re-typed over and over, and a rate
// entered in one screen never carried over to another. Now: set it once
// (from the Dashboard's "Today's Exchange Rate" widget, or from Cash &
// Bank as before), and every screen that calls getSharedExchangeRate()
// picks up the same value as its default -- still editable per
// transaction if a specific deal genuinely needs a different rate.
//
// Loaded once, globally, via a normal <script> tag in the root
// index.html -- every SPA sub-module (which all share one browser
// page/JS context regardless of how their own script got injected) can
// call these functions directly, no import needed. Same pattern as
// assets/js/shared-attendance-utils.js.
// ============================================

const DEFAULT_EXCHANGE_RATE = 25.00;

async function getSharedExchangeRate() {
    try {
        const { data, error } = await supabaseClient
            .from('exchange_rates')
            .select('usd_to_zmw, created_at')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error || !data) return DEFAULT_EXCHANGE_RATE;
        return parseFloat(data.usd_to_zmw) || DEFAULT_EXCHANGE_RATE;
    } catch (err) {
        console.warn('Could not load shared exchange rate, using default:', err);
        return DEFAULT_EXCHANGE_RATE;
    }
}

async function saveSharedExchangeRate(zmwPerUsd) {
    if (!zmwPerUsd || zmwPerUsd <= 0) {
        return { error: new Error('Exchange rate must be a positive number.') };
    }
    try {
        const { error } = await supabaseClient
            .from('exchange_rates')
            .insert([{
                usd_to_zmw: zmwPerUsd,
                zmw_to_usd: 1 / zmwPerUsd,
                created_at: new Date().toISOString()
            }]);
        return { error };
    } catch (err) {
        return { error: err };
    }
}