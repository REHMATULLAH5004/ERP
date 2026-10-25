// ============================================
// SUPABASE CONFIG
// ============================================
// Fill in your actual project URL and anon (public) key from:
// Supabase Dashboard > Project Settings > API
//
// The anon key is safe to expose in client-side code -- it's designed
// for that, and your actual data protection comes from Row Level
// Security policies on each table, not from keeping this key secret.
// Never put your service_role key here or anywhere in client-side code.
// ============================================

const SUPABASE_URL = 'https://ruhpncvhvlqqxpgpzifx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1aHBuY3ZodmxxcXhwZ3B6aWZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDU4OTUsImV4cCI6MjA5NjY4MTg5NX0.nBmHLnS3e_JIduLmqqgYEBmVVIrOeI9cmmgUP2BQ65Q';

// The login session is shared between browser tabs through a browser "lock". If another
// tab (or a tab that was closed mid-refresh) keeps hold of that lock, every request in this
// tab waits behind it and the app sits on a blank screen. This lock waits up to 5 seconds
// for its turn and then carries on, so a stuck lock can never freeze the app.
async function appAuthLock(name, acquireTimeout, fn) {
    if (!navigator.locks) return await fn();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
        return await navigator.locks.request(name, { signal: ac.signal }, async () => {
            clearTimeout(timer);
            return await fn();
        });
    } catch (e) {
        if (e && e.name === 'AbortError') return await fn();
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { lock: appAuthLock }
});