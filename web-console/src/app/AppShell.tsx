import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { apiMode } from '../api/http';
import type { Role } from '../api/types';
import type { Permission } from '../auth/permissions';
import { signOut, useSession } from '../auth/session';
import { usePermissions } from '../auth/usePermissions';
import { DEV_ROLES, getDevRole, setDevRole } from '../mocks/devRole';
import { cx } from '../lib/cx';
import s from './AppShell.module.css';

interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', permission: 'deployment:read', end: true },
  { to: '/applications', label: 'Applications', permission: 'application:read' },
  { to: '/sessions', label: 'Tool sessions', permission: 'session:use' },
  { to: '/fleet', label: 'Fleet and dead letters', permission: 'fleet:read' },
  { to: '/access', label: 'Access', permission: 'user:manage' },
  { to: '/audit', label: 'Audit trail', permission: 'audit:read' },
];

const ROLE_LABEL: Record<string, string> = {
  VIEWER: 'VIEWER: application developer',
  DEPLOYER: 'DEPLOYER: release manager',
  OPERATOR: 'OPERATOR: platform operator',
  ADMIN: 'ADMIN: security admin',
};

/** Development-only: switch the signed-in role the mock identity service issues (plan §8.8). */
function DevBar() {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<Role>(getDevRole);
  const session = useSession();
  if (session) {
    return (
      <div className={s.devBar} role="region" aria-label="Development controls">
        <span className={s.devTag}>Development</span>
        <span>Signed in with the real identity-service: the role switch is off, and permissions come from your access token.</span>
        <NavLink className={s.devLink} to="/login">Session details</NavLink>
      </div>
    );
  }
  return (
    <div className={s.devBar} role="region" aria-label="Development controls">
      <span className={s.devTag}>Development</span>
      <label className={s.devField}>
        Preview as
        <select
          value={role}
          onChange={e => {
            const next = e.target.value as Role;
            setDevRole(next);
            setRole(next);
            void queryClient.resetQueries();
          }}
        >
          {DEV_ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}
        </select>
      </label>
      <NavLink className={s.devLink} to="/login">Sign in (real identity)</NavLink>
      <span>{apiMode === 'hybrid' ? 'Hybrid: control-api calls go to localhost:8081; other services are simulated' : 'Simulated APIs: no backend needed'}</span>
    </div>
  );
}

export function AppShell() {
  const { me, can, teams } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page when the screen changes, so keyboard and screen-reader users start at the new
  // content. Picking an item inside a list + detail screen (/access/users/:id) keeps focus where the screen puts it.
  const screen = location.pathname.split('/').slice(0, 2).join('/');
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [screen]);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/applications${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  };

  const session = useSession();
  const queryClient = useQueryClient();
  const showDevBar = import.meta.env.DEV || apiMode === 'mock';

  const onSignOut = async () => {
    await signOut();
    await queryClient.resetQueries();
    navigate('/login');
  };

  return (
    <div className={s.page}>
      <a className={s.skip} href="#main">Skip to content</a>
      {showDevBar && <DevBar />}
      <div className={s.shell}>
        <nav className={s.side} aria-label="Main">
          <div className={s.brand}>app<span>fleet</span></div>
          {NAV.filter(item => can(item.permission)).map(item => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cx(s.nav, isActive && s.navOn)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className={s.content}>
          <div className={s.top}>
            <form role="search" className={s.searchForm} onSubmit={onSearch}>
              <input
                className={s.search}
                type="search"
                aria-label="Search applications"
                placeholder="Search applications"
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            </form>
            <div className={s.who}>
              {session ? (
                <>
                  <span className={s.pill}>{`Teams: ${Object.keys(session.claims.teams ?? {}).length}`}</span>
                  <NavLink className={s.pill} to="/account">{session.email}</NavLink>
                  <button type="button" className={s.signOut} onClick={() => void onSignOut()}>Sign out</button>
                </>
              ) : (
                <>
                  <span className={s.pill}>{teams === 'all' ? 'Teams: all' : `Teams: ${Object.keys(me?.permissions ?? {}).length}`}</span>
                  <NavLink className={s.pill} to="/account">{me ? me.displayName : 'Signing in'}</NavLink>
                </>
              )}
            </div>
          </div>
          {apiMode === 'hybrid' && !session && location.pathname !== '/login' && (
            <p className={s.signInBar} role="status">
              You are not signed in, so control-api will refuse these calls. <NavLink to="/login">Sign in</NavLink>
            </p>
          )}
          <main id="main" ref={mainRef} tabIndex={-1} className={s.main}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
