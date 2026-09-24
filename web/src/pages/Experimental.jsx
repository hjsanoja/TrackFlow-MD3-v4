import { useState, useEffect } from 'react';
import RevisionCapturas from './RevisionCapturas';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Analisis from './Analisis';
import Simulador from './Simulador';
import Hallazgos from './Hallazgos';
import Reporteria from './Reporteria';
import CanibalizacionInterna from '../components/CanibalizacionInterna';
import BrechaHistoricaUsd from '../components/BrechaHistoricaUsd';

export default function Experimental({ user, userDoc }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const tabParam = searchParams.get('tab');
  const validTabs = ['revision', 'canibalizacion', 'brecha_usd', 'reporteria', 'analisis', 'simulador', 'hallazgos'];
  const activeTab = validTabs.includes(tabParam) ? tabParam : 'canibalizacion';

  const handleTabChange = (tabId) => {
    setSearchParams({ tab: tabId });
  };

  const tabs = [
    {
      id: 'revision',
      label: 'Revisión de Capturas',
      shortLabel: 'Revisión',
      icon: 'rule',
      desc: 'Capturas que el control de calidad marcó como dudosas y aún nadie ha revisado',
      status: 'Nuevo'
    },
    {
      id: 'canibalizacion',
      label: 'Canibalización de Marcas',
      shortLabel: 'Canibalización Marcas',
      icon: 'compare_arrows',
      desc: 'Detección de canibalización y márgenes invertidos entre La Santé y Pharmetique',
      status: 'Nuevo'
    },
    {
      id: 'brecha_usd',
      label: 'Brechas USD Diarias (BCV)',
      shortLabel: 'Brechas USD Diarias',
      icon: 'currency_exchange',
      desc: 'Histórico de brechas calculadas con la tasa oficial BCV de cada día',
      status: 'Nuevo'
    },
    {
      id: 'reporteria',
      label: 'Reportería y Brechas',
      shortLabel: 'Reportería',
      icon: 'table_chart',
      desc: 'Reporte comparativo de precios y brechas por ID con descarga CSV/Excel',
      status: 'En evaluación'
    },
    {
      id: 'analisis',
      label: 'Análisis de Precios',
      shortLabel: 'Análisis',
      icon: 'insights',
      desc: 'Dispersión y variaciones de precios frente al mercado',
      status: 'En evaluación'
    },
    {
      id: 'simulador',
      label: 'Simulador de Precios',
      shortLabel: 'Simulador',
      icon: 'calculate',
      desc: 'Simulación de escenarios, ajustes y proyecciones de margen',
      status: 'En evaluación'
    },
    {
      id: 'hallazgos',
      label: 'Hallazgos de Mercado',
      shortLabel: 'Hallazgos',
      icon: 'lightbulb',
      desc: 'Detección automatizada de oportunidades y alertas de brechas',
      status: 'En evaluación'
    }
  ];

  return (
    <div className="space-y-6 pb-12 font-sans">
      {/* Banner de Laboratorio Experimental */}
      <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/30 rounded-3xl p-5 md:p-6 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-2xl font-variation-settings-fill">
                science
              </span>
              <h1 className="text-xl md:text-2xl font-display font-extrabold text-on-background tracking-tight">
                Módulo Experimental
              </h1>
              <span className="inline-flex items-center gap-1 text-label-sm font-mono font-bold uppercase tracking-wider bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                En Pulido & Testing
              </span>
            </div>
            <p className="text-xs text-on-surface-variant font-sans max-w-3xl leading-relaxed">
              Espacio unificado de herramientas analíticas y de reportería avanzada. Aquí evaluamos las funciones de <strong>Reportería de Brechas</strong>, <strong>Análisis</strong>, <strong>Simulador</strong> y <strong>Hallazgos</strong> antes de su publicación definitiva.
            </p>
          </div>

          {/* Selector de submenús estilo M3 Segmented Pill */}
          <div className="flex items-center gap-1 bg-surface-container-high/80 p-1 rounded-2xl border border-outline-variant/60 shadow-xs self-start lg:self-auto overflow-x-auto max-w-full">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold font-display transition-all whitespace-nowrap select-none ${
                    isActive
                      ? 'bg-surface-container-lowest dark:bg-surface-container-lowest text-primary shadow-sm ring-1 ring-black/5 dark:ring-white/10'
                      : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
                  }`}
                >
                  <span className={`material-symbols-outlined text-[17px] ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {tab.icon}
                  </span>
                  <span>{tab.shortLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Renderizado dinámico del submenú seleccionado */}
      <div className="transition-opacity duration-200">
        {activeTab === 'revision' && <RevisionCapturas />}
        {activeTab === 'canibalizacion' && <CanibalizacionInterna user={user} userDoc={userDoc} />}
        {activeTab === 'brecha_usd' && <BrechaHistoricaUsd user={user} userDoc={userDoc} />}
        {activeTab === 'reporteria' && <Reporteria user={user} userDoc={userDoc} />}
        {activeTab === 'analisis' && <Analisis user={user} userDoc={userDoc} />}
        {activeTab === 'simulador' && <Simulador user={user} userDoc={userDoc} />}
        {activeTab === 'hallazgos' && <Hallazgos user={user} userDoc={userDoc} />}
      </div>
    </div>
  );
}
