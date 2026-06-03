import { DICT } from './i18n.dict.mjs';

const I18N_STORAGE_KEY = 'codexmateLang'; // VI_PATCH_COMPLETE

function normalizeLang(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'en') return 'en';
    if (normalized === 'vi') return 'vi';
    return 'vi';
}

function interpolate(template, params) {
    if (!params || typeof params !== 'object') return template;
    return String(template).replace(/\{(\w+)\}/g, (_, key) => {
        const value = params[key];
        return value === undefined || value === null ? '' : String(value);
    });
}

export function createI18nMethods() {
    return {
        normalizeLang,
        initI18n() {
            const saved = typeof localStorage !== 'undefined'
                ? localStorage.getItem(I18N_STORAGE_KEY)
                : '';
            const next = normalizeLang(saved);
            this.lang = next;
            try {
                if (typeof document !== 'undefined' && document.documentElement) {
                    if (next === 'en') document.documentElement.lang = 'en';
                    else if (next === 'vi') document.documentElement.lang = 'vi';
                    else document.documentElement.lang = 'vi';
                }
            } catch (_) {}
        },
        setLang(nextLang) {
            const next = normalizeLang(nextLang);
            this.lang = next;
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(I18N_STORAGE_KEY, next);
                }
            } catch (_) {}
            try {
                if (typeof document !== 'undefined' && document.documentElement) {
                    if (next === 'en') document.documentElement.lang = 'en';
                    else if (next === 'vi') document.documentElement.lang = 'vi';
                    else document.documentElement.lang = 'vi';
                }
            } catch (_) {}
        },
        t(key, params = null) {
            const lang = normalizeLang(this.lang);
            const table = DICT[lang] || DICT.vi;
            const fallbackEn = DICT.en;
            const raw = (table && table[key]) || (fallbackEn && fallbackEn[key]) || key;
            return interpolate(raw, params);
        }
    };
}
