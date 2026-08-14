import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { supabase } from '../supabase';
import { useData } from '../context/DataContext';

export default function Layout({ user, userDoc, children }) {
  const { isRefreshing, refreshData, productos = [] } = useData();
  const navigate = useNavigate();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const userEmail = (userDoc?.email || user?.email || '').toLowerCase();
  const isAdmin = userDoc?.rol === 'administrador' || userEmail === 'hjsanoja@gmail.com' || userEmail === 'admin@trackflow.com';

  const handleLogout = async () => {
    try {
      localStorage.removeItem('trackflow_demo_user');
    } catch (e) {}
    try {
      await supabase.auth.signOut();
    } catch (e) {}
    try {
      await signOut(auth);
    } catch (e) {}
    window.location.reload();
  };

  const navItems = [
    { to: '/', label: 'Dashboard', icon: 'dashboard', adminOnly: false },
    { to: '/analisis', label: 'Análisis', icon: 'insights', adminOnly: false },
    { to: '/mapa-calor', label: 'Mapa de Calor', icon: 'thermostat', adminOnly: false },
    { to: '/productos', label: 'Productos', icon: 'medication', adminOnly: true },
    { to: '/competencia', label: 'Competencia', icon: 'link', adminOnly: true },
    { to: '/cadenas', label: 'Cadenas', icon: 'storefront', adminOnly: true },
    { to: '/usuarios', label: 'Usuarios', icon: 'group', adminOnly: true },
  ];

  // Global Keyboard shortcut listener for Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSearchOpen]);

  // Filtered search results
  const filteredNav = navItems.filter(item => {
    if (item.adminOnly && !isAdmin) return false;
    if (!searchQuery.trim()) return true;
    return item.label.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const filteredProducts = productos.filter(p => {
    if (!searchQuery.trim()) return false;
    const q = searchQuery.toLowerCase();
    return (
      p.nombre?.toLowerCase().includes(q) ||
      p.principio_activo?.toLowerCase().includes(q) ||
      p.laboratorio?.toLowerCase().includes(q) ||
      p.categoria?.toLowerCase().includes(q)
    );
  }).slice(0, 6);

  const handleSelectNav = (path) => {
    navigate(path);
    setIsSearchOpen(false);
    setSearchQuery('');
  };

  return (
    <div className="min-h-screen bg-surface flex font-sans text-on-surface">
      {/* Sidebar - Material Design 3 Navigation Drawer (Desktop / Tablet) */}
      <aside className="hidden md:flex w-64 lg:w-72 bg-surface-container-lowest border-r border-outline-variant/60 flex-col justify-between py-6 px-4 shrink-0 shadow-xs">
        <div>
          {/* Logo & Brand */}
          <div className="px-4 mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary flex items-center justify-center text-on-primary shadow-elevation-1">
                <span className="material-symbols-outlined select-none text-2xl font-bold">monitoring</span>
              </div>
              <div>
                <h1 className="text-xl font-display font-bold tracking-tight text-on-surface flex items-center gap-0.5">
                  Track<span className="text-secondary font-display font-bold">Flow</span>
                </h1>
                <p className="text-[10px] text-on-surface-variant font-mono tracking-wider uppercase font-semibold">Monitor de Precios</p>
              </div>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <div className="px-4 py-2 text-[11px] font-mono font-bold tracking-wider text-on-surface-variant uppercase">
              Menú Principal
            </div>
            {navItems
              .filter(item => !item.adminOnly || isAdmin)
              .map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-4 px-4 py-3 rounded-full text-sm font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-primary-container text-on-primary-container font-bold shadow-elevation-1'
                        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                    }`
                  }
                >
                  <span className="material-symbols-outlined select-none text-[22px] leading-none">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
          </nav>
        </div>

        {/* User profile footer - MD3 Style */}
        <div className="space-y-4">
          <div className="bg-surface-container-low rounded-2xl p-4 border border-outline-variant/40">
            <div className="flex items-center gap-3">
              {(() => {
                const displayName = (!userDoc?.nombre || userDoc.nombre === 'Administrador TrackFlow' || userDoc.nombre === 'admin')
                  ? 'Hernando Sanoja'
                  : userDoc.nombre;
                return (
                  <>
                    <div className="w-10 h-10 rounded-full bg-primary text-on-primary font-bold flex items-center justify-center text-sm font-display shadow-elevation-1">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                    <div className="truncate flex-1">
                      <div className="text-sm font-bold text-on-surface truncate font-display">{displayName}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="m3-live-indicator"></span>
                        <span className="text-[10px] text-on-surface-variant uppercase font-mono font-semibold tracking-wider">{userDoc?.rol || 'administrador'}</span>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold text-error bg-error-container hover:bg-error-container/85 border border-error/20 rounded-full transition-all active:scale-98"
          >
            <span className="material-symbols-outlined select-none text-base">logout</span>
            <span>Cerrar Sesión</span>
          </button>

          {/* Developer attribution & Version */}
          <div className="pt-3 text-center border-t border-outline-variant/40 flex flex-col items-center gap-1">
            <span className="text-[10px] text-on-surface-variant font-mono tracking-wide">
              Desarrollador: <span className="font-bold text-primary">Hernando Sanoja</span>
            </span>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[9px] text-primary font-mono font-bold uppercase tracking-wider bg-primary-container/60 px-2.5 py-0.5 rounded-full border border-primary/15">
                M3 Expressive Activo
              </span>
              <span className="text-[9px] text-on-surface-variant/70 font-mono">
                V7.4.0 · Material 3 Expressive & Cinemática
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-x-auto min-h-screen flex flex-col">
        {/* Top Header Bar */}
        <header className="px-6 py-2.5 bg-surface-container-lowest/90 backdrop-blur-md border-b border-outline-variant/60 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5 px-3 py-1 bg-surface-container-low rounded-full border border-outline-variant/40">
              <span className="m3-live-indicator"></span>
              <span className="text-xs font-mono font-semibold text-on-surface-variant">
                Supabase DB Activa
              </span>
            </div>

            {/* Quick Search Shortcut Trigger */}
            <button
              onClick={() => setIsSearchOpen(true)}
              className="hidden sm:flex items-center gap-3 px-3.5 py-1.5 bg-surface-container-low hover:bg-surface-container border border-outline-variant/60 rounded-full text-xs text-on-surface-variant transition-colors group"
            >
              <span className="material-symbols-outlined text-base text-on-surface-variant group-hover:text-primary transition-colors">search</span>
              <span className="font-sans">Buscar módulo o molécula...</span>
              <kbd className="font-mono text-[10px] bg-surface-container-lowest border border-outline-variant px-1.5 py-0.5 rounded text-on-surface-variant font-bold">⌘K</kbd>
            </button>
          </div>

          <div className="flex items-center gap-3">
            {isRefreshing ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-mono font-bold text-primary bg-primary-container/50 px-3 py-1 rounded-full border border-primary/20 animate-pulse">
                <span className="material-symbols-outlined text-sm animate-spin">sync</span>
                Actualizando datos...
              </span>
            ) : (
              <button
                onClick={() => refreshData()}
                className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-on-surface-variant hover:text-primary transition-colors px-3 py-1.5 rounded-full hover:bg-surface-container-low border border-outline-variant/40"
                title="Actualizar datos manualmente"
              >
                <span className="material-symbols-outlined text-sm">refresh</span>
                Actualizar
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto pb-20 md:pb-8">
          {children}
        </div>
      </main>

      {/* Global Command Palette Modal (Cmd+K / Ctrl+K) */}
      {isSearchOpen && createPortal(
        <div
          className="m3-modal-scrim items-start pt-16 sm:pt-24"
          onClick={() => setIsSearchOpen(false)}
        >
          <div
            className="bg-surface-container-lowest rounded-extra-large shadow-elevation-4 max-w-xl w-full border border-outline-variant overflow-hidden animate-fade-in-slide my-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-surface-container-high flex items-center gap-3">
              <span className="material-symbols-outlined text-primary text-xl">search</span>
              <input
                autoFocus
                type="text"
                placeholder="Escribe para buscar rutas, productos, principios activos..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-transparent border-none outline-none font-sans text-sm text-on-surface placeholder:text-on-surface-variant/60"
              />
              <kbd className="text-[10px] font-mono font-bold bg-surface-container-high px-2 py-0.5 rounded text-on-surface-variant">ESC</kbd>
            </div>

            <div className="max-h-80 overflow-y-auto p-3 space-y-3">
              {/* Navigation Modules */}
              <div>
                <div className="px-3 py-1 text-[11px] font-mono font-bold uppercase tracking-wider text-on-surface-variant">
                  Módulos de la Plataforma
                </div>
                <div className="mt-1 space-y-1">
                  {filteredNav.map(item => (
                    <button
                      key={item.to}
                      onClick={() => handleSelectNav(item.to)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-left hover:bg-surface-container-low text-sm font-medium transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-primary text-lg">{item.icon}</span>
                        <span className="text-on-surface font-display font-semibold">{item.label}</span>
                      </div>
                      <span className="text-xs font-mono text-on-surface-variant/70">Ir a vista →</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Products match */}
              {filteredProducts.length > 0 && (
                <div className="pt-2 border-t border-surface-container-high">
                  <div className="px-3 py-1 text-[11px] font-mono font-bold uppercase tracking-wider text-on-surface-variant">
                    Productos Encontrados ({filteredProducts.length})
                  </div>
                  <div className="mt-1 space-y-1">
                    {filteredProducts.map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleSelectNav('/')}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-left hover:bg-surface-container-low text-xs transition-colors"
                      >
                        <div>
                          <div className="font-bold text-on-surface">{p.nombre}</div>
                          <div className="text-[11px] text-on-surface-variant">{p.principio_activo} · {p.laboratorio}</div>
                        </div>
                        <span className="font-mono font-bold text-primary">${Number(p.pvp_propio_usd || 0).toFixed(2)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Mobile Bottom Navigation Bar (MD3 Style for Mobile Touch Usability) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface-container-lowest/95 backdrop-blur-md border-t border-outline-variant/60 flex items-center justify-around py-1.5 px-2 shadow-lg">
        {navItems
          .filter(item => !item.adminOnly || isAdmin)
          .slice(0, 5)
          .map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center py-1 px-3 rounded-2xl min-w-[56px] transition-all ${
                  isActive
                    ? 'text-primary font-bold bg-primary-container/70 shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`
              }
            >
              <span className="material-symbols-outlined text-xl select-none">
                {item.icon}
              </span>
              <span className="text-[10px] font-medium tracking-tight mt-0.5">
                {item.label}
              </span>
            </NavLink>
          ))}
      </nav>
    </div>
  );
}
