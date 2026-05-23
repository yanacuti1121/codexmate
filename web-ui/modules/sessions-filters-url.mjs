import {
    buildSessionFilterCacheState,
    isSessionQueryEnabled
} from '../logic.mjs';

export function normalizeSessionRoleFilter(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'user' || normalized === 'assistant' || normalized === 'system') {
        return normalized;
    }
    return 'all';
}

export function normalizeSessionTimePreset(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === '7d' || normalized === '30d' || normalized === '90d') {
        return normalized;
    }
    return 'all';
}

export function readSessionsFilterUrlState() {
    try {
        const url = new URL(window.location.href);
        if (url.pathname === '/session') return null;
        const source = (url.searchParams.get('s_source') || '').trim().toLowerCase();
        const pathFilter = url.searchParams.get('s_path') || '';
        const query = url.searchParams.get('s_query') || '';
        const roleFilter = url.searchParams.get('s_role') || 'all';
        const timeRangePreset = url.searchParams.get('s_time') || 'all';
        const hasAny = !!(source || pathFilter || query || roleFilter !== 'all' || timeRangePreset !== 'all');
        if (!hasAny) return null;
        return {
            source: source || 'all',
            pathFilter,
            query,
            roleFilter,
            timeRangePreset
        };
    } catch (_) {
        return null;
    }
}

export function applySessionsFilterUrlState(vm, state) {
    if (!vm || !state) return;
    const cached = buildSessionFilterCacheState(state.source, state.pathFilter);
    vm.sessionFilterSource = cached.source;
    vm.sessionPathFilter = cached.pathFilter;
    vm.sessionQuery = typeof state.query === 'string' ? state.query : '';
    vm.sessionRoleFilter = normalizeSessionRoleFilter(state.roleFilter);
    vm.sessionTimePreset = normalizeSessionTimePreset(state.timeRangePreset);
    if (typeof vm.refreshSessionPathOptions === 'function') {
        vm.refreshSessionPathOptions(vm.sessionFilterSource);
    }
}

export function buildSessionsFilterShareUrl(vm) {
    try {
        // 使用干净的根路径作为基础 URL
        const baseUrl = window.location.origin + '/';
        const url = new URL(baseUrl);
        url.searchParams.set('tab', 'sessions');
        url.searchParams.set('s_source', String(vm.sessionFilterSource || 'all'));
        if (vm.sessionPathFilter) url.searchParams.set('s_path', String(vm.sessionPathFilter || ''));
        if (vm.sessionQuery && isSessionQueryEnabled(vm.sessionFilterSource)) url.searchParams.set('s_query', String(vm.sessionQuery || ''));
        if (vm.sessionRoleFilter && vm.sessionRoleFilter !== 'all') url.searchParams.set('s_role', String(vm.sessionRoleFilter || 'all'));
        if (vm.sessionTimePreset && vm.sessionTimePreset !== 'all') url.searchParams.set('s_time', String(vm.sessionTimePreset || 'all'));
        return url.toString();
    } catch (_) {
        return '';
    }
}

export function syncSessionsFilterUrl(vm) {
    // URL 保持静态，不同步状态到 URL
    // 所有状态通过 localStorage 管理
}

